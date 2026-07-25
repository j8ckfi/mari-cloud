//! attack_restore_root_escape — adversarial follow-up on the fix for the
//! restore root-escape write primitive (`crate::rootfs::RootDir`, spec 5.3).
//!
//! The fix replaced every composed-path `std::fs` call in `restore` with an
//! `openat`/`O_NOFOLLOW` walk anchored to a held root descriptor, so a symlink
//! sitting on disk can no longer redirect a write. These tests do not admire
//! that; they try to get outside the root anyway.
//!
//! Every test owns a `root` and an `outside` directory that a restore must
//! never touch, and asserts the *outside* half explicitly — an escape is a
//! change out there, not merely a surprising return value. A restore is allowed
//! to fail (revert is authoritative but it is also allowed to refuse); it is
//! never allowed to leak.
//!
//! # What held
//!
//! Symlink chains, `..`-relative and absolute link targets, dangling links,
//! FIFOs at the leaf and at a parent component, a link aimed straight at the
//! chunk store, embedded NULs, case-folding collisions on this APFS host, a
//! manifest whose own symlink entry is an ancestor of a later entry, and a
//! second thread swapping a path component between a directory and a symlink
//! for the whole duration of a restore. All contained. Those cases are live
//! regression tests below.
//!
//! # What did not hold
//!
//! `O_NOFOLLOW` stops the kernel following a *symbolic* link. It does nothing
//! about a **hard** link, which is not a redirect at all — it is a second name
//! for the same inode, and `RootDir::create_file` used to reuse an existing
//! regular file (`O_TRUNC`) instead of replacing it.
//!
//! The **write** half of that is fixed: the leaf write now `fstat`s the
//! descriptor it is about to write and, when `st_nlink > 1`, unlinks the name
//! and creates fresh, so a restore's bytes can never reach an inode's other
//! names. `a_hardlink_at_a_manifest_path_must_not_redirect_the_write_outside_the_root`
//! and `a_hardlink_into_the_chunk_store_must_not_let_a_restore_destroy_a_chunk`
//! are live regression tests for it, and the second is the one that mattered
//! most: a computer root holds one computer, while a clobbered chunk body is
//! shared, content-addressed truth (spec 4.1) that verify-on-read can only
//! report as lost. The **read** half is fixed too: a hard link is still an
//! ordinary regular file to every check `O_NOFOLLOW` can make, so `snapshot` no
//! longer decides by kind at all — it reads a file's bytes only once every name
//! its inode has is a path the manifest itself records, and drops the entry
//! unread otherwise.
//! `a_hardlink_must_not_let_a_snapshot_read_a_file_outside_the_root` is the live
//! regression test for that.
//! The two hostile-manifest denial-of-service tests that sat beside them are
//! fixed and run by default too: a manifest path deeper than `PATH_MAX` is
//! refused rather than materialized into a tree no later snapshot could walk,
//! and a declared size no chunk backs is an error rather than an allocation.

use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use mari_core::{
    ChunkStore, EntryKind, Error, Manifest, ManifestEntry, RestoreOptions, RootDir,
    SnapshotOptions, restore, snapshot,
};
use mari_proto::{ChunkRef, MANIFEST_VERSION};

// ---------------------------------------------------------------------------
// fixture
// ---------------------------------------------------------------------------

/// A store, a live `root` a restore writes into, and an `outside` directory
/// that is off limits. `outside` starts with a sentinel file so "untouched" is
/// an assertion with teeth rather than an absence of evidence.
struct Fixture {
    _tmp: tempfile::TempDir,
    store: ChunkStore,
    store_dir: PathBuf,
    root: PathBuf,
    outside: PathBuf,
}

const SENTINEL: &[u8] = b"DO-NOT-TOUCH";

