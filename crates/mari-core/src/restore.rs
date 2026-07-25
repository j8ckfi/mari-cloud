//! Restore: reconstruct a byte-identical tree from a [`Manifest`] (spec 5.3).
//!
//! Every file comes back with its exact bytes (each chunk blake3-verified on
//! read), its mode, and — for symlinks — its link text, including dangling
//! links. A priority path list (heat-profile order, spec 4.6(d)) is restored
//! first so the first-prompt-critical files land before the long tail.
//!
//! # Staying inside the root
//!
//! Restore is hostile-input safe in two independent ways, because a revert
//! (spec 5.3) restores into the **live, dirty** root — a tree an adversary has
//! been able to write to.
//!
//! 1. **The manifest cannot name a path outside the root.** An entry whose path
//!    carries a `..`, an embedded root, or a Windows prefix is rejected with
//!    [`Error::PathTraversal`], up front, before anything is written.
//! 2. **The disk cannot redirect a path outside the root.** A lexically-valid
//!    path is still a lie if `root/a` is already a symlink to `/etc`: the
//!    kernel would happily resolve `root/a/b` to `/etc/b`. So every operation
//!    here — directory creation, file write, symlink creation, mode change —
//!    goes through [`crate::rootfs::RootDir`], which walks one component at a
//!    time from a held descriptor with `O_NOFOLLOW` and never lets the kernel
//!    resolve more than a single name. See that module for the mechanism and
//!    for the residual-risk accounting.
//!
//! A pre-existing node whose kind conflicts with the manifest (a symlink where
//! a directory belongs, a directory where a file belongs) is **replaced**, not
//! written through, and not treated as a fatal error: the manifest is the truth
//! about the tree, and a revert that refused to run because a run had left a
//! stale symlink behind would be a denial of service on the recovery path. Only
//! the conflicting node is removed — a symlink is unlinked, never followed, and
//! a directory only when it is empty.
//!
//! # Declared sizes are claims, not facts
//!
//! Every number in a manifest is untrusted for the same reason its paths are:
//! restore runs on the supervisor's cold-wake path, against a manifest a run
//! may have influenced. A file entry's `size` is therefore never handed to the
//! allocator on the entry's own say-so — an entry declaring `u64::MAX` would
//! abort the process with "capacity overflow" long before any chunk was read,
//! turning a hostile manifest into a crash of a daemon. Sizes are cross-checked
//! against the chunk-length sum up front (pass 0, before a single byte is
//! written), and the reassembly buffer past [`MAX_PREALLOC`] grows only as
//! verified chunk bytes actually arrive from the store. Nothing in this module
//! panics on manifest content: every inconsistency is an [`Error`].

use std::collections::HashSet;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::path::Path;

use mari_proto::{EntryKind, Manifest, ManifestEntry};

use crate::error::{Error, Result};
use crate::rootfs::{RootDir, manifest_components_under};
use crate::store::ChunkStore;

/// The most a restore will reserve for a file *before* it has read the
/// corresponding bytes back from the store. A file smaller than this gets its
/// buffer in one allocation, as before; anything larger grows incrementally, so
/// the peak reservation an untrusted `size` can command is bounded by the bytes
/// the store really produced, not by the number in the manifest.
pub const MAX_PREALLOC: usize = 8 * 1024 * 1024;

/// Options controlling a restore.
#[derive(Clone, Debug, Default)]
pub struct RestoreOptions {
    /// Manifest paths to restore before all others, in this order (heat
    /// profile). Paths that do not name a file entry are ignored.
    pub priority: Vec<String>,
}

/// What a restore did.
#[derive(Clone, Debug, Default)]
pub struct RestoreStats {
    /// Files written.
    pub files: usize,
    /// Directories created.
    pub dirs: usize,
    /// Symlinks created.
    pub symlinks: usize,
    /// Total file bytes written.
    pub bytes: u64,
    /// The order in which file entries were restored (their manifest paths).
    /// Priority paths appear first, in the requested order.
    pub file_order: Vec<String>,
}

