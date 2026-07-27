//! Root-anchored filesystem access: a path is never resolved by the kernel's
//! full-path walk, so no operation can be redirected outside the root by a
//! symlink that already sits on disk.
//!
//! # Why this exists
//!
//! Validating a path *lexically* (`/a/b` contains no `..`, so `root/a/b` is
//! under `root`) is not enough. `std::fs::write`, `std::fs::create_dir_all`,
//! `std::fs::set_permissions` and friends hand the whole path to the kernel,
//! which follows every symlink it meets. If `root/a` is already a symlink to
//! `/etc`, a lexically-valid `root/a/b` writes `/etc/b`. That is a root-escape
//! write primitive, and a restore into a *dirty* tree (spec 5.3 revert, which
//! restores into the live root) is exactly the situation that hands an
//! adversary the chance to plant such a symlink.
//!
//! # The mechanism
//!
//! [`RootDir`] opens the root once and keeps the descriptor. Every subsequent
//! operation walks the path **one component at a time** with `openat(…,
//! O_DIRECTORY | O_NOFOLLOW)` relative to the descriptor of the component
//! before it, and every leaf operation is an `*at` call (`mkdirat`,
//! `symlinkat`, `unlinkat`, `openat`, `fchmod` on the opened descriptor)
//! against that parent descriptor. `O_NOFOLLOW` makes the kernel refuse a
//! symlink in the final position, and there is no other position: the walk
//! never hands the kernel more than one component. A descriptor, once opened,
//! names an *inode*, so renaming or replacing a directory after we opened it
//! cannot redirect anything already anchored to it.
//!
//! # Conflicting on-disk nodes
//!
//! A restore is authoritative: the manifest says what the tree is. When a node
//! of the wrong kind occupies a path (a symlink where a directory belongs, a
//! directory where a file belongs), it is **replaced**, never written through.
//! Replacement is `unlinkat` — which removes the link itself, never its target
//! — followed by a fresh create. A *directory* is only ever removed when it is
//! empty (`AT_REMOVEDIR`), so no data the manifest does not mention is deleted
//! recursively by this layer.
//!
//! A regular file with a **link count above one** is replaced the same way, and
//! for the same reason: `O_NOFOLLOW` can refuse a symbolic link but a hard link
//! is not a redirect to refuse — it is a second name for one inode, possibly a
//! name outside the root. See `RootDir::vet_for_write`.
//!
//! # Residual risk (honest accounting)
//!
//! * **No escape is possible, even under a race.** Every step is `O_NOFOLLOW`
//!   against a held descriptor, so an adversary who swaps a component
//!   mid-operation can only make the step *fail*, never redirect it. The
//!   unlink-then-create sequences retry a bounded number of times and then give
//!   up with [`Error::UnsafePath`]; a caller sees an error, never a write
//!   outside the root.
//! * **The root itself is trusted.** [`RootDir::open`] resolves the root path
//!   normally (following symlinks). The root comes from configuration, not from
//!   a manifest or from the guest.
//! * **Directories are opened `O_RDONLY`.** Traversing a directory needs only
//!   `+x`, while holding a descriptor for it needs `+r`. A tree containing an
//!   execute-only directory therefore fails where a plain path walk would have
//!   worked. Restore applies manifest directory modes last (deepest-first), so
//!   this only bites on a *pre-existing* execute-only directory, and the
//!   supervisor restores as root.
//! * **Enumeration is anchored too, where it has to be authoritative.** A
//!   caller that must account for *everything* on disk — the supervisor's revert
//!   prune, because spec 5.3 makes the manifest authoritative over the tree —
//!   enumerates with [`RootDir::walk`], which reads one directory at a time
//!   through a descriptor it already holds. `walkdir` cannot do that job: it
//!   composes a full path for every entry and hands it back to the kernel, so a
//!   subtree deeper than `PATH_MAX` (which a run can build with nothing but
//!   relative `mkdir`s) yields one error instead of entries and survives the
//!   prune in silence. Snapshot still uses `walkdir`: a path it cannot address
//!   fails the snapshot loudly rather than being silently omitted from the
//!   manifest, and every path it finds is fed back through this type, so a raced
//!   swap turns into an error rather than a read of a foreign inode.

use std::fs::File;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::path::{Component, Path, PathBuf};

use mari_proto::EntryKind;
use rustix::fs::{
    AtFlags, CWD, Dir, FileType, Mode, OFlags, RawMode, Stat, fchmod, fstat, ftruncate, mkdirat,
    openat, readlinkat, statat, symlinkat, unlinkat,
};
use rustix::io::Errno;

use crate::error::{Error, Result};

/// Flags for opening a directory component: it must already be (or have just
/// been made) a real directory, and a symlink in that position is refused.
const DIR_FLAGS: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::NOFOLLOW)
    .union(OFlags::CLOEXEC);

/// Mode new intermediate directories are created with. Manifest directory modes
/// are applied afterwards, deepest-first (see [`crate::restore`]).
const NEW_DIR_MODE: RawMode = 0o755;

/// How many times a create/replace sequence retries when the node under it keeps
/// changing. A bounded loop turns a hostile racer into a typed error instead of
/// a spin — it can never turn into an escape, because every individual step is
/// `O_NOFOLLOW`.
const REPLACE_ATTEMPTS: usize = 8;

