//! The supervisor daemon: the top-level orchestrator (spec §5).
//!
//! It opens the chunk store, optionally restores a manifest into `MARI_ROOT`
//! (the cold-wake path, ordered by the stored heat profile), connects to the
//! control plane over framed CBOR/WebSocket with a Hello/HelloAck handshake and
//! exponential-backoff reconnect, and serves control messages: starting and
//! stopping runs, streaming their journals with monotonic offsets, taking
//! snapshots on a schedule and on command, holding the machine awake during runs
//! (heartbeat, spec 5.4), and — on `PrepareForCold` — stopping runs cleanly,
//! writing a final manifest, and exiting (spec 4.5).
//!
//! Journal streaming is a **pull** off each run's [`crate::journal::Journal`]:
//! per connection the supervisor tracks how far it has sent, and on reconnect it
//! resets that mark to the control plane's last-acked offset (from `HelloAck`)
//! and re-reads — so a resumed stream has no gap and no duplicate bytes.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use futures_util::StreamExt;
use mari_core::{
    ChunkStore, HeatRecorder, RestoreOptions, SnapshotOptions, default_credential_excludes,
    load_heat, restore, snapshot, store_heat,
};
use mari_proto::{
    ComputerId, ControlMessage, Epoch, JournalOffset, ManifestId, PROTO_VERSION, RunId,
    SnapshotReason, SupervisorMessage,
};
use tokio::sync::Notify;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, info, warn};

use crate::config::Config;
use crate::journal::FRAME_CHUNK;
use crate::run::RunManager;
use crate::store_uri::open_store;
use crate::ws::{Backoff, decode_payload, send_framed};

/// How often to send `RunHeartbeat` while a run is active (spec 5.4).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
/// How long `PrepareForCold` waits for runs to stop before writing the final
/// manifest anyway.
const COLD_STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// State shared between the connection loop and the background tasks.
struct Shared {
    config: Config,
    store: ChunkStore,
    computer: ComputerId,
    epoch: Epoch,
    run_manager: Arc<RunManager>,
    outbox_tx: UnboundedSender<SupervisorMessage>,
    journal_notify: Arc<Notify>,
    /// Durably-acked journal offset per run (updated by `JournalAck`, seeded by
    /// `HelloAck`). The resume baseline.
    acked: Mutex<HashMap<RunId, u64>>,
}

impl Shared {
    fn excludes(&self) -> Vec<String> {
        let mut e = default_credential_excludes();
        e.push("*/.mari".to_string());
        e.push("*/.mari/*".to_string());
        e
    }

    fn snapshot_opts(&self) -> SnapshotOptions {
        SnapshotOptions {
            exclude: self.excludes(),
            created_at: now_secs(),
            ..SnapshotOptions::default()
        }
    }
}

/// Why a session ended.
enum SessionOutcome {
    /// The connection dropped; reconnect after backoff.
    Disconnected,
    /// `PrepareForCold` completed; the daemon should exit.
    ColdExit,
}

