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
//!
//! # Staying alive, and dying properly
//!
//! Two things keep this daemon usable on a substrate that evicts containers and
//! reaps idle sockets:
//!
//! - A **supervisor-level keepalive** (a WebSocket ping every
//!   [`Config::keepalive_ms`]) that exists whether or not a run does. Spec 5.4's
//!   heartbeat holds the *machine* awake during a run; it says nothing about an
//!   AWAKE computer sitting with no run, whose idle control socket was measured
//!   dying at ~270 s with a 1006 and no close frame. A drop that follows silence
//!   is logged as an idle timeout, not as a failure, and a socket that stops
//!   answering entirely is declared dead rather than hung.
//! - A **graceful shutdown on SIGTERM/SIGINT** that does exactly what
//!   `PrepareForCold` does — stop each run cleanly, flush the journal segments,
//!   write the final manifest, advance the head — because on a substrate where
//!   eviction is routine and the disk is wiped on every stop, that signal is the
//!   only warning the computer gets. With `containers_pid_namespace` on, an init
//!   process that does not handle SIGTERM receives nothing at all, so the whole
//!   eviction grace window would be spent doing nothing.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::Result;
use futures_util::StreamExt;
use mari_core::{
    ChunkStore, EntryKind, HeatRecorder, Manifest, RestoreOptions, RootDir, SnapshotOptions,
    default_credential_excludes, load_heat, restore, snapshot, store_heat,
};
use mari_proto::{
    ComputerId, ControlMessage, Epoch, JournalOffset, ManifestId, PROTO_VERSION, RunId,
    SnapshotReason, SupervisorMessage,
};
use tokio::sync::Notify;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};
use tokio::sync::watch;
use tokio_tungstenite::tungstenite::Message;
use tracing::{debug, error, info, warn};

use crate::adapters::AdapterSet;
use crate::config::Config;
use crate::continuation;
use crate::journal::FRAME_CHUNK;
use crate::run::RunManager;
use crate::state::DurableState;
use crate::store_uri::open_store;
use crate::ws::{self, Backoff, UrlPolicyError, decode_payload, send_framed};

/// How often to send `RunHeartbeat` while a run is active (spec 5.4).
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
/// Fallback for classifying a drop as an idle timeout when both the idle
/// timeout and the keepalive are disabled.
const DEFAULT_IDLE_CLASS: Duration = Duration::from_secs(60);

/// State shared between the connection loop and the background tasks.
pub(crate) struct Shared {
    pub(crate) config: Config,
    pub(crate) store: ChunkStore,
    pub(crate) computer: ComputerId,
    pub(crate) epoch: Epoch,
    pub(crate) run_manager: Arc<RunManager>,
    pub(crate) outbox_tx: UnboundedSender<SupervisorMessage>,
    pub(crate) journal_notify: Arc<Notify>,
    /// Durably-acked journal offset per run (updated by `JournalAck`, seeded by
    /// `HelloAck`). The resume baseline.
    pub(crate) acked: Mutex<HashMap<RunId, u64>>,
    /// True when THIS process restored the tree from the chunk store on the way
    /// up (a cold wake). The disk is then exactly the manifest we wrote it from,
    /// so the WARM-rollback comparison (spec 4.7) does not apply and is skipped.
    pub(crate) cold_restored: bool,
    /// Guards the one-shot startup continuation pass (spec 5.6 / 4.7): it runs
    /// on the FIRST `HelloAck`, never again on a reconnect.
    pub(crate) continuation_done: std::sync::atomic::AtomicBool,
}

/// The manifest exclusions the supervisor uses (spec 10.1): credential paths,
/// plus the supervisor's own `.mari` state directory and its subtree. A snapshot
/// omits these, and — critically — a revert ([`prune_to_manifest`]) preserves
/// exactly these on disk, so the two never drift.
pub(crate) fn mari_excludes() -> Vec<String> {
    let mut e = default_credential_excludes();
    e.push("*/.mari".to_string());
    e.push("*/.mari/*".to_string());
    e
}

impl Shared {
    pub(crate) fn excludes(&self) -> Vec<String> {
        mari_excludes()
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
#[derive(Debug)]
enum SessionOutcome {
    /// The connection ended; reconnect after backoff.
    Disconnected(DisconnectReason),
    /// The shutdown sequence ran to completion on this connection
    /// (`PrepareForCold`, or a SIGTERM/SIGINT while connected). Exit 0.
    Exit,
}

/// How a control-plane session ended. The distinction that matters
/// operationally is [`DisconnectReason::IdleTimeout`] — an edge or NAT reaping a
/// socket that had nothing to carry — versus everything else, which is a real
/// failure worth a warning.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DisconnectReason {
    /// The peer sent a Close frame.
    PeerClose,
    /// The stream ended with no close frame (a 1006-style abnormal closure).
    Eof,
    /// A transport read error.
    ReadError,
    /// No inbound frame arrived within the idle window — not even a pong to our
    /// keepalive ping. Either the peer reaped an idle socket, or the flow was
    /// dropped without an RST and reads would have hung forever.
    IdleTimeout,
    /// The outbox channel closed: the supervisor is tearing down.
    OutboxClosed,
    /// A shutdown signal arrived while the connection was still being made.
    ShuttingDown,
}

impl DisconnectReason {
    /// Classify a drop that arrived after `silence` of no inbound traffic. A
    /// close/EOF/error that lands on a socket which had been quiet for longer
    /// than the idle window is the idle reaper, not a session failure — logging
    /// it as a failure is what makes a real failure impossible to spot.
    fn after_silence(self, silence: Duration, idle_window: Duration) -> Self {
        match self {
            DisconnectReason::PeerClose | DisconnectReason::Eof | DisconnectReason::ReadError
                if silence >= idle_window =>
            {
                DisconnectReason::IdleTimeout
            }
            other => other,
        }
    }
}

/// Which signal asked the daemon to stop.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum ShutdownSignal {
    Term,
    Int,
}

impl std::fmt::Display for ShutdownSignal {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            ShutdownSignal::Term => "SIGTERM",
            ShutdownSignal::Int => "SIGINT",
        })
    }
}

type ShutdownRx = watch::Receiver<Option<ShutdownSignal>>;

/// Resolve when a shutdown signal has been published.
///
/// If the watch channel is closed this **never** resolves. That matters: `run`
/// owns the sender for the process lifetime, but if it ever did close,
/// `wait_for` would return `Err` immediately and a `select!` branch that treated
/// that as a shutdown request would tear the daemon down on its own — or, worse,
/// spin the connection loop as fast as the CPU allows.
async fn wait_for_shutdown(shutdown: &mut ShutdownRx) -> ShutdownSignal {
    loop {
        // Copy the value out and drop the watch guard within this statement: a
        // guard held across an await would make every caller's future non-Send.
        let signal = match shutdown.wait_for(|v| v.is_some()).await {
            Ok(v) => *v,
            Err(_) => None,
        };
        match signal {
            Some(sig) => return sig,
            None => std::future::pending::<()>().await,
        }
    }
}

