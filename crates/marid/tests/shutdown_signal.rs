//! Graceful shutdown on SIGTERM, proven against a real `marid` process.
//!
//! Why this matters more than it looks: on a substrate where eviction is routine
//! and the disk is wiped on every stop — Cloudflare Containers, which send
//! SIGTERM and then take the instance away — the signal is the *only* warning a
//! computer gets that its filesystem is about to cease existing. Spec 4.5 says
//! the supervisor stops each session cleanly and Mari writes a manifest before
//! the transition; if marid ignores SIGTERM, none of that happens, and with
//! `containers_pid_namespace` on it is not even killed (a probe confirmed the
//! container surviving both `kill -TERM 1` and `kill -KILL 1` from inside), so
//! the whole ~15-minute grace window is spent doing nothing before the disk goes.
//!
//! A test that asserts "a handler is registered" proves nothing, so these tests
//! spawn the real binary as a child process, start a real run on a real PTY, send
//! it a real signal, and then read the chunk store to see whether the run's bytes
//! survived:
//!
//! 1. [`sigterm_writes_a_final_manifest_containing_the_runs_bytes`] — the run's
//!    file content is restored byte-for-byte out of the final manifest, the run
//!    was stopped cleanly (`RunCompleted`), its journal segments are in the store,
//!    the head advanced under the supervisor's epoch, and the process exits 0
//!    inside the deadline.
//! 2. [`sigterm_is_bounded_even_when_a_run_refuses_to_die`] — a run that ignores
//!    the clean stop cannot consume the eviction window: the manifest is written
//!    anyway and the process still exits within the grace budget.

mod common;

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use mari_core::{ChunkStore, ManifestId, RestoreOptions, restore};
use mari_proto::{ControlMessage, Epoch, RunId, SnapshotReason};

use common::FakeCp;