/// The platform's `PATH_MAX`: the buffer a path — *including* its terminating
/// NUL — has to fit in for any syscall to accept it at all. Kernel ABI, not a
/// policy knob: 4096 on Linux (where marid runs), 1024 on the Darwin/BSD hosts
/// this suite is developed on.
#[cfg(any(target_os = "linux", target_os = "android"))]
pub const PATH_MAX: usize = 4096;
/// The platform's `PATH_MAX` (see the Linux definition above).
#[cfg(not(any(target_os = "linux", target_os = "android")))]
pub const PATH_MAX: usize = 1024;

/// The longest manifest path (`/a/b`, root-relative) that may be realized.
///
/// A composed path is `root + path`, and the shortest root that can exist is
/// one byte (`/`), so this is the longest manifest path that could be handed to
/// a syscall under *any* root: [`PATH_MAX`], less that byte, less the NUL.
pub const MAX_MANIFEST_PATH_BYTES: usize = PATH_MAX - 2;

/// The most components a manifest path may name.
///
/// `/a` is the least a component can cost, so this is exactly what
/// [`MAX_MANIFEST_PATH_BYTES`] already implies. It is stated and checked
/// separately because it bounds a *different* cost: [`RootDir`] holds one open
/// descriptor per resolved component, so the component count is how many
/// descriptors a single manifest path can command mid-restore. Relaxing the
/// byte bound must not silently unbound that.
pub const MAX_MANIFEST_PATH_COMPONENTS: usize = MAX_MANIFEST_PATH_BYTES / 2;

/// Split a manifest entry path (`/a/b`, absolute-in-root) into its components,
/// rejecting anything that would escape the root lexically — a `..`, an embedded
/// root, or a Windows prefix — and anything so long or so deep that no composed
/// path could address it (see below). An empty result names the root itself
/// (manifests carry a `/` entry for the root directory).
///
/// # Why there is a length bound as well as a `..` bound
///
/// The anchored walk resolves one component at a time, so — unlike the composed
/// `std::fs` calls it replaced — it is not itself bound by [`PATH_MAX`]. A
/// manifest can therefore name a path that *no composed path can address*, and
/// without this bound [`crate::restore`] would materialize it quite happily.
/// Nothing afterwards could address it: [`crate::snapshot`] enumerates with
/// `walkdir`, which composes a full path for every entry, so the walk fails
/// `ENAMETOOLONG` — and a walk error is fatal to a snapshot. One hostile (or
/// merely pathological) manifest would leave a computer that can never be
/// checkpointed again, and a computer that cannot snapshot cannot be taken COLD
/// without losing its tree. That is a permanent denial of service, not a bad
/// restore, so an unaddressable path is refused here, before anything is
/// created. The component bound also caps [`RootDir`]'s descriptor stack, which
/// holds one fd per resolved component.
///
/// # Why the bounds are the kernel's and not a "sane tree" number
///
/// This function also validates the paths `snapshot` *finds on disk*, and a
/// guest can build a legal tree of any depth with relative `mkdir`s and no
/// privileges at all. A tighter bound would reject such a tree — producing
/// exactly the un-snapshottable computer this bound exists to prevent, just at
/// a lower threshold. At [`PATH_MAX`], everything `walkdir` can enumerate passes
/// (its composed path is longer than the manifest path it yields) and only what
/// no composed path could ever reach is refused.
///
/// # What is deliberately *not* bounded
///
/// [`RootDir::remove_path`] does not go through here, because *removal* is not
/// subject to this argument in either direction: it acts on a node that already
/// exists, it makes the tree smaller, and refusing it would strand exactly the
/// too-deep subtree [`RootDir::walk`] exists to reach. It uses
/// [`lexical_components`], which is this function's `..` half alone.
pub fn manifest_components(entry_path: &str) -> Result<Vec<String>> {
    if entry_path.len() > MAX_MANIFEST_PATH_BYTES {
        return Err(Error::InvalidManifest(format!(
            "entry path {} is {} bytes; nothing longer than {} can be composed under any root \
             (PATH_MAX is {}), so no later pass could address it",
            elide(entry_path),
            entry_path.len(),
            MAX_MANIFEST_PATH_BYTES,
            PATH_MAX
        )));
    }
    // The byte bound above is checked first, so the split below cannot allocate
    // more than `MAX_MANIFEST_PATH_COMPONENTS` components before this sees them.
    let comps = lexical_components(entry_path)?;
    if comps.len() > MAX_MANIFEST_PATH_COMPONENTS {
        return Err(Error::InvalidManifest(format!(
            "entry path {} names {} components; nothing deeper than {} can be composed under \
             any root, and a restore would hold one descriptor per component",
            elide(entry_path),
            comps.len(),
            MAX_MANIFEST_PATH_COMPONENTS
        )));
    }
    Ok(comps)
}

/// The lexical half of [`manifest_components`]: split into components, refusing
/// a `..`, an embedded root, or a Windows prefix, with no bound on how long or
/// how deep the path is. Only removal uses it — see that function's "What is
/// deliberately not bounded".
fn lexical_components(entry_path: &str) -> Result<Vec<String>> {
    let rel = entry_path.trim_start_matches('/');
    let mut out = Vec::new();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => {
                let s = c.to_str().ok_or_else(|| Error::PathTraversal {
                    path: entry_path.to_string(),
                })?;
                out.push(s.to_string());
            }
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(Error::PathTraversal {
                    path: entry_path.to_string(),
                });
            }
        }
    }
    Ok(out)
}

