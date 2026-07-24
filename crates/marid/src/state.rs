//! Durable supervisor state: what survives the supervisor process (spec 5.6, 4.7).
//!
//! Memory does not survive COLD (spec 4.5) and a substrate disk can roll back to
//! an older checkpoint (spec 4.7) — so neither RAM nor the disk can hold the
//! record of "what was running" or "what the tree last was". Both live in the
//! **chunk store**, the home of the computer (spec 3.3), under two keys:
//!
//! | Key | Contents |
//! |---|---|
//! | `runs/{computer}/{run}.cbor` | one [`RunRecord`]: how the run was started, whose adapter owns it, how far its journal is durable, and its phase |
//! | `state/{computer}/heads.cbor` | the [`HeadHistory`]: the last few manifests the supervisor recorded for this computer, newest last |
//!
//! Both are per-computer mutable objects like the heat profile
//! (`heat/{computer}.cbor`, contracts §9) — not content-addressed chunks, which
//! stay immutable. They are marid's own state, not a cross-language wire
//! contract, so they are defined here rather than in `mari-proto`; only the
//! *report* that comes out of them (`SupervisorMessage::RollbackDetected`)
//! crosses the wire.
//!
//! Every read-modify-write goes through [`DurableState`], which serializes them
//! within the process so a run's housekeeping flush and its completion cannot
//! interleave and lose a field.

use std::path::Path;

use mari_proto::{ComputerId, Epoch, ManifestId, RunId};
use serde::{Deserialize, Serialize};
use tracing::{debug, warn};

use mari_core::ChunkStore;

/// Schema version of [`RunRecord`] and [`HeadHistory`].
pub const STATE_VERSION: u32 = 1;

/// How many recorded heads to keep. The history exists to answer one question —
/// "is the tree on disk one of the checkpoints we recorded *before* the newest
/// one?" — and a rollback restores a recent checkpoint, so a short window is
/// enough and bounds both the object size and the startup comparison.
pub const HEAD_HISTORY_LEN: usize = 8;

/// Where a run is in its life, as recorded durably.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RunPhase {
    /// Started and not yet finished. A record still in this phase at startup is
    /// an unfinished run (spec 5.6).
    Running,
    /// The run's process exited and its completion was reported.
    Completed,
    /// The supervisor could not continue the run after a restart, or a rollback
    /// destroyed work it may not safely replay. The journal is preserved.
    Interrupted,
}

/// The durable record of one run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RunRecord {
    /// [`STATE_VERSION`].
    pub version: u32,
    /// The run id.
    pub run: RunId,
    /// The argv the run was started with (contracts §5.2 `start_run`).
    pub argv: Vec<String>,
    /// Vault variable names to inject (spec 10.1); values are never recorded.
    pub env_names: Vec<String>,
    /// The run's working directory.
    pub cwd: String,
    /// The agent adapter bound to this run at start, if any.
    pub adapter: Option<String>,
    /// The pre-run manifest: this run's diff baseline (spec 5.2). Unchanged by
    /// a resume — a resumed run is the same run.
    pub pre_run_manifest: ManifestId,
    /// Journal bytes durably written to store segments so far.
    pub journal_len: u64,
    /// The next journal segment ordinal for this run.
    pub next_seq: u64,
    /// The wake epoch under which the run was started or last continued.
    pub epoch: u64,
    /// Unix seconds when the run was started.
    pub started_at: u64,
    /// Current phase.
    pub phase: RunPhase,
}

impl RunRecord {
    /// A fresh record for a run that is starting now.
    #[allow(clippy::too_many_arguments)] // it is a record: every field is one.
    pub fn new(
        run: RunId,
        argv: Vec<String>,
        env_names: Vec<String>,
        cwd: String,
        adapter: Option<String>,
        pre_run_manifest: ManifestId,
        epoch: Epoch,
        started_at: u64,
    ) -> Self {
        Self {
            version: STATE_VERSION,
            run,
            argv,
            env_names,
            cwd,
            adapter,
            pre_run_manifest,
            journal_len: 0,
            next_seq: 0,
            epoch: epoch.get(),
            started_at,
            phase: RunPhase::Running,
        }
    }

