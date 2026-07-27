// Provisioning and clients for the CLOUDFLARE THESIS e2e (`e2e/cloudflare.e2e.test.ts`).
//
// Everything here is scaffolding around REAL infrastructure: a scratch Worker
// carrying the real control plane (`deploy/cf-thesis/`), a scratch D1, a scratch
// R2 bucket, and the real Cloudflare container image built from
// `deploy/Dockerfile.mari`. Nothing is faked; the only thing this module knows
// how to do that the product does not is create and destroy the scratch account
// resources, and drive a WebAuthn ceremony from Node.
//
// Naming rule, non-negotiable: every resource is `mari-thesis-e2e*`. The account
// runs unrelated container applications (perceptrons-runner-runner,
// sailbox-sailbox, vibesdk-production-userappsandboxservice) and the real Mari
// resources (`mari` D1, `mari-store` R2, app.mari.sh) — none of which this
// module may name, touch, or list-and-delete by pattern.

import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { SoftCredential } from './webauthn.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(HERE, '../..');
const APP_DIR = resolve(REPO, 'deploy/cf-thesis');
const CTX_DIR = resolve(APP_DIR, 'ctx');
const TEMPLATE = resolve(APP_DIR, 'wrangler.template.jsonc');
export const CONFIG = resolve(APP_DIR, 'wrangler.generated.jsonc');
const CONTROL_PLANE = resolve(REPO, 'packages/control-plane');

export const WORKER_NAME = 'mari-thesis-e2e';
/** wrangler derives `<worker>-<class lowercased>` for the container application. */
export const CONTAINER_APP = `${WORKER_NAME}-computerdo`;
export const D1_NAME = 'mari-thesis-e2e-db';
export const BUCKET = 'mari-thesis-e2e-store';
/** The account's workers.dev subdomain. The image has to be built for a known
 *  origin (it carries the store endpoint), so this is assumed and then VERIFIED
 *  against the URL the deploy actually reports. */
export const SUBDOMAIN = 'potteryrage';

/** AWAKE -> COLD idle deadline for this deploy (WARM is unsupported here, so
 *  this is the single tier deadline). Long enough that a phase's own REST calls
 *  do not race it, short enough to reach COLD inside a test. */
export const WARM_IDLE_MS = 25_000;

export interface Provisioned {
  origin: string;
  host: string;
  wsOrigin: string;
  e2eToken: string;
  storeKeyId: string;
  storeSecret: string;
  d1Id: string;
  reused: boolean;
}

// ---------------------------------------------------------------------------
// wrangler
// ---------------------------------------------------------------------------

export function wrangler(args: string[], timeoutMs = 1_800_000, useConfig = true): string {
  const full = useConfig ? [...args, '-c', CONFIG] : args;
  return execFileSync('npx', ['wrangler', ...full], {
    cwd: CONTROL_PLANE,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '',
      // Non-interactive: a prompt is a hang, and cleanup needs wrangler to
      // answer its own confirmations.
      CI: '1',
    },
  });
}

export function wranglerQuiet(args: string[], timeoutMs = 300_000, useConfig = true): string {
  try {
    return wrangler(args, timeoutMs, useConfig);
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return `${e.stdout ?? ''}${e.stderr ?? ''}${e.message ?? ''}`;
  }
}

// ---------------------------------------------------------------------------
// The image build context
// ---------------------------------------------------------------------------

/**
 * Legacy scratch image assembler. Production now builds marid with S3 + TLS and
 * injects tenant-scoped temporary R2 credentials at materialize. This harness
 * still expects the pre-fix Dockerfile and bakes `ENV AWS_*` for its short-lived
 * S3 facade; until migrated, a gated run intentionally fails the exact-delta
 * assertion instead of silently claiming production R2/TLS coverage.
 */
