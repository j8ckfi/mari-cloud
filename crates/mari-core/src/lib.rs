//! The storage inversion: chunking, manifests, stores, restore, GC.
//!
//! One implementation, used natively by `marid` and (later) compiled to Wasm
//! for the control plane. Drift in this layer is the deletes-a-computer class
//! of bug; there is exactly one copy of this logic.
//!
//! # Shape
//!
//! - [`store::ChunkStore`] — content-addressed object store over opendal
//!   (`services-fs` always, `services-s3` behind the `s3` feature). blake3 ids,
//!   zstd chunk bodies, **blake3 verification on every read**.
//! - [`chunker`] — FastCDC content-defined chunking, configurable params.
//! - [`snapshot`] — walk a tree → upload only missing chunks → store a
//!   [`mari_proto::Manifest`]; `parent` links a base image for delta accounting.
//! - [`restore`] — reconstruct a byte-identical tree (modes, symlinks), heat
//!   priority first, path-traversal safe.
//! - [`diff`] — added / modified / removed with mode-only vs content detail.
//! - [`heat`] — the boot/run-start read-order profile and its recorder.
//! - [`gc`] — mark-and-sweep over the live set, with a safety window and an
//!   audit log. The critical path (spec 4.8).
//!
//! Manifest, heat-profile, and id types are defined once in
//! [`mari_proto`] and reused here — never redefined.

pub mod chunker;
pub mod diff;
pub mod error;
pub mod gc;
pub mod heat;
pub mod restore;
pub mod snapshot;
pub mod store;

pub use chunker::{ChunkerConfig, Cut};
pub use diff::{diff, ManifestDiff, ModifiedEntry};
pub use error::{Error, Result};
pub use gc::{
    collect_live_set, execute, plan, plan_at, DeadChunk, GcAction, GcAuditEntry, GcMode, GcPlan,
    GcReport,
};
pub use heat::{load_heat, store_heat, HeatRecorder};
pub use restore::{restore, RestoreOptions, RestoreStats};
pub use snapshot::{
    default_credential_excludes, delta_chunks, manifest_chunks, snapshot, SnapshotOptions,
    SnapshotResult,
};
pub use store::ChunkStore;

// Re-export the proto types this crate operates on, so downstream code can use
// `mari_core::Manifest` without also depending on `mari-proto` directly.
pub use mari_proto::{
    ChunkId, ChunkRef, ComputerId, EntryKind, HeatProfile, Manifest, ManifestEntry, ManifestId,
    SnapshotReason,
};
