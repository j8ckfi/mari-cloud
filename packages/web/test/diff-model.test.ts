import { describe, it, expect } from 'vitest';
import {
  baseOf,
  buildDiffModel,
  classifyEntry,
  countRows,
  dirOf,
  formatCounts,
  formatMode,
  groupRows,
  summaryAgrees,
  toRow,
} from '../src/diff/model';
import type { DiffEntry, DiffResponse } from '../src/api/types';

function entry(over: Partial<DiffEntry> = {}): DiffEntry {
  return {
    path: '/src/main.ts',
    change: 'modified',
    oldMode: 0o100644,
    newMode: 0o100644,
    oldSize: 100,
    newSize: 120,
    contentChanged: true,
    ...over,
  };
}

function response(entries: DiffEntry[], over: Partial<DiffResponse> = {}): DiffResponse {
  const added = entries.filter((e) => e.change === 'added').length;
  const modified = entries.filter((e) => e.change === 'modified').length;
  const removed = entries.filter((e) => e.change === 'removed').length;
  return {
    runId: 'r1',
    base: 'a'.repeat(64),
    head: 'b'.repeat(64),
    summary: { added, modified, removed },
    entries,
    ...over,
  };
}

describe('diff classification (spec 5.3)', () => {
  it('separates a MODE-ONLY change from a content change', () => {
    // The case a naive "modified" list hides: identical bytes, chmod +x.
    const modeOnly = entry({
      oldMode: 0o100644,
      newMode: 0o100755,
      oldSize: 100,
      newSize: 100,
      contentChanged: false,
    });
    expect(classifyEntry(modeOnly)).toBe('mode');

    // Same size, same mode, but the content DID change (one byte flipped).
    // Size equality must not be mistaken for "nothing happened".
    const sameSize = entry({ oldSize: 100, newSize: 100, contentChanged: true });
    expect(classifyEntry(sameSize)).toBe('content');
  });

  it('classifies additions and removals regardless of the content flag', () => {
    expect(classifyEntry(entry({ change: 'added', oldMode: null, oldSize: null, contentChanged: true }))).toBe('added');
    expect(classifyEntry(entry({ change: 'removed', newMode: null, newSize: null, contentChanged: false }))).toBe('removed');
  });

  it('never silently drops a reported change it cannot explain', () => {
    // Server said modified, but reported neither a content nor a mode move.
    // It must still appear as a change — swallowing it would let a reviewer
    // approve something they were never shown.
    const opaque = entry({ contentChanged: false, oldMode: 0o100644, newMode: 0o100644 });
    expect(classifyEntry(opaque)).toBe('content');
  });
});

describe('diff counting', () => {
  it('counts mode-only changes inside modified, not beside it', () => {
    const rows = [
      entry({ path: '/a', change: 'added', contentChanged: true }),
      entry({ path: '/b', change: 'removed', contentChanged: true }),
      entry({ path: '/c', contentChanged: true }),
      entry({ path: '/d', contentChanged: false, oldMode: 0o100644, newMode: 0o100755 }),
      entry({ path: '/e', contentChanged: false, oldMode: 0o100600, newMode: 0o100755 }),
    ].map(toRow);
    const counts = countRows(rows);
    expect(counts).toEqual({
      added: 1,
      removed: 1,
      modified: 3,
      modeOnly: 2,
      contentChanged: 1,
      total: 5,
    });
    // modeOnly + contentChanged partition modified exactly.
    expect(counts.modeOnly + counts.contentChanged).toBe(counts.modified);
  });

  it('formats counts compactly, mentioning mode-only only when present', () => {
    expect(formatCounts(countRows([toRow(entry({ change: 'added' }))]))).toBe('+1 ~0 -0');
    const withMode = countRows([
      toRow(entry({ contentChanged: false, oldMode: 0o100644, newMode: 0o100755 })),
    ]);
    expect(formatCounts(withMode)).toBe('+0 ~1 -0 1 mode-only');
  });

  it('computes a signed size delta only when both sides exist', () => {
    expect(toRow(entry({ oldSize: 10, newSize: 4 })).sizeDelta).toBe(-6);
    expect(toRow(entry({ change: 'added', oldSize: null, newSize: 9 })).sizeDelta).toBeNull();
    expect(toRow(entry({ change: 'removed', oldSize: 9, newSize: null })).sizeDelta).toBeNull();
  });
});

