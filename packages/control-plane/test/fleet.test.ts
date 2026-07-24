// Fleet home (spec 8.2): "For each computer: the state, the active runs, the
// waiting attention events, the changed files, and the cost meter. After an
// absence, this view is the summary of the results."
//
// Every field below is asserted against SEEDED, known data — a card whose
// numbers are hard-coded zeros would fail here. The whole view must also render
// without waking anything (spec 8.3), which the substrate call log proves.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  apiGet,
  apiPost,
  computerStub,
  createComputer,
  ensureSchema,
  FakeSupervisor,
  seedSession,
  substrateOps,
  waitUntil,
} from './helpers';
import { SUBSTRATE_PRICE_PER_HOUR, costMeter, ratePerHour } from '../src/pricing';

interface FleetComputer {
  id: string;
  hostname: string;
  state: string;
  activeRuns: number;
  activeRunIds: string[];
  attention: number;
  changedFiles: number;
  cost: {
    currency: string;
    accrued: number;
    ratePerHour: number;
    window: string;
    awakeSeconds: number;
  };
  manifestHead: string | null;
  updatedAt: number;
}

async function fleet(cookie: string): Promise<FleetComputer[]> {
  const res = await apiGet<{ computers: FleetComputer[] }>('/api/fleet', cookie);
  expect(res.status).toBe(200);
  return res.body.computers;
}

