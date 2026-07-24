// Concurrency / fencing / state-machine tests. Every block here is LIVE and
// asserts the FIXED behavior of four findings raised in review:
//
//   CP-COLDRACE-1        the cold-finalize race (a wake mid-finalize)
//   CP-FENCE-INGEST-2    an unauthenticated socket writing the journal
//   CP-JOURNAL-OFFSET-3  a replayed `journal_frame` duplicating durable bytes
//   CP-WAKE-WEDGE-4      a failed materialize leaving the computer in WAKING
//
// The last two were previously parked as `describe.skip` repros ("not owned by
// this change"). Both name a REAL defect class (see the notes on each block);
// both are handled at the root in `src/computer-do.ts` — `#onJournalFrame`
// addresses the journal by the frame's own offset, and `#failWake` takes a
// computer out of WAKING. That code carried NO test, which is why the repros
// kept being re-litigated: nothing proved them closed, and nothing would have
// caught a regression. These blocks are that proof. Do not re-skip them.
import { describe, it, expect, beforeAll } from 'vitest';
import { runDurableObjectAlarm, runInDurableObject, SELF } from 'cloudflare:test';
import {
  HOST,
  ensureSchema,
  computerStub,
  createComputer,
  seedSession,
  FakeSupervisor,
  delay,
  bytes,
  concat,
  eqBytes,
  waitUntil,
} from './helpers';
import type { ComputerDO } from '../src/computer-do';
import type {
  ExecResult,
  MaterializeSpec,
  SubstrateHandle,
  SubstrateProvider,
} from '../src/substrate';

/**
 * A driver that fails on demand, recording every call. Real substrates fail this
 * way routinely: no capacity, an image that will not pull, a daemon that is
 * down. `calls` is what proves a retry RESUMED a WARM computer instead of
 * materializing a second copy of it (spec 4.1).
 */
class FlakySubstrate implements SubstrateProvider {
  readonly calls: string[] = [];
  failMaterialize = false;
  failWake = false;
  #seq = 0;

  count(op: string): number {
    return this.calls.filter((c) => c === op).length;
  }

  async materialize(spec: MaterializeSpec): Promise<SubstrateHandle> {
    this.calls.push('materialize');
    if (this.failMaterialize) throw new Error('capacity: materialize failed');
    return { substrate: 'flaky', computer: spec.computer, id: `flaky-${++this.#seq}` };
  }
  async destroy(): Promise<void> {
    this.calls.push('destroy');
  }
  async sleep(): Promise<void> {
    this.calls.push('sleep');
  }
  async wake(): Promise<void> {
    this.calls.push('wake');
    if (this.failWake) throw new Error('resume failed');
  }
  async exec(): Promise<ExecResult> {
    this.calls.push('exec');
    return { exitCode: 0, stdout: '', stderr: '' };
  }
  async exposePort(): Promise<string> {
    this.calls.push('exposePort');
    return 'http://flaky.invalid:1';
  }
}

/** Install a flaky driver into a computer's DO and hand it back to the test. */
async function injectFlaky(
  stub: ReturnType<typeof computerStub>,
  init: Partial<Pick<FlakySubstrate, 'failMaterialize' | 'failWake'>> = {},
): Promise<FlakySubstrate> {
  const flaky = new FlakySubstrate();
  Object.assign(flaky, init);
  await runInDurableObject(stub, (instance: ComputerDO) => {
    instance.substrate = flaky;
  });
  return flaky;
}

/** Minimal SSE reader for `/api/events` (spec 6.2 / contracts C.4). */
class SseStream {
  raw = '';
  #decoder = new TextDecoder();

  constructor(body: ReadableStream<Uint8Array>) {
    void this.#pump(body.getReader());
  }

  async #pump(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value) this.raw += this.#decoder.decode(value, { stream: true });
      }
    } catch {
      /* stream torn down */
    }
  }

  events(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const block of this.raw.split('\n\n')) {
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        out.push(JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
      } catch {
        /* partial frame */
      }
    }
    return out;
  }

  async waitForEvent(
    pred: (e: Record<string, unknown>) => boolean,
    timeoutMs = 3000,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events().find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) {
        throw new Error(`timeout waiting for event; saw ${JSON.stringify(this.events())}`);
      }
      await delay(10);
    }
  }
}

