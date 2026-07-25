// Cloudflare Containers substrate driver (docs/substrates-cloudflare.md item 4).
//
// WORKERS-ONLY, and deliberately written against the RAW `ctx.container` API and
// nothing else:
//
//   * NOT `@cloudflare/sandbox`. That SDK ships its own `/container-server`
//     supervisor inside the image, with its own sessions, PTY server, process
//     manager and backup system. That is `marid`'s job, and two supervisors in
//     one container fails spec §1.2 on sight.
//   * NOT the `@cloudflare/containers` `Container` class either. Its `sleepAfter`
//     / `renewActivityTimeout` / `keepAlive` conveniences do not exist on the raw
//     API, and its 10-minute idle stop would kill a container that is actively
//     streaming a journal (an outbound WebSocket is invisible to a platform
//     activity timer — measured; see `holdAwake`).
//
// The container is bound to a Durable Object CLASS at deploy time (wrangler
// `containers[].class_name` + `image` + `instance_type`), so `ComputerDO` is the
// container class and one computer = one DO = one container instance = one
// Firecracker microVM (spec §10.4 holds with Mari doing nothing). Two consequences
// are structural and not driver bugs:
//
//   1. `instance_type` is per DO class, so spec §3.6's per-wake SIZING is not
//      available here (substrate SELECTION still is). `MaterializeSpec.resources`
//      is therefore recorded and ignored.
//   2. There is exactly ONE instance slot per computer. `materialize` means "a new
//      epoch generation starts now", so if the slot is occupied by the previous
//      generation this driver destroys it first (see materialize).
//
// ── The six functions (spec §3.5), mapped ────────────────────────────────────
//   materialize  start({ entrypoint, env, enableInternet: true, labels }) and
//                wait until the instance can actually run a process.
//   destroy      destroy().
//   sleep        destroy() as well — WARM is UNSUPPORTED here, see below.
//   wake         start() with the recorded startup options; marid then performs
//                the streaming restore (spec §4.6) from MARI_RESTORE_MANIFEST.
//   exec         `running` check, then exec(argv, { cwd, env, stdin }), then
//                output().
//   exposePort   reports the in-computer address; `proxyFetch` (the optional
//                capability) is how bytes actually travel, via
//                getTcpPort(port).fetch() from ComputerDO.fetch(). NOT a tunnel:
//                a tunnel would front the container at the edge directly and
//                bypass the control plane's auth and epoch gating.
//
// ── WARM is unsupported, on purpose ──────────────────────────────────────────
// "All disk is ephemeral. When a Container instance goes to sleep, the next time
// it is started, it will have a fresh disk as defined by its container image."
// That was also measured rather than quoted: a marker file written to /work did
// not survive destroy + start, and /work came back exactly as the image defines
// it. So `supportsWarm = false`, `sleep` ≡ `destroy`, and the tier policy takes a
// computer AWAKE → COLD directly (still writing the pre-transition manifest spec
// §4.5 requires). The collapse costs almost nothing: Cloudflare bills nothing for
// a stopped container, so WARM's whole product — cheap idle — is already free,
// and what is lost is wake latency (measured: container start → marid logging
// "cold-wake restore complete" for a 35 MiB, 45-entry manifest was 686 ms and
// 1037 ms), not money.
//
// ── Measured platform behaviour this driver is shaped by ─────────────────────
// (Empirical, from real containers on this account — instance_type standard-1,
// kernel 6.18.36-cloudflare-firecracker.)
//
//   * start → exec-ready was 47/55/106/116 ms on never-started instances, so the
//     readiness probe is cheap and worth its guarantee.
//   * `destroy()` then `start()` on the SAME Durable Object is refused for
//     MINUTES (measured >563 s and ~300 s, both eventually recovering), while
//     `container.running` keeps reporting a stale `true` and `exec()` fails with
//     "no container instance". This driver therefore never trusts `running` alone,
//     retries `start()` until it is accepted, and fails with a TYPED, bounded
//     error instead of hanging.
//   * Over `max_instances`, `start()`/`exec()` reports "There is no container
//     instance that can be provided to this Durable Object, try again later" —
//     and the exec can HANG rather than erroring. Every platform call here is
//     therefore raced against a budget, and that message maps to
//     {@link CloudflareSubstrateError} kind `capacity`, which the DO reports.
//   * `ctx.container.monitor()` is cancelled with the originating request's I/O
//     context, so a platform-initiated stop goes completely unrecorded unless the
//     promise is wrapped in `ctx.waitUntil()` — see {@link CloudflareConfig.waitUntil}.
//   * `setInactivityTimeout` is undocumented and did not fire at 10 s or 60 s;
//     the DO's own alarm is the real idle policy (see `holdAwake`).

