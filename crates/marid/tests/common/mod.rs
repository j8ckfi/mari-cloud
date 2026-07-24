//! e2e harness: a reachable fake control plane and thin Docker CLI helpers.
//!
//! This module supports the Docker cold-wake thesis test (`e2e_docker.rs`,
//! decisions.md "e2e (Docker)"). It is deliberately self-contained and lives in
//! the test lane (not in `marid`'s `src`), because it needs two things marid's
//! in-crate `testkit` does not offer:
//!
//! 1. A control plane bound to `0.0.0.0` (not loopback) so a container can reach
//!    it via `host.docker.internal`. The wire logic is otherwise the same framed
//!    CBOR as `testkit`, reusing marid's own [`marid::ws`] send/decode helpers.
//! 2. Real epoch fencing (spec 4.1 / decisions.md): the DO mints a monotonically
//!    increasing epoch at each wake, and a manifest-head advance carrying a stale
//!    epoch is rejected (compare-and-swap). `testkit` always accepts; here we
//!    enforce it, which is what step 4 of the thesis test exercises.
//!
//! The substrate is driven entirely through the `docker` CLI from the test
//! process. The production substrate driver is TypeScript in the control plane
//! (decisions.md "Substrate drivers are TypeScript"); it is intentionally out of
//! scope for this Rust-side storage-continuity proof.

#![allow(dead_code)]

use std::collections::{HashMap, VecDeque};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use mari_proto::{
    AttentionKind, ComputerId, ControlMessage, DiffSummary, Epoch, ExitStatus, FrameReader,
    JournalOffset, ManifestId, RunId, RunOffset, RunRollback, SnapshotReason, SupervisorMessage,
};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use marid::ws::{decode_payload, send_framed};

// ===========================================================================
// Fake control plane (reachable from containers; enforces epoch fencing)
// ===========================================================================

/// What a supervisor said in its `Hello`.
#[derive(Clone, Debug)]
pub struct HelloRecord {
    pub computer: ComputerId,
    pub epoch: Epoch,
    pub token: String,
    pub proto_version: u32,
    /// The connection index this Hello arrived on (0-based, in accept order).
    pub conn: usize,
}

/// A recorded manifest-head advance and the fencing verdict it received.
#[derive(Clone, Debug)]
pub struct HeadAdvance {
    pub manifest: ManifestId,
    pub epoch: Epoch,
    pub accepted: bool,
}

/// Offset-addressed reassembly of one run's journal, with integrity checks:
/// a gap (offset beyond the contiguous end) or a conflicting duplicate
/// (overlapping bytes that disagree) is recorded as an error.
#[derive(Default)]
pub struct RunReassembly {
    pub buf: Vec<u8>,
    pub acked: u64,
}

impl RunReassembly {
    fn ingest(&mut self, offset: u64, bytes: &[u8]) -> Result<(), String> {
        let have = self.buf.len() as u64;
        if offset > have {
            return Err(format!(
                "journal gap: frame offset {offset} beyond contiguous {have}"
            ));
        }
        let end = offset + bytes.len() as u64;
        let overlap_end = end.min(have);
        if offset < overlap_end {
            let existing = &self.buf[offset as usize..overlap_end as usize];
            let incoming = &bytes[..(overlap_end - offset) as usize];
            if existing != incoming {
                return Err(format!(
                    "journal duplicate mismatch at [{offset}, {overlap_end})"
                ));
            }
        }
        if end > have {
            let new_from = (have - offset) as usize;
            self.buf.extend_from_slice(&bytes[new_from..]);
        }
        Ok(())
    }
}

/// A WARM-rollback report the supervisor sent (spec 4.7).
#[derive(Clone, Debug)]
pub struct RollbackReport {
    pub disk_manifest: ManifestId,
    pub recorded_manifest: Option<ManifestId>,
    pub diff: DiffSummary,
    pub runs: Vec<RunRollback>,
}

/// Everything the fake control plane observed. Tests lock and assert against it.
#[derive(Default)]
pub struct FakeState {
    pub hellos: Vec<HelloRecord>,
    pub connections: u32,
    pub journals: HashMap<RunId, RunReassembly>,
    pub run_started: Vec<(RunId, ManifestId)>,
    pub run_completed: Vec<(RunId, ExitStatus, ManifestId, DiffSummary)>,
    pub snapshots: Vec<(ManifestId, Epoch, SnapshotReason)>,
    pub head_advances: Vec<HeadAdvance>,
    pub attentions: Vec<(RunId, AttentionKind)>,
    pub heartbeats: HashMap<RunId, u32>,
    /// WARM-rollback reports received (spec 4.7).
    pub rollbacks: Vec<RollbackReport>,
    pub errors: Vec<String>,
    /// The DO's current (authoritative) fencing epoch: the max epoch of any
    /// `Hello` seen so far. Monotonic — a later wake never lowers it.
    pub current_epoch: u64,
    /// The last accepted manifest head.
    pub head: Option<ManifestId>,
}