/// [`manifest_components`], plus the check that the path is still addressable
/// once composed under this *specific* root.
///
/// [`manifest_components`] knows no root, so it can only apply the bound for the
/// shortest one that could exist. The pass that materializes a tree does know
/// the root, and the tree it writes has to stay walkable under exactly that
/// root: a later `snapshot` composes `root + path` for every entry. A path that
/// fits under `/` but not under `/var/lib/mari/computers/…/root` is the
/// unaddressable case all over again, so it is refused rather than written.
pub fn manifest_components_under(root: &Path, entry_path: &str) -> Result<Vec<String>> {
    let comps = manifest_components(entry_path)?;
    // `entry_path` carries its own leading separator, so the composed string is
    // just the two lengths; it needs a NUL after it to be a syscall argument.
    let composed = root.as_os_str().len() + entry_path.len();
    if composed >= PATH_MAX {
        return Err(Error::InvalidManifest(format!(
            "entry path {} composes to {} bytes under {}, past PATH_MAX ({}); no later walk \
             could address it",
            elide(entry_path),
            composed,
            root.display(),
            PATH_MAX
        )));
    }
    Ok(comps)
}

/// A path for an error message: enough of it to identify the entry, not enough
/// for a 4 KiB hostile path to become a 4 KiB log line.
fn elide(path: &str) -> String {
    const KEEP: usize = 64;
    match path.char_indices().nth(KEEP) {
        Some((i, _)) => format!("{:?}…", &path[..i]),
        None => format!("{path:?}"),
    }
}

/// What the filesystem says about a regular file the resolver just looked at:
/// which inode it is, and how many names that inode has **anywhere on the
/// filesystem**, not merely inside the root.
///
/// `nlink` is the one fact that makes a hard link visible at all. `O_NOFOLLOW`
/// cannot help here — a hard link is not a redirect to refuse but a second
/// directory entry for one inode — so a reader that must stay inside the root
/// has to reason about the link count itself.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct FileFacts {
    /// The device the inode lives on. Only `(dev, ino)` together identify it.
    pub dev: u64,
    /// The inode number.
    pub ino: u64,
    /// How many names this inode has, anywhere. `1` means the name it was
    /// resolved through is its only one.
    pub nlink: u64,
    /// `st_mode`, including the file-type bits.
    pub mode: u32,
    /// Byte length.
    pub size: u64,
}

impl FileFacts {
    // The widths of these fields are per-platform (`dev_t` is `i32` on macOS and
    // `u64` on Linux, `nlink_t` is `u16` and `u64`), so the casts are load-
    // bearing on one target and redundant on the other. They match what
    // `std::os::unix::fs::MetadataExt` does with the same fields, which is what
    // makes an id from here comparable with one from a `Metadata`.
    #[allow(clippy::unnecessary_cast)]
    fn of(st: &Stat) -> Self {
        Self {
            dev: st.st_dev as u64,
            ino: st.st_ino as u64,
            nlink: st.st_nlink as u64,
            mode: st.st_mode as u32,
            size: st.st_size.max(0) as u64,
        }
    }

    /// The inode this file is, as a key: an inode is only unique per device.
    pub fn inode(&self) -> (u64, u64) {
        (self.dev, self.ino)
    }
}

/// An open handle on a directory that every operation is anchored to. No path
/// given to it can name anything outside that directory, whatever is on disk.
///
/// It caches the descriptors of the last resolved path prefix, so restoring or
/// walking a path-sorted tree costs roughly one `openat` per directory rather
/// than one per entry. The cache is bounded by the depth of the tree.
pub struct RootDir {
    root: OwnedFd,
    display: PathBuf,
    /// The currently-resolved prefix, root-relative: `(component, descriptor)`.
    stack: Vec<(String, OwnedFd)>,
}

impl std::fmt::Debug for RootDir {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RootDir")
            .field("root", &self.display)
            .finish()
    }
}

impl RootDir {
    /// Open `root` as the anchor for every later operation. The root path
    /// itself is resolved normally (it is configuration, not manifest data);
    /// everything *under* it is resolved one `O_NOFOLLOW` component at a time.
    pub fn open(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        let fd = openat(
            CWD,
            root,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map_err(|e| Error::io(root.display().to_string(), e.into()))?;
        Ok(Self {
            root: fd,
            display: root.to_path_buf(),
            stack: Vec::new(),
        })
    }

    /// The path this handle is anchored to (for messages).
    pub fn path(&self) -> &Path {
        &self.display
    }

    // ---- internals -----------------------------------------------------

    /// The descriptor of the deepest currently-resolved directory.
    fn tip(&self) -> BorrowedFd<'_> {
        match self.stack.last() {
            Some((_, fd)) => fd.as_fd(),
            None => self.root.as_fd(),
        }
    }

    fn display_of(&self, comps: &[String]) -> String {
        let mut p = self.display.clone();
        for c in comps {
            p.push(c);
        }
        p.display().to_string()
    }

    fn io_err(&self, comps: &[String], e: Errno) -> Error {
        Error::io(self.display_of(comps), e.into())
    }

    fn unsafe_err(&self, comps: &[String], detail: impl Into<String>) -> Error {
        Error::UnsafePath {
            path: self.display_of(comps),
            detail: detail.into(),
        }
    }

