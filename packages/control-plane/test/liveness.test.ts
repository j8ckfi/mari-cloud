// SUBSTRATE DEATH: the wedge, and every sibling of it.
//
// THE DEFECT THIS SUITE EXISTS FOR, reproduced by hand against a private
// instance on the Docker substrate:
//
//   1. computer AWAKE, a real container, a run that completed exit 0;
//   2. `docker rm -f` that container (on Cloudflare an eviction, and disk is
//      wiped on every stop — this is not exotic);
//   3. `POST /api/computers/:id/runs` -> 200, run queued, state "awake",
//      activeRuns 1 — and NOTHING happened. No container was re-materialized.
//      The run stayed pending indefinitely.
//   4. `POST /api/computers/:id/wake` -> 200 {"state":"awake","epoch":1} and did
//      nothing, because the DO believed it was already awake.
//
// Every primitive needed to recover already existed (snapshot, epoch fencing,
// restore, adapter resume). The TRIGGER did not. The bug class is "a state that
// cannot advance without an external event", so this suite hunts the whole class:
// the eviction itself, a WAKING that never completes, a materialize that hangs,
// a COLD handshake whose final snapshot never arrives, a run handed to a
// supervisor that died before acking it, and the tier alarm firing against a
// substrate that is already gone.
//
// Everything here is real: a real ComputerDO with real DO/D1/R2 bindings, real
// supervisor WebSockets speaking framed CBOR, real alarms, and byte-level journal
// assertions. The only fake is the substrate driver itself (decisions.md), and
// `FakeSubstrate.evict()` is `docker rm -f` — the driver then answers `gone` and
// refuses every operation, exactly as a daemon does for a container that is not
// there. The same repro runs against REAL Docker in
// `test/node/substrate-death.e2e.test.ts` (MARI_NODE_E2E=1).

import { describe, it, expect, beforeAll } from 'vitest';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  apiGet,
  apiPost,
  createComputer,
  computerStub,
  delay,
  ensureSchema,
  eqBytes,
  FakeSupervisor,
  seedSession,
  waitUntil,
} from './helpers';
import type { ComputerDO, Incident } from '../src/computer-do';
import type { FakeSubstrate } from '../src/substrate';

type Stub = ReturnType<typeof computerStub>;

/** Reach the DO's injected fake driver and do something with it. */
function withFake<T>(stub: Stub, fn: (fake: FakeSubstrate, instance: ComputerDO) => T): Promise<T> {
  return runInDurableObject(stub, (instance: ComputerDO) =>
    fn(instance.substrate as unknown as FakeSubstrate, instance),
  );
}

/** The driver call log (spec §3.5 operations only — probes are reads). */
function ops(stub: Stub): Promise<string[]> {
  return withFake(stub, (fake) => fake.calls.map((c) => c.op));
}

/** The persisted meta, read the way a restarted object would (test-only reach). */
function metaOf(stub: Stub): Promise<Record<string, unknown>> {
  return runInDurableObject(stub, async (instance: ComputerDO) => {
    const meta = await (
      instance as unknown as { ctx: DurableObjectState }
    ).ctx.storage.get<Record<string, unknown>>('meta');
    return meta ?? {};
  });
}

/**
 * The epoch + one-time token of the LAST materialize, read out of the driver's
 * recorded spec — which is exactly how a real supervisor receives them (the token
 * never crosses the REST boundary, contracts.md §6).
 */
async function generationOf(stub: Stub): Promise<{ epoch: number; token: string }> {
  const spec = await withFake(stub, (fake) => {
    const last = fake.specs.at(-1);
    return last ? { ...last.env } : null;
  });
  if (!spec) throw new Error('materialize was never called');
  return { epoch: Number(spec['MARI_EPOCH']), token: String(spec['MARI_TOKEN']) };
}

