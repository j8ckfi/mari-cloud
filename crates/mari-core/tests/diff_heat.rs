//! Diff classification (mode-only vs content) and heat-profile recording +
//! persistence.

mod common;

use mari_core::{
    ChunkStore, ChunkerConfig, HeatRecorder, SnapshotOptions, diff, load_heat, snapshot, store_heat,
};
use mari_proto::{ComputerId, HeatProfile};

fn small_chunker() -> ChunkerConfig {
    ChunkerConfig {
        min: 2048,
        avg: 4096,
        max: 16384,
    }
}

fn opts() -> SnapshotOptions {
    SnapshotOptions {
        chunker: small_chunker(),
        exclude: vec![],
        parent: None,
        created_at: 0,
    }
}

#[tokio::test]
async fn diff_distinguishes_mode_only_from_content_from_add_remove() {
    let tmp = tempfile::tempdir().unwrap();
    let src = tmp.path().join("src");
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();
    std::fs::create_dir_all(&src).unwrap();

    std::fs::write(src.join("keep.txt"), b"unchanged").unwrap();
    common::chmod(&src.join("keep.txt"), 0o644);
    std::fs::write(src.join("chmod_me.txt"), b"same bytes").unwrap();
    common::chmod(&src.join("chmod_me.txt"), 0o644);
    std::fs::write(src.join("edit_me.txt"), b"before").unwrap();
    std::fs::write(src.join("remove_me.txt"), b"doomed").unwrap();

    let before = snapshot(&store, &src, &opts()).await.unwrap();

    // Mutate: chmod one (mode only), edit one (content), remove one, add one.
    common::chmod(&src.join("chmod_me.txt"), 0o600);
    std::fs::write(src.join("edit_me.txt"), b"after, different length").unwrap();
    std::fs::remove_file(src.join("remove_me.txt")).unwrap();
    std::fs::write(src.join("added.txt"), b"brand new").unwrap();

    let after = snapshot(&store, &src, &opts()).await.unwrap();

    let d = diff(&before.manifest, &after.manifest);

    // Added / removed.
    assert!(d.added.iter().any(|e| e.path == "/added.txt"));
    assert!(d.removed.iter().any(|e| e.path == "/remove_me.txt"));
    assert_eq!(d.added.len(), 1);
    assert_eq!(d.removed.len(), 1);

    // chmod_me: mode changed, content did NOT.
    let chmod_change = d
        .modified
        .iter()
        .find(|m| m.path == "/chmod_me.txt")
        .expect("chmod_me should be modified");
    assert!(chmod_change.mode_changed);
    assert!(
        !chmod_change.content_changed,
        "chmod must not read as content change"
    );

    // edit_me: content changed.
    let edit_change = d
        .modified
        .iter()
        .find(|m| m.path == "/edit_me.txt")
        .expect("edit_me should be modified");
    assert!(edit_change.content_changed);
    assert!(!edit_change.mode_changed);

    // keep.txt is unchanged -> not reported at all.
    assert!(!d.modified.iter().any(|m| m.path == "/keep.txt"));

    let summary = d.summary();
    assert_eq!(summary.added, 1);
    assert_eq!(summary.removed, 1);
    assert_eq!(summary.modified, 2);

    // Diffing a manifest against itself is empty.
    assert!(diff(&after.manifest, &after.manifest).is_empty());
}

#[tokio::test]
async fn heat_recorder_dedups_and_preserves_first_seen_order() {
    let mut r = HeatRecorder::new();
    assert!(r.record("/boot/vmlinuz"));
    assert!(r.record("/etc/hostname"));
    assert!(!r.record("/boot/vmlinuz"), "repeat should not re-order");
    assert!(r.record("/usr/bin/agent"));
    assert!(!r.record("/etc/hostname"));

    let profile = r.profile();
    assert_eq!(
        profile.paths,
        vec![
            "/boot/vmlinuz".to_string(),
            "/etc/hostname".to_string(),
            "/usr/bin/agent".to_string(),
        ]
    );
    assert_eq!(r.len(), 3);
}

#[tokio::test]
async fn heat_profile_persists_and_reloads() {
    let tmp = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();
    let computer = ComputerId::new("computer-alpha");

    // Nothing stored yet.
    assert!(load_heat(&store, &computer).await.unwrap().is_none());

    let profile = HeatProfile {
        paths: vec!["/a".into(), "/b".into(), "/c".into()],
    };
    store_heat(&store, &computer, &profile).await.unwrap();

    let loaded = load_heat(&store, &computer).await.unwrap().unwrap();
    assert_eq!(loaded, profile);

    // Stored at the contracts path heat/{computer}.cbor.
    assert!(tmp.path().join("store/heat/computer-alpha.cbor").exists());

    // A recorder can be seeded from a loaded profile and extend it.
    let mut r = HeatRecorder::from_profile(&loaded);
    assert!(!r.record("/a"));
    assert!(r.record("/d"));
    assert_eq!(r.profile().paths, vec!["/a", "/b", "/c", "/d"]);
}