impl Fixture {
    fn new() -> Self {
        let tmp = tempfile::tempdir().unwrap();
        let store_dir = tmp.path().join("store");
        let store = ChunkStore::open_fs(&store_dir).unwrap();
        let root = tmp.path().join("root");
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("sentinel"), SENTINEL).unwrap();
        std::fs::set_permissions(&outside, std::fs::Permissions::from_mode(0o755)).unwrap();
        Self {
            _tmp: tmp,
            store,
            store_dir,
            root,
            outside,
        }
    }

    /// Nothing outside the root was created, written, or chmod'd.
    fn assert_outside_pristine(&self) {
        assert_eq!(
            names_in(&self.outside),
            vec!["sentinel".to_string()],
            "the restore created something outside the root"
        );
        assert_eq!(
            std::fs::read(self.outside.join("sentinel")).unwrap(),
            SENTINEL,
            "the restore wrote through to a file outside the root"
        );
        assert_eq!(
            std::fs::metadata(&self.outside).unwrap().mode() & 0o7777,
            0o755,
            "the restore chmod'd a directory outside the root"
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

fn is_real_dir(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_dir())
        .unwrap_or(false)
}

fn is_real_file(p: &Path) -> bool {
    std::fs::symlink_metadata(p)
        .map(|m| m.file_type().is_file())
        .unwrap_or(false)
}

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

/// Path-sorted, the way `snapshot` emits entries (pass 1 of `restore` relies on
/// parents preceding their children).
fn manifest_of(mut entries: Vec<ManifestEntry>) -> Manifest {
    entries.sort_by(|a, b| a.path.cmp(&b.path));
    Manifest {
        version: MANIFEST_VERSION,
        parent: None,
        created_at: 0,
        entries,
    }
}

// ===========================================================================
// LIVE: attacks that the fix withstands. Each stays in the suite as a
// regression test for a distinct escape shape.
// ===========================================================================

/// A chain: `root/a` -> `root/b` -> `outside`. One `O_NOFOLLOW` refusal is not
/// enough if the resolver ever restarts a full path walk after replacing a
/// component; walking one name at a time from a held descriptor is.
#[tokio::test]
async fn a_symlink_chain_resolving_outside_the_root_is_replaced_not_followed() {
    let fx = Fixture::new();
    symlink(fx.root.join("b"), fx.root.join("a")).unwrap();
    symlink(&fx.outside, fx.root.join("b")).unwrap();

    let manifest = manifest_of(vec![file_entry(&fx.store, "/a/f", b"inside").await]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    fx.assert_outside_pristine();
    assert!(is_real_dir(&fx.root.join("a")), "root/a must be a real dir");
    assert_eq!(std::fs::read(fx.root.join("a/f")).unwrap(), b"inside");
    // The second link in the chain was never an operand and must survive as-is.
    assert_eq!(
        std::fs::read_link(fx.root.join("b")).unwrap(),
        fx.outside,
        "an unrelated link must not be rewritten"
    );
}

/// The link text is relative and climbs out with `..` — the shape the lexical
/// manifest check cannot see, because it is on disk, not in the manifest.
#[tokio::test]
async fn a_relative_dotdot_symlink_target_does_not_redirect_a_write() {
    let fx = Fixture::new();
    symlink("../outside", fx.root.join("sub")).unwrap();
    assert!(
        fx.root.join("sub/sentinel").exists(),
        "precondition: the trap resolves outside the root"
    );

    let manifest = manifest_of(vec![
        dir_entry("/sub", 0o755),
        file_entry(&fx.store, "/sub/f", b"inside").await,
    ]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    fx.assert_outside_pristine();
    assert_eq!(std::fs::read(fx.root.join("sub/f")).unwrap(), b"inside");
}

/// The most valuable target reachable from a computer root is the chunk store
/// itself: one clobbered chunk file is unrecoverable content-addressed data for
/// every manifest that references it. A symlink aimed at the store directory
/// must not get a restore to write into it.
#[tokio::test]
async fn a_symlink_aimed_at_the_chunk_store_cannot_reach_a_chunk() {
    let fx = Fixture::new();
    let precious = fx.store.put_chunk(b"precious chunk content").await.unwrap();
    symlink(&fx.store_dir, fx.root.join("store_link")).unwrap();

    let manifest = manifest_of(vec![
        file_entry(&fx.store, "/store_link/chunks", b"clobbered").await,
    ]);
    restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .unwrap();

    // The store still has exactly its own layout and the chunk still verifies.
    assert_eq!(names_in(&fx.store_dir), vec!["chunks".to_string()]);
    assert_eq!(
        fx.store.get_chunk(&precious).await.unwrap(),
        b"precious chunk content",
        "a restore reached into the chunk store"
    );
    assert!(is_real_dir(&fx.root.join("store_link")));
    assert_eq!(
        std::fs::read(fx.root.join("store_link/chunks")).unwrap(),
        b"clobbered"
    );
}

/// A FIFO is the classic way to turn an unguarded `open` into an indefinite
/// hang: `open(O_RDONLY)` on one blocks until a writer arrives. `RootDir` opens
/// leaves `O_NONBLOCK` and directory components `O_DIRECTORY` (which is refused
/// before the FIFO is ever opened), so neither position parks the restore.
///
/// Driven on its own thread with a hard deadline: a regression here is a hang,
/// and a hang must fail this test rather than wedge the suite.
#[test]
fn a_fifo_at_the_leaf_or_at_a_parent_component_never_parks_a_restore() {
    for at_parent in [false, true] {
        let fx = Fixture::new();
        let pipe = fx.root.join("pipe");
        let ok = std::process::Command::new("mkfifo")
            .arg(&pipe)
            .status()
            .map(|s| s.success())
            .unwrap_or(false);
        assert!(ok, "mkfifo is required for this test");

        let path = if at_parent { "/pipe/f" } else { "/pipe" };
        let root = fx.root.clone();
        let store = fx.store.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap();
            let result = rt.block_on(async {
                let manifest = manifest_of(vec![file_entry(&store, path, b"payload").await]);
                restore(&store, &manifest, &root, &RestoreOptions::default()).await
            });
            let _ = tx.send(result.is_ok());
        });

        let finished = rx
            .recv_timeout(Duration::from_secs(20))
            .unwrap_or_else(|_| panic!("restore blocked on a FIFO (at_parent={at_parent})"));
        assert!(
            finished,
            "restore over a FIFO failed (at_parent={at_parent})"
        );

        let landed = if at_parent {
            fx.root.join("pipe/f")
        } else {
            fx.root.join("pipe")
        };
        assert!(is_real_file(&landed), "the bytes must land in a real file");
        assert_eq!(std::fs::read(&landed).unwrap(), b"payload");
        fx.assert_outside_pristine();
    }
}

/// A NUL inside a component is the oldest way to make a C-string API see a
/// shorter path than the validator did. It must not truncate into some other
/// name, and it must not half-create anything.
#[tokio::test]
async fn an_embedded_nul_in_a_manifest_path_writes_nothing() {
    let fx = Fixture::new();

    // A NUL that would truncate to a real, different target name.
    let manifest = manifest_of(vec![
        file_entry(&fx.store, "/sentinel\0/../../x", b"x").await,
    ]);
    let err = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .expect_err("a `..` is rejected lexically whatever else is in the path");
    assert!(
        matches!(err, Error::PathTraversal { .. }),
        "expected PathTraversal, got {err}"
    );

    // A NUL with no traversal at all: the syscall layer must refuse it.
    let manifest = manifest_of(vec![file_entry(&fx.store, "/nul\0name", b"x").await]);
    let err = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .expect_err("a NUL cannot be part of a filename");
    match &err {
        Error::Io { source, .. } => assert_eq!(
            source.kind(),
            std::io::ErrorKind::InvalidInput,
            "expected an invalid-argument io error, got {err}"
        ),
        other => panic!("expected Error::Io, got {other}"),
    }
    assert!(
        names_in(&fx.root).is_empty(),
        "a rejected path must not leave a truncated name behind: {:?}",
        names_in(&fx.root)
    );
    fx.assert_outside_pristine();
}

/// The manifest's own entries are ordered against it: `/a` is a symlink to
/// `outside` and `/a/f` is a file, so a naive implementation that honoured the
/// entries in path order would create the link and then write through it.
/// Restore writes files (pass 2) before symlinks (pass 3), so the link can
/// never become an ancestor of a write.
#[tokio::test]
async fn a_manifest_symlink_entry_cannot_become_the_parent_of_a_later_entry() {
    let fx = Fixture::new();
    let manifest = manifest_of(vec![
        symlink_entry("/a", fx.outside.to_str().unwrap()),
        file_entry(&fx.store, "/a/f", b"payload").await,
    ]);

    // Self-contradictory: /a cannot be both a symlink and a directory. Either
    // outcome is defensible; leaking is not.
    let _ = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default()).await;

    fx.assert_outside_pristine();
    assert!(
        !fx.outside.join("f").exists(),
        "the payload escaped through the manifest's own symlink"
    );
}