describe('fleet view (spec 8.2)', () => {
  let cookie = '';
  let seededId = '';
  let seededManifest = '';
  beforeAll(async () => {
    await ensureSchema();
    const s = await seedSession();
    cookie = s.cookie;
    seededId = s.computerId;
    seededManifest = s.manifest;
  });

  it('renders a COLD computer completely, with no wake', async () => {
    const card = (await fleet(cookie)).find((c) => c.id === seededId);
    expect(card).toBeTruthy();
    expect(card!.hostname).toBe('Seed Computer');
    expect(card!.state).toBe('cold');
    expect(card!.manifestHead).toBe(seededManifest);
    expect(card!.activeRuns).toBe(0);
    expect(card!.activeRunIds).toEqual([]);
    expect(card!.attention).toBe(0);
    // No previous head yet, so nothing has "changed" against it.
    expect(card!.changedFiles).toBe(0);
    // A COLD computer burns nothing and has accrued nothing.
    expect(card!.cost.currency).toBe('USD');
    expect(card!.cost.ratePerHour).toBe(0);
    expect(card!.cost.accrued).toBe(0);
    expect(card!.cost.awakeSeconds).toBe(0);

    expect(await computerStub(seededId).getState()).toBe('cold');
    expect((await substrateOps(computerStub(seededId))).filter((o) => o === 'materialize')).toEqual(
      [],
    );
  });

  it('counts active runs, attention, changed files, and accrues cost while AWAKE', async () => {
    const id = await createComputer(cookie, 'busy');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    // Two heads: the fleet card diffs the CURRENT head against the PREVIOUS one.
    // (Seeded trees; `/b.txt` added and `/a.txt` modified between them.)
    const { writeManifestTree } = await import('./helpers');
    const first = await writeManifestTree({ '/a.txt': 'one', '/keep.txt': 'same' });
    const second = await writeManifestTree({
      '/a.txt': 'one-changed-and-longer',
      '/keep.txt': 'same',
      '/b.txt': 'brand new',
    });

    sup.headAdvance(first, w.epoch);
    expect((await sup.recv.waitForTag('head_advance_result')).c.accepted).toBe(true);
    sup.headAdvance(second, w.epoch);
    expect((await sup.recv.waitForTag('head_advance_result')).c.accepted).toBe(true);
    expect(await stub.getHead()).toBe(second);

    // Two waiting attention events and one live run.
    sup.attention('run-1', 'bell');
    sup.attention('run-1', 'blocked_read');
    const started = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sleep', '30'],
    });
    await sup.recv.waitForTag('start_run');
    sup.runStarted(started.body.runId, first);

    await waitUntil(
      async () => {
        const card = (await fleet(cookie)).find((c) => c.id === id);
        return card !== undefined && card.attention === 2 && card.activeRuns === 1;
      },
      3000,
      'fleet counters',
    );

    const card = (await fleet(cookie)).find((c) => c.id === id)!;
    expect(card.state).toBe('awake');
    expect(card.manifestHead).toBe(second);
    expect(card.activeRuns).toBe(1);
    expect(card.activeRunIds).toEqual([started.body.runId]);
    expect(card.attention).toBe(2);
    // `/a.txt` modified + `/b.txt` added = 2 changed entries between the heads.
    expect(card.changedFiles).toBe(2);

    // Cost: AWAKE seconds x the substrate price sheet (internal accounting).
    const rate = SUBSTRATE_PRICE_PER_HOUR['fake']!;
    expect(card.cost.ratePerHour).toBe(rate);
    expect(card.cost.awakeSeconds).toBeGreaterThan(0);
    expect(Math.abs(card.cost.accrued - (card.cost.awakeSeconds / 3600) * rate)).toBeLessThan(1e-6);
    const accruedWhileAwake = card.cost.accrued;
    expect(accruedWhileAwake).toBeGreaterThan(0);

    // The card timestamps the last state/head change, not the creation time.
    expect(card.updatedAt).toBeGreaterThan(0);
    const stampWhileAwake = card.updatedAt;

    // Sleeping stops the burn but keeps the accrual (spec §2: WARM is near zero).
    await stub.sleepNow();
    const warmCard = (await fleet(cookie)).find((c) => c.id === id)!;
    expect(warmCard.state).toBe('warm');
    expect(warmCard.updatedAt).toBeGreaterThanOrEqual(stampWhileAwake);
    expect(warmCard.cost.ratePerHour).toBe(0);
    expect(warmCard.cost.accrued).toBeGreaterThanOrEqual(accruedWhileAwake);

    // The accrual is now frozen: two reads a moment apart agree.
    const a = (await fleet(cookie)).find((c) => c.id === id)!.cost.awakeSeconds;
    await new Promise((r) => setTimeout(r, 40));
    const b = (await fleet(cookie)).find((c) => c.id === id)!.cost.awakeSeconds;
    expect(b).toBe(a);

    sup.close();
  });

  it('prices each substrate from the static sheet', () => {
    expect(ratePerHour('docker')).toBe(0);
    expect(ratePerHour('sprites')).toBeGreaterThan(0);
    // An unknown substrate still accounts for something rather than silently 0.
    expect(ratePerHour('brand-new-cloud')).toBeGreaterThan(0);

    const meter = costMeter('sprites', 3600, 'awake');
    expect(meter.accrued).toBe(SUBSTRATE_PRICE_PER_HOUR['sprites']);
    expect(meter.ratePerHour).toBe(SUBSTRATE_PRICE_PER_HOUR['sprites']);

    const cold = costMeter('sprites', 3600, 'cold');
    expect(cold.accrued).toBe(SUBSTRATE_PRICE_PER_HOUR['sprites']);
    expect(cold.ratePerHour).toBe(0);
  });

  it('the computer detail carries the same summary plus its runs', async () => {
    const detail = await apiGet<{
      id: string;
      state: string;
      activeRuns: number;
      changedFiles: number;
      cost: { currency: string };
      runs: { id: string }[];
      manifestHead: string | null;
    }>(`/api/computers/${seededId}`, cookie);
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(seededId);
    expect(detail.body.state).toBe('cold');
    expect(detail.body.manifestHead).toBe(seededManifest);
    expect(detail.body.activeRuns).toBe(0);
    expect(detail.body.changedFiles).toBe(0);
    expect(detail.body.cost.currency).toBe('USD');
    expect(detail.body.runs).toEqual([]);
  });

  it('shows only the caller’s own computers', async () => {
    const cards = await fleet(cookie);
    expect(cards.length).toBeGreaterThan(0);
    const res = await apiGet('/api/fleet', 'better-auth.session_token=bogus');
    expect(res.status).toBe(401);
  });
});
