//! Startup continuation with teeth: unfinished runs (spec 5.6) and WARM
//! rollback (spec 4.7).
//!
//! Every test here drives the **real daemon** ([`crate::run`]) against the real
//! fake control plane over the real framed-CBOR wire, with a real chunk store on
//! disk. Nothing is stubbed: a resumed run is a real child process on a real
//! PTY, and the proof that it saw the resume argv is a file that process wrote.
//!
//! The state each test constructs is the state a dead supervisor would have left
//! behind: run records and a head history in the store, journal segments on the
//! disk, and a control plane holding some prefix of the journal.

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mari_core::{ChunkStore, SnapshotOptions, snapshot};
use mari_proto::{AttentionKind, ComputerId, Epoch, ManifestId, RunId};

use crate::config::Config;
use crate::journal::Journal;
use crate::state::{DurableState, RunPhase, RunRecord};
use crate::supervisor::mari_excludes;
use crate::testkit::FakeControlPlane;

/// The computer every test in this file supervises.
const COMPUTER: &str = "comp-cont";
/// The wake epoch the supervisor runs under.
const EPOCH: u64 = 6;

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

fn snap_opts() -> SnapshotOptions {
    SnapshotOptions {
        exclude: mari_excludes(),
        created_at: 1,
        ..SnapshotOptions::default()
    }
}

fn config(cp: &FakeControlPlane, root: &Path, store_root: &Path, agents_dir: &Path) -> Config {
    Config {
        computer_id: COMPUTER.into(),
        control_url: cp.url().to_string(),
        token: "tok".into(),
        epoch: EPOCH,
        root: root.to_path_buf(),
        store: format!("fs://{}", store_root.display()),
        snapshot_interval_secs: 3600,
        // Long enough that no blocked-read event can be confused with the
        // interrupted events these tests assert on.
        attention_silence_ms: 600_000,
        restore_manifest: None,
        agents_dir: agents_dir.to_path_buf(),
        segment_bytes: 4 * 1024 * 1024,
        allow_insecure_ws: false,
        // Not what these tests are about; `tests_keepalive` covers the keepalive.
        keepalive_ms: 0,
        idle_timeout_ms: 0,
        shutdown_grace_ms: 5_000,
    }
}

/// The local journal directory the supervisor uses for a run.
fn journal_dir(root: &Path, run: &RunId) -> PathBuf {
    root.join(".mari").join("journal").join(run.as_str())
}

/// Write a journal segment exactly where a previous supervisor life would have
/// left it: a local `.seg` file on the disk and the same bytes in the store.
async fn seed_segment(store: &ChunkStore, root: &Path, run: &RunId, seq: u64, bytes: &[u8]) {
    let dir = journal_dir(root, run);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join(format!("{seq:08}.seg")), bytes).unwrap();
    let key = Journal::segment_key(&ComputerId::new(COMPUTER), run, seq);
    store.operator().write(&key, bytes.to_vec()).await.unwrap();
}

/// A shell script that records the argv it was invoked with (proof the process
/// really saw it) and then prints `output` to its PTY.
///
/// The marker is written to a scratch file and *renamed* into place, so it only
/// ever appears complete — a reader that sees the path sees the whole argv.
fn argv_recording_script(dir: &Path, name: &str, output: &str) -> (PathBuf, PathBuf) {
    let marker = dir.join(format!("{name}.argv"));
    let script = dir.join(format!("{name}.sh"));
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{m}.partial'\nmv '{m}.partial' '{m}'\nprintf '{output}'\n",
            m = marker.display()
        ),
    )
    .unwrap();
    (script, marker)
}

