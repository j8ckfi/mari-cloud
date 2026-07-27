//! Integration tests with teeth for the supervisor.
//!
//! These exercise real behavior: real child processes on real PTYs, byte-level
//! journal capture, actual snapshot/restore against the chunk store, the
//! content-free attention detector on live output, and the WebSocket client
//! against an in-test fake control plane (handshake, ack flow, reconnect resume).

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};

use mari_core::{ChunkStore, RestoreOptions, diff, restore};
use mari_proto::{
    AttentionKind, ComputerId, ControlMessage, Epoch, ExitStatus, Manifest, ManifestId,
    PROTO_VERSION, RunId, SnapshotReason, SupervisorMessage,
};
use tokio::sync::Notify;
use tokio::sync::mpsc::{UnboundedReceiver, unbounded_channel};

use crate::config::Config;
use crate::run::{RunManager, RunState};
use crate::testkit::FakeControlPlane;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn build_manager(
    root: &Path,
    journal_dir: &Path,
    store: ChunkStore,
    silence: Duration,
    segment: usize,
) -> (Arc<RunManager>, UnboundedReceiver<SupervisorMessage>) {
    let (tx, rx) = unbounded_channel();
    let notify = Arc::new(Notify::new());
    let computer = ComputerId::new("comp-test");
    let m = Arc::new(RunManager::new(
        store.clone(),
        root.to_path_buf(),
        journal_dir.to_path_buf(),
        computer.clone(),
        Epoch::new(1),
        tx,
        notify,
        silence,
        segment,
        Arc::new(crate::adapters::AdapterSet::default()),
        Arc::new(crate::state::DurableState::new(
            store,
            computer,
            Epoch::new(1),
        )),
    ));
    (m, rx)
}

/// Collect outbox messages until `stop` returns true for one (inclusive) or the
/// timeout elapses.
async fn collect_until<F: Fn(&SupervisorMessage) -> bool>(
    rx: &mut UnboundedReceiver<SupervisorMessage>,
    stop: F,
    timeout: Duration,
) -> Vec<SupervisorMessage> {
    let mut out = Vec::new();
    let deadline = Instant::now() + timeout;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(m)) => {
                let done = stop(&m);
                out.push(m);
                if done {
                    break;
                }
            }
            Ok(None) | Err(_) => break,
        }
    }
    out
}

/// Collect outbox messages for a fixed duration (used when no completion is
/// expected, e.g. a hung run).
async fn collect_for(
    rx: &mut UnboundedReceiver<SupervisorMessage>,
    dur: Duration,
) -> Vec<SupervisorMessage> {
    let mut out = Vec::new();
    let deadline = Instant::now() + dur;
    loop {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            break;
        }
        match tokio::time::timeout(remaining, rx.recv()).await {
            Ok(Some(m)) => out.push(m),
            Ok(None) | Err(_) => break,
        }
    }
    out
}

fn attention_kinds(msgs: &[SupervisorMessage], run: &RunId) -> Vec<AttentionKind> {
    msgs.iter()
        .filter_map(|m| match m {
            SupervisorMessage::Attention { run: r, kind } if r == run => Some(*kind),
            _ => None,
        })
        .collect()
}

fn run_completed<'a>(
    msgs: &'a [SupervisorMessage],
    run: &RunId,
) -> Option<(&'a ExitStatus, &'a ManifestId, &'a mari_proto::DiffSummary)> {
    msgs.iter().find_map(|m| match m {
        SupervisorMessage::RunCompleted {
            run: r,
            exit,
            post_run_manifest,
            diff,
        } if r == run => Some((exit, post_run_manifest, diff)),
        _ => None,
    })
}

fn fs_store(dir: &Path) -> ChunkStore {
    ChunkStore::open_fs(dir.join("store")).unwrap()
}

