import type { FleetComputer } from '../api/types';
import { ComputerCard } from './ComputerCard';
import { useEventsStore } from '../store/events';
import { attentionFor, badgeCount, liveActiveRuns, liveState } from '../events/reducer';

/**
 * Fleet home (spec 8.2). Renders whatever computers it is given, enriched with
 * whatever the live event stream has pushed since the fleet was fetched. Per
 * spec 8.3 there is deliberately NO loading/spinner state — before data arrives
 * it shows the first-run panel; cards appear as the fleet query resolves.
 * Opening a card never triggers a wake (spec 8.3).
 *
 * Spec 6.2: a waiting attention badges the card, and activating that badge
 * opens the terminal pane of the run that is waiting.
 *
 * Two states below the grid deserve their own note, because they are the only
 * things a brand-new user sees:
 *
 *   * **Empty.** An account with no computers is the normal first minute, not an
 *     error. It gets the one action that moves it forward, in the tab order, and
 *     it says what a computer costs while it sits there — a fleet you are afraid
 *     of is a fleet you do not use (spec 9.4 wants forks offered freely).
 *   * **Unreachable.** A failed fleet read is NOT an empty fleet, and showing
 *     "no computers yet" for it would be a lie that suggests a destructive fix.
 *     So the failure is its own state, it names the likely cause, and it keeps
 *     any cards already on screen: `placeholderData` in the query client means a
 *     background refetch that fails still has the last good fleet to render.
 */
export function FleetHome({
  computers,
  onOpen,
  onAttention,
  onNew,
  unreachable = false,
  onRetry,
}: {
  computers: FleetComputer[];
  onOpen: (id: string) => void;
  /** Activate the oldest waiting attention of a computer (spec 6.2). */
  onAttention?: (id: string) => void;
  /** Create the first (or next) computer. Absent ⇒ the action is not offered. */
  onNew?: () => void;
  /** The fleet read failed. Renders the error state instead of "no computers". */
  unreachable?: boolean;
  /** Re-read the fleet. Absent ⇒ no retry button. */
  onRetry?: () => void;
}) {
  const model = useEventsStore((s) => s.model);

  return (
    <div className="fleet" data-testid="fleet">
      <div className="fleet-head">
        <h1>Fleet</h1>
        {onNew && (
          <button
            type="button"
            className="auth-primary compact"
            data-testid="fleet-new-computer"
            onClick={onNew}
          >
            New computer
          </button>
        )}
      </div>

      {computers.length > 0 && (
        <div className="fleet-grid">
          {computers.map((c) => (
            <ComputerCard
              key={c.id}
              computer={c}
              onOpen={onOpen}
              onAttention={onAttention}
              liveState={liveState(model, c.id)}
              liveActiveRuns={liveActiveRuns(model, c.id)}
              attentionCount={badgeCount(c.attention, attentionFor(model, c.id).length)}
            />
          ))}
        </div>
      )}

      {unreachable ? (
        <div className="empty-note" role="alert" data-testid="fleet-unreachable">
          <strong>Could not reach the control plane.</strong>
          <p>
            The fleet lives in the control plane, not in this tab, so nothing has been lost — this
            view is stale, not empty. Check that the instance is still running
            (<code>docker logs -f mari-control-plane</code> on a private instance), then read the
            fleet again.
          </p>
          {onRetry && (
            <button type="button" onClick={onRetry} data-testid="fleet-retry">
              Try again
            </button>
          )}
        </div>
      ) : (
        computers.length === 0 && (
          <div className="empty-note" data-testid="fleet-empty">
            <strong>No computers yet.</strong>
            <p>
              A computer is a filesystem, a hostname and a history that live in object storage. It
              is created in <em>deep sleep</em>: nothing is running, nothing is materialized, and it
              costs only the storage of its own changes until you start a run on it.
            </p>
            {onNew && (
              <button
                type="button"
                className="auth-primary"
                data-testid="fleet-empty-new"
                onClick={onNew}
              >
                Create your first computer
              </button>
            )}
            <p className="hint">
              Then press <kbd>⌥R</kbd> to run something on it. <kbd>⌘K</kbd> lists every command;
              nothing here needs a mouse.
            </p>
          </div>
        )
      )}
    </div>
  );
}
