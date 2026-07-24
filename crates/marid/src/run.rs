//! The run manager: the supervisor owns every run (spec 5.1).
//!
//! A run is a task an agent does on the computer. Starting one takes a pre-run
//! snapshot (the diff baseline, spec 5.2), spawns the command on a **real PTY**
//! (`portable-pty`), and streams its output into a [`Journal`] with monotonic
//! offsets. Output is watched for content-free attention signals
//! ([`crate::attention`]) and, when the child blocks silently with stdin open,
//! for the silence threshold. On exit a post-run snapshot is taken, diffed
//! against the pre-run manifest, and a `RunCompleted` is emitted (spec 5.3, 5.5).
//!
//! A network connection does not own a run: the child, its journal, and its
//! lifecycle live entirely here, so a dropped WebSocket (a closed laptop) never
//! stops a run (spec 5.1). The journal is streamed by pull off the buffer, which
//! is what makes reconnect-resume gap-free.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use mari_core::{ChunkStore, SnapshotOptions, default_credential_excludes, diff, snapshot};
use mari_proto::{
    AttentionKind, ComputerId, Epoch, ExitStatus, ManifestId, RunId, SnapshotReason,
    SupervisorMessage,
};
use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};
use tokio::sync::Notify;
use tokio::sync::mpsc::UnboundedSender;
use tracing::{debug, warn};

use crate::journal::Journal;

/// The shared map of live runs.
type RunsMap = Arc<Mutex<HashMap<RunId, Arc<RunState>>>>;

/// Shared context every run task needs.
struct RunCtx {
    store: ChunkStore,
    root: PathBuf,
    journal_dir: PathBuf,
    computer: ComputerId,
    epoch: Epoch,
    outbox: UnboundedSender<SupervisorMessage>,
    /// Woken whenever new journal bytes land, so the streamer flushes promptly.
    journal_notify: Arc<Notify>,
    silence_threshold: Duration,
    segment_size: usize,
    excludes: Vec<String>,
    /// All live runs, shared so a completion task can deregister its own run.
    runs: RunsMap,
    /// Every run's journal, kept for the process lifetime so a run that has
    /// completed can still have its unacked tail streamed after a reconnect. A
    /// completed run leaves `runs` but its journal stays here (spec 5.1: the
    /// journal outlives the connection).
    journals: Mutex<HashMap<RunId, Arc<Journal>>>,
}

/// Handle to one running (or completed) run. Tests and the supervisor read the
/// journal and the pre-run manifest through it.
pub struct RunState {
    /// The run id.
    pub id: RunId,
    /// The run's journal (owned by the supervisor, not the connection).
    pub journal: Arc<Journal>,
    /// The manifest captured immediately before the run — its diff baseline.
    pub pre_run_manifest: ManifestId,
    alive: AtomicBool,
    killer: Mutex<Option<Box<dyn ChildKiller + Send + Sync>>>,
    last_output: Mutex<Instant>,
    silence_fired: AtomicBool,
    /// Notified once to stop the housekeeping loop at completion.
    done: Arc<Notify>,
    // Held open for the run's lifetime: the pty master (keeps the pty alive and
    // carries window-size changes) and its writer (client input to the child's
    // stdin; also keeps stdin open so a blocked read stays blocked rather than
    // seeing EOF).
    master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    writer: Mutex<Option<Box<dyn std::io::Write + Send>>>,
}

impl RunState {
    /// Whether the run's child is still alive.
    pub fn is_alive(&self) -> bool {
        self.alive.load(Ordering::SeqCst)
    }

    /// Write client terminal input to the run's PTY (spec 7: input flows to the
    /// PTY the supervisor owns). A no-op once the writer has been dropped at
    /// completion.
    pub fn write_input(&self, bytes: &[u8]) {
        if let Some(writer) = self.writer.lock().unwrap().as_mut() {
            if let Err(e) = writer.write_all(bytes).and_then(|()| writer.flush()) {
                debug!(run = %self.id, "pty input write failed: {e}");
            }
        }
    }

    /// Resize the run's PTY window (spec 7.5). A no-op once the master has been
    /// dropped at completion.
    pub fn resize(&self, cols: u16, rows: u16) {
        if let Some(master) = self.master.lock().unwrap().as_ref() {
            if let Err(e) = master.resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            }) {
                debug!(run = %self.id, "pty resize failed: {e}");
            }
        }
    }
}

/// Owns all runs on this computer.
pub struct RunManager {
    ctx: Arc<RunCtx>,
}