    /// Is this run unfinished (the set spec 5.6 must continue)?
    pub fn is_unfinished(&self) -> bool {
        self.phase == RunPhase::Running
    }
}

/// One recorded manifest head: the tree this computer had at that moment.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadEntry {
    /// The manifest that was written.
    pub manifest: ManifestId,
    /// The epoch it was written under.
    pub epoch: u64,
    /// Unix seconds when it was recorded.
    pub created_at: u64,
}

/// The recorded heads for a computer, oldest first, newest last.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct HeadHistory {
    /// [`STATE_VERSION`] (0 on a default-constructed, never-stored history).
    #[serde(default)]
    pub version: u32,
    /// The entries, oldest first.
    pub entries: Vec<HeadEntry>,
}

impl HeadHistory {
    /// The newest recorded head, if any.
    pub fn newest(&self) -> Option<&HeadEntry> {
        self.entries.last()
    }
}

/// Handle for reading and writing the durable supervisor state of one computer.
pub struct DurableState {
    store: ChunkStore,
    computer: ComputerId,
    /// This supervisor's wake epoch. Unlike chunks and manifests, these records
    /// are mutable objects, so a fenced-out supervisor could otherwise clobber
    /// the live one's state — mark a running run completed, say, which would
    /// stop a later restart from continuing it. An update whose record is
    /// stamped with a NEWER epoch than ours is therefore refused: the same
    /// single-writer rule as the head advance (spec 4.1), applied where it also
    /// matters.
    epoch: Epoch,
    /// Serializes read-modify-write sequences within this process.
    lock: tokio::sync::Mutex<()>,
}

impl DurableState {
    /// Bind to a store and a computer under this supervisor's wake epoch.
    pub fn new(store: ChunkStore, computer: ComputerId, epoch: Epoch) -> Self {
        Self {
            store,
            computer,
            epoch,
            lock: tokio::sync::Mutex::new(()),
        }
    }

    /// Has a newer wake taken this run over? Then this supervisor is fenced out
    /// of it and must not write.
    fn fenced_out(&self, record: &RunRecord) -> bool {
        if record.epoch > self.epoch.get() {
            warn!(
                run = %record.run,
                record_epoch = record.epoch,
                our_epoch = self.epoch.get(),
                "refusing to update a run record owned by a newer wake"
            );
            return true;
        }
        false
    }

    /// `runs/{computer}/` — the prefix every run record of a computer lives under.
    pub fn runs_prefix(computer: &ComputerId) -> String {
        format!("runs/{computer}/")
    }

    /// `runs/{computer}/{run}.cbor`.
    pub fn run_key(computer: &ComputerId, run: &RunId) -> String {
        format!("runs/{computer}/{run}.cbor")
    }

    /// `state/{computer}/heads.cbor`.
    pub fn heads_key(computer: &ComputerId) -> String {
        format!("state/{computer}/heads.cbor")
    }

    /// Write (or overwrite) a run record.
    pub async fn put_run(&self, record: &RunRecord) -> anyhow::Result<()> {
        let key = Self::run_key(&self.computer, &record.run);
        let bytes = mari_proto::to_cbor(record)?;
        self.store.operator().write(&key, bytes).await?;
        Ok(())
    }

