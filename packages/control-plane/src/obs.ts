// Observability: structured one-line JSON logs, request-id plumbing, route
// templating, and the /healthz probe. See docs/observability.md.
//
// Zero dependencies and workerd-compatible on purpose: a log line is one
// `console.log` of one JSON string (Workers Logs / `wrangler tail` ingest that
// shape natively), and nothing here touches a Node API, so the same module
// serves the Workers entry and the Node private-instance entry.
//
// THE REDACTION RULE (spec 6.3 "what happens in the terminal is the user's
// business", spec 10.1 vault): no secret, session cookie, or journal byte may
// enter a log line. It is enforced structurally, not by caller discipline —
// every field passes through `redact()`, which drops the VALUE of any key
// matching the denylist below, replaces binary values wholesale, and truncates
// long strings so a journal buffer cannot ride through an innocent field name.

/** Build-time version constant. Kept in lockstep with package.json by hand
 *  (there is no build step to inject it); a `VERSION` wrangler var, when
 *  present, wins — see `healthz`. */
export const CONTROL_PLANE_VERSION = '0.1.0';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogFields = Record<string, unknown>;
export type LogSink = (line: string) => void;

/** What a redacted value is replaced with. The KEY survives (so a reader can
 *  see that a token was present); the VALUE never does. */
export const REDACTED = '[redacted]';

/** Key-name denylist. Matching is case-insensitive SUBSTRING matching, so
 *  `sessionCookie`, `AUTH_SECRET`, `apiKey`, `Authorization` and
 *  `refreshToken` are all caught without being listed. */
const REDACT_KEY_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /cookie/i,
  /authorization/i,
  /key/i,
  /password/i,
];

/** Longest string VALUE a log line may carry. Journal output is arbitrarily
 *  large and routinely secret-bearing; a field that big is a smell either way. */
const MAX_STRING_FIELD = 256;

/** Nesting depth cap; beyond it the value is summarized, never walked. */
const MAX_DEPTH = 6;

const SECRET_IN_STRING: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
  /\b(?:sk-[A-Za-z0-9_-]{12,}|box_[A-Za-z0-9_-]{12,}|ghp_[A-Za-z0-9]{12,}|github_pat_[A-Za-z0-9_]{12,}|xox[baprs]-[A-Za-z0-9-]{12,})\b/gi,
  /\bAKIA[A-Z0-9]{12,}\b/g,
  /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  /\b(token|secret|password|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
];

function redactString(input: string): string {
  let out = input;
  for (const pattern of SECRET_IN_STRING) out = out.replace(pattern, REDACTED);
  return out.length > MAX_STRING_FIELD
    ? `${out.slice(0, MAX_STRING_FIELD)}…[+${out.length - MAX_STRING_FIELD}]`
    : out;
}

export function shouldRedactKey(key: string): boolean {
  return REDACT_KEY_PATTERNS.some((p) => p.test(key));
}

/**
 * Deep-copy `value` with every denylisted key's value replaced, binary buffers
 * summarized to their length, and long strings truncated. Safe on cycles (the
 * depth cap ends the walk) and on anything JSON.stringify would choke on.
 */
export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  // Binary is NEVER walked or printed: journal bytes travel as Uint8Array.
  if (value instanceof ArrayBuffer) return `[bytes ${value.byteLength}]`;
  if (ArrayBuffer.isView(value)) return `[bytes ${(value as ArrayBufferView).byteLength}]`;
  if (depth >= MAX_DEPTH) return '[depth]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = shouldRedactKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  return String(value);
}

/**
 * A short, stable, non-reversible label for a user id (FNV-1a 32-bit, hex).
 * For log CORRELATION only — the raw id is a tenant identifier and does not
 * belong in an ops log stream; eight hex chars are plenty to group a user's
 * requests without naming the user.
 */
export function hashUserId(userId: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger carrying extra bound context (e.g. `{requestId}`), the child
   *  pattern: context set once, present on every subsequent line. */
  child(fields: LogFields): Logger;
}

