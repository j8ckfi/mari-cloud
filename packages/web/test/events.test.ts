import { describe, it, expect, vi } from 'vitest';
import {
  allAttention,
  applyEvent,
  applyEvents,
  attentionFor,
  badgeCount,
  eventKey,
  initialEventsModel,
  liveActiveRuns,
  liveRun,
  liveState,
} from '../src/events/reducer';
import { parseEventData, parseMariEvent } from '../src/events/protocol';
import { EventStream, type EventSourceLike } from '../src/events/source';
import type { MariEvent } from '../src/api/types';

const attn = (over: Partial<Extract<MariEvent, { type: 'attention' }>> = {}): MariEvent => ({
  type: 'attention',
  seq: 1,
  at: 1000,
  computer: 'c1',
  runId: 'r1',
  state: 'waiting',
  ...over,
});

const run = (over: Partial<Extract<MariEvent, { type: 'run' }>> = {}): MariEvent => ({
  type: 'run',
  seq: 1,
  at: 1000,
  computer: 'c1',
  runId: 'r1',
  state: 'running',
  ...over,
});

const state = (over: Partial<Extract<MariEvent, { type: 'state' }>> = {}): MariEvent => ({
  type: 'state',
  seq: 1,
  at: 1000,
  computer: 'c1',
  state: 'awake',
  ...over,
});

describe('event payload validation (spec 6.2: content-free)', () => {
  it('accepts a well-formed attention event and carries no content field', () => {
    const parsed = parseMariEvent({
      type: 'attention',
      seq: 4,
      at: 12,
      computer: 'c1',
      runId: 'r1',
      state: 'waiting',
      kind: 'bell',
    });
    expect(parsed).toEqual({
      type: 'attention',
      seq: 4,
      at: 12,
      computer: 'c1',
      runId: 'r1',
      state: 'waiting',
      kind: 'bell',
    });
  });

  it('DROPS any text a server tried to smuggle alongside an attention event', () => {
    // Spec 6.2/6.3: the event is content-free and the supervisor must not read
    // the prompt. If something upstream ever attached terminal text, the parsed
    // event has nowhere to keep it, so the UI cannot render it.
    const parsed = parseMariEvent({
      type: 'attention',
      seq: 1,
      at: 1,
      computer: 'c1',
      runId: 'r1',
      state: 'waiting',
      message: 'Allow write to /etc/passwd? [y/N]',
      grid: ['secret'],
    });
    expect(parsed).not.toBeNull();
    expect(Object.keys(parsed as object).sort()).toEqual([
      'at',
      'computer',
      'runId',
      'seq',
      'state',
      'type',
    ]);
    expect(JSON.stringify(parsed)).not.toContain('passwd');
  });

  it('accepts `run` as the alias of `runId` (the CBOR wire spells it `run`)', () => {
    const parsed = parseMariEvent({
      type: 'run',
      seq: 1,
      at: 1,
      computer: 'c1',
      run: 'r7',
      state: 'exited',
      exitCode: 2,
    });
    expect(parsed).toMatchObject({ type: 'run', runId: 'r7', state: 'exited', exitCode: 2 });
  });

  it('rejects malformed, unknown-typed and out-of-domain events', () => {
    expect(parseMariEvent(null)).toBeNull();
    expect(parseMariEvent('nope')).toBeNull();
    expect(parseMariEvent({ type: 'attention', seq: 1, at: 1, computer: 'c1' })).toBeNull(); // no run
    expect(parseMariEvent({ type: 'attention', seq: 1, at: 1, computer: 'c1', runId: 'r', state: 'x' })).toBeNull();
    expect(parseMariEvent({ type: 'run', seq: 1, at: 1, computer: 'c1', runId: 'r', state: 'zombie' })).toBeNull();
    expect(parseMariEvent({ type: 'state', seq: 1, at: 1, computer: 'c1', state: 'melted' })).toBeNull();
    expect(parseMariEvent({ type: 'gossip', seq: 1, at: 1, computer: 'c1' })).toBeNull();
    expect(parseMariEvent({ type: 'run', seq: '1', at: 1, computer: 'c1', runId: 'r', state: 'running' })).toBeNull();
    expect(parseEventData('{not json')).toBeNull();
  });

  it('drops an unknown attention kind but keeps the event', () => {
    const parsed = parseMariEvent({ ...attn(), kind: 'telepathy' });
    expect(parsed).not.toBeNull();
    expect((parsed as unknown as Record<string, unknown>)['kind']).toBeUndefined();
  });
});

