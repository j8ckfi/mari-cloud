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
import type { AttentionKind, ComputerState, DiffSummary, EntryKind } from '@mari/shared';
import type { SerializedLayout } from '../wm/serialize';

/** Cost meter (spec 8.2). Internal accounting from substrate price sheets
 *  (decisions.md), independent of billing — a placeholder wired to the shape. */
export interface CostMeter {
  currency: string;
  /** Accrued cost in currency major units (USD dollars), not minor units/cents. */
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

/**
 * The lifecycle of a run (spec 5). The supervisor owns the run; these are the
 * states the *control plane* can report about it. `pending` covers the window
 * between a start being accepted and the supervisor's `run_started` — a COLD
 * computer wakes behind the interface during it (spec 8.3), so the UI shows a
 * pending run immediately rather than blocking.
 */
export type RunState = 'pending' | 'running' | 'stopping' | 'exited' | 'failed';

/** The disposition of a finished run's changes (spec 5.3 result review). */
export type RunReview = 'pending' | 'kept' | 'reverted';

/** One run as reported by the runs API. */
export interface RunSummary {
  id: RunId;
  state: RunState;
  /** The command the run executes (spec 5.2 / contracts §5.2 `start_run`). */
  argv: string[];
  cwd: string | null;
  /** Exit code once the run ended normally, else null. */
  exitCode: number | null;
  /** Signal number when the run was signaled, else null. */
  signal: number | null;
  /** Whether this run is currently waiting for attention (spec 6.2). */
  attention: boolean;
  startedAt: number;
  endedAt: number | null;
  /** The diff baseline (spec 5.2). */
  preRunManifest: ManifestId | null;
  postRunManifest: ManifestId | null;
  /** Counts of changed entries, once the run completed. */
  diff: DiffSummary | null;
  review: RunReview;
}

/** `GET /api/computers/:id/runs`. */
export interface RunListResponse {
  computer: ComputerId;
  runs: RunSummary[];
}

/** `POST /api/computers/:id/runs` body. */
export interface StartRunRequest {
  argv: string[];
  cwd?: string;
  /** Vault variable NAMES to inject at run start; values never travel (10.1). */
  envNames?: string[];
}

/** `POST /api/computers/:id/runs` response. */
export interface StartRunResponse {
  runId: RunId;
  state: RunState;
}

/** `POST /api/computers/:id/runs/:runId/stop` response.
 *
 *  `status` is the control plane's own run status, which carries one distinction
 *  the five client states cannot: a run stopped BEFORE it ever reached a
 *  supervisor is `cancelled`, not `failed`. The interface says "cancelled"
 *  because recording a user's own cancellation as a failure is a lie. */
export interface StopRunResponse {
  runId: RunId;
  state: RunState;
  status?: string;
  cancelled?: boolean;
  sent?: boolean;
}

/** `GET /api/config` — what this deployment IS, which the bundle cannot know.
 *
 *  The preview pane used to hardcode `https`, a build-time zone and the literal
 *  user label `'user'`, so it could not work anywhere but a hypothetical hosted
 *  instance; the sign-in screen had no way to learn whether email+password
 *  sign-in exists. Both read this instead. */
export interface ConfigResponse {
  previewZone: string;
  previewScheme: string;
  previewPort: string;
  devAuth: boolean;
  devSeed: boolean;
  /** Largest body the file-write route accepts (spec 8.5). */
  maxWriteBytes: number;
  /** Largest file the read route inlines; equal to `maxWriteBytes`. */
  maxReadBytes: number;
}

/** `POST /api/computers` and `POST /api/computers/:id/fork` (spec 9.1). */
export interface ComputerCreated {
  id: ComputerId;
  name: string;
  state: ComputerState;
  head: ManifestId | null;
  parentComputer?: ComputerId | null;
}

/** `POST /api/computers/:id/wake`. Honest in every outcome (spec 8.3). */
export interface WakeResponse {
  state: ComputerState;
  epoch?: number;
  error?: string;
  retrying?: boolean;
  retryAt?: number;
}

/** `POST /api/computers/:id/sleep` — `deep` is spec 4.4's deep sleep (COLD). */
export interface SleepResponse {
  computer: ComputerId;
  state: ComputerState;
  deep: boolean;
  /** False while the transition is still waiting on the supervisor (spec 4.5). */
  settled: boolean;
}

/** `GET /api/computers/:id/secrets` — NAMES only (spec 10.1). */
export interface SecretNamesResponse {
  names: string[];
}

/**
 * A computer-level incident: something Mari had to do that nobody asked for
 * (`GET /api/computers/:id/incidents`). Content-free like the attention log —
 * a kind, a time (Unix ms), and the epoch it happened under. The interface
 * turns the kind into plain English; the server never sends prose.
 */
export type IncidentKind =
  | 'substrate_lost'
  | 'substrate_unknown'
  | 'supervisor_lost'
  | 'final_snapshot_missed'
  | 'destroy_failed'
  | 'wake_abandoned'
  | 'recovery_exhausted'
  | 'credential_rotation';

/** One recorded incident, newest first in the listing. */
export interface IncidentRecord {
  id: number;
  kind: IncidentKind;
  /** When it happened, Unix milliseconds. */
  at: number;
  epoch: number;
}

/** `GET /api/computers/:id/incidents`. */
export interface IncidentsResponse {
  incidents: IncidentRecord[];
}

/**
 * `GET /api/computers/:id/usage` (spec 8.2 cost meter, landing this phase).
 * The client hides the meter entirely when the endpoint 404s — an older
 * control plane must not render as a broken one.
 */
export interface UsageResponse {
  /** Total AWAKE time metered, milliseconds. */
  awakeMs: number;
  /** Total substrate-materialized (box) time, milliseconds. */
  boxMs: number;
  /** Metered estimate in USD. Internal accounting; there is no billing. */
  estimatedUsd: number;
}

/** `GET /api/me/limits` (spec 10.3 surface, landing this phase). */
export interface LimitsResponse {
  /** Null means explicitly unlimited. */
  computeSecondsCap: number | null;
  computeSecondsUsed: number;
  /** Null means explicitly unlimited. */
  maxComputers: number | null;
  computers: number;
  period: string;
}

/**
 * The decoded outcome of `POST /api/computers/:id/wake`, which is honest in
 * every outcome (spec 8.3): `ok` (200), `retrying` (202 `wake_retrying` with
 * the time the DO will try again), or `refused` (503 — the state the computer
 * actually landed in, plus the reason, e.g. `substrate_not_configured`).
 */
export type WakeOutcome =
  | { outcome: 'ok'; state: ComputerState; epoch?: number }
  | { outcome: 'retrying'; state: ComputerState; retryAt: number | null; error: string }
  | { outcome: 'refused'; state: ComputerState | null; error: string };

/** `GET /api/computers/:id/preview?port=` (spec 8.5). */
export interface PreviewResponse {
  computer: ComputerId;
  port: number;
  host: string;
  /** URL carrying the one-shot capability; load this in the iframe. */
  url: string;
  /** The stable address to bookmark or paste (no capability). */
  stableUrl: string;
  expiresAt: number;
}

/** One waiting attention event (spec 6.2). Content-free by construction. */
export interface AttentionRecord {
  id: number;
  run: RunId;
  kind: AttentionKind;
  at: number;
  dismissed?: boolean;
}

/** `GET /api/computers/:id/attention`. */
export interface AttentionListResponse {
  attention: AttentionRecord[];
}

/** How one path changed between two manifests. */
export type DiffChange = 'added' | 'modified' | 'removed';

/**
 * One changed path in a manifest-to-manifest difference. This is the shape both
 * the run result review (spec 5.3) and the fork difference view (spec 9.2)
 * render — they are the same function of two manifests.
 */
export interface DiffEntry {
  path: string;
  change: DiffChange;
  /** Mode bits on each side; null where the entry does not exist. */
  oldMode: number | null;
  newMode: number | null;
  oldSize: number | null;
  newSize: number | null;
  /** Whether the file's CONTENT chunks differ (false ⇒ a mode-only change). */
  contentChanged: boolean;
}

/** A manifest-to-manifest difference (spec 5.3 result, spec 9.2 fork diff). */
export interface DiffResponse {
  /** Present for a run diff; absent for a bare manifest-to-manifest diff. */
  runId?: RunId;
  /** Baseline manifest (pre-run / fork point). */
  base: ManifestId | null;
  /** Compared manifest (post-run / fork head). */
  head: ManifestId | null;
  summary: DiffSummary;
  entries: DiffEntry[];
  /** True when the server capped the entry list. */
  truncated?: boolean;
}

/** `POST .../runs/:runId/keep` and `.../revert`. */
export interface ReviewResponse {
  runId: RunId;
  review: RunReview;
  /** The manifest head after the decision (a revert restores the baseline). */
  head: ManifestId | null;
}

/** `POST /api/computers/:id/snapshot` (spec 4.3, user command). */
export interface SnapshotResponse {
  computer: ComputerId;
  manifest: ManifestId | null;
  state: ComputerState;
}

/**
 * `PUT /api/computers/:id/file` — a write WAKES a computer that is not AWAKE
 * (spec 8.4). The response reports the resulting state so the interface can
 * show the transition WITHOUT blocking on it (spec 8.3).
 */
export interface WriteFileResponse {
  ok: boolean;
  path: string;
  state: ComputerState;
}

/** `POST /api/computers/:id/upload` (multipart). Same wake semantics as PUT. */
export interface UploadResponse {
  ok: boolean;
  path: string;
  state: ComputerState;
}

/**
 * A computer's detail. The control plane's `GET /api/computers/:id` names the
 * display field `name` (the fleet listing calls the same thing `hostname`), so
 * both are declared optional here rather than pretending one shape covers
 * both — the runs list is the field this view actually exists for.
 */
export interface ComputerDetail extends Omit<FleetComputer, 'hostname'> {
  hostname?: string;
  name?: string;
  runs?: RunSummary[];
}

// ---- /api/events (SSE) ----
//
// Spec 6.2: the supervisor sends a CONTENT-FREE attention event; the control
// plane notifies the user and the notification opens the terminal pane of the
// run. Every event below is therefore metadata only — there is no message text,
// no terminal bytes, and no prompt content anywhere in these shapes, and the UI
// has nothing of the sort to render.

/** Fields common to every server event. */
export interface EventBase {
  /** Monotonic sequence for this stream; used to de-duplicate and reorder. */
  seq: number;
  /** Emission time, Unix milliseconds. */
  at: number;
  computer: ComputerId;
}

/** A run started waiting for attention, or stopped waiting (spec 6.2). */
export interface AttentionEvent extends EventBase {
  type: 'attention';
  runId: RunId;
  /** `waiting` badges the fleet card and the workspace; `cleared` removes it. */
  state: 'waiting' | 'cleared';
  /** The generic terminal signal that raised it (spec 6.1). Metadata only. */
  kind?: AttentionKind;
}

/** A run changed lifecycle state (spec 5.5 completion event included). */
export interface RunEvent extends EventBase {
  type: 'run';
  runId: RunId;
  state: RunState;
  exitCode?: number | null;
}

/** A computer changed state (spec §2 states; e.g. a write-triggered wake). */
export interface StateEvent extends EventBase {
  type: 'state';
  state: ComputerState;
}

export type MariEvent = AttentionEvent | RunEvent | StateEvent;

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
