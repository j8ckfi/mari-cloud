// The two arithmetic facts a file write and a run's working directory depend on,
// asserted directly rather than through a route (src/runs.ts).
//
// Both were shipped wrong, and both failures were SILENT:
//
//  1. The write payload travelled as ONE argv element. Linux caps a single
//     `execve` argument at `MAX_ARG_STRLEN` = 32 pages = 131072 bytes including
//     its NUL, so every write above 96 KiB of raw bytes failed at spawn while the
//     HTTP route answered `202 {ok:true, bytes:N}`.
//  2. A run's default working directory was `/` — the CONTAINER's root, outside
//     the computer's only snapshotted tree (`MARI_ROOT`). Files a run wrote there
//     were absent from every manifest and gone at deep sleep.
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CWD,
  MAX_ARGV_ELEMENT_BYTES,
  MAX_ARGV_TOTAL_BYTES,
  MAX_WRITE_BYTES,
  resolveRunCwd,
  splitPayload,
  writeArgvBytes,
  writeRunArgv,
} from '../src/runs';
import { MAX_INLINE_FILE_BYTES } from '../src/manifest-store';
import { toBase64, fromBase64 } from '../src/bytes';

/** Linux `MAX_ARG_STRLEN`: the ceiling on ONE argv string, NUL included. */
const MAX_ARG_STRLEN = 131072;

function bytes(n: number, seed = 7): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * seed + (i >> 7)) & 0xff;
  return out;
}

describe('write argv (spec 8.5 save/upload, spec 4.1 the supervisor applies it)', () => {
  it('keeps every element under the kernel ceiling at the largest accepted write', () => {
    const payload = bytes(MAX_WRITE_BYTES);
    const argv = writeRunArgv('/notes/big.bin', toBase64(payload), 'run1');
    for (const a of argv) {
      expect(a.length).toBeLessThanOrEqual(MAX_ARGV_ELEMENT_BYTES);
      // The property that actually matters, stated against the kernel's number
      // and not against our own constant.
      expect(a.length + 1).toBeLessThan(MAX_ARG_STRLEN);
    }
    // ...and the whole argument block still fits the total budget (Linux
    // RLIMIT_STACK/4 = 2 MiB by default, environment included).
    expect(writeArgvBytes(argv)).toBeLessThan(MAX_ARGV_TOTAL_BYTES);
  });

  it('reassembles byte-identically for the sizes that used to be lost', () => {
    // 96 KiB is the exact reported cliff: base64 is 131072 chars, one byte over
    // MAX_ARG_STRLEN with its NUL.
    for (const size of [0, 1, 4096, 64 * 1024, 96 * 1024, 200 * 1024, MAX_WRITE_BYTES]) {
      const payload = bytes(size, 13);
      const argv = writeRunArgv('/x.bin', toBase64(payload), 'r');
      const joined = argv.slice(4).join('');
      expect(joined, `base64 for ${size}`).toBe(toBase64(payload));
      const back = fromBase64(joined);
      expect(back.length, `length for ${size}`).toBe(size);
      expect(Array.from(back), `content for ${size}`).toEqual(Array.from(payload));
    }
  });

  it('never puts payload bytes in the script element', () => {
    const b64 = toBase64(bytes(120 * 1024));
    const argv = writeRunArgv('/a/b.bin', b64, 'tok');
    const script = argv[2] as string;
    expect(script.length).toBeLessThan(400);
    expect(script).not.toContain(b64.slice(0, 64));
    expect(script).toContain(`printf '%s' "$@"`);
    // Staged then renamed: a failed decode must not truncate the existing file,
    // and the staging file is removed on any exit so it never reaches a manifest.
    expect(script).toContain("T='/a/b.bin.mari-tok.part';");
    expect(script).toContain(`trap 'rm -f "$T"' EXIT`);
    expect(script).toContain('base64 -d > "$T"');
    expect(script).toContain(`mv -f "$T" '/a/b.bin'`);
    expect(argv[3]).toBe('mari-write');
  });

  it('the write cap equals the read cap, so a file that opens can be saved', () => {
    expect(MAX_WRITE_BYTES).toBe(MAX_INLINE_FILE_BYTES);
  });

  it('splits on exact boundaries and produces no empty piece', () => {
    expect(splitPayload('')).toEqual([]);
    expect(splitPayload('abc', 2)).toEqual(['ab', 'c']);
    expect(splitPayload('abcd', 2)).toEqual(['ab', 'cd']);
    const at = splitPayload('x'.repeat(MAX_ARGV_ELEMENT_BYTES));
    expect(at.length).toBe(1);
    const over = splitPayload('x'.repeat(MAX_ARGV_ELEMENT_BYTES + 1));
    expect(over.length).toBe(2);
    expect(over[1]).toBe('x');
  });
});

describe('run cwd (spec 2: a computer has ONE filesystem)', () => {
  it('defaults INSIDE the computer, never the container root', () => {
    expect(DEFAULT_CWD).toBe('');
    expect(resolveRunCwd('/work', DEFAULT_CWD)).toBe('/work');
    expect(resolveRunCwd('/work', undefined)).toBe('/work');
    expect(resolveRunCwd('/work', null)).toBe('/work');
    // `/` is what the control plane used to send, and it is exactly what must
    // never come back: it is outside the snapshotted tree.
    expect(resolveRunCwd('/work', DEFAULT_CWD)).not.toBe('/');
  });

  it('leaves an already-rooted path alone', () => {
    expect(resolveRunCwd('/work', '/work')).toBe('/work');
    expect(resolveRunCwd('/work', '/work/project')).toBe('/work/project');
    expect(resolveRunCwd('/work/', '/work/project/')).toBe('/work/project');
  });

  it('maps a computer-space path onto the root', () => {
    // The space the file browser, the editor and every manifest path use.
    expect(resolveRunCwd('/work', '/project')).toBe('/work/project');
    expect(resolveRunCwd('/work', 'project')).toBe('/work/project');
    expect(resolveRunCwd('/work', '/notes//sub/')).toBe('/work/notes/sub');
    // A root of `/` (COMPUTER_ROOT unset) means the two spaces coincide.
    expect(resolveRunCwd('/', '/project')).toBe('/project');
    expect(resolveRunCwd('/', '')).toBe('/');
    expect(resolveRunCwd('', '')).toBe('/');
  });
});
