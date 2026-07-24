// CBOR codec configured to match `ciborium` output byte-for-byte.
//
// ciborium encodes: structs as definite-length maps with text-string keys in
// field-declaration order, integers in shortest form, `Vec<u8>` (via
// serde_bytes) as CBOR byte strings, `Option::None` as `null`. cbor-x must
// therefore avoid its record/structure extension and its typed-array tags, and
// must decode maps to plain objects.
//
// This codec is used by both `marid`-facing protocol code and manifest reads;
// it is browser- and Workers-safe (cbor-x ships pure-JS fallbacks).

import { Encoder, FLOAT32_OPTIONS } from 'cbor-x';

const codec = new Encoder({
  // Emit standard CBOR maps, not cbor-x's record/shared-structure extension,
  // which ciborium cannot read.
  useRecords: false,
  // Decode CBOR maps to plain objects (not JS `Map`s).
  mapsAsObjects: true,
  // Encode `Uint8Array` as a plain CBOR byte string (major type 2), not a
  // typed-array tag, matching serde_bytes.
  tagUint8Array: false,
  // Never emit float32; we carry only integers, but keep floats deterministic.
  useFloat32: FLOAT32_OPTIONS.NEVER,
  // Keys are written in object insertion order (= decode order), not sorted, so
  // a decoded-then-re-encoded value reproduces ciborium's field order.
  variableMapSize: true,
});

/** Encode a value to CBOR bytes (no length prefix). */
export function encodeCbor(value: unknown): Uint8Array {
  return codec.encode(value);
}

/** Decode a value from CBOR bytes (no length prefix). */
export function decodeCbor(bytes: Uint8Array): unknown {
  return codec.decode(bytes);
}