function safeStringify(record: Record<string, unknown>): string {
  try {
    return JSON.stringify(record);
  } catch {
    // A value redact() summarized can still theoretically defeat stringify
    // (exotic getters). The log line survives with what is serializable.
    return JSON.stringify({ ts: record['ts'], level: record['level'], event: record['event'], logError: 'unserializable_fields' });
  }
}

/**
 * Construct a logger. `context` is bound to every line; `sink` defaults to
 * `console.log` (one line, one JSON object — the workerd-native shape).
 * Redaction applies to context AND per-call fields, always, with no opt-out.
 */
export function makeLogger(context: LogFields = {}, sink?: LogSink): Logger {
  const write: LogSink = sink ?? ((line) => console.log(line));
  const bound = redact(context) as Record<string, unknown>;
  const emit = (level: LogLevel, event: string, fields?: LogFields): void => {
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      event,
      ...bound,
      ...(fields === undefined ? {} : (redact(fields) as Record<string, unknown>)),
    };
    // The reserved keys are the envelope; a field must not overwrite them.
    record['ts'] = new Date().toISOString();
    record['level'] = level;
    record['event'] = event;
    write(safeStringify(record));
  };
  return {
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    child: (fields) => makeLogger({ ...context, ...fields }, sink),
  };
}

// ---------------------------------------------------------------------------
// Route templating (log cardinality control)
// ---------------------------------------------------------------------------

/** The control plane's route surface as TEMPLATES (app.ts + handler.ts). The
 *  access log records the template, never the raw path: computer ids, run ids
 *  and secret NAMES are all path segments, and raw paths would make the log
 *  both high-cardinality and tenant-identifying. */
const ROUTE_TEMPLATES: readonly string[] = [
  '/',
  '/healthz',
  '/attach/:id',
  '/supervisor/:id',
  '/api/auth/*',
  '/api/dev/seed',
  '/api/config',
  '/api/fleet',
  '/api/events',
  '/api/computers',
  '/api/computers/:id',
  '/api/computers/:id/wake',
  '/api/computers/:id/sleep',
  '/api/computers/:id/incidents',
  '/api/computers/:id/fork',
  '/api/computers/:id/layout',
  '/api/computers/:id/usage',
  '/api/computers/:id/attention',
  '/api/computers/:id/attention/:eventId/dismiss',
  '/api/computers/:id/secrets',
  '/api/computers/:id/secrets/:name',
  '/api/computers/:id/preview',
  '/api/computers/:id/runs',
  '/api/computers/:id/runs/:runId',
  '/api/computers/:id/runs/:runId/stop',
  '/api/computers/:id/runs/:runId/keep',
  '/api/computers/:id/runs/:runId/revert',
  '/api/computers/:id/runs/:runId/diff',
  '/api/computers/:id/snapshot',
  '/api/computers/:id/file',
  '/api/computers/:id/files',
  '/api/computers/:id/files/*',
  '/api/computers/:id/upload',
];

function matchTemplate(template: string, segments: string[]): boolean {
  const parts = template.split('/').filter((s) => s !== '');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] as string;
    if (p === '*') return true; // rest, including nothing
    if (i >= segments.length) return false;
    if (p.startsWith(':')) continue;
    if (p !== segments[i]) return false;
  }
  return parts.length === segments.length;
}

/**
 * The template for a pathname, or `/unknown`. Unknown segments can contain
 * tenant content (including a short secret name), so preserving "safe-looking"
 * pieces is still a leak and unbounded-cardinality logging.
 */
export function routeTemplate(pathname: string): string {
  const segments = pathname.split('/').filter((s) => s !== '');
  if (segments.length === 0) return '/';
  for (const t of ROUTE_TEMPLATES) {
    if (matchTemplate(t, segments)) return t;
  }
  return '/unknown';
}

// ---------------------------------------------------------------------------
// Request-id echo
// ---------------------------------------------------------------------------

/**
 * Echo the request id on the response. A 101 upgrade is returned untouched
 * (its headers are settled and the socket is in flight); an immutable-header
 * response is rewrapped, body stream intact.
 */
export function withRequestId(res: Response, requestId: string): Response {
  if (res.status === 101) return res;
  try {
    res.headers.set('x-request-id', requestId);
    return res;
  } catch {
    const wrapped = new Response(res.body, res);
    wrapped.headers.set('x-request-id', requestId);
    return wrapped;
  }
}

