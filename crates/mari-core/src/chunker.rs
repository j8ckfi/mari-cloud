//! Content-defined chunking (FastCDC).
//!
//! File content is split on boundaries chosen by the data itself, not by fixed
//! offsets. The payoff is delta stability: inserting a byte near the front of a
//! file shifts only the chunk that contains it, so a re-snapshot re-uploads one
//! chunk instead of the whole file. This is what makes forks and incremental
//! snapshots cheap (spec 9.1, 4.4).
//!
//! Parameters are configurable. Production defaults are 64 KiB min / 256 KiB
//! avg / 1 MiB max; tests drive tiny params for speed and to force many chunks.

use fastcdc::v2020::FastCDC;

/// Minimum chunk size FastCDC accepts (bytes).
pub const MIN_ALLOWED: u32 = 64;
/// Minimum average chunk size FastCDC accepts (bytes).
pub const AVG_MIN_ALLOWED: u32 = 256;
/// Minimum maximum-chunk-size FastCDC accepts (bytes).
pub const MAX_MIN_ALLOWED: u32 = 1024;

/// FastCDC size bounds. `min <= avg <= max`, each within the crate's absolute
/// limits (see [`ChunkerConfig::validate`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ChunkerConfig {
    /// Smallest chunk the cutter will emit (except a trailing short chunk).
    pub min: u32,
    /// Target average chunk size; sets the boundary probability.
    pub avg: u32,
    /// Hard cap on chunk size; a boundary is forced here.
    pub max: u32,
}

impl ChunkerConfig {
    /// Production defaults: 64 KiB / 256 KiB / 1 MiB.
    pub const PRODUCTION: ChunkerConfig = ChunkerConfig {
        min: 64 * 1024,
        avg: 256 * 1024,
        max: 1024 * 1024,
    };

    /// Validate the bounds, returning a message on violation. `FastCDC::new`
    /// would otherwise panic; we surface a clear error instead.
    pub fn validate(&self) -> std::result::Result<(), String> {
        if self.min < MIN_ALLOWED {
            return Err(format!("min {} < {}", self.min, MIN_ALLOWED));
        }
        if self.avg < AVG_MIN_ALLOWED {
            return Err(format!("avg {} < {}", self.avg, AVG_MIN_ALLOWED));
        }
        if self.max < MAX_MIN_ALLOWED {
            return Err(format!("max {} < {}", self.max, MAX_MIN_ALLOWED));
        }
        if !(self.min <= self.avg && self.avg <= self.max) {
            return Err(format!(
                "require min <= avg <= max, got {} {} {}",
                self.min, self.avg, self.max
            ));
        }
        Ok(())
    }
}

impl Default for ChunkerConfig {
    fn default() -> Self {
        ChunkerConfig::PRODUCTION
    }
}

/// A single cut: the byte range `[offset, offset + len)` within the input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cut {
    /// Start offset within the file.
    pub offset: usize,
    /// Length of this chunk in bytes.
    pub len: usize,
}

/// Cut `data` into content-defined chunks and return the boundaries in order.
///
/// The concatenation of `data[offset..offset+len]` over the returned cuts
/// equals `data`. Empty input yields no cuts (an empty file has zero chunks).
///
/// # Panics
/// Panics only if `cfg` is invalid; call [`ChunkerConfig::validate`] first to
/// avoid it (callers in this crate always do).
pub fn cut(data: &[u8], cfg: &ChunkerConfig) -> Vec<Cut> {
    if data.is_empty() {
        return Vec::new();
    }
    let chunker = FastCDC::new(data, cfg.min as usize, cfg.avg as usize, cfg.max as usize);
    chunker
        .map(|c| Cut {
            offset: c.offset,
            len: c.length,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_input_yields_no_cuts() {
        assert!(cut(&[], &ChunkerConfig::PRODUCTION).is_empty());
    }

    #[test]
    fn cuts_tile_the_input_exactly() {
        let cfg = ChunkerConfig {
            min: 64,
            avg: 256,
            max: 1024,
        };
        cfg.validate().unwrap();
        let data: Vec<u8> = (0..50_000u32)
            .map(|i| (i.wrapping_mul(2654435761) >> 13) as u8)
            .collect();
        let cuts = cut(&data, &cfg);
        assert!(cuts.len() > 1, "expected many chunks, got {}", cuts.len());
        // Contiguous, gap-free, covering the whole input.
        let mut pos = 0usize;
        for c in &cuts {
            assert_eq!(c.offset, pos, "cut offsets must be contiguous");
            assert!(c.len >= 1);
            pos += c.len;
        }
        assert_eq!(pos, data.len(), "cuts must cover the whole input");
    }

    #[test]
    fn production_config_is_valid() {
        ChunkerConfig::PRODUCTION.validate().unwrap();
    }
}