impl RunManager {
    /// Build a run manager.
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        store: ChunkStore,
        root: PathBuf,
        journal_dir: PathBuf,
        computer: ComputerId,
        epoch: Epoch,
        outbox: UnboundedSender<SupervisorMessage>,
        journal_notify: Arc<Notify>,
        silence_threshold: Duration,
        segment_size: usize,
    ) -> Self {
        let mut excludes = default_credential_excludes();
        // Never snapshot the supervisor's own journal/state cache.
        excludes.push("*/.mari".to_string());
        excludes.push("*/.mari/*".to_string());
        Self {
            ctx: Arc::new(RunCtx {
                store,
                root,
                journal_dir,
                computer,
                epoch,
                outbox,
                journal_notify,
                silence_threshold,
                segment_size,
                excludes,
                runs: Arc::new(Mutex::new(HashMap::new())),
                journals: Mutex::new(HashMap::new()),
            }),
        }
    }

    /// The ids of all currently tracked (live) runs.
    pub fn active_run_ids(&self) -> Vec<RunId> {
        self.ctx.runs.lock().unwrap().keys().cloned().collect()
    }

    /// Every run's journal ever started this process, live or completed. The
    /// streamer iterates these so a completed run's unacked tail still flows.
    pub fn all_journals(&self) -> Vec<(RunId, Arc<Journal>)> {
        self.ctx
            .journals
            .lock()
            .unwrap()
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// The journal of a tracked run, if present.
    pub fn journal_of(&self, run: &RunId) -> Option<Arc<Journal>> {
        self.ctx
            .runs
            .lock()
            .unwrap()
            .get(run)
            .map(|s| s.journal.clone())
    }

    /// The run state, if tracked.
    pub fn run_state(&self, run: &RunId) -> Option<Arc<RunState>> {
        self.ctx.runs.lock().unwrap().get(run).cloned()
    }

    /// Start a run: pre-run snapshot, spawn on a PTY, stream the journal.
    pub async fn start_run(
        &self,
        run: RunId,
        argv: Vec<String>,
        env_names: Vec<String>,
        cwd: String,
    ) -> anyhow::Result<Arc<RunState>> {
        if argv.is_empty() {
            anyhow::bail!("start_run: empty argv for run {run}");
        }
        if self.ctx.runs.lock().unwrap().contains_key(&run) {
            anyhow::bail!("start_run: run {run} already exists");
        }

        // --- pre-run snapshot (spec 5.2): the diff baseline. ---
        let opts = SnapshotOptions {
            exclude: self.ctx.excludes.clone(),
            created_at: now_secs(),
            ..SnapshotOptions::default()
        };
        let pre = snapshot(&self.ctx.store, &self.ctx.root, &opts).await?;
        let pre_id = pre.manifest_id.clone();
        emit(
            &self.ctx.outbox,
            SupervisorMessage::SnapshotWritten {
                manifest: pre_id.clone(),
                epoch: self.ctx.epoch,
                reason: SnapshotReason::PreRun,
            },
        );
        emit(
            &self.ctx.outbox,
            SupervisorMessage::HeadAdvanceRequest {
                manifest: pre_id.clone(),
                epoch: self.ctx.epoch,
            },
        );
        emit(
            &self.ctx.outbox,
            SupervisorMessage::RunStarted {
                run: run.clone(),
                pre_run_manifest: pre_id.clone(),
            },
        );

        // --- spawn on a real PTY. ---
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize::default())
            .map_err(|e| anyhow::anyhow!("openpty: {e}"))?;

        let mut cmd = CommandBuilder::new(&argv[0]);
        cmd.args(&argv[1..]);
        cmd.cwd(&cwd);
        // Inject vault variables by name from the supervisor's environment; the
        // values never traveled in the StartRun message (spec 10.1).
        for name in &env_names {
            if let Ok(val) = std::env::var(name) {
                cmd.env(name, val);
            }
        }

        let child = pair
            .slave
            .spawn_command(cmd)
            .map_err(|e| anyhow::anyhow!("spawn_command: {e}"))?;
        let killer = child.clone_killer();
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|e| anyhow::anyhow!("try_clone_reader: {e}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|e| anyhow::anyhow!("take_writer: {e}"))?;
        // Drop the slave handle so the master reader sees EOF when the child
        // exits (the child keeps its own descriptor).
        drop(pair.slave);

        let journal = Arc::new(Journal::new(
            run.clone(),
            self.ctx.computer.clone(),
            self.ctx.store.clone(),
            &self.ctx.journal_dir,
            self.ctx.segment_size,
        )?);

        let done = Arc::new(Notify::new());
        let state = Arc::new(RunState {
            id: run.clone(),
            journal: journal.clone(),
            pre_run_manifest: pre_id.clone(),
            alive: AtomicBool::new(true),
            killer: Mutex::new(Some(killer)),
            last_output: Mutex::new(Instant::now()),
            silence_fired: AtomicBool::new(false),
            done: done.clone(),
            master: Mutex::new(Some(pair.master)),
            writer: Mutex::new(Some(writer)),
        });
        self.ctx
            .runs
            .lock()
            .unwrap()
            .insert(run.clone(), state.clone());
        self.ctx
            .journals
            .lock()
            .unwrap()
            .insert(run.clone(), journal.clone());

        // --- reader task (blocking): drain PTY output into the journal, run the
        // attention detector, wake the streamer. ---
        let reader_handle = spawn_reader(
            reader,
            run.clone(),
            journal.clone(),
            state.clone(),
            self.ctx.outbox.clone(),
            self.ctx.journal_notify.clone(),
        );

        // --- housekeeping task: silence detection + segment uploads. ---
        spawn_housekeeping(self.ctx.clone(), run.clone(), journal.clone(), state.clone());

        // --- completion task: wait for exit, finalize journal, post snapshot,
        // diff, emit RunCompleted. ---
        spawn_completion(
            self.ctx.clone(),
            run.clone(),
            journal.clone(),
            state.clone(),
            pre_id,
            child,
            reader_handle,
        );

        Ok(state)
    }

    /// Write client terminal input to a run's PTY. Unknown or already-finished
    /// runs are ignored (the input has nowhere to go).
    pub fn write_input(&self, run: &RunId, bytes: &[u8]) {
        let state = self.ctx.runs.lock().unwrap().get(run).cloned();
        if let Some(state) = state {
            state.write_input(bytes);
        }
    }

    /// Resize a run's PTY window (spec 7.5). Unknown or finished runs are ignored.
    pub fn resize_run(&self, run: &RunId, cols: u16, rows: u16) {
        let state = self.ctx.runs.lock().unwrap().get(run).cloned();
        if let Some(state) = state {
            state.resize(cols, rows);
        }
    }

    /// Stop a run's process cleanly (SIGHUP via the pty). The completion task
    /// then snapshots and emits `RunCompleted` as for any exit.
    pub fn stop_run(&self, run: &RunId) {
        let state = self.ctx.runs.lock().unwrap().get(run).cloned();
        if let Some(state) = state {
            if let Some(mut killer) = state.killer.lock().unwrap().take() {
                if let Err(e) = killer.kill() {
                    warn!(%run, "kill failed: {e}");
                }
            }
        }
    }

    /// Stop every run cleanly and wait (up to `timeout`) for them to finish and
    /// deregister. Used by the WARM->COLD path (spec 4.5).
    pub async fn stop_all(&self, timeout: Duration) {
        let ids = self.active_run_ids();
        for id in &ids {
            self.stop_run(id);
        }
        let deadline = Instant::now() + timeout;
        loop {
            if self.ctx.runs.lock().unwrap().is_empty() {
                return;
            }
            if Instant::now() >= deadline {
                warn!("stop_all timed out with runs still active");
                return;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    run: RunId,
    journal: Arc<Journal>,
    state: Arc<RunState>,
    outbox: UnboundedSender<SupervisorMessage>,
    journal_notify: Arc<Notify>,
) -> tokio::task::JoinHandle<()> {
    tokio::task::spawn_blocking(move || {
        let mut detector = crate::attention::AttentionDetector::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF: child exited and pty closed.
                Ok(n) => {
                    let chunk = &buf[..n];
                    // Reset the silence timer on any output.
                    *state.last_output.lock().unwrap() = Instant::now();
                    state.silence_fired.store(false, Ordering::SeqCst);
                    // Content-free attention detection.
                    for kind in detector.feed(chunk) {
                        emit(
                            &outbox,
                            SupervisorMessage::Attention {
                                run: run.clone(),
                                kind,
                            },
                        );
                    }
                    // Persist to the journal and wake the streamer.
                    journal.append(chunk);
                    journal_notify.notify_waiters();
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(e) => {
                    debug!(%run, "pty reader stopped: {e}");
                    break;
                }
            }
        }
    })
}

fn spawn_housekeeping(ctx: Arc<RunCtx>, run: RunId, journal: Arc<Journal>, state: Arc<RunState>) {
    let threshold = ctx.silence_threshold;
    let tick = housekeeping_tick(threshold);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = state.done.notified() => break,
                _ = tokio::time::sleep(tick) => {
                    if !state.is_alive() {
                        break;
                    }
                    // Silence detection: one event per silent episode, re-armed
                    // by output (which resets `silence_fired`).
                    if threshold > Duration::ZERO {
                        let idle = state.last_output.lock().unwrap().elapsed();
                        if idle >= threshold
                            && !state.silence_fired.swap(true, Ordering::SeqCst)
                        {
                            emit(
                                &ctx.outbox,
                                SupervisorMessage::Attention {
                                    run: run.clone(),
                                    kind: AttentionKind::BlockedRead,
                                },
                            );
                        }
                    }
                    // Stream finished segments to the store as the run proceeds.
                    if let Err(e) = journal.flush_ready_segments().await {
                        warn!(%run, "segment flush failed: {e}");
                    }
                }
            }
        }
    });
}

