// Identifier types mirroring `crates/mari-proto::ids`.
//
// String ids are opaque handles; `ManifestId` / `ChunkId` are blake3 hex.
// `Epoch` / `JournalOffset` are `u64` counters on the Rust side but MUST stay
// below the JS safe-integer ceiling so they decode here as `number`, not
// `bigint`. The Rust `Serialize` impls debug-assert this; `assertJsSafe`
// enforces it on the values this package produces.

export type ComputerId = string;
export type RunId = string;
/** blake3 hex digest of a manifest's canonical CBOR. */
export type ManifestId = string;
/** blake3 hex digest of a chunk's bytes. */
export type ChunkId = string;
/** Fencing token; `u64` on the wire, always < 2^53. */
export type Epoch = number;
/** Byte offset into a run's journal; `u64` on the wire, always < 2^53. */
export type JournalOffset = number;

/** Largest integer a JS `Number` represents exactly (`2^53 - 1`). */
export const MAX_SAFE_INTEGER = 9_007_199_254_740_991;

/** Protocol version advertised in `Hello`. Matches `mari_proto::PROTO_VERSION`. */
export const PROTO_VERSION = 1;

/** Current manifest schema version. Matches `mari_proto::MANIFEST_VERSION`. */
export const MANIFEST_VERSION = 1;

/**
 * Throw if `value` is not a non-negative integer representable exactly by a JS
 * `Number`. Use before encoding any `u64`-typed field so an out-of-range value
 * fails loudly here instead of silently truncating a peer's `BigInt`.
 */
export function assertJsSafe(value: number, label: string): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_SAFE_INTEGER) {
    throw new RangeError(
      `${label} must be a non-negative integer <= 2^53-1, got ${value}`,
    );
  }
}