/// Install handlers for SIGTERM and SIGINT and publish the first one that
/// arrives. Without this the process has no handler at all, and an init process
/// in its own PID namespace (`containers_pid_namespace`) is not killed by a
/// signal it does not handle — the eviction grace window would pass with the
/// supervisor doing nothing and the disk wiped at the end of it.
fn spawn_signal_watcher(tx: Arc<watch::Sender<Option<ShutdownSignal>>>) {
    tokio::spawn(async move {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(e) => {
                error!("cannot install a SIGTERM handler: {e}; graceful shutdown is UNAVAILABLE");
                return;
            }
        };
        let mut int = match signal(SignalKind::interrupt()) {
            Ok(s) => s,
            Err(e) => {
                error!("cannot install a SIGINT handler: {e}");
                return;
            }
        };
        let sig = tokio::select! {
            _ = term.recv() => ShutdownSignal::Term,
            _ = int.recv() => ShutdownSignal::Int,
        };
        info!(%sig, "shutdown signal received");
        let _ = tx.send(Some(sig));
    });
}

/// Run the supervisor to completion (a cold exit) or until a fatal error. This
/// is the daemon entry used by `main` and driven directly by tests.
pub async fn run(config: Config) -> Result<()> {
    // TLS first: `wss://` needs both the rustls feature and a process crypto
    // provider, and a missing provider is a panic deep inside the first dial.
    ws::install_crypto_provider();
    // Then the scheme policy, before the store is even opened: a control URL
    // that would put this computer's wake token on the wire in cleartext is a
    // configuration error, and failing here (exit non-zero, one clear line) is
    // better than a supervisor that runs and quietly leaks. A URL we merely
    // cannot classify yet — DNS is often not up in a fresh container — is a
    // warning, and the connect loop decides.
    match ws::classify_control_url(&config.control_url, config.allow_insecure_ws).await {
        Ok(dial) => info!(url = %config.control_url, policy = ?dial.policy, "control URL accepted"),
        Err(e) if e.is_fatal() => {
            error!("{e}");
            return Err(anyhow::Error::new(e));
        }
        Err(e) => warn!("{e}; will re-check on each connect attempt"),
    }

    let store = open_store(&config.store)?;
    let computer = ComputerId::new(config.computer_id.clone());
    let epoch = Epoch::new(config.epoch);

    // Cold-wake: restore the manifest into MARI_ROOT before connecting, ordered
    // by the stored heat profile, then feed the heat recorder for the next wake.
    let cold_restored = config.restore_manifest.is_some();
    if let Some(manifest) = config.restore_manifest.clone() {
        restore_cold(&store, &computer, &config.root, &manifest).await?;
    }

    // Agent adapters (spec 5.6). Loading never fails: a malformed file is
    // skipped, because the daemon owns runs that have nothing to do with it.
    let adapters = Arc::new(AdapterSet::load_dir(&config.agents_dir));
    if adapters.is_empty() {
        info!(dir = %config.agents_dir.display(), "no agent adapters loaded");
    } else {
        info!(adapters = ?adapters.names(), "agent adapters loaded");
    }
    for (path, reason) in adapters.rejected() {
        warn!(path = %path.display(), "agent adapter ignored: {reason}");
    }

    let (outbox_tx, mut outbox_rx) = unbounded_channel::<SupervisorMessage>();
    let journal_notify = Arc::new(Notify::new());
    let journal_dir = config.root.join(".mari").join("journal");
    let durable = Arc::new(DurableState::new(store.clone(), computer.clone(), epoch));
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
        adapters,
        durable,
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
        cold_restored,
        continuation_done: std::sync::atomic::AtomicBool::new(false),
    });

    spawn_heartbeat(shared.clone());
    spawn_snapshot_scheduler(shared.clone());

    let (shutdown_tx, mut shutdown_rx) = watch::channel(None);
    // The sender stays alive here for the whole loop (the watcher task gets a
    // clone), so the channel cannot close under the connection loop.
    let shutdown_tx = Arc::new(shutdown_tx);
    spawn_signal_watcher(shutdown_tx.clone());

    let mut backoff = Backoff::new(Duration::from_millis(50), Duration::from_secs(5));
    loop {
        // A signal that arrives while we are between connections still has to be
        // honored: the runs and the tree are here whether or not a socket is.
        // Copy out of the watch guard before awaiting: holding it across an await
        // would make this future non-Send (and pin the channel's lock).
        let pending = *shutdown_rx.borrow();
        if let Some(sig) = pending {
            offline_shutdown(&shared, sig).await;
            return Ok(());
        }
        let outcome =
            connect_and_serve(&shared, &mut outbox_rx, &mut backoff, &mut shutdown_rx).await;
        match outcome {
            Ok(SessionOutcome::Exit) => return Ok(()),
            Ok(SessionOutcome::Disconnected(reason)) => {
                let delay = backoff.next_delay();
                match reason {
                    DisconnectReason::IdleTimeout => info!(
                        ?delay,
                        idle_window = ?idle_window(&shared.config),
                        "control channel went silent (idle timeout, not a failure); reconnecting"
                    ),
                    DisconnectReason::ShuttingDown => {
                        debug!("connect aborted by a shutdown signal")
                    }
                    other => warn!(
                        reason = ?other,
                        ?delay,
                        "control channel dropped; reconnecting after backoff"
                    ),
                }
                if sleep_or_shutdown(delay, &mut shutdown_rx).await {
                    continue; // the loop top runs the offline shutdown
                }
            }
            Err(e) => {
                // A fatal scheme-policy error means the control URL can never be
                // dialed as configured. Retrying would log the same refusal
                // forever; exit non-zero so the operator (or the substrate's
                // restart log) sees it.
                if let Some(pe) = e.downcast_ref::<UrlPolicyError>()
                    && pe.is_fatal()
                {
                    error!("{pe}");
                    return Err(e);
                }
                let delay = backoff.next_delay();
                warn!("session error: {e:#}; reconnecting after {delay:?}");
                if sleep_or_shutdown(delay, &mut shutdown_rx).await {
                    continue;
                }
            }
        }
    }
}

/// Sleep for `delay`, or return early if a shutdown signal arrives. Returns true
/// when it was the signal.
async fn sleep_or_shutdown(delay: Duration, shutdown: &mut ShutdownRx) -> bool {
    tokio::select! {
        _ = tokio::time::sleep(delay) => false,
        _ = wait_for_shutdown(shutdown) => true,
    }
}

/// The window of inbound silence after which a drop is attributed to the idle
/// reaper rather than to a failure.
fn idle_window(config: &Config) -> Duration {
    config
        .idle_timeout()
        .or_else(|| config.keepalive_interval().map(|k| k * 2))
        .unwrap_or(DEFAULT_IDLE_CLASS)
}