/// Restore `manifest` into `dir`, reconstructing a byte-identical tree.
pub async fn restore(
    store: &ChunkStore,
    manifest: &Manifest,
    dir: impl AsRef<Path>,
    opts: &RestoreOptions,
) -> Result<RestoreStats> {
    let root = dir.as_ref();
    std::fs::create_dir_all(root).map_err(|e| Error::io(root.display().to_string(), e))?;

    // Validate every path — and every declared file size — up front, so a
    // traversal attempt or a hostile size aborts before any write happens. The
    // components are what every later pass operates on: the composed path
    // string is never handed to the kernel.
    let mut targets: Vec<Vec<String>> = Vec::with_capacity(manifest.entries.len());
    for e in &manifest.entries {
        let comps = manifest_components_under(root, &e.path)?;
        if comps.is_empty() && e.kind != EntryKind::Dir {
            return Err(Error::InvalidManifest(format!(
                "entry {:?} names the restore root but is a {:?}, not a directory",
                e.path, e.kind
            )));
        }
        if e.kind == EntryKind::File {
            check_declared_size(e)?;
        }
        targets.push(comps);
    }

    // One descriptor on the root; every path below is resolved relative to it.
    let mut rootfs = RootDir::open(root)?;
    let mut stats = RestoreStats::default();

    // Pass 1: create directories, shallowest first (entries are path-sorted, so
    // parents precede children). Modes are applied in pass 4.
    for (e, comps) in manifest.entries.iter().zip(&targets) {
        if e.kind == EntryKind::Dir {
            rootfs.create_dir(comps)?;
            stats.dirs += 1;
        }
    }

    // Pass 2: write files. Priority entries first (in requested order), then the
    // rest in path order. Each byte is chunk-verified on read.
    let mut done: HashSet<usize> = HashSet::new();
    let index_of: std::collections::HashMap<&str, usize> = manifest
        .entries
        .iter()
        .enumerate()
        .filter(|(_, e)| e.kind == EntryKind::File)
        .map(|(i, e)| (e.path.as_str(), i))
        .collect();

    for p in &opts.priority {
        if let Some(&i) = index_of.get(p.as_str())
            && done.insert(i)
        {
            write_file(
                store,
                &manifest.entries[i],
                &mut rootfs,
                &targets[i],
                &mut stats,
            )
            .await?;
        }
    }
    for (i, e) in manifest.entries.iter().enumerate() {
        if e.kind == EntryKind::File && done.insert(i) {
            write_file(store, e, &mut rootfs, &targets[i], &mut stats).await?;
        }
    }

    // Pass 3: symlinks, after every real file exists.
    for (e, comps) in manifest.entries.iter().zip(&targets) {
        if e.kind == EntryKind::Symlink {
            let link_target = e.symlink_target.as_deref().ok_or_else(|| {
                Error::InvalidManifest(format!("symlink {} has no target", e.path))
            })?;
            // Replaces any pre-existing node at the link path, without ever
            // following one.
            rootfs.create_symlink(comps, link_target)?;
            stats.symlinks += 1;
        }
    }

    // Pass 4: apply directory modes deepest-first, so making a parent read-only
    // never blocks writing its children (which already happened).
    let mut dir_entries: Vec<(&ManifestEntry, &Vec<String>)> = manifest
        .entries
        .iter()
        .zip(&targets)
        .filter(|(e, _)| e.kind == EntryKind::Dir)
        .collect();
    dir_entries.sort_by(|a, b| b.0.path.cmp(&a.0.path));
    for (e, comps) in dir_entries {
        rootfs.chmod_dir(comps, e.mode)?;
    }

    Ok(stats)
}

/// Cross-check a file entry's declared `size` against the length its own chunk
/// list accounts for. This is what makes `size` safe to size an allocation
/// with: on its own it is an arbitrary `u64` an adversary chose, and reserving
/// against it aborts the process rather than failing the restore.
///
/// The sum itself is computed with `checked_add` — chunk lengths are equally
/// untrusted, and a list engineered to wrap `u64` would otherwise "agree" with
/// a small declared size.
fn check_declared_size(entry: &ManifestEntry) -> Result<()> {
    let mut sum: u64 = 0;
    for cref in &entry.chunks {
        sum = sum.checked_add(cref.len).ok_or_else(|| {
            Error::InvalidManifest(format!("chunk lengths of {} sum past u64::MAX", entry.path))
        })?;
    }
    if sum != entry.size {
        return Err(Error::InvalidManifest(format!(
            "file {} declares size {} but its {} chunk(s) account for {} bytes",
            entry.path,
            entry.size,
            entry.chunks.len(),
            sum
        )));
    }
    Ok(())
}

