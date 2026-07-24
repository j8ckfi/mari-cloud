// Sprites substrate driver (spec §3.7: "The first substrate is Sprites").
//
// Sprites (https://sprites.dev, by Fly.io) is a stateful sandbox service. This
// driver speaks its HTTP API with `fetch` ONLY, so it runs unchanged on
// Cloudflare Workers and on Node (spec §3.1/§11.2). No Node core modules, no
// WebSocket dependency.
//
// ── Endpoint mapping (spec §3.5 six functions → real Sprites API) ────────────
// Base URL: https://api.sprites.dev   Auth: `Authorization: Bearer <token>`
// Sources:
//   - API reference:  https://docs.sprites.dev/api/dev-latest/
//   - Sprites CRUD:    https://docs.sprites.dev/api/dev-latest/sprites/
//   - Exec:           https://docs.sprites.dev/api/dev-latest/exec/
//   - Ports:          https://docs.sprites.dev/api/dev-latest/ports/
//   - Lifecycle:      https://docs.sprites.dev/working-with-sprites/
//   - Quickstart:     https://docs.sprites.dev/quickstart/
//   - Exec framing (authoritative): superfly/sprites-js `src/exec.ts`
//     https://github.com/superfly/sprites-js/blob/main/src/exec.ts (execFileHTTP)
//
//   materialize  POST   /v1/sprites                 body {name, wait_for_capacity, url_settings}
//   destroy      DELETE /v1/sprites/{name}          -> 204
//   exec         POST   /v1/sprites/{name}/exec      ?cmd=&path=&dir=&env=  body=stdin
//                       response body = type-prefixed frames (1 stdout / 2 stderr
//                       / 3 exit[1-byte code]); we reconstruct {exitCode,stdout,stderr}.
//   exposePort   GET    /v1/sprites/{name}           -> .url, then append :{port}
//   sleep        (no endpoint)  Sprites auto-suspends on idle — see below.
//   wake         (no endpoint)  waking is implicit on activity — see below.
//
// ── Documented gaps where the public API has no exact §3.5 equivalent ────────
// * materialize: the create body has no field for a base image, per-computer
//   env, host mounts, or resource hints. On Sprites the image comes from the
//   org/checkpoint template, env is injected per-exec (query `env=`), a remote
//   sandbox has no host FS to mount, and sizing is org policy. So this driver
//   creates the sprite and stashes `spec.env` on the handle for exec to inject;
//   `image`, `mounts`, and `resources` are recorded but not sent (there is
//   nowhere to send them). A production setup pre-registers the base image as a
//   Sprites template/checkpoint.
// * sleep: Sprites has NO imperative suspend call. A sprite auto-suspends when
//   activity ceases (no active exec/console, no open TCP connection, no TTY) —
//   this IS the spec §2 WARM state (near-zero cost, immediate wake). marid's
//   run-hold heartbeat (spec §5.4) keeps it AWAKE during a run; when the hold
//   ends the platform suspends it. sleep() therefore issues NO request: it is a
//   correct no-op whose precondition (drop activity) the caller owns.
// * wake: waking is implicit — "when a request hits your Sprite's URL, it wakes
//   automatically" (working-with-sprites). There is no explicit resume call, so
//   wake() forces the transition with the smallest real activity: a trivial
//   `exec(["true"])`. That both wakes the sprite and confirms it reached AWAKE
//   (the exec only returns once the command ran).
// * exposePort: Sprites auto-exposes any listening port; the `ports/watch`
//   WebSocket only OBSERVES them and reports the authoritative per-port
//   `address`. v0 avoids a WS dependency and constructs the address from the
//   sprite's own `url` (from GET /v1/sprites/{name}) plus the port, per Sprites'
//   port-proxy scheme. It does not confirm the port is actually listening.

import type {
  MaterializeSpec,
  SubstrateHandle,
  SubstrateProvider,
  ExecOptions,
  ExecResult,
} from './provider.js';

/** The registry name of this driver. */
export const SPRITES_SUBSTRATE = 'sprites';

/** Default Sprites API base URL. */
export const DEFAULT_SPRITES_BASE_URL = 'https://api.sprites.dev';

