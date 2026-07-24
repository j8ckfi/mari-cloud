//! gc_resurrection — the GC "resurrection" race is guarded at execute time.
//!
//! A chunk can be OLD and unreferenced when the sweep is *planned* (deletable),
//! yet become REFERENCED again before the sweep *executes*. Because chunks are
//! content-addressed, a snapshot on any computer dedups against the store,
//! reuses the already-present chunk, and advances a manifest head — without
//! rewriting the chunk, so its store-mtime (the safety window's only signal)
//! stays old. The window cannot see this; only a fresh live-set check can.
//!
//! `execute` therefore never trusts the plan's frozen `live` set for a deletion
//! decision: it re-collects the live set from the *current* retained set and
//! refuses to delete any candidate that is live again. This test proves that
//! guard — the resurrected chunk survives, is audited as `Resurrected`, and the
//! now-current head restores byte-identically.
//!
//! (Was an `#[ignore]`d repro documenting the bug; now a live regression test.)

use std::path::{Path, PathBuf};

use filetime::FileTime;
use mari_core::{execute, plan_at, ChunkId, ChunkStore, GcAction, GcMode, RestoreOptions};
use mari_proto::{ChunkRef, EntryKind, Manifest, ManifestEntry, ManifestId, MANIFEST_VERSION};

const NOW: u64 = 1_000_000;

fn chunk_path(store_dir: &Path, id: &ChunkId) -> PathBuf {
    let s = id.as_str();
    store_dir.join("chunks").join(&s[..2]).join(s)
}

async fn manifest_referencing(store: &ChunkStore, chunk: &ChunkId, len: u64) -> ManifestId {
    let m = Manifest {
        version: MANIFEST_VERSION,
        parent: None,
        created_at: 0,
        entries: vec![ManifestEntry {
            path: "/resurrected.bin".to_string(),
            kind: EntryKind::File,
            mode: 0o100644,
            size: len,
            symlink_target: None,
            chunks: vec![ChunkRef {
                chunk: chunk.clone(),
                len,
            }],
        }],
    };
    store.put_manifest(&m).await.unwrap()
}

#[tokio::test]
async fn gc_does_not_delete_a_resurrected_chunk() {
    let tmp = tempfile::tempdir().unwrap();
    let store_dir = tmp.path().join("store");
    let store = ChunkStore::open_fs(&store_dir).unwrap();

    // A chunk written long ago, currently unreferenced by any retained manifest.
    let content = b"resurrect me: old content that reappears";
    let chunk = store.put_chunk(content).await.unwrap();
    // Force it "old": well past any reasonable safety window.
    filetime::set_file_mtime(
        chunk_path(&store_dir, &chunk),
        FileTime::from_unix_time((NOW - 10_000) as i64, 0),
    )
    .unwrap();

    // PLAN with nothing retained → the chunk is dead + old → deletable.
    let window = 100;
    let plan = plan_at(&store, &[], window, NOW).await.unwrap();
    assert!(
        plan.deletable().any(|d| d.chunk == chunk),
        "precondition: the old orphan is a deletable candidate"
    );

    // BETWEEN PLAN AND EXECUTE: a new snapshot references the chunk. A real
    // snapshot dedups against the store (`missing_chunks`), finds the chunk
    // already present, and does NOT re-upload it — so its mtime stays OLD.
    // We model exactly that: write a manifest that references the existing
    // chunk, without touching the chunk body.
    assert!(
        store.has_chunk(&chunk).await.unwrap(),
        "the chunk is still present, so a concurrent snapshot would dedup it"
    );
    let new_head = manifest_referencing(&store, &chunk, content.len() as u64).await;
    // The DO advances the manifest head to `new_head`; it is now RETAINED/live.

    // EXECUTE against the CURRENT retained set (which now includes `new_head`).
    // `execute` re-collects the live set at execution time, so it sees the chunk
    // is live again and refuses to delete it — the stale plan does not win.
    let report = execute(
        &store,
        &plan,
        std::slice::from_ref(&new_head),
        GcMode::Delete,
    )
    .await
    .unwrap();
    assert!(
        !report.deleted.contains(&chunk),
        "execute must NOT delete a chunk the current head depends on"
    );
    assert!(
        report
            .audit
            .iter()
            .any(|a| a.chunk == chunk && a.action == GcAction::Resurrected),
        "the sweep must record the chunk as resurrected, not deleted"
    );
    assert!(
        store.has_chunk(&chunk).await.unwrap(),
        "the live chunk survives — GC re-verified liveness at execute time"
    );

    // Safety made concrete: restoring the now-current head succeeds and its
    // content is byte-identical, because its chunk was preserved.
    let head = store.get_manifest(&new_head).await.unwrap();
    let dst = tmp.path().join("dst");
    mari_core::restore(&store, &head, &dst, &RestoreOptions::default())
        .await
        .expect("restore of the live head must succeed: its chunk was preserved");
    let restored = std::fs::read(dst.join("resurrected.bin")).unwrap();
    assert_eq!(
        restored, content,
        "restored file must be byte-identical to the original content"
    );
}

/// A genuinely-dead chunk (still absent from the retained set at execute time)
/// is still swept — the resurrection guard tightens deletion, it does not
/// disable it.
#[tokio::test]
async fn gc_still_deletes_a_chunk_that_stays_dead() {
    let tmp = tempfile::tempdir().unwrap();
    let store_dir = tmp.path().join("store");
    let store = ChunkStore::open_fs(&store_dir).unwrap();

    let content = b"truly dead: never referenced again";
    let chunk = store.put_chunk(content).await.unwrap();
    filetime::set_file_mtime(
        chunk_path(&store_dir, &chunk),
        FileTime::from_unix_time((NOW - 10_000) as i64, 0),
    )
    .unwrap();

    let window = 100;
    let plan = plan_at(&store, &[], window, NOW).await.unwrap();
    assert!(plan.deletable().any(|d| d.chunk == chunk));

    // Retained set at execute time is still empty: nothing revived the chunk.
    let report = execute(&store, &plan, &[], GcMode::Delete).await.unwrap();
    assert!(
        report.deleted.contains(&chunk),
        "an unreferenced, aged-out chunk must still be swept"
    );
    assert!(!store.has_chunk(&chunk).await.unwrap());
}