/// This host is APFS, i.e. case-insensitive: `/A` and `/a` are one name. A
/// manifest carrying both a directory `/A` and a symlink `/a` therefore makes
/// two entries collide on disk. Restore may refuse (it does here, with a
/// directory-not-empty io error) but it must not resolve the collision by
/// letting the symlink stand where the directory's children live.
#[tokio::test]
async fn a_case_folding_collision_between_two_entries_never_escapes() {
    let fx = Fixture::new();
    let manifest = manifest_of(vec![
        dir_entry("/A", 0o755),
        file_entry(&fx.store, "/A/child", b"inside").await,
        symlink_entry("/a", fx.outside.to_str().unwrap()),
    ]);

    let _ = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default()).await;

    fx.assert_outside_pristine();
    // Whatever occupies the collided name, the child bytes are not out there,
    // and the name is not a live door to `outside`.
    assert!(!fx.outside.join("child").exists());
    let collided = fx.root.join("A");
    if std::fs::symlink_metadata(&collided)
        .map(|m| m.file_type().is_symlink())
        .unwrap_or(false)
    {
        panic!("the directory's name resolved to a symlink pointing outside the root");
    }
}

/// The whole point of a `*at`-anchored walk is that a swap under it can only
/// make a step fail. A second thread flips `root/sub` between a real directory
/// and a symlink to `outside` for the entire restore; the restore may end in an
/// error, but nothing may appear outside.
#[tokio::test]
async fn a_component_swapped_under_a_running_restore_cannot_redirect_it() {
    let fx = Fixture::new();
    let stop = Arc::new(AtomicBool::new(false));

    let sub = fx.root.join("sub");
    let out = fx.outside.clone();
    let stop_racer = stop.clone();
    // `std::fs::remove_dir_all` does not follow symlinks (it is hardened
    // against exactly that, CVE-2022-21658), so the racer itself can never
    // reach into `outside`: only the restore under test could.
    let racer = std::thread::spawn(move || {
        let mut flips: u64 = 0;
        while !stop_racer.load(Ordering::Relaxed) {
            let _ = std::fs::remove_dir_all(&sub);
            let _ = std::fs::remove_file(&sub);
            if symlink(&out, &sub).is_ok() {
                flips += 1;
            }
            let _ = std::fs::remove_file(&sub);
            let _ = std::fs::create_dir(&sub);
        }
        flips
    });

    let mut entries = Vec::new();
    for i in 0..400 {
        entries.push(file_entry(&fx.store, &format!("/sub/f{i:04}"), b"payload").await);
    }
    let manifest = manifest_of(entries);
    let result = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default()).await;

    stop.store(true, Ordering::Relaxed);
    let flips = racer.join().unwrap();
    assert!(
        flips > 50,
        "the racer never got the trap in place ({flips} flips) — the test proved nothing"
    );

    // Tear the trap down before asserting, so a failure is about the restore.
    let _ = std::fs::remove_file(fx.root.join("sub"));
    let _ = std::fs::remove_dir_all(fx.root.join("sub"));

    fx.assert_outside_pristine();
    if let Err(e) = result {
        // Failing is allowed; failing *safely* is the requirement.
        assert!(
            matches!(e, Error::UnsafePath { .. } | Error::Io { .. }),
            "expected a typed failure under a racing swap, got {e}"
        );
    }
}

