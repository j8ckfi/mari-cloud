//! Garbage collection: mark-and-sweep over the live set (decisions.md, spec 4.8).
//!
//! This is the deletes-a-computer code path, so it is built to fail safe.
//!
//! **Mark.** The live set is the union of every chunk reachable from any
//! *retained* manifest, following each manifest's parent chain to the base
//! image. Retention (the time-machine policy) decides which manifests are
//! retained; a chunk referenced only by a non-retained manifest is dead. If any
//! retained manifest — or any parent in its chain — cannot be loaded, the plan
//! **errors** rather than proceed on an incomplete live set.
//!
//! **Sweep.** A chunk is deleted only if it is (1) absent from the live set AND
//! (2) older than the safety window. The window protects in-flight snapshots: a
//! just-written chunk not yet referenced by any manifest must not be swept out
//! from under the snapshot that is about to reference it. A chunk with an
//! unknown store timestamp is treated as protected.
//!
//! Both invariants are re-checked at the deletion site in [`execute`], not only
//! at plan time. Every deletion is recorded in an audit log.

use std::collections::{BTreeSet, HashSet};
use std::time::{SystemTime, UNIX_EPOCH};

use futures::stream::{self, StreamExt};
use mari_proto::{ChunkId, ManifestId};

use crate::error::Result;
use crate::snapshot::manifest_chunks;
use crate::store::ChunkStore;

/// Concurrency for age lookups during planning.
const AGE_CONCURRENCY: usize = 32;

/// A chunk not in the live set: a deletion candidate.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DeadChunk {
    /// The chunk id.
    pub chunk: ChunkId,
    /// Age in seconds (`now - store_mtime`); `0` if the mtime is unknown.
    pub age_secs: u64,
    /// Whether the store reported a last-modified time for this chunk.
    pub mtime_known: bool,
    /// Protected from deletion: younger than the safety window, or unknown age.
    pub protected: bool,
}

/// A sweep plan: what is live, and what is dead (with ages). Produced by
/// [`plan`]; consumed by [`execute`]. Inspect it (or dry-run) before deleting.
#[derive(Clone, Debug)]
pub struct GcPlan {
    /// The live set: chunks reachable from a retained manifest chain.
    pub live: BTreeSet<ChunkId>,
    /// Dead chunks (not in the live set), each with its age and protection.
    pub dead: Vec<DeadChunk>,
    /// The safety window in seconds used to compute protection.
    pub safety_window_secs: u64,
    /// The `now` (Unix seconds) the ages were computed against.
    pub now_secs: u64,
    /// Total chunks in the store at plan time.
    pub total_chunks: usize,
}

impl GcPlan {
    /// Size of the live set.
    pub fn live_count(&self) -> usize {
        self.live.len()
    }

    /// Dead chunks eligible for deletion (past the safety window).
    pub fn deletable(&self) -> impl Iterator<Item = &DeadChunk> {
        self.dead.iter().filter(|d| !d.protected)
    }

    /// Dead chunks held back by the safety window.
    pub fn protected(&self) -> impl Iterator<Item = &DeadChunk> {
        self.dead.iter().filter(|d| d.protected)
    }
}

/// Whether [`execute`] actually deletes or only reports.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GcMode {
    /// Delete nothing; report what would be deleted.
    DryRun,
    /// Delete the eligible dead chunks.
    Delete,
}

/// What happened to one chunk during a sweep.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GcAction {
    /// Deleted from the store (Delete mode only).
    Deleted,
    /// Eligible; would be deleted (DryRun mode).
    WouldDelete,
    /// Held back by the safety window.
    ProtectedByWindow,
}

/// One line of the sweep's audit log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GcAuditEntry {
    /// The chunk id.
    pub chunk: ChunkId,
    /// Its age in seconds at plan time.
    pub age_secs: u64,
    /// The action taken.
    pub action: GcAction,
}

/// The result of a sweep.
#[derive(Clone, Debug)]
pub struct GcReport {
    /// The mode the sweep ran in.
    pub mode: GcMode,
    /// Chunks actually deleted (empty for a dry run).
    pub deleted: Vec<ChunkId>,
    /// The full audit log: one entry per dead chunk considered.
    pub audit: Vec<GcAuditEntry>,
}

impl GcReport {
    /// Number of chunks deleted.
    pub fn deleted_count(&self) -> usize {
        self.deleted.len()
    }
}

