//! A run's journal: the record of its terminal bytes (spec §2, 4.2).
//!
//! The supervisor owns the journal, not any network connection (spec 5.1). As
//! PTY output arrives it is appended here, assigned a monotonic byte offset, and
//! made available for streaming to the control plane. Finished fixed-size
//! segments are written to local segment files AND uploaded to the chunk store
//! at `journal/{computer}/{run}/{seq}.seg` (contracts §9); the control-plane
//! journal is the truth, the on-disk/in-memory copy is a cache (spec 4.2).
//!
//! Streaming is a **pull** off this buffer: a connection tracks how far it has
//! sent, and after a reconnect it resets that mark to the control plane's
//! last-acked offset and re-reads from here — so a resume produces no gap and no
//! duplicate bytes regardless of what the previous connection had sent.
//!
//! v0 keeps the full journal in memory as the streaming/resume cache; segment
//! files provide the durable local + store copies. A file-backed tail replaces
//! the in-memory buffer when journals outgrow memory; the offset contract is the
//! same.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use mari_core::ChunkStore;
use mari_proto::{ComputerId, RunId};

/// The default segment size for a live run: 4 MiB.
pub const DEFAULT_SEGMENT_BYTES: usize = 4 * 1024 * 1024;

/// Maximum bytes carried in a single [`mari_proto::SupervisorMessage::JournalFrame`].
/// Bounds frame size well under `MAX_FRAME_LEN` and keeps streaming responsive.
pub const FRAME_CHUNK: usize = 64 * 1024;

/// One run's append-only journal with segment upload and offset-addressed reads.
pub struct Journal {
    run: RunId,
    computer: ComputerId,
    store: ChunkStore,
    local_dir: PathBuf,
    segment_size: usize,
    /// Offset of the first byte this instance holds. Non-zero for a **resumed**
    /// run (spec 5.6): the run's earlier life already produced bytes
    /// `[0, base)`, so the continuation must take offsets from `base` on rather
    /// than restarting at 0 and colliding with what the control plane holds.
    base: u64,
    inner: Mutex<Inner>,
    /// Serializes segment flushing so the reserve/upload/commit sequence never
    /// interleaves with another flush of the same journal.
    flush_lock: tokio::sync::Mutex<()>,
}

struct Inner {
    /// Bytes this instance produced; index 0 is journal offset `base`.
    buf: Vec<u8>,
    /// Absolute offset up to which segments have been written.
    uploaded_up_to: u64,
    next_seq: u64,
    finished: bool,
}

impl Journal {
    /// Create a journal for `run`, writing local segment files under
    /// `local_root/{run}` and uploading to the store keyed by `computer`/`run`.
    pub fn new(
        run: RunId,
        computer: ComputerId,
        store: ChunkStore,
        local_root: impl AsRef<Path>,
        segment_size: usize,
    ) -> std::io::Result<Self> {
        Self::resumed(run, computer, store, local_root, segment_size, 0, 0)
    }

    /// Create a journal that **continues** an earlier life of the same run
    /// (spec 5.6): new bytes take offsets from `base_offset`, and new segments
    /// take ordinals from `next_seq` so they cannot overwrite the segments the
    /// earlier life wrote.
    ///
    /// `base_offset` is the highest journal end any surviving copy attests to.
    /// When the control plane durably held bytes the earlier life never managed
    /// to flush into a segment, the base is above the end of the stored segment
    /// chain, and that chain reconstructs the run's journal with those bytes
    /// missing — they exist only at the control plane, which is where the
    /// journal's truth lives anyway (spec 4.2). The offsets stay correct either
    /// way, which is what the stream contract depends on.
    pub fn resumed(
        run: RunId,
        computer: ComputerId,
        store: ChunkStore,
        local_root: impl AsRef<Path>,
        segment_size: usize,
        base_offset: u64,
        next_seq: u64,
    ) -> std::io::Result<Self> {
        let local_dir = local_root.as_ref().join(run.as_str());
        std::fs::create_dir_all(&local_dir)?;
        Ok(Self {
            run,
            computer,
            store,
            local_dir,
            segment_size: segment_size.max(1),
            base: base_offset,
            inner: Mutex::new(Inner {
                buf: Vec::new(),
                uploaded_up_to: base_offset,
                next_seq,
                finished: false,
            }),
            flush_lock: tokio::sync::Mutex::new(()),
        })
    }

    /// The offset of the first byte this instance holds (0 for a fresh run).
    /// The streamer never asks for anything below it: those bytes belong to the
    /// run's earlier life and are already at the control plane / in the store.
    pub fn base_offset(&self) -> u64 {
        self.base
    }

    /// The run this journal belongs to.
    pub fn run(&self) -> &RunId {
        &self.run
    }