    fn split<'a>(&self, comps: &'a [String]) -> Result<(&'a [String], &'a str)> {
        match comps.split_last() {
            Some((name, dirs)) => Ok((dirs, name.as_str())),
            None => Err(Error::InvalidManifest(format!(
                "entry path names the root {} itself",
                self.display.display()
            ))),
        }
    }

    /// Resolve `dirs` from the root, leaving the cache positioned there. Every
    /// component must be a real directory; with `create`, a missing one is made
    /// and a non-directory one is replaced. Never follows a symlink.
    fn descend(&mut self, dirs: &[String], create: bool) -> Result<()> {
        let shared = self
            .stack
            .iter()
            .zip(dirs)
            .take_while(|(have, want)| have.0.as_str() == want.as_str())
            .count();
        self.stack.truncate(shared);
        for depth in shared..dirs.len() {
            let fd = self.open_dir_component(&dirs[..=depth], create)?;
            self.stack.push((dirs[depth].clone(), fd));
        }
        Ok(())
    }

    /// Open (optionally creating) the last component of `path` as a directory,
    /// relative to the current tip.
    fn open_dir_component(&self, path: &[String], create: bool) -> Result<OwnedFd> {
        let (_, name) = self.split(path)?;
        for _ in 0..REPLACE_ATTEMPTS {
            match openat(self.tip(), name, DIR_FLAGS, Mode::empty()) {
                Ok(fd) => return Ok(fd),
                Err(e) if e == Errno::NOENT => {
                    if !create {
                        return Err(self.io_err(path, e));
                    }
                }
                // A symlink (ELOOP under O_NOFOLLOW) or a non-directory
                // (ENOTDIR) occupies this component.
                Err(e) if e == Errno::LOOP || e == Errno::NOTDIR => {
                    if !create {
                        return Err(
                            self.unsafe_err(path, "path component is a symlink or not a directory")
                        );
                    }
                }
                Err(e) => return Err(self.io_err(path, e)),
            }

            // `create` from here. `mkdirat` never follows a symlink: if one
            // occupies the name it fails EEXIST rather than creating anything
            // at the symlink's target.
            match mkdirat(self.tip(), name, Mode::from_raw_mode(NEW_DIR_MODE)) {
                Ok(()) => continue,
                Err(e) if e == Errno::EXIST => {}
                Err(e) => return Err(self.io_err(path, e)),
            }
            match self.kind_of(path)? {
                // Vanished under us, or already a directory we simply failed to
                // open a moment ago: go round and try the open again.
                None => continue,
                Some(FileType::Directory) => continue,
                // A symlink, a regular file, a fifo, a device: the manifest
                // needs a directory here, so the node is replaced. Only the
                // node itself is removed — `unlinkat` does not follow a link.
                Some(kind) => self.remove_at(path, kind)?,
            }
        }
        Err(self.unsafe_err(
            path,
            "the node at this path kept changing while it was being created",
        ))
    }

    /// `lstat` the last component of `path` against the tip; `None` if absent.
    fn kind_of(&self, path: &[String]) -> Result<Option<FileType>> {
        let (_, name) = self.split(path)?;
        match statat(self.tip(), name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(st) => Ok(Some(FileType::from_raw_mode(st.st_mode))),
            Err(e) if e == Errno::NOENT => Ok(None),
            Err(e) => Err(self.io_err(path, e)),
        }
    }

    /// Remove the last component of `path` from the tip directory without
    /// following it. A directory is removed only when empty; the resulting
    /// `ENOTEMPTY` is reported as an [`Error::Io`] so a caller can recognize it
    /// by [`std::io::ErrorKind::DirectoryNotEmpty`].
    fn remove_at(&self, path: &[String], kind: FileType) -> Result<()> {
        let (_, name) = self.split(path)?;
        let flags = if kind == FileType::Directory {
            AtFlags::REMOVEDIR
        } else {
            AtFlags::empty()
        };
        match unlinkat(self.tip(), name, flags) {
            Ok(()) => Ok(()),
            Err(e) if e == Errno::NOENT => Ok(()),
            Err(e) => Err(self.io_err(path, e)),
        }
    }

    // ---- operations ----------------------------------------------------

    /// Make `comps` a real directory, creating every missing ancestor and
    /// replacing any non-directory node in the way. An empty `comps` is the
    /// root, which already exists.
    pub fn create_dir(&mut self, comps: &[String]) -> Result<()> {
        if comps.is_empty() {
            return Ok(());
        }
        // Descending *into* the directory both creates it and caches it, which
        // is exactly what the entries under it need next.
        self.descend(comps, true)
    }

    /// Open the file at `comps` for writing, truncated, creating parents as
    /// needed. A symlink at the target — or at any component of the path — is
    /// replaced, never followed, so the bytes always land inside the root.
    ///
    /// An existing regular file with exactly one link is truncated in place
    /// (not unlinked), so an open descriptor on it keeps seeing the file the
    /// manifest describes. A **multiply-linked** one is unlinked and recreated
    /// instead — a hard link is a second name for one inode, so reusing it
    /// would write the manifest's bytes through every other name that inode
    /// has, including names outside the root.
    pub fn create_file(&mut self, comps: &[String], mode: u32) -> Result<File> {
        let (dirs, name) = self.split(comps)?;
        self.descend(dirs, true)?;
        let create_mode = Mode::from_raw_mode((mode & 0o7777) as RawMode);
        for _ in 0..REPLACE_ATTEMPTS {
            // O_EXCL settles the common case (nothing there) with no window at
            // all, and cannot follow a symlink by definition.
            match openat(
                self.tip(),
                name,
                OFlags::WRONLY
                    | OFlags::CREATE
                    | OFlags::EXCL
                    | OFlags::NOFOLLOW
                    | OFlags::CLOEXEC
                    | OFlags::NONBLOCK,
                create_mode,
            ) {
                Ok(fd) => return Ok(File::from(fd)),
                Err(e) if e == Errno::EXIST => {}
                Err(e) => return Err(self.io_err(comps, e)),
            }
            match self.kind_of(comps)? {
                None => continue,
                Some(FileType::RegularFile) => {
                    // Reopen to reuse the inode — deliberately *without*
                    // O_TRUNC, because truncation is already the destructive
                    // act: by the time a vetting `fstat` could run, an inode
                    // outside the root would be empty. O_NOFOLLOW still guards
                    // the position, and O_NONBLOCK means a racing fifo cannot
                    // park us forever; `vet_for_write` below decides whether
                    // this descriptor may be written at all.
                    match openat(
                        self.tip(),
                        name,
                        OFlags::WRONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
                        Mode::empty(),
                    ) {
                        Ok(fd) => match self.vet_for_write(comps, &fd)? {
                            Vetted::Reuse => {
                                ftruncate(&fd, 0).map_err(|e| self.io_err(comps, e))?;
                                return Ok(File::from(fd));
                            }
                            // A second name for this inode: it may be a name
                            // outside the root, and nothing about this
                            // descriptor can tell us that it is not. Drop it
                            // untouched, unlink *the name we resolved* (which
                            // is anchored under the root and cannot be the
                            // outside one), and let the next attempt create a
                            // fresh, singly-linked inode with O_EXCL.
                            Vetted::Replace => {
                                drop(fd);
                                self.remove_at(comps, FileType::RegularFile)?;
                            }
                            // Raced into something else; drop it and retry.
                            Vetted::Retry => drop(fd),
                        },
                        Err(e) if e == Errno::LOOP || e == Errno::NOENT => {}
                        Err(e) => return Err(self.io_err(comps, e)),
                    }
                }
                // A symlink, a directory, a fifo, a device: replace it. This is
                // the write-through case the whole module exists to stop.
                Some(kind) => self.remove_at(comps, kind)?,
            }
        }
        Err(self.unsafe_err(
            comps,
            "the node at this path kept changing while the file was being created",
        ))
    }

    /// Create the symlink at `comps` pointing at `target`, creating parents as
    /// needed and replacing any node already at the path.
    pub fn create_symlink(&mut self, comps: &[String], target: &str) -> Result<()> {
        let (dirs, name) = self.split(comps)?;
        self.descend(dirs, true)?;
        for _ in 0..REPLACE_ATTEMPTS {
            match symlinkat(target, self.tip(), name) {
                Ok(()) => return Ok(()),
                Err(e) if e == Errno::EXIST => {}
                Err(e) => return Err(self.io_err(comps, e)),
            }
            match self.kind_of(comps)? {
                None => continue,
                Some(kind) => self.remove_at(comps, kind)?,
            }
        }
        Err(self.unsafe_err(
            comps,
            "the node at this path kept changing while the symlink was being created",
        ))
    }

    /// Set the mode of the directory at `comps` (empty = the root). The
    /// directory is opened `O_NOFOLLOW` first and `fchmod`'d through that
    /// descriptor, so the bits can never land on a symlink's target.
    pub fn chmod_dir(&mut self, comps: &[String], mode: u32) -> Result<()> {
        self.descend(comps, false)?;
        fchmod(self.tip(), Mode::from_raw_mode((mode & 0o7777) as RawMode))
            .map_err(|e| self.io_err(comps, e))
    }

    /// Open the regular file at `comps` for reading and return it with the
    /// [`FileFacts`] of the descriptor itself — **without reading a byte**. A
    /// symlink anywhere in the path, including the final component, is an
    /// [`Error::UnsafePath`].
    ///
    /// This exists because refusing symlinks is not the whole of "no bytes from
    /// outside the root". A hard link is a second name for one inode; the name
    /// resolved here is inside the root, but the inode may have other names that
    /// are not. `nlink` is the only evidence the kernel offers about that, and a
    /// caller that has to decide whether it may read this inode gets it from
    /// `fstat` on the very descriptor it would read from — never from a `statat`
    /// on the name, which describes whatever occupied it at some earlier
    /// instant. See [`crate::snapshot`] for the decision that uses it.
    pub fn open_file(&mut self, comps: &[String]) -> Result<(File, FileFacts)> {
        let (dirs, name) = self.split(comps)?;
        self.descend(dirs, false)?;
        let fd = match openat(
            self.tip(),
            name,
            OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::NONBLOCK,
            Mode::empty(),
        ) {
            Ok(fd) => fd,
            Err(e) if e == Errno::LOOP => {
                return Err(self.unsafe_err(comps, "target is a symlink, not a regular file"));
            }
            Err(e) => return Err(self.io_err(comps, e)),
        };
        let st = self.stat_fd(comps, &fd)?;
        if !is_regular(&st) {
            return Err(self.unsafe_err(comps, "target is not a regular file"));
        }
        Ok((File::from(fd), FileFacts::of(&st)))
    }

    /// The [`FileFacts`] of the regular file at `comps`, resolved root-anchored
    /// and without following a symlink in any position. `None` when the path
    /// does not currently name a regular file inside the root — it is absent, a
    /// component vanished, or a component is no longer a directory.
    ///
    /// This answers "does *this name* still refer to *that inode* right now",
    /// which is how a caller re-checks a name it learned about earlier.
    pub fn stat_file(&mut self, comps: &[String]) -> Result<Option<FileFacts>> {
        let (dirs, name) = self.split(comps)?;
        match self.descend(dirs, false) {
            Ok(()) => {}
            // The path no longer leads anywhere inside the root: a missing
            // component, or one that is now a symlink or a non-directory.
            Err(Error::Io { ref source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(None);
            }
            Err(Error::UnsafePath { .. }) => return Ok(None),
            Err(e) => return Err(e),
        }
        match statat(self.tip(), name, AtFlags::SYMLINK_NOFOLLOW) {
            Ok(st) if is_regular(&st) => Ok(Some(FileFacts::of(&st))),
            Ok(_) => Ok(None),
            Err(e) if e == Errno::NOENT || e == Errno::NOTDIR || e == Errno::LOOP => Ok(None),
            Err(e) => Err(self.io_err(comps, e)),
        }
    }

    /// Read the regular file at `comps` and return its bytes and its `st_mode`.
    /// A symlink anywhere in the path — including the final component — is an
    /// [`Error::UnsafePath`], so no bytes from outside the root can be read.
    ///
    /// Reads unconditionally: a caller that must also account for the inode's
    /// hard links uses [`RootDir::open_file`] and decides before reading.
    pub fn read_file(&mut self, comps: &[String]) -> Result<(Vec<u8>, u32)> {
        let (file, facts) = self.open_file(comps)?;
        let buf = self.read_open_file(comps, file, &facts)?;
        Ok((buf, facts.mode))
    }

    /// Drain a descriptor from [`RootDir::open_file`] into memory. `facts` only
    /// sizes the first allocation; the read itself is what decides how many
    /// bytes there are.
    pub fn read_open_file(
        &self,
        comps: &[String],
        mut file: File,
        facts: &FileFacts,
    ) -> Result<Vec<u8>> {
        use std::io::Read;

        let mut buf = Vec::with_capacity(facts.size as usize);
        file.read_to_end(&mut buf)
            .map_err(|e| Error::io(self.display_of(comps), e))?;
        Ok(buf)
    }

    /// Read the link text of the symlink at `comps`, as raw bytes. Never
    /// follows the link, and never traverses a symlinked component.
    pub fn read_link(&mut self, comps: &[String]) -> Result<Vec<u8>> {
        let (dirs, name) = self.split(comps)?;
        self.descend(dirs, false)?;
        let target =
            readlinkat(self.tip(), name, Vec::<u8>::new()).map_err(|e| self.io_err(comps, e))?;
        Ok(target.into_bytes())
    }

    /// Remove the node at the manifest path `path` (`/a/b`), root-anchored: no
    /// component is followed through a symlink, a symlink is unlinked rather
    /// than its target, and a directory is removed only when empty (which
    /// surfaces as an [`Error::Io`] whose kind is
    /// [`std::io::ErrorKind::DirectoryNotEmpty`]).
    ///
    /// Returns whether a node was actually removed. Refuses to remove the root.
    ///
    /// The path is checked lexically (no `..`, no embedded root) but is **not**
    /// held to [`MAX_MANIFEST_PATH_BYTES`]: that bound exists to stop a manifest
    /// *creating* something no later pass could address, and a removal is the
    /// one operation that has to be able to reach such a node — [`Self::walk`]
    /// finds the too-deep subtree a composed walker cannot, and this is what
    /// deletes it.
    pub fn remove_path(&mut self, path: &str) -> Result<bool> {
        let comps = lexical_components(path)?;
        if comps.is_empty() {
            return Err(Error::UnsafePath {
                path: self.display.display().to_string(),
                detail: "refusing to remove the root itself".to_string(),
            });
        }
        let (dirs, _) = self.split(&comps)?;
        match self.descend(dirs, false) {
            Ok(()) => {}
            // A parent that no longer exists means the node does not either.
            Err(Error::Io { source, .. }) if source.kind() == std::io::ErrorKind::NotFound => {
                return Ok(false);
            }
            Err(e) => return Err(e),
        }
        match self.kind_of(&comps)? {
            None => Ok(false),
            Some(kind) => {
                self.remove_at(&comps, kind)?;
                Ok(true)
            }
        }
    }

    /// Enumerate everything under the root, **children before their parents**,
    /// without ever composing a path: each directory is read through the
    /// descriptor its parent's read handed us (`openat` + `getdents`), so the
    /// only name the kernel ever resolves is a single component.
    ///
    /// This is what makes a prune authoritative. A composed-path walker
    /// (`walkdir`, `std::fs::read_dir` on a joined path) stops at `PATH_MAX`:
    /// a run can build a subtree deeper than that with relative `mkdir`s alone,
    /// and every entry below the limit comes back as an error instead of a path
    /// — so a caller that must delete "everything the manifest does not name"
    /// never learns those entries exist. Anchored enumeration has no such limit,
    /// and the contents-first order means a directory is only ever reached after
    /// the walk has already offered its children.
    ///
    /// Ordering is deterministic (each directory's entries ascending by name).
    ///
    /// The returned walk owns its own descriptors and does not borrow the
    /// [`RootDir`], so the caller can act on each entry — [`Self::remove_path`]
    /// takes `&mut self` — while iterating.
    ///
    /// # What a caller must handle
    ///
    /// Items are [`Result`]s, and an `Err` is **not** skippable noise: it means
    /// a node exists that this walk could not account for (a directory it could
    /// not open or read, or a name with no manifest form). A caller whose job is
    /// to be authoritative has to report that, because what it leaves behind is
    /// then not what it decided to leave behind. The walk itself continues.
    ///
    /// One descriptor is held per level of depth, so a hostile tree deep enough
    /// to exhaust `RLIMIT_NOFILE` turns into such an `Err` — loud and bounded,
    /// never a silent gap.
    pub fn walk(&self) -> Result<RootWalk> {
        // `openat(root, ".")` rather than a `dup`: the walk gets an independent
        // file position without depending on the root handle's own state.
        let fd = openat(self.root.as_fd(), ".", DIR_FLAGS, Mode::empty())
            .map_err(|e| Error::io(self.display.display().to_string(), e.into()))?;
        let pending = read_children(fd.as_fd())
            .map_err(|e| Error::io(self.display.display().to_string(), e.into()))?;
        Ok(RootWalk {
            display: self.display.clone(),
            queued: None,
            stack: vec![WalkLevel {
                fd,
                prefix: String::new(),
                pending,
                own: None,
            }],
        })
    }

    fn stat_fd(&self, comps: &[String], fd: &OwnedFd) -> Result<Stat> {
        fstat(fd).map_err(|e| self.io_err(comps, e))
    }

    /// Decide whether an already-open descriptor may be written through.
    ///
    /// `O_NOFOLLOW` refuses a *symbolic* link, which is the only thing the
    /// kernel can be asked not to follow. A **hard** link is not a redirect: it
    /// is a second directory entry for one inode, so there is nothing to follow
    /// and nothing to refuse. Reusing such an inode means the manifest's bytes
    /// (and, via the `fchmod` the caller does next, the manifest's mode) land on
    /// every name that inode has — including names outside the root, and
    /// including a chunk-store body. That is a write primitive with no bound at
    /// all, so a link count above one is treated exactly like a wrong-kind node:
    /// the name is replaced rather than written through.
    ///
    /// This is checked on the **open descriptor**, never on the path before the
    /// open: a pre-open `statat` describes whatever occupied the name at that
    /// instant, and the whole attack is to change it afterwards. `fstat` on the
    /// descriptor we are about to write describes the inode we are about to
    /// write, with no window in between.
    ///
    /// Breaking the link costs nothing a manifest can express: manifests have no
    /// hard-link concept (each path carries its own chunk list), so a restore
    /// owes no caller a shared inode.
    fn vet_for_write(&self, comps: &[String], fd: &OwnedFd) -> Result<Vetted> {
        let st = self.stat_fd(comps, fd)?;
        if !is_regular(&st) {
            return Ok(Vetted::Retry);
        }
        if st.st_nlink > 1 {
            return Ok(Vetted::Replace);
        }
        Ok(Vetted::Reuse)
    }
}

