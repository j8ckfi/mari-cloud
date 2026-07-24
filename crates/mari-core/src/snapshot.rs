//! Snapshot: turn a live directory tree into a stored [`Manifest`] (spec 4.3).
//!
//! Walk the tree (files, dirs, symlinks, modes), content-chunk each file, upload
//! only the chunks the store is missing (a single batched existence check), then
//! write a manifest that names every entry and its chunks. An optional `parent`
//! records the base image this layers on, so delta accounting (spec §2, 4.4) is
//! a function of the manifest chain alone.
//!
//! Credential paths are excluded from the manifest per spec 10.1: a matched path
//! never has its bytes read, chunked, uploaded, or recorded.
//!
//! # Only this computer's bytes
//!
//! Exclusion is by path, and a **hard link** is what makes a path a poor proxy
//! for a file: it is a second name for one inode, so a run that links
//! `/innocent.txt` to a secret outside the root — or to a credential path the
//! exclude list drops — hands the snapshot an entry that is a regular file by
//! every check `O_NOFOLLOW` can make, whose content is not this computer's.
//! Chunked once, that content is in the chunk store, in this manifest, and in
//! every fork and retained manifest that shares the chunk (spec 10.1, 10.2).
//!
//! So a file's bytes are read only once the snapshot can account for **every**
//! name its inode has:
//!
//! - the walk records where each multiply-linked inode was seen, but never
//!   reads anything;
//! - a second pass opens each file root-anchored and takes `st_nlink` from that
//!   descriptor (a `statat` on the name describes whatever occupied it an
//!   instant ago, which is the whole attack);
//! - `nlink == 1` needs nothing further: the name it was resolved through is
//!   inside the root and is the inode's only one;
//! - `nlink > 1` is read only if that many of this manifest's own paths still
//!   resolve to that inode — re-resolved *after* the descriptor was opened, so
//!   no count taken during the walk can be spent on an inode that has changed
//!   since. Otherwise some name is somewhere this snapshot is not looking, and
//!   the entry is dropped, unread, into
//!   [`SnapshotResult::unattributable_links`].
//!
//! Dropping the entry rather than failing the snapshot is deliberate: a
//! snapshot that a guest can make fail permanently, with one `link()` call, is a
//! computer that can no longer checkpoint and cannot go COLD without losing its
//! tree (spec 4.3, 4.4).
//!
//! In-root hard links are ordinary content, not an attack (`git clone --local`
//! makes thousands), and they survive this intact: every name is accounted for,
//! so each is snapshotted as its own entry — which is all a manifest can express
//! — and content addressing stores the bytes once.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use mari_proto::{
    ChunkId, ChunkRef, EntryKind, Manifest, ManifestEntry, ManifestId, MANIFEST_VERSION,
};
use walkdir::WalkDir;

use crate::chunker::{self, ChunkerConfig};
use crate::error::{Error, Result};
use crate::rootfs::{manifest_components, FileFacts, RootDir};
use crate::store::ChunkStore;

/// Options controlling a snapshot.
#[derive(Clone, Debug)]
pub struct SnapshotOptions {
    /// FastCDC parameters for file chunking.
    pub chunker: ChunkerConfig,
    /// Glob patterns whose matching paths are excluded from the manifest
    /// (spec 10.1). Matched directories are pruned with their whole subtree.
    pub exclude: Vec<String>,
    /// The base-image manifest this snapshot layers on, recorded as the
    /// manifest's `parent` for delta accounting. `None` for a self-contained
    /// snapshot.
    pub parent: Option<ManifestId>,
    /// Creation time to stamp into the manifest (Unix seconds).
    pub created_at: u64,
}

impl Default for SnapshotOptions {
    fn default() -> Self {
        Self {
            chunker: ChunkerConfig::PRODUCTION,
            exclude: default_credential_excludes(),
            parent: None,
            created_at: 0,
        }
    }
}

/// Default credential-path exclusions (spec 10.1). Glob patterns matched against
/// the absolute in-root entry path; `*` spans path separators.
pub fn default_credential_excludes() -> Vec<String> {
    [
        // Each credential directory is excluded both as the directory entry
        // itself and as its whole subtree, so no trace (not even an empty dir)
        // reaches the manifest.
        "*/.aws",
        "*/.aws/*",
        "*/.ssh",
        "*/.ssh/*",
        "*/.config/gcloud",
        "*/.config/gcloud/*",
        "*/.config/gh",
        "*/.config/gh/*",
        "*/.kube/config",
        "*/.docker/config.json",
        "*/.netrc",
        "*.pem",
        "*.key",
    ]
    .into_iter()
    .map(String::from)
    .collect()
}