describe('events reducer (duplicates, reordering)', () => {
  it('folds an attention event into a per-computer badge', () => {
    const m = applyEvent(initialEventsModel(), attn());
    expect(attentionFor(m, 'c1')).toHaveLength(1);
    expect(attentionFor(m, 'c1')[0]).toMatchObject({ computer: 'c1', runId: 'r1' });
    expect(attentionFor(m, 'other')).toEqual([]);
  });

  it('is a no-op for a duplicate delivery (same seq), object identity included', () => {
    const first = applyEvent(initialEventsModel(), attn({ seq: 5 }));
    const again = applyEvent(first, attn({ seq: 5 }));
    expect(again).toBe(first); // same object: nothing re-rendered
    expect(first.applies).toBe(1);
    expect(attentionFor(again, 'c1')).toHaveLength(1);
  });

  it('drops an out-of-order event for the same entity', () => {
    // waiting@2 then a late cleared@1 — the stale clear must NOT unbadge.
    const m = applyEvents(initialEventsModel(), [
      attn({ seq: 2, state: 'waiting' }),
      attn({ seq: 1, state: 'cleared' }),
    ]);
    expect(attentionFor(m, 'c1')).toHaveLength(1);
    expect(m.applies).toBe(1);

    // …and the properly-ordered clear does unbadge.
    const cleared = applyEvent(m, attn({ seq: 3, state: 'cleared' }));
    expect(attentionFor(cleared, 'c1')).toEqual([]);
  });

  it('does not let one entity’s seq block another entity’s events', () => {
    // A single global high-water mark would swallow the second event here.
    const m = applyEvents(initialEventsModel(), [
      attn({ seq: 10, runId: 'r-a' }),
      attn({ seq: 4, runId: 'r-b' }),
      state({ seq: 2, state: 'awake' }),
    ]);
    expect(attentionFor(m, 'c1').map((a) => a.runId).sort()).toEqual(['r-a', 'r-b']);
    expect(liveState(m, 'c1')).toBe('awake');
  });

  it('never resurrects a finished run, even from a higher-seq stale state', () => {
    const m = applyEvents(initialEventsModel(), [
      run({ seq: 1, state: 'running' }),
      run({ seq: 2, state: 'exited', exitCode: 0 }),
      run({ seq: 3, state: 'running' }), // reordered arrival, higher seq
    ]);
    expect(liveRun(m, 'c1', 'r1')?.state).toBe('exited');
    expect(liveActiveRuns(m, 'c1')).toBe(0);
  });

  it('clears a run’s attention when the run ends', () => {
    // A run that exited cannot still be waiting for the user's input.
    const m = applyEvents(initialEventsModel(), [
      attn({ seq: 1, state: 'waiting' }),
      run({ seq: 1, state: 'exited', exitCode: 0 }),
    ]);
    expect(attentionFor(m, 'c1')).toEqual([]);
  });

  it('counts active runs per computer', () => {
    const m = applyEvents(initialEventsModel(), [
      run({ seq: 1, runId: 'a', state: 'running' }),
      run({ seq: 1, runId: 'b', state: 'pending' }),
      run({ seq: 1, runId: 'c', state: 'exited', exitCode: 1 }),
      run({ seq: 1, runId: 'd', state: 'running', computer: 'c2' }),
    ]);
    expect(liveActiveRuns(m, 'c1')).toBe(2);
    expect(liveActiveRuns(m, 'c2')).toBe(1);
  });

  it('orders attention oldest-first across the fleet', () => {
    const m = applyEvents(initialEventsModel(), [
      attn({ seq: 1, at: 300, computer: 'c2', runId: 'r2' }),
      attn({ seq: 1, at: 100, computer: 'c1', runId: 'r1' }),
    ]);
    expect(allAttention(m).map((a) => a.runId)).toEqual(['r1', 'r2']);
  });

  it('keys events by entity, not by computer alone', () => {
    expect(eventKey(attn({ runId: 'r1' }))).not.toBe(eventKey(attn({ runId: 'r2' })));
    expect(eventKey(run({ runId: 'r1' }))).not.toBe(eventKey(attn({ runId: 'r1' })));
    expect(eventKey(state())).toBe('state:c1');
  });

  it('badge count never hides a waiting run', () => {
    expect(badgeCount(0, 1)).toBe(1); // live knows, REST has not caught up
    expect(badgeCount(3, 0)).toBe(3); // REST knows, stream just connected
    expect(badgeCount(2, 5)).toBe(5);
  });
});

/**
 * A hand-driven EventSource stand-in that behaves like the real one: a record
 * with an `event:` name goes ONLY to the listener registered for that name,
 * never to `onmessage`. The control plane names every record (`sseRecord`
 * writes `event: attention`), so a client wired to `onmessage` alone would
 * receive nothing at all — this fake is what makes that failure visible here
 * instead of in production.
 */
