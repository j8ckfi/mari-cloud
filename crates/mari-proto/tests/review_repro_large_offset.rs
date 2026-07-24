//! Regression guard (was review repro PROTO-02): u64 fields >= 2^32.
//!
//! The contract (`docs/contracts.md` §1) allows every wire `u64` to range up to
//! `2^53 - 1` and requires shortest-form *integer* encoding so both sides stay
//! on `u64` / `number`. `ciborium` (marid) always emits a major-type-0 uint. The
//! TypeScript codec (`cbor-x`) once silently switched to a CBOR **float64**
//! (major type 7, prefix `0xfb`) for ANY integer-valued JS number `>= 2^32`, so a
//! run whose journal head crossed 4 GiB produced `journal_ack` / `hello_ack`
//! offsets marid could not decode — its read loop errored and the session tore
//! down. `packages/shared/src/cbor.ts` now emits a CBOR integer for these values
//! (matched by the `*_large` conformance fixtures).
//!
//! This test pins the two Rust-side invariants that fix relies on: ciborium
//! encodes a `>= 2^32` offset as a shortest-form uint, and marid rejects (loudly,
//! never silently coerces) a float64-encoded offset — defense in depth against a
//! future TS encoder regression.

use mari_proto::{ControlMessage, JournalOffset, RunId};

/// The bytes `cbor-x` used to produce for
/// `{ t:'journal_ack', c:{ run:'run-0001', offset: 4294967296 } }` — a `0xfb`
/// float64 in place of the offset. Kept as a fixed adversarial input.
const CBORX_FLOAT_ENCODED_OFFSET: &[u8] = &[
    0xa2, 0x61, 0x74, 0x6b, 0x6a, 0x6f, 0x75, 0x72, 0x6e, 0x61, 0x6c, 0x5f, 0x61, 0x63, 0x6b, 0x61,
    0x63, 0xa2, 0x63, 0x72, 0x75, 0x6e, 0x68, 0x72, 0x75, 0x6e, 0x2d, 0x30, 0x30, 0x30, 0x31, 0x66,
    0x6f, 0x66, 0x66, 0x73, 0x65, 0x74, 0xfb, 0x41, 0xf0, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
];

#[test]
fn ciborium_encodes_a_large_offset_as_a_shortest_form_uint() {
    // 2^32 does not fit a u32, so ciborium uses the 8-byte uint form (0x1b) and
    // never a float (0xfb). This is exactly what cbor-x must now match.
    let bytes = mari_proto::to_cbor(&ControlMessage::JournalAck {
        run: RunId::new("run-0001"),
        offset: JournalOffset::new(4_294_967_296),
    })
    .unwrap();
    assert!(
        bytes.windows(1).any(|w| w == [0x1b]),
        "offset >= 2^32 must be an 8-byte uint (0x1b)"
    );
    assert!(
        !bytes.contains(&0xfb),
        "an offset must never be encoded as a CBOR float64 (0xfb)"
    );

    // And it round-trips back to the same value.
    let decoded = mari_proto::from_cbor::<ControlMessage>(&bytes).unwrap();
    assert!(matches!(
        decoded,
        ControlMessage::JournalAck { offset, .. } if offset == JournalOffset::new(4_294_967_296)
    ));
}

#[test]
fn marid_rejects_a_float_encoded_offset_rather_than_coercing_it() {
    // If a float64 offset ever reached marid, ciborium refuses to coerce it into
    // a u64: the decode fails loudly instead of silently truncating the offset.
    let decoded = mari_proto::from_cbor::<ControlMessage>(CBORX_FLOAT_ENCODED_OFFSET);
    assert!(
        decoded.is_err(),
        "a float64-encoded offset must be rejected, got: {decoded:?}"
    );
}
