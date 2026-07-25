//! attack_prune_root_escape — the mirror of the restore escape: a revert
//! (spec 5.3) *deletes* everything the manifest does not name before it
//! restores, so a path that redirects outside the root turns the prune into a
//! delete outside the root.
//!
//! # Why the model
//!
//! The real function is `prune_to_manifest` in `crates/marid/src/supervisor.rs`
//! (private, called only by `revert_to_manifest`). These tests live in
//! `mari-core`, so [`prune_model`] below reproduces its loop exactly —
//! `RootDir::walk` (anchored, contents-first), keep an entry only when the
//! manifest has that exact path with the same kind, otherwise
//! `RootDir::remove_path`, count every entry the walk could not account for, and
//! treat a directory-not-empty failure as expected and silent. The only omission
//! is the exclude-glob filter, which none of these attacks go through. **If the
//! supervisor's loop changes, this model has to change with it** — it is a
//! stand-in for a private function, not a second implementation anybody calls.
//!
//! # What held
//!
//! Removal is the half of the fix that is actually solid: `RootDir::remove_path`
//! walks `O_NOFOLLOW` and every removal is an `unlinkat`, which unlinks a name
//! and never its target. A symlinked component, a hard link, and a component
//! being swapped by another thread during the prune all fail closed.
//!
//! Enumeration is the half that had to be rebuilt. It now runs through the same
//! kind of descriptors the removal does — `openat`/`getdents` per directory, one
//! component at a time — instead of through the full paths `walkdir` composes,
//! which stopped dead at `PATH_MAX` and left the subtree past it standing. What
//! the walk still cannot account for is an `Err` item the caller is handed, not
//! a gap it never hears about.
//!
//! The *write* that follows the prune is closed as well, but one layer down
//! rather than here: the prune still **keeps** a hard link whose path and kind
//! match the manifest, because path and kind are all it compares. What stops
//! the escape is `RootDir::create_file` refusing to reuse a multiply-linked
//! inode. `a_revert_must_not_write_through_a_hardlink_the_prune_kept` drives
//! the whole revert (prune, then restore) and is a live regression test for
//! that division of labour.
//!
//! # What did not hold
//!
//! Nothing here is `#[ignore]`d any more. The last one — a subtree deeper than
//! `PATH_MAX` surviving a revert in silence — is
//! `a_prune_must_reach_a_subtree_deeper_than_path_max`, now a live regression
//! test for the anchored walk.

use std::collections::HashMap;
use std::os::unix::fs::{PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use mari_core::{
    ChunkStore, EntryKind, Error, Manifest, RestoreOptions, RootDir, SnapshotOptions, restore,
    snapshot,
};
use mari_proto::MANIFEST_VERSION;

// ---------------------------------------------------------------------------
// the model of marid's revert prune
// ---------------------------------------------------------------------------

/// What one prune pass did, so a test can assert on the decisions and not just
/// on the surviving tree.
#[derive(Debug, Default)]
struct PruneOutcome {
    removed: Vec<String>,
    /// Removals that failed with something other than "directory not empty" —
    /// the supervisor logs these as warnings.
    refused: Vec<String>,
    /// Entries the anchored walk could not account for. Any of these means the
    /// prune does not know what it left behind, so the revert is not
    /// authoritative; the supervisor logs them and fails the revert.
    walk_errors: usize,
}

/// A faithful model of `prune_to_manifest` (crates/marid/src/supervisor.rs).
fn prune_model(root: &Path, manifest: &Manifest) -> PruneOutcome {
    let mut out = PruneOutcome::default();
    let in_manifest: HashMap<&str, EntryKind> = manifest
        .entries
        .iter()
        .map(|e| (e.path.as_str(), e.kind))
        .collect();

    let mut rootfs = RootDir::open(root).expect("open root");

    // Anchored, contents-first: every directory is read through the descriptor
    // its parent handed over, so no path is ever composed and nothing is out of
    // reach. The walk owns its own descriptors, so `rootfs` stays free to remove.
    let walk = match rootfs.walk() {
        Ok(w) => w,
        Err(_) => {
            out.walk_errors += 1;
            return out;
        }
    };
    for item in walk {
        let entry = match item {
            Ok(e) => e,
            Err(_) => {
                out.walk_errors += 1;
                continue;
            }
        };
        if in_manifest.get(entry.path.as_str()) == Some(&entry.kind) {
            continue;
        }
        match rootfs.remove_path(&entry.path) {
            Ok(true) => out.removed.push(entry.path),
            Ok(false) => {}
            Err(Error::Io { ref source, .. })
                if entry.kind == EntryKind::Dir
                    && source.kind() == std::io::ErrorKind::DirectoryNotEmpty => {}
            Err(_) => out.refused.push(entry.path),
        }
    }
    out
}

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

struct Fixture {
    _tmp: tempfile::TempDir,
    store: ChunkStore,
    root: PathBuf,
    outside: PathBuf,
}

const SENTINEL: &[u8] = b"DO-NOT-TOUCH";

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let store = ChunkStore::open_fs(tmp.path().join("store")).unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("sentinel"), SENTINEL).unwrap();
        Self {
            _tmp: tmp,
            store,
            root,
            outside,
        }
    }

    fn assert_outside_pristine(&self) {
        assert_eq!(
            names_in(&self.outside),
            vec!["sentinel".to_string()],
            "the prune deleted (or created) something outside the root"
        );
        assert_eq!(
            std::fs::read(self.outside.join("sentinel")).unwrap(),
            SENTINEL,
            "the prune wrote through to a file outside the root"
        );
    }
}

