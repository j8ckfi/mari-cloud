// The live-events reducer (spec 6.2, spec 8.2).
//
// `/api/events` is a best-effort push stream: it reconnects, so it REPLAYS, and
// nothing guarantees that two events about different things arrive in the order
// the server minted them. The fleet home and the workspace badges are rendered
// from the result, so this fold has to be safe under both.
//
// The invariant that makes it safe: every event names an entity (a run, a
// computer, or one run's attention), and each entity remembers the highest
// `seq` applied to it. An event whose `seq` is not strictly greater than that
// is DROPPED. This single rule gives:
//
//   * duplicate delivery is a no-op (equal seq is not greater), and
//   * a late event cannot undo a newer one for the same entity, while
//   * events about different entities never block each other (which a single
//     global high-water mark would wrongly do after a reconnect replay).
//
// Run states additionally go through the run state machine, so a reordered
// `running` after an `exited` cannot resurrect a finished run even if the
// server minted it with a higher seq.

import type { ComputerState } from '@mari/shared';
import type { AttentionKind } from '@mari/shared';
import type { MariEvent, RunState } from '../api/types';
import { isActive, mergeRunState } from '../runs/state';

/** One run's live state, as learned from the stream. */
export interface LiveRun {
  runId: string;
  computer: string;
  state: RunState;
  exitCode: number | null;
  /** Last event time for this run, Unix ms. */
  at: number;
}

/** One waiting attention (spec 6.2). Metadata only — there is no content. */
export interface LiveAttention {
  computer: string;
  runId: string;
  kind: AttentionKind | null;
  at: number;
}

/** The folded live view of the fleet. */
export interface EventsModel {
  /** Computer state as last pushed; absent when the stream said nothing yet. */
  states: Readonly<Record<string, ComputerState>>;
  /** Runs seen on the stream, keyed `computer/runId`. */
  runs: Readonly<Record<string, LiveRun>>;
  /** Waiting attention, keyed `computer/runId`; cleared entries are removed. */
  attention: Readonly<Record<string, LiveAttention>>;
  /** Highest applied seq per entity key — the de-duplication high-water marks. */
  applied: Readonly<Record<string, number>>;
  /** Count of events actually folded in (dropped duplicates excluded). */
  applies: number;
}

export function initialEventsModel(): EventsModel {
  return { states: {}, runs: {}, attention: {}, applied: {}, applies: 0 };
}

/** The entity key an event advances. */
export function eventKey(event: MariEvent): string {
  switch (event.type) {
    case 'state':
      return `state:${event.computer}`;
    case 'run':
      return `run:${event.computer}/${event.runId}`;
    case 'attention':
      return `attn:${event.computer}/${event.runId}`;
  }
}

/** The key runs and attention are stored under. */
export function runKey(computer: string, runId: string): string {
  return `${computer}/${runId}`;
}

/**
 * Fold one event. Returns the SAME model object when the event is dropped, so
 * a caller can cheaply tell whether anything changed (and React can skip a
 * render on a duplicate).
 */
export function applyEvent(model: EventsModel, event: MariEvent): EventsModel {
  const key = eventKey(event);
  const seen = model.applied[key];
  if (seen !== undefined && event.seq <= seen) return model; // duplicate or stale

  const applied = { ...model.applied, [key]: event.seq };
  const applies = model.applies + 1;

  switch (event.type) {
    case 'state':
      return {
        ...model,
        applied,
        applies,
        states: { ...model.states, [event.computer]: event.state },
      };

    case 'run': {
      const k = runKey(event.computer, event.runId);
      const prev = model.runs[k];
      // The state machine, not the event, decides the resulting state: a
      // reordered `running` after an `exited` must not resurrect the run.
      const state = prev === undefined ? event.state : mergeRunState(prev.state, event.state);
      const exitCode =
        event.exitCode !== undefined ? event.exitCode : (prev?.exitCode ?? null);
      const run: LiveRun = { runId: event.runId, computer: event.computer, state, exitCode, at: event.at };
      const next: EventsModel = { ...model, applied, applies, runs: { ...model.runs, [k]: run } };
      // A run that is no longer active cannot still be waiting for input.
      if (!isActive(state) && next.attention[k] !== undefined) {
        const attention = { ...next.attention };
        delete attention[k];
        return { ...next, attention };
      }
      return next;
    }

    case 'attention': {
      const k = runKey(event.computer, event.runId);
      if (event.state === 'cleared') {
        if (model.attention[k] === undefined) return { ...model, applied, applies };
        const attention = { ...model.attention };
        delete attention[k];
        return { ...model, applied, applies, attention };
      }
      const item: LiveAttention = {
        computer: event.computer,
        runId: event.runId,
        kind: event.kind ?? null,
        at: event.at,
      };
      return { ...model, applied, applies, attention: { ...model.attention, [k]: item } };
    }
  }
}

/** Fold a sequence of events. */
export function applyEvents(model: EventsModel, events: readonly MariEvent[]): EventsModel {
  return events.reduce(applyEvent, model);
}

// ---- selectors ----

/** Live computer state, or null when the stream has said nothing about it. */
export function liveState(model: EventsModel, computer: string): ComputerState | null {
  return model.states[computer] ?? null;
}

/** Waiting attention for one computer, oldest first (the queue order). */
export function attentionFor(model: EventsModel, computer: string): LiveAttention[] {
  return Object.values(model.attention)
    .filter((a) => a.computer === computer)
    .sort((a, b) => a.at - b.at || (a.runId < b.runId ? -1 : 1));
}

/** Every waiting attention across the fleet, oldest first. */
export function allAttention(model: EventsModel): LiveAttention[] {
  return Object.values(model.attention).sort(
    (a, b) => a.at - b.at || (a.computer < b.computer ? -1 : 1),
  );
}

/** Number of runs currently active on a computer, per the stream. */
export function liveActiveRuns(model: EventsModel, computer: string): number {
  return Object.values(model.runs).filter((r) => r.computer === computer && isActive(r.state))
    .length;
}

/** Live view of one run, or null. */
export function liveRun(model: EventsModel, computer: string, runId: string): LiveRun | null {
  return model.runs[runKey(computer, runId)] ?? null;
}

/**
 * The attention badge count for a fleet card. The REST fleet count and the live
 * stream are two views of the same thing that can each be ahead of the other: a
 * page loaded a minute ago has a stale REST count, and a stream that just
 * connected has not replayed the older waiting events. Taking the MAXIMUM never
 * hides a waiting run — the failure this badge exists to prevent (spec 6.2) —
 * at the cost of briefly over-counting after a clear, which the next fleet
 * refetch settles.
 */
export function badgeCount(serverCount: number, liveCount: number): number {
  return Math.max(serverCount, liveCount);
}
