//! GATE 1 — rootless restore fidelity, executed INSIDE a Cloudflare Container.
//!
//! This file lives in the probe lane (`deploy/probe/`). The probe image build
//! copies it into `crates/mari-core/tests/` so it compiles as a first-class
//! `mari-core` integration test and reuses `tests/common/mod.rs` — the *same*
//! tree builder (`build_reference_tree`) and byte-level comparator
//! (`read_tree`) the crate's own `roundtrip.rs` uses — verbatim. The repo
//! working tree is never modified; the copy happens only in the Docker build
//! context.
//!
//! It answers exactly the questions docs/substrates-cloudflare.md marks
//! unverified (#3):
//!
//! 1. Does `snapshot -> wipe -> restore` stay byte-identical without root?
//!    Not "restore into a fresh dir" (that is `roundfile.rs`'s shape) but the
//!    literal contract from decisions.md: wipe the tree in place, restore over
//!    the same path.
//! 2. Do the special mode bits (setuid / setgid / sticky) survive? `mode` is
//!    the only permission state a `ManifestEntry` carries, and `restore` masks
//!    it with `0o7777`, so those three bits ARE inside the contract.
//! 3. Ownership and device nodes: what the substrate refuses, and whether the
//!    contract depends on it. It does not — and this file proves that
//!    structurally, not by assertion-free hand-waving.
//! 4. What snapshot + restore cost in wall-clock at a realistic size, with the
//!    PRODUCTION chunker, on the substrate's own CPU allocation.

mod common;

use std::collections::BTreeMap;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::Command;
use std::time::Instant;

use common::{build_reference_tree, chmod, gen_bytes, read_tree, Node};
use mari_core::{restore, snapshot, ChunkStore, ChunkerConfig, RestoreOptions, SnapshotOptions};
use mari_proto::{ChunkRef, EntryKind, ManifestEntry};

/// Same chunker `roundtrip.rs` uses, so `big.bin` is split into >100 chunks.
fn small_chunker() -> ChunkerConfig {
    let c = ChunkerConfig {
        min: 2048,
        avg: 4096,
        max: 16384,
    };
    c.validate().unwrap();
    c
}

/// Who we are, printed once per test so every result below is attributable to a
/// concrete uid/gid — the whole point of the gate.
fn who() -> String {
    let out = |args: &[&str]| -> String {
        Command::new(args[0])
            .args(&args[1..])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_else(|e| format!("<{e}>"))
    };
    out(&["id"])
}

/// Delete every entry under `root`, leaving `root` itself. This is the "wipe"
/// in "snapshot -> wipe -> restore".
fn wipe(root: &Path) {
    for e in std::fs::read_dir(root).expect("read_dir root") {
        let e = e.expect("dirent");
        let ft = e.file_type().expect("file_type");
        if ft.is_dir() {
            std::fs::remove_dir_all(e.path()).expect("remove_dir_all");
        } else {
            std::fs::remove_file(e.path()).expect("remove_file");
        }
    }
    let left: Vec<_> = std::fs::read_dir(root)
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert!(left.is_empty(), "wipe left entries behind: {left:?}");
}

/// Set `mode` and report what the kernel actually kept. A rootless sandbox may
/// silently drop a bit rather than fail the call, which is the interesting
/// case: it means the source tree never had the bit, so a faithful restore
/// cannot be blamed for its absence.
fn set_and_read_mode(p: &Path, mode: u32) -> (Result<(), String>, u32) {
    let r = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode))
        .map_err(|e| e.to_string());
    let got = std::fs::symlink_metadata(p)
        .expect("stat after chmod")
        .permissions()
        .mode()
        & 0o7777;
    (r, got)
}

/// Run a command, return `(exit_ok, combined_output)`.
fn sh(args: &[&str]) -> (bool, String) {
    match Command::new(args[0]).args(&args[1..]).output() {
        Ok(o) => {
            let mut s = String::from_utf8_lossy(&o.stdout).to_string();
            s.push_str(&String::from_utf8_lossy(&o.stderr));
            (o.status.success(), s.trim().to_string())
        }
        Err(e) => (false, format!("<spawn failed: {e}>")),
    }
}