impl FakeState {
    /// The reassembled journal bytes for a run (contiguous received bytes).
    pub fn journal(&self, run: &RunId) -> Vec<u8> {
        self.journals.get(run).map(|r| r.buf.clone()).unwrap_or_default()
    }

    /// The completed-run record for `run`, if any.
    pub fn completion(
        &self,
        run: &RunId,
    ) -> Option<&(RunId, ExitStatus, ManifestId, DiffSummary)> {
        self.run_completed.iter().find(|(r, ..)| r == run)
    }

    /// Head advances observed for a given epoch with a given verdict.
    pub fn advances(&self, epoch: u64, accepted: bool) -> Vec<&HeadAdvance> {
        self.head_advances
            .iter()
            .filter(|a| a.epoch.get() == epoch && a.accepted == accepted)
            .collect()
    }
}

struct Ctrl {
    /// Per-connection outbound control-message queues.
    pending: Mutex<HashMap<usize, VecDeque<ControlMessage>>>,
}

/// A fake control-plane server bound to `0.0.0.0` (reachable from containers).
pub struct FakeCp {
    port: u16,
    state: Arc<Mutex<FakeState>>,
    ctrl: Arc<Ctrl>,
    _accept: tokio::task::JoinHandle<()>,
}

impl FakeCp {
    /// Bind on all interfaces and start accepting.
    pub async fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("0.0.0.0:0").await?;
        let port = listener.local_addr()?.port();
        let state = Arc::new(Mutex::new(FakeState::default()));
        let ctrl = Arc::new(Ctrl {
            pending: Mutex::new(HashMap::new()),
        });
        let accept = tokio::spawn(accept_loop(listener, state.clone(), ctrl.clone()));
        Ok(Self {
            port,
            state,
            ctrl,
            _accept: accept,
        })
    }

    /// The host port the server is bound to.
    pub fn port(&self) -> u16 {
        self.port
    }

    /// The URL a container should connect to (via `host.docker.internal`).
    pub fn container_url(&self) -> String {
        format!("ws://host.docker.internal:{}/", self.port)
    }

    /// Queue a control message for a specific connection (by accept index).
    pub fn queue_to(&self, conn: usize, msg: ControlMessage) {
        self.ctrl
            .pending
            .lock()
            .unwrap()
            .entry(conn)
            .or_default()
            .push_back(msg);
    }

    /// Inspect the observed state under the lock.
    pub fn with_state<R>(&self, f: impl FnOnce(&FakeState) -> R) -> R {
        f(&self.state.lock().unwrap())
    }

    /// Poll `pred` against the observed state until it holds or `timeout` elapses.
    pub async fn wait_until(&self, timeout: Duration, pred: impl Fn(&FakeState) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if pred(&self.state.lock().unwrap()) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    }

    /// Wait until at least `n` connections have been accepted; returns the
    /// 0-based index of connection `n` (i.e. `n - 1`) on success.
    pub async fn wait_for_connection(&self, n: u32, timeout: Duration) -> Option<usize> {
        if self.wait_until(timeout, |s| s.connections >= n).await {
            Some((n - 1) as usize)
        } else {
            None
        }
    }
}

async fn accept_loop(listener: TcpListener, state: Arc<Mutex<FakeState>>, ctrl: Arc<Ctrl>) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => break,
        };
        // One task per connection: connections in this test are sequential, but a
        // per-connection task keeps a lingering socket from blocking a fresh wake.
        let state = state.clone();
        let ctrl = ctrl.clone();
        tokio::spawn(async move {
            let ws = match accept_async(stream).await {
                Ok(ws) => ws,
                Err(_) => return,
            };
            serve_conn(ws, state, ctrl).await;
        });
    }
}

