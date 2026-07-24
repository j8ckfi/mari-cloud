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
//! * **Enumeration is not anchored.** Callers that *walk* a tree (snapshot,
//!   the supervisor's revert prune) use `walkdir`, which does not follow
//!   symlinks but does re-resolve paths. They feed the paths they find back
//!   through this type, so a raced swap turns into an error rather than an
//!   operation on a foreign inode.

use std::fs::File;
use std::os::fd::{AsFd, BorrowedFd, OwnedFd};
use std::path::{Component, Path, PathBuf};

use rustix::fs::{
    fchmod, fstat, mkdirat, openat, readlinkat, statat, symlinkat, unlinkat, AtFlags, FileType,
    Mode, OFlags, RawMode, Stat, CWD,
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

/// Split a manifest entry path (`/a/b`, absolute-in-root) into its components,
/// rejecting anything that would escape the root lexically: a `..`, an embedded
/// root, or a Windows prefix. An empty result names the root itself (manifests
/// carry a `/` entry for the root directory).
pub fn manifest_components(entry_path: &str) -> Result<Vec<String>> {
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
                        return Err(self.unsafe_err(
                            path,
                            "path component is a symlink or not a directory",
                        ));
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
    /// An existing regular file is truncated in place (not unlinked), matching
    /// `std::fs::write` semantics for hard links and open descriptors.
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
                    // Reopen with O_TRUNC. O_NOFOLLOW still guards the position,
                    // and O_NONBLOCK means a racing fifo cannot park us forever;
                    // the fstat below confirms what we actually got.
                    match openat(
                        self.tip(),
                        name,
                        OFlags::WRONLY
                            | OFlags::TRUNC
                            | OFlags::NOFOLLOW
                            | OFlags::CLOEXEC
                            | OFlags::NONBLOCK,
                        Mode::empty(),
                    ) {
                        Ok(fd) => {
                            if is_regular(&self.stat_fd(comps, &fd)?) {
                                return Ok(File::from(fd));
                            }
                            // Raced into something else; drop it and retry.
                        }
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

    /// Read the regular file at `comps` and return its bytes and its `st_mode`.
    /// A symlink anywhere in the path — including the final component — is an
    /// [`Error::UnsafePath`], so no bytes from outside the root can be read.
    pub fn read_file(&mut self, comps: &[String]) -> Result<(Vec<u8>, u32)> {
        use std::io::Read;

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
        let mut file = File::from(fd);
        let mut buf = Vec::with_capacity(st.st_size.max(0) as usize);
        file.read_to_end(&mut buf)
            .map_err(|e| Error::io(self.display_of(comps), e))?;
        Ok((buf, u32::from(st.st_mode)))
    }

    /// Read the link text of the symlink at `comps`, as raw bytes. Never
    /// follows the link, and never traverses a symlinked component.
    pub fn read_link(&mut self, comps: &[String]) -> Result<Vec<u8>> {
        let (dirs, name) = self.split(comps)?;
        self.descend(dirs, false)?;
        let target = readlinkat(self.tip(), name, Vec::<u8>::new())
            .map_err(|e| self.io_err(comps, e))?;
        Ok(target.into_bytes())
    }

    /// Remove the node at the manifest path `path` (`/a/b`), root-anchored: no
    /// component is followed through a symlink, a symlink is unlinked rather
    /// than its target, and a directory is removed only when empty (which
    /// surfaces as an [`Error::Io`] whose kind is
    /// [`std::io::ErrorKind::DirectoryNotEmpty`]).
    ///
    /// Returns whether a node was actually removed. Refuses to remove the root.
    pub fn remove_path(&mut self, path: &str) -> Result<bool> {
        let comps = manifest_components(path)?;
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

    fn stat_fd(&self, comps: &[String], fd: &OwnedFd) -> Result<Stat> {
        fstat(fd).map_err(|e| self.io_err(comps, e))
    }
}

fn is_regular(st: &Stat) -> bool {
    FileType::from_raw_mode(st.st_mode) == FileType::RegularFile
}