// ---------------------------------------------------------------------------
// /healthz
// ---------------------------------------------------------------------------

/** The slice of Env healthz needs — structural, so a test can hand it a
 *  deliberately broken binding without faking the whole Env. */
export interface HealthzEnv {
  DB: { prepare(query: string): { first(): Promise<unknown> } };
  STORE: { head(key: string): Promise<unknown> };
  COMPUTER?: { idFromName(name: string): unknown; get(id: never): unknown };
  VERSION?: string;
  STORE_URI?: string;
  CF_ACCOUNT_ID?: string;
  R2_PARENT_ACCESS_KEY_ID?: string;
  R2_PARENT_API_TOKEN?: string;
}

export interface HealthzOptions {
  /** Per-dependency probe budget; a hung binding must not hang the probe. */
  timeoutMs?: number;
}

async function bounded<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Cap and stringify a probe failure. Binding errors are configuration-shaped,
 *  not tenant-shaped, but the cap holds either way. */
function failureDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const safe = redactString(msg);
  return safe.length > 200 ? `${safe.slice(0, 200)}…` : safe;
}

/**
 * GET /healthz — unauthenticated, tenant-content-free (spec 6.3 discipline
 * applies to ops surfaces too): it names deployment facts (version, which
 * dependency answered) and nothing about any computer or user.
 *
 *  - `d1`: `SELECT 1`, bounded.
 *  - `r2`: HEAD of a fixed probe key, bounded. A `null` (key absent) is still
 *    an ANSWER — the store responded; only an error/timeout is a failure.
 *  - `do`: constructing a stub is the cheapest truthful check (`idFromName` +
 *    `get` validate the namespace binding without dispatching a request or
 *    materializing anything). No RPC is made on purpose: a healthz that
 *    creates Durable Objects is a healthz that costs money and storage.
 *
 * 200 only when the core dependencies (D1, R2) both answer; 503 otherwise,
 * with per-dependency status and detail.
 */
export async function healthz(env: HealthzEnv, opts: HealthzOptions = {}): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 1000;
  const detail: Record<string, string> = {};

  let d1: 'ok' | 'fail' = 'ok';
  try {
    await bounded(env.DB.prepare('SELECT 1').first(), timeoutMs, 'd1');
  } catch (err) {
    d1 = 'fail';
    detail['d1'] = failureDetail(err);
  }

  let r2: 'ok' | 'fail' = 'ok';
  try {
    await bounded(env.STORE.head('healthz-probe'), timeoutMs, 'r2');
  } catch (err) {
    r2 = 'fail';
    detail['r2'] = failureDetail(err);
  }

  let doStatus: 'ok' | 'fail' | 'skipped' = 'skipped';
  if (env.COMPUTER !== undefined) {
    try {
      env.COMPUTER.get(env.COMPUTER.idFromName('healthz-probe') as never);
      doStatus = 'ok';
    } catch (err) {
      doStatus = 'fail';
      detail['do'] = failureDetail(err);
    }
  } else {
    detail['do'] = 'no COMPUTER binding (Node entry probes its own substrate elsewhere)';
  }

  let storeConfig: 'ok' | 'fail' | 'not_required' = 'not_required';
  if (env.STORE_URI?.startsWith('s3://')) {
    const configured =
      Boolean(env.CF_ACCOUNT_ID) &&
      Boolean(env.R2_PARENT_ACCESS_KEY_ID) &&
      Boolean(env.R2_PARENT_API_TOKEN);
    storeConfig = configured ? 'ok' : 'fail';
    if (!configured) {
      detail['storeConfig'] =
        's3 store requires CF_ACCOUNT_ID, R2_PARENT_ACCESS_KEY_ID, and R2_PARENT_API_TOKEN';
    }
  }

  const ok = d1 === 'ok' && r2 === 'ok' && storeConfig !== 'fail';
  const body = {
    ok,
    version: env.VERSION ?? CONTROL_PLANE_VERSION,
    d1,
    r2,
    storeConfig,
    do: doStatus,
    time: Date.now(),
    ...(Object.keys(detail).length > 0 ? { detail } : {}),
  };
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 503,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