/// Deterministic shell-safe bytes, so the run's output is known exactly.
fn known_blob(len: usize, seed: u32) -> Vec<u8> {
    (0..len)
        .map(|i| {
            let n = ((i as u32)
                .wrapping_mul(2_654_435_761)
                .wrapping_add(seed.wrapping_mul(40_503))
                % 62) as u8;
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

/// Spawn the real `marid` binary against `cp`, with `root` as the computer
/// filesystem and `store` as the chunk store.
#[allow(clippy::too_many_arguments)]
fn spawn_marid(
    cp: &FakeCp,
    computer: &str,
    root: &Path,
    store: &Path,
    epoch: u64,
    grace_ms: u64,
) -> Child {
    Command::new(env!("CARGO_BIN_EXE_marid"))
        .env("MARI_COMPUTER_ID", computer)
        // Loopback, so the scheme policy allows plaintext (`ws::classify_control_url`).
        .env("MARI_CONTROL_URL", format!("ws://127.0.0.1:{}/", cp.port()))
        .env("MARI_TOKEN", "sigterm-token")
        .env("MARI_EPOCH", epoch.to_string())
        .env("MARI_ROOT", root)
        .env("MARI_STORE", format!("fs://{}", store.display()))
        .env("MARI_SNAPSHOT_INTERVAL", "3600")
        .env("MARI_ATTENTION_SILENCE_MS", "600000")
        // Small segments, so a short run still produces store segments to check.
        .env("MARI_SEGMENT_BYTES", "256")
        .env("MARI_SHUTDOWN_GRACE_MS", grace_ms.to_string())
        .env("MARI_AGENTS_DIR", root.join("agents.d"))
        .env("RUST_LOG", "info,marid=debug")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn the marid binary")
}

/// Send a signal to a child by name (no libc dependency needed for a test).
fn signal_child(child: &Child, signal: &str) {
    let pid = child.id().to_string();
    let status = Command::new("kill")
        .args([&format!("-{signal}"), &pid])
        .status()
        .expect("spawn kill");
    assert!(status.success(), "kill -{signal} {pid} failed: {status:?}");
}

/// Wait up to `timeout` for the child to exit, returning its status.
fn wait_for_exit(child: &mut Child, timeout: Duration) -> Option<std::process::ExitStatus> {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait().expect("try_wait") {
            Some(status) => return Some(status),
            None if Instant::now() >= deadline => return None,
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

/// Kill and reap a child, then return everything it wrote to stderr (the log).
fn reap_with_logs(mut child: Child) -> String {
    let _ = child.kill();
    let out = child.wait_with_output().expect("collect child output");
    String::from_utf8_lossy(&out.stderr).into_owned()
}

/// The store's journal segments for a run, reassembled in sequence order.
fn store_segments(store_dir: &Path, computer: &str, run: &str) -> Vec<u8> {
    let dir = store_dir.join("journal").join(computer).join(run);
    let mut names: Vec<PathBuf> = match std::fs::read_dir(&dir) {
        Ok(rd) => rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "seg"))
            .collect(),
        Err(_) => return Vec::new(),
    };
    names.sort();
    let mut out = Vec::new();
    for p in names {
        out.extend_from_slice(&std::fs::read(&p).unwrap());
    }
    out
}

// ---------------------------------------------------------------------------
// 1. The signal does the whole durability duty.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sigterm_writes_a_final_manifest_containing_the_runs_bytes() {
    let cp = FakeCp::start().await.expect("bind fake control plane");
    let root_dir = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let root = root_dir.path();
    let store_path = store_dir.path();
    let computer = "comp-sigterm";
    let epoch = 3u64;

    // Pre-existing content, so the final manifest has to carry both what was
    // already there and what the run produced.
    let base = known_blob(700, 11);
    std::fs::write(root.join("base.txt"), &base).unwrap();

    let mut child = spawn_marid(&cp, computer, root, store_path, epoch, 20_000);

    let connected = cp
        .wait_until(Duration::from_secs(30), |s| !s.hellos.is_empty())
        .await;
    if !connected {
        panic!("marid did not connect:\n{}", reap_with_logs(child));
    }
    let conn = cp.with_state(|s| s.hellos[0].conn);

    // A run that writes known bytes into the tree and then keeps going, so the
    // signal arrives with the run genuinely in flight.
    let produced = known_blob(900, 12);
    let produced_str = String::from_utf8(produced.clone()).unwrap();
    let run = RunId::new("run-sigterm");
    let script = format!(
        "printf '%s' '{produced_str}' > run-output.txt; \
         printf 'RUN-ALIVE'; while :; do sleep 0.2; printf '.'; done"
    );
    cp.queue_to(
        conn,
        ControlMessage::StartRun {
            run: run.clone(),
            argv: vec!["/bin/sh".into(), "-c".into(), script],
            env_names: vec![],
            cwd: root.to_str().unwrap().to_string(),
        },
    );

    // Wait until the run is genuinely live: its journal is flowing AND its file
    // is on disk. Signalling before that would prove nothing about a live run.
    let live = cp
        .wait_until(Duration::from_secs(30), |s| {
            s.journal(&run).windows(9).any(|w| w == b"RUN-ALIVE")
        })
        .await;
    if !live {
        panic!("the run never produced output:\n{}", reap_with_logs(child));
    }
    assert_eq!(
        std::fs::read(root.join("run-output.txt")).unwrap(),
        produced,
        "the run must have written its file before the signal"
    );

    // --- the signal ---
    let snapshots_before = cp.with_state(|s| s.snapshots.len());
    let sent_at = Instant::now();
    signal_child(&child, "TERM");

    let status = match wait_for_exit(&mut child, Duration::from_secs(30)) {
        Some(s) => s,
        None => panic!(
            "marid did not exit within 30s of SIGTERM:\n{}",
            reap_with_logs(child)
        ),
    };
    let shutdown_took = sent_at.elapsed();
    let logs = reap_with_logs(child);

    assert!(
        status.success(),
        "a graceful shutdown must exit 0, got {status:?}\n{logs}"
    );
    assert!(
        shutdown_took < Duration::from_secs(20),
        "shutdown took {shutdown_took:?}, beyond its own grace budget\n{logs}"
    );

    // --- the control plane saw the whole sequence ---
    let final_manifest: ManifestId = cp
        .with_state(|s| {
            s.snapshots[snapshots_before..]
                .iter()
                .rev()
                .find(|(_, _, reason)| *reason == SnapshotReason::Final)
                .map(|(m, _, _)| m.clone())
        })
        .unwrap_or_else(|| {
            panic!("no final snapshot was reported after SIGTERM\n{logs}");
        });
    cp.with_state(|s| {
        let (_, epoch_reported, _) = s.snapshots[snapshots_before..]
            .iter()
            .rev()
            .find(|(_, _, r)| *r == SnapshotReason::Final)
            .unwrap();
        assert_eq!(
            *epoch_reported,
            Epoch::new(epoch),
            "the final snapshot must be reported under the supervisor's epoch"
        );
        // Spec 4.5: each run is stopped in a clean state — which means a real
        // completion event, not a run dropped on the floor.
        assert!(
            s.completion(&run).is_some(),
            "the in-flight run must have been stopped cleanly (RunCompleted)\n{logs}"
        );
        // The head advanced to the final manifest under our epoch.
        assert_eq!(
            s.head.as_ref(),
            Some(&final_manifest),
            "the head must advance to the final manifest\n{logs}"
        );
        assert!(
            s.advances(epoch, true)
                .iter()
                .any(|a| a.manifest == final_manifest),
            "the final head advance must be accepted under epoch {epoch}\n{logs}"
        );
        assert!(s.errors.is_empty(), "journal integrity: {:?}", s.errors);
    });

    // --- and, the point of the whole exercise: the bytes are in the store ---
    let store = ChunkStore::open_fs(store_path).expect("open the chunk store");
    let manifest = store
        .get_manifest(&final_manifest)
        .await
        .expect("the final manifest must exist in the chunk store");
    let restored = tempfile::tempdir().unwrap();
    restore(
        &store,
        &manifest,
        restored.path(),
        &RestoreOptions::default(),
    )
    .await
    .expect("the final manifest must restore");
    assert_eq!(
        std::fs::read(restored.path().join("run-output.txt")).unwrap(),
        produced,
        "the final manifest must carry the run's bytes byte-for-byte — without \
         this, a SIGTERM on a substrate that wipes the disk is silent data loss"
    );
    assert_eq!(
        std::fs::read(restored.path().join("base.txt")).unwrap(),
        base,
        "the final manifest must carry the pre-existing tree too"
    );

    // The journal reached the store as well (spec 4.2's local-then-store path):
    // the segments reassemble to a prefix of what the control plane received.
    let segments = store_segments(store_path, computer, run.as_str());
    let live_journal = cp.with_state(|s| s.journal(&run));
    assert!(
        !segments.is_empty(),
        "the shutdown must flush the run's journal segments to the store\n{logs}"
    );
    assert!(
        live_journal.starts_with(&segments),
        "stored journal segments ({} bytes) must be a prefix of the journal the \
         control plane received ({} bytes)",
        segments.len(),
        live_journal.len()
    );

    // The log names each stage, so an operator can see where a shutdown stalled.
    for stage in [
        "shutdown signal received",
        "shutdown: stopping runs",
        "shutdown: journal segments flushed",
        "shutdown: final manifest written",
    ] {
        assert!(
            logs.contains(stage),
            "the shutdown log must report the {stage:?} stage; log was:\n{logs}"
        );
    }
}

// ---------------------------------------------------------------------------
// 2. A run that will not die cannot eat the eviction window.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sigterm_is_bounded_even_when_a_run_refuses_to_die() {
    let cp = FakeCp::start().await.expect("bind fake control plane");
    let root_dir = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let root = root_dir.path();
    let store_path = store_dir.path();
    let computer = "comp-sigterm-stuck";
    // A deliberately tight budget: the stop phase gets a third of it (2 s) and
    // the manifest write gets the rest.
    let grace_ms = 6_000;

    let mut child = spawn_marid(&cp, computer, root, store_path, 1, grace_ms);
    let connected = cp
        .wait_until(Duration::from_secs(30), |s| !s.hellos.is_empty())
        .await;
    if !connected {
        panic!("marid did not connect:\n{}", reap_with_logs(child));
    }
    let conn = cp.with_state(|s| s.hellos[0].conn);

    // `trap '' HUP` makes the run ignore the clean stop marid sends (portable-pty
    // signals SIGHUP through the tty). It writes its file first, then refuses to
    // leave — bounded at ~30 s so a failing test cannot leak a forever-process.
    let produced = known_blob(500, 21);
    let produced_str = String::from_utf8(produced.clone()).unwrap();
    let run = RunId::new("run-stuck");
    let script = format!(
        "trap '' HUP; printf '%s' '{produced_str}' > stuck-output.txt; \
         printf 'STUCK-ALIVE'; i=0; while [ $i -lt 60 ]; do sleep 0.5; i=$((i+1)); done"
    );
    cp.queue_to(
        conn,
        ControlMessage::StartRun {
            run: run.clone(),
            argv: vec!["/bin/sh".into(), "-c".into(), script],
            env_names: vec![],
            cwd: root.to_str().unwrap().to_string(),
        },
    );
    let live = cp
        .wait_until(Duration::from_secs(30), |s| {
            s.journal(&run).windows(11).any(|w| w == b"STUCK-ALIVE")
        })
        .await;
    if !live {
        panic!("the stuck run never started:\n{}", reap_with_logs(child));
    }

    let sent_at = Instant::now();
    signal_child(&child, "TERM");
    let status = match wait_for_exit(&mut child, Duration::from_secs(30)) {
        Some(s) => s,
        None => panic!(
            "marid hung on a run that refuses to die — the shutdown is NOT bounded:\n{}",
            reap_with_logs(child)
        ),
    };
    let took = sent_at.elapsed();
    let logs = reap_with_logs(child);

    assert!(
        status.success(),
        "shutdown must exit 0, got {status:?}\n{logs}"
    );
    // The bound: the whole sequence fits in the grace budget plus process-exit
    // slack, even though the run never stopped.
    assert!(
        took < Duration::from_millis(grace_ms) + Duration::from_secs(4),
        "an unstoppable run made the shutdown take {took:?}, past the {grace_ms}ms \
         budget — a substrate's eviction window would have expired\n{logs}"
    );
    assert!(
        logs.contains("runs still active at the stop deadline"),
        "the log must say the stop deadline was hit (that is the bound doing its \
         job); log was:\n{logs}"
    );

    // And the manifest was still written, with the run's bytes in it. This is the
    // whole point of bounding the stop: a run that will not die must not cost the
    // computer its filesystem.
    let final_manifest = cp
        .with_state(|s| {
            s.snapshots
                .iter()
                .rev()
                .find(|(_, _, r)| *r == SnapshotReason::Final)
                .map(|(m, _, _)| m.clone())
        })
        .unwrap_or_else(|| panic!("no final snapshot after SIGTERM\n{logs}"));
    let store = ChunkStore::open_fs(store_path).unwrap();
    let manifest = store.get_manifest(&final_manifest).await.unwrap();
    let restored = tempfile::tempdir().unwrap();
    restore(
        &store,
        &manifest,
        restored.path(),
        &RestoreOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(restored.path().join("stuck-output.txt")).unwrap(),
        produced,
        "the final manifest must hold the stuck run's bytes"
    );
}

// ---------------------------------------------------------------------------
// 3. SIGINT is the same duty (a private instance in a terminal, Ctrl-C).
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn sigint_also_writes_the_final_manifest() {
    let cp = FakeCp::start().await.expect("bind fake control plane");
    let root_dir = tempfile::tempdir().unwrap();
    let store_dir = tempfile::tempdir().unwrap();
    let root = root_dir.path();
    let store_path = store_dir.path();
    let payload = known_blob(300, 31);
    std::fs::write(root.join("ctrl-c.txt"), &payload).unwrap();

    let mut child = spawn_marid(&cp, "comp-sigint", root, store_path, 1, 10_000);
    let connected = cp
        .wait_until(Duration::from_secs(30), |s| !s.hellos.is_empty())
        .await;
    if !connected {
        panic!("marid did not connect:\n{}", reap_with_logs(child));
    }

    signal_child(&child, "INT");
    let status = match wait_for_exit(&mut child, Duration::from_secs(30)) {
        Some(s) => s,
        None => panic!("marid ignored SIGINT:\n{}", reap_with_logs(child)),
    };
    let logs = reap_with_logs(child);
    assert!(
        status.success(),
        "SIGINT must exit 0, got {status:?}\n{logs}"
    );
    assert!(
        logs.contains("SIGINT"),
        "the log must name the signal it acted on:\n{logs}"
    );

    let final_manifest = cp
        .with_state(|s| {
            s.snapshots
                .iter()
                .rev()
                .find(|(_, _, r)| *r == SnapshotReason::Final)
                .map(|(m, _, _)| m.clone())
        })
        .unwrap_or_else(|| panic!("no final snapshot after SIGINT\n{logs}"));
    let store = ChunkStore::open_fs(store_path).unwrap();
    let manifest = store.get_manifest(&final_manifest).await.unwrap();
    let restored = tempfile::tempdir().unwrap();
    restore(
        &store,
        &manifest,
        restored.path(),
        &RestoreOptions::default(),
    )
    .await
    .unwrap();
    assert_eq!(
        std::fs::read(restored.path().join("ctrl-c.txt")).unwrap(),
        payload
    );
}
