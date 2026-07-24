// Concurrency / fencing / state-machine tests.
//
// The FIRST describe block is LIVE (regression coverage for the two findings
// fixed in this lane): the cold-finalize race (CP-COLDRACE-1) and the
// unauthenticated journal write (CP-FENCE-INGEST-2). Each asserts the correct,
// fixed behavior.
//
// The SECOND describe block stays `describe.skip`: it holds reviewer repros for
// findings NOT owned by this change (journal-frame offset dedup; a failed
// materialize wedging WAKING). Flip to `describe` to reproduce those.
import { describe, it, expect, beforeAll } from 'vitest';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { ensureSchema, computerStub, FakeSupervisor, delay, bytes } from './helpers';
import type { ComputerDO } from '../src/computer-do';

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

describe.skip('review repro: findings NOT owned by this change', () => {
  beforeAll(ensureSchema);

  // FINDING (unowned): the DO ignores JournalFrame.offset and blindly appends
  // #pending at its own head, so a replayed frame is DUPLICATED, not deduped.
  it('a replayed journal frame at the same offset is deduplicated', async () => {
    const id = 'repro-dup';
    const run = 'run-dup';
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const A = bytes(0xaa, 0xbb, 0xcc, 0xdd);
    // Two frames at offset 0 within one flush window (the effect a resume-from-0
    // has on the DO while its #pending still holds the pre-disconnect bytes).
    sup.journalFrame(run, 0, A);
    sup.journalFrame(run, 0, A);
    await delay(60);

    const stored = new Uint8Array(await stub.readJournal(run));
    // DESIRED: offset-addressed ingestion dedups the replay -> 4 bytes.
    // ACTUAL: 8 bytes (A twice); every later offset is now shifted by 4.
    expect(stored.length).toBe(4);

    sup.close();
  });

  // FINDING (unowned): if the substrate's materialize() throws, wake() leaves
  // the DO wedged in WAKING forever — no handle, no alarm re-armed, no retry.
  it('a failed materialize does not wedge the computer in WAKING', async () => {
    const id = 'repro-wedge';
    const stub = computerStub(id);

    await runInDurableObject(stub, (instance: ComputerDO) => {
      // Inject a substrate whose materialize always throws.
      (instance as unknown as { substrate: unknown }).substrate = {
        async materialize() {
          throw new Error('capacity: materialize failed');
        },
        async destroy() {},
        async sleep() {},
        async wake() {},
        async exec() {
          return { exitCode: 0, stdout: '', stderr: '' };
        },
        async exposePort() {
          return 'http://x.invalid:1';
        },
      };
    });

    await expect(stub.wake(id)).rejects.toThrow();

    // DESIRED: a failed wake rolls back to a non-transient state (cold) so the
    // fleet never shows a permanent spinner (spec 8.3) and the tier machine can
    // still act. ACTUAL: it is stuck in 'waking' with no handle and no alarm.
    expect(await stub.getState()).not.toBe('waking');
  });
});