async fn wait_for_file(path: &Path, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if path.exists() {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Poll a durable run record until it reaches `phase`.
async fn wait_for_phase(
    state: &DurableState,
    run: &RunId,
    phase: RunPhase,
    timeout: Duration,
) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(r)) = state.get_run(run).await
            && r.phase == phase
        {
            return true;
        }
        if Instant::now() >= deadline {
            return false;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[allow(clippy::too_many_arguments)]
fn unfinished_record(
    run: &RunId,
    argv: &[&str],
    cwd: &Path,
    adapter: Option<&str>,
    pre: &ManifestId,
    journal_len: u64,
    next_seq: u64,
) -> RunRecord {
    let mut record = RunRecord::new(
        run.clone(),
        argv.iter().map(|s| s.to_string()).collect(),
        vec![],
        cwd.to_string_lossy().to_string(),
        adapter.map(str::to_string),
        pre.clone(),
        Epoch::new(EPOCH - 1),
        1,
    );
    record.journal_len = journal_len;
    record.next_seq = next_seq;
    record.phase = RunPhase::Running;
    record
}

/// Attention events observed for one run.
fn attentions_for(cp: &FakeControlPlane, run: &RunId) -> Vec<AttentionKind> {
    cp.with_state(|s| {
        s.attentions
            .iter()
            .filter(|(r, _)| r == run)
            .map(|(_, k)| *k)
            .collect()
    })
}

// ---------------------------------------------------------------------------
// 1. spec 5.6 — an unfinished run whose adapter declares a resume is continued.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_resumes_an_unfinished_run_with_the_adapters_resume_command() {
    let root = tempfile::tempdir().unwrap();
    let store_root = tempfile::tempdir().unwrap();
    let agents = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(store_root.path()).unwrap();
    let state = DurableState::new(store.clone(), ComputerId::new(COMPUTER), Epoch::new(EPOCH));
    let run = RunId::new("run-resumable");

    // The tree as the dead supervisor left it, and the head it had recorded for
    // exactly that tree: a healthy restart, NOT a rollback.
    std::fs::write(root.path().join("work.txt"), b"in progress").unwrap();
    let head = snapshot(&store, root.path(), &snap_opts()).await.unwrap();
    state
        .record_head(&head.manifest_id, Epoch::new(EPOCH - 1))
        .await
        .unwrap();

    // 50 journal bytes the run had already produced, durable on disk and in the
    // store, and held by the control plane.
    let earlier: Vec<u8> = (0..50u8).map(|i| b'a' + (i % 26)).collect();
    seed_segment(&store, root.path(), &run, 0, &earlier).await;

    // The agent: a resume command that records the argv it is given.
    let (script, marker) = argv_recording_script(scratch.path(), "resume", "RESUMED-OUTPUT");
    std::fs::write(
        agents.path().join("mytool.toml"),
        format!(
            "name = \"mytool\"\ncommand = [\"mytool\"]\nresume = [\"sh\", \"{}\", \"--resume\", \"{{run}}\", \"{{journal}}\"]\n",
            script.display()
        ),
    )
    .unwrap();

    let record = unfinished_record(
        &run,
        &["mytool", "--task", "write-the-thing"],
        root.path(),
        Some("mytool"),
        &head.manifest_id,
        earlier.len() as u64,
        1,
    );
    state.put_run(&record).await.unwrap();

    let cp = FakeControlPlane::start().await.unwrap();
    cp.seed_journal(&run, &earlier);
    let sup = tokio::spawn(crate::run(config(
        &cp,
        root.path(),
        store_root.path(),
        agents.path(),
    )));

    // The resume command really ran, and really saw the resume argv.
    assert!(
        wait_for_file(&marker, Duration::from_secs(30)).await,
        "the adapter's resume command must be spawned after a restart"
    );
    let argv_seen = std::fs::read_to_string(&marker).unwrap();
    let argv_lines: Vec<&str> = argv_seen.lines().collect();
    assert_eq!(
        argv_lines,
        vec![
            "--resume",
            run.as_str(),
            journal_dir(root.path(), &run).to_string_lossy().as_ref(),
        ],
        "the resumed process must receive the substituted resume argv \
         ({{run}} and {{journal}}), and nothing else"
    );

    // The run kept its identity: same run id, same pre-run manifest baseline.
    assert!(
        cp.wait_until(Duration::from_secs(10), |s| s
            .run_started
            .iter()
            .any(|(r, m)| *r == run && *m == head.manifest_id))
            .await,
        "a resumed run is the same run: it reports the original pre-run manifest"
    );

    // And its journal CONTINUED: the resumed output lands at offset 50, right
    // after the bytes the control plane already held. A restart at 0 would be a
    // duplicate mismatch here, and a jump past 50 a gap.
    let mut expected = earlier.clone();
    expected.extend_from_slice(b"RESUMED-OUTPUT");
    assert!(
        cp.wait_until(Duration::from_secs(30), |s| s
            .journals
            .get(&run)
            .map(|r| r.buf == expected)
            .unwrap_or(false))
            .await,
        "the resumed run's journal must continue the earlier one exactly; got {:?}",
        String::from_utf8_lossy(&cp.reassembled(&run))
    );
    cp.with_state(|s| assert!(s.errors.is_empty(), "journal errors: {:?}", s.errors));

    // A healthy restart is not a rollback, and a resumed run is not interrupted.
    cp.with_state(|s| {
        assert!(
            s.rollbacks.is_empty(),
            "a disk that matches the recorded head must not be reported as rolled back: {:?}",
            s.rollbacks
        );
    });
    assert!(
        attentions_for(&cp, &run).is_empty(),
        "a run that was successfully resumed raises no attention"
    );

    // The resumed process exited, so the run is now finished for good.
    assert!(
        wait_for_phase(&state, &run, RunPhase::Completed, Duration::from_secs(30)).await,
        "the record must end Completed once the resumed process exits"
    );

    sup.abort();
}

// ---------------------------------------------------------------------------
// 2. spec 5.6 degradation — no adapter, or an adapter with no resume template:
//    interrupted, journal preserved, exactly one content-free attention event.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn restart_interrupts_runs_that_cannot_be_resumed_and_preserves_their_journals() {
    let root = tempfile::tempdir().unwrap();
    let store_root = tempfile::tempdir().unwrap();
    let agents = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(store_root.path()).unwrap();
    let state = DurableState::new(store.clone(), ComputerId::new(COMPUTER), Epoch::new(EPOCH));
    let orphan = RunId::new("run-orphan"); // no adapter at all
    let noresume = RunId::new("run-noresume"); // adapter, but it has no resume

    std::fs::write(root.path().join("work.txt"), b"in progress").unwrap();
    let head = snapshot(&store, root.path(), &snap_opts()).await.unwrap();
    state
        .record_head(&head.manifest_id, Epoch::new(EPOCH - 1))
        .await
        .unwrap();

    // An adapter that declares NO resume function: the honest common case.
    std::fs::write(
        agents.path().join("plain.toml"),
        "name = \"plain\"\ncommand = [\"plain-agent\"]\n",
    )
    .unwrap();

    let journal_bytes = b"partial output before the crash";
    for run in [&orphan, &noresume] {
        seed_segment(&store, root.path(), run, 0, journal_bytes).await;
    }
    state
        .put_run(&unfinished_record(
            &orphan,
            &["some-unmanaged-binary", "--go"],
            root.path(),
            None,
            &head.manifest_id,
            journal_bytes.len() as u64,
            1,
        ))
        .await
        .unwrap();
    state
        .put_run(&unfinished_record(
            &noresume,
            &["plain-agent"],
            root.path(),
            Some("plain"),
            &head.manifest_id,
            journal_bytes.len() as u64,
            1,
        ))
        .await
        .unwrap();

    let cp = FakeControlPlane::start().await.unwrap();
    let sup = tokio::spawn(crate::run(config(
        &cp,
        root.path(),
        store_root.path(),
        agents.path(),
    )));

    assert!(
        cp.wait_until(Duration::from_secs(30), |s| s.attentions.len() >= 2)
            .await,
        "each run that cannot be continued must raise an attention event"
    );
    // Give the pass a moment past the second event, so a spurious third (or a
    // sneaky respawn) would be visible rather than merely not-yet-arrived.
    tokio::time::sleep(Duration::from_millis(300)).await;

    assert_eq!(
        attentions_for(&cp, &orphan),
        vec![AttentionKind::Interrupted],
        "a run with no adapter is interrupted exactly once"
    );
    assert_eq!(
        attentions_for(&cp, &noresume),
        vec![AttentionKind::Interrupted],
        "a run whose adapter declares no resume is interrupted exactly once"
    );
    cp.with_state(|s| {
        assert!(
            s.run_started.is_empty(),
            "nothing may be spawned for a run that cannot be resumed: {:?}",
            s.run_started
        );
        assert!(s.rollbacks.is_empty(), "this is not a rollback");
    });

    for run in [&orphan, &noresume] {
        // The journal is preserved, byte for byte, on the disk and in the store.
        let seg = journal_dir(root.path(), run).join("00000000.seg");
        assert_eq!(
            std::fs::read(&seg).unwrap(),
            journal_bytes,
            "an interrupted run's journal must be left exactly as it was"
        );
        let key = Journal::segment_key(&ComputerId::new(COMPUTER), run, 0);
        assert_eq!(
            store.operator().read(&key).await.unwrap().to_vec(),
            journal_bytes
        );
        // And the record says interrupted — not completed, not still running.
        let record = state.get_run(run).await.unwrap().expect("record survives");
        assert_eq!(record.phase, RunPhase::Interrupted);
        assert_eq!(
            record.journal_len,
            journal_bytes.len() as u64,
            "the recorded journal head must not move when a run is interrupted"
        );
    }

    sup.abort();
}

