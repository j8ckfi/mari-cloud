// REAL substrate selection for the Node runtime (spec §3.6, §3.7).
//
// "Wake is a scheduling decision. On each cold wake, Mari selects a substrate by
// price, capacity, and latency. A computer has no fixed substrate." (spec 3.6)
//
// So this is not "pick Docker and hard-wire it": every `materialize` runs
// `selectSubstrate` over the drivers this host can actually reach (Docker when a
// daemon socket exists, Sprites when a token is configured), and every later
// call is routed to the driver named by the handle — a computer materialized on
// Docker is destroyed on Docker even if the selection would now prefer Sprites.
// The fake driver stays where it belongs: control-plane Workers tests only.
//
// The wrapper also owns what is substrate-shaped rather than computer-shaped:
// the chunk-store bind mount (`/store`), published ports, and resource hints.
// The marid config itself (computer id, epoch, token, control URL, store URI,
// restore manifest) is composed by the Durable Object, because it is identical
// on every substrate.

import {
  DOCKER_SUBSTRATE,
  SPRITES_SUBSTRATE,
  createSubstrate,
  selectSubstrate,
  type SelectionWeights,
  type SubstrateName,
} from '../substrates/index.js';
import { findDockerSocket } from '../substrates/docker.js';
import type {
  ExecOptions,
  ExecResult,
  InstanceStatus,
  MaterializeSpec,
  Mount,
  SubstrateHandle,
  SubstrateProvider,
} from '../substrates/provider.js';

export interface RuntimeSubstrateConfig {
  /** Candidate driver names, in preference order (ties break earlier-first). */
  readonly candidates: readonly SubstrateName[];
  /** Weighting of price / capacity / latency in the wake decision (spec 3.6). */
  readonly weights?: SelectionWeights;
  /** Host directory holding the chunk store, bind-mounted into each computer. */
  readonly storeHostDir?: string;
  /** Mount point of the chunk store inside the computer (matches MARI_STORE). */
  readonly storeMountPath: string;
  /** Ports published at materialize time (Docker fixes publishing at create). */
  readonly ports: readonly number[];
  /** Resource hints handed to the driver. */
  readonly cpus?: number;
  readonly memoryMiB?: number;
  /** Sprites credentials; when absent, Sprites is not a candidate. */
  readonly spritesToken?: string;
  readonly spritesBaseUrl?: string;
}

/** Drivers whose WARM state freezes the guest process (Docker `pause`). Such a
 *  computer cannot answer `prepare_for_cold`, so the DO resumes it first. */
const FREEZES_WHEN_WARM: ReadonlySet<string> = new Set([DOCKER_SUBSTRATE]);

/**
 * The provider the Durable Object drives on a private instance. Implements the
 * six spec §3.5 functions and nothing else; `materialize` additionally performs
 * the spec §3.6 selection.
 */
export class RuntimeSubstrate implements SubstrateProvider {
  readonly #drivers = new Map<SubstrateName, Promise<SubstrateProvider>>();
  readonly #available: SubstrateName[];

  constructor(
    private readonly config: RuntimeSubstrateConfig,
    available: readonly SubstrateName[],
  ) {
    this.#available = [...available];
  }

  /** The drivers this host can actually reach, in preference order. */
  get available(): readonly SubstrateName[] {
    return this.#available;
  }

  /** True when this handle's substrate freezes the guest while WARM, so the DO
   *  must wake it before asking the supervisor to stop cleanly (spec 4.5). */
  resumeBeforeCold(handle: SubstrateHandle): boolean {
    return FREEZES_WHEN_WARM.has(handle.substrate);
  }

