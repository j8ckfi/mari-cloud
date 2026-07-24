//! Storage formats: the manifest (a snapshot of a filesystem) and the heat
//! profile (boot/run-start read order).
//!
//! A manifest is a file tree rendered as a flat, path-ordered list of entries
//! (decisions.md: "a file tree ... NOT a flat chunk list"). Each entry names
//! its chunks in order; file bytes are the concatenation of those chunks.
//! `mari-core` owns chunking and is the only writer of manifests; the
//! TypeScript side reads them but never writes them.

use serde::{Deserialize, Serialize};

use crate::ids::{ChunkId, ManifestId};

/// Current manifest schema version.
pub const MANIFEST_VERSION: u32 = 1;

/// What a manifest entry is. Serialized as its snake_case name (`"file"`,
/// `"dir"`, `"symlink"`) — a bare CBOR text string, not a tagged map.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntryKind {
    /// A regular file. `chunks` holds its content in order; `size` is the byte
    /// length; `symlink_target` is null.
    File,
    /// A directory. `chunks` is empty, `size` is 0, `symlink_target` is null.
    Dir,
    /// A symbolic link. `symlink_target` is the link text; `chunks` is empty.
    Symlink,
}

/// A reference to one content-addressed chunk and how many bytes of the file it
/// contributes. `len` is this chunk's byte length within the file (equal to the
/// chunk's own length for whole-chunk refs).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ChunkRef {
    /// blake3 digest identifying the chunk in the chunk store.
    pub chunk: ChunkId,
    /// Byte length this chunk contributes to the file.
    pub len: u64,
}

/// One filesystem object. The `path` is absolute and is the ordering key; the
/// flat list is sorted by `path` so the tree can be reconstructed by prefix.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ManifestEntry {
    /// Absolute path from the filesystem root, e.g. `/etc/hostname`.
    pub path: String,
    /// The kind of object at `path`.
    pub kind: EntryKind,
    /// Unix mode bits, including the file-type bits (e.g. `0o100644`).
    pub mode: u32,
    /// Byte length of a file; `0` for directories and (by convention) the
    /// length of the link text is carried here for symlinks.
    pub size: u64,
    /// Link text for a symlink; `null` otherwise. Always present on the wire.
    pub symlink_target: Option<String>,
    /// Ordered chunk references composing a file's content; empty for
    /// directories and symlinks.
    pub chunks: Vec<ChunkRef>,
}

/// A snapshot of a computer's whole filesystem at one instant. Stored at
/// `manifests/{id}.cbor`; its `ManifestId` is the blake3 of that CBOR.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Manifest {
    /// Schema version. Currently [`MANIFEST_VERSION`].
    pub version: u32,
    /// The base-image manifest this one layers on, if any. `null` for a
    /// self-contained manifest. Present on the wire regardless.
    pub parent: Option<ManifestId>,
    /// Creation time, Unix seconds. Snapshot writers set this; fixtures use a
    /// fixed value for determinism.
    pub created_at: u64,
    /// The filesystem, as a flat path-ordered list.
    pub entries: Vec<ManifestEntry>,
}

impl Manifest {
    /// An empty manifest at the current version with no parent.
    pub fn empty(created_at: u64) -> Self {
        Self {
            version: MANIFEST_VERSION,
            parent: None,
            created_at,
            entries: Vec::new(),
        }
    }
}

/// The ordered list of paths a computer reads at boot and at run start. Stored
/// at `heat/{computer}.cbor`. Cold wake prefetches chunks in this order
/// (spec 4.6(d)).
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeatProfile {
    /// Paths in the order they are read; earlier paths are prefetched first.
    pub paths: Vec<String>,
}

/// Why a snapshot was written (spec 4.3). Serialized as a bare snake_case
/// string: `"pre_run"`, `"scheduled"`, `"command"`, `"final"`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotReason {
    /// Written automatically before a run (the run's diff baseline).
    PreRun,
    /// Written on the periodic snapshot schedule.
    Scheduled,
    /// Written in response to an explicit user/control command.
    Command,
    /// The final snapshot written before the WARM->COLD transition.
    Final,
}

/// Counts summarizing a manifest diff (spec 5.3): how many entries were added,
/// modified, or removed relative to the pre-run manifest.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct DiffSummary {
    /// Entries present after the run but not before.
    pub added: u32,
    /// Entries present in both but with changed content or metadata.
    pub modified: u32,
    /// Entries present before the run but not after.
    pub removed: u32,
}