fn mib(bytes: u64) -> f64 {
    bytes as f64 / (1024.0 * 1024.0)
}

// ---------------------------------------------------------------------------
// 1. The contract itself.
// ---------------------------------------------------------------------------

/// decisions.md, verbatim: "snapshot -> wipe -> restore is byte-identical
/// including modes, symlinks, empty files, and files spanning many chunks."
///
/// The wipe is real: the tree is destroyed in place and restored over the same
/// path, so a restore that depended on a pre-existing directory, on an inode
/// that survived, or on `create_dir_all` racing a leftover, fails here.
#[tokio::test]
async fn gate1_snapshot_wipe_restore_in_place_is_byte_identical() {
    println!("[gate1] running as: {}", who());

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("work");
    let store_dir = tmp.path().join("store");
    std::fs::create_dir_all(&root).unwrap();
    build_reference_tree(&root);

    // The exact tree state the restore has to reproduce.
    let before = read_tree(&root);
    assert!(before.len() >= 10, "reference tree is too small to mean much");

    let store = ChunkStore::open_fs(&store_dir).unwrap();
    let opts = SnapshotOptions {
        chunker: small_chunker(),
        exclude: vec![], // no exclusions: everything must round-trip
        parent: None,
        created_at: 100,
    };

    let t = Instant::now();
    let snap = snapshot(&store, &root, &opts).await.unwrap();
    let snap_ms = t.elapsed().as_secs_f64() * 1e3;

    // Multi-chunk file, same assertion the crate's own roundtrip test makes.
    let big = snap
        .manifest
        .entries
        .iter()
        .find(|e| e.path == "/big.bin")
        .expect("big.bin present");
    assert_eq!(big.kind, EntryKind::File);
    assert!(
        big.chunks.len() > 100,
        "big.bin should span many chunks, got {}",
        big.chunks.len()
    );
    assert_eq!(big.chunks.iter().map(|c| c.len).sum::<u64>(), big.size);
    assert!(
        snap.unattributable_links.is_empty(),
        "nothing in the reference tree is a hard link out of the root: {:?}",
        snap.unattributable_links
    );

    // The manifest that came back from the store is the one we wrote.
    let reloaded = store.get_manifest(&snap.manifest_id).await.unwrap();
    assert_eq!(reloaded, snap.manifest);

    // WIPE. In place, not into a fresh directory.
    wipe(&root);
    assert!(
        read_tree(&root).is_empty(),
        "the wipe must leave an empty root"
    );

    let t = Instant::now();
    let stats = restore(&store, &snap.manifest, &root, &RestoreOptions::default())
        .await
        .unwrap();
    let restore_ms = t.elapsed().as_secs_f64() * 1e3;

    let after = read_tree(&root);
    assert_eq!(
        before, after,
        "snapshot -> wipe -> restore was NOT byte-identical"
    );

    // Spot-check every edge case the contract names, so a failure says which.
    assert!(
        matches!(after.get("empty.txt"), Some(Node::File { content, .. }) if content.is_empty()),
        "empty file"
    );
    assert!(
        matches!(after.get("run.sh"), Some(Node::File { perms, .. }) if *perms == 0o755),
        "exec bit"
    );
    assert!(
        matches!(after.get("data"), Some(Node::Dir { perms }) if *perms == 0o750),
        "directory mode"
    );
    assert!(
        matches!(after.get("data/nested"), Some(Node::Dir { perms }) if *perms == 0o700),
        "nested directory mode"
    );
    assert!(
        matches!(after.get("dangling"), Some(Node::Symlink { target }) if target == "this-target-does-not-exist"),
        "dangling symlink"
    );
    assert!(
        matches!(after.get("link_abs"), Some(Node::Symlink { target }) if target == "/etc/hostname"),
        "absolute symlink"
    );
    assert!(
        matches!(after.get("link_rel"), Some(Node::Symlink { target }) if target == "data/a.txt"),
        "relative symlink"
    );
    assert!(after.contains_key("weird name.txt"), "space in name");
    assert_eq!(stats.symlinks, 3, "three symlinks restored");

    println!(
        "[gate1] contract PASS  entries={} files={} dirs={} symlinks={} bytes={} \
         snapshot_ms={snap_ms:.1} restore_ms={restore_ms:.1} \
         chunks_unique={} chunks_uploaded={}",
        before.len(),
        stats.files,
        stats.dirs,
        stats.symlinks,
        stats.bytes,
        snap.unique_chunks,
        snap.uploaded_chunks,
    );
}

