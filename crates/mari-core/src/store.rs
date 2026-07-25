//! The chunk store: the home of every computer (spec 3.3, §2).
//!
//! A thin, content-addressed layer over an opendal [`Operator`]. It owns the
//! object layout of contracts.md §9, blake3 identity, zstd compression of chunk
//! bodies, and — non-negotiably — **blake3 verification on every chunk read**.
//! A read never hands back bytes it has not re-hashed; corruption becomes a
//! typed [`Error`] naming the chunk (verify-then-use).
//!
//! The store is async because opendal is, and because `marid` (its native
//! caller) is a tokio program; the same logic compiles to Wasm for the control
//! plane later. Chunks and manifests are immutable and content-addressed, so
//! every write is idempotent and safe from a fenced-out writer (contracts §6).

use std::path::Path;

use futures::stream::{self, StreamExt};
use mari_proto::{ChunkId, HeatProfile, Manifest, ManifestId};
use opendal::{ErrorKind, Operator};

use crate::error::{Error, Result};

/// zstd compression level used for chunk bodies. Level 3 is the zstd default:
/// a good ratio at high speed, which matters because a wake reads many chunks.
const ZSTD_LEVEL: i32 = 3;

/// Concurrency for batched existence checks and deletions against the store.
const STORE_CONCURRENCY: usize = 32;

/// A content-addressed object store for chunks, manifests and heat profiles.
///
/// Cloneable: an [`Operator`] is a cheap handle (an `Arc` internally), so a
/// `ChunkStore` can be shared across tasks.
#[derive(Clone)]
pub struct ChunkStore {
    op: Operator,
}

impl ChunkStore {
    /// Wrap an existing opendal [`Operator`] (any backend).
    pub fn new(op: Operator) -> Self {
        Self { op }
    }

    /// Open a store backed by the local filesystem rooted at `root`, creating
    /// the directory if needed. This is the mandatory `services-fs` backend
    /// used by `marid` in development and by every test here.
    pub fn open_fs(root: impl AsRef<Path>) -> Result<Self> {
        let root = root.as_ref();
        std::fs::create_dir_all(root).map_err(|e| Error::io(root.display().to_string(), e))?;
        let root_str = root.to_str().ok_or_else(|| {
            Error::io(
                root.display().to_string(),
                std::io::Error::other("non-utf8 store root"),
            )
        })?;
        let builder = opendal::services::Fs::default().root(root_str);
        let op = Operator::new(builder)?.finish();
        Ok(Self::new(op))
    }

    /// Borrow the underlying operator (for tests / advanced callers).
    pub fn operator(&self) -> &Operator {
        &self.op
    }

    // ---- ids -----------------------------------------------------------

    /// The [`ChunkId`] of a chunk's *plaintext* bytes: lowercase blake3 hex.
    /// The id is over the uncompressed content, so compression is an internal
    /// storage detail invisible to identity.
    pub fn chunk_id(bytes: &[u8]) -> ChunkId {
        ChunkId::new(blake3::hash(bytes).to_hex().to_string())
    }

    /// The [`ManifestId`] of a manifest's canonical CBOR: lowercase blake3 hex
    /// (contracts §3).
    pub fn manifest_id_of_cbor(cbor: &[u8]) -> ManifestId {
        ManifestId::new(blake3::hash(cbor).to_hex().to_string())
    }

    // ---- keys ----------------------------------------------------------

    /// A content address is 64 lowercase hex characters (contracts §3). Ids
    /// arrive from **manifests**, which are untrusted input: a `parent` of
    /// `"../../etc/passwd"` would otherwise compose a key that walks out of the
    /// store root inside the backend. Verification-on-read means such a probe
    /// could never return usable bytes, but it must not reach the backend at
    /// all. Ids this crate mints (blake3 hex) and ids recovered from a listing
    /// always pass.
    fn check_content_address(kind: &str, id: &str) -> Result<()> {
        let well_formed = id.len() == 64
            && id
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
        if well_formed {
            Ok(())
        } else {
            Err(Error::InvalidManifest(format!(
                "malformed {kind} id {id:?}: expected 64 lowercase hex characters"
            )))
        }
    }