/// Connect, handshake, and serve until the connection drops or the daemon exits.
async fn connect_and_serve(
    shared: &Arc<Shared>,
    outbox_rx: &mut UnboundedReceiver<SupervisorMessage>,
    backoff: &mut Backoff,
    shutdown: &mut ShutdownRx,
) -> Result<SessionOutcome> {
    // The scheme policy is enforced here, not at startup only: this is the call
    // that actually opens the socket, and for a name-based host it is the DNS
    // answer at *this* moment that decides whether plaintext is acceptable.
    let connect = ws::connect_control(
        shared.config.control_url.as_str(),
        shared.config.allow_insecure_ws,
        None,
    );
    let (ws, _resp) = tokio::select! {
        r = connect => r?,
        _ = wait_for_shutdown(shutdown) => {
            return Ok(SessionOutcome::Disconnected(DisconnectReason::ShuttingDown));
        }
    };
    // NB: do NOT reset the backoff here. A successful TCP/WS connect is not a
    // successful session: the DO still validates proto_version, epoch, and the
    // one-time token in the handshake and closes the socket (1008) on a
    // mismatch (contracts Appendix B). A fenced-out supervisor whose epoch is
    // stale connects fine every time but is rejected every time; resetting on
    // connect would defeat the backoff and storm the edge with reconnects. The
    // backoff is reset only once the DO acks our `Hello` (see `HelloAck` below).
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
    // The supervisor-level keepalive: independent of runs, so an AWAKE computer
    // with nothing running keeps its control channel. Its first tick is
    // immediate, which also exercises the path right after the handshake.
    let mut keepalive = shared.config.keepalive_interval().map(|d| {
        let mut i = tokio::time::interval(d);
        i.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        i
    });
    let idle_window = idle_window(&shared.config);
    let mut last_inbound = Instant::now();

    loop {
        tokio::select! {
            incoming = read.next() => {
                // Any frame at all — including a pong to our keepalive — proves
                // the peer is still there.
                if matches!(incoming, Some(Ok(_))) {
                    last_inbound = Instant::now();
                }
                match incoming {
                    Some(Ok(Message::Binary(payload))) => {
                        let mut msgs: Vec<ControlMessage> = Vec::new();
                        decode_payload(&mut frames, payload.as_ref(), &mut msgs)?;
                        for cm in msgs {
                            if matches!(cm, ControlMessage::PrepareForCold) {
                                info!("prepare_for_cold: beginning shutdown");
                                bounded_connected_shutdown(
                                    shared, &mut write, outbox_rx, &mut sent,
                                )
                                .await;
                                info!("prepared for cold; exiting");
                                return Ok(SessionOutcome::Exit);
                            }
                            // The handshake succeeded: the DO accepted our epoch/token
                            // and replied. Only now is the session truly established, so
                            // this is where the reconnect backoff resets (not on connect).
                            if matches!(cm, ControlMessage::HelloAck { .. }) {
                                backoff.reset();
                            }
                            handle_control(shared, cm, &mut sent).await;
                        }
                        flush_journals(shared, &mut write, &mut sent).await?;
                    }
                    Some(Ok(Message::Ping(p))) => { write_msg(&mut write, Message::Pong(p)).await?; }
                    Some(Ok(Message::Close(_))) => {
                        return Ok(SessionOutcome::Disconnected(
                            DisconnectReason::PeerClose
                                .after_silence(last_inbound.elapsed(), idle_window),
                        ));
                    }
                    None => {
                        return Ok(SessionOutcome::Disconnected(
                            DisconnectReason::Eof
                                .after_silence(last_inbound.elapsed(), idle_window),
                        ));
                    }
                    Some(Ok(_)) => {}
                    Some(Err(e)) => {
                        debug!("read error: {e}");
                        return Ok(SessionOutcome::Disconnected(
                            DisconnectReason::ReadError
                                .after_silence(last_inbound.elapsed(), idle_window),
                        ));
                    }
                }
            }
            ev = outbox_rx.recv() => {
                match ev {
                    Some(msg) => send_framed(&mut write, &msg).await?,
                    None => return Ok(SessionOutcome::Disconnected(DisconnectReason::OutboxClosed)),
                }
            }
            _ = shared.journal_notify.notified() => {
                flush_journals(shared, &mut write, &mut sent).await?;
            }
            _ = tick.tick() => {
                // The idle check rides the always-present tick, not the keepalive
                // ticker: a deployment that disables the keepalive (or a peer that
                // is a black hole from the very first frame, so no pong can ever
                // arrive) must still not leave this loop reading a dead socket
                // forever.
                if let Some(limit) = shared.config.idle_timeout()
                    && last_inbound.elapsed() >= limit
                {
                    warn!(
                        silence = ?last_inbound.elapsed(),
                        ?limit,
                        "control channel answered nothing within the idle window \
                         (not even a pong); treating it as dead"
                    );
                    return Ok(SessionOutcome::Disconnected(DisconnectReason::IdleTimeout));
                }
                flush_journals(shared, &mut write, &mut sent).await?;
            }
            // Graceful shutdown with the socket still up: the control plane gets
            // the final journal bytes, the completion events, and the final
            // manifest before this process goes away.
            sig = wait_for_shutdown(shutdown) => {
                info!(%sig, "graceful shutdown: control connection is up");
                bounded_connected_shutdown(shared, &mut write, outbox_rx, &mut sent).await;
                info!(%sig, "graceful shutdown complete; exiting");
                return Ok(SessionOutcome::Exit);
            }
            _ = async {
                match keepalive.as_mut() {
                    Some(i) => { i.tick().await; }
                    // No keepalive configured: this branch never completes.
                    None => std::future::pending::<()>().await,
                }
            } => {
                write_msg(&mut write, ws::keepalive_ping()).await?;
            }
        }
    }
}