describe('diff grouping', () => {
  it('groups by directory with deterministic ordering', () => {
    const rows = [
      entry({ path: '/src/z.ts' }),
      entry({ path: '/README.md' }),
      entry({ path: '/src/a.ts' }),
      entry({ path: '/src/nested/deep.ts' }),
    ].map(toRow);
    const groups = groupRows(rows);
    expect(groups.map((g) => g.dir)).toEqual(['/', '/src', '/src/nested']);
    expect(groups[1]!.rows.map((r) => r.path)).toEqual(['/src/a.ts', '/src/z.ts']);
    expect(groups[1]!.counts.total).toBe(2);
    // Same input in another order yields the identical grouping.
    const shuffled = groupRows([...rows].reverse());
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(groups));
  });

  it('derives dir and basename for root-level and nested paths', () => {
    expect(dirOf('/README.md')).toBe('/');
    expect(dirOf('/src/a/b.ts')).toBe('/src/a');
    expect(baseOf('/src/a/b.ts')).toBe('b.ts');
    expect(baseOf('/README.md')).toBe('README.md');
  });
});

describe('diff view model', () => {
  it('builds sorted rows, groups and counts from a response', () => {
    const model = buildDiffModel(
      response([
        entry({ path: '/src/b.ts', change: 'added', oldMode: null, oldSize: null }),
        entry({ path: '/a.md' }),
      ]),
    );
    expect(model.rows.map((r) => r.path)).toEqual(['/a.md', '/src/b.ts']);
    expect(model.counts.total).toBe(2);
    expect(model.empty).toBe(false);
    expect(model.base).toBe('a'.repeat(64));
    expect(summaryAgrees(model)).toBe(true);
  });

  it('is empty (and safely rendered) for null, missing and empty diffs', () => {
    for (const input of [null, undefined, response([])]) {
      const model = buildDiffModel(input);
      expect(model.empty).toBe(true);
      expect(model.rows).toEqual([]);
      expect(model.groups).toEqual([]);
      expect(model.counts.total).toBe(0);
    }
  });

  it('detects a summary that disagrees with the entries it sent', () => {
    // A partial entry list under a complete summary: the reviewer must be told,
    // because Keep/Revert applies to changes they did not see (spec 5.3).
    const model = buildDiffModel(
      response([entry({ path: '/a.md' })], { summary: { added: 0, modified: 5, removed: 0 } }),
    );
    expect(summaryAgrees(model)).toBe(false);

    const honest = buildDiffModel(response([entry({ path: '/a.md' })]));
    expect(summaryAgrees(honest)).toBe(true);
  });

  it('carries the truncation flag through', () => {
    expect(buildDiffModel(response([entry()], { truncated: true })).truncated).toBe(true);
    expect(buildDiffModel(response([entry()])).truncated).toBe(false);
  });

  it('formats modes as octal permissions without the file-type bits', () => {
    expect(formatMode(0o100644)).toBe('0644');
    expect(formatMode(0o100755)).toBe('0755');
    expect(formatMode(0o40755)).toBe('0755');
    expect(formatMode(null)).toBe('—');
  });

  it('carries no file content anywhere in the model (spec 10.2)', () => {
    // A difference view must not show cookie content; the model cannot, because
    // a row has no field that could hold bytes.
    const model = buildDiffModel(
      response([entry({ path: '/home/user/.config/browser/Cookies', contentChanged: true })]),
    );
    const row = model.rows[0]!;
    expect(Object.keys(row).sort()).toEqual([
      'class',
      'dir',
      'name',
      'newMode',
      'newSize',
      'oldMode',
      'oldSize',
      'path',
      'sizeDelta',
    ]);
  });
});