fn known_blob(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| {
            let n = (i % 62) as u8;
            if n < 10 {
                b'0' + n
            } else if n < 36 {
                b'a' + (n - 10)
            } else {
                b'A' + (n - 36)
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 1. Real PTY run: exact journal bytes and exit status.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn real_pty_run_captures_exact_bytes_and_exit_three() {
    let root = tempfile::tempdir().unwrap();
    let jdir = tempfile::tempdir().unwrap();
    let store = fs_store(root.path());
    let (m, mut rx) = build_manager(
        root.path(),
        jdir.path(),
        store,
        Duration::from_secs(30),
        4096,
    );

    let run = RunId::new("run-exit3");
    // No trailing newline -> no ONLCR (\n -> \r\n) translation in the pty, so
    // the journal equals these bytes exactly.
    let marker = "MARI-KNOWN-BYTES-0123456789";
    let state: Arc<RunState> = m
        .start_run(
            run.clone(),
            vec![
                "sh".into(),
                "-c".into(),
                format!("printf '{marker}'; exit 3"),
            ],
            vec![],
            root.path().to_str().unwrap().to_string(),
        )
        .await
        .unwrap();

    let msgs = collect_until(
        &mut rx,
        |m| matches!(m, SupervisorMessage::RunCompleted { run: r, .. } if *r == run),
        Duration::from_secs(15),
    )
    .await;

    let (exit, _post, _diff) = run_completed(&msgs, &run).expect("run must complete");
    assert_eq!(
        *exit,
        ExitStatus::Exited { code: 3 },
        "exit status must be 3"
    );

    // Journal bytes must equal the program's output exactly.
    assert_eq!(state.journal.snapshot_bytes(), marker.as_bytes());
}

// ---------------------------------------------------------------------------
// 2. Snapshot/diff/restore: the run's changes are exactly the diff, and the
//    pre-run manifest restores byte-identically.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn diff_lists_exactly_changed_paths_and_prerun_restores_byte_identically() {
    let root = tempfile::tempdir().unwrap();
    let jdir = tempfile::tempdir().unwrap();
    let store = fs_store(jdir.path()); // store outside root to avoid self-capture

    // Pre-populate the computer filesystem.
    std::fs::write(root.path().join("keep.txt"), b"keep").unwrap();
    std::fs::write(root.path().join("mod.txt"), b"before").unwrap();
    std::fs::write(root.path().join("del.txt"), b"delete-me").unwrap();

    let (m, mut rx) = build_manager(
        root.path(),
        jdir.path(),
        store.clone(),
        Duration::from_secs(30),
        4096,
    );

    let run = RunId::new("run-diff");
    let state = m
        .start_run(
            run.clone(),
            vec![
                "sh".into(),
                "-c".into(),
                "printf created > new.txt; printf AFTER > mod.txt; rm del.txt".into(),
            ],
            vec![],
            root.path().to_str().unwrap().to_string(),
        )
        .await
        .unwrap();

    let msgs = collect_until(
        &mut rx,
        |m| matches!(m, SupervisorMessage::RunCompleted { run: r, .. } if *r == run),
        Duration::from_secs(15),
    )
    .await;
    let (_exit, post_id, summary) = run_completed(&msgs, &run).expect("run must complete");

    // The wire diff summary must be exactly +1 / ~1 / -1.
    assert_eq!(summary.added, 1, "one file added");
    assert_eq!(summary.modified, 1, "one file modified");
    assert_eq!(summary.removed, 1, "one file removed");

    // Recompute the structured diff from the stored manifests and assert the
    // exact paths.
    let pre: Manifest = store.get_manifest(&state.pre_run_manifest).await.unwrap();
    let post: Manifest = store.get_manifest(post_id).await.unwrap();
    let d = diff(&pre, &post);
    let added: Vec<&str> = d.added.iter().map(|e| e.path.as_str()).collect();
    let removed: Vec<&str> = d.removed.iter().map(|e| e.path.as_str()).collect();
    let modified: Vec<&str> = d.modified.iter().map(|e| e.path.as_str()).collect();
    assert_eq!(added, vec!["/new.txt"]);
    assert_eq!(removed, vec!["/del.txt"]);
    assert_eq!(modified, vec!["/mod.txt"]);

    // Restore the pre-run manifest into a fresh tree: it must reproduce the
    // pre-run filesystem byte-for-byte (del.txt back, new.txt absent).
    let restored = tempfile::tempdir().unwrap();
    restore(&store, &pre, restored.path(), &RestoreOptions::default())
        .await
        .unwrap();
    assert_eq!(
        std::fs::read(restored.path().join("keep.txt")).unwrap(),
        b"keep"
    );
    assert_eq!(
        std::fs::read(restored.path().join("mod.txt")).unwrap(),
        b"before"
    );
    assert_eq!(
        std::fs::read(restored.path().join("del.txt")).unwrap(),
        b"delete-me"
    );
    assert!(
        !restored.path().join("new.txt").exists(),
        "new.txt must not exist in the restored pre-run tree"
    );
}

// ---------------------------------------------------------------------------
// 3. Attention: BEL, OSC 9, blocked-read silence, and a chatty (silent-signals)
//    run produces zero events.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn bell_emits_one_bell_event() {
    let root = tempfile::tempdir().unwrap();
    let jdir = tempfile::tempdir().unwrap();
    let (m, mut rx) = build_manager(
        root.path(),
        jdir.path(),
        fs_store(root.path()),
        Duration::from_secs(30),
        4096,
    );
    let run = RunId::new("run-bell");
    m.start_run(
        run.clone(),
        vec!["sh".into(), "-c".into(), "printf '\\a'".into()],
        vec![],
        root.path().to_str().unwrap().to_string(),
    )
    .await
    .unwrap();

    let msgs = collect_until(
        &mut rx,
        |m| matches!(m, SupervisorMessage::RunCompleted { run: r, .. } if *r == run),
        Duration::from_secs(10),
    )
    .await;
    assert_eq!(attention_kinds(&msgs, &run), vec![AttentionKind::Bell]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn osc9_emits_one_osc_event_and_no_bell() {
    let root = tempfile::tempdir().unwrap();
    let jdir = tempfile::tempdir().unwrap();
    let (m, mut rx) = build_manager(
        root.path(),
        jdir.path(),
        fs_store(root.path()),
        Duration::from_secs(30),
        4096,
    );
    let run = RunId::new("run-osc");
    // ESC ] 9 ; done BEL   (BEL terminates the OSC; must NOT count as a bell)
    m.start_run(
        run.clone(),
        vec!["sh".into(), "-c".into(), "printf '\\033]9;done\\a'".into()],
        vec![],
        root.path().to_str().unwrap().to_string(),
    )
    .await
    .unwrap();

    let msgs = collect_until(
        &mut rx,
        |m| matches!(m, SupervisorMessage::RunCompleted { run: r, .. } if *r == run),
        Duration::from_secs(10),
    )
    .await;
    assert_eq!(attention_kinds(&msgs, &run), vec![AttentionKind::Osc]);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn blocked_read_emits_one_event_after_threshold() {
    let root = tempfile::tempdir().unwrap();
    let jdir = tempfile::tempdir().unwrap();
    let (m, mut rx) = build_manager(
        root.path(),
        jdir.path(),
        fs_store(root.path()),
        Duration::from_millis(500), // test threshold
        4096,
    );
    let run = RunId::new("run-blocked");
    // Blocks on a read with no output; stdin stays open (we hold the pty writer).
    m.start_run(
        run.clone(),
        vec!["sh".into(), "-c".into(), "read x".into()],
        vec![],
        root.path().to_str().unwrap().to_string(),
    )
    .await
    .unwrap();

    // Collect for well over one threshold; exactly one blocked-read event.
    let msgs = collect_for(&mut rx, Duration::from_millis(1600)).await;
    assert_eq!(
        attention_kinds(&msgs, &run),
        vec![AttentionKind::BlockedRead],
        "a silent blocked read must raise exactly one blocked-read event"
    );
    m.stop_run(&run);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn chatty_run_raises_no_attention() {
    let root = tempfile::tempdir().unwrap();
    let jdir = tempfile::tempdir().unwrap();
    let (m, mut rx) = build_manager(
        root.path(),
        jdir.path(),
        fs_store(root.path()),
        Duration::from_millis(500),
        4096,
    );
    let run = RunId::new("run-chatty");
    // Prints every 50ms for ~1s: never idle past the 500ms threshold, no BEL/OSC.
    m.start_run(
        run.clone(),
        vec![
            "sh".into(),
            "-c".into(),
            "i=0; while [ $i -lt 20 ]; do printf 'tick '; i=$((i+1)); sleep 0.05; done".into(),
        ],
        vec![],
        root.path().to_str().unwrap().to_string(),
    )
    .await
    .unwrap();

    let msgs = collect_until(
        &mut rx,
        |m| matches!(m, SupervisorMessage::RunCompleted { run: r, .. } if *r == run),
        Duration::from_secs(10),
    )
    .await;
    assert!(
        attention_kinds(&msgs, &run).is_empty(),
        "chatty output must raise no attention: {:?}",
        attention_kinds(&msgs, &run)
    );
}

// ---------------------------------------------------------------------------
// 4. WebSocket client: handshake, ack flow, full journal transfer, completion.
// ---------------------------------------------------------------------------

fn ws_config(cp: &FakeControlPlane, root: &Path, store_dir: &Path) -> Config {
    Config {
        computer_id: "comp-ws".into(),
        control_url: cp.url().to_string(),
        allow_insecure_ws: false,
        token: "secret-token".into(),
        epoch: 7,
        root: root.to_path_buf(),
        store: format!("fs://{}", store_dir.join("store").display()),
        snapshot_interval_secs: 3600,
        attention_silence_ms: 600_000,
        restore_manifest: None,
        agents_dir: store_dir.join("agents.d"),
        segment_bytes: 4 * 1024 * 1024,
        // These tests are not about the keepalive; the tests that are set their
        // own timings (see `tests_keepalive`).
        keepalive_ms: 0,
        idle_timeout_ms: 0,
        shutdown_grace_ms: 5_000,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ws_handshake_ack_and_full_journal_transfer() {
    let cp = FakeControlPlane::start().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let blob = known_blob(1500);
    let blob_path = root.path().join("blob.bin");
    std::fs::write(&blob_path, &blob).unwrap();

    let config = ws_config(&cp, root.path(), store_dir.path());
    let sup = tokio::spawn(crate::run(config));

    // Handshake happened.
    assert!(
        cp.wait_until(Duration::from_secs(5), |s| !s.hellos.is_empty())
            .await,
        "supervisor must connect and send Hello"
    );
    cp.with_state(|s| {
        let h = &s.hellos[0];
        assert_eq!(h.computer, ComputerId::new("comp-ws"));
        assert_eq!(h.epoch, Epoch::new(7));
        assert_eq!(h.token, "secret-token");
        assert_eq!(h.proto_version, PROTO_VERSION);
    });

    // Drive a run that emits the known blob and exits.
    let run = RunId::new("run-ws1");
    cp.queue_control(ControlMessage::StartRun {
        run: run.clone(),
        argv: vec![
            "sh".into(),
            "-c".into(),
            format!("cat '{}'", blob_path.display()),
        ],
        env_names: vec![],
        cwd: root.path().to_str().unwrap().to_string(),
    });

    // The full journal transferred, byte-identical, with no integrity errors.
    let ok = cp
        .wait_until(Duration::from_secs(10), |s| {
            s.journals.get(&run).map(|r| r.buf == blob).unwrap_or(false)
        })
        .await;
    assert!(ok, "journal must reassemble to the exact PTY output");
    cp.with_state(|s| assert!(s.errors.is_empty(), "journal errors: {:?}", s.errors));

    // Completion and snapshot/head messages arrived.
    assert!(
        cp.wait_until(Duration::from_secs(10), |s| !s.run_completed.is_empty())
            .await,
        "a RunCompleted must arrive"
    );
    cp.with_state(|s| {
        let (r, exit, _post, _diff) = &s.run_completed[0];
        assert_eq!(*r, run);
        assert_eq!(*exit, ExitStatus::Exited { code: 0 });
        assert!(
            s.snapshots
                .iter()
                .any(|(_, _, reason)| *reason == SnapshotReason::PreRun),
            "a pre-run snapshot must be reported"
        );
        assert!(
            !s.head_advances.is_empty(),
            "a head advance must be requested"
        );
        assert!(
            s.run_started.iter().any(|(rr, _)| *rr == run),
            "RunStarted must be reported"
        );
    });

    sup.abort();
}

// ---------------------------------------------------------------------------
// 5. WebSocket reconnect: after a kill, the journal resumes from the acked
//    offset with no gap and no duplicate bytes.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ws_reconnect_resumes_journal_from_acked_offset() {
    let cp = FakeControlPlane::start().await.unwrap();
    // The control plane never acks past 100 bytes, so a resume must re-send the
    // rest from offset 100.
    let ack_cap = 100u64;
    cp.set_ack_cap(ack_cap);

    let root = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let blob = known_blob(2000);
    let blob_path = root.path().join("blob.bin");
    std::fs::write(&blob_path, &blob).unwrap();

    let config = ws_config(&cp, root.path(), store_dir.path());
    let sup = tokio::spawn(crate::run(config));

    assert!(
        cp.wait_until(Duration::from_secs(5), |s| s.connections >= 1
            && !s.hellos.is_empty())
            .await,
        "first connection + Hello"
    );

    // A run that emits the blob then lingers, so the connection is live when we
    // kill it.
    let run = RunId::new("run-ws2");
    cp.queue_control(ControlMessage::StartRun {
        run: run.clone(),
        argv: vec![
            "sh".into(),
            "-c".into(),
            format!("cat '{}'; sleep 3", blob_path.display()),
        ],
        env_names: vec![],
        cwd: root.path().to_str().unwrap().to_string(),
    });

    // Wait until the server has received at least the ack cap and thus acked it.
    assert!(
        cp.wait_until(Duration::from_secs(5), |s| s
            .journals
            .get(&run)
            .map(|r| r.buf.len() as u64 >= ack_cap && r.acked >= ack_cap)
            .unwrap_or(false))
            .await,
        "the first connection must receive and ack at least {ack_cap} bytes"
    );

    // Kill the live connection; the run keeps going (spec 5.1).
    cp.kill_connection();

    // The supervisor reconnects.
    assert!(
        cp.wait_until(Duration::from_secs(5), |s| s.connections >= 2)
            .await,
        "supervisor must reconnect"
    );

    // The full journal reassembles, with no gap and no conflicting duplicate.
    let ok = cp
        .wait_until(Duration::from_secs(8), |s| {
            s.journals.get(&run).map(|r| r.buf == blob).unwrap_or(false)
        })
        .await;
    assert!(ok, "resumed journal must equal the exact PTY output");

    cp.with_state(|s| {
        assert!(s.errors.is_empty(), "no gap/duplicate: {:?}", s.errors);
    });

    // The resume's first frame on the second connection started exactly at the
    // acked offset — proving it resumed from the ack, not from 0 or the end.
    assert_eq!(
        cp.first_offset(1, &run),
        Some(ack_cap),
        "resume must start at the acked offset"
    );

    sup.abort();
}

// ---------------------------------------------------------------------------
// 5b. Terminal input/resize: a first-class ControlMessage::Input reaches the
//     run's PTY (proven by the PTY echoing it into the journal), and a Resize
//     does not tear down the session — input after a resize still flows.
// ---------------------------------------------------------------------------

/// True if the run's reassembled journal contains `needle`. `s` is the
/// already-locked state passed into a `wait_until` predicate (do not re-lock).
fn journal_has(s: &crate::testkit::FakeState, run: &RunId, needle: &[u8]) -> bool {
    s.journals
        .get(run)
        .map(|r| r.buf.windows(needle.len()).any(|w| w == needle))
        .unwrap_or(false)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn ws_client_input_reaches_the_pty_and_resize_does_not_tear_down() {
    let cp = FakeControlPlane::start().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let config = ws_config(&cp, root.path(), store_dir.path());
    let sup = tokio::spawn(crate::run(config));

    assert!(
        cp.wait_until(Duration::from_secs(5), |s| !s.hellos.is_empty())
            .await,
        "supervisor must connect and handshake"
    );

    // An interactive `cat`: it (and the PTY line discipline) echo typed input.
    let run = RunId::new("run-input");
    cp.queue_control(ControlMessage::StartRun {
        run: run.clone(),
        argv: vec!["cat".into()],
        env_names: vec![],
        cwd: root.path().to_str().unwrap().to_string(),
    });
    assert!(
        cp.wait_until(Duration::from_secs(5), |s| s
            .run_started
            .iter()
            .any(|(r, _)| *r == run))
            .await,
        "the run must start before we type"
    );

    // Type a line as a first-class ControlMessage::Input.
    cp.queue_control(ControlMessage::Input {
        run: run.clone(),
        bytes: b"mari-typed\n".to_vec(),
    });
    assert!(
        cp.wait_until(Duration::from_secs(8), |s| journal_has(
            s,
            &run,
            b"mari-typed"
        ))
        .await,
        "typed input must reach the PTY and echo into the journal"
    );

    // Resize the PTY, then type again: if the Resize frame had torn the session
    // down (the pre-fix undecodable-frame bug), this second line would never
    // arrive.
    cp.queue_control(ControlMessage::Resize {
        run: run.clone(),
        cols: 100,
        rows: 30,
    });
    cp.queue_control(ControlMessage::Input {
        run: run.clone(),
        bytes: b"after-resize\n".to_vec(),
    });
    assert!(
        cp.wait_until(Duration::from_secs(8), |s| journal_has(
            s,
            &run,
            b"after-resize"
        ))
        .await,
        "input after a resize must still reach the PTY"
    );

    cp.with_state(|s| assert!(s.errors.is_empty(), "journal errors: {:?}", s.errors));

    // Stop the interactive `cat` and wait for it to actually finish, so its
    // blocking PTY reader thread ends before the runtime tears down.
    cp.queue_control(ControlMessage::StopRun { run: run.clone() });
    assert!(
        cp.wait_until(Duration::from_secs(5), |s| s
            .run_completed
            .iter()
            .any(|(r, ..)| *r == run))
            .await,
        "the run must stop cleanly after StopRun"
    );
    sup.abort();
}

// ---------------------------------------------------------------------------
// 6. Cold-wake restore: MARI_RESTORE_MANIFEST reconstructs the tree into
//    MARI_ROOT, ordered by the stored heat profile, and records the read order
//    for the next wake.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn cold_wake_restores_root_ordered_by_heat_and_updates_heat() {
    use mari_core::{HeatProfile, SnapshotOptions, snapshot, store_heat};

    let store_root = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(store_root.path()).unwrap();
    let computer = ComputerId::new("comp-ws"); // ws_config uses this id

    // A source tree to snapshot into the store.
    let src = tempfile::tempdir().unwrap();
    std::fs::write(src.path().join("a.txt"), b"alpha").unwrap();
    std::fs::write(src.path().join("z_last.txt"), b"omega-bytes").unwrap();
    let res = snapshot(&store, src.path(), &SnapshotOptions::default())
        .await
        .unwrap();
    let manifest_id = res.manifest_id.to_string();

    // Seed a heat profile that prioritizes the lexicographically-last file, so
    // restore ordering (not path ordering) puts it first.
    store_heat(
        &store,
        &computer,
        &HeatProfile {
            paths: vec!["/z_last.txt".to_string()],
        },
    )
    .await
    .unwrap();

    let cp = FakeControlPlane::start().await.unwrap();
    let root = tempfile::tempdir().unwrap(); // empty; cold wake fills it
    let mut config = ws_config(&cp, root.path(), store_root.path());
    // Point the config's store at the very store that holds the manifest.
    config.store = format!("fs://{}", store_root.path().display());
    config.restore_manifest = Some(manifest_id);
    let sup = tokio::spawn(crate::run(config));

    // Restore runs before connecting; once Hello is seen, the tree is present.
    assert!(
        cp.wait_until(Duration::from_secs(5), |s| !s.hellos.is_empty())
            .await,
        "supervisor must restore then connect"
    );

    // The tree was restored byte-identically into MARI_ROOT.
    assert_eq!(std::fs::read(root.path().join("a.txt")).unwrap(), b"alpha");
    assert_eq!(
        std::fs::read(root.path().join("z_last.txt")).unwrap(),
        b"omega-bytes"
    );

    // The heat profile was rewritten for the next wake, still honoring the
    // priority: the heat-prioritized file was read first.
    let heat = mari_core::load_heat(&store, &computer)
        .await
        .unwrap()
        .expect("heat profile must be written after restore");
    assert_eq!(
        heat.paths.first().map(String::as_str),
        Some("/z_last.txt"),
        "restore must read the heat-prioritized file first"
    );
    assert!(heat.paths.contains(&"/a.txt".to_string()));

    sup.abort();
}

// ---------------------------------------------------------------------------
// 6b. Spawn failure and the write-argv log leak.
//
// A run whose process cannot be spawned (E2BIG from an oversized argv element,
// ENOENT from a missing binary) must fail THAT RUN with a terminal RunCompleted
// — never wedge or kill the daemon — and no argv payload may ever reach a log
// line (decisions appendix: 1,063,564 bytes of base64 in docker logs).
// ---------------------------------------------------------------------------

/// Log capture: a process-global tracing subscriber writing into a shared
/// buffer. Global (not thread-scoped `with_default`) because the supervisor
/// logs from spawned tasks on other worker threads. Installed once; every test
/// in this process shares it, and only these tests assert on it.
fn install_log_capture() -> Arc<std::sync::Mutex<Vec<u8>>> {
    static LOG_BUF: std::sync::OnceLock<Arc<std::sync::Mutex<Vec<u8>>>> =
        std::sync::OnceLock::new();
    LOG_BUF
        .get_or_init(|| {
            let buf: Arc<std::sync::Mutex<Vec<u8>>> = Arc::new(std::sync::Mutex::new(Vec::new()));
            struct CaptureWriter(Arc<std::sync::Mutex<Vec<u8>>>);
            impl std::io::Write for CaptureWriter {
                fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                    self.0.lock().unwrap().extend_from_slice(b);
                    Ok(b.len())
                }
                fn flush(&mut self) -> std::io::Result<()> {
                    Ok(())
                }
            }
            let writer_buf = buf.clone();
            let subscriber = tracing_subscriber::fmt()
                .with_max_level(tracing::Level::DEBUG)
                .with_ansi(false)
                .with_writer(move || CaptureWriter(writer_buf.clone()))
                .finish();
            let _ = tracing::subscriber::set_global_default(subscriber);
            buf.clone()
        })
        .clone()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn huge_argv_never_reaches_logs_and_spawn_failure_fails_only_that_run() {
    let logs = install_log_capture();

    let cp = FakeControlPlane::start().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let config = ws_config(&cp, root.path(), store_dir.path());
    let sup = tokio::spawn(crate::run(config));

    assert!(
        cp.wait_until(Duration::from_secs(5), |s| !s.hellos.is_empty())
            .await,
        "supervisor must connect and handshake"
    );

    // An argv element far past Linux's MAX_ARG_STRLEN (131072): exec fails with
    // E2BIG. The canary sits at the END of the payload, past any bounded
    // prefix a redacted log line may legitimately show.
    let canary = "MARI-LEAK-CANARY-7f3e2a91";
    let payload = format!("{}{canary}", "A".repeat(200_000));
    let run = RunId::new("run-e2big");
    cp.queue_control(ControlMessage::StartRun {
        run: run.clone(),
        argv: vec!["/bin/echo".into(), payload],
        env_names: vec![],
        cwd: root.path().to_str().unwrap().to_string(),
    });

    // The run — not the daemon — fails, with a terminal completion event.
    // E2BIG surfaces in one of two shapes depending on where exec fails:
    // portable-pty's pre_exec closes std's exec-error pipe, so the kernel may
    // report it as a post-fork child abort (Signaled) rather than a spawn error
    // (Exited 127). Either way the contract holds: a terminal, non-success
    // completion for THIS run, and a daemon that keeps serving.
    assert!(
        cp.wait_until(Duration::from_secs(10), |s| s
            .run_completed
            .iter()
            .any(|(r, exit, ..)| *r == run && *exit != ExitStatus::Exited { code: 0 }))
            .await,
        "an unspawnable run must complete with a failure status"
    );

    // The daemon lives: a subsequent normal run on the SAME connection works
    // end to end (journal bytes and a clean completion).
    let run2 = RunId::new("run-after-e2big");
    let marker = "STILL-ALIVE-AFTER-E2BIG";
    cp.queue_control(ControlMessage::StartRun {
        run: run2.clone(),
        argv: vec!["sh".into(), "-c".into(), format!("printf '{marker}'")],
        env_names: vec![],
        cwd: root.path().to_str().unwrap().to_string(),
    });
    assert!(
        cp.wait_until(Duration::from_secs(10), |s| {
            journal_has(s, &run2, marker.as_bytes())
                && s.run_completed
                    .iter()
                    .any(|(r, exit, ..)| *r == run2 && *exit == ExitStatus::Exited { code: 0 })
        })
        .await,
        "a run after the spawn failure must work normally"
    );
    cp.with_state(|s| {
        assert_eq!(
            s.connections, 1,
            "the daemon must not have crashed or reconnected"
        );
        assert!(s.errors.is_empty(), "journal errors: {:?}", s.errors);
    });

    // The log leak: no fragment of the argv payload may appear in any log line.
    let captured = String::from_utf8_lossy(&logs.lock().unwrap()).into_owned();
    assert!(
        !captured.contains(canary),
        "argv payload leaked into logs (canary found)"
    );
    assert!(
        !captured.contains(&"A".repeat(1024)),
        "argv payload leaked into logs (1KiB of payload found)"
    );
    // The redacted line still tells an operator what happened: the run id and
    // the argv's shape (count + total bytes), never its content.
    assert!(
        captured.contains("run-e2big") && captured.contains("2 args"),
        "the redacted start_run line (run id + arg count) must be logged"
    );

    sup.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn missing_binary_fails_run_with_completion_and_daemon_survives() {
    let cp = FakeControlPlane::start().await.unwrap();
    let root = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let config = ws_config(&cp, root.path(), store_dir.path());
    let sup = tokio::spawn(crate::run(config));

    assert!(
        cp.wait_until(Duration::from_secs(5), |s| !s.hellos.is_empty())
            .await,
        "supervisor must connect and handshake"
    );

    let run = RunId::new("run-enoent");
    cp.queue_control(ControlMessage::StartRun {
        run: run.clone(),
        argv: vec!["/nonexistent/mari-no-such-binary".into()],
        env_names: vec![],
        cwd: root.path().to_str().unwrap().to_string(),
    });
    assert!(
        cp.wait_until(Duration::from_secs(10), |s| s
            .run_completed
            .iter()
            .any(|(r, exit, ..)| *r == run && *exit == ExitStatus::Exited { code: 127 }))
            .await,
        "a missing binary must fail the run with exit 127, not the daemon"
    );

    // A pre-run snapshot was still reported (the run had a baseline), and the
    // next run works.
    cp.with_state(|s| {
        assert!(
            s.snapshots
                .iter()
                .any(|(_, _, reason)| *reason == SnapshotReason::PreRun),
            "the failed run still reports its pre-run snapshot"
        );
    });
    let run2 = RunId::new("run-after-enoent");
    cp.queue_control(ControlMessage::StartRun {
        run: run2.clone(),
        argv: vec!["sh".into(), "-c".into(), "printf OK-ENOENT".into()],
        env_names: vec![],
        cwd: root.path().to_str().unwrap().to_string(),
    });
    assert!(
        cp.wait_until(Duration::from_secs(10), |s| journal_has(
            s,
            &run2,
            b"OK-ENOENT"
        ))
        .await,
        "the daemon must keep serving runs after a spawn failure"
    );
    cp.with_state(|s| assert_eq!(s.connections, 1, "no crash, no reconnect"));

    sup.abort();
}

// ---------------------------------------------------------------------------
// 7. store URI parsing.
// ---------------------------------------------------------------------------

#[test]
fn store_uri_fs_scheme_parses() {
    let tmp = tempfile::tempdir().unwrap();
    let path: PathBuf = tmp.path().join("s");
    let uri = format!("fs://{}", path.display());
    let store = crate::store_uri::open_store(&uri).unwrap();
    // A round-trip through the opened store proves it points at a usable backend.
    let _ = store; // opening alone creates the directory.
    assert!(path.exists(), "fs store directory must be created");
}

#[test]
fn store_uri_unknown_scheme_errors() {
    assert!(crate::store_uri::open_store("gopher://nope").is_err());
}