/** Wake through the DO, then connect a supervisor for that generation. */
async function wakeAndConnect(
  stub: Stub,
  id: string,
): Promise<{ sup: FakeSupervisor; epoch: number; token: string }> {
  const w = await stub.wake(id);
  expect(w.ok, `wake ${id}: ${w.error ?? ''}`).toBe(true);
  const sup = await FakeSupervisor.connect(id);
  await sup.handshake(id, w.epoch, w.token);
  return { sup, epoch: w.epoch, token: w.token };
}

/** `docker rm -f`, in one call: the instance is gone and the socket dies with it. */
async function evict(stub: Stub, sup: FakeSupervisor | null): Promise<number> {
  const n = await withFake(stub, (fake) => fake.evictAll());
  sup?.close();
  return n;
}

/** Wait until the supervisor-loss grace deadline is armed (the close handler runs
 *  in a `waitUntil`, so it is observable but not synchronous). */
async function waitForGrace(stub: Stub): Promise<void> {
  await waitUntil(
    async () => {
      const meta = await metaOf(stub);
      return meta['livenessAt'] !== null && meta['supervisorLostAt'] !== null;
    },
    2000,
    'the supervisor-loss grace deadline to be armed',
  );
}

function kinds(incidents: Incident[]): string[] {
  return incidents.map((i) => i.kind);
}

interface RunBody {
  id: string;
  state: string;
  status: string;
  dispatched: boolean;
  exitCode: number | null;
  journalLength: number;
  journalTail: string;
  epoch: number;
}

const M = (c: string): string => c.repeat(64);

