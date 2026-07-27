//! Startup continuation: unfinished runs (spec 5.6) and WARM rollback (spec 4.7).
//!
//! Both duties are answered by the same pass, because both ask the same question
//! at the same moment — the first `HelloAck`, when the control plane has just
//! told us the journal head it holds for every run it knows:
//!
//! > for each run that was still running when this supervisor's predecessor
//! > died, is continuing it the right thing, and if so, how?
//!
//! ## What the supervisor compares
//!
//! Nothing on the substrate disk can be the reference: a WARM rollback restores
//! an *older disk*, and marid's own state would roll back with it. The reference
//! is therefore the pair that cannot roll back — the chunk store
//! ([`crate::state`]: the run records and the head history) and the control
//! plane's `hello_ack` offsets. A rollback is detected when the disk is behind
//! **either** of them:
//!
//! - **journal signal** — a run's on-disk journal segments hold fewer bytes than
//!   the store record says were durably written. Bytes that were on the disk are
//!   gone, so the disk went backwards. This is spec 4.7's "compare the disk with
//!   the journal head".
//! - **tree signal** — the tree on disk is byte-for-byte one of the *older*
//!   heads we recorded, not the newest one. The disk is literally an earlier
//!   checkpoint.
//!
//! Neither signal can fire on a healthy restart: on a healthy restart the disk
//! journal is at least as long as the record (the local segment file is written
//! before the store upload, and the record after it), and the tree either equals
//! the newest recorded head or is *ahead* of it — ahead matches no older entry.
//! A cold wake is skipped entirely: this process wrote the tree from the store
//! itself, so it knows exactly what the disk is.
//!
//! ## What it then does
//!
//! | situation | action |
//! |---|---|
//! | no rollback, adapter declares a resume command | spawn the resume command; the run keeps its id, its pre-run manifest and its journal offsets |
//! | no rollback, no adapter or no resume template | mark interrupted, keep the journal, one content-free attention event |
//! | rollback, replay **provably** safe | replay the run's original argv from the restored tree |
//! | rollback, anything else | mark interrupted, keep the journal, one content-free attention event |
//!
//! Replay is safe only under [`replay_is_safe`]: **the run had produced no
//! journal output at all** — none recorded in the store, none held by the
//! control plane, none surviving on disk. A run that had produced output may
//! have taken effects the rollback undid only partially, and re-running it would
//! double them; the supervisor does not guess. Default is not to replay, and a
//! rollback is always reported to the control plane
//! ([`mari_proto::SupervisorMessage::RollbackDetected`]) whatever it decides.

use std::collections::HashMap;
use std::sync::Arc;

use mari_core::{Manifest, SnapshotOptions, diff, snapshot};
use mari_proto::{DiffSummary, ManifestId, RunId, RunRollback, SupervisorMessage};
use tracing::{info, warn};

use crate::adapters::ResumeContext;
use crate::state::{HeadHistory, RunRecord, local_journal_state};
use crate::supervisor::Shared;

/// What the supervisor decided to do with one unfinished run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Decision {
    /// Spawn the agent's resume command (spec 5.6).
    Resume,
    /// Re-run the original argv: a rollback destroyed the run and replaying it
    /// is provably safe.
    Replay,
    /// Leave it stopped, keep the journal, raise one attention event.
    Interrupt,
}

/// A detected WARM rollback and the difference it caused (spec 4.7).
#[derive(Clone, Debug)]
pub(crate) struct RollbackFinding {
    /// The tree actually found on disk at connect.
    pub disk_manifest: ManifestId,
    /// The newest head the supervisor had recorded, if any.
    pub recorded_manifest: Option<ManifestId>,
    /// The on-disk tree measured against `recorded_manifest`.
    pub diff: DiffSummary,
    /// Which signal fired (for the log; the wire report carries the numbers).
    pub signal: &'static str,
}

/// One unfinished run's journal position at startup.
#[derive(Clone, Debug)]
pub(crate) struct RunPosition {
    /// Bytes the control plane durably holds (its `hello_ack` offset).
    pub control_offset: u64,
    /// Bytes still present in the run's journal on disk.
    pub disk_offset: u64,
    /// Next free journal segment ordinal, from disk and record.
    pub next_seq: u64,
    /// The highest journal end any surviving copy attests to: where a
    /// continuation of this run must take its next offset.
    pub resume_offset: u64,
}