/// What [`RootDir::vet_for_write`] concluded about an opened descriptor.
enum Vetted {
    /// A singly-linked regular file: truncate it in place.
    Reuse,
    /// A multiply-linked regular file: unlink the name and create fresh, so the
    /// write cannot reach the inode's other names.
    Replace,
    /// Raced into something that is no longer a regular file: start over.
    Retry,
}

fn is_regular(st: &Stat) -> bool {
    FileType::from_raw_mode(st.st_mode) == FileType::RegularFile
}

// ---------------------------------------------------------------------------
// anchored enumeration
// ---------------------------------------------------------------------------

/// One node an anchored walk found.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WalkEntry {
    /// The node's path in manifest form (`/a/b`), relative to the walk's root.
    pub path: String,
    /// What the node was when the walk saw it — the classification a manifest
    /// uses, so it can be compared with a [`mari_proto::ManifestEntry`] directly.
    /// Everything that is neither a directory nor a symlink (regular file, fifo,
    /// socket, device) is reported as [`EntryKind::File`], exactly as a
    /// path-composing walk reported it before.
    pub kind: EntryKind,
}

/// A contents-first walk of a [`RootDir`] that never composes a path. Built by
/// [`RootDir::walk`]; see there for what an `Err` item means.
pub struct RootWalk {
    /// The root's on-disk path, used only to build error messages.
    display: PathBuf,
    /// Open directories on the current path, root first. Each holds the
    /// descriptor its own entries are read and resolved against.
    stack: Vec<WalkLevel>,
    /// An entry to hand out before resuming the walk: a directory whose insides
    /// could not be read is still reported to the caller, but only after the
    /// error that says its subtree is unaccounted for.
    queued: Option<WalkEntry>,
}

