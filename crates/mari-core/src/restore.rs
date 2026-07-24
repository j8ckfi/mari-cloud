//! Restore: reconstruct a byte-identical tree from a [`Manifest`] (spec 5.3).
//!
//! Every file comes back with its exact bytes (each chunk blake3-verified on
//! read), its mode, and — for symlinks — its link text, including dangling
//! links. A priority path list (heat-profile order, spec 4.6(d)) is restored
//! first so the first-prompt-critical files land before the long tail.
//!
//! Restore is hostile-input safe: an entry whose path escapes the target root
//! (`..`, an absolute re-root) is rejected with [`Error::PathTraversal`] and
//! nothing is written outside the root. Symlinks are materialized last, after
//! every real file, so no file is ever written *through* a restored symlink.

use std::collections::HashSet;
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};

use mari_proto::{EntryKind, Manifest, ManifestEntry};

use crate::error::{Error, Result};
use crate::store::ChunkStore;

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

/// Join a manifest entry path onto `root`, rejecting any path that would escape
/// the root. Manifest paths are absolute-in-root (`/a/b`); a `..` component, an
/// embedded root, or a Windows prefix is refused.
fn safe_join(root: &Path, entry_path: &str) -> Result<PathBuf> {
    let rel = entry_path.trim_start_matches('/');
    let mut out = root.to_path_buf();
    for comp in Path::new(rel).components() {
        match comp {
            Component::Normal(c) => out.push(c),
            Component::CurDir => {}
            Component::ParentDir | Component::RootDir | Component::Prefix(_) => {
                return Err(Error::PathTraversal {
                    path: entry_path.to_string(),
                });
            }
        }
    }
    // Defense in depth: the composed path must stay under the root.
    if !out.starts_with(root) {
        return Err(Error::PathTraversal {
            path: entry_path.to_string(),
        });
    }
    Ok(out)
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

    // Validate every path up front so a traversal attempt aborts before any
    // write happens.
    let mut targets: Vec<PathBuf> = Vec::with_capacity(manifest.entries.len());
    for e in &manifest.entries {
        targets.push(safe_join(root, &e.path)?);
    }

    let mut stats = RestoreStats::default();

    // Pass 1: create directories, shallowest first (entries are path-sorted, so
    // parents precede children). Modes are applied in pass 4.
    for (e, target) in manifest.entries.iter().zip(&targets) {
        if e.kind == EntryKind::Dir {
            std::fs::create_dir_all(target)
                .map_err(|e2| Error::io(target.display().to_string(), e2))?;
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
        if let Some(&i) = index_of.get(p.as_str()) {
            if done.insert(i) {
                write_file(store, &manifest.entries[i], &targets[i], &mut stats).await?;
            }
        }
    }
    for (i, e) in manifest.entries.iter().enumerate() {
        if e.kind == EntryKind::File && done.insert(i) {
            write_file(store, e, &targets[i], &mut stats).await?;
        }
    }

    // Pass 3: symlinks, after every real file exists.
    for (e, target) in manifest.entries.iter().zip(&targets) {
        if e.kind == EntryKind::Symlink {
            let link_target = e.symlink_target.as_deref().ok_or_else(|| {
                Error::InvalidManifest(format!("symlink {} has no target", e.path))
            })?;
            if let Some(parent) = target.parent() {
                std::fs::create_dir_all(parent)
                    .map_err(|e2| Error::io(parent.display().to_string(), e2))?;
            }
            // Replace any pre-existing node at the link path.
            if target.symlink_metadata().is_ok() {
                std::fs::remove_file(target)
                    .map_err(|e2| Error::io(target.display().to_string(), e2))?;
            }
            std::os::unix::fs::symlink(link_target, target)
                .map_err(|e2| Error::io(target.display().to_string(), e2))?;
            stats.symlinks += 1;
        }
    }

    // Pass 4: apply directory modes deepest-first, so making a parent read-only
    // never blocks writing its children (which already happened).
    let mut dir_entries: Vec<(&ManifestEntry, &PathBuf)> = manifest
        .entries
        .iter()
        .zip(&targets)
        .filter(|(e, _)| e.kind == EntryKind::Dir)
        .collect();
    dir_entries.sort_by(|a, b| b.0.path.cmp(&a.0.path));
    for (e, target) in dir_entries {
        let perms = std::fs::Permissions::from_mode(e.mode & 0o7777);
        std::fs::set_permissions(target, perms)
            .map_err(|e2| Error::io(target.display().to_string(), e2))?;
    }

    Ok(stats)
}

/// Reassemble one file from its chunks (each verified on read), write it, and
/// set its mode.
async fn write_file(
    store: &ChunkStore,
    entry: &ManifestEntry,
    target: &Path,
    stats: &mut RestoreStats,
) -> Result<()> {
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| Error::io(parent.display().to_string(), e))?;
    }
    let mut content: Vec<u8> = Vec::with_capacity(entry.size as usize);
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
    std::fs::write(target, &content).map_err(|e| Error::io(target.display().to_string(), e))?;
    let perms = std::fs::Permissions::from_mode(entry.mode & 0o7777);
    std::fs::set_permissions(target, perms)
        .map_err(|e| Error::io(target.display().to_string(), e))?;
    stats.files += 1;
    stats.bytes += entry.size;
    stats.file_order.push(entry.path.clone());
    Ok(())
}