function fakeSource(): EventSourceLike & {
  emit(data: string, name?: string): void;
  fail(): void;
  closed: boolean;
} {
  const named = new Map<string, Array<(ev: { data: string }) => void>>();
  const es = {
    onmessage: null as ((ev: { data: string }) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
    onopen: null as ((ev: unknown) => void) | null,
    closed: false,
    addEventListener(type: string, listener: (ev: { data: string }) => void) {
      const list = named.get(type) ?? [];
      list.push(listener);
      named.set(type, list);
    },
    close() {
      this.closed = true;
    },
    /** Emit a record. With `name`, only that name's listeners see it. */
    emit(data: string, name?: string) {
      if (name === undefined) this.onmessage?.({ data });
      else for (const fn of named.get(name) ?? []) fn({ data });
    },
    fail() {
      this.onerror?.(new Error('boom'));
    },
  };
  return es;
}

describe('EventStream (spec 6.2 transport)', () => {
  it('parses payloads and hands over only valid events', () => {
    const sources: ReturnType<typeof fakeSource>[] = [];
    const seen: MariEvent[] = [];
    const invalid: string[] = [];
    const stream = new EventStream({
      url: '/api/events',
      onEvent: (e) => seen.push(e),
      onInvalid: (d) => invalid.push(d),
      factory: () => {
        const s = fakeSource();
        sources.push(s);
        return s;
      },
    });
    stream.connect();
    sources[0]!.emit(JSON.stringify(attn()));
    sources[0]!.emit('garbage');
    sources[0]!.emit(JSON.stringify({ type: 'run', seq: 1, at: 1, computer: 'c1' })); // no runId

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: 'attention', runId: 'r1' });
    expect(invalid).toEqual(['garbage', JSON.stringify({ type: 'run', seq: 1, at: 1, computer: 'c1' })]);
    stream.close();
    expect(sources[0]!.closed).toBe(true);
  });

  it('receives NAMED records, which is how the control plane sends them', () => {
    // `sseRecord` writes `event: attention\ndata: {…}`; a named record never
    // reaches `onmessage`. Subscribing only to `onmessage` would silently
    // deliver zero events — the badge would simply never appear.
    const sources: ReturnType<typeof fakeSource>[] = [];
    const seen: MariEvent[] = [];
    const stream = new EventStream({
      url: '/api/events',
      onEvent: (e) => seen.push(e),
      factory: () => {
        const s = fakeSource();
        sources.push(s);
        return s;
      },
    });
    stream.connect();

    sources[0]!.emit(JSON.stringify(attn({ seq: 1 })), 'attention');
    sources[0]!.emit(JSON.stringify(run({ seq: 2, state: 'exited', exitCode: 0 })), 'run');
    sources[0]!.emit(JSON.stringify(state({ seq: 3, state: 'waking' })), 'state');

    expect(seen.map((e) => e.type)).toEqual(['attention', 'run', 'state']);
    // …and each record was delivered exactly once, not once per listener.
    expect(seen).toHaveLength(3);
    stream.close();
  });

  it('reconnects with backoff after an error and stops when closed', () => {
    const sources: ReturnType<typeof fakeSource>[] = [];
    const timers: Array<{ fn: () => void; ms: number }> = [];
    const stream = new EventStream({
      url: '/api/events',
      onEvent: () => {},
      backoffMs: 100,
      maxBackoffMs: 400,
      factory: () => {
        const s = fakeSource();
        sources.push(s);
        return s;
      },
      setTimeoutFn: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimeoutFn: () => {},
    });
    stream.connect();
    expect(sources).toHaveLength(1);

    sources[0]!.fail();
    expect(sources[0]!.closed).toBe(true);
    expect(timers.map((t) => t.ms)).toEqual([100]);
    timers[0]!.fn();
    expect(sources).toHaveLength(2);

    sources[1]!.fail();
    expect(timers.map((t) => t.ms)).toEqual([100, 200]); // doubled
    timers[1]!.fn();
    expect(sources).toHaveLength(3);

    // A clean open resets the backoff.
    sources[2]!.onopen?.({});
    sources[2]!.fail();
    expect(timers.map((t) => t.ms)).toEqual([100, 200, 100]);

    // After close, a pending retry must not open a new source.
    stream.close();
    timers[2]!.fn();
    expect(sources).toHaveLength(3);
  });

  it('does not resubscribe while already connected', () => {
    const factory = vi.fn(() => fakeSource());
    const stream = new EventStream({ url: '/api/events', onEvent: () => {}, factory });
    stream.connect();
    stream.connect();
    expect(factory).toHaveBeenCalledTimes(1);
    stream.close();
  });
});
