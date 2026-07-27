// Spec 10.3 — per-user quotas: how many computers an account may hold, and how
// much compute (AWAKE time) it may spend per calendar month. "The hosted
// instance sets defaults. A private instance sets its own."
//
// This module is the ONE implementation of the policy: plan resolution from the
// environment, the D1 usage ledger, and the check functions the routes and the
// Durable Object call. app.ts wires the refusals and ComputerDO records closed
// AWAKE intervals; nothing here talks to a substrate or a Durable Object, so a
// refused request costs no substrate call — the same property the wake-proxy
// authorization relies on (decisions.md SEC-03: refuse BEFORE the DO is
// addressed).
//
// PLAN RESOLUTION. Two vars, both optional:
//   LIMIT_MAX_COMPUTERS  — computers an account may hold (count).
//   LIMIT_COMPUTE_HOURS  — AWAKE compute-hours an account may spend per UTC
//                          calendar month.
// A value <= 0 means UNLIMITED (a private instance that wants no ceiling says
// so explicitly). When a var is UNSET the default depends on where this is
// running, decided by the same `isProductionEnv` verdict the auth layer uses
// (two sources for one verdict is how they drift — decisions.md):
//   - production (hosted):    3 computers, 100 compute-hours/month.
//   - everywhere else (dev, tests, a private instance): unlimited. A private
//     instance runs on the user's own substrate account or Docker daemon
//     (spec 11.2) — their machine, their bill — so an unconfigured ceiling
//     would only be a nuisance; the hosted defaults protect a shared wallet.
//
// THE LEDGER. `usage_period` accumulates milliseconds per user per UTC month:
//   awakeMs — AWAKE (compute) time, the metered and CAPPED quantity. Only the
//             Durable Object knows when a computer entered and left AWAKE, so
//             accumulation is ITS job (docs/limits-hooks.md); this module only
//             provides the upsert.
//   boxMs   — substrate-resident time (an instance or its disk exists: AWAKE +
//             WARM). Accumulated for accounting honesty, capped by nothing in
//             v0.1 — WARM is near-zero cost by design (spec §2).
// The period key is the UTC `YYYY-MM` month, so the cap resets on month
// boundaries with no cron: a new month simply upserts a new row.
//
// ENFORCEMENT IS A GATE, NOT A KILL SWITCH. `canWake` refuses NEW wakes (and
// the routes that start one: run creation, file writes) once the month's spend
// crossed the cap; it does not tear down a computer that is already AWAKE.
// A running computer still leaves AWAKE through the ordinary tier policy, and
// the overshoot is bounded by one idle window. v0.1 accepts that bound.
//
// SPEC 10.3's egress limits are NOT here: nothing in the control plane can
// meter a substrate's egress today (spec 13 open item), and a cap that meters
// nothing would be a lie.

import type { Env } from './types';
import { isProductionEnv } from './auth';

/** Hosted default: computers an account may hold (spec 10.3). */
export const HOSTED_MAX_COMPUTERS = 3;
/** Hosted default: AWAKE compute-hours per account per UTC month (spec 10.3). */
export const HOSTED_COMPUTE_HOURS = 100;

/** Resolved plan. `null` means unlimited — never 0, so a cap of "none" cannot
 *  be confused with a cap of "nothing". */
export interface PlanLimits {
  maxComputers: number | null;
  computeSecondsCap: number | null;
}

/** Parse a limit var: unset -> undefined (caller applies defaults), a
 *  non-finite value -> undefined (a typo must not silently mean "no limit"),
 *  <= 0 -> null (explicit UNLIMITED), else the number. */
function parseLimit(raw: string | undefined): number | null | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return n <= 0 ? null : n;
}

