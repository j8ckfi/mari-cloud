//! The one error type for the storage layer.
//!
//! Corruption is a first-class, typed outcome: a chunk whose stored bytes do
//! not hash back to their id names that chunk in the error. Nothing in this
//! crate returns "wrong bytes" silently — a failed blake3 verification or a
//! failed decompression is always an [`Error`], never a value.

use mari_proto::{ChunkId, ManifestId};

/// Result alias for the storage layer.
pub type Result<T> = std::result::Result<T, Error>;

/// Every failure mode of chunking, storage, snapshot, restore, diff and GC.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    /// A local-filesystem operation failed, annotated with the offending path.
    #[error("io error at {path}: {source}")]
    Io {
        /// The path the operation was against.
        path: String,
        /// The underlying OS error.
        #[source]
        source: std::io::Error,
    },

    /// The object-store backend (opendal) returned an error.
    #[error("store backend error: {0}")]
    Store(#[from] opendal::Error),

    /// CBOR encode/decode of a manifest or heat profile failed.
    #[error("cbor error: {0}")]
    Cbor(String),

    /// A chunk's stored bytes decompressed to content that does not hash back
    /// to its id — the chunk on disk is corrupt. Verify-then-use caught it
    /// before the bytes reached a file.
    #[error("chunk {chunk} failed blake3 verification: content hashes to {actual}")]
    ChunkCorrupted {
        /// The id the chunk was fetched under (its expected blake3).
        chunk: ChunkId,
        /// The blake3 the decompressed bytes actually produced.
        actual: ChunkId,
    },

    /// A chunk's stored body could not be decompressed at all — corrupt zstd
    /// frame. Still names the chunk.
    #[error("chunk {chunk} could not be decompressed (corrupt zstd frame)")]
    ChunkDecompress {
        /// The id the chunk was fetched under.
        chunk: ChunkId,
    },

    /// A manifest referenced (as a head or as a parent) is not in the store.
    /// GC refuses to proceed on an incomplete live set, so this fails the plan
    /// rather than under-counting the live set and deleting a live chunk.
    #[error("manifest {0} not found in store")]
    ManifestNotFound(ManifestId),

    /// A chunk referenced by a manifest is absent from the store during
    /// restore.
    #[error("chunk {0} referenced by a manifest is missing from the store")]
    ChunkMissing(ChunkId),

    /// A restore entry's path escapes the restore root (path traversal). The
    /// entry is rejected and nothing is written outside the root.
    #[error("manifest entry path {path:?} escapes the restore root")]
    PathTraversal {
        /// The offending entry path from the manifest.
        path: String,
    },

    /// A manifest is internally inconsistent (e.g. a parent chain cycle, or a
    /// chunk-length sum that disagrees with the entry size).
    #[error("invalid manifest: {0}")]
    InvalidManifest(String),
}

impl Error {
    /// If this error names a specific corrupt chunk, return its id. Lets a
    /// caller (or a test) assert *which* chunk failed verification.
    pub fn corrupt_chunk(&self) -> Option<&ChunkId> {
        match self {
            Error::ChunkCorrupted { chunk, .. } | Error::ChunkDecompress { chunk } => Some(chunk),
            _ => None,
        }
    }

    /// Construct an [`Error::Io`] with path context.
    pub fn io(path: impl Into<String>, source: std::io::Error) -> Self {
        Error::Io {
            path: path.into(),
            source,
        }
    }
}

impl From<mari_proto::Error> for Error {
    fn from(e: mari_proto::Error) -> Self {
        Error::Cbor(e.to_string())
    }
}
