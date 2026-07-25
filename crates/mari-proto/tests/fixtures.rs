//! Conformance-fixture generator (and its own round-trip test).
//!
//! Serializes one deterministic exemplar of every wire message and of the
//! stored formats (`Manifest`, `HeatProfile`, `ComputerState`) into
//! `packages/shared/fixtures/<name>.cbor` (CBOR body) and
//! `<name>.expected.json` (canonical JSON of the same value). Two messages also
//! get a `<name>.frame` file (the length-prefixed wire frame) so the TS side
//! can validate framing across languages.
//!
//! Regeneration is deterministic: every exemplar uses fixed values, no
//! timestamps and no randomness. The `packages/shared` vitest suite decodes
//! each fixture and deep-equals it against the JSON; this Rust test additionally
//! asserts that each written fixture round-trips back to the original value.

use std::fs;
use std::path::{Path, PathBuf};

use mari_proto::messages::PROTO_VERSION;
use mari_proto::{
    AttentionKind, ChunkRef, ComputerId, ComputerState, ControlMessage, DiffSummary, EntryKind,
    Epoch, ExitStatus, HeatProfile, JournalOffset, MANIFEST_VERSION, Manifest, ManifestEntry,
    ManifestId, RunId, RunOffset, RunRollback, SnapshotReason, SupervisorMessage,
};
use serde::Serialize;
use serde::de::DeserializeOwned;

/// 64-char blake3-hex-shaped id built from a repeated byte. Deterministic.
fn hex64(byte: u8) -> String {
    std::iter::repeat_n(format!("{byte:02x}"), 32).collect()
}

fn fixtures_dir() -> PathBuf {
    // CARGO_MANIFEST_DIR is crates/mari-proto; fixtures live under the shared package.
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/shared/fixtures")
        .canonicalize()
        .unwrap_or_else(|_| {
            let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../packages/shared/fixtures");
            fs::create_dir_all(&p).unwrap();
            p.canonicalize().unwrap()
        })
}

/// Write `<name>.cbor` and `<name>.expected.json`, then assert both round-trip
/// back to `value`.
fn write_fixture<T>(dir: &Path, name: &str, value: &T)
where
    T: Serialize + DeserializeOwned + PartialEq + std::fmt::Debug,
{
    let cbor = mari_proto::to_cbor(value).expect("encode cbor");
    fs::write(dir.join(format!("{name}.cbor")), &cbor).expect("write cbor");

    let json = serde_json::to_string_pretty(value).expect("encode json");
    fs::write(
        dir.join(format!("{name}.expected.json")),
        format!("{json}\n"),
    )
    .expect("write json");

    // Teeth: the files we just wrote must decode back to the exact value.
    let from_cbor: T = mari_proto::from_cbor(&cbor).expect("decode cbor");
    assert_eq!(&from_cbor, value, "cbor round-trip failed for {name}");
    let from_json: T = serde_json::from_str(&json).expect("decode json");
    assert_eq!(&from_json, value, "json round-trip failed for {name}");
}

/// Write a length-prefixed wire frame for cross-language framing checks.
fn write_frame<T: Serialize>(dir: &Path, name: &str, value: &T) {
    let framed = mari_proto::encode_frame(value).expect("encode frame");
    fs::write(dir.join(format!("{name}.frame")), &framed).expect("write frame");
}