/// Every spelling of "the root itself" — `/`, ``, `///`, `/.` — collapses to
/// zero components. A file or a symlink there has no name to create, and the
/// only way to honour it would be to operate on the root descriptor, so it must
/// be rejected up front rather than silently skipped (a silently-skipped entry
/// is a restore that reports success on a tree it did not reconstruct).
#[tokio::test]
async fn an_entry_naming_the_root_itself_is_rejected_unless_it_is_a_directory() {
    let fx = Fixture::new();

    for path in ["/", "", "///", "/."] {
        let manifest = manifest_of(vec![file_entry(&fx.store, path, b"x").await]);
        let err = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
            .await
            .expect_err("a file entry naming the root must be rejected");
        assert!(
            matches!(err, Error::InvalidManifest(_)),
            "expected InvalidManifest for {path:?}, got {err}"
        );

        let manifest = manifest_of(vec![symlink_entry(path, "/etc")]);
        let err = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
            .await
            .expect_err("a symlink entry naming the root must be rejected");
        assert!(
            matches!(err, Error::InvalidManifest(_)),
            "expected InvalidManifest for {path:?}, got {err}"
        );
    }
    assert!(names_in(&fx.root).is_empty());
    fx.assert_outside_pristine();
}

// ===========================================================================
// ATTACKS THAT SUCCEEDED. Each asserts the property that must hold once the
// defect is fixed, so un-ignoring it turns red until it is. One that carries no
// `#[ignore]` is closed, and now guards its fix like anything above.
// ===========================================================================