async function subscribe(cookie: string): Promise<SseStream> {
  const res = await SELF.fetch(`${HOST}/api/events`, {
    headers: { Cookie: cookie, accept: 'text/event-stream' },
  });
  expect(res.status).toBe(200);
  const stream = new SseStream(res.body as ReadableStream<Uint8Array>);
  await waitUntil(() => stream.raw.includes(': ready'), 3000, 'sse ready');
  return stream;
}

describe('concurrency: cold-finalize race + supervisor ingest auth (regression)', () => {
  beforeAll(ensureSchema);

  // CP-COLDRACE-1: a wake that arrives after WARM->COLD sent `prepare_for_cold`
  // but before the supervisor's final `snapshot_written` must NOT be silently
  // torn down. wake() now clears `coldPending` and bumps the epoch, and the
  // stale final snapshot is fenced at the ingest gate.
  it('wake during cold-finalize is NOT undone by the trailing final snapshot', async () => {
    const id = 'repro-coldrace';
    const stub = computerStub(id);

    const w1 = await stub.wake(id);
    expect(w1.state).toBe('awake');
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w1.epoch, w1.token);

    // AWAKE -> WARM
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getState()).toBe('warm');

    // WARM -> COLD begins: prepare_for_cold sent, coldPending = true (state warm).
    const prepared = sup.recv.waitForTag('prepare_for_cold');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await prepared;
    expect(await stub.getState()).toBe('warm');

    // A wake arrives mid-finalize (user click / proxy request). It re-materializes
    // to AWAKE with a fresh epoch.
    const w2 = await stub.wake(id);
    expect(w2.state).toBe('awake');
    expect(w2.epoch).toBe(w1.epoch + 1);
    expect(await stub.getState()).toBe('awake');

    // The old supervisor finishes its clean shutdown and reports the final
    // manifest under its now-STALE epoch. It must be ignored, not honored.
    const MFINAL = 'f'.repeat(64);
    sup.snapshotWritten(MFINAL, w1.epoch, 'final');
    await delay(60);

    // The computer the user just woke is still AWAKE.
    expect(await stub.getState()).toBe('awake');

    sup.close();
  });

  // CP-FENCE-INGEST-2: a supervisor socket that never completed `hello` cannot
  // write the journal (nor raise attention / hold the machine AWAKE).
  it('a socket that never handshook cannot write the journal', async () => {
    const id = 'repro-rogue';
    const run = 'run-rogue';
    const stub = computerStub(id);
    await stub.wake(id);

    // Connect a supervisor socket and send a journal frame WITHOUT any hello.
    const rogue = await FakeSupervisor.connect(id);
    rogue.journalFrame(run, 0, bytes(0x01, 0x02, 0x03, 0x04, 0x05));
    await delay(60); // let the flush window fire

    const stored = new Uint8Array(await stub.readJournal(run));
    // An unauthenticated writer's bytes are rejected (0 stored).
    expect(stored.length).toBe(0);

    rogue.close();
  });
});