struct WalkLevel {
    fd: OwnedFd,
    /// This directory's manifest path (`""` for the root, `/a` below it), which
    /// its children's paths are built from — a string, never a path the kernel
    /// is asked to resolve.
    prefix: String,
    /// Children not visited yet, descending by name so `pop` yields ascending.
    pending: Vec<Child>,
    /// The directory itself, handed out once its contents are exhausted. `None`
    /// for the root, which the walk does not own.
    own: Option<WalkEntry>,
}

/// One name read out of a directory, before anything is opened.
struct Child {
    /// The name, or `None` when it is not valid UTF-8.
    name: Option<String>,
    /// Lossy rendering, only used to report a non-UTF-8 name.
    lossy: String,
    /// What `getdents` said it is; `Unknown` on filesystems that do not fill in
    /// `d_type`, in which case the walk asks with `statat`.
    ft: FileType,
}

impl std::fmt::Debug for RootWalk {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RootWalk")
            .field("root", &self.display)
            .field("depth", &self.stack.len())
            .finish()
    }
}

impl RootWalk {
    /// The on-disk path a manifest-form path names, for error messages only —
    /// composed as text, never handed to the kernel.
    fn display_of(&self, path: &str) -> String {
        self.display
            .join(path.trim_start_matches('/'))
            .display()
            .to_string()
    }

