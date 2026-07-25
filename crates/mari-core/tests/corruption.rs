//! A chunk corrupted on disk must be caught on read (blake3 verify-then-use),
//! with a typed error naming the chunk — never returned as silent wrong bytes.

use std::path::{Path, PathBuf};

use mari_core::{ChunkStore, ChunkerConfig, RestoreOptions, SnapshotOptions, restore, snapshot};
use mari_proto::ChunkId;

fn on_disk_chunk_path(store_dir: &Path, id: &ChunkId) -> PathBuf {
    let s = id.as_str();
    store_dir.join("chunks").join(&s[..2]).join(s)
}

async fn snapshot_single_chunk_file(
    store: &ChunkStore,
    dir: &Path,
) -> (mari_proto::Manifest, ChunkId) {
    std::fs::create_dir_all(dir).unwrap();
    // Below the chunker minimum, so the file is exactly one chunk.
    std::fs::write(dir.join("secret.txt"), b"the original, correct bytes").unwrap();
    let opts = SnapshotOptions {
        chunker: ChunkerConfig {
            min: 2048,
            avg: 4096,
            max: 16384,
        },
        exclude: vec![],
        parent: None,
        created_at: 0,
    };
    let snap = snapshot(store, dir, &opts).await.unwrap();
    let entry = snap
        .manifest
        .entries
        .iter()
        .find(|e| e.path == "/secret.txt")
        .unwrap();
    assert_eq!(entry.chunks.len(), 1, "file should be a single chunk");
    let id = entry.chunks[0].chunk.clone();
    (snap.manifest.clone(), id)
}

#[tokio::test]
async fn blake3_mismatch_detected_on_restore() {
    let tmp = tempfile::tempdir().unwrap();
    let store_dir = tmp.path().join("store");
    let store = ChunkStore::open_fs(&store_dir).unwrap();
    let (manifest, victim) = snapshot_single_chunk_file(&store, &tmp.path().join("src")).await;

    // Craft a *validly compressed but wrong* body: store different bytes under
    // their own id, then copy that object over the victim's key. It will
    // decompress cleanly but hash to the wrong id.
    let wrong = store
        .put_chunk(b"these are not the bytes you are looking for")
        .await
        .unwrap();
    let wrong_bytes = std::fs::read(on_disk_chunk_path(&store_dir, &wrong)).unwrap();
    std::fs::write(on_disk_chunk_path(&store_dir, &victim), &wrong_bytes).unwrap();

    let err = restore(
        &store,
        &manifest,
        &tmp.path().join("dst"),
        &RestoreOptions::default(),
    )
    .await
    .expect_err("corruption must be detected");

    match &err {
        mari_core::Error::ChunkCorrupted { chunk, actual } => {
            assert_eq!(chunk, &victim, "error must name the corrupted chunk");
            assert_eq!(actual, &wrong, "error reports the hash of the bad bytes");
        }
        other => panic!("expected ChunkCorrupted, got {other:?}"),
    }
    assert_eq!(err.corrupt_chunk(), Some(&victim));
}

#[tokio::test]
async fn undecompressable_body_detected_on_restore() {
    let tmp = tempfile::tempdir().unwrap();
    let store_dir = tmp.path().join("store");
    let store = ChunkStore::open_fs(&store_dir).unwrap();
    let (manifest, victim) = snapshot_single_chunk_file(&store, &tmp.path().join("src")).await;

    // Overwrite the body with bytes that are not a zstd frame at all.
    std::fs::write(
        on_disk_chunk_path(&store_dir, &victim),
        b"\x00\x01\x02 not a zstd frame \xff\xfe",
    )
    .unwrap();

    let err = restore(
        &store,
        &manifest,
        &tmp.path().join("dst"),
        &RestoreOptions::default(),
    )
    .await
    .expect_err("undecompressable chunk must be detected");
    assert!(
        matches!(&err, mari_core::Error::ChunkDecompress { chunk } if chunk == &victim),
        "expected ChunkDecompress naming {victim}, got {err:?}"
    );
    assert_eq!(err.corrupt_chunk(), Some(&victim));
}

#[tokio::test]
async fn direct_get_chunk_verifies() {
    // The verification lives in the store, not just restore.
    let tmp = tempfile::tempdir().unwrap();
    let store_dir = tmp.path().join("store");
    let store = ChunkStore::open_fs(&store_dir).unwrap();

    let good = store.put_chunk(b"hello world").await.unwrap();
    assert_eq!(store.get_chunk(&good).await.unwrap(), b"hello world");

    // Corrupt it and confirm the read refuses to hand back bytes.
    let other = store
        .put_chunk(b"a different payload entirely")
        .await
        .unwrap();
    let other_bytes = std::fs::read(on_disk_chunk_path(&store_dir, &other)).unwrap();
    std::fs::write(on_disk_chunk_path(&store_dir, &good), &other_bytes).unwrap();

    let err = store
        .get_chunk(&good)
        .await
        .expect_err("must not return unverified bytes");
    assert_eq!(err.corrupt_chunk(), Some(&good));
}
