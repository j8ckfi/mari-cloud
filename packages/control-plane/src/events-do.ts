// EventsDO — the per-user fan-out hub for live fleet events (spec 6.2).
//
// Spec 6.2: "The supervisor sends a content-free attention event to the control
// plane. The control plane sends a notification to the user." A ComputerDO is
// the coordination point for ONE computer (spec 3.2) and cannot reach a browser
// that is watching the whole fleet, so the delivery leg needs one rendezvous per
// USER: each ComputerDO publishes into `EventsDO(userId)`, and every open
// `/api/events` stream for that user is a subscriber of that object.
//
// The transport is Server-Sent Events: one-way server -> client, which is
// exactly the shape of a notification (terminal input has its own channel, the
// attach WebSocket), and `EventSource` reconnects by itself when a laptop sleeps.
//
// CONTENT-FREE IS ENFORCED HERE (spec 6.3): `publish` rebuilds every event from
// an allow-list of metadata fields, so no caller can put terminal bytes, prompt
// text, or file contents on this stream even by accident. What happens in the
// terminal is the user's business.

import { DurableObject } from 'cloudflare:workers';
import type { Env } from './types';

/** Run lifecycle as reported on the stream (the web client's `RunState`). */
export type EventRunState = 'pending' | 'running' | 'stopping' | 'exited' | 'failed';

/** A run is waiting for the user, or has stopped waiting (spec 6.2). */
export interface AttentionEventPayload {
  type: 'attention';
  computer: string;
  runId: string;
  state: 'waiting' | 'cleared';
  /** Generic terminal signal class (spec 6.1): bell | osc | blocked_read. */
  kind?: string;
  at?: number;
  seq?: number;
}

/** A run changed lifecycle state (spec 5.5 completion included). */
export interface RunEventPayload {
  type: 'run';
  computer: string;
  runId: string;
  state: EventRunState;
  exitCode?: number | null;
  at?: number;
  seq?: number;
}

/** A computer changed state (spec §2 states; e.g. a write-triggered wake). */
export interface StateEventPayload {
  type: 'state';
  computer: string;
  state: string;
  at?: number;
  seq?: number;
}

/** One content-free fleet event. */
export type FleetEvent = AttentionEventPayload | RunEventPayload | StateEventPayload;

const RUN_STATES: ReadonlySet<string> = new Set<EventRunState>([
  'pending',
  'running',
  'stopping',
  'exited',
  'failed',
]);

/**
 * Rebuild an event from allow-listed fields only — the content-free guarantee
 * (spec 6.3). Returns null for an event that is not well-formed, so a bad
 * publish is dropped rather than streamed.
 */
export function sanitizeEvent(e: FleetEvent, seq: number, now: number): FleetEvent | null {
  if (typeof e?.computer !== 'string' || e.computer === '') return null;
  const at = typeof e.at === 'number' && Number.isFinite(e.at) ? e.at : now;
  if (e.type === 'attention') {
    if (typeof e.runId !== 'string' || e.runId === '') return null;
    if (e.state !== 'waiting' && e.state !== 'cleared') return null;
    const out: AttentionEventPayload = {
      type: 'attention',
      seq,
      at,
      computer: e.computer,
      runId: e.runId,
      state: e.state,
    };
    if (typeof e.kind === 'string' && e.kind !== '') out.kind = e.kind;
    return out;
  }
  if (e.type === 'run') {
    if (typeof e.runId !== 'string' || e.runId === '') return null;
    if (typeof e.state !== 'string' || !RUN_STATES.has(e.state)) return null;
    const out: RunEventPayload = {
      type: 'run',
      seq,
      at,
      computer: e.computer,
      runId: e.runId,
      state: e.state,
    };
    if (e.exitCode === null) out.exitCode = null;
    else if (typeof e.exitCode === 'number' && Number.isFinite(e.exitCode)) out.exitCode = e.exitCode;
    return out;
  }
  if (e.type === 'state') {
    if (typeof e.state !== 'string' || e.state === '') return null;
    return { type: 'state', seq, at, computer: e.computer, state: e.state };
  }
  return null;
}

/** Serialize one event as an SSE record. */
export function sseRecord(e: FleetEvent): string {
  return `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}

/** The comment line sent on connect: `EventSource` ignores comments, so this
 *  flushes headers without delivering a bogus event to the client. */
export const SSE_READY = ': ready\n\n';

/** Max queued writes before a stalled subscriber is dropped. */
const MAX_INFLIGHT = 128;

interface Subscriber {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  inflight: number;
}

export class EventsDO extends DurableObject<Env> {
  #subs = new Set<Subscriber>();
  #encoder = new TextEncoder();
  // Stream sequence. Seeded from the wall clock so it keeps increasing across a
  // hub restart — the client de-duplicates on `seq` per entity and would drop
  // fresh events if the counter ever went backwards.
  #seq = Date.now();

  /** `GET /subscribe` -> an open `text/event-stream`. */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/subscribe')) return new Response('not found', { status: 404 });

    const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
    const sub: Subscriber = { writer: writable.getWriter(), inflight: 0 };
    this.#subs.add(sub);
    this.#writeRaw(sub, SSE_READY);
    request.signal?.addEventListener('abort', () => this.#drop(sub));

    return new Response(readable, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Defeat proxy buffering so events arrive when they happen.
        'x-accel-buffering': 'no',
      },
    });
  }

  /**
   * Fan one event out to every open stream. Called by ComputerDO over RPC.
   * Returns the number of streams it reached (0 when the user has nothing open —
   * an unheard event is dropped, not queued: the durable record of an attention
   * is the attention log in the computer's own DO, spec 6.2).
   */
  async publish(event: FleetEvent): Promise<number> {
    const clean = sanitizeEvent(event, ++this.#seq, Date.now());
    if (!clean) return 0;
    const record = sseRecord(clean);
    let delivered = 0;
    for (const sub of [...this.#subs]) {
      if (this.#writeRaw(sub, record)) delivered++;
    }
    return delivered;
  }

  /** Current subscriber count (introspection for tests/ops). */
  async subscriberCount(): Promise<number> {
    return this.#subs.size;
  }

  #writeRaw(sub: Subscriber, text: string): boolean {
    if (sub.inflight > MAX_INFLIGHT) {
      this.#drop(sub);
      return false;
    }
    sub.inflight++;
    sub.writer.write(this.#encoder.encode(text)).then(
      () => {
        sub.inflight--;
      },
      () => this.#drop(sub),
    );
    return true;
  }

  #drop(sub: Subscriber): void {
    if (!this.#subs.delete(sub)) return;
    void sub.writer.close().catch(() => undefined);
  }
}