// ---------------------------------------------------------------------------
// 3. spec 4.7 — the disk lost journal bytes the store recorded: report it, do
//    NOT replay (the default), interrupt instead.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn warm_rollback_that_lost_journal_bytes_is_reported_and_not_replayed() {
    let root = tempfile::tempdir().unwrap();
    let store_root = tempfile::tempdir().unwrap();
    let agents = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(store_root.path()).unwrap();
    let state = DurableState::new(store.clone(), ComputerId::new(COMPUTER), Epoch::new(EPOCH));
    let run = RunId::new("run-lost");

    std::fs::write(root.path().join("a.txt"), b"one").unwrap();
    std::fs::write(root.path().join("b.txt"), b"two").unwrap();
    let head = snapshot(&store, root.path(), &snap_opts()).await.unwrap();
    state
        .record_head(&head.manifest_id, Epoch::new(EPOCH - 1))
        .await
        .unwrap();

    // The rollback's signature: the store records 40 durable journal bytes for
    // the run, but the restored disk carries only the first 10 of them.
    let survived = b"0123456789";
    seed_segment(&store, root.path(), &run, 0, survived).await;
    let cp = FakeControlPlane::start().await.unwrap();
    cp.seed_journal(&run, &[b'x'; 40]);

    // The run's adapter DOES declare a resume. A rollback still wins: the run's
    // world moved under it, so continuing where it left off is not on the table.
    let (script, marker) = argv_recording_script(scratch.path(), "resume", "SHOULD-NOT-RUN");
    std::fs::write(
        agents.path().join("mytool.toml"),
        format!(
            "name = \"mytool\"\ncommand = [\"mytool\"]\nresume = [\"sh\", \"{}\", \"--resume\", \"{{run}}\"]\n",
            script.display()
        ),
    )
    .unwrap();
    state
        .put_run(&unfinished_record(
            &run,
            &["mytool", "--task", "x"],
            root.path(),
            Some("mytool"),
            &head.manifest_id,
            40,
            1,
        ))
        .await
        .unwrap();

    let sup = tokio::spawn(crate::run(config(
        &cp,
        root.path(),
        store_root.path(),
        agents.path(),
    )));

    assert!(
        cp.wait_until(Duration::from_secs(30), |s| !s.rollbacks.is_empty())
            .await,
        "a disk whose journal is behind the recorded head is a rollback (spec 4.7)"
    );
    tokio::time::sleep(Duration::from_millis(300)).await;

    cp.with_state(|s| {
        assert_eq!(s.rollbacks.len(), 1, "exactly one report per detection");
        let report = &s.rollbacks[0];
        assert_eq!(
            report.recorded_manifest.as_ref(),
            Some(&head.manifest_id),
            "the report names the newest head the supervisor had recorded"
        );
        // The tree itself is intact here — the difference is in the journal, and
        // that is what the per-run entry carries.
        assert_eq!(
            (report.diff.added, report.diff.modified, report.diff.removed),
            (0, 0, 0),
            "the tree matches the recorded head; only the journal is behind"
        );
        let entry = report
            .run(&run)
            .expect("the report names the unfinished run");
        assert_eq!(
            entry.control_offset.get(),
            40,
            "what the control plane holds"
        );
        assert_eq!(entry.disk_offset.get(), 10, "what survived on the disk");
        assert!(!entry.replayed, "replay must NOT happen by default");

        assert!(
            s.run_started.is_empty(),
            "nothing may be spawned: not the resume, not a replay: {:?}",
            s.run_started
        );
    });
    assert!(
        !marker.exists(),
        "the adapter's resume command must not run after a rollback it cannot survive"
    );
    assert_eq!(
        attentions_for(&cp, &run),
        vec![AttentionKind::Interrupted],
        "the user is told, exactly once, and content-free"
    );

    // Journal preserved and the record marked interrupted.
    assert_eq!(
        std::fs::read(journal_dir(root.path(), &run).join("00000000.seg")).unwrap(),
        survived,
        "a rollback report must not touch what is left of the journal"
    );
    let record = state.get_run(&run).await.unwrap().unwrap();
    assert_eq!(record.phase, RunPhase::Interrupted);

    sup.abort();
}