/// The outcome of a snapshot: the stored manifest and dedup accounting.
#[derive(Clone, Debug)]
pub struct SnapshotResult {
    /// The manifest that was written.
    pub manifest: Manifest,
    /// Its id (blake3 of the CBOR), the key it is stored under.
    pub manifest_id: ManifestId,
    /// Total chunk references across all files (with duplicates).
    pub total_refs: usize,
    /// Distinct chunk ids in this snapshot.
    pub unique_chunks: usize,
    /// Chunks actually uploaded (were missing from the store).
    pub uploaded_chunks: usize,
    /// Chunks skipped because the store already had them (dedup).
    pub reused_chunks: usize,
    /// Entry paths excluded by the glob list (for observability / tests).
    pub excluded: Vec<String>,
    /// Paths of files dropped because the snapshot could not account for every
    /// name their inode has (a hard link out of the root, or into an excluded
    /// credential path). Their bytes were never read, chunked, or uploaded.
    pub unattributable_links: Vec<String>,
}

/// A file the walk found and has not read yet: where its entry sits in the
/// manifest under construction, and the components its bytes are read through.
struct PendingFile {
    /// Index into the entry list.
    entry: usize,
    /// The entry path, split for the root-anchored resolver.
    comps: Vec<String>,
}

/// Compiled exclusion matcher.
struct Excludes {
    patterns: Vec<glob::Pattern>,
}

impl Excludes {
    fn compile(globs: &[String]) -> Result<Self> {
        let mut patterns = Vec::with_capacity(globs.len());
        for g in globs {
            patterns.push(
                glob::Pattern::new(g)
                    .map_err(|e| Error::InvalidManifest(format!("bad exclude glob {g:?}: {e}")))?,
            );
        }
        Ok(Self { patterns })
    }

    fn matches(&self, path: &str) -> bool {
        self.patterns.iter().any(|p| p.matches(path))
    }
}

/// Map an absolute filesystem path under `root` to its in-manifest path: the
/// root itself is `/`, a child `root/a/b` is `/a/b`.
fn manifest_path(root: &Path, p: &Path) -> Result<String> {
    let rel = p.strip_prefix(root).unwrap_or(p);
    let rel_str = rel
        .to_str()
        .ok_or_else(|| Error::InvalidManifest(format!("non-utf8 path {p:?}")))?;
    if rel_str.is_empty() {
        Ok("/".to_string())
    } else {
        Ok(format!("/{rel_str}"))
    }
}