describe('substrate death: liveness and recovery', () => {
  beforeAll(ensureSchema);

  it('THE REPRO: an evicted container recovers to a fresh instance with a NEW epoch, and the queued run runs', async () => {
    const { cookie } = await seedSession();
    const id = await createComputer(cookie, 'evicted');
    const stub = computerStub(id);

    // ---- generation 1: a real run that completed, exit 0 ------------------
    const gen1 = await wakeAndConnect(stub, id);
    const first = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/echo', 'before'],
    });
    expect(first.status).toBe(200);
    const runBefore = first.body.runId;
    const dispatched1 = await gen1.sup.recv.waitForTag('start_run');
    expect(dispatched1.c.run).toBe(runBefore);

    const OUT = new TextEncoder().encode('before the eviction\r\n');
    gen1.sup.runStarted(runBefore, M('1'));
    gen1.sup.journalFrame(runBefore, 0, OUT);
    await gen1.sup.recv.waitForTag('journal_ack');
    gen1.sup.headAdvance(M('2'), gen1.epoch);
    expect((await gen1.sup.recv.waitForTag('head_advance_result')).c.accepted).toBe(true);
    gen1.sup.runCompleted(runBefore, M('2'));
    await waitUntil(
      async () => (await stub.runDetail(runBefore))?.status === 'completed',
      2000,
      'the first run to complete',
    );
    const headBefore = await stub.getHead();
    expect(headBefore).toBe(M('2'));

    // ---- the eviction: the container is removed, nobody is told -----------
    expect(await evict(stub, gen1.sup)).toBe(1);
    await waitForGrace(stub);

    // Step 3 of the repro: a run is requested. It is accepted and queued...
    const second = await apiPost<{ runId: string; computerState: string; queued: boolean }>(
      `/api/computers/${id}/runs`,
      cookie,
      { argv: ['/bin/echo', 'after'] },
    );
    expect(second.status).toBe(200);
    const runAfter = second.body.runId;
    expect(second.body.queued).toBe(true);

    // ...and the liveness deadline is what makes it happen: the grace window
    // passes with no supervisor back, the substrate is asked, and it says the
    // instance is gone.
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    await waitUntil(
      async () => (await withFake(stub, (f) => f.specs.length)) === 2,
      3000,
      'a FRESH instance to be materialized',
    );

    // The dead instance was destroyed, and a new one materialized: the fleet is
    // not left paying for a machine nobody can reach.
    expect(await ops(stub)).toEqual(['materialize', 'destroy', 'materialize']);
    // The substrate really was ASKED (provider.ts's liveness capability), not
    // guessed at.
    expect(await withFake(stub, (f) => f.probes.map((p) => p.status))).toEqual(['gone']);

    // A NEW epoch: the dead generation can never advance anything (spec 4.1).
    const gen2 = await generationOf(stub);
    expect(gen2.epoch).toBe(gen1.epoch + 1);
    expect(gen2.token).not.toBe(gen1.token);

    // The head is EXACTLY where the last snapshot left it. Recovery restores
    // from the head; it never invents or loses one.
    expect(await stub.getHead()).toBe(headBefore);

    // The recovery is recorded, content-free.
    const incidents = await stub.listIncidents();
    expect(kinds(incidents)).toContain('substrate_lost');
    expect(Object.keys(incidents[0] ?? {}).sort()).toEqual(['at', 'epoch', 'id', 'kind']);

    // ---- generation 2 takes the queued run -------------------------------
    const sup2 = await FakeSupervisor.connect(id);
    await sup2.handshake(id, gen2.epoch, gen2.token);
    const dispatched2 = await sup2.recv.waitForTag('start_run');
    expect(dispatched2.c.run).toBe(runAfter);
    // Exactly once, and only the run that had not run: the completed one is not
    // re-dispatched.
    expect(sup2.recv.all.filter((m) => m.t === 'start_run')).toHaveLength(1);

    const OUT2 = new TextEncoder().encode('after the eviction\r\n');
    sup2.runStarted(runAfter, M('2'));
    sup2.journalFrame(runAfter, 0, OUT2);
    await sup2.recv.waitForTag('journal_ack');
    sup2.runCompleted(runAfter, M('3'));
    await waitUntil(
      async () => (await stub.runDetail(runAfter))?.status === 'completed',
      2000,
      'the recovered run to complete',
    );

    // ---- the journal has no gap and no duplicate -------------------------
    const before = new Uint8Array(await stub.readJournal(runBefore));
    const after = new Uint8Array(await stub.readJournal(runAfter));
    expect(eqBytes(before, OUT)).toBe(true);
    expect(eqBytes(after, OUT2)).toBe(true);
    // The DO's own ingest ledger: no duplicate, no divergence, no hole (a gap is
    // recorded rather than absorbed, so an empty ledger is a real assertion).
    expect(await stub.journalAnomalies()).toEqual([]);

    // ---- the dead generation is fenced out -------------------------------
    // A head advance carrying epoch 1 is refused with the DO's authoritative
    // epoch, and the head does not move (contracts.md §6).
    sup2.headAdvance(M('9'), gen1.epoch);
    const refused = await sup2.recv.waitForTag('head_advance_result');
    expect(refused.c).toMatchObject({ accepted: false, current_epoch: gen2.epoch });
    // Still generation 1's last accepted advance: neither the recovery nor the
    // fenced-out write moved it.
    expect(await stub.getHead()).toBe(headBefore);

    // And a supervisor that comes back with the DEAD generation's credentials
    // cannot even handshake, so it can never write the journal either.
    const zombie = await FakeSupervisor.connect(id);
    zombie.send({
      t: 'hello',
      c: { computer: id, epoch: gen1.epoch, token: gen1.token, proto_version: 1 },
    });
    await expect(zombie.recv.waitForTag('hello_ack', 300)).rejects.toThrow(/timeout/);
    zombie.close();

    // The REST surface tells the same story the wire does.
    const detail = await apiGet<{ state: string; activeRuns: number }>(
      `/api/computers/${id}`,
      cookie,
    );
    expect(detail.body.state).toBe('awake');
    expect(detail.body.activeRuns).toBe(0);
    const listed = await apiGet<{ runs: RunBody[] }>(`/api/computers/${id}/runs`, cookie);
    const byId = new Map(listed.body.runs.map((r) => [r.id, r]));
    expect(byId.get(runBefore)?.state).toBe('exited');
    expect(byId.get(runAfter)?.state).toBe('exited');
    expect(byId.get(runAfter)?.epoch).toBe(gen2.epoch);
    // Both runs ran under the generation that owned them; the recovery did not
    // rewrite history.
    expect(byId.get(runBefore)?.epoch).toBe(gen1.epoch);

    sup2.close();
  });

  it('POST /wake on an AWAKE computer whose instance is gone recovers instead of answering "already awake"', async () => {
    const { cookie } = await seedSession();
    const id = await createComputer(cookie, 'wake-honest');
    const stub = computerStub(id);
    const gen1 = await wakeAndConnect(stub, id);

    // No runs at all here: this is step 4 of the repro in isolation.
    await evict(stub, gen1.sup);
    // Past the grace window, so a blip is not being confused with a death. The
    // DO's own clock is what decides; the wake below is the only trigger.
    await waitUntil(
      async () => Date.now() - Number((await metaOf(stub))['generationAt'] ?? 0) > 450,
      2000,
      'the grace window to pass',
    );

    const res = await apiPost<{ state: string; epoch: number }>(
      `/api/computers/${id}/wake`,
      cookie,
    );
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('awake');
    // The old answer was `epoch: 1` and no materialize. Now: a fresh instance
    // under a new epoch.
    expect(res.body.epoch).toBe(gen1.epoch + 1);
    expect(await withFake(stub, (f) => f.specs.length)).toBe(2);
    expect(await ops(stub)).toEqual(['materialize', 'destroy', 'materialize']);
    expect(kinds(await stub.listIncidents())).toContain('substrate_lost');
  });

  it('an interrupted run keeps its journal and raises exactly ONE content-free attention event', async () => {
    const { cookie } = await seedSession();
    const id = await createComputer(cookie, 'interrupted');
    const stub = computerStub(id);
    const gen1 = await wakeAndConnect(stub, id);

    const created = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sh', '-c', 'long running agent'],
    });
    const runId = created.body.runId;
    await gen1.sup.recv.waitForTag('start_run');
    const PARTIAL = new TextEncoder().encode('agent: working...\r\n');
    gen1.sup.runStarted(runId, M('a'));
    gen1.sup.journalFrame(runId, 0, PARTIAL);
    await gen1.sup.recv.waitForTag('journal_ack');

    // The machine dies mid-run.
    await evict(stub, gen1.sup);
    await waitForGrace(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await waitUntil(
      async () => (await stub.runDetail(runId))?.status === 'interrupted',
      3000,
      'the in-flight run to be interrupted',
    );

    // No completion is fabricated — the run did not complete (spec 5.6).
    const detail = await stub.runDetail(runId);
    expect(detail?.status).toBe('interrupted');
    expect(detail?.exit).toBeNull();
    // The journal is preserved EXACTLY: the control plane's copy is the truth
    // (spec 4.2) and an interruption does not edit history.
    expect(eqBytes(new Uint8Array(await stub.readJournal(runId)), PARTIAL)).toBe(true);
    expect(await stub.journalAnomalies()).toEqual([]);

    // Exactly one attention event, content-free (spec 6.2/6.3).
    const attention = await stub.listAttentionEvents();
    expect(attention).toHaveLength(1);
    expect(attention[0]?.kind).toBe('interrupted');
    expect(attention[0]?.run).toBe(runId);
    expect(Object.keys(attention[0] ?? {}).sort()).toEqual(
      ['at', 'dismissed', 'id', 'kind', 'run'].sort(),
    );

    // marid raises the SAME event when it restarts and finds the run unfinished
    // (decisions.md appendix). One interruption, one badge — not two.
    const gen2 = await generationOf(stub);
    const sup2 = await FakeSupervisor.connect(id);
    await sup2.handshake(id, gen2.epoch, gen2.token);
    sup2.send({ t: 'attention', c: { run: runId, kind: 'interrupted' } });
    await delay(60);
    expect(await stub.listAttentionEvents()).toHaveLength(1);

    // The fleet no longer counts it as active — an interrupted run is over.
    const fleet = await apiGet<{ computers: { id: string; activeRuns: number }[] }>(
      '/api/fleet',
      cookie,
    );
    expect(fleet.body.computers.find((c) => c.id === id)?.activeRuns).toBe(0);

    // A resume (marid's agent adapter, same run id) puts it back to running:
    // `interrupted` is not a terminal lie about the run's identity.
    sup2.runStarted(runId, M('a'));
    await waitUntil(
      async () => (await stub.runDetail(runId))?.status === 'running',
      2000,
      'the resumed run to be running again',
    );
    sup2.close();
  });

  it('a run dispatched to a supervisor that dies before acking it is re-queued and runs exactly once', async () => {
    const { cookie } = await seedSession();
    const id = await createComputer(cookie, 'never-acked');
    const stub = computerStub(id);
    const gen1 = await wakeAndConnect(stub, id);

    const created = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/echo', 'never acked'],
    });
    const runId = created.body.runId;
    // The frame goes out and the dispatch latch is written...
    await gen1.sup.recv.waitForTag('start_run');
    expect((await stub.runDetail(runId))?.dispatched).toBe(true);
    // ...and then the machine dies before the supervisor ever says `run_started`.
    // Nothing was written: no journal byte, no pre-run manifest.
    expect((await stub.runDetail(runId))?.journalLength).toBe(0);

    await evict(stub, gen1.sup);
    await waitForGrace(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // The latch is RELEASED, because the run provably never began — the same rule
    // marid uses for a replay after a rollback. Before this it stayed
    // `dispatched = 1` forever and no supervisor was ever handed it again.
    await waitUntil(
      async () => (await stub.runDetail(runId))?.status === 'queued',
      3000,
      'the never-started run to be re-queued',
    );
    const requeued = await stub.runDetail(runId);
    expect(requeued?.dispatched).toBe(false);
    // Not interrupted: an interruption would mean it ran, and it did not.
    expect(await stub.listAttentionEvents()).toEqual([]);

    const gen2 = await generationOf(stub);
    const sup2 = await FakeSupervisor.connect(id);
    await sup2.handshake(id, gen2.epoch, gen2.token);
    const start = await sup2.recv.waitForTag('start_run');
    expect(start.c.run).toBe(runId);
    // EXACTLY once in the new generation: the latch still prevents duplication.
    await delay(60);
    expect(sup2.recv.all.filter((m) => m.t === 'start_run')).toHaveLength(1);

    sup2.runStarted(runId, M('b'));
    sup2.runCompleted(runId, M('c'));
    await waitUntil(
      async () => (await stub.runDetail(runId))?.status === 'completed',
      2000,
      'the re-queued run to complete',
    );
    sup2.close();
  });

  it('a run whose machine dies every time it is dispatched is re-queued ONCE, then interrupted', async () => {
    // The poison run. Re-queueing a run that provably never began is right — but
    // that run may be WHY the machine died (the Cloudflare e2e tears its microVM
    // down from inside a run), and a control plane that keeps handing it a fresh
    // instance would spend the account's capacity in a loop. One retry, then the
    // same honest degradation: recorded, notified once, never silently dropped.
    const id = 'poison-run';
    const stub = computerStub(id);
    const runId = 'run-poison';

    const gen1 = await wakeAndConnect(stub, id);
    await stub.enqueueRun({ computerId: id, runId, argv: ['/bin/sh', '-c', 'kill the machine'] });
    await gen1.sup.recv.waitForTag('start_run');
    // First death: never started, so it is re-queued.
    await evict(stub, gen1.sup);
    await waitForGrace(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await waitUntil(
      async () => (await stub.runDetail(runId))?.status === 'queued',
      3000,
      'the first re-queue',
    );

    // The fresh generation takes it, and its machine dies the same way.
    const gen2 = await generationOf(stub);
    const sup2 = await FakeSupervisor.connect(id);
    await sup2.handshake(id, gen2.epoch, gen2.token);
    await sup2.recv.waitForTag('start_run');
    await evict(stub, sup2);
    await waitForGrace(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // Second death: NOT re-queued again. The run is interrupted, with one
    // content-free attention event, and the loop stops.
    await waitUntil(
      async () => (await stub.runDetail(runId))?.status === 'interrupted',
      3000,
      'the second death to interrupt rather than re-queue',
    );
    const attention = await stub.listAttentionEvents();
    expect(attention.map((a) => a.kind)).toEqual(['interrupted']);
    // Two evictions, two recoveries, and exactly three instances asked for (the
    // original plus one per recovery) — not an unbounded stream of them.
    expect(await withFake(stub, (f) => f.specs.length)).toBeLessThanOrEqual(3);
  });

  it('the AWAKE/WARM -> COLD handshake completes on its own when the final snapshot never arrives', async () => {
    // (a) of the two observed stalls. The e2e suite had to nudge this transition
    // with `POST /wake` and count the nudges — a test helper working around a
    // product defect IS the defect. No nudge is used here: the DO's own deadline
    // is the only trigger, and the missed snapshot is RECORDED, not swallowed.
    const id = 'cold-selfheals';
    const stub = computerStub(id);
    const gen = await wakeAndConnect(stub, id);
    const head = M('7');
    gen.sup.headAdvance(head, gen.epoch);
    expect((await gen.sup.recv.waitForTag('head_advance_result')).c.accepted).toBe(true);

    // AWAKE -> WARM.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getState()).toBe('warm');

    // WARM -> COLD asks the supervisor to stop cleanly and write the final
    // manifest (spec 4.5)...
    const prepared = gen.sup.recv.waitForTag('prepare_for_cold');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await prepared;
    expect(await stub.getState()).toBe('warm');

    // ...and that supervisor is already gone (its container stopped, or the
    // socket outlived it). It never answers.
    gen.sup.close();

    // The handshake's own deadline finalizes it. Nothing external is nudged.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getState()).toBe('cold');
    // Finalized from the LAST KNOWN HEAD: nothing is invented, nothing is lost
    // that was ever in the chunk store.
    expect(await stub.getHead()).toBe(head);
    expect(await ops(stub)).toEqual(['materialize', 'sleep', 'destroy']);
    // Honest about what it did NOT get: work since the last snapshot is genuinely
    // not in the chunk store, so this is not reported as a clean transition.
    expect(kinds(await stub.listIncidents())).toContain('final_snapshot_missed');

    // And the computer is immediately usable again.
    const again = await stub.wake(id);
    expect(again.ok).toBe(true);
    expect(again.epoch).toBe(gen.epoch + 1);
  });

  it('a WARM computer whose instance was evicted recovers instead of resuming forever', async () => {
    // WARM says "the substrate still holds this computer" (spec §2). When the
    // resource is gone that is a claim no future wake can honour — every attempt
    // would resume something that does not exist — so a refused resume ASKS, and a
    // substrate that says `gone` sends the computer to its head instead.
    const id = 'warm-evicted';
    const stub = computerStub(id);
    const gen = await wakeAndConnect(stub, id);
    expect(await stub.sleepNow()).toBe('warm');
    await evict(stub, gen.sup);

    const woken = await stub.wake(id);
    // The wake SUCCEEDS, on a fresh instance: the resume failed, the substrate said
    // the resource was gone, and the recovery + materialize happened behind it.
    expect(woken.ok).toBe(true);
    expect(woken.epoch).toBeGreaterThan(gen.epoch);
    expect(await stub.getState()).toBe('awake');
    expect(await ops(stub)).toEqual([
      'materialize',
      'sleep',
      'wake', // the refused resume
      'destroy', // the recovery's teardown of the dead handle
      'materialize', // a FRESH instance
    ]);
    expect(kinds(await stub.listIncidents())).toContain('substrate_lost');
  });

  it('the tier alarm firing against a substrate that is already gone recovers instead of throwing', async () => {
    const id = 'tier-vs-dead';
    const stub = computerStub(id);
    const gen = await wakeAndConnect(stub, id);
    // The machine is gone, but the socket does NOT close — the shape a torn-down
    // Cloudflare microVM took on a real deployment, where the DO's supervisor
    // socket stayed open and the computer read `awake` 15 minutes later.
    await evict(stub, null);

    // The idle deadline arrives and tries to `sleep` a resource that is not there.
    // Before, that threw out of `alarm()` and the computer stayed AWAKE with the
    // deadline consumed — nothing would ever move it again.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await waitUntil(async () => (await stub.getState()) === 'cold', 3000, 'recovery to COLD');
    expect(kinds(await stub.listIncidents())).toContain('substrate_lost');
    // A `sleep` was attempted and refused; the computer is COLD at its head, and
    // the dead handle is not still recorded.
    expect(await ops(stub)).toContain('sleep');
    expect((await metaOf(stub))['handle']).toBeNull();

    gen.sup.close();
  });

  it('a wake that hangs is bounded, reported, and retried while a run waits', async () => {
    // "A materialize that throws mid-flight" has a nastier sibling: one that never
    // answers. dockerode has no timeout of its own and Cloudflare's over-capacity
    // failure mode is a HANG rather than an error, so the DO bounds the call
    // itself — a client request must never wait on a substrate making up its mind
    // (spec 8.3).
    const id = 'wake-hangs';
    const stub = computerStub(id);
    await runInDurableObject(stub, (instance: ComputerDO) => {
      const fake = instance.substrate as unknown as FakeSubstrate;
      const real = fake.materialize.bind(fake);
      let calls = 0;
      (instance.substrate as unknown as { materialize: unknown }).materialize = (spec: never) => {
        calls++;
        if (calls === 1) return new Promise(() => undefined); // never answers
        return real(spec);
      };
    });

    // A run is waiting, so this wake matters.
    await stub.enqueueRun({ computerId: id, runId: 'run-hang', argv: ['/bin/true'] });
    const t0 = Date.now();
    const refused = await stub.wake(id);
    const waited = Date.now() - t0;
    // Bounded by WAKE_TIMEOUT_MS (2 s in this suite's config), not by the client
    // giving up.
    expect(waited).toBeLessThan(10_000);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('wake_failed');
    // COLD, not WAKING: a resting state the user and the tier machine can act on.
    expect(refused.state).toBe('cold');
    // ...and the wake is not a dead end, because work is pending: a bounded retry
    // is armed and reported honestly.
    expect(refused.retrying).toBe(true);
    expect(refused.retryAt).toBeGreaterThan(Date.now());
    expect((await stub.listRuns()).map((r) => r.status)).toEqual(['queued']);

    // The retry brings it up, and the run is handed over.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await waitUntil(async () => (await stub.getState()) === 'awake', 5000, 'the retry to wake it');
    const gen = await generationOf(stub);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, gen.epoch, gen.token);
    expect((await sup.recv.waitForTag('start_run')).c.run).toBe('run-hang');
    sup.close();
  });

  it('the WAKING watchdog does not fight a wake that is still running', async () => {
    // WAKING is a transition, not a resting place, so it gets a watchdog — but the
    // watchdog must not tear down a materialize that is merely slow (a driver
    // retrying a platform that is refusing, which on Cloudflare takes minutes).
    // While a wake IS in flight the deadline is pushed out, not acted on.
    //
    // The other half — WAKING persisted with NO wake behind it, which is what an
    // evicted object or a restarted private instance leaves — needs a real
    // restart, and is asserted in test/node/runtime.test.ts against the Node
    // runtime's own durable storage.
    const id = 'waking-watchdog';
    const stub = computerStub(id);
    await runInDurableObject(stub, (instance: ComputerDO) => {
      const fake = instance.substrate as unknown as FakeSubstrate;
      const real = fake.materialize.bind(fake);
      // Slow, not broken: inside the DO's own budget, so the wake must be allowed
      // to finish. (The timer lives in the object's I/O context — a callback held
      // by the test could not resolve it from outside.)
      (instance.substrate as unknown as { materialize: unknown }).materialize = async (
        spec: never,
      ) => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return real(spec);
      };
    });

    const waking = stub.wake(id);
    await waitUntil(
      async () => (await metaOf(stub))['state'] === 'waking',
      2000,
      'the computer to enter WAKING',
    );
    // The watchdog fires while the wake is in flight: it re-arms itself into the
    // future instead of rolling the wake back.
    expect(Number((await metaOf(stub))['wakingAt'])).toBeGreaterThan(0);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getState()).toBe('waking');
    expect(Number((await metaOf(stub))['wakingAt'])).toBeGreaterThan(Date.now());
    // No incident: nothing went wrong, the substrate is just slow.
    expect(kinds(await stub.listIncidents())).not.toContain('wake_abandoned');

    const woken = await waking;
    expect(woken.ok).toBe(true);
    expect(await stub.getState()).toBe('awake');
    // The watchdog is disarmed once the computer arrives.
    expect((await metaOf(stub))['wakingAt']).toBeNull();
  });

  it('an inconclusive liveness answer is bounded, never read as "gone" on the first try', async () => {
    // provider.ts is explicit: `unknown` is not `gone`. A driver that cannot be
    // asked must not cost a user their AWAKE computer on the first hiccup — but a
    // computer whose supervisor is absent AND whose substrate cannot be asked is
    // unusable, so the tolerance is BOUNDED rather than infinite.
    const id = 'liveness-unknown';
    const stub = computerStub(id);
    const gen = await wakeAndConnect(stub, id);
    await stub.enqueueRun({ computerId: id, runId: 'run-unknown', argv: ['/bin/true'] });
    await gen.sup.recv.waitForTag('start_run');
    await withFake(stub, (fake) => {
      fake.statusThrows = true;
    });
    gen.sup.close();
    await waitForGrace(stub);

    // First inconclusive answer: the computer is left alone.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await delay(50);
    expect(await stub.getState()).toBe('awake');
    expect(Number((await metaOf(stub))['livenessStrikes'])).toBe(1);
    expect(kinds(await stub.listIncidents())).not.toContain('substrate_unknown');

    // Second: recovered anyway, and recorded as what it was — a substrate that
    // could not be asked, not a substrate that said no.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await waitUntil(
      async () => (await stub.getState()) !== 'awake',
      3000,
      'the bounded unknown to be acted on',
    );
    expect(kinds(await stub.listIncidents())).toContain('substrate_unknown');
    // The run was never started, so it is re-queued rather than interrupted, and
    // the computer comes back for it.
    await waitUntil(
      async () => (await withFake(stub, (f) => f.specs.length)) === 2,
      3000,
      'a fresh instance for the queued run',
    );
  });

  it('a healthy computer is never probed: a supervisor that speaks is its own liveness proof', async () => {
    // The cost discipline behind the health check. A run's heartbeat (every 5 s in
    // marid) means the machine and its supervisor are both there, so the recurring
    // deadline must cost an alarm and NO substrate call.
    const id = 'healthy-nopoke';
    const stub = computerStub(id);
    const gen = await wakeAndConnect(stub, id);
    await stub.enqueueRun({ computerId: id, runId: 'run-healthy', argv: ['/bin/true'] });
    await gen.sup.recv.waitForTag('start_run');
    gen.sup.runStarted('run-healthy', M('d'));
    gen.sup.send({ t: 'run_heartbeat', c: { run: 'run-healthy' } });
    await delay(50);

    // Run the liveness check the deadline runs (same code, one implementation).
    const health = await stub.healthCheck();
    expect(health).toMatchObject({ state: 'awake', verdict: 'supervised', probes: 0 });
    expect(await withFake(stub, (f) => f.probes.length)).toBe(0);
    expect(await ops(stub)).toEqual(['materialize']);

    // And with the supervisor gone it is NOT free — the substrate gets asked.
    gen.sup.close();
    await waitForGrace(stub);
    const sick = await stub.healthCheck();
    expect(sick.probes).toBe(1);
  });
});