fn spawn_completion(
    ctx: Arc<RunCtx>,
    run: RunId,
    journal: Arc<Journal>,
    state: Arc<RunState>,
    pre_id: ManifestId,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    reader_handle: tokio::task::JoinHandle<()>,
) {
    tokio::spawn(async move {
        // Wait for the child (blocking) off the async runtime.
        let status = tokio::task::spawn_blocking(move || child.wait())
            .await
            .map_err(|e| anyhow::anyhow!("wait join: {e}"))
            .and_then(|r| r.map_err(|e| anyhow::anyhow!("child wait: {e}")));

        // Drain the reader so the journal holds every byte before we snapshot.
        let _ = reader_handle.await;

        // Stop housekeeping and mark not-alive.
        state.alive.store(false, Ordering::SeqCst);
        state.done.notify_waiters();

        // Finalize the journal: flush the last (partial) segment.
        journal.finish();
        if let Err(e) = journal.flush_ready_segments().await {
            warn!(%run, "final segment flush failed: {e}");
        }
        ctx.journal_notify.notify_waiters();

        let exit = match status {
            Ok(s) => map_exit(&s),
            Err(e) => {
                warn!(%run, "could not obtain exit status: {e}");
                ExitStatus::Signaled { signal: 0 }
            }
        };

        // Post-run snapshot and diff against the pre-run manifest (spec 5.3).
        let opts = SnapshotOptions {
            exclude: ctx.excludes.clone(),
            created_at: now_secs(),
            ..SnapshotOptions::default()
        };
        match snapshot(&ctx.store, &ctx.root, &opts).await {
            Ok(post) => {
                let summary = match ctx.store.get_manifest(&pre_id).await {
                    Ok(pre_manifest) => diff(&pre_manifest, &post.manifest).summary(),
                    Err(e) => {
                        warn!(%run, "loading pre-run manifest for diff failed: {e}");
                        Default::default()
                    }
                };
                emit(
                    &ctx.outbox,
                    SupervisorMessage::RunCompleted {
                        run: run.clone(),
                        exit,
                        post_run_manifest: post.manifest_id.clone(),
                        diff: summary,
                    },
                );
                // Default is to keep the run's changes: advance the head to the
                // post-run manifest (spec 5.3; restore is an explicit command).
                emit(
                    &ctx.outbox,
                    SupervisorMessage::HeadAdvanceRequest {
                        manifest: post.manifest_id,
                        epoch: ctx.epoch,
                    },
                );
            }
            Err(e) => {
                warn!(%run, "post-run snapshot failed: {e}");
                emit(
                    &ctx.outbox,
                    SupervisorMessage::RunCompleted {
                        run: run.clone(),
                        exit,
                        post_run_manifest: pre_id.clone(),
                        diff: Default::default(),
                    },
                );
            }
        }

        // Deregister; keeps the run alive until every byte is journaled and the
        // completion event is out.
        ctx.runs.lock().unwrap().remove(&run);
    });
}

