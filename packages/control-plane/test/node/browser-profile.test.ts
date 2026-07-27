import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
const archiver = resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../../../deploy/browser/profile-archive.mjs',
);
let scratch = '';

afterEach(async () => {
  if (scratch) await rm(scratch, { recursive: true, force: true });
  scratch = '';
});

async function invoke(mode: 'encrypt' | 'decrypt', key: string, input: string, output: string) {
  return exec('node', [archiver, mode, key, input, output], {
    timeout: 10_000,
  });
}

describe('encrypted browser-profile archive', () => {
  it('round-trips bytes and refuses tampering or a fork key', async () => {
    scratch = await mkdtemp(join(tmpdir(), 'mari-browser-profile-'));
    const key = join(scratch, 'key');
    const forkKey = join(scratch, 'fork-key');
    const plaintext = join(scratch, 'profile.tar');
    const archive = join(scratch, 'profile.enc');
    const restored = join(scratch, 'restored.tar');
    const tampered = join(scratch, 'tampered.enc');

    await writeFile(key, Buffer.alloc(32, 0x41).toString('base64'), { mode: 0o600 });
    await writeFile(forkKey, Buffer.alloc(32, 0x42).toString('base64'), { mode: 0o600 });
    await writeFile(plaintext, Buffer.from('cookie-db\0session-state\xff', 'binary'));

    await invoke('encrypt', key, plaintext, archive);
    expect((await readFile(archive)).includes(Buffer.from('cookie-db'))).toBe(false);
    await invoke('decrypt', key, archive, restored);
    expect(await readFile(restored)).toEqual(await readFile(plaintext));

    await expect(invoke('decrypt', forkKey, archive, restored)).rejects.toThrow();

    const damaged = await readFile(archive);
    damaged[Math.floor(damaged.length / 2)] ^= 0xff;
    await writeFile(tampered, damaged);
    await expect(invoke('decrypt', key, tampered, restored)).rejects.toThrow();
  });
});
