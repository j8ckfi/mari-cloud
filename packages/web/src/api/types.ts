// The control-plane HTTP contract the web app codes against.
//
// The control plane is built concurrently (see docs/contracts.md); this module
// is the web side's authoritative view of the *HTTP* surface it consumes. The
// byte-level WebSocket/attach and manifest shapes are owned by `@mari/shared`
// and re-used here; only the fleet/files/layout/run REST shapes — which
// contracts.md leaves to the control plane — are declared here, and the
// integration agent wires the server to match. Everything below is renderable
// from control-plane data ALONE (spec 8.3): a COLD computer has a full fleet
// card, a browsable file tree from its manifest head, and a saved layout, with
// no wake and no spinner.

import type { ComputerId, ManifestId, RunId } from '@mari/shared';
import type { ComputerState, EntryKind } from '@mari/shared';
import type { SerializedLayout } from '../wm/serialize';

/** Cost meter (spec 8.2). Internal accounting from substrate price sheets
 *  (decisions.md), independent of billing — a placeholder wired to the shape. */
export interface CostMeter {
  currency: string;
  /** Accrued cost in the current window, in `currency` minor units → number. */
  accrued: number;
  /** Current burn rate while AWAKE, per hour. Zero when not AWAKE. */
  ratePerHour: number;
  /** Human label for the accounting window, e.g. "month to date". */
  window: string;
}

/** One computer as summarized in the fleet home (spec 8.2). */
export interface FleetComputer {
  id: ComputerId;
  hostname: string;
  state: ComputerState;
  /** Number of runs currently executing on this computer. */
  activeRuns: number;
  /** Count of runs waiting for user attention (spec 6). */
  attention: number;
  /** Files changed at the manifest head vs. the previous head (spec 8.2). */
  changedFiles: number;
  cost: CostMeter;
  /** The current manifest head id, or null if the computer has no snapshot. */
  manifestHead: ManifestId | null;
  /** Last state/head change, Unix seconds. */
  updatedAt: number;
}

/** The fleet listing. */
export interface FleetResponse {
  computers: FleetComputer[];
}

/** One run summary for a computer's detail view. */
export interface RunSummary {
  id: RunId;
  alive: boolean;
  /** Present once the run has ended. */
  exitCode: number | null;
  /** Whether this run is currently flagged for attention. */
  attention: boolean;
  startedAt: number;
}

/** A computer's detail, including its live runs. */
export interface ComputerDetail extends FleetComputer {
  runs: RunSummary[];
}

/** One entry in a directory listing, served from the manifest (spec 8.4). */
export interface FileEntry {
  /** Basename within the listed directory. */
  name: string;
  /** Absolute path. */
  path: string;
  kind: EntryKind;
  /** File size in bytes; 0 for directories. */
  size: number;
  /** Unix mode bits. */
  mode: number;
  /** Link text for symlinks, else null. */
  symlinkTarget: string | null;
}

/** A directory listing response. */
export interface DirListing {
  computer: ComputerId;
  path: string;
  /** Manifest the listing was read from (null if the computer has no head). */
  manifest: ManifestId | null;
  entries: FileEntry[];
}

/** The saved pane layout for a computer (persisted in the DO, spec 8.6). */
export interface LayoutResponse {
  computer: ComputerId;
  layout: SerializedLayout | null;
}

/** Response to starting a run from a brief (spec 8.5). */
export interface StartRunResponse {
  run: RunId;
}
