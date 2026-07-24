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

use std::collections::{BTreeSet, HashMap, HashSet};
use std::os::unix::fs::MetadataExt;
use std::path::Path;

use mari_proto::{
    ChunkId, ChunkRef, EntryKind, Manifest, ManifestEntry, ManifestId, MANIFEST_VERSION,
};
use walkdir::WalkDir;

use crate::chunker::{self, ChunkerConfig};
use crate::error::{Error, Result};
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

    let mut entries: Vec<ManifestEntry> = Vec::new();
    let mut unique: HashMap<ChunkId, Vec<u8>> = HashMap::new();
    let mut total_refs = 0usize;
    let mut excluded: Vec<String> = Vec::new();
    // Prefixes (with trailing '/') of excluded directories, to prune subtrees.
    let mut pruned_prefixes: Vec<String> = Vec::new();

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
            let target = std::fs::read_link(entry.path())
                .map_err(|e| Error::io(entry.path().display().to_string(), e))?;
            let target = target.to_str().ok_or_else(|| {
                Error::InvalidManifest(format!("non-utf8 symlink target at {mpath}"))
            })?;
            entries.push(ManifestEntry {
                path: mpath,
                kind: EntryKind::Symlink,
                mode,
                size: target.len() as u64,
                symlink_target: Some(target.to_string()),
                chunks: Vec::new(),
            });
        } else if ft.is_file() {
            let data = std::fs::read(entry.path())
                .map_err(|e| Error::io(entry.path().display().to_string(), e))?;
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
            entries.push(ManifestEntry {
                path: mpath,
                kind: EntryKind::File,
                mode,
                size: data.len() as u64,
                symlink_target: None,
                chunks,
            });
        }
        // Other kinds (fifo, socket, device) are not part of a snapshot tree.
    }

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
    })
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
