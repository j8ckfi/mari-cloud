// Box substrate driver (box.ascii.dev — Ascii's cloud sandbox).
//
// Box is a hosted sandbox service: per-second billing while a machine runs,
// scale-to-zero via stop/archive (disk snapshotted, $0 compute), resume from
// the snapshot, and fast fork. This driver speaks its REST API with `fetch`
// ONLY, so it runs unchanged on Cloudflare Workers and on Node (spec §3.1 /
// §11.2, decisions.md "Substrate drivers are TypeScript").
//
// ── Endpoint mapping (spec §3.5 six functions → real Box API) ────────────────
// Base URL: https://ascii.dev/api/box/v1   Auth: `Authorization: Bearer <key>`
// Sources (verified 2026-07-27):
//   - API index:      https://docs.ascii.dev/box/api/v1
//   - Create box:     https://docs.ascii.dev/box/api/reference/boxes/create-box
//   - Get box:        https://docs.ascii.dev/box/api/reference/boxes/get-box
//   - Stop/archive:   https://docs.ascii.dev/box/api/reference/boxes/stop-and-archive-box
//   - Resume:         https://docs.ascii.dev/box/api/reference/boxes/resume-box
//   - Commands:       https://docs.ascii.dev/box/api/reference/agent/execute-box-command
//   - Hosting:        https://docs.ascii.dev/box/hosting
//   - Machines:       https://docs.ascii.dev/box/machines
//   - Long-running:   https://docs.ascii.dev/box/long-running-tasks
//
//   materialize  POST /boxes {ttlSeconds, env, noEnv:true}  → 202 provisioning;
//                poll GET /boxes/{id} to ready/idle (bounded); then bootstrap
//                marid via POST /boxes/{id}/commands (see "Bootstrap" below).
//   sleep        POST /boxes/{id}/stop → 202 archiving; poll to `archived`.
//                Archive IS the fleet-wide WARM (decisions.md "WARM is a fast
//                cold wake"): resources retained (disk snapshot), no process,
//                no compute billed, memory gone.
//   wake         POST /boxes/{id}/resume → 202 provisioning; poll to ready;
//                then RE-RUN the bootstrap. Box documents stop/resume as "like
//                a server reboot": hand-started processes do not survive, so
//                marid must be restarted (the binary is still on the restored
//                disk, so the download step self-skips).
//   destroy      UNSUPPORTED. Box has no delete endpoint; `stop` archives a
//                snapshot and the FAQ says it is retained for the life of the
//                box. Archive is valid WARM, but it cannot satisfy Mari's
//                destroy contract ("no substrate resources exist"). The driver
//                archives to stop compute, then rejects so the caller cannot
//                record a false COLD transition. Construction itself requires
//                an explicit test/lab opt-in, which keeps Box out of production
//                scheduling until the platform offers bounded deletion.
//   exec         POST /boxes/{id}/commands {command, timeoutSeconds}. The API
//                takes ONE SHELL STRING, not an argv, so argv is single-quoted
//                per element (§3.5's "NOT shell-interpreted" is preserved by
//                the quoting). Synchronous, server-capped at 60 s.
//   exposePort   Box's hosting API is the in-box `host` CLI driven through the
//                commands endpoint — there is no dedicated REST hosting
//                resource (the hosting doc's own API example is
//                `POST /boxes/{id}/commands {"command":"host 3000"}`).
//                `host <port>` registers https://<subdomain>-<port>.on.ascii.dev
//                and `host url <port>` prints the full URL including the
//                `_token` access token; the token-bearing URL is returned so
//                the exposure stays gated by default.
//
// ── Bootstrap (how marid gets onto a box) ────────────────────────────────────
// The Box base image is fixed (Hetzner CX33: 4 shared vCPU / 8 GB / 75 GB NVMe,
// x86_64) and does not run marid, so `MaterializeSpec.image` cannot be honored
// and materialize must inject the supervisor itself:
//
//   1. download a static (musl) marid binary from a configurable URL
//      (`MARID_BINARY_URL`, a deployment var — skipped when the binary is
//      already executable on disk, which is the resume-from-archive case);
//   2. write the whole `spec.env` (MARI_COMPUTER_ID / EPOCH / TOKEN /
//      CONTROL_URL / STORE, AWS_* creds) into a mode-0700 launcher under /run.
//      /run is runtime state, not part of the archived disk; values are
//      shell-quoted and NEVER logged or placed on the durable handle;
//   3. install a static systemd unit whose only persisted configuration is the
//      path to that runtime launcher, then `enable` and `restart` it. Systemd is
//      Box's documented long-running-task primitive. The bootstrap proves the
//      MainPID remains alive before it reports success.
//
// `spec.cmd` (tests) replaces step 3's program. The env/binary URL/cmd live only
// in the provider's in-memory bootstrap map. A handle therefore stays safe to
// persist in a Durable Object. If an activation loses that map, `wake` rejects
// BEFORE resuming the archived machine: the driver never wakes a box whose
// supervisor credentials it can no longer reconstruct.
//
// ── Documented gaps where the API has no exact §3.5 equivalent ───────────────
// * image/mounts/resources: one fixed machine size, no host filesystem, no
//   per-box sizing — recorded on the spec, deliberately not sent (there is
//   nowhere to send them; same posture as sprites.ts/cloudflare.ts).
// * ttlSeconds: null by default. Box's auto-archive TTL counts from CREATION,
//   not last activity, so any finite platform TTL would archive a computer
//   mid-run; Mari's own tier alarm (spec §4.4) is the idle policy. A deployment
//   that insists on a platform backstop can set `BoxConfig.ttlSeconds`, and
//   then `holdAwake` re-asserts it (PATCH /boxes/{id}) during runs.
// * noEnv: true always. A box normally inherits the Ascii account's secrets;
//   a Mari computer must receive exactly `spec.env` and nothing else.
// * stdin: the commands API has none, so `ExecOptions.input` is delivered as
//   `printf %s <base64> | base64 -d | <argv…>` — bytes survive verbatim.
// * cwd: the API's `cwd` field is RELATIVE to the box work directory, while
//   §3.5 callers pass absolute in-computer paths — so cwd is honored with a
//   `cd <dir> && …` prefix instead of the field.
//
// Every platform call is raced against a deadline (the cloudflare.ts rule: an
// async platform's worst failure mode is a hang, which is worse than an error),
// and long operations poll GET /boxes/{id} bounded, never open-ended.