import type {
  MaterializeSpec,
  SubstrateHandle,
  SubstrateProvider,
  ExecOptions,
  ExecResult,
} from './provider.js';

/** The registry name of this driver. */
export const CLOUDFLARE_SUBSTRATE = 'cloudflare';

/** Label stamped on every instance, mirroring the Docker driver's key. */
export const COMPUTER_LABEL = 'mari.computer';

/** Label carrying the wake epoch, so an instance can be attributed to the
 *  generation that started it (contracts.md §6 fencing). */
export const EPOCH_LABEL = 'mari.epoch';

/** How the platform words "over max_instances, or the previous instance of this
 *  Durable Object is still being torn down". The two are indistinguishable from
 *  the message alone — the error text below says so rather than guessing. */
const NO_INSTANCE_RE = /no container instance/i;

/** `start()` on a container the platform still considers up. */
const ALREADY_RUNNING_RE = /already running/i;

/** Defaults, all overridable via {@link CloudflareConfig}. */
const DEFAULT_START_TIMEOUT_MS = 30_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_DESTROY_TIMEOUT_MS = 10_000;
const DEFAULT_PROBE_INTERVAL_MS = 100;
/** Ceiling for one readiness probe; the loop, not the probe, owns the budget. */
const PROBE_EXEC_TIMEOUT_MS = 5_000;
/**
 * Value `holdAwake` re-asserts on the platform's inactivity timer. Longer than
 * the DO's default AWAKE idle deadline (5 min) on purpose: the DO alarm must be
 * what takes a computer down, never a platform timer racing it.
 */
const DEFAULT_HOLD_AWAKE_MS = 15 * 60_000;

/** The readiness probe: the cheapest possible "can this instance run a process".
 *  `/bin/sh` is guaranteed by the base image (a run is an arbitrary program the
 *  user brought, so a POSIX userland is part of the contract). */
const DEFAULT_READY_PROBE = ['/bin/sh', '-c', 'exit 0'] as const;

/** What went wrong, so a caller can branch without parsing English. */
export type CloudflareErrorKind =
  /** The Durable Object has no `containers` binding — a deployment error. */
  | 'no_binding'
  /** Over `max_instances`, or the previous instance is still being torn down. */
  | 'capacity'
  /** A platform call did not answer inside its budget (it may still be running). */
  | 'timeout'
  /** The instance is not running, and this operation must not start it. */
  | 'not_running'
  /** The platform refused the call for a reason this driver does not model. */
  | 'platform';

/** A typed substrate failure. The DO reports the message and logs it; `kind`
 *  exists so an operator alert can distinguish capacity from a bad deployment. */
export class CloudflareSubstrateError extends Error {
  override readonly name = 'CloudflareSubstrateError';
  readonly kind: CloudflareErrorKind;
  /** True when a later attempt could plausibly succeed. */
  readonly retryable: boolean;
  /** The underlying platform error, when there was one. */
  override readonly cause?: unknown;