export function assembleContext(opts: {
  endpoint: string;
  keyId: string;
  secret: string;
}): { dockerfile: string; base: string } {
  rmSync(CTX_DIR, { recursive: true, force: true });
  mkdirSync(CTX_DIR, { recursive: true });

  for (const f of ['Cargo.toml', 'Cargo.lock', 'rust-toolchain.toml']) {
    cpSync(resolve(REPO, f), resolve(CTX_DIR, f));
  }
  for (const crate of ['mari-proto', 'mari-core', 'marid']) {
    const from = resolve(REPO, 'crates', crate);
    const to = resolve(CTX_DIR, 'crates', crate);
    mkdirSync(to, { recursive: true });
    cpSync(resolve(from, 'Cargo.toml'), resolve(to, 'Cargo.toml'));
    cpSync(resolve(from, 'src'), resolve(to, 'src'), { recursive: true });
    if (existsSync(resolve(from, 'tests'))) {
      cpSync(resolve(from, 'tests'), resolve(to, 'tests'), { recursive: true });
    }
  }

  const base = readFileSync(resolve(REPO, 'deploy/Dockerfile.mari'), 'utf8');
  const BUILD_LINE = 'cargo build -p marid --locked --release --target "$TARGET"';
  if (!base.includes(BUILD_LINE)) {
    throw new Error(
      `deploy/Dockerfile.mari no longer contains ${JSON.stringify(BUILD_LINE)}; ` +
        'the thesis e2e patches exactly that line and must be updated deliberately',
    );
  }
  const dockerfile =
    base.replace(
      BUILD_LINE,
      'cargo build -p marid --locked --release --features s3 --target "$TARGET"',
    ) +
    [
      '',
      '# ---- thesis-e2e only ---------------------------------------------------',
      '# The chunk store lives off-container (all disk here is ephemeral), and Mari',
      '# now hands hosted computers temporary tenant credentials. This legacy scratch',
      '# harness instead bakes a random facade key for its own short lifetime.',
      '# These values reach opendal through its default credential chain.',
      `ENV AWS_ENDPOINT_URL=${opts.endpoint} \\`,
      '    AWS_REGION=auto \\',
      `    AWS_ACCESS_KEY_ID=${opts.keyId} \\`,
      `    AWS_SECRET_ACCESS_KEY=${opts.secret}`,
      '',
    ].join('\n');
  writeFileSync(resolve(CTX_DIR, 'Dockerfile'), dockerfile);
  return { dockerfile, base };
}

export function writeConfig(v: {
  origin: string;
  host: string;
  wsOrigin: string;
  d1Id: string;
  authSecret: string;
  storeKeyId: string;
  e2eToken: string;
}): void {
  const template = readFileSync(TEMPLATE, 'utf8');
  const filled = template
    .replaceAll('__D1_NAME__', D1_NAME)
    .replaceAll('__D1_ID__', v.d1Id)
    .replaceAll('__BUCKET__', BUCKET)
    .replaceAll('__ORIGIN__', v.origin)
    .replaceAll('__HOST__', v.host)
    .replaceAll('__WS_ORIGIN__', v.wsOrigin)
    .replaceAll('__AUTH_SECRET__', v.authSecret)
    .replaceAll('__STORE_KEY_ID__', v.storeKeyId)
    .replaceAll('__E2E_TOKEN__', v.e2eToken)
    .replaceAll('__WARM_IDLE_MS__', String(WARM_IDLE_MS));
  if (filled.includes('__')) {
    const left = /__[A-Z0-9_]+__/.exec(filled);
    if (left) throw new Error(`unsubstituted placeholder in wrangler config: ${left[0]}`);
  }
  writeFileSync(CONFIG, filled);
}

// ---------------------------------------------------------------------------
// Account resources
// ---------------------------------------------------------------------------

function existingD1Id(): string | null {
  const out = wranglerQuiet(['d1', 'list', '--json'], 120_000, false);
  try {
    const rows = JSON.parse(out) as { uuid?: string; name?: string }[];
    const row = rows.find((r) => r.name === D1_NAME);
    return row?.uuid ?? null;
  } catch {
    return null;
  }
}

export function ensureD1(): string {
  const existing = existingD1Id();
  if (existing) return existing;
  const out = wranglerQuiet(['d1', 'create', D1_NAME], 300_000, false);
  const m = /"?database_id"?\s*[:=]\s*"?([0-9a-f-]{36})/i.exec(out) ?? /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(out);
  if (!m) throw new Error(`could not read the new D1 id from:\n${out}`);
  return m[1] as string;
}

export function ensureBucket(): void {
  const list = wranglerQuiet(['r2', 'bucket', 'list'], 120_000, false);
  if (list.includes(BUCKET)) return;
  wrangler(['r2', 'bucket', 'create', BUCKET, '--location', 'weur'], 300_000, false);
}

/** The container application's row from `containers list`, or null when gone. */
export function containerApp(): { id: string; line: string } | null {
  const list = wranglerQuiet(['containers', 'list'], 120_000, false);
  for (const line of list.split('\n')) {
    if (!line.includes(CONTAINER_APP)) continue;
    const id = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/.exec(line);
    if (id) return { id: id[1] as string, line };
  }
  return null;
}