/// Apply one control message (except `PrepareForCold`, handled by the caller).
async fn handle_control(shared: &Arc<Shared>, msg: ControlMessage, sent: &mut HashMap<RunId, u64>) {
    match msg {
        ControlMessage::HelloAck { acked } => {
            {
                let mut acked_map = shared.acked.lock().unwrap();
                for ro in acked {
                    let off = ro.offset.get();
                    // Resume: re-send from the durably-acked offset.
                    sent.insert(ro.run.clone(), off);
                    acked_map.insert(ro.run, off);
                }
            }
            // The control plane has told us the journal head it holds for every
            // run it knows. That is both halves of the startup duty: the
            // reference for continuing unfinished runs (spec 5.6) and the
            // journal head a WARM rollback is measured against (spec 4.7). Run
            // it once, off the connection loop so a slow store cannot stall the
            // socket; a reconnect must not re-run it.
            if !shared
                .continuation_done
                .swap(true, std::sync::atomic::Ordering::SeqCst)
            {
                let shared = shared.clone();
                tokio::spawn(async move {
                    continuation::run_startup_continuation(&shared).await;
                });
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
        ControlMessage::Input { run, bytes } => {
            shared.run_manager.write_input(&run, &bytes);
        }
        ControlMessage::Resize { run, cols, rows } => {
            shared.run_manager.resize_run(&run, cols, rows);
        }
        ControlMessage::SnapshotNow { reason } => {
            spawn_snapshot(shared.clone(), reason);
        }
        ControlMessage::RestoreToManifest { manifest } => {
            let shared = shared.clone();
            tokio::spawn(async move {
                if let Err(e) = revert_to_manifest(&shared, &manifest).await {
                    warn!(%manifest, "restore_to_manifest failed: {e:#}");
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
        let mut off = *sent
            .entry(run.clone())
            .or_insert_with(|| shared.acked.lock().unwrap().get(&run).copied().unwrap_or(0));
        // A resumed run's journal starts above 0 (spec 5.6): its earlier life
        // owns everything below `base_offset`, and this instance cannot serve
        // those bytes. Never try to stream below the base — an ack lower than
        // the base (the control plane holding less than the store recorded) must
        // not park the stream at an offset that can only ever read empty.
        off = off.max(journal.base_offset());
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

/// [`cold_shutdown`] under the configured grace budget, with every outcome
/// logged. The budget exists because the shutdown window is not ours: a
/// substrate hands out a bounded eviction grace (SIGTERM plus ~15 minutes on
/// Cloudflare Containers), and a run that refuses to die must not consume it.
/// Whatever is durable at the deadline is what survives, which is why the run
/// stop gets only a fraction of the budget and the manifest write gets the rest.
async fn bounded_connected_shutdown<S>(
    shared: &Arc<Shared>,
    write: &mut S,
    outbox_rx: &mut UnboundedReceiver<SupervisorMessage>,
    sent: &mut HashMap<RunId, u64>,
) where
    S: futures_util::Sink<Message> + Unpin,
    <S as futures_util::Sink<Message>>::Error: std::error::Error + Send + Sync + 'static,
{
    let grace = shared.config.shutdown_grace();
    match tokio::time::timeout(grace, cold_shutdown(shared, write, outbox_rx, sent)).await {
        Ok(Ok(())) => {}
        Ok(Err(e)) => warn!("shutdown: reporting to the control plane failed: {e:#}"),
        Err(_) => warn!(
            ?grace,
            "shutdown: grace budget exhausted; exiting with whatever reached the store"
        ),
    }
}

/// The WARM->COLD sequence (spec 4.5): stop runs cleanly, drain their final
/// journals/events to the control plane, flush journal segments to the store,
/// write a final manifest, advance the head, and return.
///
/// This is the one shutdown path. `PrepareForCold` and a SIGTERM differ only in
/// who asked: the durability duty is identical, and a second implementation of
/// it would be a second thing to get wrong.
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
    stop_runs(shared).await;

    // Drain any pending control events (RunCompleted from the stopped runs, etc.)
    // and stream any last journal bytes so the control plane has the full record.
    while let Ok(msg) = outbox_rx.try_recv() {
        send_framed(write, &msg).await?;
    }
    flush_journals(shared, write, sent).await?;
    flush_journal_segments(shared).await;

    // Final manifest (spec 4.5).
    match write_final_manifest(shared).await {
        Some(manifest) => {
            send_framed(
                write,
                &SupervisorMessage::SnapshotWritten {
                    manifest: manifest.clone(),
                    epoch: shared.epoch,
                    reason: SnapshotReason::Final,
                },
            )
            .await?;
            send_framed(
                write,
                &SupervisorMessage::HeadAdvanceRequest {
                    manifest,
                    epoch: shared.epoch,
                },
            )
            .await?;
        }
        None => warn!("shutdown: no final manifest to report"),
    }
    // Best-effort: let the peer receive the tail before we drop the socket.
    use futures_util::SinkExt;
    let _ = write.flush().await;
    Ok(())
}

/// The same durability duty with no control connection to report it on: a signal
/// that arrives while the supervisor is disconnected (or mid-reconnect) still has
/// to leave the computer recoverable. The manifest and the journal segments go to
/// the chunk store, and the manifest is appended to the store's head history
/// (`state/{computer}/heads.cbor`) under our epoch.
///
/// What this path cannot do is make the control plane *adopt* that manifest:
/// there is no socket to send `HeadAdvanceRequest` on, and the next wake restores
/// from the head the Durable Object holds, which will be the last one it was
/// told. So the work between the last reported snapshot and the signal is **in
/// the chunk store and named in the head history, but not the DO's head** — a
/// recoverable artifact rather than an automatic recovery. Adopting it would mean
/// advancing the head to a manifest the restored disk does not match, which is a
/// worse failure than the one it fixes; closing the gap properly is a
/// contracts-level decision (who wins when the two disagree), not a supervisor
/// one. The connected path is the normal case, and it reports everything.
async fn offline_shutdown(shared: &Arc<Shared>, sig: ShutdownSignal) {
    let grace = shared.config.shutdown_grace();
    info!(%sig, ?grace, "graceful shutdown: no control connection");
    let work = async {
        stop_runs(shared).await;
        flush_journal_segments(shared).await;
        write_final_manifest(shared).await;
    };
    if tokio::time::timeout(grace, work).await.is_err() {
        warn!(
            ?grace,
            "shutdown: grace budget exhausted; exiting with whatever reached the store"
        );
    }
    info!(%sig, "graceful shutdown complete; exiting");
}

/// Stop every run cleanly within the shutdown's stop budget (spec 4.5: "the
/// supervisor stops each agent session in a clean state").
async fn stop_runs(shared: &Arc<Shared>) {
    let budget = shared.config.shutdown_stop_budget();
    let active = shared.run_manager.active_run_ids();
    info!(runs = active.len(), ?budget, "shutdown: stopping runs");
    shared.run_manager.stop_all(budget).await;
    let left = shared.run_manager.active_run_ids();
    if left.is_empty() {
        info!("shutdown: all runs stopped");
    } else {
        warn!(runs = ?left, "shutdown: runs still active at the stop deadline");
    }
}

/// Push every journal's remaining bytes into local + store segments. A run that
/// exited did this in its completion task; one that had to be abandoned did not,
/// and on a substrate that wipes the disk the store copy is the only copy.
async fn flush_journal_segments(shared: &Arc<Shared>) {
    let journals = shared.run_manager.all_journals();
    for (run, journal) in &journals {
        // Allow the trailing partial segment to be written even though the run
        // never reached its natural end.
        journal.finish();
        if let Err(e) = journal.flush_ready_segments().await {
            warn!(%run, "shutdown: journal segment flush failed: {e:#}");
        }
    }
    let bytes: u64 = journals.iter().map(|(_, j)| j.uploaded_len()).sum();
    info!(
        journals = journals.len(),
        uploaded_bytes = bytes,
        "shutdown: journal segments flushed"
    );
}

/// Write the final manifest and record it as the head under our epoch.
async fn write_final_manifest(shared: &Arc<Shared>) -> Option<ManifestId> {
    let opts = SnapshotOptions {
        exclude: shared.excludes(),
        created_at: now_secs(),
        ..SnapshotOptions::default()
    };
    match snapshot(&shared.store, &shared.config.root, &opts).await {
        Ok(res) => {
            if let Err(e) = shared
                .run_manager
                .state()
                .record_head(&res.manifest_id, shared.epoch)
                .await
            {
                warn!("shutdown: recording final head failed: {e:#}");
            }
            info!(manifest = %res.manifest_id, "shutdown: final manifest written");
            Some(res.manifest_id)
        }
        Err(e) => {
            error!("shutdown: FINAL SNAPSHOT FAILED: {e:#}");
            None
        }
    }
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
                if let Err(e) = shared
                    .run_manager
                    .state()
                    .record_head(&res.manifest_id, shared.epoch)
                    .await
                {
                    warn!("recording head failed: {e:#}");
                }
                let _ = shared.outbox_tx.send(SupervisorMessage::SnapshotWritten {
                    manifest: res.manifest_id.clone(),
                    epoch: shared.epoch,
                    reason,
                });
                let _ = shared
                    .outbox_tx
                    .send(SupervisorMessage::HeadAdvanceRequest {
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

/// Authoritative revert (spec 5.3): make the live root byte-identical to
/// `manifest_id`, discarding a run's changes.
///
/// [`restore`] only *writes* the entries a manifest names; it never removes an
/// on-disk entry the manifest omits. Restoring straight into the live root would
/// therefore leave every file a run *added* in place, so the "reverted" tree
/// would be a hybrid, not the pre-run tree. This first prunes those extraneous
/// entries — preserving the supervisor's own `.mari` state and the excluded
/// credential paths (spec 10.1), which are legitimately on disk but absent from
/// the manifest — and only then restores the manifest over the top.
///
/// # Why an unaccounted-for entry fails the whole revert
///
/// "Authoritative" is a claim about the *whole* tree, and the prune is the only
/// pass that can make it: [`restore`] writes what the manifest names and looks at
/// nothing else. So an entry the prune could not enumerate is not a lost log
/// line — it is a piece of the run still on disk, in a tree this function is
/// about to report as the pre-run tree. The restore still runs first (a tree
/// closer to the manifest beats a half-pruned one), and then the error goes back
/// to the caller, which is the only place that can tell the user the revert did
/// not fully take.
async fn revert_to_manifest(shared: &Arc<Shared>, manifest_id: &ManifestId) -> Result<()> {
    let manifest = shared.store.get_manifest(manifest_id).await?;
    let heat = load_heat(&shared.store, &shared.computer)
        .await
        .ok()
        .flatten()
        .unwrap_or_default();
    // Prune first, so the following restore lands on a tree that contains nothing
    // the manifest does not (except the preserved excludes).
    let pruned = prune_to_manifest(&shared.config.root, &manifest, &shared.excludes());
    let opts = RestoreOptions {
        priority: heat.paths,
    };
    restore(&shared.store, &manifest, &shared.config.root, &opts).await?;
    if pruned.walk_errors > 0 {
        anyhow::bail!(
            "revert to {manifest_id} is not authoritative: the prune could not account for \
             {} entr{} under {} (see the warnings above); the restored tree may still hold \
             files the run added",
            pruned.walk_errors,
            if pruned.walk_errors == 1 { "y" } else { "ies" },
            shared.config.root.display()
        );
    }
    Ok(())
}

/// What one [`prune_to_manifest`] pass did. Returned rather than only logged:
/// `walk_errors` is what separates "the prune left exactly what it decided to
/// leave" from "the prune does not know what it left", and only the caller can
/// act on that difference.
#[derive(Debug, Default)]
pub(crate) struct PruneOutcome {
    /// Extraneous or wrong-kind nodes actually removed.
    removed: usize,
    /// Removals that failed with something other than "directory not empty".
    refused: usize,
    /// Entries the anchored walk could not account for: a directory it could not
    /// open or read, or a name with no manifest form. Each one is an unknown
    /// amount of the run's tree left standing.
    walk_errors: usize,
}

/// Remove every on-disk entry under `root` that `manifest` does not contain and
/// that is not matched by an `exclude` glob (the supervisor's `.mari` tree and
/// credential paths, which are deliberately absent from manifests). An entry the
/// manifest *does* contain but whose on-disk kind conflicts with it (a stale
/// symlink where the manifest has a file, a directory where it has a file, …) is
/// also removed, so the following [`restore`] recreates it correctly and never
/// writes *through* a stale symlink. A removal error is logged and the pass
/// continues — but it is also counted, and the counts go back to the caller.
///
/// # Enumerating has to be as anchored as removing
///
/// Every removal goes through [`RootDir`], and so does every step of the walk.
/// Both matter, for different reasons.
///
/// *Removal:* this prune runs against a **live** root whose processes are not
/// necessarily gone. A run that swaps a directory for a symlink to `/etc`
/// between the walk and the removal would, with a re-resolved path, turn the
/// prune into `unlink("/etc/…")`: the restore-side write primitive, pointed the
/// other way. [`RootDir::remove_path`] walks each component `O_NOFOLLOW` from a
/// descriptor it already holds, so such a swap makes the removal *fail* (a
/// logged [`mari_core::Error::UnsafePath`]) instead of landing outside.
///
/// *Enumeration:* this used to be `walkdir`, which composes a full path for
/// every entry. A run can build a subtree deeper than `PATH_MAX` with nothing
/// but relative `mkdir`s, and `walkdir` hands back one error instead of the
/// entries below that depth. The prune then removed nothing there, every
/// ancestor above it failed with the "directory not empty" this function treats
/// as *expected*, and the whole subtree survived the revert without a word.
/// [`RootDir::walk`] reads each directory through the descriptor its parent
/// handed over — the kernel never resolves more than one component — so depth
/// costs a descriptor and nothing else, and what it still cannot account for
/// arrives as an `Err` this function counts instead of discarding.
fn prune_to_manifest(root: &Path, manifest: &Manifest, excludes: &[String]) -> PruneOutcome {
    let mut out = PruneOutcome::default();
    let patterns: Vec<glob::Pattern> = excludes
        .iter()
        .filter_map(|g| glob::Pattern::new(g).ok())
        .collect();
    let in_manifest: HashMap<&str, EntryKind> = manifest
        .entries
        .iter()
        .map(|e| (e.path.as_str(), e.kind))
        .collect();

    // The anchor every removal below is resolved against. It caches the
    // descriptors of the prefix it last walked, and the walk's contents-first
    // order groups siblings, so this costs about one `openat` per directory.
    let mut rootfs = match RootDir::open(root) {
        Ok(r) => r,
        Err(e) => {
            warn!(path = %root.display(), "revert prune: cannot open root: {e}");
            // Not one entry was examined: the tree is entirely unaccounted for.
            out.walk_errors += 1;
            return out;
        }
    };
    // The walk owns its own descriptors, so `rootfs` stays free to remove while
    // it iterates. Children come before their parent, so a directory is only
    // reached once its extraneous children have already been removed.
    let walk = match rootfs.walk() {
        Ok(w) => w,
        Err(e) => {
            warn!(path = %root.display(), "revert prune: cannot enumerate root: {e}");
            out.walk_errors += 1;
            return out;
        }
    };

    for item in walk {
        let entry = match item {
            Ok(e) => e,
            // Not noise: something is down there that this pass cannot see, so
            // it cannot claim to have pruned the tree. Loud, and counted.
            Err(e) => {
                warn!("revert prune: cannot account for an entry: {e}");
                out.walk_errors += 1;
                continue;
            }
        };
        // Preserve excluded paths (`.mari`, credentials): they are on disk on
        // purpose and never appear in a manifest.
        if patterns.iter().any(|p| p.matches(&entry.path)) {
            continue;
        }
        // Keep it only if the manifest has this exact path with the same kind;
        // the restore that follows overwrites its content and mode.
        if in_manifest.get(entry.path.as_str()) == Some(&entry.kind) {
            continue;
        }
        // Extraneous, or a kind conflict: remove it. Root-anchored — a symlink
        // is unlinked, never followed, and a directory only when it is empty.
        match rootfs.remove_path(&entry.path) {
            Ok(true) => out.removed += 1,
            Ok(false) => {}
            // A directory that still has a *preserved* (excluded) child inside it
            // cannot be removed, and should not be — that is expected.
            Err(mari_core::Error::Io { ref source, .. })
                if entry.kind == EntryKind::Dir
                    && source.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
            Err(e) => {
                out.refused += 1;
                warn!(path = %entry.path, "revert prune: remove failed: {e}");
            }
        }
    }
    debug!(?out, path = %root.display(), "revert prune complete");
    out
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

#[cfg(test)]
mod supervisor_tests {
    //! Unit tests for the behaviors that only exist in this module: the
    //! authoritative revert (`revert_to_manifest` must not leave a run's added
    //! files behind, yet must preserve `.mari`/credential state), the reconnect
    //! backoff (reset on a successful `HelloAck`, never on a bare TCP connect —
    //! so a fenced-out supervisor cannot storm the edge), and how a session's end
    //! is classified (an idle socket is not a failure, and a failure is not an
    //! idle socket).

    use super::*;
    use futures_util::SinkExt;
    use mari_core::{SnapshotOptions, snapshot};
    use std::path::Path;
    use tokio::net::TcpListener;
    use tokio_tungstenite::accept_async;

    /// Build a minimal `Shared` around a live `root` and a `store`, pointed at
    /// `control_url`. Returns the outbox receiver too (needed by the WS tests).
    fn test_shared(
        root: &Path,
        store: ChunkStore,
        control_url: &str,
    ) -> (Arc<Shared>, UnboundedReceiver<SupervisorMessage>) {
        test_shared_with(root, store, control_url, |_| {})
    }

    /// [`test_shared`] with a chance to adjust the config (timings, mostly).
    fn test_shared_with(
        root: &Path,
        store: ChunkStore,
        control_url: &str,
        tweak: impl FnOnce(&mut Config),
    ) -> (Arc<Shared>, UnboundedReceiver<SupervisorMessage>) {
        let (tx, rx) = unbounded_channel();
        let notify = Arc::new(Notify::new());
        let computer = ComputerId::new("comp-test");
        let epoch = Epoch::new(1);
        let journal_dir = root.join(".mari").join("journal");
        let run_manager = Arc::new(RunManager::new(
            store.clone(),
            root.to_path_buf(),
            journal_dir,
            computer.clone(),
            epoch,
            tx.clone(),
            notify.clone(),
            Duration::from_secs(30),
            4096,
            Arc::new(crate::adapters::AdapterSet::default()),
            Arc::new(DurableState::new(store.clone(), computer.clone(), epoch)),
        ));
        let mut config = Config {
            computer_id: "comp-test".into(),
            control_url: control_url.into(),
            allow_insecure_ws: false,
            token: "tok".into(),
            epoch: 1,
            root: root.to_path_buf(),
            store: "fs:///unused".into(),
            snapshot_interval_secs: 3600,
            attention_silence_ms: 600_000,
            restore_manifest: None,
            agents_dir: root.join("agents.d"),
            segment_bytes: 4 * 1024 * 1024,
            // Off by default so a test that is not about the keepalive sees no
            // pings; the timing tests turn them on explicitly.
            keepalive_ms: 0,
            idle_timeout_ms: 0,
            shutdown_grace_ms: 5_000,
        };
        tweak(&mut config);
        let shared = Arc::new(Shared {
            config,
            store,
            computer,
            epoch,
            run_manager,
            outbox_tx: tx,
            journal_notify: notify,
            acked: Mutex::new(HashMap::new()),
            cold_restored: false,
            continuation_done: std::sync::atomic::AtomicBool::new(false),
        });
        (shared, rx)
    }

    // -----------------------------------------------------------------------
    // Finding RESTORE-REVERT-002: reverting to the pre-run manifest must remove
    // the files a run added — and must NOT wipe the supervisor's `.mari` state
    // or the excluded credential paths (both legitimately absent from manifests).
    // -----------------------------------------------------------------------
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_removes_run_added_files_and_preserves_mari_and_credentials() {
        let root_dir = tempfile::tempdir().unwrap();
        let store_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        let store = ChunkStore::open_fs(store_dir.path()).unwrap();

        // Pre-run state, plus supervisor state (`.mari`) and a credential
        // (`.ssh`) that a snapshot deliberately excludes.
        std::fs::write(root.join("keep.txt"), b"keep").unwrap();
        std::fs::write(root.join("mod.txt"), b"before").unwrap();
        std::fs::write(root.join("del.txt"), b"delete-me").unwrap();
        std::fs::create_dir_all(root.join(".mari/journal")).unwrap();
        std::fs::write(root.join(".mari/journal/0.seg"), b"journal-bytes").unwrap();
        std::fs::create_dir_all(root.join(".ssh")).unwrap();
        std::fs::write(root.join(".ssh/id_rsa"), b"PRIVATE-KEY").unwrap();

        // The pre-run manifest (the revert target): excludes `.mari`/credentials.
        let opts = SnapshotOptions {
            exclude: mari_excludes(),
            created_at: 1,
            ..SnapshotOptions::default()
        };
        let pre = snapshot(&store, root, &opts).await.unwrap();

        // A run mutates the live tree: adds a file and a whole directory, edits
        // one file, deletes another. `.mari`/`.ssh` are left in place.
        std::fs::write(root.join("new.txt"), b"created by the run").unwrap();
        std::fs::create_dir_all(root.join("junkdir")).unwrap();
        std::fs::write(root.join("junkdir/inner.txt"), b"junk").unwrap();
        std::fs::write(root.join("mod.txt"), b"AFTER").unwrap();
        std::fs::remove_file(root.join("del.txt")).unwrap();

        // Revert into the LIVE root (the production path, spec 5.3).
        let (shared, _rx) = test_shared(root, store, "ws://unused");
        revert_to_manifest(&shared, &pre.manifest_id).await.unwrap();

        // The run's additions are gone: the reverted tree is the pre-run tree.
        assert!(
            !root.join("new.txt").exists(),
            "a run-added file must not survive the revert"
        );
        assert!(
            !root.join("junkdir").exists(),
            "a run-added directory must not survive the revert"
        );
        // Edits and deletions are undone.
        assert_eq!(std::fs::read(root.join("mod.txt")).unwrap(), b"before");
        assert_eq!(std::fs::read(root.join("del.txt")).unwrap(), b"delete-me");
        assert_eq!(std::fs::read(root.join("keep.txt")).unwrap(), b"keep");
        // Critically, the supervisor's own state and the credentials survive —
        // the revert must never wipe an excluded path.
        assert_eq!(
            std::fs::read(root.join(".mari/journal/0.seg")).unwrap(),
            b"journal-bytes",
            "revert must preserve the supervisor's .mari state"
        );
        assert_eq!(
            std::fs::read(root.join(".ssh/id_rsa")).unwrap(),
            b"PRIVATE-KEY",
            "revert must preserve excluded credential paths (spec 10.1)"
        );
    }

    /// A revert into a path where a run replaced a file with a symlink must
    /// remove the stale symlink and rewrite the real file — never write through
    /// the symlink to whatever it points at.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_replaces_a_stale_symlink_with_the_manifest_file() {
        let root_dir = tempfile::tempdir().unwrap();
        let store_dir = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        let store = ChunkStore::open_fs(store_dir.path()).unwrap();

        std::fs::write(root.join("f.txt"), b"real-contents").unwrap();
        let opts = SnapshotOptions {
            exclude: mari_excludes(),
            created_at: 1,
            ..SnapshotOptions::default()
        };
        let pre = snapshot(&store, root, &opts).await.unwrap();

        // A run replaces the file with a symlink pointing outside the root.
        let sentinel = outside_dir.path().join("sentinel");
        std::fs::write(&sentinel, b"DO-NOT-TOUCH").unwrap();
        std::fs::remove_file(root.join("f.txt")).unwrap();
        std::os::unix::fs::symlink(&sentinel, root.join("f.txt")).unwrap();

        let (shared, _rx) = test_shared(root, store, "ws://unused");
        revert_to_manifest(&shared, &pre.manifest_id).await.unwrap();

        // f.txt is a real file again with the manifest bytes, and the symlink's
        // target outside the root was never written through.
        let meta = std::fs::symlink_metadata(root.join("f.txt")).unwrap();
        assert!(meta.file_type().is_file(), "f.txt must be a regular file");
        assert_eq!(std::fs::read(root.join("f.txt")).unwrap(), b"real-contents");
        assert_eq!(
            std::fs::read(&sentinel).unwrap(),
            b"DO-NOT-TOUCH",
            "revert must not write through a stale symlink"
        );
    }

    /// The prune half of the revert must not escape either. A run that leaves a
    /// directory symlink pointing outside the root — both at a path the manifest
    /// does not know, and at a path the manifest declares a *directory* — must
    /// have the link itself unlinked. Nothing at the link's target may be read,
    /// removed, or written, in the prune or in the restore that follows.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn revert_prune_unlinks_an_escaping_symlink_and_never_deletes_its_target() {
        let root_dir = tempfile::tempdir().unwrap();
        let store_dir = tempfile::tempdir().unwrap();
        let outside_dir = tempfile::tempdir().unwrap();
        let root = root_dir.path();
        let outside = outside_dir.path();
        let store = ChunkStore::open_fs(store_dir.path()).unwrap();

        // Files outside the root that the revert must leave completely alone.
        std::fs::write(outside.join("keep.txt"), b"OUTSIDE-KEEP").unwrap();
        std::fs::create_dir_all(outside.join("nested")).unwrap();
        std::fs::write(outside.join("nested/deep.txt"), b"OUTSIDE-DEEP").unwrap();

        // Pre-run tree: a file and a real directory with a child.
        std::fs::write(root.join("f.txt"), b"real-contents").unwrap();
        std::fs::create_dir_all(root.join("d")).unwrap();
        std::fs::write(root.join("d/inner.txt"), b"inner").unwrap();
        let opts = SnapshotOptions {
            exclude: mari_excludes(),
            created_at: 1,
            ..SnapshotOptions::default()
        };
        let pre = snapshot(&store, root, &opts).await.unwrap();

        // The run leaves two escaping symlinks behind:
        //  - `/escape`, a path the manifest has never heard of;
        //  - `/d`, a path the manifest declares a directory.
        std::fs::remove_file(root.join("d/inner.txt")).unwrap();
        std::fs::remove_dir(root.join("d")).unwrap();
        std::os::unix::fs::symlink(outside, root.join("escape")).unwrap();
        std::os::unix::fs::symlink(outside, root.join("d")).unwrap();

        let (shared, _rx) = test_shared(root, store, "ws://unused");
        revert_to_manifest(&shared, &pre.manifest_id).await.unwrap();

        // Both links are gone — unlinked, not followed.
        assert!(
            std::fs::symlink_metadata(root.join("escape")).is_err(),
            "the extraneous symlink must be pruned"
        );
        // And `/d` is the manifest's real directory again, with its child.
        let d_meta = std::fs::symlink_metadata(root.join("d")).unwrap();
        assert!(
            d_meta.file_type().is_dir(),
            "/d must be a real directory again, not a symlink"
        );
        assert_eq!(std::fs::read(root.join("d/inner.txt")).unwrap(), b"inner");
        assert_eq!(std::fs::read(root.join("f.txt")).unwrap(), b"real-contents");

        // Nothing outside the root was touched: same entries, same bytes.
        let mut names: Vec<String> = std::fs::read_dir(outside)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        assert_eq!(
            names,
            vec!["keep.txt".to_string(), "nested".to_string()],
            "the revert added to or removed from a directory outside the root"
        );
        assert_eq!(
            std::fs::read(outside.join("keep.txt")).unwrap(),
            b"OUTSIDE-KEEP"
        );
        assert_eq!(
            std::fs::read(outside.join("nested/deep.txt")).unwrap(),
            b"OUTSIDE-DEEP"
        );
    }

    // -----------------------------------------------------------------------
    // Finding MARID-BACKOFF-RESET-5: the reconnect backoff resets on a
    // successful session (HelloAck), not on a bare TCP connect.
    // -----------------------------------------------------------------------

    /// Bind a listener, hand the first connection to `f`, and return its URL.
    /// Bound before returning, so the client's connect never races the accept.
    async fn spawn_ws<F, Fut>(f: F) -> String
    where
        F: FnOnce(tokio_tungstenite::WebSocketStream<tokio::net::TcpStream>) -> Fut
            + Send
            + 'static,
        Fut: std::future::Future<Output = ()> + Send,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            if let Ok((stream, _)) = listener.accept().await
                && let Ok(ws) = accept_async(stream).await
            {
                f(ws).await;
            }
        });
        format!("ws://{addr}")
    }

    /// A `ShutdownRx` that never fires, for the tests that are not about signals.
    /// The sender is dropped immediately on purpose: a closed channel must never
    /// be mistaken for "shutdown requested" (see [`wait_for_shutdown`]).
    fn no_shutdown() -> ShutdownRx {
        watch::channel(None).1
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn backoff_preserved_when_handshake_is_rejected() {
        // Server reads the Hello, then closes WITHOUT a HelloAck — the DO
        // rejecting a fenced-out / mismatched supervisor (contracts Appendix B).
        let url = spawn_ws(|mut ws| async move {
            let _ = ws.next().await; // the Hello frame
            let _ = ws.send(Message::Close(None)).await;
        })
        .await;

        let root_dir = tempfile::tempdir().unwrap();
        let store_dir = tempfile::tempdir().unwrap();
        let store = ChunkStore::open_fs(store_dir.path()).unwrap();
        let (shared, mut rx) = test_shared(root_dir.path(), store, &url);

        // Simulate a couple of prior failed attempts, so the backoff has climbed
        // above its initial delay: 50ms -> current 100ms -> current 200ms.
        let mut backoff = Backoff::new(Duration::from_millis(50), Duration::from_secs(5));
        let _ = backoff.next_delay();
        let _ = backoff.next_delay();

        let outcome = connect_and_serve(&shared, &mut rx, &mut backoff, &mut no_shutdown()).await;
        assert!(
            matches!(outcome, Ok(SessionOutcome::Disconnected(_)) | Err(_)),
            "a rejected handshake must end the session"
        );

        // No HelloAck arrived, so the backoff must be untouched. If it reset on
        // the bare TCP connect (the bug), this would be the 50ms initial delay
        // and the supervisor would storm reconnects.
        assert_eq!(
            backoff.next_delay(),
            Duration::from_millis(200),
            "backoff must NOT reset on a handshake that was rejected"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn backoff_resets_after_hello_ack() {
        // Server completes the handshake (HelloAck), then closes.
        let url = spawn_ws(|mut ws| async move {
            let _ = ws.next().await; // the Hello frame
            let _ = send_framed(&mut ws, &ControlMessage::HelloAck { acked: vec![] }).await;
            let _ = ws.send(Message::Close(None)).await;
        })
        .await;

        let root_dir = tempfile::tempdir().unwrap();
        let store_dir = tempfile::tempdir().unwrap();
        let store = ChunkStore::open_fs(store_dir.path()).unwrap();
        let (shared, mut rx) = test_shared(root_dir.path(), store, &url);

        let mut backoff = Backoff::new(Duration::from_millis(50), Duration::from_secs(5));
        let _ = backoff.next_delay();
        let _ = backoff.next_delay(); // current now 200ms

        let _ = connect_and_serve(&shared, &mut rx, &mut backoff, &mut no_shutdown()).await;

        // The session was established, so the backoff resets to its initial delay.
        assert_eq!(
            backoff.next_delay(),
            Duration::from_millis(50),
            "a successful hello_ack must reset the backoff"
        );
    }

    // -----------------------------------------------------------------------
    // Idle control channel: a socket the peer stops answering is declared dead
    // and reported as an IDLE TIMEOUT, while a socket that fails is reported as
    // a failure. The distinction is the whole point — an edge reaping an idle
    // WebSocket (measured: ~270 s, 1006, no close frame) is routine, and logging
    // it as a failure is what makes a real failure invisible.
    // -----------------------------------------------------------------------

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_peer_that_answers_nothing_is_declared_dead_as_an_idle_timeout() {
        // NB: the keepalive is on here, but the detection does not depend on it —
        // see `a_black_hole_peer_is_declared_dead_even_with_no_keepalive`.
        // The server completes the handshake and then stops reading entirely: no
        // pong to our keepalive, no close frame, socket held open. This is the
        // silent-death case — without detection, reads hang forever and the
        // supervisor is offline with nothing to show for it.
        let url = spawn_ws(|mut ws| async move {
            let _ = ws.next().await; // the Hello frame
            let _ = send_framed(&mut ws, &ControlMessage::HelloAck { acked: vec![] }).await;
            // Hold the socket open and never read again.
            std::future::pending::<()>().await;
            drop(ws);
        })
        .await;

        let root_dir = tempfile::tempdir().unwrap();
        let store_dir = tempfile::tempdir().unwrap();
        let store = ChunkStore::open_fs(store_dir.path()).unwrap();
        let (shared, mut rx) = test_shared_with(root_dir.path(), store, &url, |c| {
            c.keepalive_ms = 60;
            c.idle_timeout_ms = 400;
        });

        let mut backoff = Backoff::new(Duration::from_millis(50), Duration::from_secs(5));
        let started = Instant::now();
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            connect_and_serve(&shared, &mut rx, &mut backoff, &mut no_shutdown()),
        )
        .await
        .expect("the session must end on its own, not hang");

        assert!(
            matches!(
                outcome,
                Ok(SessionOutcome::Disconnected(DisconnectReason::IdleTimeout))
            ),
            "a peer that answers nothing must end the session as an idle timeout, got {outcome:?}"
        );
        assert!(
            started.elapsed() >= Duration::from_millis(400),
            "the socket must not be declared dead before the idle window elapses"
        );
    }

    /// Idle death must not be a side effect of the keepalive being configured: a
    /// peer that swallows the handshake and never says anything (no HelloAck, no
    /// close) has to be given up on even with pings switched off, or the loop sits
    /// on a dead socket forever with no error to report.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_black_hole_peer_is_declared_dead_even_with_no_keepalive() {
        let url = spawn_ws(|ws| async move {
            // Never read, never write, never close: accept and go silent.
            std::future::pending::<()>().await;
            drop(ws);
        })
        .await;

        let root_dir = tempfile::tempdir().unwrap();
        let store_dir = tempfile::tempdir().unwrap();
        let store = ChunkStore::open_fs(store_dir.path()).unwrap();
        let (shared, mut rx) = test_shared_with(root_dir.path(), store, &url, |c| {
            c.keepalive_ms = 0; // no pings at all
            c.idle_timeout_ms = 300;
        });

        let mut backoff = Backoff::new(Duration::from_millis(50), Duration::from_secs(5));
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            connect_and_serve(&shared, &mut rx, &mut backoff, &mut no_shutdown()),
        )
        .await
        .expect("the session must end on its own even with no keepalive");
        assert!(
            matches!(
                outcome,
                Ok(SessionOutcome::Disconnected(DisconnectReason::IdleTimeout))
            ),
            "a black-hole peer must end the session as an idle timeout, got {outcome:?}"
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn a_close_after_a_live_session_is_a_failure_not_an_idle_timeout() {
        // Handshake, then close straight away: the socket was never idle, so this
        // must NOT be attributed to the idle reaper.
        let url = spawn_ws(|mut ws| async move {
            let _ = ws.next().await;
            let _ = send_framed(&mut ws, &ControlMessage::HelloAck { acked: vec![] }).await;
            let _ = ws.send(Message::Close(None)).await;
        })
        .await;

        let root_dir = tempfile::tempdir().unwrap();
        let store_dir = tempfile::tempdir().unwrap();
        let store = ChunkStore::open_fs(store_dir.path()).unwrap();
        let (shared, mut rx) = test_shared_with(root_dir.path(), store, &url, |c| {
            c.keepalive_ms = 60;
            c.idle_timeout_ms = 10_000;
        });

        let mut backoff = Backoff::new(Duration::from_millis(50), Duration::from_secs(5));
        let outcome = tokio::time::timeout(
            Duration::from_secs(10),
            connect_and_serve(&shared, &mut rx, &mut backoff, &mut no_shutdown()),
        )
        .await
        .expect("the session must end");
        assert!(
            matches!(
                outcome,
                Ok(SessionOutcome::Disconnected(DisconnectReason::PeerClose))
            ),
            "a prompt close is a real failure, not an idle timeout, got {outcome:?}"
        );
    }

    /// The classification rule itself, at the boundary: identical drops are
    /// reported differently depending only on how long the socket had been quiet.
    #[test]
    fn a_drop_is_attributed_to_the_idle_reaper_only_after_the_idle_window() {
        let window = Duration::from_secs(120);
        for base in [
            DisconnectReason::PeerClose,
            DisconnectReason::Eof,
            DisconnectReason::ReadError,
        ] {
            assert_eq!(
                base.after_silence(Duration::from_secs(119), window),
                base,
                "a drop within the idle window is a real failure"
            );
            assert_eq!(
                base.after_silence(window, window),
                DisconnectReason::IdleTimeout,
                "a drop after the idle window is the idle reaper"
            );
        }
        // Reasons that are not transport drops are never reinterpreted.
        assert_eq!(
            DisconnectReason::OutboxClosed.after_silence(Duration::from_secs(600), window),
            DisconnectReason::OutboxClosed
        );
        assert_eq!(
            DisconnectReason::ShuttingDown.after_silence(Duration::from_secs(600), window),
            DisconnectReason::ShuttingDown
        );
    }

    /// The idle window used for classification is derived, so a deployment that
    /// disables one knob still gets a sane rule instead of 0 (which would call
    /// every drop an idle timeout).
    #[test]
    fn the_idle_window_falls_back_sanely() {
        let root = std::path::PathBuf::from("/tmp/unused");
        let store_dir = tempfile::tempdir().unwrap();
        let store = ChunkStore::open_fs(store_dir.path()).unwrap();
        let (a, _rx) = test_shared_with(&root, store.clone(), "ws://127.0.0.1:1", |c| {
            c.idle_timeout_ms = 30_000;
            c.keepalive_ms = 1_000;
        });
        assert_eq!(idle_window(&a.config), Duration::from_secs(30));

        let (b, _rx) = test_shared_with(&root, store.clone(), "ws://127.0.0.1:1", |c| {
            c.idle_timeout_ms = 0;
            c.keepalive_ms = 45_000;
        });
        assert_eq!(
            idle_window(&b.config),
            Duration::from_secs(90),
            "with no idle timeout, twice the keepalive is the window"
        );

        let (c, _rx) = test_shared_with(&root, store, "ws://127.0.0.1:1", |c| {
            c.idle_timeout_ms = 0;
            c.keepalive_ms = 0;
        });
        assert_eq!(idle_window(&c.config), DEFAULT_IDLE_CLASS);
    }

    /// The shutdown budget must always leave room to write the final manifest.
    #[test]
    fn the_shutdown_stop_budget_never_eats_the_whole_grace() {
        let root = std::path::PathBuf::from("/tmp/unused");
        let store_dir = tempfile::tempdir().unwrap();
        let store = ChunkStore::open_fs(store_dir.path()).unwrap();
        for grace_ms in [1_000u64, 6_000, 60_000, 900_000] {
            let (s, _rx) = test_shared_with(&root, store.clone(), "ws://127.0.0.1:1", |c| {
                c.shutdown_grace_ms = grace_ms;
            });
            let stop = s.config.shutdown_stop_budget();
            assert!(
                stop < s.config.shutdown_grace(),
                "stop budget {stop:?} must be strictly less than the grace {grace_ms}ms"
            );
            assert!(
                stop >= Duration::from_millis(200),
                "a run must always get a moment to stop cleanly ({stop:?})"
            );
        }
    }
}