/** Sprites HTTP exec frame stream ids (superfly/sprites-js exec protocol). */
const FRAME_STDOUT = 1;
const FRAME_STDERR = 2;
const FRAME_EXIT = 3;

/**
 * Sprites handle. Extends the base handle with the sprite `name` (the API path
 * key), its `url`, and the marid `env` to inject at exec time (see gap notes).
 * Fully serializable for DO storage.
 */
export interface SpritesHandle extends SubstrateHandle {
  readonly substrate: typeof SPRITES_SUBSTRATE;
  /** Sprite name — the `{name}` path segment. */
  readonly name: string;
  /** The sprite's canonical URL as returned by the API. */
  readonly url: string;
  /** marid env, injected on each exec since Sprites has no create-time env. */
  readonly env: Readonly<Record<string, string>>;
}

/** Sprites driver configuration. */
export interface SpritesConfig {
  /** API token (`Authorization: Bearer <token>`). */
  readonly token: string;
  /** API base URL. Defaults to {@link DEFAULT_SPRITES_BASE_URL}. */
  readonly baseUrl?: string;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

interface SpriteResource {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly status?: string;
}

function isSpritesHandle(handle: SubstrateHandle): asserts handle is SpritesHandle {
  if (handle.substrate !== SPRITES_SUBSTRATE) {
    throw new Error(`SpritesProvider received a "${handle.substrate}" handle`);
  }
}

/** `SubstrateProvider` for the Sprites API over `fetch` (Workers + Node). */
export class SpritesProvider implements SubstrateProvider {
  readonly name = SPRITES_SUBSTRATE;

  private readonly token: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: SpritesConfig) {
    if (!config.token) throw new Error('SpritesProvider requires an API token');
    this.token = config.token;
    this.baseUrl = (config.baseUrl ?? DEFAULT_SPRITES_BASE_URL).replace(/\/+$/, '');
    this.fetchImpl = config.fetch ?? fetch;
  }

  async materialize(spec: MaterializeSpec): Promise<SpritesHandle> {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/sprites`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: spec.computer,
        wait_for_capacity: true,
        url_settings: { auth: 'sprite' },
      }),
    });
    if (!res.ok) throw await apiError('create sprite', res);
    const sprite = (await res.json()) as SpriteResource;
    return {
      substrate: SPRITES_SUBSTRATE,
      computer: spec.computer,
      id: sprite.id,
      name: sprite.name,
      url: sprite.url,
      env: { ...spec.env },
    };
  }

  async destroy(handle: SubstrateHandle): Promise<void> {
    isSpritesHandle(handle);
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/sprites/${encodeURIComponent(handle.name)}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${this.token}` } },
    );
    // 204 on success; 404 means already gone — both are success.
    if (!res.ok && res.status !== 404) throw await apiError('delete sprite', res);
  }

  async sleep(handle: SubstrateHandle): Promise<void> {
    isSpritesHandle(handle);
    // No-op by design: Sprites suspends automatically when activity ceases
    // (see the "sleep" gap note in the file header). Issuing no request is the
    // correct behavior — the caller drops the run-hold to let the platform
    // suspend the sprite into WARM.
  }

  async wake(handle: SubstrateHandle): Promise<void> {
    isSpritesHandle(handle);
    // Force the implicit wake with the smallest real activity and confirm the
    // sprite reached AWAKE (exec returns only once the command ran).
    await this.exec(handle, ['true']);
  }

  async exec(
    handle: SubstrateHandle,
    argv: readonly string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    isSpritesHandle(handle);
    if (argv.length === 0) throw new Error('exec requires a non-empty argv');

    const url = new URL(`${this.baseUrl}/v1/sprites/${encodeURIComponent(handle.name)}/exec`);
    for (const arg of argv) url.searchParams.append('cmd', arg);
    url.searchParams.set('path', argv[0]!);
    if (opts.cwd) url.searchParams.set('dir', opts.cwd);
    // Inject the handle's marid env (Sprites has no create-time env), then the
    // per-exec env overrides.
    for (const [k, v] of Object.entries({ ...handle.env, ...(opts.env ?? {}) })) {
      url.searchParams.append('env', `${k}=${v}`);
    }
    if (opts.input != null) url.searchParams.set('stdin', 'true');

    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/octet-stream',
      },
      body: execBody(opts.input),
    });
    if (!res.ok) throw await apiError('exec', res);
    if (!res.body) throw new Error('exec response had no body');
    return parseExecFrames(res.body);
  }

  async exposePort(handle: SubstrateHandle, port: number): Promise<string> {
    isSpritesHandle(handle);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`invalid port ${port}`);
    }
    const res = await this.fetchImpl(
      `${this.baseUrl}/v1/sprites/${encodeURIComponent(handle.name)}`,
      { method: 'GET', headers: { Authorization: `Bearer ${this.token}` } },
    );
    if (!res.ok) throw await apiError('get sprite', res);
    const sprite = (await res.json()) as SpriteResource;
    const u = new URL(sprite.url);
    return `${u.protocol}//${u.hostname}:${port}`;
  }
}

