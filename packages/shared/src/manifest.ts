// Storage-format types mirroring `crates/mari-proto::manifest`.
//
// The TypeScript side READS manifests (spec 8.4 file browsing, 9.2 diffs) but
// never writes them; `mari-core` is the only writer. Field names and casing
// match the CBOR map keys exactly — do not camelCase them.

import type { ChunkId, ManifestId } from './ids';

/** Kind of a manifest entry. Bare snake_case string on the wire. */
export type EntryKind = 'file' | 'dir' | 'symlink';

/** Why a snapshot was written (spec 4.3). Bare snake_case string. */
export type SnapshotReason = 'pre_run' | 'scheduled' | 'command' | 'final';

/** Lifecycle state of a computer (spec §2). Bare snake_case string. */
export type ComputerState = 'awake' | 'warm' | 'cold' | 'waking';

/** One content-addressed chunk reference and the bytes it contributes. */
export interface ChunkRef {
  chunk: ChunkId;
  /** Byte length this chunk contributes to the file. */
  len: number;
}

/** One filesystem object in a manifest. */
export interface ManifestEntry {
  /** Absolute path; the ordering key of the flat list. */
  path: string;
  kind: EntryKind;
  /** Unix mode bits including file-type bits (e.g. 33188 = 0o100644). */
  mode: number;
  /** File byte length; 0 for directories. */
  size: number;
  /** Link text for a symlink; `null` otherwise (always present). */
  symlink_target: string | null;
  /** Ordered chunks composing a file; empty for dirs and symlinks. */
  chunks: ChunkRef[];
}

/** A snapshot of a whole filesystem. Stored at `manifests/{id}.cbor`. */
export interface Manifest {
  version: number;
  /** Base-image manifest this layers on, or `null` (always present). */
  parent: ManifestId | null;
  /** Creation time, Unix seconds. */
  created_at: number;
  /** The filesystem as a flat, path-ordered list. */
  entries: ManifestEntry[];
}

/** Ordered read paths for cold-wake prefetch. Stored at `heat/{computer}.cbor`. */
export interface HeatProfile {
  paths: string[];
}

/** Counts summarizing a manifest diff (spec 5.3). */
export interface DiffSummary {
  added: number;
  modified: number;
  removed: number;
}
