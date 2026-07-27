// Attention transport (spec 6.2): "The supervisor sends a content-free
// attention event to the control plane. The control plane sends a notification
// to the user."
//
// `/api/events` is the delivery leg: an authenticated, fleet-wide SSE stream fed
// by every one of the user's ComputerDOs. The teeth here are (a) an attention
// raised on the supervisor wire reaches a connected client live, and (b) what
// arrives is METADATA ONLY — the terminal bytes that flowed on the journal in
// the same instant appear nowhere on this stream (spec 6.3).
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  HOST,
  computerStub,
  createComputer,
  delay,
  ensureSchema,
  FakeSupervisor,
  seedSession,
} from './helpers';

/** Reads an SSE body incrementally and exposes the decoded events. */
class SseStream {
  raw = '';
  closed = false;
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
    this.closed = true;
  }

  /** Every complete `data:` payload seen so far, decoded. */
  events(): Record<string, unknown>[] {
    const out: Record<string, unknown>[] = [];
    for (const block of this.raw.split('\n\n')) {
      const line = block.split('\n').find((l) => l.startsWith('data: '));
      if (!line) continue;
      try {
        out.push(JSON.parse(line.slice('data: '.length)) as Record<string, unknown>);
      } catch {
        /* partial frame; it will be complete on a later poll */
      }
    }
    return out;
  }

  async waitForRaw(needle: string, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!this.raw.includes(needle)) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${needle}`);
      await delay(10);
    }
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
  expect(res.headers.get('content-type')).toContain('text/event-stream');
  expect(res.body).toBeTruthy();
  const stream = new SseStream(res.body as ReadableStream<Uint8Array>);
  await stream.waitForRaw(': ready');
  return stream;
}

describe('/api/events (spec 6.2 attention transport)', () => {
  let cookie = '';
  beforeAll(async () => {
    await ensureSchema();
    ({ cookie } = await seedSession());
  });

  it('rejects an unauthenticated subscriber', async () => {
    const res = await SELF.fetch(`${HOST}/api/events`);
    expect(res.status).toBe(401);
  });

  it('delivers a live attention event and nothing content-bearing', async () => {
    const id = await createComputer(cookie, 'attentive');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const stream = await subscribe(cookie);

    // Terminal content flows on the JOURNAL in the same instant...
    const secret = 'ANTHROPIC_API_KEY=sk-do-not-leak / Allow this tool? (y/n)';
    sup.journalFrame('run-attn', 0, new TextEncoder().encode(secret));
    // ...and the attention itself is a bare signal class (spec 6.1).
    sup.attention('run-attn', 'blocked_read');

    const evt = await stream.waitForEvent((e) => e['type'] === 'attention');
    expect(evt['computer']).toBe(id);
    expect(evt['runId']).toBe('run-attn');
    expect(evt['state']).toBe('waiting');
    expect(evt['kind']).toBe('blocked_read');
    expect(typeof evt['seq']).toBe('number');
    expect(typeof evt['at']).toBe('number');
    // The FULL key set: there is nowhere for content to hide.
    expect(Object.keys(evt).sort()).toEqual([
      'at',
      'computer',
      'kind',
      'runId',
      'seq',
      'state',
      'type',
    ]);
    // And the journal bytes never reached this stream (spec 6.3).
    expect(stream.raw).not.toContain('sk-do-not-leak');
    expect(stream.raw).not.toContain('Allow this tool');

    // The durable record is still the computer's own attention log.
    const events = await stub.listAttentionEvents();
    expect(events.map((e) => ({ run: e.run, kind: e.kind }))).toEqual([
      { run: 'run-attn', kind: 'blocked_read' },
    ]);

    // Dismissing it clears the badge on every open client, still content-free.
    const dismissed = await SELF.fetch(
      `${HOST}/api/computers/${id}/attention/${events[0]!.id}/dismiss`,
      { method: 'POST', headers: { Cookie: cookie } },
    );
    expect(dismissed.status).toBe(200);
    const cleared = await stream.waitForEvent(
      (e) => e['type'] === 'attention' && e['state'] === 'cleared',
    );
    expect(cleared['runId']).toBe('run-attn');
    expect(Object.keys(cleared).sort()).toEqual([
      'at',
      'computer',
      'runId',
      'seq',
      'state',
      'type',
    ]);
    expect(await stub.listAttentionEvents()).toEqual([]);
    sup.close();
  });

  it('delivers run lifecycle and computer state changes', async () => {
    const id = await createComputer(cookie, 'lifecycle');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const stream = await subscribe(cookie);

    const started = await SELF.fetch(`${HOST}/api/computers/${id}/runs`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ argv: ['/bin/true'] }),
    });
    const runId = ((await started.json()) as { runId: string }).runId;

    const pending = await stream.waitForEvent(
      (e) => e['type'] === 'run' && e['runId'] === runId && e['state'] === 'pending',
    );
    expect(pending['computer']).toBe(id);

    await sup.recv.waitForTag('start_run');
    sup.runStarted(runId, 'a'.repeat(64));
    await stream.waitForEvent(
      (e) => e['type'] === 'run' && e['runId'] === runId && e['state'] === 'running',
    );

    sup.runCompleted(runId, 'b'.repeat(64), { t: 'exited', c: { code: 7 } });
    const done = await stream.waitForEvent(
      (e) => e['type'] === 'run' && e['runId'] === runId && e['state'] === 'exited',
    );
    expect(done['exitCode']).toBe(7);
    // A completion carries the exit status and nothing else about the run.
    expect(Object.keys(done).sort()).toEqual([
      'at',
      'computer',
      'exitCode',
      'runId',
      'seq',
      'state',
      'type',
    ]);

    // A state transition reaches the same stream (spec 8.2 fleet liveness).
    await stub.sleepNow();
    const state = await stream.waitForEvent(
      (e) => e['type'] === 'state' && e['computer'] === id && e['state'] === 'warm',
    );
    expect(state['computer']).toBe(id);

    // Sequence numbers are strictly increasing across the whole stream.
    const seqs = stream.events().map((e) => Number(e['seq']));
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    sup.close();
  });

  it('does not deliver another user’s events', async () => {
    // A second identity, signed up through the real Better Auth endpoint
    // (DEV_AUTH=1 enables email/password in test builds).
    const other = await SELF.fetch(`${HOST}/api/auth/sign-up/email`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'other@mari.test',
        password: 'other-password-123',
        name: 'Other User',
      }),
    });
    expect(other.status).toBe(200);
    const otherCookie = (other.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
    expect(otherCookie).toMatch(/=/);

    const mine = await createComputer(cookie, 'mine-only');
    const stub = computerStub(mine);
    const w = await stub.wake(mine);
    const sup = await FakeSupervisor.connect(mine);
    await sup.handshake(mine, w.epoch, w.token);

    const theirStream = await subscribe(otherCookie);
    const myStream = await subscribe(cookie);

    sup.attention('run-private', 'bell');
    await myStream.waitForEvent((e) => e['type'] === 'attention' && e['runId'] === 'run-private');

    // The other user's stream saw nothing about my computer.
    expect(theirStream.raw).not.toContain(mine);
    expect(theirStream.events().filter((e) => e['type'] === 'attention')).toEqual([]);
    sup.close();
  });
});
