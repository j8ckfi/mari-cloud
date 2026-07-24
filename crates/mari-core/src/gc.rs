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
//! (2) older than the safety window. The window is keyed on the chunk's *store
//! mtime*, so it protects a **freshly-uploaded** chunk: bytes just written but
//! not yet named by any manifest must not be swept out from under the snapshot
//! that is about to reference them. A chunk with an unknown store timestamp is
//! treated as protected.
//!
//! The mtime window does **not**, on its own, protect a *resurrected* chunk: one
//! that is old and unreferenced at plan time but is referenced again before the
//! sweep runs. Because chunks are content-addressed, a snapshot on any computer
//! that dedups against the store reuses an already-present chunk and advances a
//! manifest head **without rewriting the chunk** — its store-mtime stays old, so
//! the window sees nothing. The fleet-wide, shared chunk store means some
//! computer is nearly always snapshotting, so this race window is effectively
//! always open. Guarding it is [`execute`]'s job: it re-collects the live set
//! from the *current* retained set at execution time and refuses to delete any
//! candidate that has become live again — it never trusts the plan's frozen
//! `live` set for a deletion decision.
//!
//! This narrows the race to the interval between that execution-time live-set
//! collection and each delete. Fully closing it requires coordination the caller
//! owns and mari-core cannot provide alone: run the sweep under a quiesce, or
//! gate it on the fencing epoch (decisions.md) so any manifest-head advance
//! after planning aborts the sweep. `execute` assumes the `retained` set it is
//! given names every manifest that could be referenced for the duration of the
//! call. Every deletion is recorded in an audit log.

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
    /// Dead when the plan was built, but live again against the current retained
    /// set at execution time — a resurrection caught and skipped, never deleted.
    Resurrected,
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

/// Execute a sweep plan, re-verifying safety against the **current** retained
/// set rather than trusting the plan's frozen live set.
///
/// The plan supplies the candidate list and each candidate's plan-time age. But
/// between planning and execution a dead chunk can be *resurrected*: a snapshot
/// on any computer dedups against the store, references the already-present
/// chunk, and advances a manifest head — all without rewriting the chunk, so its
/// store-mtime (the window's only signal) stays old (see the module docs). To
/// catch that, `execute` re-collects the live set from `retained` — the
/// retention set as of *now* — and deletes a candidate only if it is still
/// absent from that current live set. `retained` must therefore be re-read fresh
/// at call time, not reused from planning.
///
/// In [`GcMode::DryRun`] nothing is deleted; the same current-state checks run,
/// so the report is an honest preview. In [`GcMode::Delete`] every still-dead,
/// still-aged-out candidate is deleted. Returns an audit log covering every dead
/// chunk considered. This narrows but does not by itself eliminate the
/// resurrection window (module docs): the caller must run the sweep under
/// coordination for full safety.
pub async fn execute(
    store: &ChunkStore,
    plan: &GcPlan,
    retained: &[ManifestId],
    mode: GcMode,
) -> Result<GcReport> {
    // Re-verify against the live set as of *now*, never the plan's frozen one:
    // a chunk dead at plan time may have been referenced again since.
    let current_live = collect_live_set(store, retained).await?;

    let mut deleted = Vec::new();
    let mut audit = Vec::with_capacity(plan.dead.len());

    for d in &plan.dead {
        // Invariant 1 (resurrection guard): never delete a chunk that is live
        // against the CURRENT retained set, even if it was dead when the plan
        // was built. A snapshot that dedup-references an already-present chunk
        // between plan and execute revives it without refreshing its mtime, so
        // only this fresh live-set check — not the plan's `live` and not the
        // mtime window — catches it.
        if current_live.contains(&d.chunk) {
            audit.push(GcAuditEntry {
                chunk: d.chunk.clone(),
                age_secs: d.age_secs,
                action: GcAction::Resurrected,
            });
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
