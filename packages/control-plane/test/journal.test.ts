// Journal (spec 4.2, 7.3, decisions.md): frames streamed over the supervisor WS
// are coalesced and persisted in the DO; a client attaching AFTER the supervisor
// disconnected receives the EXACT prior bytes (byte-compare), reconstructed from
// DO state without waking anything.
import { describe, it, expect, beforeAll } from 'vitest';
import { ensureSchema, computerStub, FakeSupervisor, FakeClient, bytes, concat, eqBytes } from './helpers';

describe('journal persistence + attach replay', () => {
  beforeAll(ensureSchema);

  it('coalesces frames, acks the durable offset, and replays exact bytes to a late client', async () => {
    const id = 'journalcomp';
    const run = 'run-1';
    const stub = computerStub(id);
    const w = await stub.wake(id);

    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    // Two frames pushed within one flush window MUST coalesce into ONE ack at
    // the combined offset. Include non-UTF8 bytes to prove byte-level fidelity.
    const b1 = bytes(0x00, 0x01, 0x02, 0xff, 0xfe, 0x1b, 0x5b, 0x33, 0x31, 0x6d); // ESC[31m + binary
    const b2 = bytes(0x68, 0x69, 0x0d, 0x0a, 0x80, 0x81); // "hi\r\n" + high bytes
    sup.journalFrame(run, 0, b1);
    sup.journalFrame(run, b1.length, b2);

    const ack = await sup.recv.waitForTag('journal_ack');
    expect(ack.c.run).toBe(run);
    expect(ack.c.offset).toBe(b1.length + b2.length);
    // Coalescing: exactly one flush/ack for the two same-window frames.
    expect(sup.recv.countTag('journal_ack')).toBe(1);

    const full = concat(b1, b2);

    // The DO holds the exact bytes.
    const stored = await stub.readJournal(run);
    expect(eqBytes(new Uint8Array(stored), full)).toBe(true);

    // Supervisor disconnects.
    sup.close();

    // A client attaches AFTER the disconnect: it gets a grid, then the exact
    // prior journal bytes as a frame — from DO state, no wake.
    const client = await FakeClient.connect(id);
    client.attach(run, 80, 24);

    const grid = await client.recv.waitForTag('grid');
    expect(grid.run).toBe(run);

    const frame = await client.recv.waitForTag('frame');
    expect(frame.run).toBe(run);
    expect(frame.offset).toBe(0);
    expect(eqBytes(new Uint8Array(frame.bytes), full)).toBe(true);

    client.close();
  });

  it('streams live frames to an already-attached client', async () => {
    const id = 'journalcomp2';
    const run = 'run-live';
    const stub = computerStub(id);
    const w = await stub.wake(id);

    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const client = await FakeClient.connect(id);
    client.attach(run, 80, 24);
    await client.recv.waitForTag('grid'); // empty grid, no prior bytes yet

    const live = bytes(0x6c, 0x69, 0x76, 0x65); // "live"
    sup.journalFrame(run, 0, live);

    const frame = await client.recv.waitForTag('frame');
    expect(eqBytes(new Uint8Array(frame.bytes), live)).toBe(true);

    sup.close();
    client.close();
  });
});