// CP-JOURNAL-OFFSET-3 — ADJUDICATED REAL.
//
// The claim was that the DO ignored `JournalFrame.offset` and appended at its
// own head, so a replayed frame duplicated bytes. The refutation ("marid resumes
// from the acked offset, so a replay never happens") does not hold, because the
// offset marid resumes from is the one this DO hands it in `hello_ack` — and
// that offset is `journal_head`, which EXCLUDES the coalescing buffer. Two
// reachable paths, neither needing a supervisor bug:
//
//   1. The fencing token stays valid until COLD, so a reconnecting supervisor of
//      the SAME wake generation handshakes on a SECOND socket while the first is
//      still authenticated (`#isCurrentSupervisor` compares epochs, and both
//      sockets carry the current one). Frames still in flight on the old socket
//      land after the new socket has resumed from `hello_ack`.
//   2. A reconnect inside a flush window resumes below bytes still buffered here.
//
// The damage is not just duplication: the following `journal_ack` names an
// offset ABOVE what the supervisor actually sent, and marid's next resume starts
// there (`supervisor.rs` flush_journals), skipping real output. Duplication now,
// silent loss later — in what spec 4.2 calls the truth.
describe('journal ingest is offset-addressed (CP-JOURNAL-OFFSET-3)', () => {
  beforeAll(ensureSchema);

  it('deduplicates a frame replayed at an offset already buffered', async () => {
    const id = 'repro-dup';
    const run = 'run-dup';
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const A = bytes(0xaa, 0xbb, 0xcc, 0xdd);
    // Two frames at offset 0 within one flush window (what a resume-from-0 does
    // to the DO while its coalescing buffer still holds the pre-resume bytes).
    sup.journalFrame(run, 0, A);
    sup.journalFrame(run, 0, A);
    await delay(60);

    const stored = new Uint8Array(await stub.readJournal(run));
    expect(stored.length).toBe(4);
    expect(eqBytes(stored, A)).toBe(true);

    // The replay is recorded, not silently absorbed — and the record is
    // metadata only (spec 6.3: no journal byte may reach a log).
    const anomalies = await stub.journalAnomalies(run);
    expect(anomalies.map((a) => a.kind)).toEqual(['duplicate']);
    expect(anomalies[0]).toMatchObject({ run, kind: 'duplicate', atOffset: 0, len: 4 });
    expect(Object.keys(anomalies[0]!).sort()).toEqual([
      'at',
      'atOffset',
      'id',
      'kind',
      'len',
      'run',
    ]);

    sup.close();
  });

  it('replays across the flush boundary keep the tail and the ack honest', async () => {
    const id = 'repro-dup-flushed';
    const run = 'run-dup-flushed';
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const A = new TextEncoder().encode('first-half');
    const B = new TextEncoder().encode('SECOND-half');

    sup.journalFrame(run, 0, A);
    const ack1 = await sup.recv.waitForTag('journal_ack');
    expect(ack1.c.offset).toBe(A.length); // A is durable now

    // The supervisor resumes from BELOW the durable head (it never saw the ack)
    // and re-sends A together with new bytes B.
    sup.journalFrame(run, 0, concat(A, B));
    const ack2 = await sup.recv.waitForTag('journal_ack');

    // Only B was new: the journal is A+B once, and the ack names exactly the
    // bytes the supervisor really sent — an ack of A+A+B would make its next
    // resume skip |A| bytes of real output.
    expect(ack2.c.offset).toBe(A.length + B.length);
    const stored = new Uint8Array(await stub.readJournal(run));
    expect(eqBytes(stored, concat(A, B))).toBe(true);

    sup.close();
  });

  it('records a divergence when a replayed offset carries DIFFERENT bytes', async () => {
    const id = 'repro-diverge';
    const run = 'run-diverge';
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const A = new TextEncoder().encode('the-real-output');
    sup.journalFrame(run, 0, A);
    await sup.recv.waitForTag('journal_ack');

    // Same offset, different bytes: two writers disagree about the truth.
    const OTHER = new TextEncoder().encode('the-FAKE-output');
    expect(OTHER.length).toBe(A.length);
    sup.journalFrame(run, 0, OTHER);
    await delay(60);

    // What is durable wins; the journal is untouched...
    const stored = new Uint8Array(await stub.readJournal(run));
    expect(eqBytes(stored, A)).toBe(true);
    expect(new TextDecoder().decode(stored)).not.toContain('FAKE');

    // ...and the disagreement is surfaced as an integrity signal.
    const anomalies = await stub.journalAnomalies(run);
    expect(anomalies.map((a) => a.kind)).toEqual(['divergent']);
    expect(anomalies[0]).toMatchObject({ kind: 'divergent', atOffset: 0, len: A.length });

    sup.close();
  });

  it('a same-generation reconnect cannot duplicate the journal (the reachable path)', async () => {
    const id = 'repro-dup-reconnect';
    const run = 'run-dup-reconnect';
    const stub = computerStub(id);
    const w = await stub.wake(id);

    // Generation E, socket 1: streams A, which becomes durable.
    const sup1 = await FakeSupervisor.connect(id);
    await sup1.handshake(id, w.epoch, w.token);
    const A = new TextEncoder().encode('$ ls -la\r\n');
    sup1.journalFrame(run, 0, A);
    expect((await sup1.recv.waitForTag('journal_ack')).c.offset).toBe(A.length);

    // The connection degrades; marid reconnects with the SAME epoch + token
    // (the token is valid until COLD), so socket 2 is also current-generation.
    const sup2 = await FakeSupervisor.connect(id);
    await sup2.handshake(id, w.epoch, w.token);
    const helloAck = sup2.recv.all.find((m) => m.t === 'hello_ack');
    expect(helloAck.c.acked).toContainEqual({ run, offset: A.length });

    // Socket 2 resumes exactly where `hello_ack` said...
    const B = new TextEncoder().encode('total 0\r\n');
    sup2.journalFrame(run, A.length, B);

    // ...while socket 1's in-flight frames arrive AFTER the resume. Socket 1 is
    // not fenced (same epoch), so the ingest gate lets them through: only the
    // offset can tell the DO it already holds these bytes.
    sup1.journalFrame(run, 0, A);
    sup1.journalFrame(run, A.length, B);
    await delay(80);

    const stored = new Uint8Array(await stub.readJournal(run));
    expect(eqBytes(stored, concat(A, B))).toBe(true);
    expect(new TextDecoder().decode(stored)).toBe('$ ls -la\r\ntotal 0\r\n');

    sup1.close();
    sup2.close();
  });
});