import type {
  MaterializeSpec,
  SubstrateHandle,
  SubstrateProvider,
  ExecOptions,
  ExecResult,
  InstanceStatus,
} from './provider.js';

/** The registry name of this driver. */
export const BOX_SUBSTRATE = 'box';

/** Default Box API base URL. */
export const DEFAULT_BOX_BASE_URL = 'https://ascii.dev/api/box/v1';

/** Where the bootstrap installs the static marid binary inside the box. */
export const DEFAULT_MARID_BIN_PATH = '/usr/local/bin/marid';

/** Where the systemd-managed marid process appends its log inside the box. */
export const DEFAULT_MARID_LOG_PATH = '/var/log/marid.log';

/** Marker the bootstrap prints after systemd reports a stable live MainPID. */
const BOOTSTRAP_OK = 'mari-box-bootstrap-ok';

/** Static unit name. The unit contains no credentials; its launcher is in /run. */
const MARID_SERVICE = 'mari-supervisor.service';
const MARID_RUNTIME_DIR = '/run/mari-box';
const MARID_RUNTIME_LAUNCHER = `${MARID_RUNTIME_DIR}/marid-start`;

/** The server-side cap on one command's `timeoutSeconds` (API-documented). */
const MAX_COMMAND_TIMEOUT_S = 60;

// Defaults, all overridable via {@link BoxConfig}.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_CREATE_TIMEOUT_MS = 180_000;
const DEFAULT_RESUME_TIMEOUT_MS = 180_000;
const DEFAULT_ARCHIVE_TIMEOUT_MS = 180_000;
const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

/** Box lifecycle states (get-box reference, verbatim enum). */
type BoxState =
  | 'init'
  | 'provisioning'
  | 'provisioned'
  | 'cloning'
  | 'ready'
  | 'idle'
  | 'running'
  | 'archiving'
  | 'archived'
  | 'error';

/** States in which the machine runs and accepts commands. `running` means "a
 *  prompt is executing" and still accepts the commands endpoint. */
const RUNNING_STATES: ReadonlySet<string> = new Set(['ready', 'idle', 'running']);

/** States on the way to running; polling continues through these. */
const PENDING_STATES: ReadonlySet<string> = new Set([
  'init',
  'provisioning',
  'provisioned',
  'cloning',
]);

/** What went wrong, so a caller can branch without parsing English. */
export type BoxErrorKind =
  /** 401/402 — key invalid, or the account cannot operate boxes. */
  | 'auth'
  /** 404 — the box no longer exists on the platform. */
  | 'not_found'
  /** 409 — the request conflicts with the box's current state. */
  | 'conflict'
  /** 429 — rate/daily limit; retry later. */
  | 'capacity'
  /** A call or poll did not finish inside its budget (it may still finish). */
  | 'timeout'
  /** The machine is not running, and this operation must not start it. */
  | 'not_running'
  /** Any other platform refusal (including 5xx). */
  | 'api'
  /** The platform answered something this driver cannot interpret. */
  | 'protocol';

/** A typed substrate failure carrying the platform's own error envelope
 *  (`{ok:false, code, message, requestId}` — the envelope every v1 error
 *  uses), so operator logs can quote `requestId` back to the platform. */
export class BoxSubstrateError extends Error {
  override readonly name = 'BoxSubstrateError';
  readonly kind: BoxErrorKind;
  /** HTTP status, when the failure was an HTTP response. */
  readonly status?: number;
  /** Platform error code (`machine_not_running`, `rate_limited`, …). */
  readonly code?: string;
  /** Platform request id, for support escalation. */
  readonly requestId?: string;
  /** True when a later attempt could plausibly succeed. */
  readonly retryable: boolean;
  override readonly cause?: unknown;

  constructor(
    kind: BoxErrorKind,
    message: string,
    detail: { status?: number; code?: string; requestId?: string; cause?: unknown } = {},
  ) {
    super(message);
    this.kind = kind;
    if (detail.status !== undefined) this.status = detail.status;
    if (detail.code !== undefined) this.code = detail.code;
    if (detail.requestId !== undefined) this.requestId = detail.requestId;
    if (detail.cause !== undefined) this.cause = detail.cause;
    this.retryable =
      kind === 'capacity' || kind === 'timeout' || (kind === 'api' && (detail.status ?? 0) >= 500);
  }
}

/**
 * Persistable Box handle. Deliberately contains no bootstrap environment,
 * credentials, binary URL, or command. Those stay in provider memory only.
 */
export interface BoxHandle extends SubstrateHandle {
  readonly substrate: typeof BOX_SUBSTRATE;
  /** The box id (`bx_…`) — the `{boxId}` path segment. */
  readonly id: string;
  /** Ports the caller asked for. Recorded only: Box's hosting API registers a
   *  port at expose time (`host <port>`), no create-time publish exists. */
  readonly ports: readonly number[];
  /** The box's three-word hosting subdomain, when known. Diagnostics only —
   *  exposePort re-reads the authoritative URL from `host url`. */
  readonly subdomain: string | null;
}

