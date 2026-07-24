// Epoch fencing (spec 4.1 mechanism, contracts.md §6) over the REAL supervisor
// WebSocket against a real ComputerDO.
//
// Scenario: supervisor A wakes (epoch 1) and advances the head. A new wake mints
// epoch 2 for supervisor B, which advances the head. Then A (still holding the
// stale epoch 1) attempts a head advance: it MUST be rejected and the head MUST
// remain B's.
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureSchema, computerStub, FakeSupervisor } from './helpers';

describe('epoch fencing', () => {
  beforeAll(ensureSchema);

  it('rejects a stale-epoch head advance; head stays the current writer’s', async () => {
    const id = 'epochcomp';
    const stub = computerStub(id);

    // ---- Wake #1: epoch 1, supervisor A ----
    const w1 = await stub.wake(id);
    expect(w1.epoch).toBe(1);
    const supA = await FakeSupervisor.connect(id);
    await supA.handshake(id, w1.epoch, w1.token);

    const MA = 'a'.repeat(64);
    supA.headAdvance(MA, w1.epoch);
    const r1 = await supA.recv.waitForTag('head_advance_result');
    expect(r1.c.accepted).toBe(true);
    expect(r1.c.current_epoch).toBe(1);
    expect(await stub.getHead()).toBe(MA);

    // ---- A new wake generation: epoch 2, supervisor B ----
    // (WARM rollback / migration: the computer sleeps then wakes anew.)
    await stub.sleepNow();
    const w2 = await stub.wake(id);
    expect(w2.epoch).toBe(2);
    expect(w2.token).not.toBe(w1.token);

    const supB = await FakeSupervisor.connect(id);
    await supB.handshake(id, w2.epoch, w2.token);

    const MB = 'b'.repeat(64);
    supB.headAdvance(MB, w2.epoch);
    const r2 = await supB.recv.waitForTag('head_advance_result');
    expect(r2.c.accepted).toBe(true);
    expect(await stub.getHead()).toBe(MB);

    // ---- A, fenced out, tries to advance with the stale epoch 1 ----
    const MA2 = 'c'.repeat(64);
    supA.headAdvance(MA2, w1.epoch);
    const r3 = await supA.recv.waitForTag('head_advance_result');
    expect(r3.c.accepted).toBe(false);
    expect(r3.c.current_epoch).toBe(2);

    // Head is unchanged — still B's manifest, NOT A's stale write.
    expect(await stub.getHead()).toBe(MB);

    supA.close();
    supB.close();
  });

  it('rejects a supervisor whose hello token/epoch does not match', async () => {
    const id = 'epochcomp2';
    const stub = computerStub(id);
    const w = await stub.wake(id);

    const sup = await FakeSupervisor.connect(id);
    // Wrong token: the DO must not ack the handshake.
    sup.send({ t: 'hello', c: { computer: id, epoch: w.epoch, token: 'wrong-token', proto_version: 1 } });
    await expect(sup.recv.waitForTag('hello_ack', 400)).rejects.toThrow(/timeout/);
    sup.close();
  });
});