/// **FIXED — the hard-link write escape. Live regression test.**
///
/// `O_NOFOLLOW` refuses a *symbolic* link. A **hard** link is not a redirect at
/// all: it is a second directory entry for the same inode, so there is nothing
/// for the kernel to follow and nothing for `O_NOFOLLOW` to refuse.
/// `RootDir::create_file` used to reopen an existing regular file with
/// `O_TRUNC` rather than replacing it, and `restore::write_file` then `fchmod`s
/// that same descriptor. A run that left a hard link at any path the manifest
/// declares as a file therefore got the restore to write the manifest's bytes,
/// and stamp the manifest's mode, onto an arbitrary inode on the same
/// filesystem — including one outside the computer root — and to return
/// `Ok(files: 1)` while doing it.
///
/// The fix is in the leaf write itself, not in a pre-flight check: the
/// `Some(FileType::RegularFile)` arm of `create_file` now reopens the existing
/// file **without** `O_TRUNC` (truncation is already the destructive act, so it
/// cannot precede the vetting), `fstat`s the descriptor it is about to write,
/// and — when `st_nlink > 1` — drops it untouched, `unlinkat`s the name, and
/// creates a fresh inode with `O_EXCL`. Vetting the open descriptor instead of
/// the path is what closes the window; a manifest has no hard-link concept, so
/// nothing it can express is lost by breaking the link.
#[tokio::test]
async fn a_hardlink_at_a_manifest_path_must_not_redirect_the_write_outside_the_root() {
    let fx = Fixture::new();
    let victim = fx.outside.join("victim");
    std::fs::write(&victim, b"OUTSIDE-ORIGINAL").unwrap();
    std::fs::set_permissions(&victim, std::fs::Permissions::from_mode(0o600)).unwrap();

    // What a run leaves behind: a second name, inside the root, for an inode
    // outside it.
    std::fs::hard_link(&victim, fx.root.join("f")).unwrap();

    let manifest = manifest_of(vec![file_entry(&fx.store, "/f", b"PWNED-BY-RESTORE").await]);
    let _ = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default()).await;

    assert_eq!(
        std::fs::read(&victim).unwrap(),
        b"OUTSIDE-ORIGINAL",
        "the restore wrote through a hard link to a file outside the root"
    );
    assert_eq!(
        std::fs::metadata(&victim).unwrap().mode() & 0o7777,
        0o600,
        "the restore chmod'd a file outside the root through a hard link"
    );
    assert_eq!(
        std::fs::read(fx.root.join("f")).unwrap(),
        b"PWNED-BY-RESTORE",
        "the manifest's bytes must still land inside the root"
    );
}