/**
 * The PLATFORM's own view of the instances, which is the only view of a
 * container that does not come from Mari: `wrangler containers instances`
 * names each instance after the Durable Object that owns it — i.e. after the
 * computer id — and reports its state. Used to prove a container really was
 * destroyed rather than believing the control plane's word for it.
 */
export function containerInstances(appId: string): { id: string; name: string; state: string }[] {
  const out = wranglerQuiet(['containers', 'instances', appId], 120_000, false);
  const rows: { id: string; name: string; state: string }[] = [];
  for (const line of out.split('\n')) {
    if (!line.includes('│')) continue;
    const cells = line
      .split('│')
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (cells.length < 3) continue;
    if (!/^[0-9a-f]{64}$/.test(cells[0] ?? '')) continue;
    rows.push({ id: cells[0] as string, name: cells[1] as string, state: cells[2] as string });
  }
  return rows;
}

/** The platform's state for one computer's instance, or `'none'` when the
 *  platform has no instance for it at all. */
export function instanceState(appId: string, computer: string): string {
  return containerInstances(appId).find((i) => i.name === computer)?.state ?? 'none';
}

export interface DeployResult {
  origin: string;
  output: string;
}

export function deploy(): DeployResult {
  const out = wrangler(['deploy'], 2_400_000);
  const m = /https:\/\/([a-z0-9-]+\.[a-z0-9-]+\.workers\.dev)/i.exec(out);
  if (!m) throw new Error(`deploy printed no workers.dev URL:\n${out}`);
  return { origin: `https://${m[1]}`, output: out };
}

export function applyMigrations(): string {
  return wrangler(['d1', 'migrations', 'apply', D1_NAME, '--remote'], 600_000);
}

// ---------------------------------------------------------------------------
// HTTP / WebSocket client
// ---------------------------------------------------------------------------

export interface Res<T> {
  status: number;
  body: T;
  bytes: Uint8Array;
  headers: Headers;
}

/** One client identity: a cookie jar plus the origin it talks to. */
export class Client {
  readonly origin: string;
  #jar = new Map<string, string>();

  constructor(origin: string) {
    this.origin = origin;
  }

  get cookie(): string {
    return [...this.#jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res: Response): void {
    for (const raw of res.headers.getSetCookie()) {
      const first = raw.split(';')[0] ?? '';
      const eq = first.indexOf('=');
      if (eq <= 0) continue;
      const name = first.slice(0, eq);
      const value = first.slice(eq + 1);
      if (value === '' || /max-age=0\b/i.test(raw)) this.#jar.delete(name);
      else this.#jar.set(name, value);
    }
  }

  /**
   * One REST call, with a HARD deadline.
   *
   * The timeout is not decoration: a control-plane route can block behind an
   * in-flight wake (`ComputerDO.#wakeInFlight`), and a suite that waits forever
   * on it reports nothing at all — which is exactly how a run of this suite once
   * hung for an hour on `POST /wake`. A request that exceeds the deadline throws,
   * and the caller's `waitFor` turns that into a legible failure.
   */
  async req<T = unknown>(
    method: string,
    path: string,
    init: { body?: string | Uint8Array; headers?: Record<string, string>; timeoutMs?: number } = {},
  ): Promise<Res<T>> {
    const headers: Record<string, string> = { ...init.headers };
    const cookie = this.cookie;
    if (cookie) headers['cookie'] = cookie;
    if (init.body !== undefined && !headers['content-type']) {
      headers['content-type'] =
        typeof init.body === 'string' ? 'application/json' : 'application/octet-stream';
    }
    const res = await fetch(`${this.origin}${path}`, {
      method,
      headers,
      body: init.body as BodyInit | undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(init.timeoutMs ?? 60_000),
    });
    this.absorb(res);
    const bytes = new Uint8Array(await res.arrayBuffer());
    const text = Buffer.from(bytes).toString('utf8');
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      /* not JSON: a file read or an XML error */
    }
    return { status: res.status, body: body as T, bytes, headers: res.headers };
  }

  get<T>(path: string): Promise<Res<T>> {
    return this.req<T>('GET', path);
  }

  post<T>(path: string, body: unknown = {}): Promise<Res<T>> {
    return this.req<T>('POST', path, { body: JSON.stringify(body) });
  }
}

