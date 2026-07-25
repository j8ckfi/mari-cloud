//! review_repro_restore_symlink_escape — a symlink already on disk must never
//! redirect a restore outside its root.
//!
//! # The original finding
//!
//! `restore()` validated entry paths *lexically* (`/sub/pwned` contains no
//! `..`, so `root/sub/pwned` "is under" `root`) and then handed the composed
//! path to `std::fs::write` / `create_dir_all`, which resolve the whole path
//! through the kernel and follow every symlink on the way. With `root/sub`
//! already a symlink to `/outside` — the situation the revert path (spec 5.3)
//! hands you for free, because it restores into the **live, dirty** root — the
//! bytes landed at `/outside/pwned`. A root-escape write primitive.
//!
//! # The decided semantics
//!
//! The escape is prevented by **replacing** the conflicting node, not by
//! failing the call. Restore is authoritative: the manifest is the truth about
//! the tree (spec 5.3, "the user keeps the changes or restores the manifest"),
//! and revert is the *recovery* path. A restore that aborted because a run had
//! left a stale symlink behind would let any run permanently deny its own
//! computer the ability to revert — the defect traded for a denial of service.
//! So the file lands **inside** the root and the call succeeds.
//!
//! What is absolute is the other half: nothing outside the root is created,
//! written, unlinked, or chmod'd, ever. Every test below asserts both halves.
//!
//! The one case that *does* fail with a typed error is a non-empty directory
//! where the manifest declares a file: replacing it would mean deleting data
//! the manifest does not mention, which this layer refuses to do (the revert
//! path's prune removes such children first, so restore never sees it).
//!
//! Every case here runs in the main suite. Nothing is `#[ignore]`d.

mod common;

use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::Path;

use mari_core::{
    ChunkStore, Error, ManifestEntry, RestoreOptions, RootDir, SnapshotOptions, restore, snapshot,
};
use mari_proto::{ChunkRef, EntryKind, MANIFEST_VERSION, Manifest};

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

fn dir_entry(path: &str, mode: u32) -> ManifestEntry {
    ManifestEntry {
        path: path.to_string(),
        kind: EntryKind::Dir,
        mode: 0o40000 | mode,
        size: 0,
        symlink_target: None,
        chunks: Vec::new(),
    }
}

fn symlink_entry(path: &str, target: &str) -> ManifestEntry {
    ManifestEntry {
        path: path.to_string(),
        kind: EntryKind::Symlink,
        mode: 0o120777,
        size: target.len() as u64,
        symlink_target: Some(target.to_string()),
        chunks: Vec::new(),
    }
}

/// Upload `content` and build the file entry that names it.
async fn file_entry(store: &ChunkStore, path: &str, content: &[u8]) -> ManifestEntry {
    let chunk = store.put_chunk(content).await.unwrap();
    ManifestEntry {
        path: path.to_string(),
        kind: EntryKind::File,
        mode: 0o100644,
        size: content.len() as u64,
        symlink_target: None,
        chunks: vec![ChunkRef {
            chunk,
            len: content.len() as u64,
        }],
    }
}

/// A manifest from `entries`, path-sorted the way `snapshot` emits them (pass 1
/// of `restore` relies on parents preceding their children).
fn manifest_of(mut entries: Vec<ManifestEntry>) -> Manifest {
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Manifest {
        version: MANIFEST_VERSION,
        parent: None,
        created_at: 0,
        entries,
    }
}

/// Every name directly inside `dir`, sorted. Used to prove an outside directory
/// gained nothing.
fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

/// The path exists and is a real directory (not a symlink to one).
fn is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false)
}

/// The path exists and is a regular file (not a symlink to one).
fn is_real_file(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_file())
        .unwrap_or(false)
}

/// A scratch layout: a store, a live `root`, and an `outside` directory that
/// nothing a restore does may ever touch. `outside` starts with one sentinel
/// file so "unchanged" is an assertion with teeth.
struct Fixture {
    _tmp: tempfile::TempDir,
    store: ChunkStore,
    root: std::path::PathBuf,
    outside: std::path::PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("sentinel"), b"DO-NOT-TOUCH").unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            _tmp: tmp,
            store,
            root,
            outside,
        }
    }

    /// The outside directory is exactly as it was left: same entries, same
    /// sentinel bytes, same mode.
    fn assert_outside_pristine(&self) {
        assert_eq!(
            names_in(&self.outside),
            vec!["sentinel".to_string()],
            "the restore created something outside the root at {}",
            self.outside.display()
        );
        assert_eq!(
            std::fs::read(self.outside.join("sentinel")).unwrap(),
            b"DO-NOT-TOUCH",
            "the restore wrote through to a file outside the root"
        );
        assert_eq!(
            std::fs::metadata(&self.outside).unwrap().mode() & 0o7777,
            0o755,
            "the restore chmod'd a directory outside the root"
        );
    }
}