/// Snapshot `dir` into the store, returning the stored manifest and dedup
/// accounting. Only chunks missing from the store are uploaded.
pub async fn snapshot(
    store: &ChunkStore,
    dir: impl AsRef<Path>,
    opts: &SnapshotOptions,
) -> Result<SnapshotResult> {
    opts.chunker
        .validate()
        .map_err(|m| Error::InvalidManifest(format!("chunker config: {m}")))?;
    let root = dir.as_ref();
    let excludes = Excludes::compile(&opts.exclude)?;
    // `walkdir` enumerates without following symlinks, but it re-resolves each
    // path it hands back, so a component swapped under it mid-walk would make a
    // plain `std::fs::read` read a file outside the root into the manifest.
    // Every read below is therefore anchored to this descriptor instead.
    let mut rootfs = RootDir::open(root)?;

    let mut entries: Vec<ManifestEntry> = Vec::new();
    let mut unique: HashMap<ChunkId, Vec<u8>> = HashMap::new();
    let mut total_refs = 0usize;
    let mut excluded: Vec<String> = Vec::new();
    // Prefixes (with trailing '/') of excluded directories, to prune subtrees.
    let mut pruned_prefixes: Vec<String> = Vec::new();
    // Files the walk recorded but did not read: whether their bytes may be read
    // at all depends on names the walk has not reached yet (see the module
    // docs), so the reading happens in a second pass.
    let mut pending: Vec<PendingFile> = Vec::new();
    // For each multiply-linked inode the walk saw, the recorded files that named
    // it. Singly-linked files need no entry here: one name is one name, and it
    // is the one the resolver walked to inside the root.
    let mut names_by_inode: HashMap<(u64, u64), Vec<usize>> = HashMap::new();

    for entry in WalkDir::new(root).sort_by_file_name() {
        let entry =
            entry.map_err(|e| Error::io(root.display().to_string(), walkdir_io(e)))?;
        let mpath = manifest_path(root, entry.path())?;

        // Prune anything beneath an excluded directory.
        if pruned_prefixes.iter().any(|pfx| mpath.starts_with(pfx)) {
            continue;
        }
        // Exclude this entry itself (credential paths, spec 10.1).
        if excludes.matches(&mpath) {
            excluded.push(mpath.clone());
            if entry.file_type().is_dir() {
                pruned_prefixes.push(format!("{}/", mpath.trim_end_matches('/')));
            }
            continue;
        }

        let ft = entry.file_type();
        let meta = entry
            .metadata()
            .map_err(|e| Error::io(entry.path().display().to_string(), walkdir_io(e)))?;
        let mode = meta.mode();

        if ft.is_dir() {
            entries.push(ManifestEntry {
                path: mpath,
                kind: EntryKind::Dir,
                mode,
                size: 0,
                symlink_target: None,
                chunks: Vec::new(),
            });
        } else if ft.is_symlink() {
            let comps = manifest_components(&mpath)?;
            let raw = rootfs.read_link(&comps)?;
            let target = String::from_utf8(raw).map_err(|_| {
                Error::InvalidManifest(format!("non-utf8 symlink target at {mpath}"))
            })?;
            entries.push(ManifestEntry {
                path: mpath,
                kind: EntryKind::Symlink,
                mode,
                size: target.len() as u64,
                symlink_target: Some(target),
                chunks: Vec::new(),
            });
        } else if ft.is_file() {
            let comps = manifest_components(&mpath)?;
            // A second name for this inode makes its content unattributable
            // until every name is accounted for, so remember where this one is.
            if meta.nlink() > 1 {
                names_by_inode
                    .entry((meta.dev(), meta.ino()))
                    .or_default()
                    .push(pending.len());
            }
            pending.push(PendingFile {
                entry: entries.len(),
                comps,
            });
            // Mode, size and chunks are filled in by the read pass, from the
            // descriptor the bytes actually come out of.
            entries.push(ManifestEntry {
                path: mpath,
                kind: EntryKind::File,
                mode,
                size: 0,
                symlink_target: None,
                chunks: Vec::new(),
            });
        }
        // Other kinds (fifo, socket, device) are not part of a snapshot tree.
    }

    // Read pass. Every open is root-anchored, so a symlink in any position is
    // refused; the link-count accounting on the opened descriptor is what keeps
    // a hard link from feeding an outside inode into the store.
    let mut unattributable_links: Vec<String> = Vec::new();
    let mut dropped: HashSet<usize> = HashSet::new();
    // One verdict per inode, not per name: a directory holding n links to one
    // inode would otherwise cost n² stats.
    let mut verdicts: HashMap<(u64, u64), bool> = HashMap::new();

    for p in &pending {
        let (file, facts) = match rootfs.open_file(&p.comps) {
            Ok(open) => open,
            // The tree is live (spec 4.3 snapshots a running computer): a file
            // the walk saw can be gone before its bytes are read. It is then not
            // in the tree, so it is not in the manifest — and that is not an
            // error about the snapshot.
            Err(Error::Io { ref source, .. })
                if source.kind() == std::io::ErrorKind::NotFound =>
            {
                dropped.insert(p.entry);
                continue;
            }
            Err(e) => return Err(e),
        };

        if facts.nlink > 1 {
            let allowed = match verdicts.get(&facts.inode()) {
                Some(&v) => v,
                None => {
                    let v = links_are_accounted_for(&mut rootfs, &pending, &names_by_inode, &facts)?;
                    verdicts.insert(facts.inode(), v);
                    v
                }
            };
            if !allowed {
                // The descriptor is dropped here, unread: not one byte of an
                // inode this computer cannot claim reaches the chunker.
                unattributable_links.push(entries[p.entry].path.clone());
                dropped.insert(p.entry);
                continue;
            }
        }

        let data = rootfs.read_open_file(&p.comps, file, &facts)?;
        let mut chunks = Vec::new();
        for c in chunker::cut(&data, &opts.chunker) {
            let slice = &data[c.offset..c.offset + c.len];
            let id = ChunkStore::chunk_id(slice);
            chunks.push(ChunkRef {
                chunk: id.clone(),
                len: c.len as u64,
            });
            total_refs += 1;
            unique.entry(id).or_insert_with(|| slice.to_vec());
        }
        debug_assert_eq!(
            chunks.iter().map(|c| c.len).sum::<u64>(),
            data.len() as u64,
            "chunk lengths must sum to file size"
        );
        let entry = &mut entries[p.entry];
        // The mode comes from the very descriptor the bytes came out of, so the
        // recorded mode always belongs to the recorded content.
        entry.mode = facts.mode;
        entry.size = data.len() as u64;
        entry.chunks = chunks;
    }

    let mut entries: Vec<ManifestEntry> = entries
        .into_iter()
        .enumerate()
        .filter(|(i, _)| !dropped.contains(i))
        .map(|(_, e)| e)
        .collect();
    entries.sort_by(|a, b| a.path.cmp(&b.path));

    // One batched existence check for every distinct chunk, then upload the
    // missing ones only.
    let all_ids: Vec<ChunkId> = unique.keys().cloned().collect();
    let unique_chunks = all_ids.len();
    let missing = store.missing_chunks(&all_ids).await?;
    let uploaded_chunks = missing.len();
    for id in &missing {
        let bytes = unique
            .get(id)
            .expect("missing id came from this snapshot's own set");
        let put_id = store.put_chunk(bytes).await?;
        debug_assert_eq!(&put_id, id, "content address must be stable");
    }

    let manifest = Manifest {
        version: MANIFEST_VERSION,
        parent: opts.parent.clone(),
        created_at: opts.created_at,
        entries,
    };
    let manifest_id = store.put_manifest(&manifest).await?;

    Ok(SnapshotResult {
        manifest,
        manifest_id,
        total_refs,
        unique_chunks,
        uploaded_chunks,
        reused_chunks: unique_chunks - uploaded_chunks,
        excluded,
        unattributable_links,
    })
}