    /// Append raw output bytes; they take the next contiguous offsets.
    pub fn append(&self, data: &[u8]) {
        if data.is_empty() {
            return;
        }
        let mut g = self.inner.lock().unwrap();
        g.buf.extend_from_slice(data);
    }

    /// The journal's end offset: the offset the next appended byte will take.
    pub fn len(&self) -> u64 {
        self.base + self.inner.lock().unwrap().buf.len() as u64
    }

    /// Whether this instance holds no bytes.
    pub fn is_empty(&self) -> bool {
        self.len() == self.base
    }

    /// Read up to `max` bytes starting at byte offset `from`. Returns an empty
    /// vec when `from` is at or past the end, and also when `from` is **below**
    /// [`Journal::base_offset`] — those bytes belong to the run's earlier life
    /// and this instance does not hold them. Used by the streamer to build the
    /// next [`mari_proto::SupervisorMessage::JournalFrame`] and by resume to
    /// re-read from the acked offset.
    pub fn read_from(&self, from: u64, max: usize) -> Vec<u8> {
        if from < self.base {
            return Vec::new();
        }
        let g = self.inner.lock().unwrap();
        let len = self.base + g.buf.len() as u64;
        if from >= len {
            return Vec::new();
        }
        let start = (from - self.base) as usize;
        let end = (start + max).min(g.buf.len());
        g.buf[start..end].to_vec()
    }

    /// Bytes durably written to store segments so far (an absolute offset).
    pub fn uploaded_len(&self) -> u64 {
        self.inner.lock().unwrap().uploaded_up_to
    }

    /// Every byte this instance produced, i.e. the journal from
    /// [`Journal::base_offset`] to the end (test/assertion helper).
    pub fn snapshot_bytes(&self) -> Vec<u8> {
        self.inner.lock().unwrap().buf.clone()
    }

    /// Mark the journal complete: the final (partial) segment may now be
    /// flushed even though it is smaller than the segment size.
    pub fn finish(&self) {
        self.inner.lock().unwrap().finished = true;
    }

    /// The store key for segment `seq` of this run (contracts §9).
    pub fn segment_key(computer: &ComputerId, run: &RunId, seq: u64) -> String {
        format!("journal/{computer}/{run}/{seq:08}.seg")
    }

    /// Flush every segment that is ready: while the tail beyond `uploaded_up_to`
    /// is at least one segment (or the journal is finished and any tail
    /// remains), write it to a local `.seg` file and upload it to the store.
    /// Idempotent and safe to call repeatedly.
    pub async fn flush_ready_segments(&self) -> anyhow::Result<()> {
        let _flush = self.flush_lock.lock().await;
        loop {
            // Reserve the next segment under the data lock without holding it
            // across the await.
            let job = {
                let g = self.inner.lock().unwrap();
                let len = self.base + g.buf.len() as u64;
                let start = g.uploaded_up_to;
                let avail = len - start;
                // Index into `buf`, whose element 0 is journal offset `base`.
                let at = (start - self.base) as usize;
                if avail == 0 {
                    None
                } else if avail >= self.segment_size as u64 {
                    let take = self.segment_size;
                    Some((g.next_seq, start, g.buf[at..at + take].to_vec()))
                } else if g.finished {
                    let take = avail as usize;
                    Some((g.next_seq, start, g.buf[at..at + take].to_vec()))
                } else {
                    None
                }
            };

            let (seq, start, bytes) = match job {
                Some(j) => j,
                None => break,
            };

            let local_path = self.local_dir.join(format!("{seq:08}.seg"));
            tokio::fs::write(&local_path, &bytes).await.map_err(|e| {
                anyhow::anyhow!(
                    "writing local journal segment {}: {e}",
                    local_path.display()
                )
            })?;

            let key = Self::segment_key(&self.computer, &self.run, seq);
            self.store
                .operator()
                .write(&key, bytes.clone())
                .await
                .map_err(|e| anyhow::anyhow!("uploading journal segment {key}: {e}"))?;

            // Commit the reservation.
            let mut g = self.inner.lock().unwrap();
            if g.uploaded_up_to == start {
                g.uploaded_up_to = start + bytes.len() as u64;
                g.next_seq = seq + 1;
            }
        }
        Ok(())
    }