// ---------------------------------------------------------------------------
// 2. setuid / setgid / sticky — inside the contract, because `mode` is.
// ---------------------------------------------------------------------------

/// `ManifestEntry::mode` carries the full mode word and `restore` applies
/// `mode & 0o7777`, which includes setuid (0o4000), setgid (0o2000) and sticky
/// (0o1000). So these bits are part of "byte-identical including modes".
///
/// The assertion is conditional in exactly one direction and no further: if the
/// substrate let us set the bit on the SOURCE tree, the restore must reproduce
/// it. A bit the sandbox refuses to set was never in the snapshot, so its
/// absence after restore is not a restore failure — and that case is reported
/// loudly rather than silently passed.
#[tokio::test]
async fn gate1_special_mode_bits_survive_roundtrip() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("work");
    let store_dir = tmp.path().join("store");
    std::fs::create_dir_all(&root).unwrap();

    // setuid file, setgid file, sticky dir, and a read-only file (restore has
    // to write bytes into a file whose final mode forbids writing).
    std::fs::write(root.join("setuid.bin"), b"#!/bin/sh\nid\n").unwrap();
    std::fs::write(root.join("setgid.bin"), b"#!/bin/sh\nid\n").unwrap();
    std::fs::write(root.join("readonly.txt"), gen_bytes(7, 1024)).unwrap();
    std::fs::create_dir_all(root.join("sticky")).unwrap();
    std::fs::write(root.join("sticky").join("inside.txt"), b"sticky child\n").unwrap();
    chmod(&root.join("sticky").join("inside.txt"), 0o644);

    let cases: [(&str, u32); 4] = [
        ("setuid.bin", 0o4755),
        ("setgid.bin", 0o2755),
        ("readonly.txt", 0o400),
        ("sticky", 0o1777),
    ];

    let mut wanted: BTreeMap<String, u32> = BTreeMap::new();
    let mut refused: Vec<String> = Vec::new();
    for (name, mode) in cases {
        let p = root.join(name);
        let (res, got) = set_and_read_mode(&p, mode);
        println!(
            "[gate1] chmod {name} -> {mode:o}: call={} resulting_mode={got:o}",
            match &res {
                Ok(()) => "ok".to_string(),
                Err(e) => format!("ERR {e}"),
            }
        );
        if got == mode {
            wanted.insert(name.to_string(), mode);
        } else {
            refused.push(format!("{name} wanted {mode:o} got {got:o}"));
        }
    }

    let before = read_tree(&root);
    let store = ChunkStore::open_fs(&store_dir).unwrap();
    let snap = snapshot(
        &store,
        &root,
        &SnapshotOptions {
            chunker: small_chunker(),
            exclude: vec![],
            parent: None,
            created_at: 1,
        },
    )
    .await
    .unwrap();

    // The manifest carried the bits it was given.
    for (name, mode) in &wanted {
        let e = snap
            .manifest
            .entries
            .iter()
            .find(|e| e.path == format!("/{name}"))
            .unwrap_or_else(|| panic!("/{name} missing from manifest"));
        assert_eq!(
            e.mode & 0o7777,
            *mode,
            "manifest lost the special bits of /{name}"
        );
    }

    wipe(&root);
    restore(&store, &snap.manifest, &root, &RestoreOptions::default())
        .await
        .unwrap();

    let after = read_tree(&root);
    assert_eq!(
        before, after,
        "special-mode tree was NOT byte-identical after wipe+restore"
    );
    for (name, mode) in &wanted {
        let got = std::fs::symlink_metadata(root.join(name))
            .unwrap()
            .permissions()
            .mode()
            & 0o7777;
        assert_eq!(got, *mode, "/{name}: restore dropped a special mode bit");
    }

    if refused.is_empty() {
        println!("[gate1] special mode bits PASS (setuid, setgid, sticky, 0400 all set and restored)");
    } else {
        println!(
            "[gate1] SUBSTRATE LIMIT: the sandbox refused to set: {}. \
             Those bits were therefore never in the snapshot; the rest round-tripped.",
            refused.join("; ")
        );
    }
}

