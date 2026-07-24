import { useMemo, useState } from 'react';
import {
  buildDiffModel,
  formatCounts,
  formatMode,
  summaryAgrees,
  type ChangeClass,
  type DiffRow,
  type DiffViewModel,
} from '../diff/model';
import type { DiffResponse } from '../api/types';

const CLASS_MARK: Record<ChangeClass, string> = {
  added: '+',
  removed: '−',
  content: '~',
  mode: 'm',
};

const CLASS_LABEL: Record<ChangeClass, string> = {
  added: 'added',
  removed: 'removed',
  content: 'modified',
  mode: 'mode only',
};

/**
 * The difference view (spec 5.3 result review; spec 9.2 fork difference).
 *
 * Presentational and source-agnostic: it renders a {@link DiffViewModel} and
 * calls back for decisions. It is deliberately the SAME component for a run
 * result and a fork comparison, because a difference is a function of two
 * manifests either way (decisions.md).
 *
 * Spec 9.2: an automatic merge is not permitted. There is no "apply", no
 * "resolve", and no preselected outcome here — the only actions are the ones
 * the caller passes in, and they are a human's explicit decision.
 *
 * Spec 10.2: the view shows paths, modes and sizes. It shows no file content,
 * so a browser-profile cookie cannot appear in it.
 */
export function DiffView({
  diff,
  actions,
  emptyNote = 'No changes.',
}: {
  diff: DiffResponse | null | undefined;
  actions?: React.ReactNode;
  emptyNote?: string;
}) {
  const model = useMemo(() => buildDiffModel(diff), [diff]);
  const [grouped, setGrouped] = useState(true);

  return (
    <div className="diff" data-testid="diff-view" data-empty={model.empty}>
      <div className="diff-bar">
        <span className="diff-counts" data-testid="diff-counts">
          {formatCounts(model.counts)}
        </span>
        <span className="hint" data-testid="diff-range">
          {short(model.base)} → {short(model.head)}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          onClick={() => setGrouped((g) => !g)}
          data-testid="diff-toggle-group"
          aria-pressed={grouped}
        >
          {grouped ? 'Flat' : 'By folder'}
        </button>
        {actions}
      </div>

      {!summaryAgrees(model) && (
        <div className="diff-warn" data-testid="diff-partial">
          Showing {model.counts.total} of {summaryTotal(model)} changed entries — this list is
          partial.
        </div>
      )}
      {model.truncated && (
        <div className="diff-warn" data-testid="diff-truncated">
          The server capped this list; not every change is shown.
        </div>
      )}

      <div className="diff-list" data-testid="diff-list">
        {model.empty ? (
          <div className="empty-note" data-testid="diff-empty">
            {emptyNote}
          </div>
        ) : grouped ? (
          model.groups.map((g) => (
            <div key={g.dir} className="diff-group" data-testid="diff-group" data-dir={g.dir}>
              <div className="diff-group-head">
                <span className="diff-dir">{g.dir}</span>
                <span className="hint">{formatCounts(g.counts)}</span>
              </div>
              {g.rows.map((row) => (
                <Row key={row.path} row={row} showDir={false} />
              ))}
            </div>
          ))
        ) : (
          model.rows.map((row) => <Row key={row.path} row={row} showDir />)
        )}
      </div>
    </div>
  );
}

function Row({ row, showDir }: { row: DiffRow; showDir: boolean }) {
  return (
    <div className="diff-row" data-testid="diff-row" data-path={row.path} data-class={row.class}>
      <span className={`diff-mark ${row.class}`} aria-hidden="true">
        {CLASS_MARK[row.class]}
      </span>
      <span className="diff-path">{showDir ? row.path : row.name}</span>
      <span className="diff-kind" data-testid="diff-row-kind">
        {CLASS_LABEL[row.class]}
      </span>
      {row.class === 'mode' ? (
        <span className="diff-meta" data-testid="diff-row-mode">
          {formatMode(row.oldMode)} → {formatMode(row.newMode)}
        </span>
      ) : (
        <span className="diff-meta" data-testid="diff-row-size">
          {formatSize(row)}
        </span>
      )}
    </div>
  );
}

function formatSize(row: DiffRow): string {
  if (row.class === 'added') return `${row.newSize ?? 0} B`;
  if (row.class === 'removed') return `${row.oldSize ?? 0} B`;
  if (row.sizeDelta === null) return '';
  const sign = row.sizeDelta > 0 ? '+' : '';
  return `${sign}${row.sizeDelta} B`;
}

function summaryTotal(model: DiffViewModel): number {
  const s = model.summary;
  return s === null ? model.counts.total : s.added + s.modified + s.removed;
}

function short(id: string | null): string {
  if (id === null) return '—';
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}