fn names_in(dir: &Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    v
}

fn empty_manifest() -> Manifest {
    Manifest {
        version: MANIFEST_VERSION,
        parent: None,
        created_at: 0,
        entries: Vec::new(),
    }
}

// ===========================================================================
// LIVE: attacks the anchored removal withstands.
// ===========================================================================

/// The prune's `walkdir` never descends into a symlink, so it only ever hands
/// `remove_path` the link itself — and `remove_path` unlinks the name, never
/// the target. The directory the link pointed at keeps every file in it.
#[test]
fn a_prune_never_deletes_through_a_symlinked_component() {
    let fx = Fixture::new();
    std::fs::write(fx.outside.join("victim"), b"outside the root").unwrap();
    symlink(&fx.outside, fx.root.join("sub")).unwrap();

    // Nothing is in the manifest, so everything on disk is extraneous.
    let out = prune_model(&fx.root, &empty_manifest());

    assert_eq!(out.removed, vec!["/sub".to_string()]);
    assert!(out.refused.is_empty(), "unexpected refusals: {out:?}");
    assert_eq!(
        std::fs::read(fx.outside.join("victim")).unwrap(),
        b"outside the root",
        "the prune deleted a file outside the root"
    );
    assert_eq!(names_in(&fx.outside), vec!["sentinel", "victim"]);
    assert!(
        names_in(&fx.root).is_empty(),
        "the link itself must be gone"
    );
}

/// A hard link is the shape `O_NOFOLLOW` cannot see. It does not matter for
/// *removal*: `unlinkat` drops one name and the inode survives while any other
/// name refers to it. (It matters a great deal for the write that follows —
/// see `a_revert_must_not_write_through_a_hardlink_the_prune_kept` below.)
#[test]
fn a_prune_never_destroys_the_target_of_a_hardlink() {
    let fx = Fixture::new();
    let victim = fx.outside.join("victim");
    std::fs::write(&victim, b"outside the root").unwrap();
    std::fs::hard_link(&victim, fx.root.join("f")).unwrap();

    let out = prune_model(&fx.root, &empty_manifest());

    assert_eq!(out.removed, vec!["/f".to_string()]);
    assert!(
        victim.exists(),
        "the prune destroyed a file outside the root through a hard link"
    );
    assert_eq!(std::fs::read(&victim).unwrap(), b"outside the root");
    assert_eq!(names_in(&fx.outside), vec!["sentinel", "victim"]);
    assert_eq!(
        std::fs::read(fx.outside.join("sentinel")).unwrap(),
        SENTINEL
    );
    assert!(names_in(&fx.root).is_empty());
}