    /// The next free segment ordinal — equal to the number of segments this run
    /// has ever produced, including those written by an earlier life of a
    /// resumed run (test helper and durable-record source).
    pub fn segments_uploaded(&self) -> u64 {
        self.inner.lock().unwrap().next_seq
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mari_core::ChunkStore;

    fn store(dir: &std::path::Path) -> ChunkStore {
        ChunkStore::open_fs(dir.join("store")).unwrap()
    }

    #[tokio::test]
    async fn offsets_are_monotonic_and_reads_are_offset_addressed() {
        let tmp = tempfile::tempdir().unwrap();
        let j = Journal::new(
            RunId::new("run-a"),
            ComputerId::new("comp-1"),
            store(tmp.path()),
            tmp.path().join("journal"),
            8,
        )
        .unwrap();

        assert_eq!(j.len(), 0);
        j.append(b"hello ");
        j.append(b"world");
        assert_eq!(j.len(), 11);
        assert_eq!(j.read_from(0, 100), b"hello world");
        assert_eq!(j.read_from(6, 100), b"world");
        assert_eq!(j.read_from(11, 100), b"");
        // Bounded read returns at most `max` bytes from `from`.
        assert_eq!(j.read_from(0, 5), b"hello");
    }

    /// A resumed run's journal continues the offsets and the segment ordinals of
    /// its earlier life (spec 5.6): new bytes must never be handed out at
    /// offsets the control plane already holds, and a new segment must never
    /// overwrite one already in the store.
    #[tokio::test]
    async fn resumed_journal_continues_offsets_and_segment_ordinals() {
        let tmp = tempfile::tempdir().unwrap();
        let st = store(tmp.path());
        let computer = ComputerId::new("comp-resume");
        let run = RunId::new("run-resume");
        // The earlier life wrote 2 segments of 8 bytes = 16 bytes.
        let j = Journal::resumed(
            run.clone(),
            computer.clone(),
            st.clone(),
            tmp.path().join("journal"),
            8,
            16,
            2,
        )
        .unwrap();

        assert_eq!(j.base_offset(), 16);
        assert_eq!(j.len(), 16, "an empty resumed journal ends at its base");
        assert!(j.is_empty());
        // Nothing below the base is served: those bytes are the earlier life's.
        assert_eq!(j.read_from(0, 100), b"");
        assert_eq!(j.read_from(15, 100), b"");

        j.append(b"CONTINUED");
        assert_eq!(j.len(), 25);
        assert_eq!(j.read_from(16, 100), b"CONTINUED");
        // offset 16 is 'C'; offset 20 is the 5th byte of "CONTINUED".
        assert_eq!(j.read_from(20, 100), b"INUED");
        assert_eq!(j.read_from(25, 100), b"");

        j.finish();
        j.flush_ready_segments().await.unwrap();
        // 9 bytes at a segment size of 8: a full segment at ordinal 2 and the
        // 1-byte tail at ordinal 3 — the ordinals continue where the earlier
        // life stopped, so segments 0 and 1 are never overwritten.
        assert_eq!(j.segments_uploaded(), 4);
        assert_eq!(j.uploaded_len(), 25);
        assert_eq!(
            st.operator()
                .read(&Journal::segment_key(&computer, &run, 2))
                .await
                .unwrap()
                .to_vec(),
            b"CONTINUE"
        );
        assert_eq!(
            st.operator()
                .read(&Journal::segment_key(&computer, &run, 3))
                .await
                .unwrap()
                .to_vec(),
            b"D"
        );
        assert!(
            st.operator()
                .read(&Journal::segment_key(&computer, &run, 0))
                .await
                .is_err(),
            "the resumed journal must not have written over ordinal 0"
        );
    }

    #[tokio::test]
    async fn segments_roll_at_size_and_upload_reassembles_to_journal() {
        let tmp = tempfile::tempdir().unwrap();
        let st = store(tmp.path());
        let computer = ComputerId::new("comp-seg");
        let run = RunId::new("run-seg");
        let j = Journal::new(
            run.clone(),
            computer.clone(),
            st.clone(),
            tmp.path().join("journal"),
            8, // tiny segments to force multiple rolls
        )
        .unwrap();

        // 20 bytes -> two full 8-byte segments while running, 4 bytes tail.
        let data: Vec<u8> = (0u8..20).map(|i| b'A' + (i % 26)).collect();
        j.append(&data);
        j.flush_ready_segments().await.unwrap();
        // Two full segments so far; the 4-byte tail is not yet flushed.
        assert_eq!(j.segments_uploaded(), 2);

        // Finish -> the partial final segment flushes.
        j.finish();
        j.flush_ready_segments().await.unwrap();
        assert_eq!(j.segments_uploaded(), 3);

        // Reassemble the stored segments in order; must equal the journal.
        let mut reassembled = Vec::new();
        for seq in 0..j.segments_uploaded() {
            let key = Journal::segment_key(&computer, &run, seq);
            let bytes = st.operator().read(&key).await.unwrap().to_vec();
            reassembled.extend_from_slice(&bytes);
        }
        assert_eq!(reassembled, data);

        // And the local segment files exist too.
        for seq in 0..j.segments_uploaded() {
            let p = tmp
                .path()
                .join("journal")
                .join(run.as_str())
                .join(format!("{seq:08}.seg"));
            assert!(p.exists(), "missing local segment {}", p.display());
        }
    }
}
