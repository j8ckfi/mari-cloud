//! Garbage collection: the deletes-a-computer path. Two levels of teeth.
//!
//! 1. A focused test of the safety window and reachability: a reachable chunk
//!    is never deleted; a young unreachable chunk survives the window; an old
//!    unreachable chunk is swept; dry-run deletes nothing.
//! 2. A property test over randomized manifest histories (with parent chains)
//!    and retention subsets: for any history, plan+execute never deletes a
//!    chunk reachable from a retained manifest, deletes an unreachable chunk
//!    only once past the window, and a dry run mutates nothing.

use std::collections::{BTreeSet, HashSet};
use std::path::{Path, PathBuf};

use filetime::FileTime;
use mari_core::{ChunkStore, GcAction, GcMode, execute, plan_at};
use mari_proto::{
    ChunkId, ChunkRef, EntryKind, MANIFEST_VERSION, Manifest, ManifestEntry, ManifestId,
};
use proptest::prelude::*;

const NOW: u64 = 1_000_000;

fn chunk_path(store_dir: &Path, id: &ChunkId) -> PathBuf {
    let s = id.as_str();
    store_dir.join("chunks").join(&s[..2]).join(s)
}

/// Force a chunk's stored age by setting its file mtime to `NOW - age`.
fn set_age(store_dir: &Path, id: &ChunkId, age: u64) {
    let mtime = FileTime::from_unix_time((NOW - age) as i64, 0);
    filetime::set_file_mtime(chunk_path(store_dir, id), mtime).unwrap();
}

/// Store a manifest whose file entries reference `subset` of `chunk_ids`.
async fn store_manifest(
    store: &ChunkStore,
    chunk_ids: &[ChunkId],
    subset: &[usize],
    parent: Option<ManifestId>,
) -> ManifestId {
    let mut entries: Vec<ManifestEntry> = subset
        .iter()
        .map(|&i| ManifestEntry {
            path: format!("/f{i:03}"),
            kind: EntryKind::File,
            mode: 0o100644,
            size: 1,
            symlink_target: None,
            chunks: vec![ChunkRef {
                chunk: chunk_ids[i].clone(),
                len: 1,
            }],
        })
        .collect();
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    let m = Manifest {
        version: MANIFEST_VERSION,
        parent,
        created_at: 0,
        entries,
    };
    store.put_manifest(&m).await.unwrap()
}

#[tokio::test]
async fn window_and_reachability_are_respected() {
    let tmp = tempfile::tempdir().unwrap();
    let store_dir = tmp.path().join("store");
    let store = ChunkStore::open_fs(&store_dir).unwrap();

    let live = store
        .put_chunk(b"referenced by a retained manifest")
        .await
        .unwrap();
    let young = store.put_chunk(b"a young orphan chunk").await.unwrap();
    let old = store.put_chunk(b"an old orphan chunk").await.unwrap();

    // live is old on disk, but reachability trumps age; young/old are orphans.
    set_age(&store_dir, &live, 100_000);
    set_age(&store_dir, &young, 10);
    set_age(&store_dir, &old, 10_000);

    let retained = store_manifest(&store, std::slice::from_ref(&live), &[0], None).await;

    let window = 100;
    let plan = plan_at(&store, std::slice::from_ref(&retained), window, NOW)
        .await
        .unwrap();

    assert_eq!(plan.live_count(), 1);
    assert!(plan.live.contains(&live));
    assert!(
        !plan.dead.iter().any(|d| d.chunk == live),
        "live chunk must not be a dead candidate"
    );

    let young_d = plan.dead.iter().find(|d| d.chunk == young).unwrap();
    assert!(
        young_d.protected,
        "young orphan must be protected by the window"
    );
    assert_eq!(young_d.age_secs, 10);
    let old_d = plan.dead.iter().find(|d| d.chunk == old).unwrap();
    assert!(!old_d.protected, "old orphan must be deletable");
    assert_eq!(old_d.age_secs, 10_000);

    // Dry-run changes nothing on disk.
    let dry = execute(
        &store,
        &plan,
        std::slice::from_ref(&retained),
        GcMode::DryRun,
    )
    .await
    .unwrap();
    assert!(dry.deleted.is_empty());
    assert!(store.has_chunk(&old).await.unwrap());
    assert!(
        dry.audit
            .iter()
            .any(|a| a.chunk == old && a.action == GcAction::WouldDelete)
    );
    assert!(
        dry.audit
            .iter()
            .any(|a| a.chunk == young && a.action == GcAction::ProtectedByWindow)
    );

    // Delete: only the old orphan is swept.
    let rep = execute(
        &store,
        &plan,
        std::slice::from_ref(&retained),
        GcMode::Delete,
    )
    .await
    .unwrap();
    assert_eq!(rep.deleted, vec![old.clone()]);
    assert!(
        !store.has_chunk(&old).await.unwrap(),
        "old orphan should be gone"
    );
    assert!(
        store.has_chunk(&young).await.unwrap(),
        "young orphan must survive the window"
    );
    assert!(
        store.has_chunk(&live).await.unwrap(),
        "reachable chunk must never be deleted"
    );
    assert!(
        rep.audit
            .iter()
            .any(|a| a.chunk == old && a.action == GcAction::Deleted)
    );
}

#[tokio::test]
async fn missing_parent_fails_the_plan_rather_than_deleting() {
    // A retained manifest with a dangling parent must error, not silently
    // under-count the live set (which would delete the base image's chunks).
    let tmp = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();
    let c = store.put_chunk(b"child chunk").await.unwrap();
    let bogus_parent = ManifestId::new("0".repeat(64));
    let child = store_manifest(&store, &[c], &[0], Some(bogus_parent)).await;

    let err = plan_at(&store, &[child], 0, NOW)
        .await
        .expect_err("must fail on missing parent");
    assert!(
        matches!(err, mari_core::Error::ManifestNotFound(_)),
        "got {err:?}"
    );
}

