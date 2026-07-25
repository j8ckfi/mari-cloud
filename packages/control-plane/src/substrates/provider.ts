// The substrate provider interface (spec §3.5).
//
// A substrate is an external compute service (Sprites, local Docker, ...). To
// Mari it is stateless: a substrate disk is a cache, and the chunk store is the
// home of each computer (spec §2, §4.1). Mari drives every substrate through
// EXACTLY the six functions named in spec §3.5 and MUST NOT use any other
// substrate capability (spec §3.5 last sentence):
//
//   materialize, destroy, sleep, wake, exec, exposePort
//
// `marid` never talks to a substrate API directly; wake is a control-plane
// scheduling decision (spec §3.6, decisions.md), so these drivers live in the
// control plane and are selected per cold wake.
//
// Handles are plain, JSON/structured-clone-serializable objects: they are
// persisted in the computer's Durable Object storage between calls (a driver
// instance does not outlive a request), so a driver MUST reconstruct all state
// it needs from the handle alone and never stash live objects on it.

import type { ComputerId } from '@mari/shared';

/** Registry key identifying which driver owns a handle (e.g. `"docker"`). */
export type SubstrateName = string;

/**
 * A host-directory mount. In v0 this is the dev store directory bound into a
 * local Docker computer (decisions.md: "mounts (host store dir for dev)").
 * Remote substrates without a host filesystem ignore mounts (see sprites.ts).
 */
export interface Mount {
  /** Absolute path on the substrate host. */
  readonly source: string;
  /** Absolute path inside the computer. */
  readonly target: string;
  /** Mount read-only. Defaults to read-write. */
  readonly readOnly?: boolean;
}

/** Best-effort resource sizing. A substrate may clamp or ignore these. */
export interface ResourceHints {
  /** Fractional vCPUs (e.g. `0.5`, `2`). */
  readonly cpus?: number;
  /** Memory limit in MiB. */
  readonly memoryMiB?: number;
}

/**
 * Everything a substrate needs to materialize a computer. It carries the base
 * image, the marid config as an env map (control URL, auth token, and the wake
 * `epoch` — the fencing token of decisions.md/§6), the dev host mounts, and
 * resource hints.
 */
export interface MaterializeSpec {
  /** Stable computer identity (spec §2). Not a substrate address. */
  readonly computer: ComputerId;
  /** Base image ref (a shared manifest's OS image; spec §2 "Base image"). */
  readonly image: string;
  /**
   * marid configuration injected as process environment. Includes at least the
   * control-plane URL, the supervisor auth token, and the wake epoch. Values
   * are secrets — a driver MUST NOT log them.
   */
  readonly env: Readonly<Record<string, string>>;
  /** Host-directory mounts (dev store dir). */
  readonly mounts?: readonly Mount[];
  /** Resource sizing hints. */
  readonly resources?: ResourceHints;
  /**
   * TCP ports to publish/expose so {@link SubstrateProvider.exposePort} can
   * return a reachable address. On some substrates (Docker) port publishing is
   * fixed at materialize time — see docker.ts.
   */
  readonly ports?: readonly number[];
  /**
   * Entrypoint override. When omitted the image's own entrypoint (the marid
   * binary in production) is used. Provided mainly so tests can run a bespoke
   * process.
   */
  readonly cmd?: readonly string[];
}

/**
 * An opaque, serializable reference to one materialized computer on one
 * substrate. Drivers extend this with their own fields (container id, sprite
 * name/url, published ports). It is stored in DO storage and handed back to
 * every subsequent call, so it must contain everything the driver needs.
 */
export interface SubstrateHandle {
  /** Which driver owns this handle. */
  readonly substrate: SubstrateName;
  /** The computer this handle materializes. */
  readonly computer: ComputerId;
  /** The substrate-native id (container id, sprite id, ...). */
  readonly id: string;
}

