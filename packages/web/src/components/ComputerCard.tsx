import type { FleetComputer } from '../api/types';

/** Format a cost meter's accrued amount (minor units) as a currency string. */
export function formatCost(accrued: number, currency: string): string {
  const symbol = currency === 'USD' ? '$' : '';
  return `${symbol}${(accrued / 100).toFixed(2)}`;
}

/**
 * One fleet card (spec 8.2). Renders entirely from control-plane data: state,
 * active runs, attention, changed files, and the cost meter. A COLD computer
 * renders every field with no wake and no spinner (spec 8.3).
 */
export function ComputerCard({
  computer,
  onOpen,
}: {
  computer: FleetComputer;
  onOpen: (id: string) => void;
}) {
  const c = computer;
  return (
    <button
      type="button"
      className="card"
      data-testid="computer-card"
      data-computer-id={c.id}
      data-state={c.state}
      onClick={() => onOpen(c.id)}
    >
      <div className="card-head">
        <span className="card-host">{c.hostname}</span>
        <span className={`state ${c.state}`} data-testid="computer-state">
          {c.state}
        </span>
      </div>
      <div className="card-stats">
        <div className="stat">
          <div className="n" data-testid="active-runs">
            {c.activeRuns}
          </div>
          <div className="k">runs</div>
        </div>
        <div className="stat">
          <div className={`n ${c.attention > 0 ? 'badge-attn' : ''}`} data-testid="attention">
            {c.attention}
          </div>
          <div className="k">attention</div>
        </div>
        <div className="stat">
          <div className="n" data-testid="changed-files">
            {c.changedFiles}
          </div>
          <div className="k">changed</div>
        </div>
      </div>
      <div className="cost" data-testid="cost-meter">
        <span>{c.cost.window}</span>
        <span className="rate">
          {formatCost(c.cost.accrued, c.cost.currency)}
          {c.cost.ratePerHour > 0 ? ` · ${formatCost(c.cost.ratePerHour, c.cost.currency)}/h` : ''}
        </span>
      </div>
    </button>
  );
}