/// **FIXED — the same primitive, aimed at the chunk store. Live regression
/// test.**
///
/// The symlink version is contained by `O_NOFOLLOW` (see
/// `a_symlink_aimed_at_the_chunk_store_cannot_reach_a_chunk`). The hard-link
/// version had nothing containing it, and the blast radius was the whole store:
/// chunk bodies are content-addressed and shared by every manifest of every
/// computer (spec 4.1 — the chunk store holds the truth of each filesystem), so
/// one clobbered chunk file is permanent data loss that verify-on-read can only
/// report, never repair. It reproduced as `restore` returning `Ok` and
/// `get_chunk(precious)` then failing `Error::ChunkDecompress` ("corrupt zstd
/// frame") — note that the *truncation* alone destroyed the body, before a
/// single attacker byte was written.
///
/// `RootDir::create_file` now opens an existing regular file **without**
/// `O_TRUNC`, `fstat`s the descriptor it is about to write, and treats
/// `st_nlink > 1` exactly like a wrong-kind node: it unlinks the name it
/// resolved (which is anchored under the root) and creates a fresh inode. A
/// singly-linked file has exactly one name, and we reached it by an
/// `O_NOFOLLOW` walk from the root, so reusing that one is provably in-root.
///
/// Both halves are asserted. Containment on its own would also be satisfied by
/// a restore that simply refused — and a revert that cannot run is its own
/// failure — so this pins the store *and* the completed write inside the root.
#[tokio::test]
async fn a_hardlink_into_the_chunk_store_must_not_let_a_restore_destroy_a_chunk() {
    let fx = Fixture::new();
    let precious = fx.store.put_chunk(b"precious chunk content").await.unwrap();

    // Whatever layout the store uses, the attacker only needs to find the file.
    let chunk_file = walkdir::WalkDir::new(&fx.store_dir)
        .into_iter()
        .filter_map(|e| e.ok())
        .find(|e| e.file_type().is_file())
        .expect("the chunk is on disk")
        .path()
        .to_path_buf();
    let chunk_inode = std::fs::metadata(&chunk_file).unwrap().ino();
    let chunk_body = std::fs::read(&chunk_file).unwrap();
    std::fs::hard_link(&chunk_file, fx.root.join("f")).unwrap();
    assert_eq!(
        std::fs::metadata(&chunk_file).unwrap().nlink(),
        2,
        "precondition: the trap is a second name for the chunk's own inode"
    );

    let manifest = manifest_of(vec![file_entry(&fx.store, "/f", b"attacker bytes").await]);
    let stats = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default())
        .await
        .expect("the restore must contain the write, not refuse to run");

    match fx.store.get_chunk(&precious).await {
        Ok(bytes) => assert_eq!(
            bytes, b"precious chunk content",
            "a restore rewrote a chunk body through a hard link"
        ),
        Err(e) => panic!("a restore destroyed a chunk body through a hard link: {e}"),
    }
    // Byte-level, not merely decodable: the stored body is the compressed frame
    // `put_chunk` wrote, and nothing may have touched it.
    assert_eq!(
        std::fs::read(&chunk_file).unwrap(),
        chunk_body,
        "the chunk body on disk changed under a restore"
    );

    // The other half: the manifest's bytes landed inside the root, on an inode
    // of their own, and the store name is no longer shared with anything.
    assert_eq!(stats.files, 1);
    assert_eq!(std::fs::read(fx.root.join("f")).unwrap(), b"attacker bytes");
    assert_ne!(
        std::fs::metadata(fx.root.join("f")).unwrap().ino(),
        chunk_inode,
        "the restored file is still a second name for the chunk's inode"
    );
    assert_eq!(
        std::fs::metadata(&chunk_file).unwrap().nlink(),
        1,
        "the chunk file is still reachable by a name inside a computer root"
    );
    fx.assert_outside_pristine();
}