/// Run the supervisor to completion (a cold exit) or until a fatal error. This
/// is the daemon entry used by `main` and driven directly by tests.
pub async fn run(config: Config) -> Result<()> {
    let store = open_store(&config.store)?;
    let computer = ComputerId::new(config.computer_id.clone());
    let epoch = Epoch::new(config.epoch);

    // Cold-wake: restore the manifest into MARI_ROOT before connecting, ordered
    // by the stored heat profile, then feed the heat recorder for the next wake.
    if let Some(manifest) = config.restore_manifest.clone() {
        restore_cold(&store, &computer, &config.root, &manifest).await?;
    }

    let (outbox_tx, mut outbox_rx) = unbounded_channel::<SupervisorMessage>();
    let journal_notify = Arc::new(Notify::new());
    let journal_dir = config.root.join(".mari").join("journal");
    let run_manager = Arc::new(RunManager::new(
        store.clone(),
        config.root.clone(),
        journal_dir,
        computer.clone(),
        epoch,
        outbox_tx.clone(),
        journal_notify.clone(),
        config.silence_threshold(),
        config.segment_bytes as usize,
    ));

    let shared = Arc::new(Shared {
        config: config.clone(),
        store,
        computer,
        epoch,
        run_manager,
        outbox_tx,
        journal_notify,
        acked: Mutex::new(HashMap::new()),
    });

    spawn_heartbeat(shared.clone());
    spawn_snapshot_scheduler(shared.clone());

    let mut backoff = Backoff::new(Duration::from_millis(50), Duration::from_secs(5));
    loop {
        match connect_and_serve(&shared, &mut outbox_rx, &mut backoff).await {
            Ok(SessionOutcome::ColdExit) => {
                info!("prepared for cold; exiting");
                return Ok(());
            }
            Ok(SessionOutcome::Disconnected) => {
                let delay = backoff.next_delay();
                debug!(?delay, "disconnected; reconnecting after backoff");
                tokio::time::sleep(delay).await;
            }
            Err(e) => {
                let delay = backoff.next_delay();
                warn!("session error: {e:#}; reconnecting after {delay:?}");
                tokio::time::sleep(delay).await;
            }
        }
    }
}

/// Connect, handshake, and serve until the connection drops or a cold exit.
async fn connect_and_serve(
    shared: &Arc<Shared>,
    outbox_rx: &mut UnboundedReceiver<SupervisorMessage>,
    backoff: &mut Backoff,
) -> Result<SessionOutcome> {
    let (ws, _resp) = connect_async(shared.config.control_url.as_str()).await?;
    backoff.reset();
    info!(url = %shared.config.control_url, "connected to control plane");
    let (mut write, mut read) = ws.split();

    // Handshake: Hello first (spec §6 / contracts §5.1).
    send_framed(
        &mut write,
        &SupervisorMessage::Hello {
            computer: shared.computer.clone(),
            epoch: shared.epoch,
            token: shared.config.token.clone(),
            proto_version: PROTO_VERSION,
        },
    )
    .await?;

    // Per-connection send offsets (reset from HelloAck on resume).
    let mut sent: HashMap<RunId, u64> = HashMap::new();
    let mut frames = mari_proto::FrameReader::new();
    let mut tick = tokio::time::interval(Duration::from_millis(25));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Binary(payload))) => {
                        let mut msgs: Vec<ControlMessage> = Vec::new();
                        decode_payload(&mut frames, payload.as_ref(), &mut msgs)?;
                        for cm in msgs {
                            if matches!(cm, ControlMessage::PrepareForCold) {
                                cold_shutdown(shared, &mut write, outbox_rx, &mut sent).await?;
                                return Ok(SessionOutcome::ColdExit);
                            }
                            handle_control(shared, cm, &mut sent).await;
                        }
                        flush_journals(shared, &mut write, &mut sent).await?;
                    }
                    Some(Ok(Message::Ping(p))) => { write_msg(&mut write, Message::Pong(p)).await?; }
                    Some(Ok(Message::Close(_))) | None => return Ok(SessionOutcome::Disconnected),
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        debug!("read error: {e}");
                        return Ok(SessionOutcome::Disconnected);
                    }
                }
            }
            ev = outbox_rx.recv() => {
                match ev {
                    Some(msg) => send_framed(&mut write, &msg).await?,
                    None => return Ok(SessionOutcome::Disconnected),
                }
            }
            _ = shared.journal_notify.notified() => {
                flush_journals(shared, &mut write, &mut sent).await?;
            }
            _ = tick.tick() => {
                flush_journals(shared, &mut write, &mut sent).await?;
            }
        }
    }
}

