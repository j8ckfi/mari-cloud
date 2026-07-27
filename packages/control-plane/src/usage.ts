// Usage accounting for the cost meter (spec 8.2): per-computer AWAKE-time and
// run-count accumulation in D1, bucketed per calendar month, plus the
// owner-authed GET /api/computers/:id/usage endpoint (wired in handler.ts,
// before the Hono router — app.ts belongs to another lane this phase).
//
// This is INTERNAL ACCOUNTING from substrate price sheets, not billing
// (decisions.md: "Billing: absent until v0.9+ — the 8.2 cost meter is internal
// accounting from substrate price sheets"). Nothing here gates a wake and
// nothing here talks to a payment system.
//
// WRITERS. ComputerDO closes and records every AWAKE interval on lifecycle
// transitions and recurring alarm checkpoints, and records each completed run
// once. The exact call sites and failure semantics are pinned in
// docs/obs-hooks.md.
//
// SCHEMA OWNERSHIP. `usage_ledger` is created here (idempotent ensure) and by
// migrations/0003_usage.sql for the hosted DB; test/usage.test.ts pins the two
// together, the same discipline auth-schema.test.ts applies to 0001. The
// limits lane (A5) plans a `usage_period` table for QUOTA metering in
// migrations/0002_limits.sql; it did not exist when this lane started, so this
// ledger is deliberately separate — see docs/obs-hooks.md for the merge note.

import { makeAuth } from './auth';
import { getOwnedComputer } from './db/fleet';
import { makeLogger } from './obs';
import type { Env } from './types';
import { splitUsagePeriods } from './limits';

// ---------------------------------------------------------------------------
// Price constants — docs/costs.md is the source; change them THERE first.
// All verified against provider pricing pages on 2026-07-27 (see the doc for
// URLs and derivations).
// ---------------------------------------------------------------------------

/** Cloudflare Containers `standard-1` (0.5 vCPU / 4 GiB / 8 GB — the fleet's
 *  one instance type, wrangler.jsonc): USD per AWAKE hour at the 20% mean CPU
 *  duty assumption. 4 GiB×$0.009/GiB-h + 8 GB×$0.000252/GB-h + 0.5 vCPU×20%×$0.072/vCPU-h. */
export const CF_STANDARD1_ACTIVE_USD_PER_HOUR = 0.0452;

/** Same instance, idle-but-attached (provisioned memory+disk, ~0% CPU). */
export const CF_STANDARD1_IDLE_USD_PER_HOUR = 0.038;

/** box.ascii.dev: $20 per 2M VM-seconds = $0.00001/VM-s = $0.036/VM-hour.
 *  With pause-on-inference, billable VM-seconds are EXECUTION seconds only
 *  (the box is paused while the model thinks), which is what `boxMs` meters. */
export const BOX_USD_PER_ACTIVE_HOUR = 0.036;

/** R2 Standard storage — the at-rest cost of a COLD computer's delta. */
export const R2_DELTA_USD_PER_GB_MONTH = 0.015;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** DDL for the usage ledger. Mirrored verbatim by migrations/0003_usage.sql
 *  (pinned by test/usage.test.ts — the auth-schema.test.ts discipline). */
