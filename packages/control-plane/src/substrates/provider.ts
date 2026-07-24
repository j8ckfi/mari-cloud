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
   * Put the computer into native sleep — WARM (spec §2): checkpoint or pause.
   * Wake must be immediate and cost near zero.
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
}