    /// Read one run record, or `None` if the store has none.
    pub async fn get_run(&self, run: &RunId) -> anyhow::Result<Option<RunRecord>> {
        let key = Self::run_key(&self.computer, run);
        match self.store.operator().read(&key).await {
            Ok(buf) => Ok(Some(mari_proto::from_cbor(&buf.to_vec())?)),
            Err(e) if e.kind() == opendal::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }

    /// Every run record for this computer, sorted by run id. A record that
    /// cannot be decoded is skipped with a warning: one corrupt object must not
    /// stop the supervisor from continuing the other runs.
    pub async fn list_runs(&self) -> anyhow::Result<Vec<RunRecord>> {
        let prefix = Self::runs_prefix(&self.computer);
        let entries = match self
            .store
            .operator()
            .list_with(&prefix)
            .recursive(true)
            .await
        {
            Ok(e) => e,
            Err(e) if e.kind() == opendal::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(e.into()),
        };
        let mut out = Vec::new();
        for entry in entries {
            if entry.metadata().is_dir() || !entry.path().ends_with(".cbor") {
                continue;
            }
            match self.store.operator().read(entry.path()).await {
                Ok(buf) => match mari_proto::from_cbor::<RunRecord>(&buf.to_vec()) {
                    Ok(r) => out.push(r),
                    Err(e) => warn!(key = entry.path(), "skipping undecodable run record: {e}"),
                },
                Err(e) => warn!(key = entry.path(), "skipping unreadable run record: {e}"),
            }
        }
        out.sort_by(|a, b| a.run.as_str().cmp(b.run.as_str()));
        Ok(out)
    }

    /// The unfinished runs: exactly the set spec 5.6 must continue at startup.
    pub async fn unfinished_runs(&self) -> anyhow::Result<Vec<RunRecord>> {
        Ok(self
            .list_runs()
            .await?
            .into_iter()
            .filter(RunRecord::is_unfinished)
            .collect())
    }

    /// Record how far a run's journal is durable. No-op if the record is gone.
    pub async fn set_journal_progress(
        &self,
        run: &RunId,
        journal_len: u64,
        next_seq: u64,
    ) -> anyhow::Result<()> {
        let _g = self.lock.lock().await;
        let Some(mut record) = self.get_run(run).await? else {
            return Ok(());
        };
        if self.fenced_out(&record) {
            return Ok(());
        }
        // Monotonic: a late write must never walk the durable length backwards.
        if journal_len <= record.journal_len && next_seq <= record.next_seq {
            return Ok(());
        }
        record.journal_len = record.journal_len.max(journal_len);
        record.next_seq = record.next_seq.max(next_seq);
        self.put_run(&record).await
    }

    /// Move a run to a terminal phase. No-op if the record is gone.
    pub async fn set_phase(&self, run: &RunId, phase: RunPhase) -> anyhow::Result<()> {
        let _g = self.lock.lock().await;
        let Some(mut record) = self.get_run(run).await? else {
            return Ok(());
        };
        if self.fenced_out(&record) {
            return Ok(());
        }
        record.phase = phase;
        self.put_run(&record).await
    }

    /// Note that a run is being continued under a new epoch (its phase stays
    /// `Running`; the journal keeps its offsets).
    pub async fn set_epoch(&self, run: &RunId, epoch: Epoch) -> anyhow::Result<()> {
        let _g = self.lock.lock().await;
        let Some(mut record) = self.get_run(run).await? else {
            return Ok(());
        };
        if self.fenced_out(&record) {
            return Ok(());
        }
        record.epoch = epoch.get();
        self.put_run(&record).await
    }

    /// The recorded head history (empty when none was ever stored).
    pub async fn head_history(&self) -> anyhow::Result<HeadHistory> {
        let key = Self::heads_key(&self.computer);
        match self.store.operator().read(&key).await {
            Ok(buf) => Ok(mari_proto::from_cbor(&buf.to_vec())?),
            Err(e) if e.kind() == opendal::ErrorKind::NotFound => Ok(HeadHistory::default()),
            Err(e) => Err(e.into()),
        }
    }

    /// Append a head to the history, keeping the newest [`HEAD_HISTORY_LEN`].
    /// Re-recording the current newest head is a no-op, so a scheduled snapshot
    /// of an idle computer does not flush the window.
    pub async fn record_head(&self, manifest: &ManifestId, epoch: Epoch) -> anyhow::Result<()> {
        let _g = self.lock.lock().await;
        let mut history = self.head_history().await?;
        if history.newest().map(|h| &h.manifest) == Some(manifest) {
            return Ok(());
        }
        history.version = STATE_VERSION;
        history.entries.push(HeadEntry {
            manifest: manifest.clone(),
            epoch: epoch.get(),
            created_at: now_secs(),
        });
        if history.entries.len() > HEAD_HISTORY_LEN {
            let drop = history.entries.len() - HEAD_HISTORY_LEN;
            history.entries.drain(..drop);
        }
        let bytes = mari_proto::to_cbor(&history)?;
        self.store
            .operator()
            .write(&Self::heads_key(&self.computer), bytes)
            .await?;
        debug!(%manifest, "recorded head");
        Ok(())
    }
}

/// The journal bytes that survived on **disk** for a run, and the next free
/// segment ordinal, read from the local segment files under
/// `{journal_root}/{run}/{seq:08}.seg`.
///
/// Only the contiguous run of segments from ordinal 0 counts: a hole means the
/// bytes after it are not addressable from the disk copy, so they are not
/// claimed as present. A disk that lost segments a store record says were
/// written is the journal-side signature of a WARM rollback (spec 4.7).
pub fn local_journal_state(journal_root: &Path, run: &RunId) -> (u64, u64) {
    let dir = journal_root.join(run.as_str());
    let mut sizes: std::collections::BTreeMap<u64, u64> = std::collections::BTreeMap::new();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return (0, 0);
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(stem) = name.strip_suffix(".seg") else {
            continue;
        };
        let Ok(seq) = stem.parse::<u64>() else {
            continue;
        };
        let Ok(meta) = entry.metadata() else { continue };
        if meta.is_file() {
            sizes.insert(seq, meta.len());
        }
    }
    let mut total = 0u64;
    let mut next = 0u64;
    for (seq, len) in sizes {
        if seq != next {
            break; // a hole: stop counting here
        }
        total += len;
        next = seq + 1;
    }
    (total, next)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(dir: &Path) -> ChunkStore {
        ChunkStore::open_fs(dir.join("store")).unwrap()
    }

