// The cost meter (spec 8.2), from a STATIC substrate price sheet.
//
// decisions.md: "The 8.2 cost meter is internal accounting from substrate price
// sheets, independent of billing." Nothing here talks to a payment system, and
// nothing here gates a wake — it is bookkeeping the fleet view renders so a user
// can see what a computer costs while it is AWAKE.
//
// The meter's only input is AWAKE time: a WARM computer costs "near zero" and a
// COLD one costs "object storage only" (spec §2), neither of which is compute,
// so only AWAKE seconds accrue here.

/** USD per AWAKE hour, per substrate (spec 3.5 providers). v0 list prices. */
export const SUBSTRATE_PRICE_PER_HOUR: Readonly<Record<string, number>> = {
  /** Cloudflare Containers standard-1 at the fleet's documented 20% mean CPU
   * duty assumption (usage.ts / docs/costs.md). */
  cloudflare: 0.0452,
  /** box.ascii.dev active VM-second rate. */
  box: 0.036,
  sprites: 0.12,
  sail: 0.1,
  northflank: 0.15,
  /** Local Docker on the user's own machine: no metered compute charge. */
  docker: 0,
  /** The in-memory driver used by control-plane tests, priced like a small
   *  microVM so the accounting path is exercised end to end. */
  fake: 0.05,
};

/** Fallback rate for an unknown substrate name. */
export const DEFAULT_PRICE_PER_HOUR = 0.1;

/** The accounting currency. v0 is single-currency. */
export const COST_CURRENCY = 'USD';

/** The label the fleet card shows for the accumulation window. */
export const COST_WINDOW = 'since creation';

/** The fleet-card cost meter (web `CostMeter`). */
export interface CostMeter {
  currency: string;
  /** Accrued cost over the accounting window. */
  accrued: number;
  /** Burn rate while AWAKE; zero when the computer is not AWAKE. */
  ratePerHour: number;
  window: string;
  /** The AWAKE seconds the accrual was computed from (internal accounting). */
  awakeSeconds: number;
}

/** Price sheet lookup for a substrate name. */
export function ratePerHour(substrate: string | undefined): number {
  if (!substrate) return DEFAULT_PRICE_PER_HOUR;
  const rate = SUBSTRATE_PRICE_PER_HOUR[substrate];
  return rate === undefined ? DEFAULT_PRICE_PER_HOUR : rate;
}

/** Accrual is kept to nano-currency: a short AWAKE stretch costs a tiny
 *  fraction of a cent, and rounding it to cents would erase the accounting
 *  entirely. Presentation rounding belongs to the interface, not to the ledger. */
function roundCost(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

/** AWAKE time is metered at millisecond resolution. */
function roundSeconds(v: number): number {
  return Math.round(v * 1e3) / 1e3;
}

/**
 * Build the meter for one computer: accumulated AWAKE seconds x the substrate's
 * hourly price. `ratePerHour` is the LIVE burn rate, so it is zero unless the
 * computer is AWAKE right now; `accrued` keeps the historical total either way.
 */
export function costMeter(
  substrate: string | undefined,
  awakeSeconds: number,
  state: string,
): CostMeter {
  const rate = ratePerHour(substrate);
  const seconds = Number.isFinite(awakeSeconds) && awakeSeconds > 0 ? awakeSeconds : 0;
  return {
    currency: COST_CURRENCY,
    accrued: roundCost((seconds / 3600) * rate),
    ratePerHour: state === 'awake' ? rate : 0,
    window: COST_WINDOW,
    awakeSeconds: roundSeconds(seconds),
  };
}