// ---------------------------------------------------------------------------
// 4. spec 4.7 — the disk is exactly an older recorded checkpoint, and the run
//    that was lost had produced no output at all: replay IS safe, and happens.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn warm_rollback_replays_only_a_run_that_had_produced_no_journal_output() {
    let root = tempfile::tempdir().unwrap();
    let store_root = tempfile::tempdir().unwrap();
    let agents = tempfile::tempdir().unwrap();
    let scratch = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(store_root.path()).unwrap();
    let state = DurableState::new(store.clone(), ComputerId::new(COMPUTER), Epoch::new(EPOCH));
    let run = RunId::new("run-fresh");

    // Checkpoint 1: just a.txt. Recorded.
    std::fs::write(root.path().join("a.txt"), b"one").unwrap();
    let old = snapshot(&store, root.path(), &snap_opts()).await.unwrap();
    state
        .record_head(&old.manifest_id, Epoch::new(EPOCH - 2))
        .await
        .unwrap();
    // Checkpoint 2: b.txt appears. Recorded — this is the newest head.
    std::fs::write(root.path().join("b.txt"), b"two").unwrap();
    let newest = snapshot(&store, root.path(), &snap_opts()).await.unwrap();
    state
        .record_head(&newest.manifest_id, Epoch::new(EPOCH - 1))
        .await
        .unwrap();
    // The substrate restores checkpoint 1: b.txt is gone. The disk is now
    // byte-for-byte an OLDER recorded head — the tree signal.
    std::fs::remove_file(root.path().join("b.txt")).unwrap();

    // The run that was in flight had produced nothing at all: no journal on
    // disk, none in the record, none at the control plane.
    let (script, marker) = argv_recording_script(scratch.path(), "original", "REPLAYED-OUTPUT");
    state
        .put_run(&unfinished_record(
            &run,
            &[
                "sh",
                script.to_string_lossy().as_ref(),
                "--original-argv",
                "--task=x",
            ],
            root.path(),
            None,
            &old.manifest_id,
            0,
            0,
        ))
        .await
        .unwrap();

    let cp = FakeControlPlane::start().await.unwrap();
    let sup = tokio::spawn(crate::run(config(
        &cp,
        root.path(),
        store_root.path(),
        agents.path(),
    )));

    assert!(
        cp.wait_until(Duration::from_secs(30), |s| !s.rollbacks.is_empty())
            .await,
        "a disk sitting at an older recorded head is a rollback (spec 4.7)"
    );
    cp.with_state(|s| {
        let report = &s.rollbacks[0];
        assert_eq!(
            report.recorded_manifest.as_ref(),
            Some(&newest.manifest_id),
            "measured against the newest recorded head"
        );
        assert_eq!(
            (report.diff.added, report.diff.modified, report.diff.removed),
            (0, 0, 1),
            "the difference is exactly the file the rollback took back (b.txt)"
        );
        let entry = report.run(&run).expect("the report names the run");
        assert_eq!(entry.control_offset.get(), 0);
        assert_eq!(entry.disk_offset.get(), 0);
        assert!(
            entry.replayed,
            "a run that had produced no journal output at all is safe to replay"
        );
    });

    // The replay ran the run's ORIGINAL argv (not a resume command — there is
    // no adapter here at all).
    assert!(
        wait_for_file(&marker, Duration::from_secs(30)).await,
        "a safe replay must actually re-run the run"
    );
    let argv_seen = std::fs::read_to_string(&marker).unwrap();
    assert_eq!(
        argv_seen.lines().collect::<Vec<_>>(),
        vec!["--original-argv", "--task=x"],
        "a replay re-runs the original argv"
    );

    // Its journal starts at 0 — the run had none, so there is nothing to continue.
    assert!(
        cp.wait_until(Duration::from_secs(30), |s| s
            .journals
            .get(&run)
            .map(|r| r.buf == b"REPLAYED-OUTPUT")
            .unwrap_or(false))
            .await,
        "the replayed run's journal must be exactly its output, from offset 0"
    );
    assert_eq!(cp.first_offset(0, &run), Some(0));
    cp.with_state(|s| assert!(s.errors.is_empty(), "journal errors: {:?}", s.errors));
    assert!(
        attentions_for(&cp, &run).is_empty(),
        "a replayed run is not an interrupted run"
    );
    assert!(
        wait_for_phase(&state, &run, RunPhase::Completed, Duration::from_secs(30)).await,
        "the replayed run finishes for real"
    );

    sup.abort();
}