async fn serve_conn(ws: WebSocketStream<TcpStream>, state: Arc<Mutex<FakeState>>, ctrl: Arc<Ctrl>) {
    let conn_idx = {
        let mut s = state.lock().unwrap();
        s.connections += 1;
        (s.connections - 1) as usize
    };
    let (mut write, mut read) = ws.split();
    let mut frames = FrameReader::new();
    let mut tick = tokio::time::interval(Duration::from_millis(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Binary(payload))) => {
                        let mut msgs: Vec<SupervisorMessage> = Vec::new();
                        if let Err(e) = decode_payload(&mut frames, payload.as_ref(), &mut msgs) {
                            state.lock().unwrap().errors.push(format!("decode: {e}"));
                            return;
                        }
                        for m in msgs {
                            if handle_sup(m, &mut write, &state, conn_idx).await.is_err() {
                                return;
                            }
                        }
                    }
                    Some(Ok(Message::Ping(p))) => {
                        let _ = write.send(Message::Pong(p)).await;
                    }
                    Some(Ok(Message::Close(_))) | None => return,
                    Some(Ok(_)) => {}
                    Some(Err(_)) => return,
                }
            }
            _ = tick.tick() => {
                let batch: Vec<ControlMessage> = {
                    let mut q = ctrl.pending.lock().unwrap();
                    q.get_mut(&conn_idx).map(|dq| dq.drain(..).collect()).unwrap_or_default()
                };
                for cm in batch {
                    if send_framed(&mut write, &cm).await.is_err() {
                        return;
                    }
                }
            }
        }
    }
}

async fn handle_sup(
    msg: SupervisorMessage,
    write: &mut futures_util::stream::SplitSink<WebSocketStream<TcpStream>, Message>,
    state: &Arc<Mutex<FakeState>>,
    conn_idx: usize,
) -> Result<(), ()> {
    match msg {
        SupervisorMessage::Hello {
            computer,
            epoch,
            token,
            proto_version,
        } => {
            let acked = {
                let mut s = state.lock().unwrap();
                s.hellos.push(HelloRecord {
                    computer,
                    epoch,
                    token,
                    proto_version,
                    conn: conn_idx,
                });
                // Fencing: the DO's current epoch is the max epoch ever seen. A
                // fresh wake at a higher epoch fences out every older supervisor.
                if epoch.get() > s.current_epoch {
                    s.current_epoch = epoch.get();
                }
                s.journals
                    .iter()
                    .map(|(run, r)| RunOffset {
                        run: run.clone(),
                        offset: JournalOffset::new(r.acked),
                    })
                    .collect::<Vec<_>>()
            };
            send_framed(write, &ControlMessage::HelloAck { acked })
                .await
                .map_err(|_| ())?;
        }
        SupervisorMessage::JournalFrame { run, offset, bytes } => {
            let ack = {
                let mut s = state.lock().unwrap();
                let entry = s.journals.entry(run.clone()).or_default();
                if let Err(e) = entry.ingest(offset.get(), &bytes) {
                    s.errors.push(e);
                    return Err(());
                }
                let received = entry.buf.len() as u64;
                if received > entry.acked {
                    entry.acked = received;
                    Some(received)
                } else {
                    None
                }
            };
            if let Some(offset) = ack {
                send_framed(
                    write,
                    &ControlMessage::JournalAck {
                        run,
                        offset: JournalOffset::new(offset),
                    },
                )
                .await
                .map_err(|_| ())?;
            }
        }
        SupervisorMessage::RunStarted {
            run,
            pre_run_manifest,
        } => {
            state.lock().unwrap().run_started.push((run, pre_run_manifest));
        }
        SupervisorMessage::RunCompleted {
            run,
            exit,
            post_run_manifest,
            diff,
        } => {
            state
                .lock()
                .unwrap()
                .run_completed
                .push((run, exit, post_run_manifest, diff));
        }
        SupervisorMessage::SnapshotWritten {
            manifest,
            epoch,
            reason,
        } => {
            state.lock().unwrap().snapshots.push((manifest, epoch, reason));
        }
        SupervisorMessage::HeadAdvanceRequest { manifest, epoch } => {
            // Compare-and-swap on the epoch (spec 4.1 / decisions.md fencing).
            let current = {
                let mut s = state.lock().unwrap();
                let current = s.current_epoch;
                let accepted = epoch.get() >= current && current != 0;
                if accepted {
                    s.head = Some(manifest.clone());
                }
                s.head_advances.push(HeadAdvance {
                    manifest,
                    epoch,
                    accepted,
                });
                current
            };
            let accepted = epoch.get() >= current && current != 0;
            send_framed(
                write,
                &ControlMessage::HeadAdvanceResult {
                    accepted,
                    current_epoch: Epoch::new(current),
                },
            )
            .await
            .map_err(|_| ())?;
        }
        SupervisorMessage::Attention { run, kind } => {
            state.lock().unwrap().attentions.push((run, kind));
        }
        SupervisorMessage::RunHeartbeat { run } => {
            *state.lock().unwrap().heartbeats.entry(run).or_insert(0) += 1;
        }
        SupervisorMessage::RollbackDetected {
            disk_manifest,
            recorded_manifest,
            diff,
            runs,
        } => {
            state.lock().unwrap().rollbacks.push(RollbackReport {
                disk_manifest,
                recorded_manifest,
                diff,
                runs,
            });
        }
    }
    Ok(())
}