    /// A computer id becomes a store key segment (`heat/{computer}.cbor`), so it
    /// must name exactly one segment: no separator, no `.`/`..`, not empty.
    fn check_computer_id(computer: &str) -> Result<()> {
        let ok = !computer.is_empty()
            && computer != "."
            && computer != ".."
            && !computer.contains('/')
            && !computer.contains('\\')
            && !computer.contains('\0');
        if ok {
            Ok(())
        } else {
            Err(Error::InvalidManifest(format!(
                "computer id {computer:?} is not a single store key segment"
            )))
        }
    }

    /// `chunks/{id[0..2]}/{id}` — the sharded chunk key (contracts §9).
    pub fn chunk_key(id: &ChunkId) -> String {
        let s = id.as_str();
        // Chunk ids are 64 hex chars; guard anyway so a malformed id can't panic.
        let prefix = if s.len() >= 2 { &s[..2] } else { "00" };
        format!("chunks/{prefix}/{s}")
    }

    /// `manifests/{id}.cbor`.
    pub fn manifest_key(id: &ManifestId) -> String {
        format!("manifests/{id}.cbor")
    }

    /// `heat/{computer}.cbor`.
    pub fn heat_key(computer: &str) -> String {
        format!("heat/{computer}.cbor")
    }

    // ---- chunks --------------------------------------------------------

    /// Does the store already hold this chunk?
    pub async fn has_chunk(&self, id: &ChunkId) -> Result<bool> {
        Self::check_content_address("chunk", id.as_str())?;
        Ok(self.op.exists(&Self::chunk_key(id)).await?)
    }

    /// Batched existence check: given ids (order/duplicates irrelevant), return
    /// the subset the store is **missing**, so a snapshot uploads only new
    /// chunks. Existence probes run concurrently.
    pub async fn missing_chunks(&self, ids: &[ChunkId]) -> Result<Vec<ChunkId>> {
        // Deduplicate first so we probe each id once.
        let mut unique: Vec<ChunkId> = ids.to_vec();
        unique.sort();
        unique.dedup();

        let results: Vec<Result<Option<ChunkId>>> = stream::iter(unique.into_iter().map(|id| {
            let op = self.op.clone();
            async move {
                let present = op.exists(&Self::chunk_key(&id)).await?;
                Ok(if present { None } else { Some(id) })
            }
        }))
        .buffer_unordered(STORE_CONCURRENCY)
        .collect()
        .await;

        let mut missing = Vec::new();
        for r in results {
            if let Some(id) = r? {
                missing.push(id);
            }
        }
        missing.sort();
        Ok(missing)
    }

    /// Store a chunk. Computes its id, zstd-compresses the body, and writes it
    /// under its content-addressed key. Idempotent: the same bytes always map
    /// to the same key, so a re-write is harmless. Returns the id.
    pub async fn put_chunk(&self, bytes: &[u8]) -> Result<ChunkId> {
        let id = Self::chunk_id(bytes);
        let compressed =
            zstd::encode_all(bytes, ZSTD_LEVEL).map_err(|e| Error::io(Self::chunk_key(&id), e))?;
        self.op.write(&Self::chunk_key(&id), compressed).await?;
        Ok(id)
    }

    /// Read a chunk and hand back its plaintext bytes — **after** verifying
    /// them. Decompresses the stored body, then re-hashes and compares to the
    /// requested id. A decompression failure or a hash mismatch is a typed
    /// error naming the chunk; the bytes are never returned unverified.
    pub async fn get_chunk(&self, id: &ChunkId) -> Result<Vec<u8>> {
        Self::check_content_address("chunk", id.as_str())?;
        let key = Self::chunk_key(id);
        let compressed = match self.op.read(&key).await {
            Ok(buf) => buf.to_vec(),
            Err(e) if e.kind() == ErrorKind::NotFound => {
                return Err(Error::ChunkMissing(id.clone()));
            }
            Err(e) => return Err(e.into()),
        };
        let plain = zstd::decode_all(compressed.as_slice())
            .map_err(|_| Error::ChunkDecompress { chunk: id.clone() })?;
        let actual = Self::chunk_id(&plain);
        if &actual != id {
            return Err(Error::ChunkCorrupted {
                chunk: id.clone(),
                actual,
            });
        }
        Ok(plain)
    }

    /// Delete a chunk. Used only by GC's sweep, under its own guards.
    pub async fn delete_chunk(&self, id: &ChunkId) -> Result<()> {
        Self::check_content_address("chunk", id.as_str())?;
        self.op.delete(&Self::chunk_key(id)).await?;
        Ok(())
    }