  async materialize(spec: MaterializeSpec): Promise<SubstrateHandle> {
    const name = selectSubstrate(this.#available, this.config.weights ?? {});
    const driver = await this.#driver(name);
    const mounts: Mount[] = [...(spec.mounts ?? [])];
    if (this.config.storeHostDir) {
      // The chunk store is the home of the computer (spec §2): the supervisor
      // reads and writes it directly (decisions.md direct-to-store), so it is
      // mounted rather than proxied through the control plane.
      mounts.push({ source: this.config.storeHostDir, target: this.config.storeMountPath });
    }
    const ports = spec.ports && spec.ports.length > 0 ? spec.ports : this.config.ports;
    return driver.materialize({
      ...spec,
      mounts,
      ports: [...ports],
      resources: spec.resources ?? { cpus: this.config.cpus, memoryMiB: this.config.memoryMiB },
    });
  }

  async destroy(handle: SubstrateHandle): Promise<void> {
    return (await this.#driver(handle.substrate)).destroy(handle);
  }

  async sleep(handle: SubstrateHandle): Promise<void> {
    return (await this.#driver(handle.substrate)).sleep(handle);
  }

  async wake(handle: SubstrateHandle): Promise<void> {
    return (await this.#driver(handle.substrate)).wake(handle);
  }

  async exec(
    handle: SubstrateHandle,
    argv: readonly string[],
    opts?: ExecOptions,
  ): Promise<ExecResult> {
    return (await this.#driver(handle.substrate)).exec(handle, argv, opts);
  }

  async exposePort(handle: SubstrateHandle, port: number): Promise<string> {
    return (await this.#driver(handle.substrate)).exposePort(handle, port);
  }

  /**
   * Route the liveness probe to the driver that owns the handle (provider.ts's
   * optional declaration). A driver that does not declare it reports `unknown`,
   * which is what the Durable Object's bounded probe path expects — it must never
   * be told `gone` about a substrate nobody asked.
   */
  async instanceStatus(handle: SubstrateHandle): Promise<InstanceStatus> {
    try {
      const driver = await this.#driver(handle.substrate);
      return driver.instanceStatus ? await driver.instanceStatus(handle) : 'unknown';
    } catch {
      // A driver that cannot even be constructed (an unreachable daemon socket)
      // has not answered the question; it has not answered `gone` either.
      return 'unknown';
    }
  }

  /** Construct (once) the driver named `name`. */
  #driver(name: SubstrateName): Promise<SubstrateProvider> {
    const existing = this.#drivers.get(name);
    if (existing) return existing;
    let created: Promise<SubstrateProvider>;
    if (name === SPRITES_SUBSTRATE) {
      const token = this.config.spritesToken;
      if (!token) {
        return Promise.reject(new Error('sprites substrate selected but SPRITES_TOKEN is unset'));
      }
      created = Promise.resolve(
        createSubstrate(SPRITES_SUBSTRATE, {
          token,
          ...(this.config.spritesBaseUrl ? { baseUrl: this.config.spritesBaseUrl } : {}),
        }),
      );
    } else if (name === DOCKER_SUBSTRATE) {
      created = createSubstrate(DOCKER_SUBSTRATE);
    } else {
      return Promise.reject(new Error(`unknown substrate "${name}"`));
    }
    this.#drivers.set(name, created);
    return created;
  }
}

/**
 * Build the runtime substrate for this host, or throw when nothing is
 * reachable — a private instance with no substrate can create a computer but
 * could never wake one, and failing loudly at boot beats a 500 at wake time.
 */
export function createRuntimeSubstrate(config: RuntimeSubstrateConfig): RuntimeSubstrate {
  const available = config.candidates.filter((name) => {
    if (name === DOCKER_SUBSTRATE) return findDockerSocket() !== undefined;
    if (name === SPRITES_SUBSTRATE) return Boolean(config.spritesToken);
    return false;
  });
  if (available.length === 0) {
    throw new Error(
      `no substrate available: candidates=[${config.candidates.join(', ')}]; ` +
        `Docker needs a reachable daemon socket (DOCKER_HOST or a well-known path) ` +
        `and Sprites needs SPRITES_TOKEN`,
    );
  }
  return new RuntimeSubstrate(config, available);
}
