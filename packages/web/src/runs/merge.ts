// Merging the two views of a computer's runs into the one the user sees.
//
// The runs list has two sources that are each sometimes ahead of the other:
//
//   * `GET /runs` — durable, complete, and as stale as the last poll.
//   * `/api/events` — immediate, but only covers what happened while this tab
//     was listening, and it can deliver late or twice (see events/reducer).
//
// Neither may win outright. A run the user just started exists only in the
// stream; a run from yesterday exists only in REST. So the list is a merge, and
// the state of a run present in both is resolved by the run state machine —
// never by "whichever I read last", which is how a finished run gets shown as
// running again.

import type { RunSummary } from '../api/types';
import type { EventsModel } from '../events/reducer';
import { liveRun } from '../events/reducer';
import { isActive, mergeRunState } from './state';
import type { RunState } from './state';
import type { DiffSummary } from '@mari/shared';

/** One row of the runs list. */
export interface RunRow {
  id: string;
  state: RunState;
  argv: string[];
  cwd: string | null;
  exitCode: number | null;
  attention: boolean;
  startedAt: number;
  endedAt: number | null;
  diff: DiffSummary | null;
  review: RunSummary['review'];
  /** True when this row exists only because of a live event (no REST row yet). */
  liveOnly: boolean;
}

function rowFromSummary(s: RunSummary): RunRow {
  return {
    id: s.id,
    state: s.state,
    argv: s.argv,
    cwd: s.cwd,
    exitCode: s.exitCode,
    attention: s.attention,
    startedAt: s.startedAt,
    endedAt: s.endedAt,
    diff: s.diff,
    review: s.review,
    liveOnly: false,
  };
}

/**
 * Merge the REST run list for `computer` with the live event model.
 * Newest first. A run in both sources takes the further-along state, the live
 * exit code if it has one, and is flagged for attention if EITHER source says
 * so — a waiting run that the badge missed is the failure spec 6.2 exists to
 * prevent.
 */
export function mergeRuns(
  computer: string,
  rest: readonly RunSummary[],
  live: EventsModel,
): RunRow[] {
  const rows = new Map<string, RunRow>();
  for (const summary of rest) rows.set(summary.id, rowFromSummary(summary));

  for (const run of Object.values(live.runs)) {
    if (run.computer !== computer) continue;
    const existing = rows.get(run.runId);
    if (existing === undefined) {
      rows.set(run.runId, {
        id: run.runId,
        state: run.state,
        argv: [],
        cwd: null,
        exitCode: run.exitCode,
        attention: false,
        startedAt: run.at,
        endedAt: isActive(run.state) ? null : run.at,
        diff: null,
        review: 'pending',
        liveOnly: true,
      });
      continue;
    }
    existing.state = mergeRunState(existing.state, run.state);
    if (run.exitCode !== null) existing.exitCode = run.exitCode;
    if (!isActive(existing.state) && existing.endedAt === null) existing.endedAt = run.at;
  }

  for (const attention of Object.values(live.attention)) {
    if (attention.computer !== computer) continue;
    const row = rows.get(attention.runId);
    if (row !== undefined) row.attention = true;
  }

  return [...rows.values()].sort(
    (a, b) => b.startedAt - a.startedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
  );
}

/** Runs still executing, for the "active runs" count (spec 8.2). */
export function activeRows(rows: readonly RunRow[]): RunRow[] {
  return rows.filter((r) => isActive(r.state));
}

/** The most recent run matching a predicate, for context-free commands. */
export function newestRow(
  rows: readonly RunRow[],
  predicate: (row: RunRow) => boolean,
): RunRow | null {
  return rows.find(predicate) ?? null;
}