/// Is replaying this run from the restored (older) tree safe?
///
/// Narrow on purpose. Safe means the run produced **no journal output at all**:
/// the store record has none, the control plane holds none, and none survives on
/// disk. Such a run said nothing and showed nothing, so starting it again is
/// indistinguishable from starting it the first time. Anything else — a single
/// byte of output anywhere — means the run may have done work whose effects the
/// rollback undid only in part, and the supervisor must not double it.
pub(crate) fn replay_is_safe(record: &RunRecord, pos: &RunPosition) -> bool {
    record.journal_len == 0 && pos.control_offset == 0 && pos.disk_offset == 0
}

/// The one-shot startup pass. Runs after the first `HelloAck`.
pub(crate) async fn run_startup_continuation(shared: &Arc<Shared>) {
    let records = match shared.run_manager.state().unfinished_runs().await {
        Ok(r) => r,
        Err(e) => {
            warn!("could not read run records; no run can be continued: {e:#}");
            return;
        }
    };
    let history = shared
        .run_manager
        .state()
        .head_history()
        .await
        .unwrap_or_else(|e| {
            warn!("could not read head history: {e:#}");
            HeadHistory::default()
        });

    // Journal positions for every unfinished run, from all three sources.
    let acked: HashMap<RunId, u64> = shared.acked.lock().unwrap().clone();
    let journal_root = shared.run_manager.journal_dir().clone();
    let mut positions: HashMap<RunId, RunPosition> = HashMap::new();
    for record in &records {
        let (disk_offset, disk_seq) = local_journal_state(&journal_root, &record.run);
        let control_offset = acked.get(&record.run).copied().unwrap_or(0);
        positions.insert(
            record.run.clone(),
            RunPosition {
                control_offset,
                disk_offset,
                next_seq: disk_seq.max(record.next_seq),
                resume_offset: record.journal_len.max(control_offset).max(disk_offset),
            },
        );
    }

    let rollback = detect_rollback(shared, &records, &positions, &history).await;
    if let Some(finding) = &rollback {
        warn!(
            signal = finding.signal,
            disk = %finding.disk_manifest,
            recorded = ?finding.recorded_manifest.as_ref().map(|m| m.to_string()),
            added = finding.diff.added,
            modified = finding.diff.modified,
            removed = finding.diff.removed,
            "WARM ROLLBACK: the substrate restored an old checkpoint"
        );
    }

    // Decide for every unfinished run before acting, so the report the control
    // plane receives states what actually happened to each of them.
    let mut decisions: Vec<(RunRecord, Decision, Option<Vec<String>>)> = Vec::new();
    for record in records {
        let pos = &positions[&record.run];
        let (decision, argv) = decide(shared, &record, pos, rollback.is_some());
        decisions.push((record, decision, argv));
    }

    if let Some(finding) = &rollback {
        let runs: Vec<RunRollback> = decisions
            .iter()
            .map(|(record, decision, _)| {
                let pos = &positions[&record.run];
                RunRollback {
                    run: record.run.clone(),
                    control_offset: mari_proto::JournalOffset::new(pos.control_offset),
                    disk_offset: mari_proto::JournalOffset::new(pos.disk_offset),
                    replayed: *decision == Decision::Replay,
                }
            })
            .collect();
        let _ = shared.outbox_tx.send(SupervisorMessage::RollbackDetected {
            disk_manifest: finding.disk_manifest.clone(),
            recorded_manifest: finding.recorded_manifest.clone(),
            diff: finding.diff,
            runs,
        });
    }

    for (record, decision, argv) in decisions {
        let pos = &positions[&record.run];
        match decision {
            Decision::Interrupt => shared.run_manager.interrupt_run(&record.run).await,
            Decision::Resume | Decision::Replay => {
                let argv = argv.expect("resume/replay decisions carry an argv");
                let (base, seq) = match decision {
                    // A replay re-runs the whole run; it is only ever chosen for
                    // a run with no journal output, so it starts at the top.
                    Decision::Replay => (0, 0),
                    _ => (pos.resume_offset, pos.next_seq),
                };
                info!(
                    run = %record.run,
                    ?decision,
                    journal_base = base,
                    "continuing run after restart"
                );
                if let Err(e) = shared
                    .run_manager
                    .continue_run(&record, argv, base, seq)
                    .await
                {
                    warn!(
                        run = %record.run,
                        "could not continue run: {}",
                        crate::run::bound_str(&format!("{e:#}"), 512)
                    );
                    // Continuation failed: the run is not running and nobody
                    // knows. That is exactly the interrupted case.
                    shared.run_manager.interrupt_run(&record.run).await;
                }
            }
        }
    }
}