  constructor(kind: CloudflareErrorKind, message: string, cause?: unknown) {
    super(message);
    this.kind = kind;
    this.retryable = kind === 'capacity' || kind === 'timeout';
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Cloudflare handle. `id` is the computer id: the instance has no separate
 * address, because it belongs to the computer's own Durable Object.
 *
 * It carries the startup options so {@link CloudflareProvider.wake} and
 * {@link CloudflareProvider.exec} can reconstruct everything they need from the
 * handle alone (provider.ts's rule — a driver instance does not outlive a
 * request). `env` therefore includes `MARI_TOKEN`: it is persisted in the same DO
 * storage that already holds that token, and a driver MUST NOT log it.
 */
export interface CloudflareHandle extends SubstrateHandle {
  readonly substrate: typeof CLOUDFLARE_SUBSTRATE;
  /** Entrypoint override, or `null` to use the image's own (marid). */
  readonly entrypoint: readonly string[] | null;
  /** marid's whole configuration, as handed to `start()`. Secret. */
  readonly env: Readonly<Record<string, string>>;
  /** The wake epoch this instance was started with, when the env carried one. */
  readonly epoch: number | null;
  /** Ports the caller asked for. Recorded only: Cloudflare needs no publish
   *  step, `getTcpPort` addresses any port on a running instance. */
  readonly ports: readonly number[];
}

/** Why an instance exited, as far as the driver can tell. */
export interface ContainerExitInfo {
  readonly computer: string;
  readonly epoch: number | null;
  /** Present when `monitor()` rejected rather than resolved. */
  readonly error?: string;
}

/** Driver configuration. Constructed per request with the live `ctx.container`. */
export interface CloudflareConfig {
  /**
   * `ctx.container` of the computer's own Durable Object. `undefined` when the
   * class has no `containers` binding — construction still succeeds and every
   * operation fails with a `no_binding` error, so a missing binding cannot brick
   * the DO's read-only paths (spec §8.4: a COLD computer is browsable without a
   * substrate at all).
   */
  readonly container?: Container | undefined;
  /** wrangler `max_instances`, quoted in the capacity error. Diagnostics only. */
  readonly maxInstances?: number;
  /** Budget for start → exec-ready. Default 30 s. */
  readonly startTimeoutMs?: number;
  /** Budget for one `exec` (spawn + output). Default 60 s. */
  readonly execTimeoutMs?: number;
  /** Budget for `destroy`. Default 10 s; exceeding it is not an error. */
  readonly destroyTimeoutMs?: number;
  /** Inactivity value `holdAwake` re-asserts. Default 15 min. */
  readonly holdAwakeMs?: number;
  /** Readiness probe argv; `null` skips the probe (not recommended). */
  readonly readyProbe?: readonly string[] | null;
  /** Poll interval while waiting for readiness. Default 100 ms. */
  readonly probeIntervalMs?: number;
  /**
   * `ctx.waitUntil`. REQUIRED for exit detection to work at all: a floating
   * `monitor()` promise is cancelled with the originating request's I/O context,
   * so without this a platform-initiated stop is never observed (spec §4.7).
   */
  readonly waitUntil?: (promise: Promise<unknown>) => void;
  /** Called when the instance exits — including a stop this driver asked for.
   *  The control plane knows which transitions it initiated; the driver does not. */
  readonly onContainerExit?: (info: ContainerExitInfo) => void;
  /** Injectable sleep, for deterministic tests. */
  readonly sleepFn?: (ms: number) => Promise<void>;
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => number;
}

function isCloudflareHandle(handle: SubstrateHandle): asserts handle is CloudflareHandle {
  if (handle.substrate !== CLOUDFLARE_SUBSTRATE) {
    throw new Error(`CloudflareProvider received a "${handle.substrate}" handle`);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Map a platform error onto {@link CloudflareErrorKind}. */
function classify(err: unknown, context: string, maxInstances: number | undefined): CloudflareSubstrateError {
  if (err instanceof CloudflareSubstrateError) return err;
  const msg = messageOf(err);
  if (NO_INSTANCE_RE.test(msg)) {
    const cap = maxInstances === undefined ? 'max_instances (default 20)' : `max_instances=${maxInstances}`;
    return new CloudflareSubstrateError(
      'capacity',
      `${context}: no container instance could be provided. Either the account is at ` +
        `${cap} for this container application, or this Durable Object's previous ` +
        `instance is still being torn down (measured: minutes after destroy(), while ` +
        `container.running still reports true). The platform message is identical for ` +
        `both. Platform said: ${msg}`,
      err,
    );
  }
  return new CloudflareSubstrateError('platform', `${context}: ${msg}`, err);
}

/** Decode `exec` output, which may arrive as bytes, text, or a stream. */
async function toText(value: unknown): Promise<string> {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    return new TextDecoder().decode(new Uint8Array(v.buffer, v.byteOffset, v.byteLength));
  }
  if (typeof (value as ReadableStream).getReader === 'function') {
    const reader = (value as ReadableStream<Uint8Array>).getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (chunk) {
        parts.push(chunk);
        total += chunk.length;
      }
    }
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const p of parts) {
      out.set(p, cursor);
      cursor += p.length;
    }
    return new TextDecoder().decode(out);
  }
  return String(value);
}

/** A one-shot `ReadableStream` over `input`, for `exec`'s stdin. */
function stdinStream(input: Uint8Array | string): ReadableStream<Uint8Array> {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * `SubstrateProvider` over the raw Cloudflare Containers API.
 *
 * Exactly spec §3.5's six functions, plus the two OPTIONAL declarations
 * provider.ts defines for capabilities other substrates express differently
 * (`holdAwake`, `proxyFetch`) and the `supportsWarm` flag. No other platform
 * capability is touched: no `keepAlive`, no `sleepAfter`, no `snapshotContainer`,
 * no Sandbox SDK.
 */
export class CloudflareProvider implements SubstrateProvider {
  readonly name = CLOUDFLARE_SUBSTRATE;

  /** Cloudflare wipes the disk on stop, so WARM would be a lie (see the file
   *  header). The DO's tier policy reads this and goes AWAKE → COLD directly. */
  readonly supportsWarm = false;

  readonly #cfg: CloudflareConfig;

  constructor(config: CloudflareConfig) {
    this.#cfg = config;
  }

  // ── spec §3.5: materialize ──────────────────────────────────────────────────

  /**
   * Start the computer's container instance and return once it can really run a
   * process.
   *
   * `enableInternet: true` is mandatory, not a convenience: marid dials the
   * control plane over an outbound `wss://` on 443 and that socket IS the journal
   * and the control channel. (Verified against a real container: DNS 18 ms, TCP
   * 4 ms, TLS 1.3 13 ms, HTTP 101 upgrade, byte-exact framed CBOR both ways, held
   * 15 minutes with 60 keepalives and no reconnect. With `enableInternet: false`
   * the same image never opened the socket while the container was demonstrably
   * alive — that was the negative control.)
   *
   * ONE INSTANCE SLOT: a materialize is by definition a new epoch generation
   * (the DO mints the epoch before calling), and the platform gives this Durable
   * Object exactly one instance. An instance still running here is therefore the
   * PREVIOUS generation, whose supervisor can no longer authenticate (its token
   * is dead) and whose disk is about to be discarded anyway. It is destroyed
   * first — spec §4.1's "two writable copies of one computer must not exist"
   * decided by the platform's own topology rather than by hope.
   */
  async materialize(spec: MaterializeSpec): Promise<CloudflareHandle> {
    const container = this.#container();
    const startup = this.#startupOptions(spec);

    if (container.running) {
      await this.#destroyQuietly(container, 'materialize (replacing the previous generation)');
    }

    await this.#startAndAwaitReady(container, startup, spec.computer);
    this.#armExitWatch(container, spec.computer, epochOf(spec.env));

    return {
      substrate: CLOUDFLARE_SUBSTRATE,
      computer: spec.computer,
      id: spec.computer,
      entrypoint: spec.cmd ? [...spec.cmd] : null,
      env: { ...spec.env },
      epoch: epochOf(spec.env),
      ports: [...(spec.ports ?? [])],
    };
  }

  // ── spec §3.5: destroy ──────────────────────────────────────────────────────

  /**
   * Destroy the instance. Stronger here than anywhere else: the disk is gone by
   * platform rule, so there is no orphaned-volume failure mode to clean up.
   *
   * Destroying an already-gone instance resolves without error (provider.ts).
   * Note that `container.running` can keep reporting `true` for minutes after
   * this resolves; the instance is nonetheless gone (a following `exec` fails
   * with "no container instance"), which is why `materialize` retries `start()`
   * rather than trusting the flag.
   */
  async destroy(handle: SubstrateHandle): Promise<void> {
    isCloudflareHandle(handle);
    const container = this.#container();
    await this.#destroyQuietly(container, 'destroy');
  }

  // ── spec §3.5: sleep ────────────────────────────────────────────────────────

  /**
   * WARM does not exist on this substrate: `sleep` is `destroy`.
   *
   * This is not a shortcut — keeping the resource would be pointless (a stopped
   * container costs $0 and its disk is wiped, so there is nothing to retain) and
   * recording WARM would be actively wrong (the next wake would "resume" a
   * resource that holds nothing). {@link supportsWarm} is `false` so the tier
   * policy never reaches this path; it is implemented anyway because §3.5 says
   * every substrate module obeys the interface, and because a caller that does
   * sleep a Cloudflare computer must end up in a state that is TRUE.
   */
  async sleep(handle: SubstrateHandle): Promise<void> {
    isCloudflareHandle(handle);
    const container = this.#container();
    await this.#destroyQuietly(container, 'sleep (WARM is unsupported: sleep destroys)');
  }

  // ── spec §3.5: wake ─────────────────────────────────────────────────────────

  /**
   * Start the instance again from the recorded startup options. marid then does
   * the streaming restore (spec §4.6) from `MARI_RESTORE_MANIFEST` in that env —
   * on this substrate every wake is a cold wake, because the disk it comes back
   * with is the image's.
   *
   * EPOCH CAVEAT, and it is the reason the tier policy matters: the recorded env
   * carries the epoch and token of the materialize that produced this handle. A
   * control plane that has minted a NEW epoch must call {@link materialize}, not
   * `wake`, or the booting supervisor would present a stale epoch and its
   * handshake would be rejected (contracts.md §6). ComputerDO does exactly that
   * for a substrate with `supportsWarm === false`, since such a computer is never
   * WARM and every wake takes the COLD → AWAKE (materialize) path.
   */
  async wake(handle: SubstrateHandle): Promise<void> {
    isCloudflareHandle(handle);
    const container = this.#container();
    const startup: ContainerStartupOptions = {
      enableInternet: true,
      env: { ...handle.env },
      labels: labelsFor(handle.computer, handle.epoch),
      ...(handle.entrypoint ? { entrypoint: [...handle.entrypoint] } : {}),
    };
    await this.#startAndAwaitReady(container, startup, handle.computer);
    this.#armExitWatch(container, handle.computer, handle.epoch);
  }

  // ── spec §3.5: exec ─────────────────────────────────────────────────────────

  /**
   * Run `argv` and capture output and exit status. `argv[0]` is the executable
   * and the array is NOT shell-interpreted — the platform agrees verbatim: "The
   * `exec()` operation starts the executable directly with the provided argument
   * array. It does not start a shell first."
   *
   * THE RUNNING CHECK FAILS LOUDLY INSTEAD OF STARTING. `exec()` does not start a
   * stopped container, and Cloudflare's docs suggest calling `start()` when it is
   * stopped. This driver refuses, because on THIS substrate a stopped instance
   * has no disk: the command would run against the base image rather than against
   * the computer, so a file write would land in a tree that is discarded and a
   * read would report a file "missing" that exists in the chunk store. Spec §4.1
   * says the substrate disk of an AWAKE computer is the only copy that accepts
   * writes — so the caller must WAKE the computer (fresh epoch, delta restored)
   * and only then exec. A `not_running` error says which.
   */
  async exec(
    handle: SubstrateHandle,
    argv: readonly string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    isCloudflareHandle(handle);
    if (argv.length === 0) throw new Error('exec requires a non-empty argv');
    const container = this.#container();
    if (!container.running) {
      throw new CloudflareSubstrateError(
        'not_running',
        `exec on computer "${handle.computer}": the container instance is not running. ` +
          `On Cloudflare a stopped instance has NO disk (it is wiped on stop), so this ` +
          `command would run against the base image and not against the computer. Wake ` +
          `the computer first (spec §4.1: the AWAKE substrate disk is the only writable copy).`,
      );
    }
    return this.#execRaw(container, argv, opts, this.#num(this.#cfg.execTimeoutMs, DEFAULT_EXEC_TIMEOUT_MS));
  }

  // ── spec §3.5: exposePort ───────────────────────────────────────────────────

  /**
   * The address that reaches `port` INSIDE the computer.
   *
   * Cloudflare publishes nothing: "End-users cannot make non-HTTP TCP or UDP
   * requests to a Container instance", and there is no host address to hand back.
   * The port is reachable only through the runtime that hosts this driver, which
   * is why {@link proxyFetch} exists and why the wake proxy must prefer it. Unlike
   * Docker, a port needs NO declaration at materialize time.
   *
   * This call still does real work: it rejects an out-of-range port, requires a
   * running instance, and asks the platform to address the port (`getTcpPort`),
   * so a caller learns immediately that the preview cannot be served.
   */
  async exposePort(handle: SubstrateHandle, port: number): Promise<string> {
    isCloudflareHandle(handle);
    const container = this.#container();
    assertPort(port);
    this.#requireRunning(container, handle, `exposePort(${port})`);
    container.getTcpPort(port);
    return `http://127.0.0.1:${port}`;
  }

  // ── Optional capability: proxyFetch (spec §8.5 preview mode) ─────────────────

  /**
   * Forward `request` to `port` inside the computer through the Worker-fronted
   * path, from `ComputerDO.fetch()`.
   *
   * This is the whole reason preview mode does not use `sandbox.tunnels`: a
   * tunnel runs `cloudflared` in the container and Cloudflare's edge fronts the
   * request directly, routing around the control plane's WebSocket auth and epoch
   * ingest gating. Here every byte still passes through the computer's own DO.
   * WebSockets work on this path (they cannot cross a Worker→DO RPC boundary,
   * which is why it must be the DO's own `fetch`, not a stub call).
   */
  async proxyFetch(handle: SubstrateHandle, port: number, request: Request): Promise<Response> {
    isCloudflareHandle(handle);
    const container = this.#container();
    assertPort(port);
    this.#requireRunning(container, handle, `proxyFetch(${port})`);
    return container.getTcpPort(port).fetch(request);
  }

  // ── Optional capability: holdAwake (spec §5.4 run hold) ─────────────────────

  /**
   * Re-assert the platform's inactivity timer while a run is in progress.
   *
   * `keepAlive` IS NEVER CALLED — it does not exist on the raw API, and the
   * `@cloudflare/containers` class that owns it would stop a container that is
   * merely streaming (its `sleepAfter` counts inbound requests as activity, and
   * an outbound WebSocket is invisible to it). `setInactivityTimeout` is the raw
   * API's only inactivity knob; it is undocumented and, measured, did not fire at
   * 10 s or at 60 s, so this call is belt-and-braces. The REAL hold is the DO's
   * own alarm, which `run_heartbeat` renews for every substrate — which is what
   * the platform's lack of a renewable `sleepAfter` calls for.
   *
   * Failure is swallowed: a platform that has removed or gated this method must
   * not be able to fail a run.
   */
  async holdAwake(handle: SubstrateHandle): Promise<void> {
    isCloudflareHandle(handle);
    const container = this.#cfg.container;
    if (!container || !container.running) return;
    try {
      await container.setInactivityTimeout(this.#num(this.#cfg.holdAwakeMs, DEFAULT_HOLD_AWAKE_MS));
    } catch {
      // Undocumented and measured not to fire; the DO alarm is the real policy.
    }
  }

  // ── internals ───────────────────────────────────────────────────────────────

  #container(): Container {
    const c = this.#cfg.container;
    if (!c) {
      throw new CloudflareSubstrateError(
        'no_binding',
        'this Durable Object has no `containers` binding: add a `containers` entry ' +
          'to wrangler.jsonc whose `class_name` is the computer DO class (and keep the ' +
          'class in `new_sqlite_classes`). A container-enabled DO is a deploy-time ' +
          'property, so this cannot be fixed at runtime.',
      );
    }
    return c;
  }

  /** The exact options handed to `start()`. */
  #startupOptions(spec: MaterializeSpec): ContainerStartupOptions {
    return {
      // marid's whole configuration (MARI_COMPUTER_ID / EPOCH / TOKEN / ROOT /
      // STORE / CONTROL_URL / RESTORE_MANIFEST), passed through unchanged.
      env: { ...spec.env },
      // The journal and control channel are an outbound wss:// on 443.
      enableInternet: true,
      labels: labelsFor(spec.computer, epochOf(spec.env)),
      // Omitted => the image's own ENTRYPOINT (marid) runs, which is the
      // production shape; `cmd` exists so a test can run a bespoke process.
      ...(spec.cmd ? { entrypoint: [...spec.cmd] } : {}),
      // `mounts` and `resources` are deliberately dropped: there is no host
      // filesystem to bind, and `instance_type` is fixed per DO class at deploy.
    };
  }

  /**
   * Start, then poll a readiness probe until the instance runs a process.
   *
   * `start()` is void and synchronous, so it is NOT the readiness signal: over
   * capacity, or while the previous instance drains, the call is accepted (or
   * throws "already running" against a stale flag) and it is the first successful
   * `exec` that marks the instance usable. The loop is bounded so a wake fails
   * with a typed error instead of hanging — the platform's own failure mode here
   * is a hang, which is worse than an error.
   */
  async #startAndAwaitReady(
    container: Container,
    startup: ContainerStartupOptions,
    computer: string,
  ): Promise<void> {
    const budget = this.#num(this.#cfg.startTimeoutMs, DEFAULT_START_TIMEOUT_MS);
    const interval = this.#num(this.#cfg.probeIntervalMs, DEFAULT_PROBE_INTERVAL_MS);
    const probe = this.#cfg.readyProbe === undefined ? DEFAULT_READY_PROBE : this.#cfg.readyProbe;
    const t0 = this.#now();
    let lastError: unknown = null;
    let attempts = 0;

    for (;;) {
      attempts++;
      try {
        container.start(startup);
      } catch (err) {
        // "already running" is expected on every retry after the first, and also
        // when `running` is stale-true after a destroy. Anything else is recorded
        // and retried until the budget runs out.
        if (!ALREADY_RUNNING_RE.test(messageOf(err))) lastError = err;
      }

      if (!probe || probe.length === 0) return;

      try {
        const result = await this.#execRaw(container, probe, {}, PROBE_EXEC_TIMEOUT_MS);
        if (result.exitCode === 0) return;
        lastError = new Error(`readiness probe exited ${result.exitCode}`);
      } catch (err) {
        lastError = err;
      }

      if (this.#now() - t0 >= budget) {
        const waited = this.#now() - t0;
        throw classify(
          lastError ?? new Error('readiness probe never succeeded'),
          `computer "${computer}" did not become exec-ready within ${budget} ms ` +
            `(waited ${waited} ms over ${attempts} attempts)`,
          this.#cfg.maxInstances,
        );
      }
      await this.#sleep(interval);
    }
  }

