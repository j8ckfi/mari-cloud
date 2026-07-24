// Manifest diff engine (spec 9.2 / 5.3), computed IN THE CONTROL PLANE.
//
// A run's result is a difference against its pre-run manifest (spec 5.3), and a
// fork difference view compares two manifests (spec 9.2). Both are functions of
// the manifests ALONE (decisions.md: "8.4 file browsing and 9.2 diffs are
// functions of the manifest alone") — no substrate, no wake, no chunk reads:
// entry metadata plus the per-file chunk-ref lists carry everything needed to
// decide added / modified / removed.
//
// The TS side only READS manifests (decisions.md); this module never writes one.

import type { DiffSummary, Manifest, ManifestEntry } from '@mari/shared';
import { loadManifest } from './manifest-store';

/** The metadata of one entry as it appears on one side of a diff. */
export interface DiffEntryFacts {
  kind: ManifestEntry['kind'];
  mode: number;
  size: number;
  symlink_target: string | null;
  /** Number of content chunks (0 for dirs/symlinks). */
  chunks: number;
}

/** An entry present on exactly one side. */
export interface DiffEntry extends DiffEntryFacts {
  path: string;
}

/** An entry present on both sides but not identical. */
export interface ModifiedEntry {
  path: string;
  from: DiffEntryFacts;
  to: DiffEntryFacts;
  /** `to.size - from.size`. */
  sizeDelta: number;
  /** The chunk-ref list changed (file content differs). */
  contentChanged: boolean;
  modeChanged: boolean;
  kindChanged: boolean;
  symlinkChanged: boolean;
}

/** The structured difference between two manifests (spec 9.2). */
export interface ManifestDiff {
  added: DiffEntry[];
  modified: ModifiedEntry[];
  removed: DiffEntry[];
  summary: DiffSummary;
}

function facts(e: ManifestEntry): DiffEntryFacts {
  return {
    kind: e.kind,
    mode: e.mode,
    size: e.size,
    symlink_target: e.symlink_target,
    chunks: e.chunks.length,
  };
}

/** True when two entries have identical content chunk refs (ids AND lengths). */
function sameChunks(a: ManifestEntry, b: ManifestEntry): boolean {
  if (a.chunks.length !== b.chunks.length) return false;
  for (let i = 0; i < a.chunks.length; i++) {
    const x = a.chunks[i]!;
    const y = b.chunks[i]!;
    if (x.chunk !== y.chunk || x.len !== y.len) return false;
  }
  return true;
}

function byPath(manifest: Manifest): Map<string, ManifestEntry> {
  const m = new Map<string, ManifestEntry>();
  for (const e of manifest.entries) m.set(e.path, e);
  return m;
}

/**
 * Diff `from` -> `to`. An entry is:
 *  - **added** when its path exists only in `to`,
 *  - **removed** when its path exists only in `from`,
 *  - **modified** when the path exists in both and any of kind/mode/size/
 *    symlink target/chunk refs differ.
 *
 * Results are path-sorted so the output is deterministic regardless of the
 * manifests' own ordering.
 */
export function diffManifests(from: Manifest, to: Manifest): ManifestDiff {
  const a = byPath(from);
  const b = byPath(to);

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const modified: ModifiedEntry[] = [];

  for (const [path, toEntry] of b) {
    const fromEntry = a.get(path);
    if (!fromEntry) {
      added.push({ path, ...facts(toEntry) });
      continue;
    }
    const contentChanged = !sameChunks(fromEntry, toEntry) || fromEntry.size !== toEntry.size;
    const modeChanged = fromEntry.mode !== toEntry.mode;
    const kindChanged = fromEntry.kind !== toEntry.kind;
    const symlinkChanged = fromEntry.symlink_target !== toEntry.symlink_target;
    if (contentChanged || modeChanged || kindChanged || symlinkChanged) {
      modified.push({
        path,
        from: facts(fromEntry),
        to: facts(toEntry),
        sizeDelta: toEntry.size - fromEntry.size,
        contentChanged,
        modeChanged,
        kindChanged,
        symlinkChanged,
      });
    }
  }

  for (const [path, fromEntry] of a) {
    if (!b.has(path)) removed.push({ path, ...facts(fromEntry) });
  }

  const sortPath = <T extends { path: string }>(list: T[]): T[] =>
    list.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  return {
    added: sortPath(added),
    modified: sortPath(modified),
    removed: sortPath(removed),
    summary: { added: added.length, modified: modified.length, removed: removed.length },
  };
}

/** Total number of changed entries in a diff (the spec 8.2 "changed files"). */
export function changedCount(summary: DiffSummary): number {
  return summary.added + summary.modified + summary.removed;
}

/**
 * Load both manifests from the store and diff them (spec 9.2's engine, reading
 * through the manifest-store reader). Throws `ManifestNotFound` if either id is
 * absent.
 */
export async function diffManifestIds(
  store: R2Bucket,
  fromId: string,
  toId: string,
): Promise<ManifestDiff> {
  if (fromId === toId) {
    const only = await loadManifest(store, fromId);
    return diffManifests(only, only);
  }
  const [from, to] = await Promise.all([loadManifest(store, fromId), loadManifest(store, toId)]);
  return diffManifests(from, to);
}
