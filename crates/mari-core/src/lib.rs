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
//! - [`rootfs`] — root-anchored (`openat`/`O_NOFOLLOW`) filesystem access. Every
//!   write, directory creation, removal and mode change in this crate goes
//!   through it, so no on-disk symlink can redirect an operation outside the
//!   root it was aimed at.
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
pub mod rootfs;
pub mod snapshot;
pub mod store;

pub use chunker::{ChunkerConfig, Cut};
pub use diff::{ManifestDiff, ModifiedEntry, diff};
pub use error::{Error, Result};
pub use gc::{
    DeadChunk, GcAction, GcAuditEntry, GcMode, GcPlan, GcReport, collect_live_set, execute, plan,
    plan_at,
};
pub use heat::{HeatRecorder, load_heat, store_heat};
pub use restore::{RestoreOptions, RestoreStats, restore};
pub use rootfs::{RootDir, RootWalk, WalkEntry, manifest_components};
pub use snapshot::{
    SnapshotOptions, SnapshotResult, default_credential_excludes, delta_chunks, manifest_chunks,
    snapshot,
};
pub use store::ChunkStore;

// Re-export the proto types this crate operates on, so downstream code can use
// `mari_core::Manifest` without also depending on `mari-proto` directly.
pub use mari_proto::{
    ChunkId, ChunkRef, ComputerId, EntryKind, HeatProfile, Manifest, ManifestEntry, ManifestId,
    SnapshotReason,
};
