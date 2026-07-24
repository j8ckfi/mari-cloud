//! The thesis test: **a computer is data** (decisions.md "e2e (Docker)", spec
//! §1.1, §4.2, §5.6).
//!
//! Gated on `MARI_E2E_DOCKER=1`; skips with a clear message otherwise. It proves
//! the whole storage inversion end to end, against the real Docker substrate on
//! this host:
//!
//! 1. Build a Linux `marid` binary inside a `rust` container, with named-volume
//!    caches for the cargo registry and target dir so re-runs are incremental
//!    (debug profile).
//! 2. Chunk store = a host temp dir (opendal fs), bind-mounted into every
//!    container at `/store`. Fake control plane = an in-test server bound on
//!    `0.0.0.0`, reached from containers via `host.docker.internal`.
//! 3. Seed a base tree, snapshot it (mari-core, fs store) as the base manifest,
//!    then **materialize container A** (`debian:bookworm-slim`, `marid`
//!    entrypoint, epoch 1, restore = base). marid restores and connects. A run
//!    appends known bytes to `/work/log.txt`, prints to the PTY, exits 0: the
//!    journal frames arrive, `RunCompleted` carries exit 0 and a diff naming
//!    exactly `/work/log.txt`, a final snapshot head `H2` is recorded. Then
//!    **destroy container A — this is COLD**: no substrate resources remain.
//! 4. **Materialize a FRESH container B** (epoch 2, restore = `H2`). marid
//!    reconnects; `/work/log.txt` is byte-for-byte `base + appended`; and the
//!    journal segments the run left in the store reassemble to exactly the bytes
//!    the control plane received live (continuity, spec 4.2/5.6 groundwork).
//! 5. Epoch fencing at the storage boundary (spec 4.1): a leftover epoch-1
//!    supervisor cannot advance the head after B's higher-epoch wake — the
//!    control plane rejects the stale advance and marid survives the rejection.
//!
//! The substrate is driven entirely through the `docker` CLI. The production
//! substrate driver is TypeScript in the control plane (decisions.md) and is out
//! of scope here; this test is the Rust-side storage-continuity proof.
//!
//! Run it:
//! `MARI_E2E_DOCKER=1 cargo test -p marid --test e2e_docker -- --nocapture`

mod common;

use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use mari_core::{ChunkStore, SnapshotOptions, diff, snapshot};
use mari_proto::{
    ComputerId, ControlMessage, Epoch, ExitStatus, PROTO_VERSION, RunId, SnapshotReason,
};

use common::{
    FakeCp, HelloRecord, LabelCleanup, cleanup_by_label, container_running, cp_out_bytes, docker,
    docker_available, docker_ok, ensure_image, ensure_volume,
};

const REGISTRY_VOL: &str = "mari_e2e_cargo_registry";
const TARGET_VOL: &str = "mari_e2e_cargo_target";
const RUST_IMAGE: &str = "rust:1-bookworm";
const RUNTIME_IMAGE: &str = "debian:bookworm-slim";

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

/// Deterministic alphanumeric bytes (shell-safe: no quotes, no separators), so a
/// blob can be embedded literally in a `printf '%s' '<blob>'` run script and the
/// journal/file bytes are known exactly.
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

fn repo_root() -> PathBuf {
    // CARGO_MANIFEST_DIR = <repo>/crates/marid ; the repo root is two levels up.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(Path::parent)
        .expect("repo root")
        .to_path_buf()
}

/// Build `marid` for linux/arm64 inside a rust container. Named-volume caches
/// (registry + target) make re-runs incremental; the repo is mounted read-only
/// and cargo writes only to the caches, so nothing in the host tree is touched.
/// (No shell is involved — `Command` passes the space-containing repo path as a
/// single argument, so no quoting is required.)
fn build_marid_in_docker() {
    let repo = repo_root();
    let repo_mount = format!("{}:/repo:ro", repo.display());
    println!("[e2e] building marid for linux/arm64 in {RUST_IMAGE} (incremental via named volumes)…");
    let status = std::process::Command::new("docker")
        .args([
            "run",
            "--rm",
            "--platform",
            "linux/arm64",
            "-v",
            &repo_mount,
            "-v",
            &format!("{REGISTRY_VOL}:/usr/local/cargo/registry"),
            "-v",
            &format!("{TARGET_VOL}:/target"),
            "-e",
            "CARGO_TARGET_DIR=/target",
            "-e",
            "CARGO_NET_RETRY=5",
            "-w",
            "/repo",
            RUST_IMAGE,
            "cargo",
            "build",
            "-p",
            "marid",
            "--locked",
        ])
        .status()
        .expect("spawn docker build");
    assert!(status.success(), "marid build in docker failed: {status:?}");
}