    /// List the ids of every chunk in the store (the sweep's universe).
    pub async fn list_chunk_ids(&self) -> Result<Vec<ChunkId>> {
        let entries = self.op.list_with("chunks/").recursive(true).await?;
        let mut ids = Vec::new();
        for entry in entries {
            if entry.metadata().is_dir() {
                continue;
            }
            // The key is chunks/{prefix}/{id}; the id is the final segment.
            let path = entry.path();
            if let Some(name) = path.rsplit('/').next()
                && !name.is_empty()
            {
                ids.push(ChunkId::new(name.to_string()));
            }
        }
        Ok(ids)
    }

    /// The store's recorded last-modified time for a chunk, as Unix seconds.
    /// GC uses this as the chunk's age source; a freshly written chunk is
    /// "young" and thus protected by the safety window.
    pub async fn chunk_mtime_secs(&self, id: &ChunkId) -> Result<Option<u64>> {
        let meta = self.op.stat(&Self::chunk_key(id)).await?;
        // opendal's `Timestamp` wraps `jiff::Timestamp`; take whole seconds.
        Ok(meta
            .last_modified()
            .map(|ts| ts.into_inner().as_second())
            .filter(|t| *t >= 0)
            .map(|t| t as u64))
    }

    // ---- manifests -----------------------------------------------------

    /// Serialize a manifest to CBOR, store it at `manifests/{id}.cbor`, and
    /// return its [`ManifestId`] (blake3 of the CBOR). Idempotent.
    pub async fn put_manifest(&self, manifest: &Manifest) -> Result<ManifestId> {
        let cbor = mari_proto::to_cbor(manifest)?;
        let id = Self::manifest_id_of_cbor(&cbor);
        self.op.write(&Self::manifest_key(&id), cbor).await?;
        Ok(id)
    }

    /// Load and decode a manifest by id. `NotFound` maps to
    /// [`Error::ManifestNotFound`] so GC can fail safe on a missing parent.
    pub async fn get_manifest(&self, id: &ManifestId) -> Result<Manifest> {
        Self::check_content_address("manifest", id.as_str())?;
        let key = Self::manifest_key(id);
        let bytes = match self.op.read(&key).await {
            Ok(buf) => buf.to_vec(),
            Err(e) if e.kind() == ErrorKind::NotFound => {
                return Err(Error::ManifestNotFound(id.clone()));
            }
            Err(e) => return Err(e.into()),
        };
        Ok(mari_proto::from_cbor(&bytes)?)
    }

    /// Is this manifest present?
    pub async fn has_manifest(&self, id: &ManifestId) -> Result<bool> {
        Self::check_content_address("manifest", id.as_str())?;
        Ok(self.op.exists(&Self::manifest_key(id)).await?)
    }

    // ---- heat ----------------------------------------------------------

    /// Persist a computer's heat profile at `heat/{computer}.cbor`.
    ///
    /// The id is validated for the same reason a chunk id is: it is interpolated
    /// into a store key, and an id containing a separator or `..` would address a
    /// different prefix entirely. `check_computer_id` existed for this and was
    /// never called; both heat entry points now call it.
    pub async fn put_heat(&self, computer: &str, profile: &HeatProfile) -> Result<()> {
        Self::check_computer_id(computer)?;
        let cbor = mari_proto::to_cbor(profile)?;
        self.op.write(&Self::heat_key(computer), cbor).await?;
        Ok(())
    }

    /// Load a computer's heat profile, or `None` if it has none yet.
    pub async fn get_heat(&self, computer: &str) -> Result<Option<HeatProfile>> {
        Self::check_computer_id(computer)?;
        match self.op.read(&Self::heat_key(computer)).await {
            Ok(buf) => Ok(Some(mari_proto::from_cbor(&buf.to_vec())?)),
            Err(e) if e.kind() == ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Build an S3-backed store from explicit configuration. Compiled in behind
    /// the `s3` feature; the caller supplies bucket/region/endpoint and relies
    /// on the ambient credential chain. Its integration test runs only when
    /// live credentials are present.
    #[cfg(feature = "s3")]
    pub fn open_s3(bucket: &str, region: &str, root: &str, endpoint: Option<&str>) -> Result<Self> {
        let mut builder = opendal::services::S3::default()
            .bucket(bucket)
            .region(region)
            .root(root);
        if let Some(ep) = endpoint {
            builder = builder.endpoint(ep);
        }
        let op = Operator::new(builder)?.finish();
        Ok(Self::new(op))
    }
}
