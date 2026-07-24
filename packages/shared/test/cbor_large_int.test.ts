// Regression teeth for protocol review PROTO-02: cbor-x used to encode any
// integer-valued Number >= 2^32 as a CBOR float64 (0xfb), which ciborium (marid)
// refuses to decode into a u64 — so a journal offset / fencing epoch past 4 GiB
// tore down the supervisor session. `encodeCbor` now emits a shortest-form CBOR
// integer for these values, byte-identical to ciborium, and rejects values that
// exceed the JS safe-integer ceiling instead of silently rounding them.

import { describe, it, expect } from 'vitest';
import { encodeCbor, decodeCbor } from '../src/cbor';
import { MAX_SAFE_INTEGER } from '../src/ids';
import type { ControlMessage } from '../src/messages';

const FLOAT64_TAG = 0xfb;

function has(bytes: Uint8Array, byte: number): boolean {
  return bytes.includes(byte);
}

describe('PROTO-02: large u64 fields encode as CBOR integers, not float64', () => {
  it('encodes a journal_ack offset at exactly 2^32 as a major-type-0 integer', () => {
    const msg: ControlMessage = { t: 'journal_ack', c: { run: 'r', offset: 4_294_967_296 } };
    const bytes = encodeCbor(msg);
    // 0x1b = 8-byte uint header; no 0xfb float marker anywhere.
    expect(has(bytes, 0x1b)).toBe(true);
    expect(has(bytes, FLOAT64_TAG)).toBe(false);
    // The exact 8-byte big-endian encoding of 2^32.
    expect([...bytes].slice(-9)).toEqual([0x1b, 0, 0, 0, 1, 0, 0, 0, 0]);
  });

  it('round-trips offsets across the 2^32..2^53-1 range as exact numbers', () => {
    for (const offset of [4_294_967_296, 5_000_000_000, MAX_SAFE_INTEGER]) {
      const encoded = encodeCbor({ t: 'journal_ack', c: { run: 'r', offset } });
      expect(has(encoded, FLOAT64_TAG)).toBe(false);
      const decoded = decodeCbor(encoded) as { c: { offset: number } };
      expect(typeof decoded.c.offset).toBe('number');
      expect(decoded.c.offset).toBe(offset);
    }
  });

  it('encodes a hello_ack with a 2^53-1 offset and re-encodes it identically', () => {
    const msg: ControlMessage = {
      t: 'hello_ack',
      c: { acked: [{ run: 'r', offset: MAX_SAFE_INTEGER }] },
    };
    const once = encodeCbor(msg);
    const twice = encodeCbor(decodeCbor(once));
    expect([...twice]).toEqual([...once]);
    expect(has(once, FLOAT64_TAG)).toBe(false);
  });

  it('rejects an integer beyond the JS safe range instead of rounding it onto the wire', () => {
    // 2^53 is not exactly representable; encoding it would silently corrupt the
    // offset. The guard must throw loudly.
    expect(() => encodeCbor({ t: 'journal_ack', c: { run: 'r', offset: 2 ** 53 } })).toThrow(
      RangeError,
    );
  });

  it('leaves small integers and negative color fields untouched', () => {
    // Sub-2^32 integers keep their compact encoding; negatives (e.g. a default
    // color -1 in the attach grid) are unaffected by the large-int rewrite.
    expect([...encodeCbor(1024)]).toEqual([0x19, 0x04, 0x00]);
    expect([...encodeCbor(-1)]).toEqual([0x20]);
    expect(decodeCbor(encodeCbor({ fg: -1, offset: 300 }))).toEqual({ fg: -1, offset: 300 });
  });
});
