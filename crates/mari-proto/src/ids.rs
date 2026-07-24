//! Identifier newtypes.
//!
//! String ids are opaque handles. `ManifestId` and `ChunkId` are the blake3
//! hex digest of the value / bytes they name; `mari-core` computes them.
//! `Epoch` and `JournalOffset` are `u64` counters that MUST stay below the
//! JavaScript safe-integer ceiling (2^53 - 1) so the TypeScript mirror decodes
//! them as plain `Number`s rather than `BigInt`s. Their `Serialize`
//! implementations `debug_assert!` that invariant.

use serde::{Deserialize, Deserializer, Serialize, Serializer};

/// Largest integer a JavaScript `Number` can represent exactly (`2^53 - 1`).
///
/// Every `u64` that crosses the wire or lands in a stored manifest must be
/// `<= MAX_SAFE_INTEGER`; the TypeScript side decodes CBOR integers above this
/// as `BigInt`, which would silently break structural equality with the Rust
/// side.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991; // 2^53 - 1

macro_rules! string_id {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Clone, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
        #[serde(transparent)]
        pub struct $name(pub String);

        impl $name {
            /// Wrap an owned or borrowed string as this id.
            pub fn new(value: impl Into<String>) -> Self {
                Self(value.into())
            }

            /// Borrow the underlying string.
            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(&self.0)
            }
        }

        impl From<String> for $name {
            fn from(value: String) -> Self {
                Self(value)
            }
        }

        impl From<&str> for $name {
            fn from(value: &str) -> Self {
                Self(value.to_owned())
            }
        }
    };
}

string_id!(
    ComputerId,
    "Stable identity of a computer (spec §2). Opaque; not a substrate address."
);
string_id!(RunId, "Identity of a single run (spec §5).");
string_id!(
    ManifestId,
    "blake3 hex digest of a manifest's canonical CBOR encoding."
);
string_id!(ChunkId, "blake3 hex digest of a chunk's bytes.");

macro_rules! u64_counter {
    ($name:ident, $doc:literal) => {
        #[doc = $doc]
        #[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Hash, PartialOrd, Ord)]
        pub struct $name(pub u64);

        impl $name {
            /// Construct from a raw `u64`.
            pub const fn new(value: u64) -> Self {
                Self(value)
            }

            /// The raw `u64`.
            pub const fn get(self) -> u64 {
                self.0
            }

            /// The next value (`self + 1`).
            pub const fn next(self) -> Self {
                Self(self.0 + 1)
            }

            /// True when the value is representable exactly by a JS `Number`.
            pub const fn is_js_safe(self) -> bool {
                self.0 <= MAX_SAFE_INTEGER
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl From<u64> for $name {
            fn from(value: u64) -> Self {
                Self(value)
            }
        }

        impl Serialize for $name {
            fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
                debug_assert!(
                    self.0 <= MAX_SAFE_INTEGER,
                    concat!(
                        stringify!($name),
                        " {} exceeds the JS safe-integer ceiling 2^53-1; wire \
                         and manifest u64 values must fit a JavaScript Number"
                    ),
                    self.0
                );
                serializer.serialize_u64(self.0)
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
                Ok(Self(u64::deserialize(deserializer)?))
            }
        }
    };
}

u64_counter!(
    Epoch,
    "Fencing token minted by the Durable Object at each wake (decisions.md). \
     Monotonic; a manifest-head advance carrying a stale epoch is rejected."
);
u64_counter!(
    JournalOffset,
    "Byte offset into a run's journal stream. Acked by the control plane and \
     used to resume streaming after a reconnect."
);