/// **FIXED — the same primitive, inbound. Live regression test.**
///
/// The root-anchored read `snapshot` uses stops a swapped component redirecting
/// it, and refuses a symlink in every position — but a hard link is a regular
/// file by every one of those checks, so the content of a file outside the
/// computer root was chunked into the store and named by the manifest, readable
/// afterwards by anyone who can restore it. It reproduced as a `/innocent.txt`
/// entry of size 18 whose chunk decoded to `TOP-SECRET-OUTSIDE` — and chunks are
/// shared, so that content then belonged to every fork and every retained
/// manifest that referenced it (spec 10.1, 10.2).
///
/// The fix is that `snapshot` no longer decides by kind. It takes `st_nlink`
/// from the descriptor it would read (not from a `statat` on the name), and
/// reads the bytes only when that many of the manifest's own paths still resolve
/// to that inode. A link the snapshot cannot account for means a name it is not
/// looking at, so the entry is dropped unread into
/// `SnapshotResult::unattributable_links` rather than failing the snapshot — a
/// checkpoint a guest can kill with one `link()` call is its own defect (spec
/// 4.3, 4.4).
#[tokio::test]
async fn a_hardlink_must_not_let_a_snapshot_read_a_file_outside_the_root() {
    let fx = Fixture::new();
    let secret = fx.outside.join("secret");
    std::fs::write(&secret, b"TOP-SECRET-OUTSIDE").unwrap();
    std::fs::hard_link(&secret, fx.root.join("innocent.txt")).unwrap();

    let snap = snapshot(
        &fx.store,
        &fx.root,
        &SnapshotOptions {
            created_at: 1,
            ..SnapshotOptions::default()
        },
    )
    .await;

    if let Ok(snap) = snap {
        for entry in &snap.manifest.entries {
            for cref in &entry.chunks {
                let bytes = fx.store.get_chunk(&cref.chunk).await.unwrap();
                assert_ne!(
                    bytes, b"TOP-SECRET-OUTSIDE",
                    "a snapshot read a file outside the root into the store via {}",
                    entry.path
                );
            }
        }
    }
}