// CP-WAKE-WEDGE-4 — ADJUDICATED REAL.
//
// `#wakeInner` set `state = 'waking'` and then awaited the substrate. A throw
// left it there: no handle, no alarm armed (none is during a wake), and the tier
// alarm acts on AWAKE/WARM only — so nothing in the system could ever move the
// computer again. `/api/events` had emitted `state: waking` and would emit
// nothing after it, and the background wake path swallowed the error, so the
// fleet card was a spinner that never resolves (spec 8.3 forbids exactly that).
// The WARM case was worse: the retry no longer looked WARM and would MATERIALIZE
// a second resource beside the one still held — two writable copies of one
// computer (spec 4.1).
describe('a failed wake leaves WAKING (CP-WAKE-WEDGE-4)', () => {
  beforeAll(ensureSchema);

  it('rolls back to COLD, surfaces the error, and stays wakeable', async () => {
    const id = 'repro-wedge';
    const stub = computerStub(id);
    const flaky = await injectFlaky(stub, { failMaterialize: true });

    // A refused wake is a RESULT every caller has to inspect, not a rejection a
    // caller can forget to catch (see `WakeResult`).
    const refused = await stub.wake(id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('wake_failed');
    expect(refused.state).toBe('cold');
    // No token: there is no supervisor generation to authenticate.
    expect(refused.token).toBe('');
    // The provider's own words ("capacity: ...") stay on the provider's side of
    // the boundary; a caller learns the outcome, not the substrate's internals.
    expect(JSON.stringify(refused)).not.toMatch(/capacity/);

    // Not a permanent spinner: a resting state the tier machine and the user can
    // both act on.
    expect(await stub.getState()).toBe('cold');
    expect(flaky.count('materialize')).toBe(1);

    // And the recourse works: once the substrate has capacity, a wake succeeds.
    flaky.failMaterialize = false;
    const w = await stub.wake(id);
    expect(w.state).toBe('awake');
    expect(await stub.getState()).toBe('awake');
  });

  it('a failed WARM resume stays WARM and never materializes a second copy', async () => {
    const id = 'repro-wedge-warm';
    const stub = computerStub(id);
    const flaky = await injectFlaky(stub);

    expect((await stub.wake(id)).state).toBe('awake');
    expect(await stub.sleepNow()).toBe('warm');

    // The resume fails: the slept resource still exists, so WARM is the truth.
    flaky.failWake = true;
    const refused = await stub.wake(id);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe('wake_failed');
    // WARM, not COLD: the slept resource still exists, and claiming COLD would
    // make the next wake materialize a second copy of it (spec 4.1).
    expect(refused.state).toBe('warm');
    expect(refused.token).toBe('');
    expect(JSON.stringify(refused)).not.toMatch(/resume failed/);
    expect(await stub.getState()).toBe('warm');

    // The retry RESUMES that resource. A second materialize here would be a
    // second writable copy of one computer (spec 4.1).
    flaky.failWake = false;
    expect((await stub.wake(id)).state).toBe('awake');
    expect(flaky.count('materialize')).toBe(1);
    expect(flaky.count('wake')).toBe(2);

    // The tier deadline survived the failure: WARM -> COLD still runs.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
  });

  it('a run queued behind a failed wake is retried on the alarm and still runs', async () => {
    const id = 'repro-wedge-queued';
    const stub = computerStub(id);
    const flaky = await injectFlaky(stub, { failMaterialize: true });

    // A run is requested while the computer is COLD; the wake behind it fails.
    const queued = await stub.enqueueRun({ computerId: id, runId: 'run-wedge', argv: ['/bin/true'] });
    expect(queued.queued).toBe(true);
    await waitUntil(async () => (await stub.getState()) === 'cold', 3000, 'rollback to cold');
    expect(flaky.count('materialize')).toBe(1);

    // The run is NOT lost (spec 5.1), and the DO armed a retry for it.
    expect((await stub.listRuns()).map((r) => r.status)).toEqual(['queued']);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await waitUntil(() => flaky.count('materialize') === 2, 3000, 'wake retry');

    // The substrate recovers; the next retry brings the computer up...
    flaky.failMaterialize = false;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await waitUntil(async () => (await stub.getState()) === 'awake', 3000, 'retry wakes');

    // ...and the queued run is handed to the supervisor that connects.
    const w = await runInDurableObject(stub, (instance: ComputerDO) => instance.describe(id));
    const sup = await FakeSupervisor.connect(id);
    sup.send({
      t: 'hello',
      c: { computer: id, epoch: w.epoch, token: await currentToken(stub), proto_version: 1 },
    });
    const start = await sup.recv.waitForTag('start_run');
    expect(start.c.run).toBe('run-wedge');
    sup.close();
  });

  it('reports the failure to the caller and to /api/events', async () => {
    const { cookie } = await seedSession();
    const id = await createComputer(cookie, 'wake-fails');
    const stub = computerStub(id);
    await injectFlaky(stub, { failMaterialize: true });

    const stream = await subscribe(cookie);

    const res = await SELF.fetch(`${HOST}/api/computers/${id}/wake`, {
      method: 'POST',
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: 'wake_failed', state: 'cold' });

    // The stream shows the transition AND its resolution — never a `waking` that
    // is the last word (spec 8.3).
    await stream.waitForEvent(
      (e) => e['type'] === 'state' && e['computer'] === id && e['state'] === 'waking',
    );
    await stream.waitForEvent(
      (e) => e['type'] === 'state' && e['computer'] === id && e['state'] === 'cold',
    );

    // And the fleet card shows a computer the user can act on.
    const fleet = await SELF.fetch(`${HOST}/api/fleet`, { headers: { Cookie: cookie } });
    const body = (await fleet.json()) as { computers: { id: string; state: string }[] };
    expect(body.computers.find((c) => c.id === id)?.state).toBe('cold');
  });
});

/** The DO's current fencing token (test-only reach into the instance). */
function currentToken(stub: ReturnType<typeof computerStub>): Promise<string> {
  return runInDurableObject(stub, async (instance: ComputerDO) => {
    const meta = await (
      instance as unknown as { ctx: DurableObjectState }
    ).ctx.storage.get<{ token: string | null }>('meta');
    return meta?.token ?? '';
  });
}
