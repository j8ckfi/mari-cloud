// The difference view model (spec 5.3 result review, spec 9.2 fork difference).
//
// A difference is a function of two manifests (decisions.md), so ONE model
// serves both callers: the result of a run against its pre-run manifest, and a
// fork against its lineage point. Nothing here knows which it is looking at.
//
// Spec 9.2 is load-bearing in the negative: "A merge is a reviewed application
// of that difference. An automatic merge is not permitted." This module
// therefore computes no merge, proposes no resolution, and offers no ordering
// that implies one. It classifies, groups, and counts — the human decides.
//
// Spec 10.2 is load-bearing too: "A difference view must not show cookie
// content." Nothing here carries file CONTENT at all; a `DiffEntry` is path +
// mode + size + a content-changed bit. There is no byte to leak.

import type { DiffEntry, DiffResponse } from '../api/types';
import type { DiffSummary } from '@mari/shared';

/**
 * How an entry changed, as the view renders it. `mode` is the case spec 4/5.3
 * make possible and a naive diff hides: the bytes are identical, only the Unix
 * mode moved (a chmod +x). It gets its own class so a reviewer can tell a
 * permission change from a content rewrite at a glance.
 */
export type ChangeClass = 'added' | 'removed' | 'content' | 'mode';

/** One row of the diff view. */
export interface DiffRow {
  path: string;
  /** Basename, for the row label. */
  name: string;
  /** Directory the entry lives in ('/' for root-level entries). */
  dir: string;
  class: ChangeClass;
  oldMode: number | null;
  newMode: number | null;
  oldSize: number | null;
  newSize: number | null;
  /** Byte delta (new - old); null when one side does not exist. */
  sizeDelta: number | null;
}

/** Counts over a set of rows. `modeOnly` is a subset of `modified`. */
export interface DiffCounts {
  added: number;
  removed: number;
  modified: number;
  /** Modified entries whose CONTENT is unchanged (mode-only). */
  modeOnly: number;
  /** Modified entries whose content changed. */
  contentChanged: number;
  total: number;
}

/** A directory group of rows, for the grouped rendering. */
export interface DiffGroup {
  dir: string;
  rows: DiffRow[];
  counts: DiffCounts;
}

/** The whole view model handed to the renderer. */
export interface DiffViewModel {
  rows: DiffRow[];
  groups: DiffGroup[];
  counts: DiffCounts;
  /** The server's own summary, when present — kept so a mismatch is visible. */
  summary: DiffSummary | null;
  base: string | null;
  head: string | null;
  truncated: boolean;
  /** True when the two manifests are identical: nothing to keep or revert. */
  empty: boolean;
}

/**
 * Classify one entry. A `modified` entry is a MODE-only change exactly when the
 * server says its content chunks did not change; otherwise it is a content
 * change. (When the server reports neither — content unchanged and mode
 * unchanged — we still call it `content`: the server said the entry changed,
 * and silently dropping a reported change from a review view would be worse
 * than showing an unexplained one.)
 */
export function classifyEntry(entry: DiffEntry): ChangeClass {
  if (entry.change === 'added') return 'added';
  if (entry.change === 'removed') return 'removed';
  if (entry.contentChanged) return 'content';
  const modeMoved =
    entry.oldMode !== null && entry.newMode !== null && entry.oldMode !== entry.newMode;
  return modeMoved ? 'mode' : 'content';
}

/** The directory part of an absolute path ('/' for a root-level entry). */
export function dirOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}

/** The basename of an absolute path. */
export function baseOf(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/');
  const last = parts[parts.length - 1];
  return last === undefined || last === '' ? path : last;
}

/** Build one row from a wire entry. */
export function toRow(entry: DiffEntry): DiffRow {
  const cls = classifyEntry(entry);
  return {
    path: entry.path,
    name: baseOf(entry.path),
    dir: dirOf(entry.path),
    class: cls,
    oldMode: entry.oldMode,
    newMode: entry.newMode,
    oldSize: entry.oldSize,
    newSize: entry.newSize,
    sizeDelta:
      entry.oldSize === null || entry.newSize === null ? null : entry.newSize - entry.oldSize,
  };
}

/** Count a set of rows. */
export function countRows(rows: readonly DiffRow[]): DiffCounts {
  const counts: DiffCounts = {
    added: 0,
    removed: 0,
    modified: 0,
    modeOnly: 0,
    contentChanged: 0,
    total: rows.length,
  };
  for (const row of rows) {
    switch (row.class) {
      case 'added':
        counts.added += 1;
        break;
      case 'removed':
        counts.removed += 1;
        break;
      case 'mode':
        counts.modified += 1;
        counts.modeOnly += 1;
        break;
      case 'content':
        counts.modified += 1;
        counts.contentChanged += 1;
        break;
    }
  }
  return counts;
}

/**
 * Group rows by directory, directories sorted lexicographically and rows sorted
 * by path within each. Deterministic order: a review the user scrolls twice
 * must not shuffle under them.
 */
export function groupRows(rows: readonly DiffRow[]): DiffGroup[] {
  const byDir = new Map<string, DiffRow[]>();
  for (const row of rows) {
    const list = byDir.get(row.dir);
    if (list) list.push(row);
    else byDir.set(row.dir, [row]);
  }
  return [...byDir.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([dir, groupRowsList]) => {
      const sorted = [...groupRowsList].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      return { dir, rows: sorted, counts: countRows(sorted) };
    });
}

/** Build the whole view model from a diff response. */
export function buildDiffModel(diff: DiffResponse | null | undefined): DiffViewModel {
  const entries = diff?.entries ?? [];
  const rows = entries.map(toRow).sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    rows,
    groups: groupRows(rows),
    counts: countRows(rows),
    summary: diff?.summary ?? null,
    base: diff?.base ?? null,
    head: diff?.head ?? null,
    truncated: diff?.truncated === true,
    empty: rows.length === 0,
  };
}

/**
 * Whether the server's own summary agrees with the entries it sent. A mismatch
 * means the entry list is partial (or the server is wrong); the review view
 * says so rather than implying the user has seen every change before they
 * choose Keep or Revert (spec 5.3).
 */
export function summaryAgrees(model: DiffViewModel): boolean {
  if (model.summary === null) return true;
  return (
    model.summary.added === model.counts.added &&
    model.summary.modified === model.counts.modified &&
    model.summary.removed === model.counts.removed
  );
}

/** Render Unix mode bits as an octal permission string, e.g. `0644`. */
export function formatMode(mode: number | null): string {
  if (mode === null) return '—';
  // Strip the file-type bits; only permissions are meaningful in a review.
  return `0${(mode & 0o7777).toString(8).padStart(3, '0')}`;
}

/** A compact one-line description of the counts, for headers and cards. */
export function formatCounts(counts: DiffCounts): string {
  const parts = [`+${counts.added}`, `~${counts.modified}`, `-${counts.removed}`];
  if (counts.modeOnly > 0) parts.push(`${counts.modeOnly} mode-only`);
  return parts.join(' ');
}
