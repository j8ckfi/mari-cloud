//! Content-defined chunking stability and base/delta deduplication.
//!
//! - Inserting one byte mid-file must re-cut only locally: >= 90% of the
//!   original chunks are reused.
//! - A fork of a base image shares every chunk (zero uploads); changing one
//!   file uploads only that file's new chunks.

mod common;

use std::collections::BTreeSet;

use common::{build_reference_tree, gen_bytes};
use mari_core::{
    delta_chunks, manifest_chunks, snapshot, ChunkStore, ChunkerConfig, SnapshotOptions,
};

fn test_chunker() -> ChunkerConfig {
    let c = ChunkerConfig {
        min: 2048,
        avg: 4096,
        max: 16384,
    };
    c.validate().unwrap();
    c
}

/// Snapshot a directory containing a single file with the given bytes and
/// return the set of chunk ids that file produced.
async fn chunkset_of_file(store: &ChunkStore, dir: &std::path::Path, bytes: &[u8]) -> BTreeSet<mari_core::ChunkId> {
    std::fs::create_dir_all(dir).unwrap();
    std::fs::write(dir.join("f.bin"), bytes).unwrap();
    let opts = SnapshotOptions {
        chunker: test_chunker(),
        exclude: vec![],
        parent: None,
        created_at: 0,
    };
    let snap = snapshot(store, dir, &opts).await.unwrap();
    manifest_chunks(&snap.manifest)
}

#[tokio::test]
async fn one_byte_insert_reuses_at_least_90_percent() {
    let tmp = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();

    let original = gen_bytes(7, 3 * 1024 * 1024);
    let mut mutated = original.clone();
    // Insert a single byte in the middle.
    mutated.insert(original.len() / 2, 0xAB);

    let s1 = chunkset_of_file(&store, &tmp.path().join("v1"), &original).await;
    let s2 = chunkset_of_file(&store, &tmp.path().join("v2"), &mutated).await;

    assert!(s1.len() > 100, "need many chunks to measure reuse, got {}", s1.len());
    let shared = s1.intersection(&s2).count();
    let reuse = shared as f64 / s1.len() as f64;
    assert!(
        reuse >= 0.90,
        "expected >= 90% chunk reuse after a 1-byte insert, got {:.1}% ({}/{})",
        reuse * 100.0,
        shared,
        s1.len()
    );
}

#[tokio::test]
async fn fork_shares_everything_then_delta_is_local() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();
    std::fs::create_dir_all(&src).unwrap();
    build_reference_tree(&src);

    let base_opts = SnapshotOptions {
        chunker: test_chunker(),
        exclude: vec![],
        parent: None,
        created_at: 10,
    };
    let base = snapshot(&store, &src, &base_opts).await.unwrap();

    // A fresh store had nothing: the base uploaded every distinct chunk.
    assert_eq!(base.uploaded_chunks, base.unique_chunks);
    assert_eq!(base.reused_chunks, 0);
    assert!(base.unique_chunks > 100, "base should have many chunks");

    // Fork: snapshot the identical tree with the base as parent. Everything is
    // already in the store, so nothing is uploaded and the delta is empty.
    let fork_opts = SnapshotOptions {
        chunker: test_chunker(),
        exclude: vec![],
        parent: Some(base.manifest_id.clone()),
        created_at: 11,
    };
    let fork = snapshot(&store, &src, &fork_opts).await.unwrap();
    assert_eq!(fork.uploaded_chunks, 0, "a fork of an identical tree uploads nothing");
    assert_eq!(fork.reused_chunks, fork.unique_chunks);
    assert_eq!(fork.unique_chunks, base.unique_chunks);

    let fork_delta = delta_chunks(&store, &fork.manifest).await.unwrap();
    assert!(
        fork_delta.is_empty(),
        "identical fork should have an empty delta, got {}",
        fork_delta.len()
    );

    // Now change exactly one small file and re-snapshot against the base. Only
    // that file's new chunk(s) are uploaded; the delta is exactly those chunks.
    std::fs::write(src.join("data").join("a.txt"), b"completely different contents").unwrap();
    common::chmod(&src.join("data").join("a.txt"), 0o600);

    let changed = snapshot(&store, &src, &fork_opts).await.unwrap();
    assert!(changed.uploaded_chunks >= 1);
    assert!(
        changed.uploaded_chunks < base.unique_chunks,
        "only the changed file's chunks should upload, got {} of {}",
        changed.uploaded_chunks,
        base.unique_chunks
    );

    let changed_delta = delta_chunks(&store, &changed.manifest).await.unwrap();
    assert_eq!(
        changed_delta.len(),
        changed.uploaded_chunks,
        "delta against the base chain should equal the newly-uploaded chunks"
    );
}
