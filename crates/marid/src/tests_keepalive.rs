//! The control channel must survive doing nothing.
//!
//! Spec 5.4's heartbeat holds the *machine* awake **while a run is active**. It
//! says nothing about an AWAKE computer that is simply sitting there, and that is
//! the common case: a user opens a computer, reads a file, thinks. A probe against
//! Cloudflare measured an idle WebSocket through the edge silently killed at
//! ~270 s — 1006, no close frame — while the container kept running. Without a
//! supervisor-level keepalive the computer loses its control channel about four
//! and a half minutes after the last run ends and then churns through reconnects.
//!
//! These tests run the **real daemon** ([`crate::run`]) against a real local
//! server that behaves like that edge: it reaps any connection that has sent it
//! nothing for `idle_kill`. Nothing is mocked and no clock is paused.
//!
//! Two scales, same server:
//!
//! - The default test scales the measured numbers down by 450× (270 s reaper →
//!   600 ms; 60 s keepalive → 100 ms(*)) and holds the socket idle for **5.8
//!   reaper windows**, where 300 s at production scale is 1.1 windows. It is
//!   therefore a strictly harder version of the production question, and it runs
//!   in about four seconds.
//! - `MARI_SLOW_TESTS=1` additionally runs the literal article: a 270 s reaper,
//!   marid's shipped 60 s keepalive, and 320 s of real idleness.
//!
//! (*) the ratio is preserved deliberately: 600/100 = 6 keepalives per reaper
//! window versus 270/60 = 4.5 in production, so the scaled test gives the
//! keepalive no extra room.

use std::collections::VecDeque;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use mari_proto::{ControlMessage, FrameReader, SnapshotReason, SupervisorMessage};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use crate::config::Config;
use crate::ws::{decode_payload, send_framed};

/// What the idle-reaping server observed.
#[derive(Default)]
struct ReaperState {
    /// Connections accepted (a reconnect increments this).
    connections: u64,
    /// Connections the server closed for being silent — the failure this whole
    /// mechanism exists to prevent.
    reaped: u64,
    /// Keepalive pings received.
    pings: u64,
    /// `Hello`s received.
    hellos: u64,
    /// Snapshot reports received (the liveness probe at the end of a test).
    snapshots: Vec<SnapshotReason>,
    /// Runs the supervisor reported starting (must stay empty: the keepalive has
    /// to work with no run in flight).
    run_starts: u64,
}

/// A control plane that reaps silent connections, exactly as the edge does.
struct Reaper {
    url: String,
    state: Arc<Mutex<ReaperState>>,
    pending: Arc<Mutex<VecDeque<ControlMessage>>>,
    _accept: tokio::task::JoinHandle<()>,
}

impl Reaper {
    async fn start(idle_kill: Duration) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        let state = Arc::new(Mutex::new(ReaperState::default()));
        let pending = Arc::new(Mutex::new(VecDeque::new()));
        let accept = {
            let state = state.clone();
            let pending = pending.clone();
            tokio::spawn(async move {
                loop {
                    let Ok((stream, _)) = listener.accept().await else {
                        return;
                    };
                    let state = state.clone();
                    let pending = pending.clone();
                    tokio::spawn(async move {
                        if let Ok(ws) = accept_async(stream).await {
                            serve(ws, state, pending, idle_kill).await;
                        }
                    });
                }
            })
        };
        Self {
            url: format!("ws://{addr}"),
            state,
            pending,
            _accept: accept,
        }
    }

    fn with_state<R>(&self, f: impl FnOnce(&ReaperState) -> R) -> R {
        f(&self.state.lock().unwrap())
    }

    fn queue(&self, msg: ControlMessage) {
        self.pending.lock().unwrap().push_back(msg);
    }

    async fn wait_until(&self, timeout: Duration, pred: impl Fn(&ReaperState) -> bool) -> bool {
        let deadline = Instant::now() + timeout;
        loop {
            if pred(&self.state.lock().unwrap()) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    }
}