// ---------------------------------------------------------------------------
// 5. The negative that keeps 3 and 4 honest: a cold wake restores the tree from
//    the chunk store itself, so an older manifest on disk is not a rollback.
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_cold_wake_into_an_older_manifest_is_not_a_rollback() {
    let root = tempfile::tempdir().unwrap();
    let store_root = tempfile::tempdir().unwrap();
    let agents = tempfile::tempdir().unwrap();
    let src = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(store_root.path()).unwrap();
    let state = DurableState::new(store.clone(), ComputerId::new(COMPUTER), Epoch::new(EPOCH));

    // Two recorded heads; the cold wake is told to restore the OLDER one (the
    // control plane's decision — spec 4.6 restores from the store, which is
    // authoritative).
    std::fs::write(src.path().join("a.txt"), b"one").unwrap();
    let old = snapshot(&store, src.path(), &snap_opts()).await.unwrap();
    state
        .record_head(&old.manifest_id, Epoch::new(EPOCH - 2))
        .await
        .unwrap();
    std::fs::write(src.path().join("b.txt"), b"two").unwrap();
    let newest = snapshot(&store, src.path(), &snap_opts()).await.unwrap();
    state
        .record_head(&newest.manifest_id, Epoch::new(EPOCH - 1))
        .await
        .unwrap();

    let cp = FakeControlPlane::start().await.unwrap();
    let mut cfg = config(&cp, root.path(), store_root.path(), agents.path());
    cfg.restore_manifest = Some(old.manifest_id.to_string());
    let sup = tokio::spawn(crate::run(cfg));

    assert!(
        cp.wait_until(Duration::from_secs(10), |s| !s.hellos.is_empty())
            .await,
        "the supervisor must restore then connect"
    );
    // The restored tree really is the older one...
    assert_eq!(std::fs::read(root.path().join("a.txt")).unwrap(), b"one");
    assert!(!root.path().join("b.txt").exists());
    // ...and that is not a rollback: this process wrote the disk from the store.
    tokio::time::sleep(Duration::from_millis(500)).await;
    cp.with_state(|s| {
        assert!(
            s.rollbacks.is_empty(),
            "a cold wake must never be reported as a WARM rollback: {:?}",
            s.rollbacks
        );
        assert!(s.attentions.is_empty(), "and must raise no attention");
    });

    sup.abort();
}
