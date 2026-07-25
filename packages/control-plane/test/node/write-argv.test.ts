// The file-write run against a REAL `/bin/sh`, on a real filesystem.
//
// `test/writes.test.ts` proves the control plane composes the right argv; this
// proves that argv actually writes the file, and that the shape it replaced could
// not. No Docker, no daemon: the defect was an `execve` limit, so a local process
// is the honest reproduction (`pnpm --filter @mari/control-plane test:node`).
//
// The reported failure, verbatim: at 96/128/200/256 KiB the API answered
// `202 {"ok":true,"bytes":N}`, the file never appeared, and the write run ended
// `state=failed signal=6`. Cause: the whole base64 payload was ONE argv element,
// and Linux caps one element at `MAX_ARG_STRLEN` (131072 bytes, NUL included).
import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { platform } from 'node:process';
import { MAX_WRITE_BYTES, shellQuote, writeRunArgv } from '../../src/runs';

/** Run an argv to completion. Resolves with the exit status or the spawn error. */
function run(argv: string[]): Promise<{ code: number | null; signal: string | null; error: string | null }> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0] as string, argv.slice(1), { stdio: 'ignore' });
    } catch (err) {
      // `E2BIG` arrives synchronously here (libuv fails before the fork), which
      // is the same failure marid's `spawn_command` hits — it is not an exit
      // status, so nothing in the run's journal can explain it.
      resolve({ code: null, signal: null, error: String(err) });
      return;
    }
    child.on('error', (err) => resolve({ code: null, signal: null, error: String(err) }));
    child.on('exit', (code, signal) => resolve({ code, signal, error: null }));
  });
}

function payload(n: number): Uint8Array {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = (i * 31 + (i >> 8)) & 0xff;
  return out;
}

describe('a write run writes the file (spec 4.1: the disk is the only writable copy)', () => {
  // 1 MiB of base64 is ~1.34 MiB of argument block. Linux allows 2 MiB
  // (RLIMIT_STACK/4); macOS caps the TOTAL at 1 MiB, so the largest case is
  // asserted only where the product actually runs — a computer is a Linux
  // container on every substrate Mari has.
  const sizes = platform === 'linux'
    ? [0, 96 * 1024, 200 * 1024, MAX_WRITE_BYTES]
    : [0, 96 * 1024, 200 * 1024];

  it('round-trips every size the route accepts, byte for byte', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mari-write-'));
    try {
      for (const size of sizes) {
        const bytes = payload(size);
        const target = join(dir, `sub/dir/w${size}.bin`);
        const argv = writeRunArgv(target, Buffer.from(bytes).toString('base64'), `run${size}`);
        const res = await run(argv);
        expect(res.error, `spawn ${size}`).toBeNull();
        expect(res.signal, `signal ${size}`).toBeNull();
        expect(res.code, `exit ${size}`).toBe(0);
        const got = await readFile(target);
        expect(got.length, `length ${size}`).toBe(size);
        expect(Buffer.compare(got, Buffer.from(bytes)), `content ${size}`).toBe(0);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('the pre-fix shape — one argv element — cannot even be spawned', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mari-write-old-'));
    try {
      const bytes = payload(MAX_WRITE_BYTES);
      const b64 = Buffer.from(bytes).toString('base64');
      const target = join(dir, 'old.bin');
      // Exactly what the control plane used to emit.
      const script =
        `set -e; printf '%s' ${shellQuote(b64)} | base64 -d > ${shellQuote(target)}`;
      const res = await run(['/bin/sh', '-c', script]);
      // E2BIG. Node surfaces it as a spawn error; a supervisor that unwraps it
      // aborts (the observed `signal=6`). Either way: no file.
      expect(res.error ?? '').toMatch(/E2BIG|spawn/i);
      await expect(readFile(target)).rejects.toThrow();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('a failed decode leaves the previous content intact', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mari-write-atomic-'));
    try {
      const target = join(dir, 'keep.txt');
      await writeFile(target, 'original content\n');
      // Not base64: `base64 -d` fails, `set -e` fails the run, and the staging
      // file — not the target — is what got truncated.
      const argv = writeRunArgv(target, '!!!not base64!!!', 'bad');
      const res = await run(argv);
      expect(res.code === 0).toBe(false);
      expect(await readFile(target, 'utf8')).toBe('original content\n');
      // ...and no staging file is left behind for the next snapshot to commit
      // into the manifest (the `/work/core` lesson: litter a run leaves becomes
      // part of the computer forever).
      expect(await readdir(dir)).toEqual(['keep.txt']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