/// Reassemble one file from its chunks (each verified on read), write it, and
/// set its mode. The file is created through the root-anchored resolver, so a
/// symlink at the target — or at any parent component — is replaced rather than
/// followed.
async fn write_file(
    store: &ChunkStore,
    entry: &ManifestEntry,
    rootfs: &mut RootDir,
    comps: &[String],
    stats: &mut RestoreStats,
) -> Result<()> {
    // `restore` already vetted this size, but the check is cheap and this
    // function must not depend on its caller for memory safety.
    check_declared_size(entry)?;

    // Reserve a bounded amount up front and let the rest follow the bytes that
    // actually arrive; `try_reserve` turns an allocation failure into a typed
    // error instead of an abort, which matters because marid awaits this on the
    // cold-wake path.
    let prealloc = usize::try_from(entry.size)
        .unwrap_or(usize::MAX)
        .min(MAX_PREALLOC);
    let mut content: Vec<u8> = Vec::new();
    content
        .try_reserve(prealloc)
        .map_err(|_| out_of_memory(entry, prealloc))?;
    for cref in &entry.chunks {
        let bytes = store.get_chunk(&cref.chunk).await?;
        if bytes.len() as u64 != cref.len {
            return Err(Error::InvalidManifest(format!(
                "chunk {} in {} is {} bytes, manifest claims {}",
                cref.chunk,
                entry.path,
                bytes.len(),
                cref.len
            )));
        }
        content
            .try_reserve(bytes.len())
            .map_err(|_| out_of_memory(entry, bytes.len()))?;
        content.extend_from_slice(&bytes);
    }
    if content.len() as u64 != entry.size {
        return Err(Error::InvalidManifest(format!(
            "reassembled {} is {} bytes, manifest size is {}",
            entry.path,
            content.len(),
            entry.size
        )));
    }

    let mut file = rootfs.create_file(comps, entry.mode)?;
    let path_for_err = || format!("{}{}", rootfs.path().display(), entry.path);
    file.write_all(&content)
        .map_err(|e| Error::io(path_for_err(), e))?;
    // An existing file was truncated rather than replaced, so its mode is
    // whatever it already had; set it explicitly either way.
    file.set_permissions(std::fs::Permissions::from_mode(entry.mode & 0o7777))
        .map_err(|e| Error::io(path_for_err(), e))?;

    stats.files += 1;
    stats.bytes += entry.size;
    stats.file_order.push(entry.path.clone());
    Ok(())
}

/// The reassembly buffer could not be grown. Reported as an I/O error naming
/// the entry, so a caller sees which file exhausted memory rather than losing
/// the daemon to an allocation abort.
fn out_of_memory(entry: &ManifestEntry, wanted: usize) -> Error {
    Error::io(
        entry.path.clone(),
        std::io::Error::new(
            std::io::ErrorKind::OutOfMemory,
            format!("cannot reserve {wanted} more bytes to reassemble this file"),
        ),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use mari_proto::{ChunkId, ChunkRef};

    fn entry(size: u64, lens: &[u64]) -> ManifestEntry {
        ManifestEntry {
            path: "/f".to_string(),
            kind: EntryKind::File,
            mode: 0o100644,
            size,
            symlink_target: None,
            chunks: lens
                .iter()
                .map(|&len| ChunkRef {
                    chunk: ChunkId::new("0".repeat(64)),
                    len,
                })
                .collect(),
        }
    }

    #[test]
    fn a_size_its_chunks_account_for_is_accepted() {
        check_declared_size(&entry(7, &[3, 4])).unwrap();
        check_declared_size(&entry(0, &[])).unwrap();
    }

    #[test]
    fn a_declared_size_no_chunk_backs_is_rejected() {
        // The allocation an unvalidated manifest used to command.
        let err = check_declared_size(&entry(u64::MAX, &[])).unwrap_err();
        assert!(
            matches!(err, Error::InvalidManifest(_)),
            "expected InvalidManifest, got {err}"
        );
    }

    #[test]
    fn chunk_lengths_that_wrap_u64_are_rejected_not_wrapped() {
        // Summing with `+` would wrap to 3 and "agree" with the declared size.
        let err = check_declared_size(&entry(3, &[u64::MAX, 4])).unwrap_err();
        assert!(
            matches!(err, Error::InvalidManifest(_)),
            "expected InvalidManifest, got {err}"
        );
    }
}