/** Driver configuration. */
export interface BoxConfig {
  /** API key (`Authorization: Bearer <key>`, `box_…` format). */
  readonly apiKey: string;
  /** API base URL. Defaults to {@link DEFAULT_BOX_BASE_URL}. */
  readonly baseUrl?: string;
  /**
   * URL of the static (musl) marid binary the bootstrap downloads
   * (deployment var `MARID_BINARY_URL`). Required unless every materialize
   * carries a `cmd` override (tests).
   */
  readonly maridBinaryUrl?: string;
  /**
   * Explicit test/lab opt-in for a provider whose platform cannot delete boxes.
   *
   * Box archives snapshots indefinitely and currently exposes no DELETE
   * endpoint, so it cannot satisfy SubstrateProvider.destroy. The constructor
   * rejects unless this is exactly true. This flag must never be enabled in a
   * production substrate candidate list; it exists only for bounded driver
   * tests while the platform contract is incomplete.
   */
  readonly allowRetainedBoxesForTesting?: boolean;
  /**
   * Platform auto-archive TTL. Defaults to `null` (disabled) because Box's TTL
   * counts from CREATION and would archive an active computer; Mari's tier
   * alarm owns idle (spec §4.4). When set, {@link BoxProvider.holdAwake}
   * re-asserts it during runs.
   */
  readonly ttlSeconds?: number | null;
  /** In-box path for the marid binary. Default {@link DEFAULT_MARID_BIN_PATH}. */
  readonly maridBinPath?: string;
  /** In-box path for the marid log. Default {@link DEFAULT_MARID_LOG_PATH}. */
  readonly maridLogPath?: string;
  /** Budget for one HTTP round-trip. Default 30 s. */
  readonly requestTimeoutMs?: number;
  /** Budget for create → machine ready (the bootstrap that follows is bounded
   *  separately by {@link execTimeoutMs}). Default 180 s. */
  readonly createTimeoutMs?: number;
  /** Budget for resume → machine ready (bootstrap bounded separately). Default 180 s. */
  readonly resumeTimeoutMs?: number;
  /** Budget for stop → `archived`. Default 180 s. */
  readonly archiveTimeoutMs?: number;
  /** Budget for one exec. Server caps the command at 60 s regardless. */
  readonly execTimeoutMs?: number;
  /** Poll interval while waiting on an async transition. Default 1 s. */
  readonly pollIntervalMs?: number;
  /** Injected for tests. Defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
  /** Injectable sleep, for deterministic tests. */
  readonly sleepFn?: (ms: number) => Promise<void>;
  /** Injectable clock, for deterministic tests. */
  readonly now?: () => number;
}

/** GET /boxes/{id} `box` object — the fields this driver reads. */
interface BoxResource {
  readonly id: string;
  readonly name?: string;
  readonly state: BoxState | string;
  readonly url?: string | null;
  readonly subdomain?: string | null;
}

interface BoxEnvelope {
  readonly ok: boolean;
  readonly type?: string;
  readonly status?: number;
  readonly code?: string;
  readonly message?: string;
  readonly requestId?: string;
  readonly error?: { readonly code?: string; readonly message?: string };
}

interface BoxInfoResponse extends BoxEnvelope {
  readonly box?: BoxResource | null;
}

/** POST /boxes/{id}/commands response (`type: "command.finished"`). */
interface CommandFinishedResponse extends BoxEnvelope {
  readonly success?: boolean;
  readonly exitCode?: number | null;
  readonly signal?: string | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  readonly timedOut?: boolean;
}

/** Secret bootstrap state which must never cross the provider-memory boundary. */
interface BootstrapConfig {
  readonly env: Readonly<Record<string, string>>;
  readonly cmd: readonly string[] | null;
  readonly maridBinaryUrl: string | null;
}

function isBoxHandle(handle: SubstrateHandle): asserts handle is BoxHandle {
  if (handle.substrate !== BOX_SUBSTRATE) {
    throw new Error(`BoxProvider received a "${handle.substrate}" handle`);
  }
}

/** `SubstrateProvider` for the Box API over `fetch` (Workers + Node). */
export class BoxProvider implements SubstrateProvider {
  readonly name = BOX_SUBSTRATE;

  /**
   * Archive IS WARM (decisions.md "WARM is a fast cold wake"): the platform
   * snapshots the disk, bills nothing, and resume restores the same disk.
   * Memory does not survive — which is exactly the fleet-wide definition.
   */
  readonly supportsWarm = true;

  readonly #cfg: BoxConfig;
  /** Bootstrap credentials live only as long as this provider activation. */
  readonly #bootstraps = new Map<string, BootstrapConfig>();

  constructor(config: BoxConfig) {
    if (!config.apiKey) throw new Error('BoxProvider requires an API key');
    if (config.allowRetainedBoxesForTesting !== true) {
      throw new BoxSubstrateError(
        'protocol',
        'BoxProvider is not production-ready: Box has no delete endpoint and retains ' +
          'archived snapshots for the life of the box, so destroy cannot guarantee that ' +
          'no substrate resources remain. Set allowRetainedBoxesForTesting only in a ' +
          'bounded test/lab environment.',
      );
    }
    this.#cfg = config;
  }

  /**
   * An archived (WARM) box runs NO processes and its commands endpoint refuses
   * with `machine_not_running`, so the supervisor inside cannot answer
   * `prepare_for_cold`. The DO must resume the box before asking (computer-do's
   * FreezingSubstrate contract — same reason as Docker `pause`).
   */
  resumeBeforeCold(handle: SubstrateHandle): boolean {
    isBoxHandle(handle);
    return true;
  }

  // ── spec §3.5: materialize ─────────────────────────────────────────────────