    fn state(dir: &Path, epoch: u64) -> DurableState {
        DurableState::new(store(dir), ComputerId::new("comp-s"), Epoch::new(epoch))
    }

    fn record(run: &str) -> RunRecord {
        RunRecord::new(
            RunId::new(run),
            vec!["agent".into(), "--go".into()],
            vec!["API_KEY".into()],
            "/work".into(),
            Some("agent".into()),
            ManifestId::new("m0"),
            Epoch::new(3),
            100,
        )
    }

    #[tokio::test]
    async fn records_round_trip_and_only_running_ones_count_as_unfinished() {
        let tmp = tempfile::tempdir().unwrap();
        let st = state(tmp.path(), 3);
        st.put_run(&record("run-a")).await.unwrap();
        st.put_run(&record("run-b")).await.unwrap();
        st.put_run(&record("run-c")).await.unwrap();
        st.set_phase(&RunId::new("run-b"), RunPhase::Completed)
            .await
            .unwrap();
        st.set_phase(&RunId::new("run-c"), RunPhase::Interrupted)
            .await
            .unwrap();

        let back = st.get_run(&RunId::new("run-a")).await.unwrap().unwrap();
        assert_eq!(back, record("run-a"), "a record round-trips exactly");
        assert_eq!(st.list_runs().await.unwrap().len(), 3);
        let unfinished: Vec<String> = st
            .unfinished_runs()
            .await
            .unwrap()
            .into_iter()
            .map(|r| r.run.to_string())
            .collect();
        assert_eq!(
            unfinished,
            vec!["run-a".to_string()],
            "completed and interrupted runs are finished for good"
        );
    }

