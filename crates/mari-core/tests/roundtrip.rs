//! Snapshot -> wipe -> restore must be byte-identical: content, modes,
//! symlinks (including dangling), empty files, and files that span many chunks.

mod common;

use common::{build_reference_tree, read_tree};
use mari_core::{restore, snapshot, ChunkStore, ChunkerConfig, RestoreOptions, SnapshotOptions};
use mari_proto::EntryKind;

/// Small chunker so the multi-MB file is split into many chunks.
fn test_chunker() -> ChunkerConfig {
    let c = ChunkerConfig {
        min: 2048,
        avg: 4096,
        max: 16384,
    };
    c.validate().unwrap();
    c
}

#[tokio::test]
async fn snapshot_restore_is_byte_identical() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    let store_dir = tmp.path().join("store");
    let dst = tmp.path().join("dst");
    std::fs::create_dir_all(&src).unwrap();
    build_reference_tree(&src);

    let store = ChunkStore::open_fs(&store_dir).unwrap();
    let opts = SnapshotOptions {
        chunker: test_chunker(),
        exclude: vec![], // no exclusions: everything must round-trip
        parent: None,
        created_at: 100,
    };
    let snap = snapshot(&store, &src, &opts).await.unwrap();

    // The multi-MB file really did span many chunks.
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
    // Chunk lengths sum to the file size.
    assert_eq!(big.chunks.iter().map(|c| c.len).sum::<u64>(), big.size);

    // The manifest we get back from the store is the one we wrote.
    let reloaded = store.get_manifest(&snap.manifest_id).await.unwrap();
    assert_eq!(reloaded, snap.manifest);

    // Restore into a fresh directory and compare byte-for-byte.
    let stats = restore(&store, &snap.manifest, &dst, &RestoreOptions::default())
        .await
        .unwrap();
    assert!(stats.files >= 5);
    assert!(stats.symlinks == 3);

    let before = read_tree(&src);
    let after = read_tree(&dst);
    assert_eq!(before, after, "restored tree must be byte-identical");

    // Spot-check the required edge cases survived.
    assert!(matches!(
        after.get("empty.txt"),
        Some(common::Node::File { content, .. }) if content.is_empty()
    ));
    assert!(matches!(
        after.get("run.sh"),
        Some(common::Node::File { perms, .. }) if *perms == 0o755
    ));
    assert!(matches!(
        after.get("dangling"),
        Some(common::Node::Symlink { target }) if target == "this-target-does-not-exist"
    ));
    assert!(after.contains_key("weird name.txt"));
}

#[tokio::test]
async fn restore_honors_priority_order() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    let store_dir = tmp.path().join("store");
    let dst = tmp.path().join("dst");
    std::fs::create_dir_all(&src).unwrap();
    build_reference_tree(&src);

    let store = ChunkStore::open_fs(&store_dir).unwrap();
    let opts = SnapshotOptions {
        chunker: test_chunker(),
        exclude: vec![],
        parent: None,
        created_at: 1,
    };
    let snap = snapshot(&store, &src, &opts).await.unwrap();

    let priority = vec!["/data/a.txt".to_string(), "/big.bin".to_string()];
    let ropts = RestoreOptions {
        priority: priority.clone(),
    };
    let stats = restore(&store, &snap.manifest, &dst, &ropts).await.unwrap();

    // The two priority files were restored first, in order.
    assert_eq!(&stats.file_order[0], "/data/a.txt");
    assert_eq!(&stats.file_order[1], "/big.bin");
    // And every file was still restored exactly once.
    let mut seen = std::collections::HashSet::new();
    for p in &stats.file_order {
        assert!(seen.insert(p.clone()), "file restored twice: {p}");
    }

    // Still byte-identical regardless of order.
    assert_eq!(read_tree(&src), read_tree(&dst));
}

#[tokio::test]
async fn restore_rejects_path_traversal() {
    use mari_proto::{Manifest, ManifestEntry, MANIFEST_VERSION};

    let tmp = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();
    let dst = tmp.path().join("dst");

    // A hostile manifest whose entry path escapes the root.
    let evil = Manifest {
        version: MANIFEST_VERSION,
        parent: None,
        created_at: 0,
        entries: vec![ManifestEntry {
            path: "/../escaped.txt".to_string(),
            kind: EntryKind::File,
            mode: 0o100644,
            size: 0,
            symlink_target: None,
            chunks: vec![],
        }],
    };

    let err = restore(&store, &evil, &dst, &RestoreOptions::default())
        .await
        .expect_err("path traversal must be rejected");
    assert!(
        matches!(err, mari_core::Error::PathTraversal { .. }),
        "expected PathTraversal, got {err:?}"
    );

    // Nothing was written outside the root.
    let escaped = tmp.path().join("escaped.txt");
    assert!(!escaped.exists(), "traversal wrote outside the root!");
}
