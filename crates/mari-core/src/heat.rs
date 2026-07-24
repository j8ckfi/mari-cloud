//! Heat profile: the boot/run-start read order (spec §2, 4.6(d)).
//!
//! `marid` observes which files a computer reads early and feeds them, in order,
//! to a [`HeatRecorder`]. The resulting [`HeatProfile`] (defined in
//! `mari-proto`) persists at `heat/{computer}.cbor`; a cold wake replays it to
//! prefetch those chunks first, so the first shell prompt arrives in seconds
//! rather than after the whole delta transfers.
//!
//! Only the *first* read of a path is significant — repeats do not reorder the
//! profile — so the record is a stable first-seen order.

use std::collections::HashSet;

use mari_proto::{ComputerId, HeatProfile};

use crate::error::Result;
use crate::store::ChunkStore;

/// Accumulates paths in first-seen order, de-duplicating repeats.
#[derive(Debug, Default)]
pub struct HeatRecorder {
    order: Vec<String>,
    seen: HashSet<String>,
}

impl HeatRecorder {
    /// A fresh recorder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed a recorder from an existing profile so a later session extends the
    /// known order rather than starting blank.
    pub fn from_profile(profile: &HeatProfile) -> Self {
        let mut r = Self::new();
        for p in &profile.paths {
            r.record(p.clone());
        }
        r
    }

    /// Note that `path` was read. The first occurrence fixes its position; later
    /// occurrences are ignored. Returns `true` if this was the first sighting.
    pub fn record(&mut self, path: impl Into<String>) -> bool {
        let path = path.into();
        if self.seen.insert(path.clone()) {
            self.order.push(path);
            true
        } else {
            false
        }
    }

    /// Number of distinct paths recorded so far.
    pub fn len(&self) -> usize {
        self.order.len()
    }

    /// Whether nothing has been recorded.
    pub fn is_empty(&self) -> bool {
        self.order.is_empty()
    }

    /// Snapshot the current order as a [`HeatProfile`].
    pub fn profile(&self) -> HeatProfile {
        HeatProfile {
            paths: self.order.clone(),
        }
    }

    /// Consume the recorder into a [`HeatProfile`].
    pub fn into_profile(self) -> HeatProfile {
        HeatProfile { paths: self.order }
    }
}

/// Persist a heat profile for a computer at `heat/{computer}.cbor`.
pub async fn store_heat(
    store: &ChunkStore,
    computer: &ComputerId,
    profile: &HeatProfile,
) -> Result<()> {
    store.put_heat(computer.as_str(), profile).await
}

/// Load a computer's heat profile, or `None` if it has none yet.
pub async fn load_heat(store: &ChunkStore, computer: &ComputerId) -> Result<Option<HeatProfile>> {
    store.get_heat(computer.as_str()).await
}