    #[tokio::test]
    async fn journal_progress_is_monotonic() {
        let tmp = tempfile::tempdir().unwrap();
        let st = state(tmp.path(), 3);
        let run = RunId::new("run-a");
        st.put_run(&record("run-a")).await.unwrap();
        st.set_journal_progress(&run, 100, 2).await.unwrap();
        // A late, smaller write must not walk the durable head backwards: that
        // head is what a resume takes its next offset from.
        st.set_journal_progress(&run, 40, 1).await.unwrap();
        let r = st.get_run(&run).await.unwrap().unwrap();
        assert_eq!((r.journal_len, r.next_seq), (100, 2));
    }

    /// A fenced-out supervisor (older wake) must not mutate a run the current
    /// one owns — marking it completed would stop a restart continuing it.
    #[tokio::test]
    async fn an_older_wake_cannot_clobber_a_newer_wakes_run_record() {
        let tmp = tempfile::tempdir().unwrap();
        let run = RunId::new("run-a");
        let current = state(tmp.path(), 9);
        current.put_run(&record("run-a")).await.unwrap();
        current.set_epoch(&run, Epoch::new(9)).await.unwrap();
        current.set_journal_progress(&run, 500, 3).await.unwrap();

        let stale = state(tmp.path(), 4);
        stale.set_phase(&run, RunPhase::Completed).await.unwrap();
        stale.set_journal_progress(&run, 900, 9).await.unwrap();

        let r = current.get_run(&run).await.unwrap().unwrap();
        assert_eq!(
            r.phase,
            RunPhase::Running,
            "the stale write must be refused"
        );
        assert_eq!((r.journal_len, r.next_seq), (500, 3));

        // The current wake still writes freely.
        current.set_phase(&run, RunPhase::Completed).await.unwrap();
        assert_eq!(
            current.get_run(&run).await.unwrap().unwrap().phase,
            RunPhase::Completed
        );
    }

    #[tokio::test]
    async fn head_history_appends_dedupes_and_caps() {
        let tmp = tempfile::tempdir().unwrap();
        let st = state(tmp.path(), 1);
        assert!(st.head_history().await.unwrap().entries.is_empty());
        for i in 0..(HEAD_HISTORY_LEN as u64 + 3) {
            st.record_head(&ManifestId::new(format!("m{i}")), Epoch::new(1))
                .await
                .unwrap();
            // Re-recording the same head is a no-op: an idle computer's
            // scheduled snapshots must not flush the window.
            st.record_head(&ManifestId::new(format!("m{i}")), Epoch::new(1))
                .await
                .unwrap();
        }
        let h = st.head_history().await.unwrap();
        assert_eq!(h.entries.len(), HEAD_HISTORY_LEN, "the window is bounded");
        assert_eq!(h.newest().unwrap().manifest, ManifestId::new("m10"));
        assert_eq!(
            h.entries[0].manifest,
            ManifestId::new("m3"),
            "the oldest entries are dropped, newest kept, order preserved"
        );
    }

    #[test]
    fn local_journal_state_counts_only_the_contiguous_run_of_segments() {
        let tmp = tempfile::tempdir().unwrap();
        let run = RunId::new("run-j");
        let dir = tmp.path().join(run.as_str());
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(local_journal_state(tmp.path(), &run), (0, 0));

        std::fs::write(dir.join("00000000.seg"), vec![0u8; 8]).unwrap();
        std::fs::write(dir.join("00000001.seg"), vec![0u8; 5]).unwrap();
        // Ordinal 3 exists but 2 does not: the disk cannot address bytes past
        // the hole, so they are not claimed as present.
        std::fs::write(dir.join("00000003.seg"), vec![0u8; 100]).unwrap();
        // Junk in the directory is ignored.
        std::fs::write(dir.join("notes.txt"), b"hello").unwrap();
        assert_eq!(local_journal_state(tmp.path(), &run), (13, 2));
    }
}
