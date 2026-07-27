// Substrate registry and the wake scheduling decision (spec §3.6).
//
// "Wake is a scheduling decision. On each cold wake, Mari selects a substrate by
// price, capacity, and latency. A computer has no fixed substrate." (spec §3.6)
//
// This module maps substrate names to driver factories and implements
// `selectSubstrate`. Only Workers-safe modules are imported statically here; the
// Node-only Docker driver is reached through a lazy `import('./docker.js')` so a
// Workers bundle of the control plane never pulls dockerode (see docker.ts).

import type { SubstrateProvider } from './provider.js';
import type { DockerProviderOptions } from './docker.js';
import { SPRITES_SUBSTRATE, SpritesProvider, createSpritesProvider } from './sprites.js';
import type { SpritesConfig } from './sprites.js';
import { CLOUDFLARE_SUBSTRATE, CloudflareProvider } from './cloudflare.js';
import type { CloudflareConfig } from './cloudflare.js';
import { BOX_SUBSTRATE, BoxProvider } from './box.js';
import type { BoxConfig } from './box.js';

export type { SubstrateName } from './provider.js';
import type { SubstrateName } from './provider.js';

// Re-export the interface, types, and drivers. Type-only re-exports for docker
// are erased, so they do not drag the Node-only module into a Workers bundle.
export * from './provider.js';
export {
  SPRITES_SUBSTRATE,
  DEFAULT_SPRITES_BASE_URL,
  SpritesProvider,
  createSpritesProvider,
} from './sprites.js';
export type { SpritesHandle, SpritesConfig } from './sprites.js';
export {
  CLOUDFLARE_SUBSTRATE,
  CloudflareProvider,
  CloudflareSubstrateError,
  createCloudflareProvider,
} from './cloudflare.js';
export type {
  CloudflareHandle,
  CloudflareConfig,
  CloudflareErrorKind,
  ContainerExitInfo,
} from './cloudflare.js';
export {
  BOX_SUBSTRATE,
  DEFAULT_BOX_BASE_URL,
  BoxProvider,
  BoxSubstrateError,
  createBoxProvider,
} from './box.js';
export type { BoxHandle, BoxConfig, BoxErrorKind } from './box.js';
export type {
  DockerProvider,
  DockerHandle,
  DockerProviderOptions,
  PublishedPort,
} from './docker.js';

/** Canonical registry key of the local Docker driver (mirrors docker.ts). */
export const DOCKER_SUBSTRATE = 'docker';

/** The substrate names this build knows how to drive. */
export const SUBSTRATE_NAMES = [
  DOCKER_SUBSTRATE,
  SPRITES_SUBSTRATE,
  CLOUDFLARE_SUBSTRATE,
  BOX_SUBSTRATE,
] as const;

/**
 * Create a driver by name.
 *
 * `docker` resolves asynchronously because it lazily imports the Node-only
 * dockerode module (and so is never selected/loaded on Workers). `sprites` is
 * `fetch`-only and constructs synchronously.
 */
export function createSubstrate(
  name: typeof DOCKER_SUBSTRATE,
  config?: DockerProviderOptions,
): Promise<SubstrateProvider>;
export function createSubstrate(
  name: typeof SPRITES_SUBSTRATE,
  config: SpritesConfig,
): SubstrateProvider;
export function createSubstrate(
  name: typeof CLOUDFLARE_SUBSTRATE,
  config: CloudflareConfig,
): SubstrateProvider;
export function createSubstrate(name: typeof BOX_SUBSTRATE, config: BoxConfig): SubstrateProvider;
export function createSubstrate(
  name: SubstrateName,
  config?: DockerProviderOptions | SpritesConfig | CloudflareConfig | BoxConfig,
): SubstrateProvider | Promise<SubstrateProvider>;
export function createSubstrate(
  name: SubstrateName,
  config?: DockerProviderOptions | SpritesConfig | CloudflareConfig | BoxConfig,
): SubstrateProvider | Promise<SubstrateProvider> {
  switch (name) {
    case DOCKER_SUBSTRATE:
      return import('./docker.js').then((m) =>
        m.createDockerProvider(config as DockerProviderOptions | undefined),
      );
    case SPRITES_SUBSTRATE:
      return new SpritesProvider(config as SpritesConfig);
    case CLOUDFLARE_SUBSTRATE:
      // Workers-only, but Workers-SAFE to import: the driver has no dependency
      // beyond the live `ctx.container` handed to it here, so unlike docker.js it
      // needs no lazy import.
      return new CloudflareProvider(config as CloudflareConfig);
    case BOX_SUBSTRATE:
      // fetch-only, so like Sprites it constructs synchronously and is safe on
      // both the Workers and the Node entry.
      return new BoxProvider(config as BoxConfig);
    default:
      throw new Error(`unknown substrate "${name}"`);
  }
}