/** Options for {@link SubstrateProvider.exec}. */
export interface ExecOptions {
  /** Working directory inside the computer. */
  readonly cwd?: string;
  /** Extra environment for this command only. */
  readonly env?: Readonly<Record<string, string>>;
  /** Bytes to feed to the command's stdin. */
  readonly input?: Uint8Array | string;
}

/**
 * What a substrate says about the resources behind one handle.
 *
 * - `alive`: the instance this handle names still exists on the substrate. It may
 *   be AWAKE or WARM (a `docker pause`d container is `alive`) — this answers
 *   "do the resources exist", not "is a process running".
 * - `gone`: the substrate is certain the instance no longer exists. Everything on
 *   its disk is lost; only the chunk store still holds the computer (spec §4.1).
 * - `unknown`: the substrate could not be asked (API unreachable, a call that did
 *   not answer in time). NOT a synonym for `gone`: a caller must bound how long
 *   it will tolerate `unknown` rather than treat it as either verdict.
 */
export type InstanceStatus = 'alive' | 'gone' | 'unknown';

/** The result of {@link SubstrateProvider.exec}. */
export interface ExecResult {
  /** Process exit code. A terminating signal is normalized to `128 + signal`. */
  readonly exitCode: number;
  /** Captured standard output, decoded as UTF-8. */
  readonly stdout: string;
  /** Captured standard error, decoded as UTF-8. */
  readonly stderr: string;
}

/**
 * The provider interface: EXACTLY spec §3.5's six functions, nothing more. Each
 * substrate module implements this and only this; Mari must not reach for other
 * substrate features.
 */
export interface SubstrateProvider {
  /**
   * Whether this substrate can hold a computer WARM (spec §2, as amended by
   * decisions.md "WARM is a fast cold wake"): substrate resources retained, the
   * substrate disk still holding the computer, no process, no compute billed.
   *
   * `undefined` (the default) and `true` mean WARM works — Docker (`pause`) and
   * Sprites (auto-suspend) both keep their disk. `false` means the substrate
   * CANNOT keep the disk across a stop, so WARM would be a lie: Cloudflare
   * Containers document "All disk is ephemeral. When a Container instance goes
   * to sleep, the next time it is started, it will have a fresh disk as defined
   * by its container image", which was also measured (a marker written to /work
   * did not survive destroy+start).
   *
   * A driver that declares `false` has {@link sleep} ≡ {@link destroy}, and the
   * tier policy (spec §4.4) must take such a computer AWAKE → COLD directly,
   * still writing the pre-transition manifest spec §4.5 requires — otherwise the
   * DO would record WARM for a computer whose disk is already gone, and the next
   * wake would "resume" a resource that no longer holds anything.
   */
  readonly supportsWarm?: boolean;

  /**
   * Materialize the computer on this substrate and return AWAKE (spec §2):
   * processes active, ready for {@link exec}. Idempotent per computer is not
   * required; callers hold the fencing epoch that guarantees a single writer.
   */
  materialize(spec: MaterializeSpec): Promise<SubstrateHandle>;

  /**
   * Destroy all substrate resources for the handle (spec §4.4 WARM→COLD). After
   * this returns, no substrate resources exist; the computer lives only in the
   * chunk store. Destroying an already-gone handle resolves without error.
   */
  destroy(handle: SubstrateHandle): Promise<void>;

  /**
   * Put the computer into WARM (spec §2, as amended by decisions.md "WARM is a
   * fast cold wake"): stop the processes and keep the disk. Memory does not
   * survive — no substrate's checkpoint is relied upon — so the caller has
   * already had the supervisor stop each agent session cleanly and write a
   * manifest (spec §4.5). No compute is billed while WARM, and the wake reads
   * the substrate's own disk cache with no chunk-store transfer.
   *
   * A substrate that cannot keep the disk declares {@link supportsWarm} `false`,
   * and then `sleep` is exactly {@link destroy} (see cloudflare.ts).
   */
  sleep(handle: SubstrateHandle): Promise<void>;

