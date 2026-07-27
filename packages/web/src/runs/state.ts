// The client-side run state machine (spec 5).
//
// The supervisor owns each run (spec 5.1); this module is only the CLIENT's
// model of what it has been told. Its whole job is to fold a stream of
// out-of-order, duplicated, and late server events into one state per run
// without ever telling the user something false — specifically, without
// resurrecting a finished run.
//
// The rules, in order of importance:
//
//  1. `exited` and `failed` are TERMINAL and absorbing. A late `started` for a
//     run that already ended (a reordered SSE delivery, or a reconnect replay)
//     must not put it back on the "running" list — spec 5.5 says the supervisor
//     sends a completion event, and once we have it, it is the truth.
//  2. `stopping` is sticky against `started`: the user asked for a stop, so the
//     interface must not flip back to "running" on a late start.
//  3. Every transition is idempotent, so applying the same event twice is a
//     no-op. Duplicate delivery is normal on an SSE reconnect.

import type { RunState } from '../api/types';

export type { RunState };

/** What the server told us about a run. */
export type RunTransition =
  /** The control plane accepted `POST /runs` (the supervisor may not have started yet). */
  | { t: 'accepted' }
  /** The supervisor reported `run_started` (contracts §5.1). */
  | { t: 'started' }
  /** The user asked for a stop and it was accepted. */
  | { t: 'stop_requested' }
  /** The supervisor reported `run_completed` (contracts §5.1). */
  | { t: 'completed'; exitCode?: number | null }
  /** The run could not be started, or the control plane reported a failure. */
  | { t: 'failed' };

/** The state a freshly accepted run is in. */
export const INITIAL_RUN_STATE: RunState = 'pending';

const TERMINAL: ReadonlySet<RunState> = new Set<RunState>(['exited', 'failed']);
const ACTIVE: ReadonlySet<RunState> = new Set<RunState>(['pending', 'running', 'stopping']);

/** Whether a run has finished; a terminal state never changes again. */
export function isTerminal(state: RunState): boolean {
  return TERMINAL.has(state);
}

/** Whether a run is still executing (or about to). Counted by the fleet card. */
export function isActive(state: RunState): boolean {
  return ACTIVE.has(state);
}

/**
 * Apply one transition. Pure, total, and idempotent: any (state, transition)
 * pair yields a state, and applying the same transition twice changes nothing
 * after the first time.
 */
export function nextRunState(state: RunState, tr: RunTransition): RunState {
  // Rule 1: terminal states absorb everything.
  if (isTerminal(state)) return state;

  switch (tr.t) {
    case 'completed':
      return 'exited';
    case 'failed':
      return 'failed';
    case 'stop_requested':
      return 'stopping';
    case 'started':
      // Rule 2: a late `started` must not undo a requested stop.
      return state === 'stopping' ? 'stopping' : 'running';
    case 'accepted':
      // An `accepted` for a run we already know more about is stale news.
      return state === 'pending' ? 'pending' : state;
  }
}

/**
 * Merge two observations of the same run's state, keeping the one that is
 * further along. Used when a REST snapshot and a live event disagree, which
 * happens whenever a poll response was in flight while an event arrived.
 * Ordering is the lifecycle order; terminal states win over active ones, and
 * `failed` loses to `exited` only if we actually saw an exit.
 */
export function mergeRunState(a: RunState, b: RunState): RunState {
  return RANK[a] >= RANK[b] ? a : b;
}

const RANK: Record<RunState, number> = {
  pending: 0,
  running: 1,
  stopping: 2,
  exited: 3,
  failed: 3,
};

/** Short human label for the runs list. */
export function runStateLabel(state: RunState, exitCode: number | null): string {
  switch (state) {
    case 'pending':
      return 'pending';
    case 'running':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'failed':
      return 'failed';
    case 'exited':
      return exitCode === null ? 'exited' : `exit ${exitCode}`;
  }
}

/**
 * A run id cut down for display. Run ids are opaque 32-char hex strings; the
 * bar, the notice line and the tab all only need enough to tell two runs
 * apart. The full id belongs in a tooltip (`title`), not in the label.
 */
export function shortRunId(run: string): string {
  return run.length > 10 ? `${run.slice(0, 8)}…` : run;
}

/**
 * Whether a finished run has changes to review (spec 5.3). A run that never
 * started, or that changed nothing, has no review to offer.
 */
export function hasReviewableResult(
  state: RunState,
  diff: { added: number; modified: number; removed: number } | null,
): boolean {
  if (state !== 'exited') return false;
  if (diff === null) return false;
  return diff.added + diff.modified + diff.removed > 0;
}