/// Compute the live set: every chunk reachable from any retained manifest,
/// transitively through parent chains. Errors if any referenced manifest is
/// missing — GC must never run on an incomplete live set.
pub async fn collect_live_set(
    store: &ChunkStore,
    retained: &[ManifestId],
) -> Result<BTreeSet<ChunkId>> {
    let mut live: BTreeSet<ChunkId> = BTreeSet::new();
    let mut visited: HashSet<ManifestId> = HashSet::new();
    let mut stack: Vec<ManifestId> = retained.to_vec();
    while let Some(id) = stack.pop() {
        if !visited.insert(id.clone()) {
            continue;
        }
        let manifest = store.get_manifest(&id).await?;
        live.extend(manifest_chunks(&manifest));
        if let Some(parent) = manifest.parent {
            stack.push(parent);
        }
    }
    Ok(live)
}

/// Plan a sweep as of *now*. See [`plan_at`].
pub async fn plan(
    store: &ChunkStore,
    retained: &[ManifestId],
    safety_window_secs: u64,
) -> Result<GcPlan> {
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    plan_at(store, retained, safety_window_secs, now).await
}

/// Plan a sweep against an explicit `now_secs` (testable). Computes the live
/// set, lists every store chunk, and classifies the non-live ones by age.
pub async fn plan_at(
    store: &ChunkStore,
    retained: &[ManifestId],
    safety_window_secs: u64,
    now_secs: u64,
) -> Result<GcPlan> {
    let live = collect_live_set(store, retained).await?;
    let all = store.list_chunk_ids().await?;
    let total_chunks = all.len();

    // Only non-live chunks are candidates; gather their ages concurrently.
    let candidates: Vec<ChunkId> = all.into_iter().filter(|c| !live.contains(c)).collect();

    let aged: Vec<Result<DeadChunk>> = stream::iter(candidates.into_iter().map(|chunk| {
        let store = store.clone();
        async move {
            let mtime = store.chunk_mtime_secs(&chunk).await?;
            let (age_secs, mtime_known) = match mtime {
                Some(mt) => (now_secs.saturating_sub(mt), true),
                None => (0, false),
            };
            // Protect anything younger than the window, or of unknown age.
            let protected = !mtime_known || age_secs < safety_window_secs;
            Ok(DeadChunk {
                chunk,
                age_secs,
                mtime_known,
                protected,
            })
        }
    }))
    .buffer_unordered(AGE_CONCURRENCY)
    .collect()
    .await;

    let mut dead = Vec::with_capacity(aged.len());
    for d in aged {
        dead.push(d?);
    }
    dead.sort_by(|a, b| a.chunk.cmp(&b.chunk));

    Ok(GcPlan {
        live,
        dead,
        safety_window_secs,
        now_secs,
        total_chunks,
    })
}

/// Execute a sweep plan. In [`GcMode::DryRun`] nothing is deleted. In
/// [`GcMode::Delete`] every eligible dead chunk is deleted, with the two
/// invariants — not live, past the window — re-checked at the deletion site.
/// Returns an audit log covering every dead chunk considered.
pub async fn execute(store: &ChunkStore, plan: &GcPlan, mode: GcMode) -> Result<GcReport> {
    let mut deleted = Vec::new();
    let mut audit = Vec::with_capacity(plan.dead.len());

    for d in &plan.dead {
        // Invariant 1: never touch a chunk reachable from a retained manifest.
        // (dead is already the non-live set; this is defense in depth.)
        if plan.live.contains(&d.chunk) {
            continue;
        }
        // Invariant 2: never delete a chunk younger than the safety window.
        if d.protected {
            audit.push(GcAuditEntry {
                chunk: d.chunk.clone(),
                age_secs: d.age_secs,
                action: GcAction::ProtectedByWindow,
            });
            continue;
        }
        match mode {
            GcMode::DryRun => audit.push(GcAuditEntry {
                chunk: d.chunk.clone(),
                age_secs: d.age_secs,
                action: GcAction::WouldDelete,
            }),
            GcMode::Delete => {
                store.delete_chunk(&d.chunk).await?;
                deleted.push(d.chunk.clone());
                audit.push(GcAuditEntry {
                    chunk: d.chunk.clone(),
                    age_secs: d.age_secs,
                    action: GcAction::Deleted,
                });
            }
        }
    }

    Ok(GcReport {
        mode,
        deleted,
        audit,
    })
}
