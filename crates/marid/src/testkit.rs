//! A fake control plane for testing the supervisor's WebSocket client.
//!
//! Gated behind the `test-support` feature (and always available to in-crate
//! tests) so the e2e suite can reuse the same harness. It speaks the real
//! framed-CBOR protocol (contracts §2, §5): it performs the Hello/HelloAck
//! handshake, records every supervisor message, reassembles each run's journal
//! by offset — asserting there is **no gap and no conflicting duplicate** — and
//! can drive the supervisor by sending control messages (e.g. `StartRun`). It
//! can drop the live connection to exercise reconnect/resume, and acks journal
//! bytes under a configurable cap so a resume has real unacked data to re-send.

#![allow(clippy::type_complexity)]

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use futures_util::{SinkExt, StreamExt};
use mari_proto::{
    AttentionKind, ComputerId, ControlMessage, DiffSummary, Epoch, ExitStatus, FrameReader,
    JournalOffset, ManifestId, RunId, RunOffset, SnapshotReason, SupervisorMessage,
};
use tokio::net::{TcpListener, TcpStream};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::accept_async;
use tokio_tungstenite::tungstenite::Message;

use crate::ws::{decode_payload, send_framed};

/// What the supervisor said in its `Hello`.
#[derive(Clone, Debug)]
pub struct HelloRecord {
    pub computer: ComputerId,
    pub epoch: Epoch,
    pub token: String,
    pub proto_version: u32,
}

/// Offset-addressed reassembly of one run's journal, with integrity checks.
#[derive(Default)]
pub struct RunReassembly {
    /// The contiguous received bytes.
    pub buf: Vec<u8>,
    /// The highest offset we have acked to the supervisor.
    pub acked: u64,
}

impl RunReassembly {
    /// Ingest one journal frame. Returns an error string on a gap (offset beyond
    /// the contiguous end) or a conflicting duplicate (overlapping bytes that
    /// disagree). Idempotent for an exact replay.
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

/// Everything the fake control plane observed. Tests lock and assert against it.
#[derive(Default)]
pub struct FakeState {
    pub hellos: Vec<HelloRecord>,
    pub connections: u32,
    pub journals: HashMap<RunId, RunReassembly>,
    /// Per-connection (indexed by connection number) first journal offset seen
    /// for each run — used to assert a resume starts at the acked offset.
    pub first_offsets: Vec<HashMap<RunId, u64>>,
    pub attentions: Vec<(RunId, AttentionKind)>,
    pub run_started: Vec<(RunId, ManifestId)>,
    pub run_completed: Vec<(RunId, ExitStatus, ManifestId, DiffSummary)>,
    pub snapshots: Vec<(ManifestId, Epoch, SnapshotReason)>,
    pub head_advances: Vec<(ManifestId, Epoch)>,
    pub heartbeats: HashMap<RunId, u32>,
    /// Non-empty if any journal-integrity check failed.
    pub errors: Vec<String>,
}

struct Ctrl {
    kill_gen: AtomicU64,
    kill_notify: tokio::sync::Notify,
    pending_out: Mutex<VecDeque<ControlMessage>>,
    ack_cap: Mutex<Option<u64>>,
}

/// A fake control-plane server bound to an ephemeral localhost port.
pub struct FakeControlPlane {
    url: String,
    state: Arc<Mutex<FakeState>>,
    ctrl: Arc<Ctrl>,
    _accept: tokio::task::JoinHandle<()>,
}

impl FakeControlPlane {
    /// Bind, start accepting, and return the running server.
    pub async fn start() -> std::io::Result<Self> {
        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let addr = listener.local_addr()?;
        let url = format!("ws://{addr}");
        let state = Arc::new(Mutex::new(FakeState::default()));
        let ctrl = Arc::new(Ctrl {
            kill_gen: AtomicU64::new(0),
            kill_notify: tokio::sync::Notify::new(),
            pending_out: Mutex::new(VecDeque::new()),
            ack_cap: Mutex::new(None),
        });
        let accept = tokio::spawn(accept_loop(listener, state.clone(), ctrl.clone()));
        Ok(Self {
            url,
            state,
            ctrl,
            _accept: accept,
        })
    }

    /// The `ws://` URL the supervisor should connect to.
    pub fn url(&self) -> &str {
        &self.url
    }

    /// Cap the acked offset so a resume has real unacked bytes to re-send. The
    /// server will never ack past `cap` bytes of a run's journal.
    pub fn set_ack_cap(&self, cap: u64) {
        *self.ctrl.ack_cap.lock().unwrap() = Some(cap);
    }

    /// Queue a control message to send to the supervisor on the live connection.
    pub fn queue_control(&self, msg: ControlMessage) {
        self.ctrl.pending_out.lock().unwrap().push_back(msg);
    }

