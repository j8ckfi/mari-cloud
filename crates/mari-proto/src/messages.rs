//! The framed-CBOR wire protocol between the supervisor (`marid`) and the
//! control plane (decisions.md: "framed CBOR over WebSocket").
//!
//! Two envelopes carry every message: [`SupervisorMessage`] (supervisor ->
//! control) and [`ControlMessage`] (control -> supervisor). Both are
//! **adjacently tagged**: on the wire a message is a map `{ "t": <variant>,
//! "c": <payload> }`, where `t` is the snake_case variant name and `c` is the
//! payload struct (absent for payload-free variants). Simple field enums
//! ([`ComputerState`], [`SnapshotReason`], [`AttentionKind`]) serialize as bare
//! snake_case strings; data-carrying enums ([`ExitStatus`]) are adjacently
//! tagged like the envelopes.

use serde::{Deserialize, Serialize};

use crate::ids::{ComputerId, Epoch, JournalOffset, ManifestId, RunId};
use crate::manifest::{DiffSummary, SnapshotReason};

/// Protocol version advertised in [`SupervisorMessage::Hello`]. Bump on any
/// breaking change to these types.
pub const PROTO_VERSION: u32 = 1;

/// Lifecycle state of a computer (spec §2). Serialized as a bare snake_case
/// string. Not carried in any single message here, but part of the shared
/// contract the Durable Object holds and the fleet view renders.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ComputerState {
    /// Materialized on a substrate; processes active; billing active.
    Awake,
    /// On a substrate in native sleep; wake is immediate.
    Warm,
    /// In the chunk store only; no substrate resources.
    Cold,
    /// In transition to `Awake`.
    Waking,
}

/// Why the supervisor detected an attention state (spec 6.1). Content-free: the
/// kind is the entire signal — no terminal text ever accompanies it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttentionKind {
    /// The terminal bell (`BEL`, 0x07).
    Bell,
    /// A notification escape sequence (OSC 9 / OSC 777).
    Osc,
    /// A blocked read on the PTY with no output past the idle threshold.
    BlockedRead,
    /// A run the supervisor could not continue: it was unfinished at a restart
    /// and its agent declares no resume (spec 5.6's defined degradation), or a
    /// WARM rollback (spec 4.7) destroyed work the supervisor may not safely
    /// replay. The run's journal is preserved; the user decides what happens
    /// next. Still content-free: no terminal text, no reason string.
    Interrupted,
}

/// How a child process ended. Adjacently tagged: `{ "t": "exited", "c": {
/// "code": 0 } }` or `{ "t": "signaled", "c": { "signal": 9 } }`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", content = "c", rename_all = "snake_case")]
pub enum ExitStatus {
    /// Process called `exit(code)`.
    Exited {
        /// The exit code.
        code: i32,
    },
    /// Process was terminated by a signal.
    Signaled {
        /// The terminating signal number.
        signal: i32,
    },
}

/// One run's most-recently-acked journal offset, used in
/// [`ControlMessage::HelloAck`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunOffset {
    /// The run being acked.
    pub run: RunId,
    /// The byte offset the control plane has durably received up to.
    pub offset: JournalOffset,
}

/// One run's journal divergence in a [`SupervisorMessage::RollbackDetected`]
/// report: what the control plane holds against what survived on the disk.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunRollback {
    /// The unfinished run this entry describes.
    pub run: RunId,
    /// Journal bytes the control plane durably holds for the run (its
    /// `hello_ack` offset) — the journal head, per spec 4.7.
    pub control_offset: JournalOffset,
    /// Journal bytes still present for the run on the restored (older) disk.
    /// Less than `control_offset` means the disk lost recorded journal bytes.
    pub disk_offset: JournalOffset,
    /// True if the supervisor judged replay safe and restarted the run; false
    /// if it left the run interrupted and raised an attention event instead.
    pub replayed: bool,
}

