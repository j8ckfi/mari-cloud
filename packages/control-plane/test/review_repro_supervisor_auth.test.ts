// SECURITY REGRESSION (live) — the supervisor WebSocket must NOT process any
// state-changing message until the socket completed the `hello` token+epoch
// handshake, and the client attach WebSocket must NOT be accepted without a
// session that OWNS the computer.
//
// contracts.md Appendix B: the supervisor channel is authenticated by "the
// one-time `token` minted at wake; a mismatch closes that socket (1008)".
// Before the fix, ComputerDO#onSupervisorMessage dispatched every frame purely
// on its tag, so an un-helloed peer could (1) probe/leak the current epoch via
// `head_advance_result`, (2) hijack the manifest head, and (3) inject bytes
// into a run's journal; and `/attach/:id` accepted any socket with no session
// or ownership check (cross-tenant terminal read + PTY keystroke injection).
//
// These tests assert the FIXED, secured behavior (SEC-01, SEC-02,
// CP-FENCE-INGEST-2): the gate lives in ComputerDO#onSupervisorMessage (the
// per-socket `hello`/epoch gate) and in handler.ts#tryWsRoute (the attach
// session+ownership gate).
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  ensureSchema,
  computerStub,
  FakeSupervisor,
  cookieFromSetCookie,
  delay,
} from './helpers';

const HOST = 'http://localhost';

/** Attempt a client attach WS upgrade THROUGH the worker (handler.ts), so the
 *  edge session+ownership gate runs. Returns the raw upgrade response. */
function attachUpgrade(id: string, headers: Record<string, string> = {}): Promise<Response> {
  return SELF.fetch(`${HOST}/attach/${encodeURIComponent(id)}`, {
    headers: { Upgrade: 'websocket', ...headers },
  }) as unknown as Promise<Response>;
}

describe('supervisor channel + attach authorization (security regression)', () => {
  beforeAll(ensureSchema);

  it('an un-helloed supervisor socket cannot probe the epoch nor hijack the head', async () => {
    const id = 'reprohijack';
    const stub = computerStub(id);

    // A legitimate wake mints epoch 1 + a secret token the attacker does NOT know.
    const w = await stub.wake(id);
    expect(w.epoch).toBe(1);
    const headBefore = await stub.getHead();

    // Attacker opens the supervisor socket but NEVER handshakes (no token).
    const attacker = await FakeSupervisor.connect(id);

    // Probe with a wrong epoch: the DO must NOT reply (no epoch disclosure to an
    // unauthenticated socket) — the wait times out.
    attacker.headAdvance('a'.repeat(64), 999_999);
    await expect(attacker.recv.waitForTag('head_advance_result', 300)).rejects.toThrow(/timeout/);

    // Even a correctly-guessed epoch is rejected: no handshake, no head advance,
    // and still no reply.
    const evilHead = 'e'.repeat(64);
    attacker.headAdvance(evilHead, 1);
    await expect(attacker.recv.waitForTag('head_advance_result', 300)).rejects.toThrow(/timeout/);

    // The head is unchanged — the attacker's manifest never took.
    expect(await stub.getHead()).toBe(headBefore);
    expect(await stub.getHead()).not.toBe(evilHead);

    attacker.close();
  });

  it('an un-helloed supervisor socket cannot inject bytes into a run journal', async () => {
    const id = 'reprojournal';
    const stub = computerStub(id);
    await stub.wake(id);

    const attacker = await FakeSupervisor.connect(id); // no handshake
    const forged = new TextEncoder().encode('\x1b[2J FORGED TERMINAL OUTPUT ');
    attacker.journalFrame('run-1', 0, forged);

    // Give the DO's coalescing flush timer (FLUSH_MS = 100) time to run — and
    // then some, so "nothing is stored" means REJECTED and not merely "not
    // flushed yet".
    await delay(260);

    const stored = await stub.readJournal('run-1');
    expect(new Uint8Array(stored).length).toBe(0);

    attacker.close();
  });

  it('a fenced-out (stale-epoch) supervisor still gets its head-advance rejected but cannot write the journal', async () => {
    const id = 'reprofenced';
    const stub = computerStub(id);

    // Generation A: epoch 1, handshakes, streams one legit frame.
    const w1 = await stub.wake(id);
    const supA = await FakeSupervisor.connect(id);
    await supA.handshake(id, w1.epoch, w1.token);
    supA.journalFrame('run-x', 0, new TextEncoder().encode('A-legit'));
    // The ack is emitted by the same flush that writes the row, so this is the
    // exact durability point — no sleep to tune against FLUSH_MS.
    await supA.recv.waitForTag('journal_ack');
    const afterA = new Uint8Array(await stub.readJournal('run-x'));
    expect(new TextDecoder().decode(afterA)).toBe('A-legit');

    // A new wake generation fences A out (epoch 2). A is still connected.
    await stub.sleepNow();
    const w2 = await stub.wake(id);
    expect(w2.epoch).toBe(w1.epoch + 1);

    // A, now stale, tries to advance the head: it MUST still receive the CAS
    // rejection (contracts.md §6.3) so it learns it lost.
    supA.headAdvance('c'.repeat(64), w1.epoch);
    const rej = await supA.recv.waitForTag('head_advance_result');
    expect(rej.c.accepted).toBe(false);
    expect(rej.c.current_epoch).toBe(w2.epoch);

    // But A's journal bytes are now DROPPED — a fenced-out writer cannot append
    // to the current run (spec 4.1/4.2 single-writer).
    supA.journalFrame('run-x', afterA.length, new TextEncoder().encode('A-STALE-INJECT'));
    // Longer than one flush window (FLUSH_MS = 100): the stale bytes must be
    // DROPPED, not just unflushed.
    await delay(260);
    const afterStale = new Uint8Array(await stub.readJournal('run-x'));
    expect(new TextDecoder().decode(afterStale)).toBe('A-legit');
    expect(new TextDecoder().decode(afterStale)).not.toContain('STALE');

    supA.close();
  });

  it('a client attach is rejected without a session, and for a non-owner, but accepted for the owner', async () => {
    // Seed mints a real Better Auth session AND a COLD computer owned by it.
    const seedRes = await SELF.fetch(`${HOST}/api/dev/seed`, { method: 'POST' });
    expect(seedRes.status).toBe(200);
    const cookie = cookieFromSetCookie(seedRes.headers.get('set-cookie'));
    expect(cookie).toMatch(/=/);

    // (1) No session cookie: rejected before the DO ever accepts the socket.
    const noAuth = await attachUpgrade('seedcomputer');
    expect(noAuth.status).toBe(401);

    // (2) Bogus session cookie: rejected.
    const bogus = await attachUpgrade('seedcomputer', {
      Cookie: 'better-auth.session_token=not-a-real-token',
    });
    expect(bogus.status).toBe(401);

    // (3) Valid session but a computer this user does NOT own: forbidden (IDOR
    // protection — a known computerId is not enough).
    const foreign = await attachUpgrade('someone-elses-computer', { Cookie: cookie });
    expect(foreign.status).toBe(403);

    // (4) The owner attaches to their own computer: the upgrade is accepted.
    const owner = await attachUpgrade('seedcomputer', { Cookie: cookie });
    expect(owner.status).toBe(101);
    const ownerWs = (owner as unknown as { webSocket: WebSocket | null }).webSocket;
    expect(ownerWs).toBeTruthy();
    ownerWs?.accept();
    ownerWs?.close();
  });
});