/** Resolve the plan for this deployment (see the header for the rules). */
export function planLimits(env: Env): PlanLimits {
  const hosted = isProductionEnv(env);
  const maxComputers = parseLimit(env.LIMIT_MAX_COMPUTERS);
  const computeHours = parseLimit(env.LIMIT_COMPUTE_HOURS);
  return {
    maxComputers:
      maxComputers !== undefined ? maxComputers : hosted ? HOSTED_MAX_COMPUTERS : null,
    computeSecondsCap:
      computeHours !== undefined
        ? computeHours === null
          ? null
          : computeHours * 3600
        : hosted
          ? HOSTED_COMPUTE_HOURS * 3600
          : null,
  };
}

/** The UTC calendar month a timestamp falls in, as `YYYY-MM`. */
export function currentPeriod(now: number = Date.now()): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}

/** Split a half-open UTC interval across calendar months so usage is charged to
 * the month in which it actually occurred, not whichever month happened to
 * contain the exit transition. */
export function splitUsagePeriods(
  startedAt: number,
  endedAt: number,
): { period: string; ms: number }[] {
  let cursor = Math.max(0, Math.floor(startedAt));
  const end = Math.max(cursor, Math.floor(endedAt));
  const slices: { period: string; ms: number }[] = [];
  while (cursor < end) {
    const d = new Date(cursor);
    const next = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    const sliceEnd = Math.min(end, next);
    slices.push({ period: currentPeriod(cursor), ms: sliceEnd - cursor });
    cursor = sliceEnd;
  }
  return slices;
}

/**
 * The usage-ledger DDL. It lives HERE and in `migrations/0002_limits.sql`
 * (test/limits.test.ts pins the two together, the same discipline
 * test/auth-schema.test.ts applies to migration 0001), and NOT in
 * `db/apply.ts`: apply.ts is byte-pinned to migration 0001 and owned by
 * another surface. `ensureLimitsSchema` makes every reader/writer below
 * self-sufficient against a database that has only run migration 0001.
 */
export const LIMITS_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS usage_period (
     userId TEXT NOT NULL,
     period TEXT NOT NULL,
     awakeMs INTEGER NOT NULL DEFAULT 0,
     boxMs INTEGER NOT NULL DEFAULT 0,
     updatedAt INTEGER NOT NULL,
     PRIMARY KEY (userId, period)
   )`,
];

// One schema application per D1Database instance per isolate; the statement is
// IF NOT EXISTS, so a second isolate re-applying it is a no-op.
const ensured = new WeakSet<D1Database>();

/** Create the usage table if absent. Idempotent, memoized per binding. */
export async function ensureLimitsSchema(db: D1Database): Promise<void> {
  if (ensured.has(db)) return;
  for (const sql of LIMITS_SCHEMA_STATEMENTS) await db.prepare(sql).run();
  ensured.add(db);
}

/**
 * Add usage to the user's CURRENT period (upsert-accumulate). Called by the
 * Durable Object when it closes an AWAKE stretch (docs/limits-hooks.md); safe
 * to call with either or both quantities, and with 0 (a no-op row touch).
 * Negative deltas are refused — the ledger only ever grows within a period.
 */
export async function accumulateUsage(
  db: D1Database,
  userId: string,
  delta: { awakeMs?: number; boxMs?: number },
  now: number = Date.now(),
): Promise<void> {
  const awakeMs = Math.max(0, Math.floor(delta.awakeMs ?? 0));
  const boxMs = Math.max(0, Math.floor(delta.boxMs ?? 0));
  if (awakeMs === 0 && boxMs === 0) return;
  await ensureLimitsSchema(db);
  await db
    .prepare(
      `INSERT INTO usage_period (userId, period, awakeMs, boxMs, updatedAt)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(userId, period) DO UPDATE SET
         awakeMs = awakeMs + excluded.awakeMs,
         boxMs = boxMs + excluded.boxMs,
         updatedAt = excluded.updatedAt`,
    )
    .bind(userId, currentPeriod(now), awakeMs, boxMs, now)
    .run();
}

/** Add a closed AWAKE interval to the exact UTC month(s) it spans. */
export async function accumulateAwakeInterval(
  db: D1Database,
  userId: string,
  startedAt: number,
  endedAt: number,
): Promise<void> {
  const slices = splitUsagePeriods(startedAt, endedAt);
  if (slices.length === 0) return;
  await ensureLimitsSchema(db);
  for (const slice of slices) {
    await db
      .prepare(
        `INSERT INTO usage_period (userId, period, awakeMs, boxMs, updatedAt)
         VALUES (?, ?, ?, 0, ?)
         ON CONFLICT(userId, period) DO UPDATE SET
           awakeMs = awakeMs + excluded.awakeMs,
           updatedAt = excluded.updatedAt`,
      )
      .bind(userId, slice.period, slice.ms, endedAt)
      .run();
  }
}

/** The user's accumulated usage for one period (default: the current one). */
export async function usageFor(
  db: D1Database,
  userId: string,
  period: string = currentPeriod(),
): Promise<{ awakeMs: number; boxMs: number }> {
  await ensureLimitsSchema(db);
  const row = await db
    .prepare(`SELECT awakeMs, boxMs FROM usage_period WHERE userId = ? AND period = ?`)
    .bind(userId, period)
    .first<{ awakeMs: number; boxMs: number }>();
  return { awakeMs: Number(row?.awakeMs ?? 0), boxMs: Number(row?.boxMs ?? 0) };
}

async function countComputers(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM computers WHERE userId = ?`)
    .bind(userId)
    .first<{ n: number }>();
  return Number(row?.n ?? 0);
}