/** A full passkey sign-UP: the ceremony creates the account (auth.ts). */
export async function signUpWithPasskey(
  client: Client,
  email: string,
): Promise<{ credential: SoftCredential; userId: string }> {
  const opts = await client.get<{
    challenge: string;
    rp: { id: string; name: string };
    user: { id: string };
  }>(`/api/auth/passkey/generate-register-options?context=${encodeURIComponent(email)}`);
  if (opts.status !== 200) {
    throw new Error(`generate-register-options -> ${opts.status} ${JSON.stringify(opts.body)}`);
  }
  const credential = await SoftCredential.create(opts.body.rp.id, opts.body.user.id);
  const attestation = await credential.attest(opts.body.challenge, client.origin);
  const verified = await client.req<{ userId?: string; id?: string }>(
    'POST',
    '/api/auth/passkey/verify-registration',
    { body: JSON.stringify({ response: attestation }), headers: { origin: client.origin } },
  );
  if (verified.status !== 200) {
    throw new Error(`verify-registration -> ${verified.status} ${JSON.stringify(verified.body)}`);
  }
  const session = await client.get<{ user?: { id: string } }>('/api/auth/get-session');
  return { credential, userId: session.body?.user?.id ?? '' };
}

/** An attach socket (contracts.md §7): every DO -> client message, and whether
 *  the socket ever closed. */
export class Attach {
  readonly messages: { t: string; run?: string; offset?: number; bytes?: Uint8Array }[] = [];
  closed: { code: number; at: number } | null = null;
  errored: string | null = null;
  #ws: WebSocket;
  readonly openedAt = Date.now();

  private constructor(ws: WebSocket) {
    this.#ws = ws;
  }

  static async open(
    origin: string,
    cookie: string,
    computerId: string,
    decode: (b: Uint8Array) => unknown,
  ): Promise<Attach> {
    const url = new URL(`/attach/${encodeURIComponent(computerId)}`, origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(url.toString(), { headers: { Cookie: cookie } });
    const attach = new Attach(ws);
    ws.on('message', (data: Buffer) => {
      try {
        attach.messages.push(
          decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) as {
            t: string;
          },
        );
      } catch {
        /* an undecodable frame shows up as a missing message in assertions */
      }
    });
    ws.on('close', (code: number) => {
      attach.closed = { code, at: Date.now() };
    });
    ws.on('error', (e: Error) => {
      attach.errored = e.message;
    });
    await new Promise<void>((res, rej) => {
      ws.once('open', () => res());
      ws.once('error', rej);
      ws.once('unexpected-response', (_r, r2) => rej(new Error(`upgrade refused ${r2.statusCode}`)));
    });
    return attach;
  }

  send(bytes: Uint8Array): void {
    this.#ws.send(Buffer.from(bytes));
  }

  get open(): boolean {
    return this.#ws.readyState === WebSocket.OPEN;
  }

  /** Live terminal bytes for a run, in arrival order. */
  frames(run: string): Uint8Array {
    const parts = this.messages
      .filter((m) => m.t === 'frame' && m.run === run && m.bytes instanceof Uint8Array)
      .map((m) => m.bytes as Uint8Array);
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      /* already gone */
    }
  }
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function randomToken(bytes = 24): string {
  return randomBytes(bytes).toString('base64url');
}

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `probe` until it returns a value, or throw with the last observation. */
export async function waitFor<T>(
  what: string,
  probe: () => Promise<T | null | undefined>,
  timeoutMs: number,
  intervalMs = 400,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown = null;
  for (;;) {
    try {
      const v = await probe();
      if (v !== null && v !== undefined && v !== false) return v as T;
      last = v;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what} (last: ${String(last)})`);
    }
    await delay(intervalMs);
  }
}

/** p50/p99 over a sample, reported the way spec §13 asks for it. */
export class Samples {
  readonly values: number[] = [];
  constructor(readonly name: string) {}
  add(ms: number): void {
    this.values.push(ms);
  }
  pct(p: number): number {
    if (this.values.length === 0) return NaN;
    const sorted = [...this.values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
    return sorted[Math.max(0, idx)] as number;
  }
  get n(): number {
    return this.values.length;
  }
  line(): string {
    return `${this.name}: n=${this.n} min=${Math.min(...this.values)} p50=${this.pct(50)} p90=${this.pct(90)} p99=${this.pct(99)} max=${Math.max(...this.values)} (ms) samples=[${this.values.join(', ')}]`;
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
