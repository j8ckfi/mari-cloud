// Usage accounting (spec 8.2 cost meter): accumulation arithmetic against the
// real D1 binding, period bucketing, the estimatedUsd formula from the
// docs/costs.md constants, the owner-authed endpoint (owner 200, no session
// 401, stranger 404 — the repo's tenancy idiom), and the no-drift pin between
// src/usage.ts and migrations/0003_usage.sql (the auth-schema.test.ts
// discipline).

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import migrationSql from '../migrations/0003_usage.sql?raw';
import {
  BOX_USD_PER_ACTIVE_HOUR,
  CF_STANDARD1_ACTIVE_USD_PER_HOUR,
  USAGE_SCHEMA_STATEMENTS,
  ensureUsageSchema,
  estimatedUsd,
  readUsage,
  recordAwakeStretch,
  recordRunExecution,
  noteAwakeStretch,
  usagePeriod,
  usagePayload,
} from '../src/usage';
import { apiGet, createComputer, ensureSchema, env, HOST, seedSession } from './helpers';

interface UsageBody {
  computerId: string;
  period: string;
  awakeMs: number;
  boxMs: number;
  runCount: number;
  estimatedUsd: number;
  error?: string;
}

describe('usage accumulation (D1)', () => {
  beforeAll(async () => {
    await ensureSchema();
    await ensureUsageSchema(env.DB);
  });

  it('sums awake stretches and run executions in one period', async () => {
    const id = `usage-${crypto.randomUUID().slice(0, 8)}`;
    const at = Date.UTC(2026, 6, 15); // 2026-07
    await recordAwakeStretch(env.DB, id, 1500, at);
    await recordAwakeStretch(env.DB, id, 2500, at + 1000);
    await recordRunExecution(env.DB, id, 600, at + 2000);
    await recordRunExecution(env.DB, id, 400, at + 3000);
    const totals = await readUsage(env.DB, id, '2026-07');
    expect(totals).toEqual({ awakeMs: 4000, boxMs: 1000, runCount: 2 });
  });

  it('buckets by UTC calendar month', async () => {
    const id = `usage-${crypto.randomUUID().slice(0, 8)}`;
    const july = Date.UTC(2026, 6, 31, 23, 59, 59);
    const august = Date.UTC(2026, 7, 1, 0, 0, 1);
    expect(usagePeriod(july)).toBe('2026-07');
    expect(usagePeriod(august)).toBe('2026-08');
    await recordAwakeStretch(env.DB, id, 100, july);
    await recordAwakeStretch(env.DB, id, 900, august);
    expect((await readUsage(env.DB, id, '2026-07')).awakeMs).toBe(100);
    expect((await readUsage(env.DB, id, '2026-08')).awakeMs).toBe(900);
  });

  it('ignores non-positive and non-finite durations', async () => {
    const id = `usage-${crypto.randomUUID().slice(0, 8)}`;
    await recordAwakeStretch(env.DB, id, 0);
    await recordAwakeStretch(env.DB, id, -50);
    await recordAwakeStretch(env.DB, id, Number.NaN);
    await recordAwakeStretch(env.DB, id, Number.POSITIVE_INFINITY);
    const totals = await readUsage(env.DB, id, usagePeriod());
    // Infinity clamps to 0 (nothing honest to record), so everything is zero.
    expect(totals.awakeMs).toBe(0);
    expect(totals.runCount).toBe(0);
  });

  it('an unmetered computer reads as zeros, not an error', async () => {
    const totals = await readUsage(env.DB, 'never-metered', usagePeriod());
    expect(totals).toEqual({ awakeMs: 0, boxMs: 0, runCount: 0 });
  });

  it('the DO-facing note* wrapper never rejects', async () => {
    const broken = {
      batch: () => Promise.reject(new Error('d1 down')),
      prepare: () => ({ bind: () => ({ run: () => Promise.reject(new Error('d1 down')) }) }),
    } as unknown as D1Database;
    await expect(noteAwakeStretch(broken, 'c1', 1000)).resolves.toBeUndefined();
  });

  it('estimatedUsd applies the docs/costs.md constants', () => {
    // One AWAKE hour on Cloudflare standard-1 + one active box hour.
    expect(estimatedUsd({ awakeMs: 3_600_000, boxMs: 0, runCount: 1 })).toBe(
      CF_STANDARD1_ACTIVE_USD_PER_HOUR,
    );
    expect(estimatedUsd({ awakeMs: 0, boxMs: 3_600_000, runCount: 1 })).toBe(
      BOX_USD_PER_ACTIVE_HOUR,
    );
    expect(estimatedUsd({ awakeMs: 3_600_000, boxMs: 3_600_000, runCount: 1 })).toBeCloseTo(
      CF_STANDARD1_ACTIVE_USD_PER_HOUR + BOX_USD_PER_ACTIVE_HOUR,
      9,
    );
    expect(estimatedUsd({ awakeMs: 0, boxMs: 0, runCount: 0 })).toBe(0);
    // Sub-cent stretches survive rounding (the pricing.ts ledger discipline).
    expect(estimatedUsd({ awakeMs: 1000, boxMs: 0, runCount: 0 })).toBeGreaterThan(0);
  });

  it('usagePayload carries totals + estimate for the endpoint', async () => {
    const id = `usage-${crypto.randomUUID().slice(0, 8)}`;
    const now = Date.now();
    await recordAwakeStretch(env.DB, id, 7_200_000, now); // 2 h awake
    await recordRunExecution(env.DB, id, 1_800_000, now); // 0.5 h box
    const payload = await usagePayload(env.DB, id, usagePeriod(now));
    expect(payload.awakeMs).toBe(7_200_000);
    expect(payload.boxMs).toBe(1_800_000);
    expect(payload.runCount).toBe(1);
    expect(payload.estimatedUsd).toBeCloseTo(
      2 * CF_STANDARD1_ACTIVE_USD_PER_HOUR + 0.5 * BOX_USD_PER_ACTIVE_HOUR,
      9,
    );
  });
});