/// Apply one control message (except `PrepareForCold`, handled by the caller).
async fn handle_control(shared: &Arc<Shared>, msg: ControlMessage, sent: &mut HashMap<RunId, u64>) {
    match msg {
        ControlMessage::HelloAck { acked } => {
            let mut acked_map = shared.acked.lock().unwrap();
            for ro in acked {
                let off = ro.offset.get();
                // Resume: re-send from the durably-acked offset.
                sent.insert(ro.run.clone(), off);
                acked_map.insert(ro.run, off);
            }
        }
        ControlMessage::JournalAck { run, offset } => {
            shared.acked.lock().unwrap().insert(run, offset.get());
        }
        ControlMessage::StartRun {
            run,
            argv,
            env_names,
            cwd,
        } => {
            info!(%run, ?argv, "start_run");
            if let Err(e) = shared
                .run_manager
                .start_run(run.clone(), argv, env_names, cwd)
                .await
            {
                warn!(%run, "start_run failed: {e:#}");
            }
        }
        ControlMessage::StopRun { run } => {
            info!(%run, "stop_run");
            shared.run_manager.stop_run(&run);
        }
        ControlMessage::SnapshotNow { reason } => {
            spawn_snapshot(shared.clone(), reason);
        }
        ControlMessage::RestoreToManifest { manifest } => {
            let shared = shared.clone();
            tokio::spawn(async move {
                let heat = load_heat(&shared.store, &shared.computer)
                    .await
                    .ok()
                    .flatten()
                    .unwrap_or_default();
                match shared.store.get_manifest(&manifest).await {
                    Ok(m) => {
                        let opts = RestoreOptions {
                            priority: heat.paths,
                        };
                        if let Err(e) =
                            restore(&shared.store, &m, &shared.config.root, &opts).await
                        {
                            warn!(%manifest, "restore failed: {e:#}");
                        }
                    }
                    Err(e) => warn!(%manifest, "restore: manifest load failed: {e:#}"),
                }
            });
        }
        ControlMessage::HeadAdvanceResult {
            accepted,
            current_epoch,
        } => {
            if !accepted {
                // The DO fenced us out: a newer wake owns the head. We must stop
                // advancing it. v0 logs this loudly; the epoch is authoritative.
                warn!(
                    our_epoch = shared.epoch.get(),
                    do_epoch = current_epoch.get(),
                    "head advance REJECTED (fenced out by a newer epoch)"
                );
            }
        }
        // Replies the supervisor sends, not receives.
        ControlMessage::PrepareForCold => unreachable!("handled by caller"),
    }
}

/// Stream each run's journal from its per-connection sent offset to the current
/// end, in bounded frames with correct monotonic offsets.
async fn flush_journals<S>(
    shared: &Arc<Shared>,
    write: &mut S,
    sent: &mut HashMap<RunId, u64>,
) -> Result<()>
where
    S: futures_util::Sink<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    for (run, journal) in shared.run_manager.all_journals() {
        let mut off = *sent.entry(run.clone()).or_insert_with(|| {
            shared
                .acked
                .lock()
                .unwrap()
                .get(&run)
                .copied()
                .unwrap_or(0)
        });
        loop {
            let chunk = journal.read_from(off, FRAME_CHUNK);
            if chunk.is_empty() {
                break;
            }
            let len = chunk.len() as u64;
            send_framed(
                write,
                &SupervisorMessage::JournalFrame {
                    run: run.clone(),
                    offset: JournalOffset::new(off),
                    bytes: chunk,
                },
            )
            .await?;
            off += len;
        }
        sent.insert(run, off);
    }
    Ok(())
}