// ---------------------------------------------------------------------------
// 3. Ownership and device nodes — what the substrate refuses, and whether the
//    contract depends on it.
// ---------------------------------------------------------------------------

/// A `ManifestEntry` has no uid, no gid, and `EntryKind` has no device/fifo
/// variant. The struct literal below is that claim as a compile-time proof: a
/// Rust struct literal must name every field, so the day someone adds `uid` to
/// `ManifestEntry` this file stops compiling and this gate has to be re-run.
///
/// The test then shows the runtime consequence: a fifo (creatable without
/// privileges) and a device node (not) can sit in the tree and the snapshot
/// simply does not carry them, while every ordinary entry still round-trips
/// byte-identically. That is the difference between "Mari cannot restore
/// device nodes on Cloudflare" and "Mari does not restore device nodes
/// anywhere, by design".
#[tokio::test]
async fn gate1_ownership_and_device_nodes_are_outside_the_contract() {
    // Compile-time: the complete field set of a manifest entry.
    let _proof = ManifestEntry {
        path: "/x".to_string(),
        kind: EntryKind::File,
        mode: 0o100644,
        size: 0,
        symlink_target: None,
        chunks: Vec::<ChunkRef>::new(),
    };
    // Compile-time: the complete set of entry kinds.
    let _kinds: [EntryKind; 3] = [EntryKind::File, EntryKind::Dir, EntryKind::Symlink];
    match _proof.kind {
        EntryKind::File | EntryKind::Dir | EntryKind::Symlink => {}
    }

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("work");
    let store_dir = tmp.path().join("store");
    std::fs::create_dir_all(&root).unwrap();
    build_reference_tree(&root);

    // Snapshot the reference tree state BEFORE the exotic nodes are added, so
    // the comparison after restore is well-defined (and so `read_tree` never
    // has to open a fifo, which would block forever).
    let before = read_tree(&root);

    // -- ownership -----------------------------------------------------------
    let target = root.join("data").join("a.txt");
    let (chown_ok, chown_out) = sh(&["chown", "1001:1001", target.to_str().unwrap()]);
    let (chgrp_ok, chgrp_out) = sh(&["chgrp", "1001", target.to_str().unwrap()]);
    println!("[gate1] chown 1001:1001 -> ok={chown_ok} {chown_out}");
    println!("[gate1] chgrp 1001      -> ok={chgrp_ok} {chgrp_out}");

    // -- fifo (unprivileged) and device node (privileged) --------------------
    let fifo = root.join("pipe");
    let (fifo_ok, fifo_out) = sh(&["mkfifo", fifo.to_str().unwrap()]);
    println!("[gate1] mkfifo -> ok={fifo_ok} {fifo_out}");

    let devnode = root.join("null0");
    let (mknod_ok, mknod_out) = sh(&["mknod", devnode.to_str().unwrap(), "c", "1", "3"]);
    println!("[gate1] mknod c 1 3 -> ok={mknod_ok} {mknod_out}");

    // -- the snapshot must survive their presence and simply not carry them --
    let store = ChunkStore::open_fs(&store_dir).unwrap();
    let snap = snapshot(
        &store,
        &root,
        &SnapshotOptions {
            chunker: small_chunker(),
            exclude: vec![],
            parent: None,
            created_at: 2,
        },
    )
    .await
    .expect("a fifo/device in the tree must not fail the snapshot");

    if fifo_ok {
        assert!(
            !snap.manifest.entries.iter().any(|e| e.path == "/pipe"),
            "a fifo must not enter the manifest"
        );
    }
    if mknod_ok {
        assert!(
            !snap.manifest.entries.iter().any(|e| e.path == "/null0"),
            "a device node must not enter the manifest"
        );
    }

    // Remove the exotic nodes so the post-restore comparison is against the
    // same reference tree state we recorded, then wipe and restore.
    wipe(&root);
    restore(&store, &snap.manifest, &root, &RestoreOptions::default())
        .await
        .unwrap();

    let after = read_tree(&root);
    assert_eq!(
        before, after,
        "ordinary entries must round-trip byte-identically even when the source \
         tree contained node types the manifest cannot express"
    );

    println!(
        "[gate1] ownership/device verdict: chown={} mknod={} mkfifo={} \
         — manifest carries neither uid/gid nor device kinds, so the byte-identical \
         contract is unaffected either way",
        if chown_ok { "PERMITTED" } else { "REFUSED" },
        if mknod_ok { "PERMITTED" } else { "REFUSED" },
        if fifo_ok { "PERMITTED" } else { "REFUSED" },
    );
}