// ===========================================================================
// Docker CLI helpers
// ===========================================================================

/// Is a working Docker daemon reachable? Used to skip when unavailable.
pub fn docker_available() -> bool {
    Command::new("docker")
        .args(["info", "--format", "{{.ServerVersion}}"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
}

/// Run a docker subcommand, returning its captured output. Never inherits stdio,
/// so binary payloads (e.g. `docker cp -`) are byte-exact.
pub fn docker(args: &[&str]) -> std::io::Result<Output> {
    Command::new("docker").args(args).output()
}

/// Run a docker subcommand and fail loudly if it does not succeed.
pub fn docker_ok(args: &[&str]) -> Output {
    let out = docker(args).unwrap_or_else(|e| panic!("docker {args:?} failed to spawn: {e}"));
    if !out.status.success() {
        panic!(
            "docker {args:?} exited {:?}\nstdout:\n{}\nstderr:\n{}",
            out.status.code(),
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
    out
}

/// Ensure an image is present locally (pull if missing). Idempotent.
pub fn ensure_image(image: &str) {
    let present = docker(&["image", "inspect", image])
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !present {
        docker_ok(&["pull", "--platform", "linux/arm64", image]);
    }
}

/// Create a named volume if it does not already exist (idempotent).
pub fn ensure_volume(name: &str) {
    let _ = docker(&["volume", "create", name]);
}

/// True if the named container exists and is currently running.
pub fn container_running(name: &str) -> bool {
    docker(&["inspect", "-f", "{{.State.Running}}", name])
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim() == "true")
        .unwrap_or(false)
}

/// Read `path` out of a container as raw bytes via `docker cp` to stdout. This
/// is byte-exact (tar stream unpacked in-process), unlike `exec cat` over a PTY.
pub fn cp_out_bytes(container: &str, path: &str) -> Vec<u8> {
    // `docker cp <c>:<path> -` writes a tar archive of the single file to stdout.
    let out = docker_ok(&["cp", &format!("{container}:{path}"), "-"]);
    untar_single_file(&out.stdout)
        .unwrap_or_else(|| panic!("could not extract {path} from cp tar stream"))
}

/// Extract the single regular-file member's bytes from a (ustar) tar stream.
fn untar_single_file(tar: &[u8]) -> Option<Vec<u8>> {
    let mut pos = 0usize;
    while pos + 512 <= tar.len() {
        let header = &tar[pos..pos + 512];
        // Two consecutive zero blocks mark end-of-archive.
        if header.iter().all(|&b| b == 0) {
            return None;
        }
        // Size is an octal ASCII field at offset 124, length 12.
        let size_field = &header[124..136];
        let size_str = size_field
            .iter()
            .take_while(|&&b| b != 0 && b != b' ')
            .map(|&b| b as char)
            .collect::<String>();
        let size = u64::from_str_radix(size_str.trim(), 8).ok()? as usize;
        let typeflag = header[156];
        pos += 512;
        // Regular file: '0' or NUL.
        if typeflag == b'0' || typeflag == 0 {
            let body = tar.get(pos..pos + size)?.to_vec();
            return Some(body);
        }
        // Skip this member's (padded) body.
        pos += size.div_ceil(512) * 512;
    }
    None
}

/// Force-remove every container carrying `label` (e.g. "mari-e2e-run=<id>").
/// Safe to call repeatedly and on the cleanup path.
pub fn cleanup_by_label(label: &str) {
    if let Ok(out) = docker(&["ps", "-aq", "--filter", &format!("label={label}")]) {
        let ids: Vec<String> = String::from_utf8_lossy(&out.stdout)
            .split_whitespace()
            .map(|s| s.to_string())
            .collect();
        for id in ids {
            let _ = docker(&["rm", "-f", &id]);
        }
    }
}

/// RAII guard that force-removes all containers with the label on drop, so a
/// panicking assertion still cleans up the substrate.
pub struct LabelCleanup {
    label: String,
    armed: AtomicBool,
}

impl LabelCleanup {
    pub fn new(label: impl Into<String>) -> Self {
        Self {
            label: label.into(),
            armed: AtomicBool::new(true),
        }
    }
    pub fn label(&self) -> &str {
        &self.label
    }
    pub fn run(&self) {
        cleanup_by_label(&self.label);
    }
}

impl Drop for LabelCleanup {
    fn drop(&mut self) {
        if self.armed.load(Ordering::SeqCst) {
            cleanup_by_label(&self.label);
        }
    }
}