/// The prune runs against a **live** root: `walkdir` decides what a path is,
/// and the removal happens later. A thread that turns a directory into a
/// symlink to `outside` in that window must not be able to convert the prune
/// into `unlink` calls out there.
#[test]
fn a_component_swapped_under_a_running_prune_never_deletes_outside() {
    const DIRS: usize = 300;
    let fx = Fixture::new();
    for i in 0..DIRS {
        std::fs::create_dir_all(fx.root.join(format!("d{i}"))).unwrap();
        std::fs::write(fx.root.join(format!("d{i}/x")), b"x").unwrap();
    }
    // Files out there that a redirected prune would delete.
    for i in 0..DIRS {
        std::fs::write(fx.outside.join(format!("x{i}")), b"outside").unwrap();
    }
    std::fs::write(fx.outside.join("x"), b"outside").unwrap();

    let stop = Arc::new(AtomicBool::new(false));
    let flips = Arc::new(AtomicU64::new(0));
    let stop_racer = stop.clone();
    let flips_racer = flips.clone();
    let root = fx.root.clone();
    let outside = fx.outside.clone();
    let racer = std::thread::spawn(move || {
        while !stop_racer.load(Ordering::Relaxed) {
            for i in 0..DIRS {
                let p = root.join(format!("d{i}"));
                // `remove_dir_all` does not follow symlinks (CVE-2022-21658
                // hardening), so the racer itself cannot reach `outside`.
                let _ = std::fs::remove_dir_all(&p);
                if symlink(&outside, &p).is_ok() {
                    flips_racer.fetch_add(1, Ordering::Relaxed);
                }
                let _ = std::fs::remove_file(&p);
                let _ = std::fs::create_dir(&p);
            }
        }
    });

    // Do not start pruning until the traps are actually being laid.
    while flips.load(Ordering::Relaxed) < 10 {
        std::hint::spin_loop();
    }
    let before = flips.load(Ordering::Relaxed);
    let out = prune_model(&fx.root, &empty_manifest());
    let during = flips.load(Ordering::Relaxed) - before;
    stop.store(true, Ordering::Relaxed);
    racer.join().unwrap();
    assert!(
        during > 10,
        "only {during} swaps happened while the prune ran — the test proved nothing"
    );

    let mut expected: Vec<String> = (0..DIRS).map(|i| format!("x{i}")).collect();
    expected.push("sentinel".to_string());
    expected.push("x".to_string());
    expected.sort();
    assert_eq!(
        names_in(&fx.outside),
        expected,
        "the prune deleted files outside the root under a racing component swap ({out:?})"
    );
}

/// `remove_path` takes a manifest-form path, and the same lexical guard the
/// restore uses runs on it first: a `..` cannot be smuggled through a component
/// that really exists, and the root itself is not removable.
#[test]
fn remove_path_rejects_traversal_even_through_real_components() {
    let fx = Fixture::new();
    std::fs::create_dir_all(fx.root.join("real")).unwrap();
    let mut rootfs = RootDir::open(&fx.root).unwrap();

    for path in [
        "/real/../../outside/sentinel",
        "/../outside/sentinel",
        "/..",
    ] {
        match rootfs.remove_path(path) {
            Err(Error::PathTraversal { .. }) => {}
            Err(other) => panic!("expected PathTraversal for {path:?}, got {other}"),
            Ok(removed) => panic!("{path:?} was accepted (removed = {removed})"),
        }
    }
    let err = rootfs
        .remove_path("/")
        .expect_err("the root itself is not removable");
    assert!(
        matches!(err, Error::UnsafePath { .. }),
        "expected UnsafePath for the root, got {err}"
    );
    fx.assert_outside_pristine();
}

// ===========================================================================
// LIVE: the end-to-end revert, and the tree the prune could not see.
// ===========================================================================

/// **The full revert path, end to end — the escape it used to be is closed.**
///
/// This is the end-to-end version of the hard-link escape (see
/// `attack_restore_root_escape.rs`). The prune is not the layer that catches
/// it: its job is to delete anything that is not exactly what the manifest
/// says, but it compares *path* and *kind* only, and a hard link to a file
/// outside the root is `EntryKind::File` at a path the manifest declares as a
/// file — so the prune keeps it (the `PruneOutcome` in the failure message
/// below is `removed: []`, deliberately), and the restore runs against a tree
/// that still contains a second name for a foreign inode.
///
/// What contains it is the write itself: `RootDir::create_file` reopens an
/// existing regular file *without* `O_TRUNC`, `fstat`s that descriptor, and
/// treats `st_nlink > 1` exactly like a wrong-kind node — the name is unlinked
/// and a fresh inode created, so nothing is ever written through a link the
/// prune left standing. Truncating first and checking after would already have
/// destroyed the outside file's bytes, which is why the check has to sit on the
/// descriptor, after the open and before any modification.
///
/// The scenario is the ordinary one: a run replaces a tracked file with a hard
/// link to something it wants destroyed (here a file outside the computer root;
/// a chunk-store body works just as well), then the run is reverted.
#[tokio::test]
async fn a_revert_must_not_write_through_a_hardlink_the_prune_kept() {
    let fx = Fixture::new();
    let victim = fx.outside.join("victim");
    std::fs::write(&victim, b"OUTSIDE-ORIGINAL-SECRET").unwrap();
    std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o600)).unwrap();

    // The pre-run tree, snapshotted: this manifest is what the revert restores.
    std::fs::create_dir_all(fx.root.join("proj")).unwrap();
    std::fs::write(fx.root.join("proj/README.md"), b"the real readme\n").unwrap();
    let snap = snapshot(
        &fx.store,
        &fx.root,
        &SnapshotOptions {
            created_at: 1,
            ..SnapshotOptions::default()
        },
    )
    .await
    .unwrap();

    // What the run does before it is reverted.
    std::fs::remove_file(fx.root.join("proj/README.md")).unwrap();
    std::fs::hard_link(&victim, fx.root.join("proj/README.md")).unwrap();

    // The revert, in order: prune, then restore (supervisor::revert_to_manifest).
    let out = prune_model(&fx.root, &snap.manifest);
    let _ = restore(
        &fx.store,
        &snap.manifest,
        &fx.root,
        &RestoreOptions::default(),
    )
    .await;

    assert_eq!(
        std::fs::read(&victim).unwrap(),
        b"OUTSIDE-ORIGINAL-SECRET",
        "a revert wrote through a hard link to a file outside the root (prune said {out:?})"
    );
    assert_eq!(
        std::fs::metadata(&victim).unwrap().permissions().mode() & 0o7777,
        0o600,
        "a revert chmod'd a file outside the root through a hard link"
    );
    assert_eq!(
        std::fs::read(fx.root.join("proj/README.md")).unwrap(),
        b"the real readme\n",
        "the reverted tree must still be correct inside the root"
    );
}