/** Refusal shape for the computer-count cap (403 `limit_computers`). */
export type CreateCheck =
  | { ok: true }
  | { ok: false; reason: 'limit_computers'; computers: number; maxComputers: number };

/** May this user hold one MORE computer? Gates create and fork (a fork is a
 *  new computer, spec 9.1 — head copy or not, it holds a fleet slot). */
export async function canCreateComputer(
  db: D1Database,
  env: Env,
  userId: string,
): Promise<CreateCheck> {
  const cap = planLimits(env).maxComputers;
  if (cap === null) return { ok: true };
  const computers = await countComputers(db, userId);
  if (computers >= cap) {
    return { ok: false, reason: 'limit_computers', computers, maxComputers: cap };
  }
  return { ok: true };
}

/** Refusal shape for the compute cap (403 `limit_compute`). */
export type WakeCheck =
  | { ok: true }
  | { ok: false; reason: 'limit_compute'; usedMs: number; capMs: number };

/**
 * May this user start (or implicitly trigger) a wake? Gates POST /wake, run
 * creation, and file writes — every app.ts route that can end in
 * `ComputerDO.wake()` spending compute (decisions.md §4: "an authenticated
 * user can still hold their own computers AWAKE without a ceiling" — this is
 * that ceiling).
 */
export async function canWake(
  db: D1Database,
  env: Env,
  userId: string,
  now: number = Date.now(),
): Promise<WakeCheck> {
  const cap = planLimits(env).computeSecondsCap;
  if (cap === null) return { ok: true };
  const capMs = cap * 1000;
  const { awakeMs } = await usageFor(db, userId, currentPeriod(now));
  if (awakeMs >= capMs) return { ok: false, reason: 'limit_compute', usedMs: awakeMs, capMs };
  return { ok: true };
}

/** What `GET /api/me/limits` serves (the web lane renders this). Caps are
 *  `null` when unlimited; `computeSecondsUsed` is this UTC month's ledger. */
export interface LimitsSummary {
  computeSecondsCap: number | null;
  computeSecondsUsed: number;
  maxComputers: number | null;
  computers: number;
  period: string;
}

export async function limitsSummary(
  db: D1Database,
  env: Env,
  userId: string,
  now: number = Date.now(),
): Promise<LimitsSummary> {
  const plan = planLimits(env);
  const period = currentPeriod(now);
  const usage = await usageFor(db, userId, period);
  return {
    computeSecondsCap: plan.computeSecondsCap,
    computeSecondsUsed: usage.awakeMs / 1000,
    maxComputers: plan.maxComputers,
    computers: await countComputers(db, userId),
    period,
  };
}