describe('GET /api/computers/:id/usage (owner-authed)', () => {
  let cookie = '';
  let computerId = '';
  beforeAll(async () => {
    await ensureSchema();
    const s = await seedSession();
    cookie = s.cookie;
    computerId = await createComputer(cookie, 'metered');
  });

  it('answers zeros for a computer nothing has metered yet', async () => {
    const res = await apiGet<UsageBody>(`/api/computers/${computerId}/usage`, cookie);
    expect(res.status).toBe(200);
    expect(res.body.computerId).toBe(computerId);
    expect(res.body.period).toBe(usagePeriod());
    expect(res.body.awakeMs).toBe(0);
    expect(res.body.boxMs).toBe(0);
    expect(res.body.runCount).toBe(0);
    expect(res.body.estimatedUsd).toBe(0);
  });

  it('reflects recorded usage, priced by the constants', async () => {
    await recordAwakeStretch(env.DB, computerId, 3_600_000);
    await recordRunExecution(env.DB, computerId, 60_000);
    const res = await apiGet<UsageBody>(`/api/computers/${computerId}/usage`, cookie);
    expect(res.status).toBe(200);
    expect(res.body.awakeMs).toBe(3_600_000);
    expect(res.body.boxMs).toBe(60_000);
    expect(res.body.runCount).toBe(1);
    expect(res.body.estimatedUsd).toBeCloseTo(
      CF_STANDARD1_ACTIVE_USD_PER_HOUR + (60_000 / 3_600_000) * BOX_USD_PER_ACTIVE_HOUR,
      9,
    );
  });

  it('accepts ?period=YYYY-MM and refuses a malformed one', async () => {
    const past = await apiGet<UsageBody>(
      `/api/computers/${computerId}/usage?period=2026-01`,
      cookie,
    );
    expect(past.status).toBe(200);
    expect(past.body.period).toBe('2026-01');
    expect(past.body.awakeMs).toBe(0);
    const bad = await apiGet<UsageBody>(
      `/api/computers/${computerId}/usage?period=january`,
      cookie,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_period');
  });

  it('requires a session (401), like every /api route', async () => {
    const anon = await SELF.fetch(`${HOST}/api/computers/${computerId}/usage`);
    expect(anon.status).toBe(401);
    const bogus = await apiGet<UsageBody>(
      `/api/computers/${computerId}/usage`,
      'better-auth.session_token=bogus',
    );
    expect(bogus.status).toBe(401);
  });

  it("a stranger gets the same 404 as a computer that doesn't exist", async () => {
    // A second real identity (DEV_AUTH=1 enables email/password in test builds).
    const signup = await SELF.fetch(`${HOST}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: `usage-stranger-${crypto.randomUUID().slice(0, 8)}@mari.test`,
        password: 'stranger-password-123',
        name: 'Usage Stranger',
      }),
    });
    expect(signup.status).toBe(200);
    const stranger = (signup.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(stranger).toMatch(/=/);

    const foreign = await apiGet<UsageBody>(`/api/computers/${computerId}/usage`, stranger);
    expect(foreign.status).toBe(404);
    expect(foreign.body.error).toBe('not_found');

    const missing = await apiGet<UsageBody>(`/api/computers/does-not-exist/usage`, cookie);
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
  });

  it('refuses non-GET methods', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/usage`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(405);
  });
});

describe('usage schema: usage.ts and migration 0003 cannot drift', () => {
  /** Collapse whitespace so formatting is not a difference. */
  const normalize = (s: string): string => s.trim().replace(/\s+/g, ' ').replace(/;$/, '');
  const statementsOf = (sql: string): string[] =>
    sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map(normalize)
      .filter((s) => s.length > 0);

  it('carries byte-for-byte the same statements, in the same order', () => {
    expect(statementsOf(migrationSql)).toEqual(USAGE_SCHEMA_STATEMENTS.map(normalize));
  });

  it('is idempotent — every statement is IF NOT EXISTS', () => {
    for (const statement of USAGE_SCHEMA_STATEMENTS) {
      expect(normalize(statement)).toMatch(/^CREATE (TABLE|INDEX) IF NOT EXISTS /);
    }
  });
});