/// **FIXED — hostile-manifest denial of service (unbounded depth). Live
/// regression test.**
///
/// The anchored walk resolves one component at a time, so it is not bound by
/// `PATH_MAX` the way the old composed-path code was: a manifest could name a
/// path far deeper than any composed path can address, and `restore` would
/// materialize it. Nothing afterwards could address it. `snapshot` walks with
/// `walkdir`, which composes full paths, so it failed `ENAMETOOLONG` — and
/// snapshot treats a walk error as fatal, so **every later snapshot of that
/// computer failed**, permanently. A computer that cannot snapshot cannot check
/// point and cannot be taken COLD without losing the tree. It cost descriptors
/// too: `RootDir` holds one open fd per resolved component, measured at 3008
/// concurrently open descriptors for a 3000-component path.
///
/// `manifest_components` now bounds a manifest path by what the kernel can
/// address at all — `MAX_MANIFEST_PATH_BYTES` and
/// `MAX_MANIFEST_PATH_COMPONENTS`, both derived from `PATH_MAX` — beside the
/// `..` rejection, and `restore` uses `manifest_components_under`, which also
/// checks the path against the root it is actually composing under. The bound
/// is the kernel's rather than a "sane tree" number on purpose: `snapshot`
/// validates the paths it *finds on disk* through the same function, and a
/// guest can build a legal tree of any depth with relative `mkdir`s, so a
/// tighter bound would produce this very defect at a lower threshold.
///
/// Removal is deliberately exempt (`RootDir::remove_path` splits lexically
/// only): a prune has to be able to reach a too-deep subtree that is already
/// on disk.
#[tokio::test]
async fn a_manifest_path_deeper_than_path_max_must_not_be_materialized() {
    let fx = Fixture::new();
    let depth = 400usize;
    let name = "dddddddddddddddddddd";
    let deep: String = (0..depth).map(|i| format!("/{name}{i}")).collect();

    let manifest = manifest_of(vec![
        file_entry(&fx.store, &format!("{deep}/leaf"), b"x").await,
    ]);
    let restored = restore(&fx.store, &manifest, &fx.root, &RestoreOptions::default()).await;

    let snapped = snapshot(
        &fx.store,
        &fx.root,
        &SnapshotOptions {
            created_at: 1,
            ..SnapshotOptions::default()
        },
    )
    .await
    .map(|_| ())
    .map_err(|e| e.to_string());

    // Clean up through the anchored API before asserting: nothing that composes
    // a path (including `TempDir`'s recursive drop) can walk back out of here.
    let mut rootfs = RootDir::open(&fx.root).unwrap();
    let _ = rootfs.remove_path(&format!("{deep}/leaf"));
    let mut comps: Vec<String> = (0..depth).map(|i| format!("{name}{i}")).collect();
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
        restored.is_err(),
        "a manifest path no later pass can address must be rejected, not materialized"
    );
    assert!(
        snapped.is_ok(),
        "the restore left the root un-snapshottable: {snapped:?}"
    );
}

/// **Regression — hostile-manifest panic (fixed).**
///
/// `restore::write_file` used to open with `Vec::with_capacity(entry.size as
/// usize)` before it read a single chunk and before the size was cross-checked
/// against the chunk lengths — that check sat at the *end* of the function,
/// after the whole file had been reassembled in memory. A manifest entry
/// declaring `size: u64::MAX` therefore panicked the task with "capacity
/// overflow" without the store ever being touched, and any declared size was an
/// allocation request an unvalidated manifest got to make. `restore` is awaited
/// on the supervisor's cold-wake path, so a panic there is a crash, not an
/// error return.
///
/// `restore` now cross-checks every file entry's `size` against
/// `chunks.iter().map(|c| c.len).sum()` in the up-front pass, before anything is
/// written, and reserves at most `MAX_PREALLOC` ahead of the bytes the store
/// actually produced. The join handle resolving (rather than carrying a panic)
/// is the assertion with teeth here.
#[tokio::test]
async fn a_hostile_declared_size_must_be_an_error_not_a_panic() {
    let fx = Fixture::new();
    let manifest = manifest_of(vec![ManifestEntry {
        path: "/f".to_string(),
        kind: EntryKind::File,
        mode: 0o100644,
        size: u64::MAX,
        symlink_target: None,
        chunks: Vec::new(),
    }]);

    let store = fx.store.clone();
    let root = fx.root.clone();
    let handle =
        tokio::spawn(
            async move { restore(&store, &manifest, &root, &RestoreOptions::default()).await },
        );
    let joined = handle.await;

    assert!(
        joined.is_ok(),
        "restore panicked on a hostile manifest size instead of returning an error"
    );
    assert!(
        joined.unwrap().is_err(),
        "a size that disagrees with the chunk list must be rejected"
    );
}