const NC: usize = 6; // distinct chunks
const NM: usize = 5; // manifests in the history

proptest! {
    #![proptest_config(ProptestConfig::with_cases(40))]

    #[test]
    fn gc_never_deletes_reachable_and_respects_window(
        membership in prop::collection::vec(prop::collection::vec(any::<bool>(), NC), NM),
        parent_raw in prop::collection::vec(any::<u8>(), NM),
        retained_sel in prop::collection::vec(any::<bool>(), NM),
        ages in prop::collection::vec(0u64..400, NC),
        window in 0u64..400,
    ) {
        let rt = tokio::runtime::Builder::new_current_thread().build().unwrap();

        // Acyclic parent map: parents[i] is None or an index < i.
        let parents: Vec<Option<usize>> = (0..NM)
            .map(|i| {
                if i == 0 {
                    None
                } else {
                    let r = (parent_raw[i] as usize) % (i + 1);
                    if r == i { None } else { Some(r) }
                }
            })
            .collect();

        rt.block_on(async {
            let tmp = tempfile::tempdir().unwrap();
            let store_dir = tmp.path().join("store");
            let store = ChunkStore::open_fs(&store_dir).unwrap();

            // Put every chunk (including pure orphans) and age it.
            let mut chunk_ids: Vec<ChunkId> = Vec::with_capacity(NC);
            for (i, &age) in ages.iter().enumerate() {
                let blob = format!("gc-prop-chunk-{i}").into_bytes();
                let id = store.put_chunk(&blob).await.unwrap();
                set_age(&store_dir, &id, age);
                chunk_ids.push(id);
            }

            // Store the manifest history; parents refer to earlier manifests.
            let mut manifest_ids: Vec<ManifestId> = Vec::with_capacity(NM);
            for i in 0..NM {
                let parent_id = parents[i].map(|p| manifest_ids[p].clone());
                let subset: Vec<usize> = (0..NC).filter(|&j| membership[i][j]).collect();
                let id = store_manifest(&store, &chunk_ids, &subset, parent_id).await;
                manifest_ids.push(id);
            }
            let retained_ids: Vec<ManifestId> = (0..NM)
                .filter(|&i| retained_sel[i])
                .map(|i| manifest_ids[i].clone())
                .collect();

            // Expected live set: reachable from any retained manifest via parents.
            let mut live_idx: BTreeSet<usize> = BTreeSet::new();
            for m in (0..NM).filter(|&i| retained_sel[i]) {
                let mut cur = Some(m);
                let mut seen: HashSet<usize> = HashSet::new();
                while let Some(x) = cur {
                    if !seen.insert(x) {
                        break;
                    }
                    for (j, &member) in membership[x].iter().enumerate() {
                        if member {
                            live_idx.insert(j);
                        }
                    }
                    cur = parents[x];
                }
            }
            let expected_live: BTreeSet<ChunkId> =
                live_idx.iter().map(|&i| chunk_ids[i].clone()).collect();
            let expected_deletable: BTreeSet<ChunkId> = (0..NC)
                .filter(|i| !live_idx.contains(i) && ages[*i] >= window)
                .map(|i| chunk_ids[i].clone())
                .collect();
            let expected_protected: BTreeSet<ChunkId> = (0..NC)
                .filter(|i| !live_idx.contains(i) && ages[*i] < window)
                .map(|i| chunk_ids[i].clone())
                .collect();

            let plan = plan_at(&store, &retained_ids, window, NOW).await.unwrap();

            // Live set exactly matches; no live chunk is a dead candidate.
            prop_assert_eq!(&plan.live, &expected_live);
            let deletable: BTreeSet<ChunkId> =
                plan.deletable().map(|d| d.chunk.clone()).collect();
            let protected: BTreeSet<ChunkId> =
                plan.protected().map(|d| d.chunk.clone()).collect();
            prop_assert_eq!(&deletable, &expected_deletable);
            prop_assert_eq!(&protected, &expected_protected);
            for d in &plan.dead {
                prop_assert!(!expected_live.contains(&d.chunk));
            }

            // Dry run mutates nothing.
            let dry = execute(&store, &plan, &retained_ids, GcMode::DryRun).await.unwrap();
            prop_assert!(dry.deleted.is_empty());
            let after_dry: BTreeSet<ChunkId> =
                store.list_chunk_ids().await.unwrap().into_iter().collect();
            let all_ids: BTreeSet<ChunkId> = chunk_ids.iter().cloned().collect();
            prop_assert_eq!(&after_dry, &all_ids);

            // Delete sweeps exactly the deletable set.
            let rep = execute(&store, &plan, &retained_ids, GcMode::Delete).await.unwrap();
            let deleted: BTreeSet<ChunkId> = rep.deleted.iter().cloned().collect();
            prop_assert_eq!(&deleted, &expected_deletable);

            // Reachable and protected chunks survive; deletable ones are gone.
            for id in &expected_live {
                prop_assert!(store.has_chunk(id).await.unwrap(), "reachable chunk was deleted");
            }
            for id in &expected_protected {
                prop_assert!(store.has_chunk(id).await.unwrap(), "windowed chunk was deleted");
            }
            for id in &expected_deletable {
                prop_assert!(!store.has_chunk(id).await.unwrap(), "dead chunk survived");
            }

            Ok(())
        })?;
    }
}