/// Supervisor -> control messages. Adjacently tagged (`t`/`c`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", content = "c", rename_all = "snake_case")]
pub enum SupervisorMessage {
    /// First message after the WebSocket opens: identifies the computer, its
    /// current fencing epoch, an auth token, and the protocol version.
    Hello {
        /// The computer this supervisor serves.
        computer: ComputerId,
        /// The epoch minted for this wake.
        epoch: Epoch,
        /// Opaque bearer token issued by the control plane at wake.
        token: String,
        /// [`PROTO_VERSION`] the supervisor speaks.
        proto_version: u32,
    },
    /// A slice of a run's journal (terminal bytes and framed tool events).
    /// `bytes` is a CBOR byte string starting at `offset`.
    JournalFrame {
        /// The run this journal slice belongs to.
        run: RunId,
        /// Byte offset of the first byte of `bytes` within the run's journal.
        offset: JournalOffset,
        /// Raw journal bytes. Encoded as a CBOR byte string / `Uint8Array`.
        #[serde(with = "serde_bytes")]
        bytes: Vec<u8>,
    },
    /// A run has started. Names the run and the manifest captured immediately
    /// before it (its diff baseline, spec 5.2).
    RunStarted {
        /// The run that started.
        run: RunId,
        /// The pre-run manifest, the baseline for this run's diff.
        pre_run_manifest: ManifestId,
    },
    /// A run has finished. Carries the exit status, the post-run manifest, and
    /// the diff counts against the pre-run manifest.
    RunCompleted {
        /// The run that completed.
        run: RunId,
        /// How the run's root process ended.
        exit: ExitStatus,
        /// Manifest captured after the run.
        post_run_manifest: ManifestId,
        /// Diff of the post-run manifest against the pre-run manifest.
        diff: DiffSummary,
    },
    /// A snapshot was written to the chunk store (spec 4.3).
    SnapshotWritten {
        /// The manifest id that was written.
        manifest: ManifestId,
        /// The epoch under which it was written (for fencing).
        epoch: Epoch,
        /// Why the snapshot was taken.
        reason: SnapshotReason,
    },
    /// Request to advance the manifest head to `manifest`. The Durable Object
    /// accepts only if `epoch` is current (compare-and-swap; decisions.md
    /// fencing) and replies with [`ControlMessage::HeadAdvanceResult`].
    HeadAdvanceRequest {
        /// The manifest to make the new head.
        manifest: ManifestId,
        /// The supervisor's epoch, checked against the DO's current epoch.
        epoch: Epoch,
    },
    /// A content-free attention event (spec 6.2). No terminal text is included;
    /// the kind is the whole payload.
    Attention {
        /// The run that needs attention.
        run: RunId,
        /// The generic signal that was detected.
        kind: AttentionKind,
    },
    /// Periodic liveness for a run; also the substrate hold on providers that
    /// stop idle machines (spec 5.4).
    RunHeartbeat {
        /// The run being held alive.
        run: RunId,
    },
    /// The supervisor found, at connect, that the substrate had restored an old
    /// checkpoint: the disk is behind what was recorded (a WARM rollback, spec
    /// 4.7). This is the structured report of the difference. It is a *report*,
    /// not a request: the supervisor has already decided per run whether replay
    /// was safe (`RunRollback::replayed`) and raised an attention event for each
    /// run it did not replay.
    RollbackDetected {
        /// Manifest of the tree actually found on disk at connect.
        disk_manifest: ManifestId,
        /// The newest manifest the supervisor had recorded before the rollback,
        /// or `null` if it had recorded none.
        recorded_manifest: Option<ManifestId>,
        /// The difference of the on-disk tree measured **against**
        /// `recorded_manifest`: `removed` counts entries the recorded head has
        /// that the disk lost, `added` counts entries only the disk has.
        diff: DiffSummary,
        /// Per-run journal divergence and the replay verdict for each
        /// unfinished run.
        runs: Vec<RunRollback>,
    },
}

/// Control -> supervisor messages. Adjacently tagged (`t`/`c`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "t", content = "c", rename_all = "snake_case")]
pub enum ControlMessage {
    /// Reply to [`SupervisorMessage::Hello`]: the durably-acked journal offset
    /// per run, so the supervisor resumes streaming from the right place.
    HelloAck {
        /// Acked offsets, one per known run.
        acked: Vec<RunOffset>,
    },
    /// Acknowledge journal bytes up to `offset` for one run.
    JournalAck {
        /// The run being acked.
        run: RunId,
        /// Bytes durably received up to (but not including) this offset.
        offset: JournalOffset,
    },
    /// Start a run. The supervisor owns the process; the connection does not
    /// (spec 5.1).
    StartRun {
        /// Id to assign the new run.
        run: RunId,
        /// The command and its arguments (`argv[0]` is the program).
        argv: Vec<String>,
        /// Names of environment variables to inject from the control-plane
        /// vault at run start (spec 10.1). Values never travel in this message.
        env_names: Vec<String>,
        /// Working directory for the run.
        cwd: String,
    },
    /// Stop a run's process.
    StopRun {
        /// The run to stop.
        run: RunId,
    },
    /// Terminal input for a run's PTY: the raw bytes an attached client typed
    /// (keystrokes, paste). The Durable Object forwards these supervisor-ward
    /// from the client<->DO attach protocol (contracts §7.1); the supervisor
    /// writes them to the run's PTY. `bytes` is a CBOR byte string.
    Input {
        /// The run whose PTY receives the bytes.
        run: RunId,
        /// Raw bytes to write to the run's PTY.
        #[serde(with = "serde_bytes")]
        bytes: Vec<u8>,
    },
    /// Viewport resize for a run's PTY: set the terminal window size (spec 7.5).
    /// Forwarded by the Durable Object from the client<->DO attach protocol.
    Resize {
        /// The run whose PTY window size changes.
        run: RunId,
        /// New column count.
        cols: u16,
        /// New row count.
        rows: u16,
    },
    /// Take a snapshot now, tagging it with `reason` (spec 4.3).
    SnapshotNow {
        /// Why the snapshot is being requested.
        reason: SnapshotReason,
    },
    /// Stop each agent session cleanly ahead of the WARM->COLD transition
    /// (spec 4.5). Payload-free.
    PrepareForCold,
    /// Reply to [`SupervisorMessage::HeadAdvanceRequest`]: whether the advance
    /// was accepted, and the DO's current epoch (so a fenced-out supervisor
    /// learns it lost).
    HeadAdvanceResult {
        /// True if the head advanced; false if the epoch was stale.
        accepted: bool,
        /// The DO's current (authoritative) epoch.
        current_epoch: Epoch,
    },
    /// Restore the substrate disk to a given manifest (spec 5.3 restore / 4.7
    /// replay).
    RestoreToManifest {
        /// The manifest to restore to.
        manifest: ManifestId,
    },
}
