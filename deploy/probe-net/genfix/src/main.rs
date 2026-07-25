//! SCRATCH — Gate 2 fixture generator.
//!
//! Emits the exact bytes `marid` would put on the wire, using the real
//! `mari_proto::encode_frame` (4-byte big-endian length + ciborium CBOR).
//! These files are baked into the probe container image and compared
//! byte-for-byte against what the Cloudflare Worker produces with the real
//! TypeScript encoder (`packages/shared/src/frame.ts`), in both directions.
//!
//! Deterministic: no timestamps, no randomness.

use std::fs;
use std::path::Path;

use mari_proto::{
    ComputerId, ControlMessage, Epoch, JournalOffset, RunId, SupervisorMessage,
    messages::PROTO_VERSION,
};
use sha2::{Digest, Sha256};

/// Deterministic payload generator, mirrored byte-for-byte in worker.ts.
fn pattern(len: usize, mul: u64, add: u64) -> Vec<u8> {
    (0..len as u64)
        .map(|i| ((i.wrapping_mul(mul).wrapping_add(add)) & 0xff) as u8)
        .collect()
}

fn write(dir: &Path, name: &str, bytes: &[u8], index: &mut Vec<serde_json::Value>) {
    fs::write(dir.join(name), bytes).expect("write fixture");
    let digest = hex::encode(Sha256::digest(bytes));
    println!("{name}: {} bytes sha256={digest}", bytes.len());
    index.push(serde_json::json!({
        "name": name,
        "len": bytes.len(),
        "sha256": digest,
    }));
}

fn main() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../fixtures");
    fs::create_dir_all(&dir).expect("mkdir fixtures");
    let mut index = Vec::new();

    // 1. hello — the first frame marid sends. Epoch is 2^32 + 1 on purpose: it
    //    exercises the CBOR u64 parity rule (contracts §1) over the real wire.
    let hello = SupervisorMessage::Hello {
        computer: ComputerId::new("probe-computer-1"),
        epoch: Epoch::new(4_294_967_297),
        token: "probe-token-abc".to_string(),
        proto_version: PROTO_VERSION,
    };
    write(
        &dir,
        "sup_hello.frame",
        &mari_proto::encode_frame(&hello).expect("encode hello"),
        &mut index,
    );

    // 2. journal_frame — 64 KiB of terminal bytes at a >2^32 offset. This is
    //    the frame marid streams continuously; it is the size that matters.
    let journal = SupervisorMessage::JournalFrame {
        run: RunId::new("probe-run-1"),
        offset: JournalOffset::new(8_589_934_592),
        bytes: pattern(65_536, 37, 11),
    };
    write(
        &dir,
        "sup_journal_big.frame",
        &mari_proto::encode_frame(&journal).expect("encode journal"),
        &mut index,
    );

    // 3. control -> supervisor: start_run.
    let start = ControlMessage::StartRun {
        run: RunId::new("probe-run-1"),
        argv: vec![
            "/bin/sh".to_string(),
            "-c".to_string(),
            "echo hi".to_string(),
        ],
        env_names: vec!["ANTHROPIC_API_KEY".to_string()],
        cwd: "/work".to_string(),
    };
    write(
        &dir,
        "ctl_start_run.frame",
        &mari_proto::encode_frame(&start).expect("encode start_run"),
        &mut index,
    );

    // 4. control -> supervisor: input (a CBOR byte string, the other direction's
    //    binary payload).
    let input = ControlMessage::Input {
        run: RunId::new("probe-run-1"),
        bytes: pattern(256, 11, 3),
    };
    write(
        &dir,
        "ctl_input.frame",
        &mari_proto::encode_frame(&input).expect("encode input"),
        &mut index,
    );

    fs::write(
        dir.join("index.json"),
        serde_json::to_string_pretty(&index).expect("json") + "\n",
    )
    .expect("write index");

    // Teeth: every emitted frame must decode back to the value it came from.
    let rt: SupervisorMessage =
        mari_proto::decode_frame(&fs::read(dir.join("sup_hello.frame")).unwrap()).unwrap();
    assert_eq!(rt, hello, "hello round-trip");
    let rt: SupervisorMessage =
        mari_proto::decode_frame(&fs::read(dir.join("sup_journal_big.frame")).unwrap()).unwrap();
    assert_eq!(rt, journal, "journal round-trip");
    let rt: ControlMessage =
        mari_proto::decode_frame(&fs::read(dir.join("ctl_start_run.frame")).unwrap()).unwrap();
    assert_eq!(rt, start, "start_run round-trip");
    let rt: ControlMessage =
        mari_proto::decode_frame(&fs::read(dir.join("ctl_input.frame")).unwrap()).unwrap();
    assert_eq!(rt, input, "input round-trip");
    println!("all fixtures round-trip");
}