fn housekeeping_tick(threshold: Duration) -> Duration {
    if threshold == Duration::ZERO {
        return Duration::from_millis(100);
    }
    let fifth = threshold / 5;
    fifth.clamp(Duration::from_millis(20), Duration::from_millis(250))
}

fn emit(outbox: &UnboundedSender<SupervisorMessage>, msg: SupervisorMessage) {
    // A closed outbox means the supervisor is shutting down; dropping the
    // message is correct (nothing left to receive it).
    let _ = outbox.send(msg);
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// Map a `portable-pty` exit status onto the wire [`ExitStatus`]. A signal name
/// (portable-pty reports the name, not the number) is mapped back to its number
/// where known; the diff/journal contract only depends on the exit code.
fn map_exit(status: &portable_pty::ExitStatus) -> ExitStatus {
    if let Some(sig) = status.signal() {
        ExitStatus::Signaled {
            signal: signal_number(sig),
        }
    } else {
        ExitStatus::Exited {
            code: status.exit_code() as i32,
        }
    }
}

fn signal_number(name: &str) -> i32 {
    // strsignal-style names -> numbers for the common terminating signals.
    let lower = name.to_ascii_lowercase();
    if lower.contains("hangup") {
        1
    } else if lower.contains("interrupt") {
        2
    } else if lower.contains("quit") {
        3
    } else if lower.contains("abort") {
        6
    } else if lower.contains("kill") {
        9
    } else if lower.contains("segmentation") {
        11
    } else if lower.contains("pipe") {
        13
    } else if lower.contains("terminat") {
        15
    } else {
        // Fall back to a trailing number ("Signal 20") if present.
        name.rsplit(|c: char| !c.is_ascii_digit())
            .find(|s| !s.is_empty())
            .and_then(|s| s.parse().ok())
            .unwrap_or(0)
    }
}
