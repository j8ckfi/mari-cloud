// Spec 10.3 quotas (src/limits.ts): plan resolution, the D1 usage ledger, the
// route-level gates, and the migration that carries the ledger's DDL to the
// hosted database. Plus the run-lifecycle idempotency/cancellation audit
// (double stop, concurrent create) — the surfaces a client retry hits.
//
// Route-level enforcement is tested through the REAL Hono app with a capped
// Env (the auth-production.test.ts idiom): the suite's global bindings keep
// quotas unlimited (a non-production environment defaults to no ceiling, so
// every other suite is unaffected), and each enforcement test constructs an
// Env override with real caps over the SAME D1/DO/R2 bindings.

import { describe, it, expect, beforeAll } from 'vitest';
import { env, SELF } from 'cloudflare:test';
import migrationSql from '../migrations/0002_limits.sql?raw';
import { createApp } from '../src/app';
import {
  LIMITS_SCHEMA_STATEMENTS,
  HOSTED_MAX_COMPUTERS,
  HOSTED_COMPUTE_HOURS,
  planLimits,
  currentPeriod,
  accumulateUsage,
  usageFor,
  canCreateComputer,
  canWake,
  limitsSummary,
} from '../src/limits';
import type { Env } from '../src/types';
import {
  HOST,
  apiGet,
  apiPost,
  computerStub,
  createComputer,
  ensureSchema,
  seedSession,
  substrateOps,
  FakeSupervisor,
} from './helpers';

/** Build an Env from the suite's real bindings with the vars under test. */
function envWith(vars: Partial<Env>): Env {
  return { ...env, ...vars } as Env;
}

const noopCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