    fn io_at(&self, path: &str, e: Errno) -> Error {
        Error::io(self.display_of(path), e.into())
    }
}

impl Iterator for RootWalk {
    type Item = Result<WalkEntry>;

    fn next(&mut self) -> Option<Self::Item> {
        if let Some(entry) = self.queued.take() {
            return Some(Ok(entry));
        }
        loop {
            let level = self.stack.last_mut()?;
            let Some(child) = level.pending.pop() else {
                // Contents exhausted: the directory itself comes after them.
                let done = self.stack.pop().expect("the level was just borrowed");
                match done.own {
                    Some(entry) => return Some(Ok(entry)),
                    // The root is not part of its own walk; nothing is above it.
                    None => continue,
                }
            };
            let depth = self.stack.len() - 1;
            let name = match child.name {
                Some(name) => name,
                None => {
                    // A name with no manifest form: no manifest can name it, and
                    // no caller of this crate can address it. Report it — leaving
                    // it out entirely is how a tree keeps a node nobody sees.
                    let shown = format!("{}/{}", self.stack[depth].prefix, child.lossy);
                    return Some(Err(Error::io(
                        self.display_of(&shown),
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "directory entry name is not valid UTF-8",
                        ),
                    )));
                }
            };
            let path = format!("{}/{}", self.stack[depth].prefix, name);

            // What is it? `d_type` when the filesystem filled it in, `statat`
            // against the parent descriptor when it did not.
            let ft = if child.ft == FileType::Unknown {
                let st = statat(
                    self.stack[depth].fd.as_fd(),
                    name.as_str(),
                    AtFlags::SYMLINK_NOFOLLOW,
                );
                match st {
                    Ok(st) => FileType::from_raw_mode(st.st_mode),
                    // Gone since the directory was read: it is not in the tree.
                    Err(Errno::NOENT) => continue,
                    Err(e) => return Some(Err(self.io_at(&path, e))),
                }
            } else {
                child.ft
            };
            if ft != FileType::Directory {
                return Some(Ok(WalkEntry {
                    path,
                    kind: walk_kind(ft),
                }));
            }

            // A directory: descend through its own descriptor. `O_NOFOLLOW` here
            // is what stops a symlink swapped in since the read from turning the
            // walk into an enumeration of some other tree.
            let opened = openat(
                self.stack[depth].fd.as_fd(),
                name.as_str(),
                DIR_FLAGS,
                Mode::empty(),
            );
            let fd = match opened {
                Ok(fd) => fd,
                Err(Errno::NOENT) => continue,
                Err(Errno::LOOP) | Err(Errno::NOTDIR) => {
                    // Replaced between the read and the open. Report what the
                    // name holds now, so the caller acts on the node that is
                    // actually there.
                    let st = statat(
                        self.stack[depth].fd.as_fd(),
                        name.as_str(),
                        AtFlags::SYMLINK_NOFOLLOW,
                    );
                    match st {
                        Ok(st) => {
                            return Some(Ok(WalkEntry {
                                path,
                                kind: walk_kind(FileType::from_raw_mode(st.st_mode)),
                            }));
                        }
                        Err(Errno::NOENT) => continue,
                        Err(e) => return Some(Err(self.io_at(&path, e))),
                    }
                }
                Err(e) => {
                    // No way in (permissions, descriptors exhausted): its subtree
                    // is unaccounted for. Say so, and still hand over the
                    // directory itself.
                    self.queued = Some(WalkEntry {
                        path: path.clone(),
                        kind: EntryKind::Dir,
                    });
                    return Some(Err(self.io_at(&path, e)));
                }
            };
            let own = WalkEntry {
                path: path.clone(),
                kind: EntryKind::Dir,
            };
            match read_children(fd.as_fd()) {
                Ok(pending) => self.stack.push(WalkLevel {
                    fd,
                    prefix: path,
                    pending,
                    own: Some(own),
                }),
                Err(e) => {
                    self.queued = Some(own);
                    return Some(Err(self.io_at(&path, e)));
                }
            }
        }
    }
}

