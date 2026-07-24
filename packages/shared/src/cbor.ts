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

import { Encoder, FLOAT32_OPTIONS, type Options } from 'cbor-x';
import { assertJsSafe } from './ids';

// `int64AsNumber` is implemented by cbor-x's decoder (decode.js) but omitted
// from its published `Options` type; declare it here so it is type-checked.
interface CborOptions extends Options {
  int64AsNumber?: boolean;
}

const codecOptions: CborOptions = {
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
  // Decode an 8-byte CBOR uint (major type 0, prefix 0x1b) as a JS `number`
  // rather than a `bigint`. ciborium emits this form for any `u64` >= 2^32, and
  // every wire `u64` is <= 2^53-1 (contracts §1), so the value is exact. Without
  // this, a large offset/epoch would decode to a `bigint` and silently break the
  // structural-equality comparisons the protocol relies on (e.g. epoch fencing).
  int64AsNumber: true,
};

const codec = new Encoder(codecOptions);

// 2^32: the boundary above which cbor-x's default number path emits a CBOR
// float64 (0xfb) instead of a major-type-0 integer.
const U32_CEILING = 0x1_0000_0000;

/**
 * Rewrite a value so every integer-valued `Number` encodes as a CBOR integer,
 * matching ciborium's shortest-form uint output.
 *
 * cbor-x encodes a positive integer >= 2^32 as a CBOR **float64** (major type 7)
 * — but ciborium (and contracts §1) requires a major-type-0 integer for every
 * `u64`. That drift made a journal offset or fencing epoch past 4 GiB undecodable
 * on the Rust side (protocol review PROTO-02). Handing cbor-x a `bigint` for such
 * values makes it emit a proper CBOR integer, byte-identical to ciborium.
 *
 * The value is first checked with {@link assertJsSafe}, so an out-of-contract
 * `u64` (> 2^53-1, i.e. not exactly representable) fails loudly here instead of
 * being silently rounded onto the wire.
 */
function toCborIntegers(value: unknown): unknown {
  if (typeof value === 'number') {
    if (Number.isInteger(value) && value >= U32_CEILING) {
      // Only positive integers reach this branch; a u64 field this large must be
      // JS-safe or it cannot round-trip. (i32/color fields never reach 2^32.)
      assertJsSafe(value, 'cbor u64 field');
      return BigInt(value);
    }
    return value;
  }
  if (value === null || typeof value !== 'object') return value;
  // Byte strings and other typed arrays / buffers pass through untouched.
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) return value;
  if (Array.isArray(value)) return value.map(toCborIntegers);
  // Rebuild the object in the SAME key order (insertion order) so the encoded
  // map keys stay byte-identical under `variableMapSize`.
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>)) {
    out[key] = toCborIntegers((value as Record<string, unknown>)[key]);
  }
  return out;
}

/** Encode a value to CBOR bytes (no length prefix). */
export function encodeCbor(value: unknown): Uint8Array {
  return codec.encode(toCborIntegers(value));
}

/** Decode a value from CBOR bytes (no length prefix). */
export function decodeCbor(bytes: Uint8Array): unknown {
  return codec.decode(bytes);
}