async fn serve(
    ws: WebSocketStream<TcpStream>,
    state: Arc<Mutex<ReaperState>>,
    pending: Arc<Mutex<VecDeque<ControlMessage>>>,
    idle_kill: Duration,
) {
    state.lock().unwrap().connections += 1;
    let (mut write, mut read) = ws.split();
    let mut frames = FrameReader::new();
    let mut last_inbound = Instant::now();
    // The reaper's own clock. Coarse on purpose: this is a proxy sweeping for
    // idle flows, not a precise timer.
    let mut tick = tokio::time::interval(Duration::from_millis(20));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            incoming = read.next() => {
                last_inbound = Instant::now();
                match incoming {
                    Some(Ok(Message::Ping(p))) => {
                        state.lock().unwrap().pings += 1;
                        // Answer explicitly rather than relying on the library's
                        // implicit pong, so what this test proves is marid's
                        // behavior and not tungstenite's internals.
                        if write.send(Message::Pong(p)).await.is_err() {
                            return;
                        }
                    }
                    Some(Ok(Message::Binary(payload))) => {
                        let mut msgs: Vec<SupervisorMessage> = Vec::new();
                        if decode_payload(&mut frames, payload.as_ref(), &mut msgs).is_err() {
                            return;
                        }
                        for m in msgs {
                            match m {
                                SupervisorMessage::Hello { .. } => {
                                    state.lock().unwrap().hellos += 1;
                                    if send_framed(
                                        &mut write,
                                        &ControlMessage::HelloAck { acked: vec![] },
                                    )
                                    .await
                                    .is_err()
                                    {
                                        return;
                                    }
                                }
                                SupervisorMessage::SnapshotWritten { reason, .. } => {
                                    state.lock().unwrap().snapshots.push(reason);
                                }
                                SupervisorMessage::RunStarted { .. } => {
                                    state.lock().unwrap().run_starts += 1;
                                }
                                _ => {}
                            }
                        }
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) | None => return,
                }
            }
            _ = tick.tick() => {
                if last_inbound.elapsed() >= idle_kill {
                    // Reap it the way the edge does: drop the socket, no close
                    // frame. The client sees a 1006-style abnormal closure.
                    state.lock().unwrap().reaped += 1;
                    return;
                }
                let batch: Vec<ControlMessage> =
                    { pending.lock().unwrap().drain(..).collect() };
                for cm in batch {
                    if send_framed(&mut write, &cm).await.is_err() {
                        return;
                    }
                }
            }
        }
    }
}

fn config_for(reaper: &Reaper, root: &Path, store_dir: &Path, keepalive_ms: u64) -> Config {
    Config {
        computer_id: "comp-keepalive".into(),
        control_url: reaper.url.clone(),
        allow_insecure_ws: false,
        token: "keepalive-token".into(),
        epoch: 1,
        root: root.to_path_buf(),
        store: format!("fs://{}", store_dir.join("store").display()),
        snapshot_interval_secs: 3600,
        attention_silence_ms: 600_000,
        restore_manifest: None,
        agents_dir: store_dir.join("agents.d"),
        segment_bytes: 4 * 1024 * 1024,
        keepalive_ms,
        // Far above anything these tests exercise: only the SERVER's reaper may
        // end a connection here, so a failure cannot be blamed on marid giving up.
        idle_timeout_ms: keepalive_ms * 1_000,
        shutdown_grace_ms: 5_000,
    }
}

