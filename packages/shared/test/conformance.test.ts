// Cross-language conformance: for every fixture the Rust side wrote, decode the
// CBOR here and deep-equal it against the canonical JSON, then re-encode and
// byte-compare. If Rust and TypeScript ever drift, this suite fails.

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { decodeCbor, encodeCbor } from '../src/cbor';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, '..', 'fixtures');

/** Recursively convert byte strings to number arrays so a decoded value can be
 * deep-compared against JSON (where bytes are arrays of numbers). */
function normalize(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) {
    return Array.from(value as unknown as Uint8Array);
  }
  if (Array.isArray(value)) return value.map(normalize);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = normalize(v);
  }
  return out;
}

const names = readdirSync(fixturesDir)
  .filter((f) => f.endsWith('.cbor'))
  .map((f) => f.slice(0, -'.cbor'.length))
  .sort();

function readCbor(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir, `${name}.cbor`)));
}
function readExpected(name: string): unknown {
  return JSON.parse(readFileSync(join(fixturesDir, `${name}.expected.json`), 'utf8'));
}

describe('conformance fixtures', () => {
  it('there is a fixture set to check', () => {
    // The Rust generator emits 19 exemplars; guard against an empty run.
    expect(names.length).toBeGreaterThanOrEqual(19);
  });

  it('every .cbor has a matching .expected.json', () => {
    const json = new Set(
      readdirSync(fixturesDir)
        .filter((f) => f.endsWith('.expected.json'))
        .map((f) => f.slice(0, -'.expected.json'.length)),
    );
    for (const name of names) expect(json.has(name)).toBe(true);
  });

  for (const name of names) {
    describe(name, () => {
      it('decodes and deep-equals the canonical JSON', () => {
        expect(normalize(decodeCbor(readCbor(name)))).toEqual(readExpected(name));
      });

      it('re-encodes byte-identically to the Rust CBOR', () => {
        const original = readCbor(name);
        const reencoded = encodeCbor(decodeCbor(original));
        expect(Array.from(reencoded)).toEqual(Array.from(original));
      });
    });
  }
});

describe('byte-string fidelity', () => {
  it('journal bytes decode to a Uint8Array with the exact bytes', () => {
    const decoded = decodeCbor(readCbor('sup_journal_frame')) as {
      t: string;
      c: { bytes: Uint8Array };
    };
    expect(decoded.t).toBe('journal_frame');
    expect(ArrayBuffer.isView(decoded.c.bytes)).toBe(true);
    // "hello \x1b[32mworld\x1b[0m\n"
    expect(Array.from(decoded.c.bytes)).toEqual([
      104, 101, 108, 108, 111, 32, 27, 91, 51, 50, 109, 119, 111, 114, 108, 100, 27, 91, 48, 109,
      10,
    ]);
  });
});