  async materialize(spec: MaterializeSpec): Promise<BoxHandle> {
    const cmd = spec.cmd && spec.cmd.length > 0 ? [...spec.cmd] : null;
    const binaryUrl = cmd ? null : (this.#cfg.maridBinaryUrl ?? spec.env.MARID_BINARY_URL ?? null);
    if (!cmd && !binaryUrl) {
      throw new BoxSubstrateError(
        'protocol',
        'materialize on the box substrate needs MARID_BINARY_URL (a deployment var): ' +
          'the Box base image does not carry marid, so the bootstrap must download a ' +
          'static build. Only a test cmd override may omit it.',
      );
    }

    const deadline = this.#now() + this.#num(this.#cfg.createTimeoutMs, DEFAULT_CREATE_TIMEOUT_MS);
    const created = await this.#request<BoxInfoResponse>(
      'POST',
      '/boxes',
      {
        // Disabled by default; Mari's tier alarm is the idle policy (header).
        ttlSeconds: this.#cfg.ttlSeconds ?? null,
        // Never inherit the Ascii account's secrets into a Mari computer.
        // Per-box env is intentionally omitted: Box persists it across resume
        // and fork, while supervisor credentials belong only to this activation.
        noEnv: true,
      },
      `create box for computer "${spec.computer}"`,
    );
    const box = created.box;
    if (!box?.id) {
      throw new BoxSubstrateError('protocol', 'create box: response had no box.id');
    }

    const bootstrap: BootstrapConfig = {
      env: { ...spec.env },
      cmd,
      maridBinaryUrl: binaryUrl,
    };
    this.#bootstraps.set(box.id, bootstrap);
    const handle: BoxHandle = {
      substrate: BOX_SUBSTRATE,
      computer: spec.computer,
      id: box.id,
      ports: [...(spec.ports ?? [])],
      subdomain: box.subdomain ?? null,
    };

    try {
      const ready = await this.#pollUntilRunning(box.id, deadline, `computer "${spec.computer}"`);
      await this.#bootstrap(handle, bootstrap, deadline);
      return {
        ...handle,
        subdomain: ready.subdomain ?? handle.subdomain,
      };
    } catch (err) {
      // A box whose supervisor never started must not be left billing; archive
      // it (the platform's terminal state) before reporting the failure.
      this.#bootstraps.delete(handle.id);
      await this.#stopQuietly(handle.id);
      throw err;
    }
  }

  // ── spec §3.5: destroy ─────────────────────────────────────────────────────