/// Parameters for one `marid` container.
struct MaridSpec<'a> {
    name: &'a str,
    label: &'a str,
    cid: &'a str,
    epoch: u64,
    restore: Option<&'a str>,
    store_host: &'a str,
    url: &'a str,
    token: &'a str,
}

/// `docker run -d` a marid container: the built Linux binary (from the target
/// volume, read-only) as the entrypoint, the host store bind-mounted at /store,
/// and the control plane reachable via host.docker.internal.
fn launch_marid(s: &MaridSpec) {
    let mut args: Vec<String> = [
        "run",
        "-d",
        "--name",
        s.name,
        "--label",
        s.label,
        "--platform",
        "linux/arm64",
        "--add-host",
        "host.docker.internal:host-gateway",
        "-v",
        &format!("{TARGET_VOL}:/target:ro"),
        "-v",
        &format!("{}:/store", s.store_host),
        "-e",
        &format!("MARI_COMPUTER_ID={}", s.cid),
        "-e",
        &format!("MARI_CONTROL_URL={}", s.url),
        "-e",
        &format!("MARI_EPOCH={}", s.epoch),
        "-e",
        "MARI_ROOT=/work",
        "-e",
        "MARI_STORE=fs:///store",
        "-e",
        &format!("MARI_TOKEN={}", s.token),
        "-e",
        "MARI_SNAPSHOT_INTERVAL=3600",
        "-e",
        "MARI_ATTENTION_SILENCE_MS=600000",
        "-e",
        "MARI_SEGMENT_BYTES=512",
        "-e",
        "RUST_LOG=info,marid=debug",
    ]
    .into_iter()
    .map(String::from)
    .collect();
    if let Some(m) = s.restore {
        args.push("-e".into());
        args.push(format!("MARI_RESTORE_MANIFEST={m}"));
    }
    args.push(RUNTIME_IMAGE.into());
    args.push("/target/debug/marid".into());
    docker_ok(&args.iter().map(String::as_str).collect::<Vec<_>>());
}

/// Wait for a *new* Hello to appear beyond `prev_len`, returning it. Dumps
/// container logs and panics on timeout, so a wake failure is legible.
async fn await_new_hello(
    cp: &FakeCp,
    prev_len: usize,
    container: &str,
    timeout: Duration,
) -> HelloRecord {
    let ok = cp
        .wait_until(timeout, |st| st.hellos.len() > prev_len)
        .await;
    if !ok {
        dump_logs(container);
        panic!("timed out waiting for {container} to connect and send Hello");
    }
    cp.with_state(|st| st.hellos[prev_len].clone())
}

fn dump_logs(container: &str) {
    if let Ok(out) = docker(&["logs", container]) {
        eprintln!(
            "----- docker logs {container} -----\n{}\n{}\n-----------------------------",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
        );
    }
}

/// Reassemble a run's journal from the segment files it left in the (host) store,
/// in sequence order: `journal/{computer}/{run}/{seq:08}.seg`.
fn reassemble_store_segments(store_host: &Path, computer: &str, run: &str) -> Vec<u8> {
    let dir = store_host.join("journal").join(computer).join(run);
    let mut names: Vec<PathBuf> = std::fs::read_dir(&dir)
        .unwrap_or_else(|e| panic!("reading segment dir {}: {e}", dir.display()))
        .filter_map(|e| e.ok().map(|e| e.path()))
        .filter(|p| p.extension().map(|x| x == "seg").unwrap_or(false))
        .collect();
    names.sort(); // zero-padded seq → lexical order == numeric order
    let mut out = Vec::new();
    for p in names {
        out.extend_from_slice(&std::fs::read(&p).unwrap());
    }
    out
}