    /// Drop the current connection (simulate a network kill), forcing the
    /// supervisor to reconnect.
    pub fn kill_connection(&self) {
        self.ctrl.kill_gen.fetch_add(1, Ordering::SeqCst);
        self.ctrl.kill_notify.notify_waiters();
    }

    /// Inspect the observed state under the lock.
    pub fn with_state<R>(&self, f: impl FnOnce(&FakeState) -> R) -> R {
        f(&self.state.lock().unwrap())
    }

    /// The reassembled journal for a run (contiguous received bytes).
    pub fn reassembled(&self, run: &RunId) -> Vec<u8> {
        self.state
            .lock()
            .unwrap()
            .journals
            .get(run)
            .map(|r| r.buf.clone())
            .unwrap_or_default()
    }

    /// The first journal offset the server saw for `run` on connection `conn`
    /// (0-indexed).
    pub fn first_offset(&self, conn: usize, run: &RunId) -> Option<u64> {
        self.state
            .lock()
            .unwrap()
            .first_offsets
            .get(conn)
            .and_then(|m| m.get(run).copied())
    }

    /// Number of connections accepted so far.
    pub fn connection_count(&self) -> u32 {
        self.state.lock().unwrap().connections
    }

    /// Poll `pred` against the observed state until it holds or `timeout`
    /// elapses. Returns whether it held.
    pub async fn wait_until(
        &self,
        timeout: Duration,
        pred: impl Fn(&FakeState) -> bool,
    ) -> bool {
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
}

async fn accept_loop(listener: TcpListener, state: Arc<Mutex<FakeState>>, ctrl: Arc<Ctrl>) {
    loop {
        let (stream, _) = match listener.accept().await {
            Ok(s) => s,
            Err(_) => break,
        };
        let ws = match accept_async(stream).await {
            Ok(ws) => ws,
            Err(_) => continue,
        };
        serve_conn(ws, state.clone(), ctrl.clone()).await;
    }
}

async fn serve_conn(
    ws: WebSocketStream<TcpStream>,
    state: Arc<Mutex<FakeState>>,
    ctrl: Arc<Ctrl>,
) {
    let conn_idx = {
        let mut s = state.lock().unwrap();
        s.connections += 1;
        s.first_offsets.push(HashMap::new());
        s.first_offsets.len() - 1
    };
    let my_gen = ctrl.kill_gen.load(Ordering::SeqCst);
    let (mut write, mut read) = ws.split();
    let mut frames = FrameReader::new();
    let mut tick = tokio::time::interval(Duration::from_millis(5));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        if ctrl.kill_gen.load(Ordering::SeqCst) != my_gen {
            let _ = write.close().await;
            return;
        }
        tokio::select! {
            _ = ctrl.kill_notify.notified() => { /* re-check gen at loop top */ }
            incoming = read.next() => {
                match incoming {
                    Some(Ok(Message::Binary(payload))) => {
                        let mut msgs: Vec<SupervisorMessage> = Vec::new();
                        if let Err(e) = decode_payload(&mut frames, payload.as_ref(), &mut msgs) {
                            state.lock().unwrap().errors.push(format!("decode: {e}"));
                            return;
                        }
                        for m in msgs {
                            if handle_sup(m, &mut write, &state, &ctrl, conn_idx).await.is_err() {
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
                    let mut q = ctrl.pending_out.lock().unwrap();
                    q.drain(..).collect()
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
    ctrl: &Arc<Ctrl>,
    conn_idx: usize,
) -> Result<(), ()> {
    match msg {
        SupervisorMessage::Hello {
            computer,
            epoch,
            token,
            proto_version,
        } => {
            // Record and reply with the durably-acked offsets so far.
            let acked = {
                let mut s = state.lock().unwrap();
                s.hellos.push(HelloRecord {
                    computer,
                    epoch,
                    token,
                    proto_version,
                });
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
                // Record the first offset for this run on this connection.
                s.first_offsets[conn_idx]
                    .entry(run.clone())
                    .or_insert(offset.get());
                let entry = s.journals.entry(run.clone()).or_default();
                if let Err(e) = entry.ingest(offset.get(), &bytes) {
                    s.errors.push(e);
                    return Err(());
                }
                let received = entry.buf.len() as u64;
                let cap = *ctrl.ack_cap.lock().unwrap();
                let target = match cap {
                    Some(c) => received.min(c),
                    None => received,
                };
                if target > entry.acked {
                    entry.acked = target;
                    Some(target)
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
            state
                .lock()
                .unwrap()
                .snapshots
                .push((manifest, epoch, reason));
        }
        SupervisorMessage::HeadAdvanceRequest { manifest, epoch } => {
            state
                .lock()
                .unwrap()
                .head_advances
                .push((manifest.clone(), epoch));
            // Accept the advance at our (single) epoch.
            send_framed(
                write,
                &ControlMessage::HeadAdvanceResult {
                    accepted: true,
                    current_epoch: epoch,
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
    }
    Ok(())
}