  /**
   * Fail closed: stop compute, verify the box is archived, then reject because
   * Box retains the snapshot indefinitely. A caller must not record COLD from
   * an archive. Only a platform-side 404 is real, idempotent destruction.
   */
  async destroy(handle: SubstrateHandle): Promise<void> {
    isBoxHandle(handle);
    try {
      await this.#stopBox(handle.id, `destroy computer "${handle.computer}"`);
      const deadline =
        this.#now() + this.#num(this.#cfg.archiveTimeoutMs, DEFAULT_ARCHIVE_TIMEOUT_MS);
      await this.#pollUntilState(
        handle.id,
        (s) => s === 'archived',
        (s) => PENDING_STATES.has(s) || RUNNING_STATES.has(s) || s === 'archiving',
        deadline,
        `destroy computer "${handle.computer}": box did not reach archived`,
      );
    } catch (err) {
      // A 404 is the only state which actually satisfies destroy. #stopBox
      // treats it as idempotent success, so the following poll is what observes
      // and resolves the already-gone case.
      if (err instanceof BoxSubstrateError && err.kind === 'not_found') {
        this.#bootstraps.delete(handle.id);
        return;
      }
      throw err;
    }
    this.#bootstraps.delete(handle.id);
    throw retainedBoxError(handle.id);
  }

  // ── spec §3.5: sleep ───────────────────────────────────────────────────────

  /**
   * AWAKE → WARM: stop and archive. The caller has already had the supervisor
   * stop cleanly and write a manifest (spec §4.5). Unlike destroy this POLLS to
   * `archived`, because sleep's contract is "the computer IS WARM when this
   * resolves" — a resume issued mid-`archiving` would 409.
   */
  async sleep(handle: SubstrateHandle): Promise<void> {
    isBoxHandle(handle);
    const deadline =
      this.#now() + this.#num(this.#cfg.archiveTimeoutMs, DEFAULT_ARCHIVE_TIMEOUT_MS);
    await this.#stopBox(handle.id, `sleep computer "${handle.computer}"`);
    await this.#pollUntilState(
      handle.id,
      (s) => s === 'archived',
      (s) => PENDING_STATES.has(s) || RUNNING_STATES.has(s) || s === 'archiving',
      deadline,
      `sleep computer "${handle.computer}": box did not reach archived`,
    );
  }

  // ── spec §3.5: wake ────────────────────────────────────────────────────────

  /**
   * WARM → AWAKE: resume the archived box, then re-run the bootstrap. Resume
   * restores the archived disk (the WARM cache — no chunk-store transfer), but
   * "stop/resume behaves like a server reboot" (platform doc), so marid is
   * restarted from the handle's recorded env; the binary is already on the
   * restored disk and the download self-skips.
   */
  async wake(handle: SubstrateHandle): Promise<void> {
    isBoxHandle(handle);
    const bootstrap = this.#bootstraps.get(handle.id);
    if (!bootstrap) {
      throw new BoxSubstrateError(
        'protocol',
        `cannot wake computer "${handle.computer}": its secret Box bootstrap state was ` +
          'intentionally not persisted and this provider activation no longer has it; ' +
          'the archived box was left stopped',
      );
    }
    const deadline = this.#now() + this.#num(this.#cfg.resumeTimeoutMs, DEFAULT_RESUME_TIMEOUT_MS);
    try {
      await this.#request<BoxEnvelope>(
        'POST',
        `/boxes/${encodeURIComponent(handle.id)}/resume`,
        undefined,
        `resume computer "${handle.computer}"`,
      );
    } catch (err) {
      // 409: not archived — either already running (a benign double wake) or
      // still archiving. Both are settled by the poll below; anything else is
      // a real refusal.
      if (!(err instanceof BoxSubstrateError) || err.kind !== 'conflict') throw err;
    }
    await this.#pollUntilRunning(handle.id, deadline, `computer "${handle.computer}"`);
    await this.#bootstrap(handle, bootstrap, deadline);
  }

  // ── spec §3.5: exec ────────────────────────────────────────────────────────

  /**
   * Run `argv` and capture output and exit status. The commands API takes one
   * SHELL STRING; each argv element is single-quoted so the array semantics of
   * §3.5 (`argv` is NOT shell-interpreted) survive the transport. cwd/env/stdin
   * are compiled into the string (see the header's gap notes).
   *
   * On a stopped/archived box the platform refuses with `machine_not_running`;
   * that is surfaced as a typed `not_running` error rather than a start,
   * because §4.1 says only an AWAKE computer's disk accepts writes — the
   * caller must wake first.
   */
  async exec(
    handle: SubstrateHandle,
    argv: readonly string[],
    opts: ExecOptions = {},
  ): Promise<ExecResult> {
    isBoxHandle(handle);
    if (argv.length === 0) throw new Error('exec requires a non-empty argv');
    return this.#command(handle.id, buildShellCommand(argv, opts), `exec ${argv[0]}`);
  }

  // ── spec §3.5: exposePort ──────────────────────────────────────────────────

  /**
   * Register `port` with Box hosting and return the public HTTPS URL.
   *
   * Two in-box commands (the hosting doc's own API surface — see header):
   * `host <port>` registers the subdomain route (idempotent; the access token
   * persists across re-hosting), then `host url <port>` prints the full URL
   * INCLUDING the `_token` query parameter. The token-bearing URL is returned:
   * the default-private exposure stays gated, and the caller (the wake proxy,
   * spec §8.5) owns any wider publication. The in-box service must listen on
   * 0.0.0.0 — the platform routes from outside the process loopback.
   */
  async exposePort(handle: SubstrateHandle, port: number): Promise<string> {
    isBoxHandle(handle);
    assertPort(port);
    const register = await this.exec(handle, ['host', String(port)]);
    if (register.exitCode !== 0) {
      throw new BoxSubstrateError(
        'api',
        `exposePort(${port}): \`host ${port}\` exited ${register.exitCode}` +
          `${register.stderr ? ` — ${register.stderr.trim()}` : ''}`,
      );
    }
    const urlOut = await this.exec(handle, ['host', 'url', String(port)]);
    const url = /https:\/\/\S+/.exec(urlOut.stdout)?.[0];
    if (urlOut.exitCode !== 0 || !url) {
      throw new BoxSubstrateError(
        'protocol',
        `exposePort(${port}): \`host url ${port}\` printed no URL` +
          `${urlOut.stderr ? ` — ${urlOut.stderr.trim()}` : ''}`,
      );
    }
    return url;
  }

  // ── Optional capability: instanceStatus (liveness) ─────────────────────────

  /**
   * Does the platform still hold resources for this handle?
   *
   * The nuance this method exists for: an ARCHIVED box is `alive`, not `gone`.
   * Its disk snapshot is retained and a resume brings the same disk back — that
   * is Mari's WARM, and reporting it `gone` would make the DO recover a
   * computer that needs no recovery. Verdicts:
   *
   *   * GET 200, any lifecycle state incl. `archiving`/`archived` → `alive`
   *   * GET 200, state `error` → `unknown`. The platform kept the record but
   *     does not vouch for the machine or its disk; `unknown` makes the caller
   *     bound it rather than either trusting a broken box or destroying a
   *     recoverable one.
   *   * GET 404 → `gone` (the box was deleted platform-side; only the chunk
   *     store holds the computer now).
   *   * unreachable / any other refusal → `unknown`, never `gone`.
   *
   * Never throws, never changes the box (provider.ts's contract).
   */
  async instanceStatus(handle: SubstrateHandle): Promise<InstanceStatus> {
    if (handle.substrate !== BOX_SUBSTRATE) return 'unknown';
    let res: BoxInfoResponse;
    try {
      res = await this.#request<BoxInfoResponse>(
        'GET',
        `/boxes/${encodeURIComponent(handle.id)}`,
        undefined,
        `status of computer "${handle.computer}"`,
      );
    } catch (err) {
      if (err instanceof BoxSubstrateError && err.kind === 'not_found') return 'gone';
      return 'unknown';
    }
    const state = res.box?.state;
    if (state === undefined) return 'unknown';
    if (state === 'error') return 'unknown';
    if (
      RUNNING_STATES.has(state) ||
      PENDING_STATES.has(state) ||
      state === 'archiving' ||
      state === 'archived'
    ) {
      return 'alive';
    }
    return 'unknown';
  }

  // ── Optional capability: holdAwake (spec §5.4 run hold) ────────────────────

  /**
   * With the default `ttlSeconds: null` there is no platform timer to renew and
   * this is a no-op. When a deployment configures a finite TTL, re-assert it
   * (PATCH /boxes/{id} sets a fresh `archiveAfter`) so the creation-anchored
   * auto-archive cannot fire mid-run. Best effort by contract: failures are
   * swallowed — the DO's own alarm is the authoritative hold.
   */
  async holdAwake(handle: SubstrateHandle): Promise<void> {
    isBoxHandle(handle);
    const ttl = this.#cfg.ttlSeconds;
    if (ttl == null) return;
    try {
      await this.#request<BoxEnvelope>(
        'PATCH',
        `/boxes/${encodeURIComponent(handle.id)}`,
        { ttlSeconds: ttl },
        `holdAwake computer "${handle.computer}"`,
      );
    } catch {
      // Best effort; must never fail a run (provider.ts).
    }
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /**
   * Install/restart marid as Box's documented systemd long-running service.
   *
   * The persisted unit contains no secrets. Its launcher lives under /run and
   * is reconstructed from provider memory on each explicit wake. A stable
   * MainPID check proves the process survived the command request; merely
   * reaching a shell `&` line is not readiness.
   */
  async #bootstrap(
    handle: BoxHandle,
    bootstrap: BootstrapConfig,
    readinessDeadline: number,
  ): Promise<void> {
    const bin = this.#cfg.maridBinPath ?? DEFAULT_MARID_BIN_PATH;
    const log = this.#cfg.maridLogPath ?? DEFAULT_MARID_LOG_PATH;
    const lines: string[] = ['set -eu'];
    if (bootstrap.maridBinaryUrl) {
      lines.push(
        `sudo -n install -d -m 0755 ${shq(parentDir(bin))} ${shq(parentDir(log))}`,
        // Idempotent: a resumed box's restored disk still holds the binary.
        // curl first (present in the box image), wget as the fallback.
        `if [ ! -x ${shq(bin)} ]; then ` +
          `tmp=$(mktemp); ` +
          `(curl -fsSL ${shq(bootstrap.maridBinaryUrl)} -o "$tmp" || ` +
          `wget -qO "$tmp" ${shq(bootstrap.maridBinaryUrl)}); ` +
          `sudo -n install -m 0755 "$tmp" ${shq(bin)}; rm -f "$tmp"; fi`,
      );
    } else {
      lines.push(`sudo -n install -d -m 0755 ${shq(parentDir(log))}`);
    }

    const launcher: string[] = ['#!/bin/sh', 'set -eu'];
    for (const [key, value] of Object.entries(bootstrap.env)) {
      assertEnvName(key);
      launcher.push(`export ${key}=${shq(value)}`);
    }
    const program = bootstrap.cmd ? bootstrap.cmd.map(shq).join(' ') : shq(bin);
    launcher.push(`exec ${program}`, '');

    const unit = [
      '[Unit]',
      'Description=Mari supervisor',
      'After=network-online.target',
      'Wants=network-online.target',
      `ConditionPathIsExecutable=${MARID_RUNTIME_LAUNCHER}`,
      '',
      '[Service]',
      'Type=simple',
      'User=user',
      `ExecStart=${MARID_RUNTIME_LAUNCHER}`,
      'Restart=always',
      'RestartSec=1',
      `StandardOutput=append:${log}`,
      'StandardError=inherit',
      '',
      '[Install]',
      'WantedBy=multi-user.target',
      '',
    ].join('\n');
    const unitPath = `/etc/systemd/system/${MARID_SERVICE}`;
    lines.push(
      `sudo -n install -d -o user -g user -m 0700 ${shq(MARID_RUNTIME_DIR)}`,
      `printf %s ${shq(toBase64(launcher.join('\n')))} | base64 -d | ` +
        `sudo -n tee ${shq(MARID_RUNTIME_LAUNCHER)} >/dev/null`,
      `sudo -n chown user:user ${shq(MARID_RUNTIME_LAUNCHER)}`,
      `sudo -n chmod 0700 ${shq(MARID_RUNTIME_LAUNCHER)}`,
      `printf %s ${shq(toBase64(unit))} | base64 -d | ` +
        `sudo -n tee ${shq(unitPath)} >/dev/null`,
      'sudo -n systemctl daemon-reload',
      `sudo -n systemctl enable ${shq(MARID_SERVICE)} >/dev/null`,
      `sudo -n systemctl restart ${shq(MARID_SERVICE)}`,
      // `is-active` immediately after restart can catch a crash/restart loop in
      // its transient active phase. Require the same live MainPID one second
      // later, which is also proof that the process outlived this shell request.
      `mari_pid_before=$(sudo -n systemctl show -p MainPID --value ${shq(MARID_SERVICE)})`,
      'case "$mari_pid_before" in ""|0|*[!0-9]*) exit 1;; esac',
      'sleep 1',
      `mari_pid_after=$(sudo -n systemctl show -p MainPID --value ${shq(MARID_SERVICE)})`,
      '[ "$mari_pid_before" = "$mari_pid_after" ]',
      'sudo -n kill -0 "$mari_pid_after"',
      `sudo -n systemctl is-active --quiet ${shq(MARID_SERVICE)}`,
      `echo ${BOOTSTRAP_OK}`,
    );
    const result = await this.#commandWhenReady(
      handle.id,
      lines.join('\n'),
      `bootstrap marid on computer "${handle.computer}"`,
      readinessDeadline,
    );
    if (result.exitCode !== 0 || !result.stdout.includes(BOOTSTRAP_OK)) {
      throw new BoxSubstrateError(
        'api',
        `bootstrap on computer "${handle.computer}" failed (exit ${result.exitCode})` +
          `${result.stderr ? ` — ${result.stderr.trim()}` : ''}`,
      );
    }
  }

  /**
   * The GET lifecycle state can become `ready` before the command transport is
   * ready. Box then returns 502 `box_direct_failed` with `box_restoring` in the
   * envelope. Retry only that documented/transient readiness shape, bounded by
   * the same create/resume deadline; do not hide arbitrary command failures.
   */
  async #commandWhenReady(
    boxId: string,
    command: string,
    context: string,
    deadline: number,
  ): Promise<ExecResult> {
    const interval = this.#num(this.#cfg.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    let last: BoxSubstrateError | null = null;
    for (;;) {
      try {
        return await this.#command(boxId, command, context);
      } catch (err) {
        if (!isRestoreReadinessError(err)) throw err;
        last = err;
      }
      const remaining = deadline - this.#now();
      if (remaining <= 0) {
        throw new BoxSubstrateError(
          'timeout',
          `${context}: Box command transport did not become ready before the lifecycle deadline`,
          { cause: last },
        );
      }
      await this.#sleep(Math.min(interval, remaining));
    }
  }

  /** One command round-trip: POST /boxes/{id}/commands, decode the
   *  `command.finished` envelope into an {@link ExecResult}. */
  async #command(boxId: string, command: string, context: string): Promise<ExecResult> {
    const budgetMs = this.#num(this.#cfg.execTimeoutMs, DEFAULT_EXEC_TIMEOUT_MS);
    const timeoutSeconds = Math.min(MAX_COMMAND_TIMEOUT_S, Math.max(1, Math.ceil(budgetMs / 1000)));
    const res = await this.#request<CommandFinishedResponse>(
      'POST',
      `/boxes/${encodeURIComponent(boxId)}/commands`,
      { command, timeoutSeconds },
      context,
      // The server runs the command synchronously for up to `timeoutSeconds`;
      // the HTTP budget must cover that plus transport.
      budgetMs + this.#num(this.#cfg.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS),
    );
    if (res.timedOut) {
      throw new BoxSubstrateError(
        'timeout',
        `${context}: command exceeded the server-side ${timeoutSeconds} s cap`,
      );
    }
    let exitCode = res.exitCode;
    if (exitCode == null) {
      const sig = res.signal ? signalNumber(res.signal) : null;
      if (sig === null) {
        throw new BoxSubstrateError(
          'protocol',
          `${context}: command.finished had neither exitCode nor a known signal ` +
            `(signal=${res.signal ?? 'null'})`,
        );
      }
      // provider.ts: a terminating signal is normalized to 128 + signal.
      exitCode = 128 + sig;
    }
    // NOTE: the API truncates very large output (`stdoutTruncated`); ExecResult
    // has no channel for that, so truncation passes through silently. Bulk data
    // belongs on the chunk-store path, not exec.
    return { exitCode, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  }

  /** POST /boxes/{id}/stop, treating "already gone/archived" as success. */
  async #stopBox(boxId: string, context: string): Promise<void> {
    try {
      await this.#request<BoxEnvelope>(
        'POST',
        `/boxes/${encodeURIComponent(boxId)}/stop`,
        undefined,
        context,
      );
    } catch (err) {
      if (err instanceof BoxSubstrateError) {
        // Already deleted platform-side: nothing left to stop.
        if (err.kind === 'not_found') return;
        if (err.kind === 'conflict') {
          // 409 does not say WHICH conflict; only "already archiving/archived"
          // is success. Read the state and decide.
          const state = await this.#peekState(boxId);
          if (state === 'archiving' || state === 'archived' || state === null) return;
        }
      }
      throw err;
    }
  }

  /** Best-effort stop for failure cleanup; never throws. */
  async #stopQuietly(boxId: string): Promise<void> {
    try {
      await this.#stopBox(boxId, 'cleanup after failed bootstrap');
    } catch {
      // The materialize error is the one worth reporting.
    }
  }

  /** GET the state, or `null` when the box is gone/unreadable. */
  async #peekState(boxId: string): Promise<string | null> {
    try {
      const res = await this.#request<BoxInfoResponse>(
        'GET',
        `/boxes/${encodeURIComponent(boxId)}`,
        undefined,
        'read box state',
      );
      return res.box?.state ?? null;
    } catch {
      return null;
    }
  }

  /** Poll GET /boxes/{id} until the machine accepts commands. */
  async #pollUntilRunning(boxId: string, deadline: number, what: string): Promise<BoxResource> {
    return this.#pollUntilState(
      boxId,
      (s) => RUNNING_STATES.has(s),
      (s) => PENDING_STATES.has(s),
      deadline,
      `${what}: box ${boxId} did not become ready`,
    );
  }

  /**
   * Bounded poll of GET /boxes/{id}. `done` ends it, `pending` continues it,
   * anything else (notably `error`) fails it immediately — a box in `error`
   * will not progress, and waiting out the deadline on it helps nobody.
   */
  async #pollUntilState(
    boxId: string,
    done: (state: string) => boolean,
    pending: (state: string) => boolean,
    deadline: number,
    timeoutMessage: string,
  ): Promise<BoxResource> {
    const interval = this.#num(this.#cfg.pollIntervalMs, DEFAULT_POLL_INTERVAL_MS);
    for (;;) {
      const res = await this.#request<BoxInfoResponse>(
        'GET',
        `/boxes/${encodeURIComponent(boxId)}`,
        undefined,
        'poll box state',
      );
      const box = res.box;
      if (!box) throw new BoxSubstrateError('protocol', 'poll box state: response had no box');
      const state = box.state;
      if (done(state)) return box;
      if (!pending(state)) {
        throw new BoxSubstrateError(
          'api',
          `box ${boxId} entered state "${state}" while waiting; it will not progress`,
        );
      }
      if (this.#now() >= deadline) {
        throw new BoxSubstrateError('timeout', `${timeoutMessage} (last state: "${state}")`);
      }
      await this.#sleep(interval);
    }
  }

  /**
   * One HTTP round-trip against the API, with auth, JSON body, a hard deadline
   * (AbortController — a hang is worse than an error), and the `{ok, type}`
   * envelope decoded. A non-2xx or `ok:false` becomes a typed
   * {@link BoxSubstrateError} carrying the platform's code/message/requestId.
   */
  async #request<T extends BoxEnvelope>(
    method: string,
    path: string,
    body: unknown,
    context: string,
    budgetMs?: number,
  ): Promise<T> {
    const budget = budgetMs ?? this.#num(this.#cfg.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    const base = (this.#cfg.baseUrl ?? DEFAULT_BOX_BASE_URL).replace(/\/+$/, '');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    let res: Response;
    try {
      const init: RequestInit = {
        method,
        headers: {
          Authorization: `Bearer ${this.#cfg.apiKey}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        signal: controller.signal,
      };
      if (body !== undefined) init.body = JSON.stringify(body);
      res = await (this.#cfg.fetch ?? fetch)(`${base}${path}`, init);
    } catch (err) {
      if (controller.signal.aborted) {
        throw new BoxSubstrateError('timeout', `${context}: no answer within ${budget} ms`, {
          cause: err,
        });
      }
      throw new BoxSubstrateError('api', `${context}: ${messageOf(err)}`, { cause: err });
    } finally {
      clearTimeout(timer);
    }

    let payload: BoxEnvelope | null = null;
    try {
      payload = (await res.json()) as BoxEnvelope;
    } catch {
      payload = null;
    }
    if (!res.ok || payload?.ok === false) {
      throw envelopeError(context, res.status, payload);
    }
    if (payload === null) {
      throw new BoxSubstrateError('protocol', `${context}: response was not JSON`, {
        status: res.status,
      });
    }
    return payload as T;
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

/**
 * Create a `BoxProvider` from environment. Reads `BOX_API_KEY`, optional
 * `BOX_BASE_URL`, and `MARID_BINARY_URL` (the deployment var the bootstrap
 * downloads marid from) from the passed env record (default: `process.env`
 * when present, else `{}` — Workers pass their own env in).
 *
 * This intentionally does not read a production env switch for
 * `allowRetainedBoxesForTesting`: the unsafe-retention acknowledgement can only
 * be supplied explicitly in `overrides` by a bounded test/lab caller.
 */
export function createBoxProvider(
  env: Record<string, string | undefined> = typeof process !== 'undefined' ? process.env : {},
  overrides: Partial<BoxConfig> = {},
): BoxProvider {
  const apiKey = overrides.apiKey ?? env.BOX_API_KEY;
  if (!apiKey) {
    throw new Error('createBoxProvider: BOX_API_KEY is not set');
  }
  const config: BoxConfig = {
    ...overrides,
    apiKey,
    baseUrl: overrides.baseUrl ?? env.BOX_BASE_URL,
    maridBinaryUrl: overrides.maridBinaryUrl ?? env.MARID_BINARY_URL,
  };
  return new BoxProvider(config);
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** POSIX single-quote: `'` closes, `\'` escapes, `'` reopens. Safe for any
 *  byte except NUL; keeps §3.5's "argv is not shell-interpreted" true across
 *  a shell-string transport. */
function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Env names are interpolated OUTSIDE the quoting (`export NAME='…'`), so they
 *  must be validated, not escaped. */
function assertEnvName(name: string): void {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(`invalid environment variable name ${JSON.stringify(name)}`);
  }
}

/** Compile argv + ExecOptions into the one shell string the commands API takes
 *  (see the header's gap notes for why cwd/env/stdin are compiled in). */
function buildShellCommand(argv: readonly string[], opts: ExecOptions): string {
  const parts: string[] = [];
  if (opts.env && Object.keys(opts.env).length > 0) {
    parts.push('env');
    for (const [key, value] of Object.entries(opts.env)) {
      assertEnvName(key);
      parts.push(shq(`${key}=${value}`));
    }
  }
  parts.push(...argv.map(shq));
  let command = parts.join(' ');
  if (opts.input != null) {
    command = `printf %s ${shq(toBase64(opts.input))} | base64 -d | ${command}`;
  }
  if (opts.cwd) {
    command = `cd ${shq(opts.cwd)} && ${command}`;
  }
  return command;
}

/** Base64 without Buffer or btoa: runs identically on Workers and Node, and
 *  handles binary input a latin1 `btoa` round-trip would corrupt. */
function toBase64(input: Uint8Array | string): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = i + 1 < bytes.length ? bytes[i + 1]! : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2]! : 0;
    const triple = (b0 << 16) | (b1 << 8) | b2;
    out += alphabet[(triple >> 18) & 63]! + alphabet[(triple >> 12) & 63]!;
    out += i + 1 < bytes.length ? alphabet[(triple >> 6) & 63]! : '=';
    out += i + 2 < bytes.length ? alphabet[triple & 63]! : '=';
  }
  return out;
}

/** POSIX signal name → number, for provider.ts's `128 + signal` rule. */
function signalNumber(signal: string): number | null {
  const table: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
  };
  return table[signal.toUpperCase()] ?? null;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`invalid port ${port}`);
  }
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRestoreReadinessError(err: unknown): err is BoxSubstrateError {
  if (!(err instanceof BoxSubstrateError)) return false;
  if (err.code === 'box_restoring' || err.code === 'box_securing') return true;
  return (
    err.code === 'box_direct_failed' &&
    /\bbox_(?:restoring|securing)\b/i.test(err.message)
  );
}

function retainedBoxError(boxId: string): BoxSubstrateError {
  return new BoxSubstrateError(
    'protocol',
    `Box ${boxId} was archived to stop compute, but not destroyed: the Box API has ` +
      'no delete endpoint and retains the latest snapshot for the life of the box. ' +
      'Mari must keep this computer WARM and must not record it COLD.',
  );
}

/** Map an HTTP status + error envelope onto a typed error. */
function envelopeError(
  context: string,
  status: number,
  payload: BoxEnvelope | null,
): BoxSubstrateError {
  const code = payload?.code ?? payload?.error?.code;
  const message = payload?.message ?? payload?.error?.message;
  const requestId = payload?.requestId;
  const kind: BoxErrorKind =
    code === 'machine_not_running'
      ? 'not_running'
      : status === 401 || status === 402
        ? 'auth'
        : status === 404
          ? 'not_found'
          : status === 409
            ? 'conflict'
            : status === 429
              ? 'capacity'
              : 'api';
  const detail: { status: number; code?: string; requestId?: string } = { status };
  if (code !== undefined) detail.code = code;
  if (requestId !== undefined) detail.requestId = requestId;
  return new BoxSubstrateError(
    kind,
    `Box ${context} failed: ${status}${code ? ` ${code}` : ''}` +
      `${message ? ` — ${message}` : ''}${requestId ? ` (requestId ${requestId})` : ''}`,
    detail,
  );
}