/// Decide what happens to one unfinished run, and with which argv.
fn decide(
    shared: &Arc<Shared>,
    record: &RunRecord,
    pos: &RunPosition,
    rolled_back: bool,
) -> (Decision, Option<Vec<String>>) {
    if rolled_back {
        return if replay_is_safe(record, pos) {
            (Decision::Replay, Some(record.argv.clone()))
        } else {
            (Decision::Interrupt, None)
        };
    }
    // No rollback: continue the run through its agent's resume function.
    let adapter = record
        .adapter
        .as_deref()
        .and_then(|name| shared.run_manager.adapters().get(name))
        // A run started before its adapter file existed (or under a different
        // name) is still bound by the program it ran.
        .or_else(|| shared.run_manager.adapters().match_argv(&record.argv));
    let Some(adapter) = adapter else {
        return (Decision::Interrupt, None);
    };
    let ctx = ResumeContext {
        run: record.run.to_string(),
        journal_dir: shared
            .run_manager
            .journal_dir()
            .join(record.run.as_str())
            .to_string_lossy()
            .to_string(),
        cwd: record.cwd.clone(),
    };
    match adapter.resume_argv(&ctx) {
        Some(argv) => (Decision::Resume, Some(argv)),
        None => (Decision::Interrupt, None),
    }
}

/// Detect a WARM rollback (spec 4.7). `None` means the disk is not behind.
async fn detect_rollback(
    shared: &Arc<Shared>,
    records: &[RunRecord],
    positions: &HashMap<RunId, RunPosition>,
    history: &HeadHistory,
) -> Option<RollbackFinding> {
    if shared.cold_restored {
        // This process restored the tree from the chunk store on the way up, so
        // the disk is exactly the manifest it was written from. There is nothing
        // to compare and nothing that could have rolled back.
        return None;
    }
    if history.entries.is_empty() && records.is_empty() {
        // Nothing was ever recorded for this computer and nothing was running:
        // no reference, nothing to lose. Do not pay for a snapshot.
        return None;
    }

    // Signal 1: a run's journal on disk is shorter than the store says is durable.
    let journal_signal = records.iter().any(|r| {
        positions
            .get(&r.run)
            .map(|p| p.disk_offset < r.journal_len)
            .unwrap_or(false)
    });

    if !journal_signal && history.entries.is_empty() {
        // No recorded head to compare the tree against and no journal loss:
        // neither signal can fire, so do not pay for the snapshot.
        return None;
    }

    // The tree as it actually is right now.
    let opts = SnapshotOptions {
        exclude: shared.excludes(),
        created_at: now_secs(),
        ..SnapshotOptions::default()
    };
    let disk = match snapshot(&shared.store, &shared.config.root, &opts).await {
        Ok(res) => res,
        Err(e) => {
            warn!("rollback check: snapshotting the disk failed: {e:#}");
            return None;
        }
    };

    // Signal 2: the tree equals a head we recorded BEFORE the newest one.
    let mut tree_signal = false;
    let mut newest_manifest: Option<Manifest> = None;
    if let Some(newest) = history.newest() {
        newest_manifest = load_manifest(shared, &newest.manifest).await;
        let in_sync = newest_manifest
            .as_ref()
            .map(|m| diff(m, &disk.manifest).is_empty())
            .unwrap_or(false);
        if !in_sync {
            // Walk backwards through the older recorded heads: an exact match
            // with one of them is the disk sitting at an earlier checkpoint.
            for entry in history.entries.iter().rev().skip(1) {
                if let Some(m) = load_manifest(shared, &entry.manifest).await
                    && diff(&m, &disk.manifest).is_empty()
                {
                    tree_signal = true;
                    break;
                }
            }
        }
    }

    if !journal_signal && !tree_signal {
        return None;
    }
    let summary = newest_manifest
        .as_ref()
        .map(|m| diff(m, &disk.manifest).summary())
        .unwrap_or_default();
    Some(RollbackFinding {
        disk_manifest: disk.manifest_id,
        recorded_manifest: history.newest().map(|h| h.manifest.clone()),
        diff: summary,
        signal: if journal_signal && tree_signal {
            "journal+tree"
        } else if journal_signal {
            "journal"
        } else {
            "tree"
        },
    })
}

async fn load_manifest(shared: &Arc<Shared>, id: &ManifestId) -> Option<Manifest> {
    match shared.store.get_manifest(id).await {
        Ok(m) => Some(m),
        Err(e) => {
            warn!(%id, "rollback check: recorded manifest unreadable: {e}");
            None
        }
    }
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
