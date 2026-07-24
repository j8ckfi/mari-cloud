// Wire-message types mirroring `crates/mari-proto::messages`.
//
// The two envelopes are adjacently tagged: on the wire each message is
// `{ t: <variant>, c: <payload> }`, with `c` absent for payload-free variants.
// Field names and casing match the CBOR map keys exactly.

import type { ComputerId, Epoch, JournalOffset, ManifestId, RunId } from './ids';
import type { DiffSummary, SnapshotReason } from './manifest';

/** Generic attention signal (spec 6.1). Bare snake_case string. */
export type AttentionKind = 'bell' | 'osc' | 'blocked_read';

/** How a child process ended. Adjacently tagged like the envelopes. */
export type ExitStatus =
  | { t: 'exited'; c: { code: number } }
  | { t: 'signaled'; c: { signal: number } };

/** One run's durably-acked journal offset. */
export interface RunOffset {
  run: RunId;
  offset: JournalOffset;
}

// ---- supervisor -> control payloads ----

export interface Hello {
  computer: ComputerId;
  epoch: Epoch;
  token: string;
  proto_version: number;
}

export interface JournalFrame {
  run: RunId;
  offset: JournalOffset;
  /** Raw journal bytes; a CBOR byte string decoded to `Uint8Array`. */
  bytes: Uint8Array;
}

export interface RunStarted {
  run: RunId;
  pre_run_manifest: ManifestId;
}

export interface RunCompleted {
  run: RunId;
  exit: ExitStatus;
  post_run_manifest: ManifestId;
  diff: DiffSummary;
}

export interface SnapshotWritten {
  manifest: ManifestId;
  epoch: Epoch;
  reason: SnapshotReason;
}

export interface HeadAdvanceRequest {
  manifest: ManifestId;
  epoch: Epoch;
}

export interface Attention {
  run: RunId;
  kind: AttentionKind;
}

export interface RunHeartbeat {
  run: RunId;
}

/** Supervisor -> control envelope. */
export type SupervisorMessage =
  | { t: 'hello'; c: Hello }
  | { t: 'journal_frame'; c: JournalFrame }
  | { t: 'run_started'; c: RunStarted }
  | { t: 'run_completed'; c: RunCompleted }
  | { t: 'snapshot_written'; c: SnapshotWritten }
  | { t: 'head_advance_request'; c: HeadAdvanceRequest }
  | { t: 'attention'; c: Attention }
  | { t: 'run_heartbeat'; c: RunHeartbeat };

/** Discriminant strings of {@link SupervisorMessage}. */
export type SupervisorMessageTag = SupervisorMessage['t'];

// ---- control -> supervisor payloads ----

export interface HelloAck {
  acked: RunOffset[];
}

export interface JournalAck {
  run: RunId;
  offset: JournalOffset;
}

export interface StartRun {
  run: RunId;
  argv: string[];
  /** Env var names to inject from the vault at run start; values never here. */
  env_names: string[];
  cwd: string;
}

export interface StopRun {
  run: RunId;
}

/** Terminal input for a run's PTY, forwarded by the DO from the attach protocol. */
export interface Input {
  run: RunId;
  /** Raw bytes to write to the run's PTY; a CBOR byte string / `Uint8Array`. */
  bytes: Uint8Array;
}

/** Viewport resize for a run's PTY window (spec 7.5). */
export interface Resize {
  run: RunId;
  cols: number;
  rows: number;
}

export interface SnapshotNow {
  reason: SnapshotReason;
}

export interface HeadAdvanceResult {
  accepted: boolean;
  current_epoch: Epoch;
}

export interface RestoreToManifest {
  manifest: ManifestId;
}

/** Control -> supervisor envelope. `prepare_for_cold` carries no payload. */
export type ControlMessage =
  | { t: 'hello_ack'; c: HelloAck }
  | { t: 'journal_ack'; c: JournalAck }
  | { t: 'start_run'; c: StartRun }
  | { t: 'stop_run'; c: StopRun }
  | { t: 'input'; c: Input }
  | { t: 'resize'; c: Resize }
  | { t: 'snapshot_now'; c: SnapshotNow }
  | { t: 'prepare_for_cold' }
  | { t: 'head_advance_result'; c: HeadAdvanceResult }
  | { t: 'restore_to_manifest'; c: RestoreToManifest };

/** Discriminant strings of {@link ControlMessage}. */
export type ControlMessageTag = ControlMessage['t'];