export const USAGE_SCHEMA_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS usage_ledger (
     computerId TEXT NOT NULL,
     period TEXT NOT NULL,
     awakeMs INTEGER NOT NULL DEFAULT 0,
     boxMs INTEGER NOT NULL DEFAULT 0,
     runCount INTEGER NOT NULL DEFAULT 0,
     updatedAt INTEGER NOT NULL,
     PRIMARY KEY (computerId, period)
   )`,
  `CREATE INDEX IF NOT EXISTS usage_ledger_period ON usage_ledger(period)`,
];

/** Idempotent ensure (the apply.ts idiom — no memo on purpose: the vitest
 *  workers pool rolls back per-test storage, and a JS-side "already ensured"
 *  flag would outlive a rolled-back CREATE TABLE). The hosted database gets
 *  the same statements from migrations/0003_usage.sql. */
export async function ensureUsageSchema(db: D1Database): Promise<void> {
  await db.batch(USAGE_SCHEMA_STATEMENTS.map((sql) => db.prepare(sql)));
}

// ---------------------------------------------------------------------------
// Accumulation
// ---------------------------------------------------------------------------

/** The accounting period of a timestamp: UTC calendar month, `YYYY-MM`. */
export function usagePeriod(at: number = Date.now()): string {
  const d = new Date(at);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

const PERIOD_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Clamp a duration to a non-negative finite integer of milliseconds. */
function clampMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

async function upsert(
  db: D1Database,
  computerId: string,
  period: string,
  awakeMs: number,
  boxMs: number,
  runs: number,
  at: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_ledger (computerId, period, awakeMs, boxMs, runCount, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(computerId, period) DO UPDATE SET
         awakeMs = awakeMs + excluded.awakeMs,
         boxMs = boxMs + excluded.boxMs,
         runCount = runCount + excluded.runCount,
         updatedAt = excluded.updatedAt`,
    )
    .bind(computerId, period, awakeMs, boxMs, runs, at)
    .run();
}

/**
 * Record one closed AWAKE stretch (an AWAKE-entry → AWAKE-exit interval).
 * Called on every EXIT from AWAKE — sleep, deep sleep, tier alarm, failed
 * wake, recovery, cold finalize (docs/obs-hooks.md names the DO call sites).
 * A non-positive or non-finite duration records nothing.
 */
export async function recordAwakeStretch(
  db: D1Database,
  computerId: string,
  ms: number,
  at: number = Date.now(),
): Promise<void> {
  const clamped = clampMs(ms);
  if (clamped === 0) return;
  await ensureUsageSchema(db);
  await upsert(db, computerId, usagePeriod(at), clamped, 0, 0, at);
}

/** Record an AWAKE interval into the UTC month(s) where it occurred. */
export async function recordAwakeInterval(
  db: D1Database,
  computerId: string,
  startedAt: number,
  endedAt: number,
): Promise<void> {
  const slices = splitUsagePeriods(startedAt, endedAt);
  if (slices.length === 0) return;
  await ensureUsageSchema(db);
  for (const slice of slices) {
    await upsert(db, computerId, slice.period, slice.ms, 0, 0, endedAt);
  }
}

/**
 * Record one completed run: run count +1, plus its execution time into
 * `boxMs` — box-substrate active time is execution-seconds only
 * (pause-on-inference), so a run's started→ended interval IS its box time.
 */
export async function recordRunExecution(
  db: D1Database,
  computerId: string,
  execMs: number,
  at: number = Date.now(),
): Promise<void> {
  await ensureUsageSchema(db);
  await upsert(db, computerId, usagePeriod(at), 0, clampMs(execMs), 1, at);
}

const hookLog = makeLogger({ module: 'usage' });

/** The DO-facing wrapper: NEVER rejects. A metering write must not be able to
 *  fail a state transition (the transition is the product; the ledger is
 *  bookkeeping). Failures are logged and dropped. */