// ---------------------------------------------------------------------------
// the test
// ---------------------------------------------------------------------------

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn cold_wake_across_fresh_containers_is_byte_identical_and_continuous() {
    if std::env::var("MARI_E2E_DOCKER").as_deref() != Ok("1") {
        eprintln!(
            "[e2e] SKIP: set MARI_E2E_DOCKER=1 to run the Docker cold-wake thesis test \
             (it builds a Linux marid and materializes debian containers)."
        );
        return;
    }
    assert!(
        docker_available(),
        "MARI_E2E_DOCKER=1 but no Docker daemon is reachable"
    );

    // ---- setup -----------------------------------------------------------
    let run_id = format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    );
    let label = format!("mari-e2e-run={run_id}");
    // RAII: force-remove every labeled container even if an assertion panics.
    let cleanup = LabelCleanup::new(label.clone());

    ensure_volume(REGISTRY_VOL);
    ensure_volume(TARGET_VOL);
    ensure_image(RUST_IMAGE);
    ensure_image(RUNTIME_IMAGE);

    // Step 1: build the Linux marid binary into the target volume (incremental).
    tokio::task::spawn_blocking(build_marid_in_docker)
        .await
        .expect("build task join");

    // Step 2: the chunk store is a host temp dir under $HOME (colima shares $HOME
    // into the VM; /tmp is not shared, so the bind mount must live under $HOME).
    let home = std::env::var("HOME").expect("HOME");
    let store_dir = tempfile::Builder::new()
        .prefix(".mari-e2e-store-")
        .tempdir_in(&home)
        .expect("store tempdir under $HOME");
    let store_host = store_dir.path().to_path_buf();
    let host_store = ChunkStore::open_fs(&store_host).expect("open host fs store");

    // Seed a known base tree and snapshot it as the base manifest (mari-core).
    let base_bytes = known_blob(800, 1);
    let append_bytes = known_blob(400, 2);
    let expected_after = {
        let mut v = base_bytes.clone();
        v.extend_from_slice(&append_bytes);
        v
    };
    let base_src = tempfile::tempdir().expect("base src");
    std::fs::write(base_src.path().join("log.txt"), &base_bytes).unwrap();
    let base = snapshot(&host_store, base_src.path(), &SnapshotOptions::default())
        .await
        .expect("snapshot base tree");
    let base_id = base.manifest_id.to_string();
    println!("[e2e] base manifest = {base_id}");

    // The PTY-visible run output (the journal) is a separate known blob.
    let pty_blob = known_blob(1300, 3);
    let pty_str = String::from_utf8(pty_blob.clone()).unwrap();
    let append_str = String::from_utf8(append_bytes.clone()).unwrap();

    // Step 2: the reachable fake control plane.
    let cp = FakeCp::start().await.expect("bind fake control plane");
    let url = cp.container_url();
    println!("[e2e] fake control plane at {url}");

    let cid = format!("comp-{run_id}");
    let store_host_str = store_host.to_str().unwrap().to_string();
    let token = "e2e-token";

    // =====================================================================
    // Step 3: container A (epoch 1) — cold wake from base, run, snapshot H2.
    // =====================================================================
    let name_a = format!("mari-e2e-{run_id}-a");
    let t_a = Instant::now();
    launch_marid(&MaridSpec {
        name: &name_a,
        label: &label,
        cid: &cid,
        epoch: 1,
        restore: Some(&base_id),
        store_host: &store_host_str,
        url: &url,
        token,
    });
    let hello_a = await_new_hello(&cp, 0, &name_a, Duration::from_secs(60)).await;
    println!(
        "[e2e] A connected in {:?} (restore-to-connect incl. container start)",
        t_a.elapsed()
    );
    assert_eq!(hello_a.computer, ComputerId::new(cid.clone()));
    assert_eq!(hello_a.epoch, Epoch::new(1));
    assert_eq!(hello_a.token, token);
    assert_eq!(hello_a.proto_version, PROTO_VERSION);
    let conn_a = hello_a.conn;

    // Drive the run: append known bytes to /work/log.txt, print a known blob to
    // the PTY, exit 0. `/bin/sh` avoids any PATH ambiguity in the container.
    let run = RunId::new(format!("run-{run_id}"));
    let script = format!(
        "printf '%s' '{pty_str}'; printf '%s' '{append_str}' >> /work/log.txt",
    );
    cp.queue_to(
        conn_a,
        ControlMessage::StartRun {
            run: run.clone(),
            argv: vec!["/bin/sh".into(), "-c".into(), script],
            env_names: vec![],
            cwd: "/work".into(),
        },
    );

    // The run completes with exit 0.
    let completed = cp
        .wait_until(Duration::from_secs(60), |st| st.completion(&run).is_some())
        .await;
    if !completed {
        dump_logs(&name_a);
        panic!("run did not complete");
    }
    let (exit, post_id, summary) = cp.with_state(|st| {
        let (_r, exit, post, diff) = st.completion(&run).unwrap();
        (*exit, post.clone(), *diff)
    });
    assert_eq!(exit, ExitStatus::Exited { code: 0 }, "run must exit 0");
    // The wire diff summary: exactly one modified entry (the appended log file).
    assert_eq!(
        (summary.added, summary.modified, summary.removed),
        (0, 1, 0),
        "diff summary must be exactly one modification"
    );

    // The journal frames arrived and reassemble to the exact PTY output.
    let journal_ok = cp
        .wait_until(Duration::from_secs(30), |st| st.journal(&run) == pty_blob)
        .await;
    assert!(journal_ok, "journal frames must reassemble to the PTY output");
    cp.with_state(|st| assert!(st.errors.is_empty(), "journal integrity: {:?}", st.errors));

    // The structured diff names exactly `/log.txt` (i.e. /work/log.txt relative
    // to MARI_ROOT=/work): content changed, nothing added or removed.
    let pre_id = cp.with_state(|st| {
        st.run_started
            .iter()
            .find(|(r, _)| *r == run)
            .map(|(_, m)| m.clone())
            .expect("RunStarted recorded")
    });
    let pre = host_store.get_manifest(&pre_id).await.unwrap();
    let post = host_store.get_manifest(&post_id).await.unwrap();
    let d = diff(&pre, &post);
    let modified: Vec<&str> = d.modified.iter().map(|m| m.path.as_str()).collect();
    assert_eq!(modified, vec!["/log.txt"], "exactly /work/log.txt changed");
    assert!(d.added.is_empty() && d.removed.is_empty(), "no adds/removes");
    assert!(
        d.modified[0].content_changed && !d.modified[0].mode_changed,
        "log.txt content changed, mode unchanged"
    );

    // WARM->COLD: PrepareForCold writes the final snapshot (head H2) and marid
    // exits cleanly. This is the head B will wake into.
    cp.queue_to(conn_a, ControlMessage::PrepareForCold);
    let final_written = cp
        .wait_until(Duration::from_secs(30), |st| {
            st.snapshots.iter().any(|(_, _, r)| *r == SnapshotReason::Final)
        })
        .await;
    if !final_written {
        dump_logs(&name_a);
        panic!("final snapshot (H2) was not written");
    }
    let h2 = cp.with_state(|st| {
        st.snapshots
            .iter()
            .rev()
            .find(|(_, _, r)| *r == SnapshotReason::Final)
            .map(|(m, _, _)| m.clone())
            .unwrap()
    });
    let h2_str = h2.to_string();
    println!("[e2e] final head H2 = {h2}");
    // The head advanced to H2 under epoch 1 (accepted, since epoch 1 is current).
    let head_is_h2 = cp
        .wait_until(Duration::from_secs(10), |st| st.head.as_ref() == Some(&h2))
        .await;
    assert!(head_is_h2, "head must advance to H2");

    // marid exits after cold shutdown; the container stops on its own.
    let mut stopped = false;
    for _ in 0..100 {
        if !container_running(&name_a) {
            stopped = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    assert!(stopped, "container A must exit after PrepareForCold");

    // Destroy A. This is COLD: no substrate resources remain for the computer.
    docker_ok(&["rm", &name_a]);
    let a_gone = docker(&["ps", "-aq", "--filter", &format!("name={name_a}")])
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().is_empty())
        .unwrap_or(false);
    assert!(a_gone, "container A must not exist after destroy (COLD)");
    println!("[e2e] container A destroyed — computer is now COLD (data only)");

    // Capture what the control plane received live, to compare against the store.
    let live_journal = cp.with_state(|st| st.journal(&run));
    assert_eq!(live_journal, pty_blob);

    // =====================================================================
    // Step 4: FRESH container B (epoch 2) — cold wake from H2, verify.
    // =====================================================================
    let name_b = format!("mari-e2e-{run_id}-b");
    let prev_hellos = cp.with_state(|st| st.hellos.len());
    let t_b = Instant::now();
    launch_marid(&MaridSpec {
        name: &name_b,
        label: &label,
        cid: &cid,
        epoch: 2,
        restore: Some(&h2_str),
        store_host: &store_host_str,
        url: &url,
        token,
    });
    let hello_b = await_new_hello(&cp, prev_hellos, &name_b, Duration::from_secs(60)).await;
    let restore_to_connect_b = t_b.elapsed();
    println!(
        "[e2e] === COLD WAKE (spec 4.6(e) reference): B restore-to-connect = {:?} \
         (wall clock, includes container start) ===",
        restore_to_connect_b
    );
    assert_eq!(hello_b.epoch, Epoch::new(2), "B wakes at epoch 2");
    assert_eq!(hello_b.computer, ComputerId::new(cid.clone()));

    // The file is byte-for-byte base + appended, read out of the FRESH container.
    let file_in_b = cp_out_bytes(&name_b, "/work/log.txt");
    assert_eq!(
        file_in_b.len(),
        expected_after.len(),
        "restored /work/log.txt length must be base+append ({} bytes)",
        expected_after.len()
    );
    assert!(
        file_in_b == expected_after,
        "restored /work/log.txt must be byte-identical to base + appended content"
    );
    println!(
        "[e2e] B /work/log.txt = {} bytes, byte-identical to base+append ✓",
        file_in_b.len()
    );

    // Journal continuity: the segments the run left in the store reassemble to
    // exactly the bytes the control plane received live (spec 4.2/5.6).
    let store_journal = reassemble_store_segments(&store_host, &cid, run.as_str());
    assert!(
        !store_journal.is_empty(),
        "the run must have left journal segments in the store"
    );
    assert_eq!(
        store_journal, live_journal,
        "stored journal segments must reassemble to the live journal bytes"
    );
    assert_eq!(store_journal, pty_blob, "…which are exactly the PTY output");
    println!(
        "[e2e] journal continuity: {} store bytes == live bytes == PTY output ✓",
        store_journal.len()
    );

    docker_ok(&["rm", "-f", &name_b]);

    // =====================================================================
    // Step 5: epoch fencing at the storage boundary (spec 4.1). A leftover
    // epoch-1 supervisor (like A's, had it survived) must not advance the head
    // after B's higher-epoch wake; the control plane rejects it and marid lives.
    // =====================================================================
    let name_g = format!("mari-e2e-{run_id}-ghost");
    let prev_hellos = cp.with_state(|st| st.hellos.len());
    let advances_before = cp.with_state(|st| st.head_advances.len());
    launch_marid(&MaridSpec {
        name: &name_g,
        label: &label,
        cid: &cid,
        epoch: 1, // stale: B already woke at epoch 2
        restore: Some(&base_id),
        store_host: &store_host_str,
        url: &url,
        token,
    });
    let hello_g = await_new_hello(&cp, prev_hellos, &name_g, Duration::from_secs(60)).await;
    assert_eq!(hello_g.epoch, Epoch::new(1), "ghost is a stale epoch-1 waker");
    let conn_g = hello_g.conn;

    // Provoke a head advance from the stale supervisor.
    cp.queue_to(
        conn_g,
        ControlMessage::SnapshotNow {
            reason: SnapshotReason::Command,
        },
    );
    // The control plane must REJECT an epoch-1 advance now that current=2.
    let rejected = cp
        .wait_until(Duration::from_secs(30), |st| {
            st.head_advances[advances_before..]
                .iter()
                .any(|a| a.epoch == Epoch::new(1) && !a.accepted)
        })
        .await;
    if !rejected {
        dump_logs(&name_g);
        panic!("a stale epoch-1 head advance was not rejected post-wake");
    }
    // The head is unchanged (still H2): the fenced-out writer moved nothing.
    cp.with_state(|st| {
        assert_eq!(st.head.as_ref(), Some(&h2), "fenced-out writer must not move the head");
        assert!(
            st.head_advances[advances_before..]
                .iter()
                .all(|a| !(a.epoch == Epoch::new(1) && a.accepted)),
            "no epoch-1 advance may be accepted after B's wake"
        );
    });
    // marid handled the rejection without crashing: still running and connected.
    assert!(
        container_running(&name_g),
        "marid must survive a head-advance rejection (no crash)"
    );
    println!("[e2e] epoch fencing: stale epoch-1 head advance rejected, marid survived ✓");

    docker_ok(&["rm", "-f", &name_g]);

    // Explicit cleanup (the RAII guard is the panic-path backstop). Cache volumes
    // are intentionally left in place so re-runs stay incremental.
    cleanup.run();
    cleanup_by_label(&label);

    println!("[e2e] PASS — a computer is data: reconstructed byte-identically on a fresh container from the store alone.");
}
