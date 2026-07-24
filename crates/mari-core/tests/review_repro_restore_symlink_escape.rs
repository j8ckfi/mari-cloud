//! review_repro_restore_symlink_escape — restore() writes THROUGH a symlink
//! that already exists on a dirty target, escaping the root.
//!
//! restore()'s docstring promises "no file is ever written *through* a restored
//! symlink" — true for symlinks the *manifest* creates (they are materialized
//! last). But `safe_join` validates paths only lexically and `write_file` uses
//! `std::fs::write` / `create_dir_all`, both of which follow *pre-existing*
//! symlinks on disk. Combined with the revert path restoring into the un-wiped
//! live root (`crates/marid/src/supervisor.rs` ~L272), a directory symlink
//! already on disk lets a manifest file entry write outside the root.
//!
//! Ignored so the main suite stays green. Prove it with:
//!   cargo test -p mari-core --test review_repro_restore_symlink_escape -- --ignored

use mari_core::{restore, ChunkStore, RestoreOptions};
use mari_proto::{ChunkRef, EntryKind, Manifest, ManifestEntry, MANIFEST_VERSION};

#[tokio::test]
#[ignore = "documents that restore() follows a pre-existing on-disk symlink and escapes the root"]
async fn restore_writes_through_preexisting_symlink() {
    let tmp = tempfile::tempdir().unwrap();
    let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();

    let root = tmp.path().join("root"); // live computer filesystem
    let outside = tmp.path().join("outside"); // strictly OUTSIDE the root
    std::fs::create_dir_all(&root).unwrap();
    std::fs::create_dir_all(&outside).unwrap();

    // A directory symlink already present on the (dirty) live disk: root/sub -> outside.
    std::os::unix::fs::symlink(&outside, root.join("sub")).unwrap();

    // Upload the chunk the file entry will reference.
    let content = b"payload written outside the root";
    let chunk = store.put_chunk(content).await.unwrap();

    // A manifest with a file under /sub. safe_join accepts /sub/pwned lexically
    // (root/sub/pwned starts_with root); it does not resolve the symlink.
    let manifest = Manifest {
        version: MANIFEST_VERSION,
        parent: None,
        created_at: 0,
        entries: vec![ManifestEntry {
            path: "/sub/pwned".to_string(),
            kind: EntryKind::File,
            mode: 0o100644,
            size: content.len() as u64,
            symlink_target: None,
            chunks: vec![ChunkRef {
                chunk,
                len: content.len() as u64,
            }],
        }],
    };

    restore(&store, &manifest, &root, &RestoreOptions::default())
        .await
        .unwrap();

    // The file landed OUTSIDE the root, through the pre-existing symlink.
    let escaped = outside.join("pwned");
    assert!(
        escaped.exists(),
        "expected write to escape via the symlink to {}",
        escaped.display()
    );
    assert_eq!(std::fs::read(&escaped).unwrap(), content);
}