/// The WARM->COLD sequence (spec 4.5): stop runs cleanly, drain their final
/// journals/events to the control plane, write a final manifest, and return.
async fn cold_shutdown<S>(
    shared: &Arc<Shared>,
    write: &mut S,
    outbox_rx: &mut UnboundedReceiver<SupervisorMessage>,
    sent: &mut HashMap<RunId, u64>,
) -> Result<()>
where
    S: futures_util::Sink<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    info!("prepare_for_cold: stopping runs");
    shared.run_manager.stop_all(COLD_STOP_TIMEOUT).await;

    // Drain any pending control events (RunCompleted from the stopped runs, etc.)
    // and stream any last journal bytes so the control plane has the full record.
    while let Ok(msg) = outbox_rx.try_recv() {
        send_framed(write, &msg).await?;
    }
    flush_journals(shared, write, sent).await?;

    // Final manifest (spec 4.5).
    let opts = SnapshotOptions {
        exclude: shared.excludes(),
        created_at: now_secs(),
        ..SnapshotOptions::default()
    };
    match snapshot(&shared.store, &shared.config.root, &opts).await {
        Ok(res) => {
            send_framed(
                write,
                &SupervisorMessage::SnapshotWritten {
                    manifest: res.manifest_id.clone(),
                    epoch: shared.epoch,
                    reason: SnapshotReason::Final,
                },
            )
            .await?;
            send_framed(
                write,
                &SupervisorMessage::HeadAdvanceRequest {
                    manifest: res.manifest_id,
                    epoch: shared.epoch,
                },
            )
            .await?;
        }
        Err(e) => warn!("final snapshot failed: {e:#}"),
    }
    // Best-effort: let the peer receive the tail before we drop the socket.
    use futures_util::SinkExt;
    let _ = write.flush().await;
    Ok(())
}

async fn write_msg<S>(write: &mut S, msg: Message) -> Result<()>
where
    S: futures_util::Sink<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    use futures_util::SinkExt;
    write.send(msg).await?;
    Ok(())
}

/// Take a snapshot now and report it (used by `SnapshotNow` and the scheduler).
fn spawn_snapshot(shared: Arc<Shared>, reason: SnapshotReason) {
    tokio::spawn(async move {
        let opts = shared.snapshot_opts();
        match snapshot(&shared.store, &shared.config.root, &opts).await {
            Ok(res) => {
                let _ = shared.outbox_tx.send(SupervisorMessage::SnapshotWritten {
                    manifest: res.manifest_id.clone(),
                    epoch: shared.epoch,
                    reason,
                });
                let _ = shared.outbox_tx.send(SupervisorMessage::HeadAdvanceRequest {
                    manifest: res.manifest_id,
                    epoch: shared.epoch,
                });
            }
            Err(e) => warn!("snapshot ({reason:?}) failed: {e:#}"),
        }
    });
}

fn spawn_snapshot_scheduler(shared: Arc<Shared>) {
    let interval = shared.config.snapshot_interval();
    if interval.is_zero() {
        return;
    }
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticker.tick().await; // consume the immediate first tick
        loop {
            ticker.tick().await;
            spawn_snapshot(shared.clone(), SnapshotReason::Scheduled);
        }
    });
}

fn spawn_heartbeat(shared: Arc<Shared>) {
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(HEARTBEAT_INTERVAL);
        ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            ticker.tick().await;
            for run in shared.run_manager.active_run_ids() {
                let _ = shared
                    .outbox_tx
                    .send(SupervisorMessage::RunHeartbeat { run });
            }
        }
    });
}

/// Cold-wake restore: reconstruct `root` from `manifest`, ordered by the stored
/// heat profile, and record the read order for the next wake (spec 4.6(d)).
async fn restore_cold(
    store: &ChunkStore,
    computer: &ComputerId,
    root: &std::path::Path,
    manifest_id: &str,
) -> Result<()> {
    let mid = ManifestId::new(manifest_id.to_string());
    let manifest = store.get_manifest(&mid).await?;
    let heat = load_heat(store, computer).await?.unwrap_or_default();
    let opts = RestoreOptions {
        priority: heat.paths.clone(),
    };
    let stats = restore(store, &manifest, root, &opts).await?;
    info!(
        files = stats.files,
        dirs = stats.dirs,
        symlinks = stats.symlinks,
        "cold-wake restore complete"
    );
    // Feed the heat recorder with the actual restore read order for next wake.
    let mut rec = HeatRecorder::from_profile(&heat);
    for p in &stats.file_order {
        rec.record(p.clone());
    }
    store_heat(store, computer, &rec.profile()).await?;
    Ok(())
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