export async function noteAwakeStretch(
  db: D1Database,
  computerId: string | null,
  ms: number,
): Promise<void> {
  try {
    await recordAwakeStretch(db, computerId ?? 'unknown', ms);
  } catch (err) {
    hookLog.warn('usage_write_failed', {
      kind: 'awake_stretch',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Never-rejecting interval-aware variant used by ComputerDO. */
export async function noteAwakeInterval(
  db: D1Database,
  computerId: string | null,
  startedAt: number,
  endedAt: number,
): Promise<void> {
  try {
    await recordAwakeInterval(db, computerId ?? 'unknown', startedAt, endedAt);
  } catch (err) {
    hookLog.warn('usage_write_failed', {
      kind: 'awake_interval',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Same never-rejects contract for the run-completion hook. */
export async function noteRunExecution(
  db: D1Database,
  computerId: string | null,
  execMs: number,
): Promise<void> {
  try {
    await recordRunExecution(db, computerId ?? 'unknown', execMs);
  } catch (err) {
    hookLog.warn('usage_write_failed', {
      kind: 'run_execution',
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Reads + estimate
// ---------------------------------------------------------------------------

export interface UsageTotals {
  awakeMs: number;
  boxMs: number;
  runCount: number;
}

export async function readUsage(
  db: D1Database,
  computerId: string,
  period: string,
): Promise<UsageTotals> {
  await ensureUsageSchema(db);
  const row = await db
    .prepare(`SELECT awakeMs, boxMs, runCount FROM usage_ledger WHERE computerId = ? AND period = ?`)
    .bind(computerId, period)
    .first<{ awakeMs: number; boxMs: number; runCount: number }>();
  // An absent row is a computer that was never metered this period: zeros,
  // not an error (spec 8.3's render-from-what-you-have discipline).
  return {
    awakeMs: Number(row?.awakeMs ?? 0),
    boxMs: Number(row?.boxMs ?? 0),
    runCount: Number(row?.runCount ?? 0),
  };
}

/** Nano-USD rounding, the pricing.ts ledger discipline: short stretches cost
 *  fractions of a cent and cent-rounding would erase the accounting. */
function roundUsd(v: number): number {
  return Math.round(v * 1e9) / 1e9;
}

/**
 * The v0.1 estimate from the docs/costs.md constants: AWAKE hours at the
 * Cloudflare `standard-1` active rate plus box active hours at the
 * box.ascii.dev rate. The two meter DIFFERENT substrates, so they add: a
 * computer AWAKE on Cloudflare accrues `awakeMs`; a run executing on a box
 * substrate accrues `boxMs`.
 */
export function estimatedUsd(totals: UsageTotals): number {
  const awakeHours = totals.awakeMs / 3_600_000;
  const boxHours = totals.boxMs / 3_600_000;
  return roundUsd(
    awakeHours * CF_STANDARD1_ACTIVE_USD_PER_HOUR + boxHours * BOX_USD_PER_ACTIVE_HOUR,
  );
}

export interface UsageResponse extends UsageTotals {
  computerId: string;
  period: string;
  estimatedUsd: number;
}

export async function usagePayload(
  db: D1Database,
  computerId: string,
  period: string,
): Promise<UsageResponse> {
  const totals = await readUsage(db, computerId, period);
  return { computerId, period, ...totals, estimatedUsd: estimatedUsd(totals) };
}

// ---------------------------------------------------------------------------
// GET /api/computers/:id/usage (wired in handler.ts, before the Hono app)
// ---------------------------------------------------------------------------

const USAGE_ROUTE = /^\/api\/computers\/([^/?]+)\/usage\/?$/;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Owner-authed usage read, matching the repo's tenancy idiom exactly (app.ts):
 * no session → 401 `unauthorized`; a computer that does not exist and a
 * computer that is someone else's are the SAME 404 `not_found`. `?period=`
 * (YYYY-MM) selects a past month; the default is the current one.
 *
 * Returns null when the request is not this route, so handler.ts can try it
 * in its pipeline the way it tries the WebSocket and proxy routes.
 */
export async function tryUsageRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = USAGE_ROUTE.exec(url.pathname);
  if (!match) return null;
  if (request.method !== 'GET') return json({ error: 'method_not_allowed' }, 405);

  const session = await makeAuth(env).api.getSession({ headers: request.headers });
  if (!session?.user) return json({ error: 'unauthorized' }, 401);

  const id = decodeURIComponent(match[1] as string);
  const row = await getOwnedComputer(env.DB, id, session.user.id);
  if (!row) return json({ error: 'not_found' }, 404);

  const periodRaw = url.searchParams.get('period');
  if (periodRaw !== null && !PERIOD_RE.test(periodRaw)) {
    return json({ error: 'bad_period', period: periodRaw }, 400);
  }
  const period = periodRaw ?? usagePeriod();
  return json(await usagePayload(env.DB, row.id, period), 200);
}
