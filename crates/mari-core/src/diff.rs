//! Diff two manifests (spec 5.3, 9.2).
//!
//! A run's result, and a fork's difference view, are both functions of the
//! manifest alone — no filesystem access. Comparison is by path (both manifests
//! are path-sorted). A changed entry is classified so a mode-only change (chmod)
//! is distinguishable from a content change: the fork-diff must be able to show
//! "permissions changed" without claiming the bytes moved.

use mari_proto::{DiffSummary, ManifestEntry};

use mari_proto::Manifest;

/// One entry present in both manifests but changed.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ModifiedEntry {
    /// The shared path.
    pub path: String,
    /// The entry as it was in `a`.
    pub before: ManifestEntry,
    /// The entry as it is in `b`.
    pub after: ManifestEntry,
    /// The content changed: kind, size, chunk list, or symlink target differ.
    pub content_changed: bool,
    /// The mode (permission/type bits) changed.
    pub mode_changed: bool,
}

/// The full diff between two manifests, with per-entry detail.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ManifestDiff {
    /// Entries in `b` but not `a`.
    pub added: Vec<ManifestEntry>,
    /// Entries in `a` but not `b`.
    pub removed: Vec<ManifestEntry>,
    /// Entries in both, changed.
    pub modified: Vec<ModifiedEntry>,
}

impl ManifestDiff {
    /// The counts, as the wire [`DiffSummary`] (spec 5.3).
    pub fn summary(&self) -> DiffSummary {
        DiffSummary {
            added: self.added.len() as u32,
            modified: self.modified.len() as u32,
            removed: self.removed.len() as u32,
        }
    }

    /// True when the two manifests describe the same tree.
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.modified.is_empty()
    }
}

/// Does the *content* (as opposed to just permissions) of two entries at the
/// same path differ? Symlink target and the ordered chunk list both count as
/// content.
fn content_differs(a: &ManifestEntry, b: &ManifestEntry) -> bool {
    a.kind != b.kind
        || a.size != b.size
        || a.symlink_target != b.symlink_target
        || a.chunks != b.chunks
}

/// Diff manifest `a` (before) against `b` (after). Both entry lists are assumed
/// path-sorted (snapshots always are); the walk is a linear merge by path.
pub fn diff(a: &Manifest, b: &Manifest) -> ManifestDiff {
    let mut out = ManifestDiff::default();
    let (av, bv) = (&a.entries, &b.entries);
    let (mut i, mut j) = (0usize, 0usize);
    while i < av.len() && j < bv.len() {
        let (ea, eb) = (&av[i], &bv[j]);
        match ea.path.cmp(&eb.path) {
            std::cmp::Ordering::Less => {
                out.removed.push(ea.clone());
                i += 1;
            }
            std::cmp::Ordering::Greater => {
                out.added.push(eb.clone());
                j += 1;
            }
            std::cmp::Ordering::Equal => {
                let content_changed = content_differs(ea, eb);
                let mode_changed = ea.mode != eb.mode;
                if content_changed || mode_changed {
                    out.modified.push(ModifiedEntry {
                        path: ea.path.clone(),
                        before: ea.clone(),
                        after: eb.clone(),
                        content_changed,
                        mode_changed,
                    });
                }
                i += 1;
                j += 1;
            }
        }
    }
    while i < av.len() {
        out.removed.push(av[i].clone());
        i += 1;
    }
    while j < bv.len() {
        out.added.push(bv[j].clone());
        j += 1;
    }
    out
}