// ---------------------------------------------------------------------------
// 1. the original repro, inverted: the escape is prevented
// ---------------------------------------------------------------------------

#[tokio::test]
async fn preexisting_directory_symlink_does_not_redirect_a_file_write() {
    let fx = Fixture::new();
    let content = b"payload that must stay inside the root";

    // A directory symlink already present on the (dirty) live disk:
    // root/sub -> outside. This is what the finding exploited.
    symlink(&fx.outside, fx.root.join("sub")).unwrap();

    let manifest = manifest_of(vec![file_entry(&fx.store, "/sub/pwned", content).await]);
    let stats = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .expect("restore is authoritative: it replaces the symlink rather than failing");

    assert_eq!(stats.files, 1);
    fx.assert_outside_pristine();
    assert!(
        !fx.outside.join("pwned").exists(),
        "the write escaped the root"
    );
    // The symlink was replaced by the real directory the manifest implies, and
    // the bytes landed inside.
    assert!(
        is_real_dir(&fx.root.join("sub")),
        "root/sub must be a real directory"
    );
    assert_eq!(std::fs::read(fx.root.join("sub/pwned")).unwrap(), content);
}

// ---------------------------------------------------------------------------
// 2. the symlink is not the first component
// ---------------------------------------------------------------------------

#[tokio::test]
async fn nested_symlinked_component_does_not_redirect_a_file_write() {
    let fx = Fixture::new();
    let content = b"deep payload";

    // root/a is a genuine directory; only the *second* component is the trap.
    std::fs::create_dir_all(fx.root.join("a")).unwrap();
    symlink(&fx.outside, fx.root.join("a/b")).unwrap();

    let manifest = manifest_of(vec![
        dir_entry("/a", 0o755),
        dir_entry("/a/b", 0o755),
        file_entry(&fx.store, "/a/b/deep", content).await,
    ]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    fx.assert_outside_pristine();
    assert!(is_real_dir(&fx.root.join("a/b")));
    assert_eq!(std::fs::read(fx.root.join("a/b/deep")).unwrap(), content);
}

// ---------------------------------------------------------------------------
// 3. a symlink pointing *inside* the root is still a redirect
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_symlink_pointing_inside_the_root_is_still_replaced() {
    let fx = Fixture::new();
    let content = b"must not land in /real";

    // root/real is a genuine directory inside the root; root/sub aliases it.
    // Following the alias would not escape the root, but it would still make
    // the restored tree wrong: /sub and /real would share one inode and /real
    // would gain a file the manifest never named.
    std::fs::create_dir_all(fx.root.join("real")).unwrap();
    std::fs::write(fx.root.join("real/keep"), b"keep").unwrap();
    symlink("real", fx.root.join("sub")).unwrap();

    let manifest = manifest_of(vec![
        dir_entry("/sub", 0o755),
        file_entry(&fx.store, "/sub/f", content).await,
    ]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    assert!(
        is_real_dir(&fx.root.join("sub")),
        "root/sub must be a real directory, not an alias"
    );
    assert_eq!(std::fs::read(fx.root.join("sub/f")).unwrap(), content);
    assert_eq!(
        names_in(&fx.root.join("real")),
        vec!["keep".to_string()],
        "the aliased directory must not have gained the file"
    );
    fx.assert_outside_pristine();
}

// ---------------------------------------------------------------------------
// 4. the parent is a dangling symlink
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_dangling_symlink_parent_is_replaced_not_followed() {
    let fx = Fixture::new();
    let content = b"payload under a dead link";

    // root/dead points at a path that does not exist. `create_dir_all` would
    // have materialized the *target* (creating outside/never/), which is a
    // write outside the root just as much as the others.
    let never = fx.outside.join("never");
    symlink(&never, fx.root.join("dead")).unwrap();

    let manifest = manifest_of(vec![file_entry(&fx.store, "/dead/f", content).await]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    assert!(
        !never.exists(),
        "the dangling link's target was materialized outside the root"
    );
    fx.assert_outside_pristine();
    assert!(is_real_dir(&fx.root.join("dead")));
    assert_eq!(std::fs::read(fx.root.join("dead/f")).unwrap(), content);
}

// ---------------------------------------------------------------------------
// 5. a symlink occupies a path the manifest declares as a directory
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_symlink_where_the_manifest_declares_a_directory_is_replaced() {
    let fx = Fixture::new();
    let content = b"inside";

    symlink(&fx.outside, fx.root.join("sub")).unwrap();

    // The manifest declares /sub as a directory with an explicit mode. Both the
    // mkdir and the later chmod must land on the replacement, never on the
    // symlink's target.
    let manifest = manifest_of(vec![
        dir_entry("/sub", 0o750),
        file_entry(&fx.store, "/sub/f", content).await,
    ]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    fx.assert_outside_pristine(); // includes the outside directory's mode
    let meta = std::fs::symlink_metadata(fx.root.join("sub")).unwrap();
    assert!(
        meta.file_type().is_dir(),
        "root/sub must be a real directory"
    );
    assert_eq!(
        meta.mode() & 0o7777,
        0o750,
        "the manifest's directory mode must be applied to the replacement"
    );
    assert_eq!(std::fs::read(fx.root.join("sub/f")).unwrap(), content);
}

// ---------------------------------------------------------------------------
// 6. a symlink sits at the leaf path itself
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_symlink_at_the_leaf_file_path_is_replaced_not_written_through() {
    let fx = Fixture::new();
    let content = b"manifest bytes";

    // root/f -> outside/sentinel. `std::fs::write` would have overwritten the
    // sentinel; O_EXCL|O_NOFOLLOW plus unlink-and-recreate does not.
    symlink(fx.outside.join("sentinel"), fx.root.join("f")).unwrap();

    let manifest = manifest_of(vec![file_entry(&fx.store, "/f", content).await]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    fx.assert_outside_pristine();
    assert!(
        is_real_file(&fx.root.join("f")),
        "root/f must be a regular file"
    );
    assert_eq!(std::fs::read(fx.root.join("f")).unwrap(), content);
}

// ---------------------------------------------------------------------------
// 7. the kind conflict in the other direction
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_empty_directory_where_the_manifest_declares_a_file_is_replaced() {
    let fx = Fixture::new();
    let content = b"file, not a directory";

    std::fs::create_dir_all(fx.root.join("f")).unwrap();

    let manifest = manifest_of(vec![file_entry(&fx.store, "/f", content).await]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    assert!(is_real_file(&fx.root.join("f")));
    assert_eq!(std::fs::read(fx.root.join("f")).unwrap(), content);
}

#[tokio::test]
async fn a_non_empty_directory_where_the_manifest_declares_a_file_errors_rather_than_deleting() {
    let fx = Fixture::new();

    std::fs::create_dir_all(fx.root.join("f")).unwrap();
    std::fs::write(fx.root.join("f/precious"), b"not named by the manifest").unwrap();

    let manifest = manifest_of(vec![file_entry(&fx.store, "/f", b"bytes").await]);
    let err = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .expect_err("replacing this would mean deleting data the manifest never named");

    match &err {
        Error::Io { source, .. } => assert_eq!(
            source.kind(),
            std::io::ErrorKind::DirectoryNotEmpty,
            "expected a directory-not-empty io error, got {err}"
        ),
        other => panic!("expected Error::Io, got {other}"),
    }
    assert_eq!(
        std::fs::read(fx.root.join("f/precious")).unwrap(),
        b"not named by the manifest",
        "restore must never recursively delete what the manifest does not mention"
    );
}

// ---------------------------------------------------------------------------
// 8. the symlink pass is anchored too
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_manifest_symlink_is_created_inside_the_root_under_a_symlinked_parent() {
    let fx = Fixture::new();

    symlink(&fx.outside, fx.root.join("sub")).unwrap();

    let manifest = manifest_of(vec![symlink_entry("/sub/link", "../elsewhere")]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    fx.assert_outside_pristine();
    let meta = std::fs::symlink_metadata(fx.root.join("sub/link")).unwrap();
    assert!(meta.file_type().is_symlink());
    assert_eq!(
        std::fs::read_link(fx.root.join("sub/link")).unwrap(),
        Path::new("../elsewhere")
    );
}

// ---------------------------------------------------------------------------
// 9. mode changes never reach a symlink's target
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_directory_mode_is_never_applied_through_a_symlink() {
    let fx = Fixture::new();

    symlink(&fx.outside, fx.root.join("sub")).unwrap();

    // Nothing but the directory entry: the *only* operation on /sub is the
    // create and the chmod.
    let manifest = manifest_of(vec![dir_entry("/sub", 0o700)]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    fx.assert_outside_pristine();
    assert_eq!(
        std::fs::symlink_metadata(fx.root.join("sub"))
            .unwrap()
            .mode()
            & 0o7777,
        0o700
    );
}

// ---------------------------------------------------------------------------
// 10. the lexical guard still fires first
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_manifest_path_that_escapes_lexically_is_rejected_before_any_write() {
    let fx = Fixture::new();

    let manifest = manifest_of(vec![file_entry(&fx.store, "/../pwned", b"nope").await]);
    let err = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .expect_err("a `..` in a manifest path must be rejected");
    assert!(
        matches!(err, Error::PathTraversal { .. }),
        "expected PathTraversal, got {err}"
    );

    assert!(!fx.root.parent().unwrap().join("pwned").exists());
    fx.assert_outside_pristine();
}

// ---------------------------------------------------------------------------
// 11. the guarantees the fix must not have cost: byte identity and heat order
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_restore_over_a_dirty_root_is_still_byte_identical_and_still_heat_ordered() {
    let fx = Fixture::new();

    // A source tree with a directory, an explicit dir mode, a file mode, and a
    // symlink — then snapshot it.
    let src = fx.root.join("src");
    std::fs::create_dir_all(src.join("dir")).unwrap();
    std::fs::write(src.join("a.txt"), b"alpha").unwrap();
    std::fs::set_permissions(src.join("a.txt"), std::fs::Permissions::from_mode(0o600)).unwrap();
    std::fs::write(src.join("dir/b.txt"), b"bravo").unwrap();
    symlink("a.txt", src.join("link")).unwrap();
    std::fs::set_permissions(src.join("dir"), std::fs::Permissions::from_mode(0o750)).unwrap();

    let snap = snapshot(
        &fx.store,
        &src,
        &SnapshotOptions {
            exclude: vec![],
            created_at: 7,
            ..SnapshotOptions::default()
        },
    )
    .await
    .unwrap();

    // A hostile, dirty destination: every manifest path is occupied by a node of
    // the wrong kind, two of them pointing outside the root.
    let dst = fx.root.join("dst");
    std::fs::create_dir_all(&dst).unwrap();
    symlink(&fx.outside, dst.join("dir")).unwrap();
    symlink(fx.outside.join("sentinel"), dst.join("a.txt")).unwrap();
    std::fs::write(dst.join("link"), b"a real file where a symlink belongs").unwrap();

    let opts = RestoreOptions {
        priority: vec!["/dir/b.txt".to_string()],
    };
    let stats = restore(&fx.store, &snap.manifest, &dst, &opts)
        .await
        .unwrap();

    // Heat priority still leads the write order (spec 4.6(d)).
    assert_eq!(
        stats.file_order,
        vec!["/dir/b.txt".to_string(), "/a.txt".to_string()],
        "priority paths must still be restored first, in the requested order"
    );

    // And the tree is byte-identical to the source despite the dirty start.
    assert_eq!(
        common::read_tree(&src),
        common::read_tree(&dst),
        "restore over a dirty root must still be byte-identical"
    );
    fx.assert_outside_pristine();
}

// ---------------------------------------------------------------------------
// 12. the same defect in the other direction: removal
// ---------------------------------------------------------------------------
//
// `marid`'s revert prune deletes what a manifest does not name. Composing a
// path and calling `std::fs::remove_file` on it resolves every component
// through the kernel, so a symlinked parent turns a prune into a delete outside
// the root. `RootDir::remove_path` is the anchored primitive that prune uses.

#[tokio::test]
async fn remove_path_refuses_to_delete_through_a_symlinked_component() {
    let fx = Fixture::new();

    std::fs::write(fx.outside.join("victim"), b"outside the root").unwrap();
    symlink(&fx.outside, fx.root.join("sub")).unwrap();

    let mut rootfs = RootDir::open(&fx.root).unwrap();
    let err = rootfs
        .remove_path("/sub/victim")
        .expect_err("deleting through a symlinked component must be refused");
    assert!(
        matches!(err, Error::UnsafePath { .. }),
        "expected UnsafePath, got {err}"
    );
    assert_eq!(
        std::fs::read(fx.outside.join("victim")).unwrap(),
        b"outside the root",
        "the prune deleted a file outside the root"
    );

    // The symlink itself is removable — the link, never its target.
    assert!(rootfs.remove_path("/sub").unwrap());
    assert!(std::fs::symlink_metadata(fx.root.join("sub")).is_err());
    assert!(fx.outside.join("victim").exists());
    assert_eq!(
        std::fs::read(fx.outside.join("sentinel")).unwrap(),
        b"DO-NOT-TOUCH"
    );
}

#[tokio::test]
async fn remove_path_refuses_the_root_and_reports_a_missing_node() {
    let fx = Fixture::new();
    let mut rootfs = RootDir::open(&fx.root).unwrap();

    assert!(matches!(
        rootfs
            .remove_path("/")
            .expect_err("the root is not removable"),
        Error::UnsafePath { .. }
    ));
    // A node that is not there is not an error — a prune walks a live tree.
    assert!(!rootfs.remove_path("/nothing/here").unwrap());
    assert!(!rootfs.remove_path("/absent").unwrap());
}