#[test]
fn generate_and_verify_fixtures() {
    let dir = fixtures_dir();
    fs::create_dir_all(&dir).unwrap();

    // ---- shared ids used across exemplars (deterministic) ----
    let computer = ComputerId::new("computer-alpha");
    let run = RunId::new("run-0001");
    let base_manifest = ManifestId::new(hex64(0x01));
    let head_manifest = ManifestId::new(hex64(0x02));
    let chunk_a = hex64(0xa1);
    let chunk_b = hex64(0xb2);
    let chunk_c = hex64(0xc3);
    let epoch = Epoch::new(7);
    let offset = JournalOffset::new(1024);

    // ---- storage formats ----
    let manifest = Manifest {
        version: MANIFEST_VERSION,
        parent: Some(base_manifest.clone()),
        created_at: 1_700_000_000, // fixed Unix seconds; fits a u32
        entries: vec![
            ManifestEntry {
                path: "/".into(),
                kind: EntryKind::Dir,
                mode: 0o040755,
                size: 0,
                symlink_target: None,
                chunks: vec![],
            },
            ManifestEntry {
                path: "/bin/sh".into(),
                kind: EntryKind::Symlink,
                mode: 0o120777,
                size: 4,
                symlink_target: Some("bash".into()),
                chunks: vec![],
            },
            ManifestEntry {
                path: "/etc/hostname".into(),
                kind: EntryKind::File,
                mode: 0o100644,
                size: 12,
                symlink_target: None,
                chunks: vec![ChunkRef {
                    chunk: chunk_a.clone().into(),
                    len: 12,
                }],
            },
            ManifestEntry {
                path: "/var/log/big.log".into(),
                kind: EntryKind::File,
                mode: 0o100644,
                size: 300,
                symlink_target: None,
                chunks: vec![
                    ChunkRef {
                        chunk: chunk_a.into(),
                        len: 128,
                    },
                    ChunkRef {
                        chunk: chunk_b.into(),
                        len: 128,
                    },
                    ChunkRef {
                        chunk: chunk_c.into(),
                        len: 44,
                    },
                ],
            },
        ],
    };
    write_fixture(&dir, "manifest", &manifest);

    write_fixture(
        &dir,
        "heat_profile",
        &HeatProfile {
            paths: vec![
                "/etc/hostname".into(),
                "/bin/sh".into(),
                "/var/log/big.log".into(),
            ],
        },
    );

    write_fixture(&dir, "computer_state", &ComputerState::Warm);
    write_fixture(&dir, "exit_signaled", &ExitStatus::Signaled { signal: 9 });

    // ---- supervisor -> control ----
    write_fixture(
        &dir,
        "sup_hello",
        &SupervisorMessage::Hello {
            computer: computer.clone(),
            epoch,
            token: "supervisor-token-abc".into(),
            proto_version: PROTO_VERSION,
        },
    );
    let journal = SupervisorMessage::JournalFrame {
        run: run.clone(),
        offset,
        bytes: b"hello \x1b[32mworld\x1b[0m\n".to_vec(),
    };
    write_fixture(&dir, "sup_journal_frame", &journal);
    write_fixture(
        &dir,
        "sup_run_started",
        &SupervisorMessage::RunStarted {
            run: run.clone(),
            pre_run_manifest: base_manifest.clone(),
        },
    );
    write_fixture(
        &dir,
        "sup_run_completed",
        &SupervisorMessage::RunCompleted {
            run: run.clone(),
            exit: ExitStatus::Exited { code: 0 },
            post_run_manifest: head_manifest.clone(),
            diff: DiffSummary {
                added: 3,
                modified: 1,
                removed: 0,
            },
        },
    );
    write_fixture(
        &dir,
        "sup_snapshot_written",
        &SupervisorMessage::SnapshotWritten {
            manifest: head_manifest.clone(),
            epoch,
            reason: SnapshotReason::PreRun,
        },
    );
    write_fixture(
        &dir,
        "sup_head_advance_request",
        &SupervisorMessage::HeadAdvanceRequest {
            manifest: head_manifest.clone(),
            epoch,
        },
    );
    write_fixture(
        &dir,
        "sup_attention",
        &SupervisorMessage::Attention {
            run: run.clone(),
            kind: AttentionKind::Bell,
        },
    );
    write_fixture(
        &dir,
        "sup_run_heartbeat",
        &SupervisorMessage::RunHeartbeat { run: run.clone() },
    );
    // A run the supervisor could not continue after a restart (spec 5.6's
    // defined degradation) — still content-free.
    write_fixture(
        &dir,
        "sup_attention_interrupted",
        &SupervisorMessage::Attention {
            run: run.clone(),
            kind: AttentionKind::Interrupted,
        },
    );
    // The WARM-rollback report (spec 4.7): one run replayed (it had produced no
    // journal output), one left interrupted.
    write_fixture(
        &dir,
        "sup_rollback_detected",
        &SupervisorMessage::RollbackDetected {
            disk_manifest: base_manifest.clone(),
            recorded_manifest: Some(head_manifest.clone()),
            diff: DiffSummary {
                added: 0,
                modified: 1,
                removed: 2,
            },
            runs: vec![
                RunRollback {
                    run: run.clone(),
                    control_offset: JournalOffset::new(4096),
                    disk_offset: JournalOffset::new(1024),
                    replayed: false,
                },
                RunRollback {
                    run: RunId::new("run-0002"),
                    control_offset: JournalOffset::new(0),
                    disk_offset: JournalOffset::new(0),
                    replayed: true,
                },
            ],
        },
    );

    // ---- control -> supervisor ----
    let hello_ack = ControlMessage::HelloAck {
        acked: vec![
            RunOffset {
                run: run.clone(),
                offset,
            },
            RunOffset {
                run: RunId::new("run-0002"),
                offset: JournalOffset::new(0),
            },
        ],
    };
    write_fixture(&dir, "ctl_hello_ack", &hello_ack);
    write_fixture(
        &dir,
        "ctl_journal_ack",
        &ControlMessage::JournalAck {
            run: run.clone(),
            offset,
        },
    );
    write_fixture(
        &dir,
        "ctl_start_run",
        &ControlMessage::StartRun {
            run: run.clone(),
            argv: vec!["bash".into(), "-lc".into(), "echo hi".into()],
            env_names: vec!["OPENAI_API_KEY".into(), "PATH".into()],
            cwd: "/home/agent".into(),
        },
    );
    write_fixture(
        &dir,
        "ctl_stop_run",
        &ControlMessage::StopRun { run: run.clone() },
    );
    write_fixture(
        &dir,
        "ctl_input",
        &ControlMessage::Input {
            run: run.clone(),
            bytes: b"ls -la\r".to_vec(),
        },
    );
    write_fixture(
        &dir,
        "ctl_resize",
        &ControlMessage::Resize {
            run: run.clone(),
            cols: 120,
            rows: 40,
        },
    );
    write_fixture(
        &dir,
        "ctl_snapshot_now",
        &ControlMessage::SnapshotNow {
            reason: SnapshotReason::Command,
        },
    );
    write_fixture(
        &dir,
        "ctl_prepare_for_cold",
        &ControlMessage::PrepareForCold,
    );
    write_fixture(
        &dir,
        "ctl_head_advance_result",
        &ControlMessage::HeadAdvanceResult {
            accepted: true,
            current_epoch: epoch,
        },
    );
    write_fixture(
        &dir,
        "ctl_restore_to_manifest",
        &ControlMessage::RestoreToManifest {
            manifest: head_manifest,
        },
    );

    // ---- large-u64 regression fixtures (protocol review PROTO-02) ----
    // Every wire `u64` may range up to 2^53-1 (contracts §1). ciborium always
    // emits a shortest-form major-type-0 integer; `cbor-x` used to switch to a
    // CBOR float64 for any integer-valued Number >= 2^32, so a run whose journal
    // crossed 4 GiB produced offsets/epochs the supervisor could not decode.
    // These exemplars carry offsets and epochs at exactly 2^32 and at the JS
    // safe-integer ceiling so the TS re-encode conformance test catches any such
    // drift for good.
    let offset_2pow32 = JournalOffset::new(4_294_967_296); // 2^32
    let offset_max = JournalOffset::new(mari_proto::MAX_SAFE_INTEGER); // 2^53 - 1
    write_fixture(
        &dir,
        "ctl_journal_ack_large",
        &ControlMessage::JournalAck {
            run: run.clone(),
            offset: offset_2pow32,
        },
    );
    write_fixture(
        &dir,
        "ctl_hello_ack_large",
        &ControlMessage::HelloAck {
            acked: vec![
                RunOffset {
                    run: run.clone(),
                    offset: offset_2pow32,
                },
                RunOffset {
                    run: RunId::new("run-0002"),
                    offset: offset_max,
                },
            ],
        },
    );
    write_fixture(
        &dir,
        "sup_hello_large",
        &SupervisorMessage::Hello {
            computer: computer.clone(),
            epoch: Epoch::new(mari_proto::MAX_SAFE_INTEGER),
            token: "supervisor-token-large".into(),
            proto_version: PROTO_VERSION,
        },
    );

    // ---- cross-language framing fixtures ----
    write_frame(
        &dir,
        "sup_hello",
        &SupervisorMessage::Hello {
            computer,
            epoch,
            token: "supervisor-token-abc".into(),
            proto_version: PROTO_VERSION,
        },
    );
    write_frame(&dir, "sup_journal_frame", &journal);
}