/**
 * The registry: substrate name → driver factory. `docker`'s factory is async
 * (lazy Node-only import); `sprites`'s is synchronous. Prefer {@link createSubstrate}
 * for its precise overloads; this object exists for name-driven dispatch.
 */
export const substrateRegistry = {
  [DOCKER_SUBSTRATE]: (config?: DockerProviderOptions): Promise<SubstrateProvider> =>
    createSubstrate(DOCKER_SUBSTRATE, config),
  [SPRITES_SUBSTRATE]: (config: SpritesConfig): SubstrateProvider =>
    createSubstrate(SPRITES_SUBSTRATE, config),
  [CLOUDFLARE_SUBSTRATE]: (config: CloudflareConfig): SubstrateProvider =>
    createSubstrate(CLOUDFLARE_SUBSTRATE, config),
  [BOX_SUBSTRATE]: (config: BoxConfig): SubstrateProvider => createSubstrate(BOX_SUBSTRATE, config),
} as const;

// ── Wake scheduling (spec §3.6) ──────────────────────────────────────────────

/**
 * A substrate's v0 static profile — the inputs to the wake scheduling decision.
 * `usdPerHour` also feeds the internal cost meter (decisions.md §8.2), which is
 * independent of billing.
 */
export interface SubstrateProfile {
  /** Estimated compute price, USD per hour (lower is better). */
  readonly usdPerHour: number;
  /** Fraction of requested capacity currently available, 0..1 (higher better). */
  readonly capacity: number;
  /** Typical cold-wake latency in milliseconds (lower is better). */
  readonly wakeLatencyMs: number;
}

/**
 * v0 static profile table (spec §3.6 "a static price table for v0"). Local
 * Docker is free and near-instant but only exists on the dev/private host;
 * Sprites costs money but is the hosted default. Real capacity/latency numbers
 * are Open Item (spec §13) — these are placeholders behind this interface.
 */
export const SUBSTRATE_PROFILES: Readonly<Record<string, SubstrateProfile>> = {
  [DOCKER_SUBSTRATE]: { usdPerHour: 0, capacity: 1, wakeLatencyMs: 300 },
  [SPRITES_SUBSTRATE]: { usdPerHour: 0.06, capacity: 0.9, wakeLatencyMs: 1500 },
  // Cloudflare is the only row here with MEASURED numbers behind it.
  //   price: `standard-1` (0.5 vCPU / 4 GiB / 8 GB) at the published rates —
  //          memory $0.0090/GiB-h + disk $0.000252/GB-h + CPU $0.0720/vCPU-h at
  //          an assumed 20% duty = $0.0452/h. WARM and COLD are $0.00/h here.
  //   latency: container start → marid "cold-wake restore complete" for a 35 MiB,
  //          45-entry manifest was 686 ms and 1037 ms on two instances. Per-instance
  //          throughput varied 2.8x on the same instance_type, so this is a p50-ish
  //          figure and spec §13 still wants a real p99 before anyone budgets on it.
  //   capacity: `max_instances` (default 20) caps CONCURRENT AWAKE computers and
  //          errors a wake past it, so real capacity is a fleet-level fact this
  //          static table cannot know.
  [CLOUDFLARE_SUBSTRATE]: { usdPerHour: 0.0452, capacity: 0.95, wakeLatencyMs: 1000 },
  // Box (box.ascii.dev). NOT measured yet — placeholders behind the interface,
  // like docker/sprites (spec §13 wants real numbers before anyone budgets):
  //   price: the machine is a Hetzner CX33 (4 shared vCPU / 8 GB / 75 GB NVMe,
  //          per docs.ascii.dev/box/machines) billed per second while running;
  //          the CX33 list price is on the order of $0.01/h, and archived boxes
  //          bill no compute — but Box's own margin over Hetzner is unpublished,
  //          so this row deliberately does not undercut Cloudflare's MEASURED one.
  //   latency: a wake from WARM is resume-from-archive (snapshot restore + boot,
  //          plausibly tens of seconds), far slower than a Cloudflare start.
  [BOX_SUBSTRATE]: { usdPerHour: 0.05, capacity: 0.9, wakeLatencyMs: 15_000 },
};