  /** Wake a WARM computer back to AWAKE. The inverse of {@link sleep}. */
  wake(handle: SubstrateHandle): Promise<void>;

  /**
   * Run `argv` inside the computer and capture its output and exit status.
   * `argv[0]` is the executable; the array is NOT shell-interpreted.
   */
  exec(
    handle: SubstrateHandle,
    argv: readonly string[],
    opts?: ExecOptions,
  ): Promise<ExecResult>;

  /**
   * Return a URL/address that reaches `port` inside the computer (spec §8.5
   * preview mode is built on this). The port must be one that was requested via
   * {@link MaterializeSpec.ports} where the substrate fixes publishing at
   * materialize time.
   */
  exposePort(handle: SubstrateHandle, port: number): Promise<string>;

  // ── Optional capabilities ──────────────────────────────────────────────────
  //
  // Everything below is OPTIONAL and exists because one substrate cannot express
  // a spec §3.5 function the way the others can. They are declarations, not new
  // functions: a driver that omits them behaves exactly as before, and no caller
  // may require them. Adding a seventh mandatory function would break §3.5.

  /**
   * Renew the substrate's own inactivity timer for the duration of a run
   * (spec §5.4: "On a substrate that stops idle machines, the supervisor holds
   * the machine AWAKE during a run"). Driven by `run_heartbeat` on the
   * marid → DO → driver path (decisions.md), so the supervisor never talks to a
   * substrate API itself.
   *
   * BEST EFFORT AND SECONDARY: the authoritative hold is the DO's own tier alarm,
   * which every substrate shares. A driver implements this only when its platform
   * has an idle timer of its own; a rejection is swallowed by the caller and must
   * never fail a run.
   */
  holdAwake?(handle: SubstrateHandle): Promise<void>;

  /**
   * Report whether the resources behind `handle` still exist (spec §4.7's "a
   * substrate returns a stale disk" has a harsher sibling: the substrate returns
   * NO disk, because the instance is gone).
   *
   * WHY THIS IS NOT A SEVENTH SPEC §3.5 FUNCTION. The six functions are how Mari
   * CHANGES a substrate's state; this is a READ of the state Mari already asked
   * for, and the control plane can already take it through §3.5's {@link exec}:
   * the cheapest possible command either runs inside the instance or it does not.
   * What `exec` cannot do is tell "this instance is gone" apart from "I could not
   * reach the substrate API", and that distinction decides whether a computer is
   * recovered (fresh instance, new epoch, restore from the head) or left alone.
   * So this is an OPTIONAL declaration in the same family as {@link holdAwake},
   * {@link proxyFetch} and {@link supportsWarm}: a driver that already tracks the
   * answer (Docker: `inspect`; Cloudflare: `running` plus the platform's own
   * "no container instance") says so, and a driver that omits it is probed
   * through `exec` and reports {@link InstanceStatus} `unknown` on refusal, which
   * the caller must bound. No caller may REQUIRE this method.
   *
   * A driver MUST NOT start, stop or otherwise change the instance here, and MUST
   * NOT throw: an unanswerable probe is `unknown`.
   */
  instanceStatus?(handle: SubstrateHandle): Promise<InstanceStatus>;

  /**
   * Serve a request to `port` inside the computer, for a substrate whose exposed
   * port is reachable ONLY through the runtime that hosts the driver — no URL
   * exists that a plain `fetch` could reach (Cloudflare Containers: the port is
   * behind `ctx.container.getTcpPort(port)` on the computer's own Durable
   * Object). {@link exposePort} still reports the in-computer address; this is
   * how the bytes actually travel.
   *
   * Where a driver implements this, the wake proxy (spec §8.5) MUST prefer it
   * over fetching {@link exposePort}'s string, and the request keeps flowing
   * through the control plane — which is the point: a tunnel that fronted the
   * container directly would bypass the auth and epoch gating the control plane
   * exists to enforce.
   */
  proxyFetch?(handle: SubstrateHandle, port: number, request: Request): Promise<Response>;
}