/** Drive the REAL app against an overridden Env (shared D1/DO/R2 bindings). */
async function appFetch(
  vars: Partial<Env>,
  method: string,
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = createApp();
  const res = await app.fetch(
    new Request(`${HOST}${path}`, {
      method,
      headers:
        body === undefined
          ? { Cookie: cookie }
          : { Cookie: cookie, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    envWith(vars),
    noopCtx,
  );
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe('plan resolution (spec 10.3: hosted defaults, private overrides)', () => {
  it('defaults to UNLIMITED off production (dev, tests, private instances)', () => {
    const plan = planLimits(envWith({}));
    expect(plan.maxComputers).toBeNull();
    expect(plan.computeSecondsCap).toBeNull();
  });

  it('defaults to the hosted caps on a production environment', () => {
    const plan = planLimits(envWith({ ENVIRONMENT: 'production' }));
    expect(plan.maxComputers).toBe(HOSTED_MAX_COMPUTERS);
    expect(plan.computeSecondsCap).toBe(HOSTED_COMPUTE_HOURS * 3600);
    // The defaults are the spec'd hosted numbers, not accidents.
    expect(HOSTED_MAX_COMPUTERS).toBe(3);
    expect(HOSTED_COMPUTE_HOURS).toBe(100);
  });

  it('honours explicit values in any environment, hours converted to seconds', () => {
    const plan = planLimits(envWith({ LIMIT_MAX_COMPUTERS: '7', LIMIT_COMPUTE_HOURS: '2.5' }));
    expect(plan.maxComputers).toBe(7);
    expect(plan.computeSecondsCap).toBe(2.5 * 3600);
    // Overrides beat the hosted defaults too.
    const hosted = planLimits(
      envWith({ ENVIRONMENT: 'production', LIMIT_MAX_COMPUTERS: '10', LIMIT_COMPUTE_HOURS: '500' }),
    );
    expect(hosted.maxComputers).toBe(10);
    expect(hosted.computeSecondsCap).toBe(500 * 3600);
  });

  it('<= 0 means explicitly unlimited; garbage falls back to the default', () => {
    const off = planLimits(
      envWith({ ENVIRONMENT: 'production', LIMIT_MAX_COMPUTERS: '0', LIMIT_COMPUTE_HOURS: '-1' }),
    );
    expect(off.maxComputers).toBeNull();
    expect(off.computeSecondsCap).toBeNull();
    // A typo must not silently mean "no limit" on a hosted instance.
    const typo = planLimits(
      envWith({
        ENVIRONMENT: 'production',
        LIMIT_MAX_COMPUTERS: 'three',
        LIMIT_COMPUTE_HOURS: 'lots',
      }),
    );
    expect(typo.maxComputers).toBe(HOSTED_MAX_COMPUTERS);
    expect(typo.computeSecondsCap).toBe(HOSTED_COMPUTE_HOURS * 3600);
  });
});

describe('migration 0002 cannot drift from limits.ts (the 0001/apply.ts rule)', () => {
  const normalize = (s: string) => s.trim().replace(/\s+/g, ' ').replace(/;$/, '');
  const statementsOf = (sql: string) =>
    sql
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map(normalize)
      .filter((s) => s.length > 0);

  it('carries byte-for-byte the same statements, in the same order', () => {
    expect(statementsOf(migrationSql)).toEqual(LIMITS_SCHEMA_STATEMENTS.map(normalize));
    expect(LIMITS_SCHEMA_STATEMENTS.length).toBe(1);
  });

  it('is idempotent — IF NOT EXISTS, safe against a lazily-created table', () => {
    for (const s of LIMITS_SCHEMA_STATEMENTS) {
      expect(normalize(s)).toMatch(/^CREATE TABLE IF NOT EXISTS /);
    }
  });
});

describe('the usage ledger (usage_period)', () => {
  it('upsert-accumulates within a period, keyed per user per UTC month', async () => {
    const u = `ledger-${crypto.randomUUID()}`;
    expect(await usageFor(env.DB, u)).toEqual({ awakeMs: 0, boxMs: 0 });

    await accumulateUsage(env.DB, u, { awakeMs: 1500 });
    await accumulateUsage(env.DB, u, { awakeMs: 500, boxMs: 4000 });
    expect(await usageFor(env.DB, u)).toEqual({ awakeMs: 2000, boxMs: 4000 });

    // Another user's ledger is untouched.
    expect(await usageFor(env.DB, `${u}-other`)).toEqual({ awakeMs: 0, boxMs: 0 });
  });

  it('a new month is a new row: the cap resets on the period boundary', async () => {
    const u = `period-${crypto.randomUUID()}`;
    const january = Date.UTC(2026, 0, 15);
    const february = Date.UTC(2026, 1, 15);
    expect(currentPeriod(january)).toBe('2026-01');
    expect(currentPeriod(february)).toBe('2026-02');

    await accumulateUsage(env.DB, u, { awakeMs: 9000 }, january);
    await accumulateUsage(env.DB, u, { awakeMs: 100 }, february);
    expect((await usageFor(env.DB, u, '2026-01')).awakeMs).toBe(9000);
    expect((await usageFor(env.DB, u, '2026-02')).awakeMs).toBe(100);
  });

  it('refuses to shrink: negative deltas are clamped to zero', async () => {
    const u = `clamp-${crypto.randomUUID()}`;
    await accumulateUsage(env.DB, u, { awakeMs: 700 });
    await accumulateUsage(env.DB, u, { awakeMs: -700, boxMs: -1 });
    expect((await usageFor(env.DB, u)).awakeMs).toBe(700);
  });
});

describe('route enforcement (spec 10.3 gates in app.ts)', () => {
  let cookie = '';
  let userId = '';
  let seededId = '';

  beforeAll(async () => {
    await ensureSchema();
    const res = await SELF.fetch(`${HOST}/api/dev/seed`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string } };
    userId = body.user.id;
    const s = await seedSession();
    cookie = s.cookie;
    seededId = s.computerId;
  });

  it('POST /api/computers answers 403 limit_computers at the cap, 201 under it', async () => {
    // The seed owns 2 computers. Cap 2: full.
    const refused = await appFetch({ LIMIT_MAX_COMPUTERS: '2' }, 'POST', '/api/computers', cookie, {
      name: 'one-too-many',
    });
    expect(refused.status).toBe(403);
    expect(refused.body['error']).toBe('limit_computers');
    expect(refused.body['computers']).toBe(2);
    expect(refused.body['maxComputers']).toBe(2);
    // Nothing was created.
    const fleet = await apiGet<{ computers: unknown[] }>('/api/computers', cookie);
    expect(fleet.body.computers.length).toBe(2);

    // Cap 3: one slot free — create succeeds and FILLS the cap.
    const ok = await appFetch({ LIMIT_MAX_COMPUTERS: '3' }, 'POST', '/api/computers', cookie, {
      name: 'third',
    });
    expect(ok.status).toBe(201);
    const again = await appFetch({ LIMIT_MAX_COMPUTERS: '3' }, 'POST', '/api/computers', cookie, {
      name: 'fourth',
    });
    expect(again.status).toBe(403);
  });

  it('fork passes the same computer-count gate', async () => {
    const refused = await appFetch(
      { LIMIT_MAX_COMPUTERS: '1' },
      'POST',
      `/api/computers/${seededId}/fork`,
      cookie,
      {},
    );
    expect(refused.status).toBe(403);
    expect(refused.body['error']).toBe('limit_computers');
  });

  it('wake/run/write answer 403 limit_compute once the month is spent, and the DO is never addressed', async () => {
    const id = await createComputer(cookie, 'metered');
    const before = await substrateOps(computerStub(id));

    // Spend the whole month: cap 1 compute-hour, ledger already holds 2 h.
    await accumulateUsage(env.DB, userId, { awakeMs: 2 * 3600 * 1000 });
    const capped = { LIMIT_COMPUTE_HOURS: '1' };

    const wake = await appFetch(capped, 'POST', `/api/computers/${id}/wake`, cookie);
    expect(wake.status).toBe(403);
    expect(wake.body['error']).toBe('limit_compute');
    expect(Number(wake.body['usedMs'])).toBeGreaterThanOrEqual(3600 * 1000);
    expect(wake.body['capMs']).toBe(3600 * 1000);

    const run = await appFetch(capped, 'POST', `/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/true'],
    });
    expect(run.status).toBe(403);
    expect(run.body['error']).toBe('limit_compute');

    const write = await appFetch(capped, 'PUT', `/api/computers/${id}/file?path=/x.txt`, cookie, {});
    expect(write.status).toBe(403);
    const upload = await appFetch(capped, 'POST', `/api/computers/${id}/upload?path=/x.bin`, cookie, {});
    expect(upload.status).toBe(403);

    // The refusals cost no substrate call, enqueued nothing, woke nothing.
    expect(await substrateOps(computerStub(id))).toEqual(before);
    expect(await computerStub(id).getState()).toBe('cold');
    const runs = await apiGet<{ runs: unknown[] }>(`/api/computers/${id}/runs`, cookie);
    expect(runs.body.runs).toEqual([]);

    // Under the cap the same routes work: cap 10 h against the 2 h spent.
    const allowed = await appFetch(
      { LIMIT_COMPUTE_HOURS: '10' },
      'POST',
      `/api/computers/${id}/runs`,
      cookie,
      { argv: ['/bin/true'] },
    );
    expect(allowed.status).toBe(200);
    expect(typeof allowed.body['runId']).toBe('string');
  });

  it('GET /api/me/limits reports caps, spend and computer count', async () => {
    // Through the suite's own (unlimited) bindings: caps are null, usage real.
    const open = await apiGet<{
      computeSecondsCap: number | null;
      computeSecondsUsed: number;
      maxComputers: number | null;
      computers: number;
      period: string;
    }>('/api/me/limits', cookie);
    expect(open.status).toBe(200);
    expect(open.body.computeSecondsCap).toBeNull();
    expect(open.body.maxComputers).toBeNull();
    expect(open.body.computers).toBeGreaterThanOrEqual(2);
    expect(open.body.period).toBe(currentPeriod());
    // The 2 h the previous test accumulated is visible spend.
    expect(open.body.computeSecondsUsed).toBeGreaterThanOrEqual(2 * 3600);

    // Through a capped Env the caps are numbers the web app can render.
    const capped = await appFetch(
      { LIMIT_MAX_COMPUTERS: '3', LIMIT_COMPUTE_HOURS: '100' },
      'GET',
      '/api/me/limits',
      cookie,
    );
    expect(capped.status).toBe(200);
    expect(capped.body['maxComputers']).toBe(3);
    expect(capped.body['computeSecondsCap']).toBe(100 * 3600);
  });

  it('check functions answer the exact refusal the routes serve', async () => {
    const u = `pure-${crypto.randomUUID()}`;
    await accumulateUsage(env.DB, u, { awakeMs: 3_600_000 });
    const wake = await canWake(env.DB, envWith({ LIMIT_COMPUTE_HOURS: '1' }), u);
    expect(wake).toEqual({ ok: false, reason: 'limit_compute', usedMs: 3_600_000, capMs: 3_600_000 });
    expect(await canWake(env.DB, envWith({ LIMIT_COMPUTE_HOURS: '2' }), u)).toEqual({ ok: true });

    const create = await canCreateComputer(env.DB, envWith({ LIMIT_MAX_COMPUTERS: '1' }), userId);
    expect(create.ok).toBe(false);
    const summary = await limitsSummary(env.DB, envWith({ LIMIT_COMPUTE_HOURS: '1' }), u);
    expect(summary.computeSecondsUsed).toBe(3600);
    expect(summary.computeSecondsCap).toBe(3600);
  });
});

describe('run lifecycle idempotency (double stop, concurrent create)', () => {
  let cookie = '';
  beforeAll(async () => {
    await ensureSchema();
    cookie = (await seedSession()).cookie;
  });

  it('a second stop of a cancelled-before-start run is a harmless 200, still cancelled', async () => {
    const id = await createComputer(cookie, 'double-stop-queued');
    const started = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sleep', '30'],
    });
    const runId = started.body.runId;

    const first = await apiPost<{ status: string; cancelled: boolean }>(
      `/api/computers/${id}/runs/${runId}/stop`,
      cookie,
    );
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('cancelled');
    expect(first.body.cancelled).toBe(true);

    // The retry a client fires on a slow first answer: same verdict, no new
    // state, no resurrection of the run.
    const second = await apiPost<{ status: string; cancelled: boolean; sent: boolean }>(
      `/api/computers/${id}/runs/${runId}/stop`,
      cookie,
    );
    expect(second.status).toBe(200);
    expect(second.body.status).toBe('cancelled');
    expect(second.body.sent).toBe(false);

    const detail = await apiGet<{ status: string }>(`/api/computers/${id}/runs/${runId}`, cookie);
    expect(detail.body.status).toBe('cancelled');
  });

  it('a double stop of a LIVE run stays in stopping; the run row is not duplicated or corrupted', async () => {
    const id = await createComputer(cookie, 'double-stop-live');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const started = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sleep', '30'],
    });
    await sup.recv.waitForTag('start_run');
    sup.runStarted(started.body.runId, 'a'.repeat(64));

    const [a, b] = await Promise.all([
      apiPost<{ status: string }>(`/api/computers/${id}/runs/${started.body.runId}/stop`, cookie),
      apiPost<{ status: string }>(`/api/computers/${id}/runs/${started.body.runId}/stop`, cookie),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.status).toBe('stopping');
    expect(b.body.status).toBe('stopping');
    await sup.recv.waitForTag('stop_run');

    const runs = await apiGet<{ runs: { id: string; status: string }[] }>(
      `/api/computers/${id}/runs`,
      cookie,
    );
    const rows = runs.body.runs.filter((r) => r.id === started.body.runId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.status).toBe('stopping');
    sup.close();
  });

  it('two concurrent run creations both exist and share ONE wake (one materialize)', async () => {
    const id = await createComputer(cookie, 'concurrent-create');
    const [a, b] = await Promise.all([
      apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, { argv: ['/bin/true'] }),
      apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, { argv: ['/bin/false'] }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.runId).not.toBe(b.body.runId);

    const runs = await apiGet<{ runs: { id: string }[] }>(`/api/computers/${id}/runs`, cookie);
    const ids = runs.body.runs.map((r) => r.id);
    expect(ids).toContain(a.body.runId);
    expect(ids).toContain(b.body.runId);

    // The two background wakes collapsed into one materialization (spec 4.1:
    // one writable copy — the DO's #wakeInFlight).
    const ops = (await substrateOps(computerStub(id))).filter((o) => o === 'materialize');
    expect(ops.length).toBe(1);
  });
});