// ---------------------------------------------------------------------------
// 4. What it costs, at the production chunker, on this substrate's CPU.
// ---------------------------------------------------------------------------

/// A tree sized like a real Mari delta (~100 MiB across ~500 files plus two
/// large binaries), snapshotted with `ChunkerConfig::PRODUCTION` (min 64 KiB /
/// avg 256 KiB / max 1 MiB — the parameters the R2 cost model in the memo rests
/// on), wiped, and restored. The point is a number for "restore duration", and
/// it still asserts byte-identity so the number is not bought with a shortcut.
#[tokio::test]
async fn gate1_production_chunker_scale_and_timing() {
    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path().join("work");
    let store_dir = tmp.path().join("store");
    std::fs::create_dir_all(&root).unwrap();

    let t = Instant::now();
    let mut total: u64 = 0;
    // 20 dirs x 25 files x 64 KiB = 32 MiB of small files.
    for d in 0..20u64 {
        let dir = root.join(format!("pkg{d:02}"));
        std::fs::create_dir_all(&dir).unwrap();
        for f in 0..25u64 {
            let bytes = gen_bytes(d * 1000 + f, 64 * 1024);
            total += bytes.len() as u64;
            std::fs::write(dir.join(format!("f{f:02}.dat")), &bytes).unwrap();
        }
    }
    // One 64 MiB and one 8 MiB binary: multi-chunk at production parameters.
    let big = gen_bytes(0xB16, 64 * 1024 * 1024);
    total += big.len() as u64;
    std::fs::write(root.join("big64.bin"), &big).unwrap();
    drop(big);
    let mid = gen_bytes(0x51D, 8 * 1024 * 1024);
    total += mid.len() as u64;
    std::fs::write(root.join("mid8.bin"), &mid).unwrap();
    drop(mid);
    let build_ms = t.elapsed().as_secs_f64() * 1e3;

    let before = read_tree(&root);
    let store = ChunkStore::open_fs(&store_dir).unwrap();
    let opts = SnapshotOptions {
        chunker: ChunkerConfig::PRODUCTION,
        exclude: vec![],
        parent: None,
        created_at: 3,
    };

    let t = Instant::now();
    let snap = snapshot(&store, &root, &opts).await.unwrap();
    let snap_ms = t.elapsed().as_secs_f64() * 1e3;

    let big_entry = snap
        .manifest
        .entries
        .iter()
        .find(|e| e.path == "/big64.bin")
        .unwrap();
    assert!(
        big_entry.chunks.len() > 100,
        "64 MiB at avg 256 KiB must be many chunks, got {}",
        big_entry.chunks.len()
    );

    wipe(&root);

    let t = Instant::now();
    let stats = restore(&store, &snap.manifest, &root, &RestoreOptions::default())
        .await
        .unwrap();
    let restore_ms = t.elapsed().as_secs_f64() * 1e3;

    let after = read_tree(&root);
    assert_eq!(before, after, "100 MiB tree was not byte-identical");
    assert_eq!(stats.bytes, total, "restored byte count");

    // Second restore from the same store into a wiped root: the store is now
    // page-cache warm, which is the shape of a real repeat cold wake on a
    // substrate whose disk was just written by the image pull.
    wipe(&root);
    let t = Instant::now();
    restore(&store, &snap.manifest, &root, &RestoreOptions::default())
        .await
        .unwrap();
    let restore2_ms = t.elapsed().as_secs_f64() * 1e3;
    assert_eq!(read_tree(&root), before, "second restore not byte-identical");

    println!(
        "[gate1] scale: tree_bytes={} ({:.1} MiB) files={} build_ms={build_ms:.0}",
        total,
        mib(total),
        stats.files
    );
    println!(
        "[gate1] snapshot: {snap_ms:.0} ms ({:.1} MiB/s) unique_chunks={} uploaded={} total_refs={}",
        mib(total) / (snap_ms / 1e3),
        snap.unique_chunks,
        snap.uploaded_chunks,
        snap.total_refs
    );
    println!(
        "[gate1] restore : {restore_ms:.0} ms ({:.1} MiB/s) | second restore {restore2_ms:.0} ms ({:.1} MiB/s)",
        mib(total) / (restore_ms / 1e3),
        mib(total) / (restore2_ms / 1e3)
    );
}