/**
 * Relative importance of each factor in {@link selectSubstrate}. Higher weight
 * ⇒ that factor matters more; `0` ignores it. Omitted factors default to `1`.
 */
export interface SelectionWeights {
  readonly price?: number;
  readonly capacity?: number;
  readonly latency?: number;
}

/**
 * Select the best substrate among `candidates` by price, capacity, and latency
 * (spec §3.6). Each factor is min-max normalized across the candidates to a
 * 0..1 "goodness" (cheaper / more capacity / lower latency ⇒ higher), then
 * combined by `weights`. Ties break toward the earlier candidate, so the caller
 * can order `candidates` by preference. Candidates without a known profile are
 * ignored; if none remain, this throws.
 *
 * A stub in the sense of spec §3.6 (static table, no live capacity/latency
 * probing yet) but a real, deterministic decision function — not a constant.
 */
export function selectSubstrate(
  candidates: readonly SubstrateName[],
  weights: SelectionWeights = {},
  profiles: Readonly<Record<string, SubstrateProfile>> = SUBSTRATE_PROFILES,
): SubstrateName {
  const known = candidates.filter((c) => profiles[c] !== undefined);
  if (known.length === 0) {
    throw new Error(
      `selectSubstrate: no candidate has a known profile (candidates: ${candidates.join(', ') || '<none>'})`,
    );
  }
  if (known.length === 1) return known[0]!;

  const wPrice = clampWeight(weights.price);
  const wCapacity = clampWeight(weights.capacity);
  const wLatency = clampWeight(weights.latency);

  const prices = known.map((c) => profiles[c]!.usdPerHour);
  const caps = known.map((c) => profiles[c]!.capacity);
  const lats = known.map((c) => profiles[c]!.wakeLatencyMs);

  let best: SubstrateName = known[0]!;
  let bestScore = -Infinity;
  for (const c of known) {
    const p = profiles[c]!;
    // Normalize to goodness in [0,1]: lower price/latency and higher capacity win.
    const score =
      wPrice * lowerIsBetter(p.usdPerHour, prices) +
      wCapacity * higherIsBetter(p.capacity, caps) +
      wLatency * lowerIsBetter(p.wakeLatencyMs, lats);
    if (score > bestScore) {
      bestScore = score;
      best = c;
    }
  }
  return best;
}

function clampWeight(w: number | undefined): number {
  if (w == null) return 1;
  return w < 0 ? 0 : w;
}

/** Goodness for a metric where lower is better, min-max normalized across `all`. */
function lowerIsBetter(value: number, all: readonly number[]): number {
  const min = Math.min(...all);
  const max = Math.max(...all);
  if (max === min) return 1; // no differentiation
  return (max - value) / (max - min);
}

/** Goodness for a metric where higher is better, min-max normalized across `all`. */
function higherIsBetter(value: number, all: readonly number[]): number {
  const min = Math.min(...all);
  const max = Math.max(...all);
  if (max === min) return 1;
  return (value - min) / (max - min);
}
