// The `/api/events` subscription (spec 6.2).
//
// A thin, injectable wrapper over `EventSource`. The browser reconnects an
// EventSource on its own, but it gives up permanently on some errors, so this
// adds an explicit reconnect with backoff — the attention badge must survive a
// laptop sleeping, a deploy, or a proxy hiccup, since spec 1.3 says the user
// disconnects and comes back.
//
// The stream never blocks the interface: nothing here is awaited by a view.

import { eventsUrl } from '../api/client';
import { parseEventData } from './protocol';
import type { MariEvent } from '../api/types';

/** The bit of EventSource this module uses, so tests can inject a fake. */
export interface EventSourceLike {
  onmessage: ((ev: { data: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
  /** Present on a real EventSource; used for the NAMED event types below. */
  addEventListener?(type: string, listener: (ev: { data: string }) => void): void;
  close(): void;
}

/**
 * The SSE event names the control plane emits (`event: attention` etc.).
 *
 * This matters more than it looks: `EventSource.onmessage` fires ONLY for
 * records with no `event:` field. A named record is delivered exclusively to a
 * listener registered for that name, so a client that wires up `onmessage`
 * alone silently receives nothing — the attention badge would never appear and
 * no error would be reported anywhere.
 */
export const EVENT_NAMES = ['attention', 'run', 'state'] as const;

export type EventSourceFactory = (url: string) => EventSourceLike;

export interface EventStreamOptions {
  url?: string;
  onEvent(event: MariEvent): void;
  onOpen?(): void;
  /** Called when a source fails and the explicit retry window begins. */
  onDisconnect?(): void;
  /** Called for a payload that failed validation (dropped, not thrown). */
  onInvalid?(data: string): void;
  factory?: EventSourceFactory;
  backoffMs?: number;
  maxBackoffMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (handle: number) => void;
}

const defaultFactory: EventSourceFactory = (url) =>
  new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;

/** A reconnecting subscription to the content-free server event stream. */
export class EventStream {
  #opts: Required<
    Pick<EventStreamOptions, 'url' | 'factory' | 'backoffMs' | 'maxBackoffMs' | 'setTimeoutFn' | 'clearTimeoutFn'>
  > &
    EventStreamOptions;
  #es: EventSourceLike | null = null;
  #closed = false;
  #backoff: number;
  #timer: number | null = null;

  constructor(opts: EventStreamOptions) {
    this.#opts = {
      url: opts.url ?? eventsUrl(),
      factory: opts.factory ?? defaultFactory,
      backoffMs: opts.backoffMs ?? 500,
      maxBackoffMs: opts.maxBackoffMs ?? 10_000,
      setTimeoutFn: opts.setTimeoutFn ?? ((fn, ms) => setTimeout(fn, ms) as unknown as number),
      clearTimeoutFn: opts.clearTimeoutFn ?? ((h) => clearTimeout(h)),
      ...opts,
    };
    this.#backoff = this.#opts.backoffMs;
  }

  /** Open the stream. Idempotent while already open. */
  connect(): void {
    if (this.#closed || this.#es !== null) return;
    const es = this.#opts.factory(this.#opts.url);
    this.#es = es;
    es.onopen = () => {
      this.#backoff = this.#opts.backoffMs;
      this.#opts.onOpen?.();
    };
    const deliver = (ev: { data: string }): void => {
      const event = parseEventData(ev.data);
      if (event === null) {
        this.#opts.onInvalid?.(ev.data);
        return;
      }
      this.#opts.onEvent(event);
    };
    // Unnamed records…
    es.onmessage = deliver;
    // …and every named one (see EVENT_NAMES). Each record reaches exactly one
    // of these paths, so nothing is delivered twice.
    for (const name of EVENT_NAMES) es.addEventListener?.(name, deliver);
    es.onerror = () => {
      // EventSource may or may not recover on its own; drop it and retry
      // ourselves so the behaviour is the same in every browser.
      this.#dropSocket();
      this.#opts.onDisconnect?.();
      if (!this.#closed) this.#scheduleReconnect();
    };
  }

  /** Close permanently; no further reconnects. */
  close(): void {
    this.#closed = true;
    if (this.#timer !== null) {
      this.#opts.clearTimeoutFn(this.#timer);
      this.#timer = null;
    }
    this.#dropSocket();
  }

  #dropSocket(): void {
    if (this.#es === null) return;
    try {
      this.#es.close();
    } catch {
      /* already gone */
    }
    this.#es = null;
  }

  #scheduleReconnect(): void {
    if (this.#timer !== null) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, this.#opts.maxBackoffMs);
    this.#timer = this.#opts.setTimeoutFn(() => {
      this.#timer = null;
      this.connect();
    }, delay);
  }
}