/// The core assertion, run at whatever scale the caller picks: with no run
/// active, the supervisor keeps its control channel alive across many reaper
/// windows, on one connection, and the channel still works afterwards.
async fn assert_idle_socket_survives(
    reaper: &Reaper,
    keepalive: Duration,
    idle_for: Duration,
    label: &str,
) {
    let root = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let config = config_for(
        reaper,
        root.path(),
        store_dir.path(),
        keepalive.as_millis() as u64,
    );
    let sup = tokio::spawn(crate::run(config));

    assert!(
        reaper
            .wait_until(Duration::from_secs(10), |s| s.hellos >= 1)
            .await,
        "{label}: the supervisor must connect and hand over its Hello"
    );

    // Now do nothing at all for `idle_for`. No run, no command, no traffic other
    // than whatever marid sends on its own.
    tokio::time::sleep(idle_for).await;

    let (connections, reaped, pings, run_starts) =
        reaper.with_state(|s| (s.connections, s.reaped, s.pings, s.run_starts));
    assert_eq!(
        reaped, 0,
        "{label}: the server reaped the control channel for being silent after \
         {idle_for:?} of idleness — the keepalive did not do its job"
    );
    assert_eq!(
        connections, 1,
        "{label}: the control channel must be the SAME connection throughout \
         (no churn); saw {connections} connections"
    );
    assert_eq!(
        run_starts, 0,
        "{label}: this test is about an idle computer — no run may have started"
    );
    // The keepalive is what carried it: at least most of the expected pings must
    // have arrived (allowing for scheduling slack at either end).
    let expected = (idle_for.as_millis() / keepalive.as_millis().max(1)) as u64;
    let floor = expected.saturating_sub(expected / 4 + 1);
    assert!(
        pings >= floor,
        "{label}: expected at least {floor} keepalive pings over {idle_for:?} \
         (interval {keepalive:?}), saw {pings}"
    );

    // And the channel is not merely open, it is usable: a command sent after all
    // that silence is answered.
    reaper.queue(ControlMessage::SnapshotNow {
        reason: SnapshotReason::Command,
    });
    assert!(
        reaper
            .wait_until(Duration::from_secs(20), |s| s
                .snapshots
                .contains(&SnapshotReason::Command))
            .await,
        "{label}: the control channel must still carry commands after the idle period"
    );
    reaper.with_state(|s| {
        assert_eq!(
            s.connections, 1,
            "{label}: the command must have been answered on the original connection"
        );
    });

    sup.abort();
}

/// Scaled: a 600 ms reaper, a 100 ms keepalive, and 3.5 s of idleness — 5.8
/// reaper windows, against 300 s / 270 s ≈ 1.1 windows at production scale.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_control_channel_survives_many_reaper_windows_with_no_run_active() {
    let reaper = Reaper::start(Duration::from_millis(600)).await;
    assert_idle_socket_survives(
        &reaper,
        Duration::from_millis(100),
        Duration::from_millis(3_500),
        "scaled",
    )
    .await;
}

/// The literal measurement, at full scale: the ~270 s idle kill the probe saw,
/// marid's shipped 60 s keepalive, and 320 s of real idleness. Gated because it
/// takes five and a half minutes of wall clock.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_idle_control_channel_survives_past_300_seconds_at_production_scale() {
    if std::env::var("MARI_SLOW_TESTS").as_deref() != Ok("1") {
        eprintln!(
            "[keepalive] SKIP: set MARI_SLOW_TESTS=1 to run the full-scale test \
             (270 s reaper, 60 s keepalive, 320 s of idleness; ~5.5 minutes). The \
             scaled test above covers the same property in seconds."
        );
        return;
    }
    let reaper = Reaper::start(Duration::from_secs(270)).await;
    assert_idle_socket_survives(
        &reaper,
        // marid's shipped default (Config::keepalive_ms).
        Duration::from_secs(60),
        Duration::from_secs(320),
        "production-scale",
    )
    .await;
}

