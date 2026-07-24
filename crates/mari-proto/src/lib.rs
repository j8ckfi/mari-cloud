//! Wire protocol and storage-format types shared between `marid` and the
//! control plane.
//!
//! Every message that crosses the supervisor <-> control-plane WebSocket is
//! defined here and serialized as CBOR (via `ciborium`), then wrapped in a
//! 4-byte big-endian length prefix ([`frame`]). `packages/shared` mirrors these
//! types in TypeScript by hand; the conformance fixtures in `tests/fixtures.rs`
//! (written into `packages/shared/fixtures/`) keep the two sides from drifting
//! — the TS `vitest` suite decodes each fixture and asserts equality.
//!
//! ## Encoding rules
//!
//! - Structs serialize as CBOR maps with string keys (the Rust field names, in
//!   declaration order).
//! - The two message envelopes ([`SupervisorMessage`], [`ControlMessage`]) and
//!   data-carrying enums ([`ExitStatus`]) are **adjacently tagged**:
//!   `{ "t": <variant>, "c": <payload> }`, snake_case variant names, `c`
//!   omitted for payload-free variants.
//! - Simple field enums ([`ComputerState`], [`EntryKind`], [`SnapshotReason`],
//!   [`AttentionKind`]) serialize as bare snake_case text strings.
//! - `Option::None` is written as CBOR `null` (fields are never skipped), so
//!   the key set of every struct is fixed.
//! - Journal bytes are CBOR byte strings (`Uint8Array` on the TS side).
//! - All `u64` values must fit a JavaScript `Number` (< 2^53); [`Epoch`] and
//!   [`JournalOffset`] `debug_assert!` this on serialize. See
//!   [`ids::MAX_SAFE_INTEGER`].

pub mod frame;
pub mod ids;
pub mod manifest;
pub mod messages;

pub use frame::{
    Error, FrameReader, MAX_FRAME_LEN, decode_frame, encode_frame, from_cbor, to_cbor,
};
pub use ids::{ChunkId, ComputerId, Epoch, JournalOffset, MAX_SAFE_INTEGER, ManifestId, RunId};
pub use manifest::{
    ChunkRef, DiffSummary, EntryKind, HeatProfile, MANIFEST_VERSION, Manifest, ManifestEntry,
    SnapshotReason,
};
pub use messages::{
    AttentionKind, ComputerState, ControlMessage, ExitStatus, PROTO_VERSION, RunOffset,
    RunRollback, SupervisorMessage,
};