/// **A revert is authoritative past `PATH_MAX` too.**
///
/// A run can build a tree deeper than `PATH_MAX` with nothing but relative
/// `mkdir`/`chdir` (as this test does, via `sh`) — no privileges, no exotic
/// syscalls. The prune used to enumerate with `walkdir`, which composes and
/// re-resolves a full path for every entry, so from the depth where that path
/// exceeded the limit the walk yielded one error instead of entries. The
/// supervisor dropped it at `debug!` level, every ancestor above it then failed
/// to be removed with "directory not empty" — which the prune treats as
/// *expected* and does not even log — and the subtree survived the revert
/// entirely, in silence. Spec 5.3's "restore the manifest" was not what the disk
/// ended up holding, and nothing said so.
///
/// The prune now enumerates the way it removes: `RootDir::walk` reads each
/// directory through the descriptor its parent handed over, so the kernel never
/// resolves more than a single component and depth costs nothing but a
/// descriptor. The removal side was always able to reach here (`remove_path`
/// splits lexically and descends one `openat` at a time, deliberately without
/// the manifest length bound), so the whole subtree goes.
///
/// The assertions are the two halves of "authoritative": the tree is *gone*, and
/// the walk *knew* it was — a prune that reported a walk error would leave the
/// caller unable to tell an empty root from an unread one.
#[test]
fn a_prune_must_reach_a_subtree_deeper_than_path_max() {
    let fx = Fixture::new();
    let name = "dddddddddddddddddddddddddddddddd"; // 32 chars
    let depth = 100usize; // ~3300 characters of path: well past PATH_MAX

    // Exactly what a run can do with a shell and no special privileges.
    let script = format!(
        "cd \"$1\" && for _ in $(seq 1 {depth}); do mkdir {name} && cd {name} || exit 1; done"
    );
    let status = std::process::Command::new("sh")
        .arg("-c")
        .arg(&script)
        .arg("sh")
        .arg(&fx.root)
        .status()
        .expect("sh");
    assert!(status.success(), "could not build the deep tree");

    let out = prune_model(&fx.root, &empty_manifest());
    let survived = names_in(&fx.root);

    // Clean up through the anchored API, in case the prune left anything:
    // nothing that composes a path (including `TempDir`'s recursive drop) can
    // get back out of here.
    let mut rootfs = RootDir::open(&fx.root).unwrap();
    let mut comps: Vec<String> = vec![name.to_string(); depth];
    while !comps.is_empty() {
        if rootfs
            .remove_path(&format!("/{}", comps.join("/")))
            .is_err()
        {
            break;
        }
        comps.pop();
    }

    assert!(
        survived.is_empty(),
        "a prune to an empty manifest left {survived:?} behind ({out:?})"
    );
    assert_eq!(
        out.walk_errors, 0,
        "the walk could not account for part of the tree ({out:?})"
    );
    assert!(out.refused.is_empty(), "unexpected refusals: {out:?}");
    assert_eq!(
        out.removed.len(),
        depth,
        "every directory in the deep tree must be removed"
    );
    // Contents-first, deepest name first: the only order in which a prune that
    // may only remove *empty* directories can take a whole subtree down.
    let deepest = format!("/{}", vec![name; depth].join("/"));
    let shallowest = format!("/{name}");
    assert_eq!(
        out.removed.first(),
        Some(&deepest),
        "the deepest directory must be the first one removed"
    );
    assert_eq!(
        out.removed.last(),
        Some(&shallowest),
        "the shallowest directory must be the last one removed"
    );
    fx.assert_outside_pristine();
}