/// Whether every name the filesystem has for this inode is a path this snapshot
/// is recording — the question that decides whether its bytes may be read.
///
/// `st_nlink` is a count with no names attached, so the proof has to come from
/// the other side: re-resolve the recorded paths that named this inode during
/// the walk, root-anchored, and count the ones that still lead to it. Reaching
/// `nlink` means every name the inode has is one of ours. Falling short means at
/// least one name is somewhere this snapshot is not looking — outside the root,
/// or under a credential path the exclude list dropped (spec 10.1) — and the
/// content behind it is not this computer's to store.
///
/// Order is what makes this hold under a racing tree. The re-resolution happens
/// *after* the descriptor being vetted was opened and `fstat`ed, so a name that
/// has been repointed at some other inode since the walk cannot be counted, and
/// a stale count from the walk cannot be spent. A link created outside the root
/// after the check is not a leak: at the moment of the check the inode was named
/// only from inside the root, which is what makes its content part of this
/// computer's filesystem in the first place.
fn links_are_accounted_for(
    rootfs: &mut RootDir,
    pending: &[PendingFile],
    names_by_inode: &HashMap<(u64, u64), Vec<usize>>,
    facts: &FileFacts,
) -> Result<bool> {
    // No recorded name for this inode at all: the walk saw it as singly-linked
    // (it has been linked since) or saw a different inode at this path. Either
    // way there is nothing to account with.
    let Some(names) = names_by_inode.get(&facts.inode()) else {
        return Ok(false);
    };
    let mut found: u64 = 0;
    for &i in names {
        match rootfs.stat_file(&pending[i].comps)? {
            Some(other) if other.inode() == facts.inode() => {
                found += 1;
                if found >= facts.nlink {
                    return Ok(true);
                }
            }
            // The name is gone, or leads to some other inode now: it is not
            // evidence about this one.
            _ => {}
        }
    }
    Ok(false)
}

/// The distinct chunks referenced directly by a manifest's entries (not
/// following its parent chain).
pub fn manifest_chunks(manifest: &Manifest) -> BTreeSet<ChunkId> {
    let mut set = BTreeSet::new();
    for e in &manifest.entries {
        for c in &e.chunks {
            set.insert(c.chunk.clone());
        }
    }
    set
}

/// The delta of a manifest against its parent chain: the chunks it references
/// that no ancestor already provides (spec §2 "Delta"). Loads the parent chain
/// from the store; a cycle or a missing parent is an error.
pub async fn delta_chunks(store: &ChunkStore, manifest: &Manifest) -> Result<BTreeSet<ChunkId>> {
    let mut ancestor: BTreeSet<ChunkId> = BTreeSet::new();
    let mut seen: HashSet<ManifestId> = HashSet::new();
    let mut cur = manifest.parent.clone();
    while let Some(pid) = cur {
        if !seen.insert(pid.clone()) {
            return Err(Error::InvalidManifest(format!(
                "parent chain cycle at {pid}"
            )));
        }
        let pm = store.get_manifest(&pid).await?;
        ancestor.extend(manifest_chunks(&pm));
        cur = pm.parent.clone();
    }
    Ok(manifest_chunks(manifest)
        .into_iter()
        .filter(|c| !ancestor.contains(c))
        .collect())
}

fn walkdir_io(e: walkdir::Error) -> std::io::Error {
    match e.into_io_error() {
        Some(io) => io,
        None => std::io::Error::other("walk error"),
    }
}
