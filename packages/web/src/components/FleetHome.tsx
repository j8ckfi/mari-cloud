import type { FleetComputer } from '../api/types';
import { ComputerCard } from './ComputerCard';

/**
 * Fleet home (spec 8.2). Presentational: it renders whatever computers it is
 * given. Per spec 8.3 there is deliberately NO loading/spinner state — before
 * data arrives it simply shows an empty grid; cards appear as the fleet query
 * resolves. Opening a card never triggers a wake (spec 8.3); a wake, if any,
 * happens later and behind the interface.
 */
export function FleetHome({
  computers,
  onOpen,
}: {
  computers: FleetComputer[];
  onOpen: (id: string) => void;
}) {
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
            <ComputerCard key={c.id} computer={c} onOpen={onOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
