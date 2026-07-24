import type { ComputerState } from '@mari/shared';
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
 *
 * The card is a div, not a button, because the attention badge inside it is
 * itself an action (spec 6.2: activating the attention opens the terminal pane
 * of that run) and a button may not nest in a button. Keyboard operation is
 * kept explicit: the card is focusable and activates on Enter/Space, and the
 * badge is a real button in the tab order.
 */
export function ComputerCard({
  computer,
  onOpen,
  onAttention,
  liveState,
  liveActiveRuns,
  attentionCount,
}: {
  computer: FleetComputer;
  onOpen: (id: string) => void;
  /** Activating the attention badge (spec 6.2). Absent ⇒ badge is not shown. */
  onAttention?: (id: string) => void;
  /** State pushed on the event stream, which beats the polled fleet value. */
  liveState?: ComputerState | null;
  /** Active-run count from the event stream, when it knows better. */
  liveActiveRuns?: number | null;
  /** Attention count to badge with; defaults to the fleet value. */
  attentionCount?: number;
}) {
  const c = computer;
  const state = liveState ?? c.state;
  const runs = liveActiveRuns !== null && liveActiveRuns !== undefined
    ? Math.max(c.activeRuns, liveActiveRuns)
    : c.activeRuns;
  const attention = attentionCount ?? c.attention;

  return (
    <div
      className="card"
      role="button"
      tabIndex={0}
      data-testid="computer-card"
      data-computer-id={c.id}
      data-state={state}
      data-attention={attention}
      onClick={() => onOpen(c.id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onOpen(c.id);
        }
      }}
    >
      <div className="card-head">
        <span className="card-host">{c.hostname}</span>
        {attention > 0 && onAttention && (
          <button
            type="button"
            className="attn-badge"
            data-testid="attention-badge"
            title="Waiting for you — open the run’s terminal"
            onClick={(e) => {
              e.stopPropagation();
              onAttention(c.id);
            }}
          >
            {attention} waiting
          </button>
        )}
        <span className={`state ${state}`} data-testid="computer-state">
          {state}
        </span>
      </div>
      <div className="card-stats">
        <div className="stat">
          <div className="n" data-testid="active-runs">
            {runs}
          </div>
          <div className="k">runs</div>
        </div>
        <div className="stat">
          <div className={`n ${attention > 0 ? 'badge-attn' : ''}`} data-testid="attention">
            {attention}
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
    </div>
  );
}