/// The other half of the story: when a socket *is* lost, the supervisor comes
/// back. Here the keepalive is switched off, so the reaper does exactly what the
/// probe observed — and marid must reconnect and re-handshake rather than sit
/// there believing it is connected.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn without_a_keepalive_the_reaper_wins_and_the_supervisor_reconnects() {
    let reaper = Reaper::start(Duration::from_millis(400)).await;
    let root = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    // keepalive_ms = 0 disables it: this is marid before this change.
    let mut config = config_for(&reaper, root.path(), store_dir.path(), 0);
    config.idle_timeout_ms = 0;
    let sup = tokio::spawn(crate::run(config));

    assert!(
        reaper
            .wait_until(Duration::from_secs(10), |s| s.hellos >= 1)
            .await,
        "the supervisor must connect"
    );
    // The reaper kills the silent socket, and marid dials again: proof that the
    // keepalive is what prevents the churn, not something else in the harness.
    assert!(
        reaper
            .wait_until(Duration::from_secs(15), |s| s.reaped >= 1
                && s.connections >= 2)
            .await,
        "an unkept socket must be reaped and then re-established: {:?}",
        reaper.with_state(|s| (s.connections, s.reaped, s.pings))
    );
    reaper.with_state(|s| {
        assert_eq!(
            s.pings, 0,
            "no keepalive was configured, so no ping may be sent"
        );
        assert!(s.hellos >= 2, "each reconnect must re-handshake");
    });
    sup.abort();
}

/// A ping is a ping: the keepalive frame must be a WebSocket control frame with
/// an empty payload, not an application message the control plane would have to
/// know about (contracts §2 says every binary payload is a CBOR frame).
#[test]
fn the_keepalive_frame_is_an_empty_websocket_ping() {
    let msg = crate::ws::keepalive_ping();
    match msg {
        Message::Ping(payload) => assert!(payload.is_empty(), "keepalive pings carry no payload"),
        other => panic!("the keepalive must be a Ping frame, got {other:?}"),
    }
}

/// The shipped defaults have to sit in the window the probe measured: well under
/// the ~270 s reaper, and in the 60–120 s band the design calls for.
#[test]
fn the_default_keepalive_is_well_under_the_measured_idle_kill() {
    let config = Config {
        computer_id: "c".into(),
        control_url: "wss://example.test/supervisor/c".into(),
        allow_insecure_ws: false,
        token: String::new(),
        epoch: 1,
        root: "/work".into(),
        store: "fs:///store".into(),
        snapshot_interval_secs: 300,
        attention_silence_ms: 30_000,
        restore_manifest: None,
        agents_dir: "/etc/mari/agents.d".into(),
        segment_bytes: 4 * 1024 * 1024,
        // The values `clap` would supply from the derive defaults; asserted here
        // so a change to them has to be deliberate.
        keepalive_ms: 60_000,
        idle_timeout_ms: 240_000,
        shutdown_grace_ms: 60_000,
    };
    let keepalive = config.keepalive_interval().expect("enabled by default");
    assert!(
        keepalive >= Duration::from_secs(60) && keepalive <= Duration::from_secs(120),
        "the keepalive must be in the 60-120 s band, got {keepalive:?}"
    );
    assert!(
        keepalive * 4 <= Duration::from_secs(270),
        "at least four keepalives must fit inside the measured ~270 s idle kill"
    );
    let idle = config.idle_timeout().expect("enabled by default");
    assert!(
        idle > keepalive * 3,
        "the idle timeout must tolerate several missed pongs ({idle:?} vs {keepalive:?})"
    );
}

/// `clap`'s derived defaults are what a container actually runs with (marid is
/// configured entirely from the environment), so they are worth asserting.
#[test]
fn clap_defaults_enable_the_keepalive_and_a_bounded_shutdown() {
    use clap::Parser;
    let config = Config::try_parse_from([
        "marid",
        "--computer-id",
        "c",
        "--control-url",
        "wss://example.test/supervisor/c",
        "--root",
        "/work",
        "--store",
        "fs:///store",
    ])
    .expect("the minimal argument set must parse");
    assert_eq!(config.keepalive_ms, 60_000);
    assert_eq!(config.idle_timeout_ms, 240_000);
    assert_eq!(config.shutdown_grace_ms, 60_000);
    assert!(
        !config.allow_insecure_ws,
        "cleartext must never be the default"
    );
}
