// Tier policy alarms (spec 4.4): advancing time drives AWAKE -> WARM -> COLD,
// calling the substrate driver in order (sleep, then destroy after a clean final
// snapshot), and recording the final manifest as the head.
//
// `runDurableObjectAlarm` fires the scheduled alarm regardless of wall-clock,
// which is exactly how the harness simulates idle-time passage.
import { describe, it, expect, beforeAll } from 'vitest';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { ensureSchema, computerStub, FakeSupervisor, delay } from './helpers';
import type { ComputerDO } from '../src/computer-do';

async function ops(stub: ReturnType<typeof computerStub>): Promise<string[]> {
  return runInDurableObject(stub, (instance: ComputerDO) =>
    (instance.substrate as { calls: { op: string }[] }).calls.map((c) => c.op),
  );
}

describe('tier policy', () => {
  beforeAll(ensureSchema);

  it('AWAKE -> WARM -> COLD with driver calls in order and final manifest recorded', async () => {
    const id = 'tiercomp';
    const stub = computerStub(id);

    // AWAKE.
    const w = await stub.wake(id);
    expect(await stub.getState()).toBe('awake');
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    // First alarm: AWAKE -> WARM (substrate.sleep).
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getState()).toBe('warm');
    expect(await ops(stub)).toEqual(['materialize', 'sleep']);

    // Second alarm: WARM -> COLD begins by asking the supervisor to prepare.
    const prepared = sup.recv.waitForTag('prepare_for_cold');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await prepared;

    // The supervisor stops cleanly and writes the final manifest; the DO then
    // destroys the substrate and goes COLD, recording that manifest as the head.
    const MFINAL = 'f'.repeat(64);
    sup.snapshotWritten(MFINAL, w.epoch, 'final');

    // Wait for the cold finalize to complete.
    let state = await stub.getState();
    for (let i = 0; i < 50 && state !== 'cold'; i++) {
      await delay(10);
      state = await stub.getState();
    }
    expect(state).toBe('cold');

    // Driver calls in order across the whole lifecycle.
    expect(await ops(stub)).toEqual(['materialize', 'sleep', 'destroy']);
    // Final manifest recorded as the head (spec 4.4/4.5).
    expect(await stub.getHead()).toBe(MFINAL);

    sup.close();
  });

  it('tears down immediately if no supervisor is attached at COLD time', async () => {
    const id = 'tiercomp2';
    const stub = computerStub(id);
    await stub.wake(id);

    // No supervisor connected.
    expect(await runDurableObjectAlarm(stub)).toBe(true); // -> WARM
    expect(await stub.getState()).toBe('warm');
    expect(await runDurableObjectAlarm(stub)).toBe(true); // -> COLD (no prepare)
    expect(await stub.getState()).toBe('cold');
    expect(await ops(stub)).toEqual(['materialize', 'sleep', 'destroy']);
  });
});
