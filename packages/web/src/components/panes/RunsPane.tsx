import { useMemo } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { stopRun } from '../../api/client';
import { queryKeys, useRuns } from '../../api/queries';
import { useEventsStore } from '../../store/events';
import { useUiStore } from '../../store/ui';
import { mergeRuns, type RunRow } from '../../runs/merge';
import { hasReviewableResult, isActive, runStateLabel } from '../../runs/state';

/**
 * The runs list of one computer (spec 5). Rows come from the durable REST list
 * merged with the live event stream (see runs/merge), so a run started a second
 * ago and a run from last week are in the same list, in the same order, with no
 * loading state in between (spec 8.3).
 *
 * Every row is fully operable: attach to its terminal (spec 7.1 — the pane is a
 * view of the run, opening it does not own or restart anything), stop it, and
 * review its result (spec 5.3).
 */
export function RunsPane({ computer }: { computer: string }) {
  const runsQ = useRuns(computer);
  const model = useEventsStore((s) => s.model);
  const openRunTerminal = useUiStore((s) => s.openRunTerminal);
  const openRunDiff = useUiStore((s) => s.openRunDiff);
  const setRunLauncherOpen = useUiStore((s) => s.setRunLauncherOpen);
  const qc = useQueryClient();

  const rows = useMemo(
    () => mergeRuns(computer, runsQ.data?.runs ?? [], model),
    [computer, runsQ.data, model],
  );

  const onStop = async (row: RunRow): Promise<void> => {
    try {
      await stopRun(computer, row.id);
    } finally {
      void qc.invalidateQueries({ queryKey: queryKeys.runs(computer) });
    }
  };

  return (
    <div className="runs" data-testid="runs-pane" data-computer={computer}>
      <div className="runs-bar">
        <span className="hint">
          {rows.length} run{rows.length === 1 ? '' : 's'}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button type="button" onClick={() => setRunLauncherOpen(true)} data-testid="runs-new">
          Run command
        </button>
      </div>

      <div className="runs-list" data-testid="runs-list">
        {rows.length === 0 && (
          <div className="empty-note" data-testid="runs-empty">
            No runs yet. Press <kbd>⌥R</kbd> to start one.
          </div>
        )}
        {rows.map((row) => (
          <div
            key={row.id}
            className="run-row"
            data-testid="run-row"
            data-run-id={row.id}
            data-state={row.state}
            data-attention={row.attention}
          >
            <span className={`run-state ${row.state}`} data-testid="run-state">
              {runStateLabel(row.state, row.exitCode)}
            </span>
            {row.attention && (
              <button
                type="button"
                className="attn-badge"
                data-testid="run-attention"
                title="This run is waiting for you — open its terminal"
                onClick={() => openRunTerminal(computer, row.id)}
              >
                waiting
              </button>
            )}
            <span className="run-argv" data-testid="run-argv" title={row.argv.join(' ')}>
              {row.argv.length > 0 ? row.argv.join(' ') : row.id}
            </span>
            <span className="spacer" style={{ flex: 1 }} />
            {row.diff !== null && (
              <span className="hint" data-testid="run-diff-counts">
                +{row.diff.added} ~{row.diff.modified} -{row.diff.removed}
              </span>
            )}
            <button
              type="button"
              data-testid="run-attach"
              onClick={() => openRunTerminal(computer, row.id)}
              title="Open this run’s terminal pane"
            >
              Terminal
            </button>
            {hasReviewableResult(row.state, row.diff) && (
              <button
                type="button"
                data-testid="run-review"
                onClick={() => openRunDiff(computer, row.id)}
                title="Review this run’s changes (keep or revert)"
              >
                Review
              </button>
            )}
            {isActive(row.state) && (
              <button
                type="button"
                data-testid="run-stop"
                disabled={row.state === 'stopping'}
                onClick={() => void onStop(row)}
              >
                Stop
              </button>
            )}
            {row.review !== 'pending' && (
              <span className="hint" data-testid="run-review-state">
                {row.review}
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
