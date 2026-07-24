import type { FleetComputer } from '../api/types';
import { ComputerCard } from './ComputerCard';
import { useEventsStore } from '../store/events';
import { attentionFor, badgeCount, liveActiveRuns, liveState } from '../events/reducer';

/**
 * Fleet home (spec 8.2). Renders whatever computers it is given, enriched with
 * whatever the live event stream has pushed since the fleet was fetched. Per
 * spec 8.3 there is deliberately NO loading/spinner state — before data arrives
 * it simply shows an empty grid; cards appear as the fleet query resolves.
 * Opening a card never triggers a wake (spec 8.3).
 *
 * Spec 6.2: a waiting attention badges the card, and activating that badge
 * opens the terminal pane of the run that is waiting.
 */
export function FleetHome({
  computers,
  onOpen,
  onAttention,
}: {
  computers: FleetComputer[];
  onOpen: (id: string) => void;
  /** Activate the oldest waiting attention of a computer (spec 6.2). */
  onAttention?: (id: string) => void;
}) {
  const model = useEventsStore((s) => s.model);

  return (
    <div className="fleet" data-testid="fleet">
      <h1>Fleet</h1>
      {computers.length === 0 ? (
        <div className="empty-note" data-testid="fleet-empty">
          No computers yet.
        </div>
      ) : (
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
    </div>
  );
}