/**
 * Create a `SpritesProvider` from environment. Reads `SPRITES_TOKEN` and
 * optional `SPRITES_BASE_URL` from the passed env record (default:
 * `process.env` when present, else `{}` — Workers pass their own env in).
 */
export function createSpritesProvider(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
  overrides: Partial<SpritesConfig> = {},
): SpritesProvider {
  const token = overrides.token ?? env.SPRITES_TOKEN;
  if (!token) {
    throw new Error('createSpritesProvider: SPRITES_TOKEN is not set');
  }
  return new SpritesProvider({
    token,
    baseUrl: overrides.baseUrl ?? env.SPRITES_BASE_URL,
    fetch: overrides.fetch,
  });
}

/**
 * Parse a Sprites HTTP exec response body into `{exitCode, stdout, stderr}`.
 *
 * The server writes type-prefixed frames — byte 0 is the stream id (1 stdout,
 * 2 stderr, 3 exit), the rest is payload — and relies on HTTP chunk boundaries
 * being preserved (one read == one frame). An exit frame's payload is a single
 * byte: the exit code. This mirrors superfly/sprites-js `execFileHTTP`. The
 * WebSocket exec endpoint carries the same frames without the boundary
 * dependency and is the path to swap in for large output later.
 */
async function parseExecFrames(body: ReadableStream<Uint8Array>): Promise<ExecResult> {
  const stdout: number[] = [];
  const stderr: number[] = [];
  let exitCode = -1;
  const reader = body.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value || value.length === 0) continue;
      const frameType = value[0];
      const payload = value.subarray(1);
      if (frameType === FRAME_STDOUT) {
        for (const b of payload) stdout.push(b);
      } else if (frameType === FRAME_STDERR) {
        for (const b of payload) stderr.push(b);
      } else if (frameType === FRAME_EXIT) {
        if (payload.length !== 1) {
          throw new Error(
            `invalid exec exit frame length ${payload.length}; the Sprites HTTP ` +
              'protocol requires preserved chunk boundaries (use the WS exec path for large output)',
          );
        }
        exitCode = payload[0]!;
      } else {
        throw new Error(
          `unsupported exec frame type 0x${(frameType ?? 0).toString(16).padStart(2, '0')}; ` +
            'HTTP chunk boundaries were not preserved',
        );
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (exitCode < 0) throw new Error('exec response did not include an exit frame');
  const dec = new TextDecoder();
  return {
    exitCode,
    stdout: dec.decode(Uint8Array.from(stdout)),
    stderr: dec.decode(Uint8Array.from(stderr)),
  };
}

/**
 * Normalize exec stdin to a cross-runtime `BodyInit`. A string is passed
 * through (fetch UTF-8 encodes it); binary is copied into a standalone
 * `ArrayBuffer` because the Workers `BodyInit` union accepts `ArrayBuffer` but
 * not a bare `ArrayBufferView`.
 */
function execBody(input: Uint8Array | string | undefined): string | ArrayBuffer | undefined {
  if (input == null) return undefined;
  if (typeof input === 'string') return input;
  const copy = new Uint8Array(input.byteLength);
  copy.set(input);
  return copy.buffer;
}

async function apiError(op: string, res: Response): Promise<Error> {
  let detail = '';
  try {
    detail = await res.text();
  } catch {
    // ignore
  }
  return new Error(`Sprites ${op} failed: ${res.status} ${res.statusText}${detail ? ` — ${detail}` : ''}`);
}