// ---------------------------------------------------------------------------
// 5. Seed helper for the marid boot measurement (not a test; `#[ignore]`d).
// ---------------------------------------------------------------------------

/// Writes a reference tree's snapshot into the chunk store `marid` will read at
/// boot and prints its manifest id, so the probe boot script can hand it to
/// `MARI_RESTORE_MANIFEST` and we can time container-start -> cold-wake restore
/// complete. Ignored by default so it never runs as part of the suite.
#[tokio::test]
#[ignore = "invoked explicitly by the probe boot script"]
async fn gate1_seed_store_for_marid() {
    let store_dir = std::env::var("MARI_PROBE_SEED_STORE").unwrap_or_else(|_| "/store".to_string());
    let seed_root =
        std::env::var("MARI_PROBE_SEED_ROOT").unwrap_or_else(|_| "/tmp/seed".to_string());
    let extra_mib: u64 = std::env::var("MARI_PROBE_SEED_MIB")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(32);

    let root = Path::new(&seed_root);
    let _ = std::fs::remove_dir_all(root);
    std::fs::create_dir_all(root).unwrap();
    build_reference_tree(root);
    // Pad to a realistic delta so the restore is not trivially instant.
    let pad = root.join("payload");
    std::fs::create_dir_all(&pad).unwrap();
    for i in 0..extra_mib {
        std::fs::write(pad.join(format!("p{i:03}.dat")), gen_bytes(i, 1024 * 1024)).unwrap();
    }

    let store = ChunkStore::open_fs(&store_dir).unwrap();
    let snap = snapshot(
        &store,
        root,
        &SnapshotOptions {
            chunker: ChunkerConfig::PRODUCTION,
            exclude: vec![],
            parent: None,
            created_at: 4,
        },
    )
    .await
    .unwrap();

    println!("MARI_PROBE_MANIFEST={}", snap.manifest_id.as_str());
    println!(
        "MARI_PROBE_SEED_ENTRIES={} MARI_PROBE_SEED_CHUNKS={}",
        snap.manifest.entries.len(),
        snap.unique_chunks
    );
}