/// Read every name in an already-open directory, in one pass, before anything
/// under it is opened or removed: the descriptor's own iteration state is not
/// held across a caller's mutations of the same directory. Memory is bounded by
/// the widest directory on the current path, not by the size of the tree.
fn read_children(fd: BorrowedFd<'_>) -> std::result::Result<Vec<Child>, Errno> {
    let mut dir = Dir::read_from(fd)?;
    let mut out: Vec<Child> = Vec::new();
    while let Some(entry) = dir.read() {
        let entry = entry?;
        let raw = entry.file_name().to_bytes();
        if raw == b"." || raw == b".." {
            continue;
        }
        let (name, lossy) = match std::str::from_utf8(raw) {
            Ok(s) => (Some(s.to_string()), String::new()),
            Err(_) => (None, String::from_utf8_lossy(raw).into_owned()),
        };
        out.push(Child {
            name,
            lossy,
            ft: entry.file_type(),
        });
    }
    // Popped from the back, so descending order hands them out ascending.
    out.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(out)
}

/// A filesystem node's kind in the manifest's vocabulary. Anything that is
/// neither a directory nor a symlink is a "file": manifests have no other kinds,
/// and a caller comparing against one must see the same three.
fn walk_kind(ft: FileType) -> EntryKind {
    match ft {
        FileType::Directory => EntryKind::Dir,
        FileType::Symlink => EntryKind::Symlink,
        _ => EntryKind::File,
    }
}
