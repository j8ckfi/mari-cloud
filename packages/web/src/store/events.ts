// Live server events as zustand state (decisions.md: zustand for UI state).
//
// The model itself is the pure reducer in `../events/reducer`; this store is
// only the place it lives and the socket that feeds it. Keeping the fold pure
// is what lets the out-of-order/duplicate behaviour be tested without a server.

import { create } from 'zustand';
import { EventStream, type EventStreamOptions } from '../events/source';
import {
  applyEvent,
  initialEventsModel,
  type EventsModel,
} from '../events/reducer';
import type { MariEvent } from '../api/types';

interface EventsState {
  model: EventsModel;
  connected: boolean;
  /** Fold one event in. Exposed for tests and for local optimistic updates. */
  push(event: MariEvent): void;
  setConnected(connected: boolean): void;
  reset(): void;
}

export const useEventsStore = create<EventsState>((set) => ({
  model: initialEventsModel(),
  connected: false,
  push: (event) => set((s) => ({ model: applyEvent(s.model, event) })),
  setConnected: (connected) => set({ connected }),
  reset: () => set({ model: initialEventsModel(), connected: false }),
}));

export const eventsStore = useEventsStore;

/**
 * Open the shared event stream and feed the store. Returns a disposer.
 *
 * `overrides.onEvent` runs AFTER the store has folded the event in (it never
 * replaces the fold), which is where callers hang cache invalidation. Other
 * overrides — notably `factory` — let a test drive the stream without a server.
 */
export function connectEvents(overrides: Partial<EventStreamOptions> = {}): () => void {
  const { onEvent: after, onOpen: afterOpen, onDisconnect: afterDisconnect, ...rest } = overrides;
  const stream = new EventStream({
    ...rest,
    onEvent: (event) => {
      useEventsStore.getState().push(event);
      after?.(event);
    },
    onOpen: () => {
      useEventsStore.getState().setConnected(true);
      afterOpen?.();
    },
    onDisconnect: () => {
      useEventsStore.getState().setConnected(false);
      afterDisconnect?.();
    },
  });
  stream.connect();
  return () => {
    stream.close();
    useEventsStore.getState().setConnected(false);
  };
}
