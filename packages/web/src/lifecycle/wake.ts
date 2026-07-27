// Explicit wake, with the truth about refusals (spec 8.3).
//
// `POST /api/computers/:id/wake` is honest in every outcome: 200 awake/waking,
// 202 `wake_retrying` with the time the Durable Object will try again (the
// Cloudflare destroy→start refusal window), or 503 with a reason
// (`substrate_not_configured`, no capacity, daemon down). A refusal is a
// DURABLE fact the user must be able to see and act on — not a toast that
// vanished, and never a spinner. This store keeps one notice per computer,
// auto-retries at the server's own `retryAt`, and clears itself on success.

import { create } from 'zustand';
import { wakeComputer } from '../api/client';
import type { WakeOutcome } from '../api/types';

/** The persistent wake notice for one computer, or null for none. */
export type WakeNotice =
  | {
      phase: 'retrying';
      error: string;
      /** When the server will retry (Unix ms), or null if it did not say. */
      retryAt: number | null;
      attempts: number;
    }
  | { phase: 'refused'; error: string; attempts: number }
  | null;

interface WakeState {
  notices: Record<string, WakeNotice>;
  /** Ask the control plane to wake `computer` and record the outcome. */
  requestWake(computer: string): Promise<WakeOutcome | null>;
  clear(computer: string): void;
  /** Test seam. */
  resetWakeNotices(): void;
}

/** Injectable for tests. */
export interface WakeDeps {
  wake: (computer: string) => Promise<WakeOutcome>;
  setTimeoutFn: (fn: () => void, ms: number) => number;
  now: () => number;
}

let deps: WakeDeps = {
  wake: wakeComputer,
  setTimeoutFn: (fn, ms) => setTimeout(fn, ms) as unknown as number,
  now: () => Date.now(),
};

/** Replace the store's dependencies (tests). Returns a restore function. */
export function setWakeDeps(next: Partial<WakeDeps>): () => void {
  const prev = deps;
  deps = { ...deps, ...next };
  return () => {
    deps = prev;
  };
}

/** Floor for the client-side auto-retry, so a past/absent retryAt cannot spin. */
const MIN_RETRY_DELAY_MS = 2_000;
/** With no server-provided retryAt, retry roughly when a cold start would land. */
const DEFAULT_RETRY_DELAY_MS = 15_000;

const retryTimers = new Map<string, number>();

export const useWakeStore = create<WakeState>((set, get) => ({
  notices: {},

  requestWake: async (computer) => {
    let outcome: WakeOutcome;
    try {
      outcome = await deps.wake(computer);
    } catch {
      // Transport failure: the fleet/events views carry the state; leave any
      // existing notice standing rather than inventing a new claim.
      return null;
    }
    const prev = get().notices[computer];
    const attempts = (prev?.attempts ?? 0) + 1;

    if (outcome.outcome === 'ok') {
      get().clear(computer);
      return outcome;
    }

    if (outcome.outcome === 'retrying') {
      set((s) => ({
        notices: {
          ...s.notices,
          [computer]: { phase: 'retrying', error: outcome.error, retryAt: outcome.retryAt, attempts },
        },
      }));
      // Retry when the SERVER said it would be worth asking again. The DO's
      // own schedule is bounded; the client only follows it.
      const delay = Math.max(
        MIN_RETRY_DELAY_MS,
        outcome.retryAt !== null ? outcome.retryAt - deps.now() : DEFAULT_RETRY_DELAY_MS,
      );
      const existing = retryTimers.get(computer);
      if (existing !== undefined) clearTimeout(existing);
      retryTimers.set(
        computer,
        deps.setTimeoutFn(() => {
          retryTimers.delete(computer);
          // Only keep retrying while the notice is still standing.
          if (get().notices[computer]?.phase === 'retrying') void get().requestWake(computer);
        }, delay),
      );
      return outcome;
    }

    set((s) => ({
      notices: { ...s.notices, [computer]: { phase: 'refused', error: outcome.error, attempts } },
    }));
    return outcome;
  },

  clear: (computer) => {
    const timer = retryTimers.get(computer);
    if (timer !== undefined) {
      clearTimeout(timer);
      retryTimers.delete(computer);
    }
    set((s) => {
      if (!(computer in s.notices)) return s;
      const notices = { ...s.notices };
      delete notices[computer];
      return { notices };
    });
  },

  resetWakeNotices: () => {
    for (const t of retryTimers.values()) clearTimeout(t);
    retryTimers.clear();
    set({ notices: {} });
  },
}));

/** Plain-English reading of a wake refusal reason. */
export function wakeErrorCopy(error: string): { title: string; body: string } {
  switch (error) {
    case 'substrate_not_configured':
      return {
        title: 'This deployment cannot wake computers yet',
        body: 'No substrate is configured, so there is nowhere to materialize the computer. Browsing files and history still works. If you operate this instance, configure a substrate (see deploy/DEPLOY.md); otherwise contact the operator.',
      };
    case 'wake_retrying':
      return {
        title: 'The substrate refused the wake — retrying',
        body: 'The platform is temporarily refusing to start this computer (this happens after a recent deep sleep). Your queued work is preserved and will start as soon as a retry is accepted.',
      };
    default:
      return {
        title: 'The computer could not be woken',
        body: `The substrate refused the wake (${error}). The computer is unchanged and still browsable; its queued work is preserved. Trying again is safe.`,
      };
  }
}