  /** One exec, bounded. Never leaves a hung platform promise awaited. */
  async #execRaw(
    container: Container,
    argv: readonly string[],
    opts: ExecOptions,
    budgetMs: number,
  ): Promise<ExecResult> {
    const execOptions: ContainerExecOptions = { stdout: 'pipe', stderr: 'pipe' };
    if (opts.cwd !== undefined) execOptions.cwd = opts.cwd;
    if (opts.env !== undefined) execOptions.env = { ...opts.env };
    if (opts.input != null) execOptions.stdin = stdinStream(opts.input);

    const started = this.#now();
    let proc: ExecProcess;
    try {
      proc = await this.#withBudget(
        container.exec([...argv], execOptions),
        budgetMs,
        `exec ${argv[0]}: the platform did not return a process`,
      );
    } catch (err) {
      throw classify(err, `exec ${argv[0]}`, this.#cfg.maxInstances);
    }

    const remaining = Math.max(1, budgetMs - (this.#now() - started));
    let out: ExecOutput;
    try {
      out = await this.#withBudget(
        proc.output(),
        remaining,
        `exec ${argv[0]}: no output within ${budgetMs} ms`,
      );
    } catch (err) {
      // A hung exec is the documented failure mode over capacity; kill the
      // process so the instance is not left with an orphan, then report.
      try {
        proc.kill();
      } catch {
        // Already gone.
      }
      throw classify(err, `exec ${argv[0]}`, this.#cfg.maxInstances);
    }

    return {
      exitCode: out.exitCode,
      stdout: await toText(out.stdout),
      stderr: await toText(out.stderr),
    };
  }

  /** `destroy()`, treating "already gone" as success. */
  async #destroyQuietly(container: Container, context: string): Promise<void> {
    const budget = this.#num(this.#cfg.destroyTimeoutMs, DEFAULT_DESTROY_TIMEOUT_MS);
    try {
      await this.#withBudget(container.destroy(), budget, `${context}: destroy did not resolve`);
    } catch (err) {
      const msg = messageOf(err);
      // Not running, no instance, or the platform took longer than the budget to
      // acknowledge. In every one of those the instance is not ours any more, and
      // the disk is gone by platform rule, so there is nothing left to clean up.
      if (NO_INSTANCE_RE.test(msg) || /not running/i.test(msg) || err instanceof CloudflareSubstrateError) {
        return;
      }
      throw classify(err, context, this.#cfg.maxInstances);
    }
  }

  /**
   * Observe the instance's exit (spec §4.7 needs to know a stop happened at all).
   *
   * `monitor()` is cancelled with the originating request's I/O context, so the
   * promise MUST be handed to `ctx.waitUntil` or the signal is simply lost — that
   * is the one place instrumentation of this platform silently loses data. With no
   * `waitUntil` configured the watch is not armed at all rather than pretending.
   */
  #armExitWatch(container: Container, computer: string, epoch: number | null): void {
    const waitUntil = this.#cfg.waitUntil;
    const onExit = this.#cfg.onContainerExit;
    if (!waitUntil || !onExit) return;
    const watched = container.monitor().then(
      () => onExit({ computer, epoch }),
      (err: unknown) => onExit({ computer, epoch, error: messageOf(err) }),
    );
    waitUntil(watched.catch(() => undefined));
  }

  #requireRunning(container: Container, handle: CloudflareHandle, context: string): void {
    if (!container.running) {
      throw new CloudflareSubstrateError(
        'not_running',
        `${context} on computer "${handle.computer}": the container instance is not running`,
      );
    }
  }

  async #withBudget<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new CloudflareSubstrateError('timeout', message)), ms);
    });
    try {
      // The losing promise is never awaited again; swallow its rejection so a
      // hung/failed platform call cannot surface as an unhandled rejection.
      promise.catch(() => undefined);
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  #sleep(ms: number): Promise<void> {
    const fn = this.#cfg.sleepFn;
    if (fn) return fn(ms);
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  #now(): number {
    const fn = this.#cfg.now;
    return fn ? fn() : Date.now();
  }

  #num(value: number | undefined, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
  }
}

function labelsFor(computer: string, epoch: number | null): Record<string, string> {
  const labels: Record<string, string> = { [COMPUTER_LABEL]: computer };
  if (epoch !== null) labels[EPOCH_LABEL] = String(epoch);
  return labels;
}

/** The wake epoch marid was handed, for labels and diagnostics. */
function epochOf(env: Readonly<Record<string, string>>): number | null {
  const raw = env.MARI_EPOCH;
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port ${port}`);
  }
}

/** Create the driver. Synchronous and dependency-free: the only thing it needs
 *  is the live `ctx.container` of the computer's own Durable Object. */
export function createCloudflareProvider(config: CloudflareConfig): CloudflareProvider {
  return new CloudflareProvider(config);
}
