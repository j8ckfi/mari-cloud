// The PRIVATE INSTANCE half of the chunk-read contract (spec 8.4/8.5,
// contracts.md §9.1): a real Node server, a real filesystem chunk store, and a
// store written by `mari-core`.
//
// This is not a duplicate of the Workers-pool suite (`test/chunk-read.test.ts`).
// The private instance reads chunks through `NodeR2Bucket` — a directory on disk
// laid out exactly as `marid` writes it through opendal — so this exercises the
// same decompress-and-verify reader against real files on real disk, in the Node
// runtime, over real HTTP. Nothing here is mocked: the fixture's bytes are
// written into `storeDir` under their contracts.md §9 keys, which is
// byte-for-byte what a supervisor sharing that directory would have left behind.
//
// The fixture comes from the Rust side: `cargo test -p mari-core --test
// ts_store_fixture`.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { boot, type NodeInstance } from '../../src/node/boot';
import { api, makeLocalDir, removeDir, seedSession } from './harness';
import fixture from '../fixtures/mari-core-store.json';

interface FixtureFile {
  path: string;
  size: number;
  chunks: { chunk: string; len: number }[];
  contentBase64: string;
}
const fx = fixture as unknown as {
  manifestId: string;
  manifestKey: string;
  manifestCborBase64: string;
  files: FixtureFile[];
  chunks: { id: string; key: string; storedBase64: string }[];
};

const b64 = (s: string): Buffer => Buffer.from(s, 'base64');

describe('private instance: file content from a mari-core store on disk', () => {
  let instance: NodeInstance;
  let dataDir = '';
  let storeDir = '';
  let cookie = '';
  let computerId = '';

  beforeAll(async () => {
    dataDir = await makeLocalDir('mari-chunkread-data');
    storeDir = await makeLocalDir('mari-chunkread-store');
    process.env.DEV_AUTH = '1';
    process.env.DEV_SEED = '1';
    process.env.AUTH_SECRET = 'node-chunkread-secret-not-for-prod';
    delete process.env.BASE_URL;

    // Lay the mari-core store objects into the store directory exactly as the
    // supervisor would have (contracts.md §9), compressed bodies and all.
    for (const [key, bytes] of [
      [fx.manifestKey, b64(fx.manifestCborBase64)] as const,
      ...fx.chunks.map((c) => [c.key, b64(c.storedBase64)] as const),
    ]) {
      const file = join(storeDir, ...key.split('/'));
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, bytes);
    }

    instance = await boot({
      port: 0,
      hostname: '127.0.0.1',
      dataDir,
      storeDir,
      webDir: null,
      substrateMode: 'fake',
      baseSnapshot: false,
      log: () => {},
    });

    ({ cookie } = await seedSession(instance.url));
    const created = await api<{ id: string }>(instance.url, cookie, '/api/computers', {
      method: 'POST',
      body: JSON.stringify({ name: 'rust-written' }),
    });
    expect(created.status).toBe(201);
    computerId = created.body.id;
    // Point the head at the mari-core manifest without waking (spec 8.4).
    const stub = await instance.runtime.computers.instanceFor(computerId);
    await stub.initFromManifest(computerId, fx.manifestId);
  });

  afterAll(async () => {
    await instance?.close();
    await removeDir(dataDir);
    await removeDir(storeDir);
  });

  it('serves every kind of file byte-for-byte over real HTTP', async () => {
    for (const f of fx.files) {
      const res = await fetch(
        `${instance.url}/api/computers/${computerId}/file?path=${encodeURIComponent(f.path)}`,
        { headers: { Cookie: cookie } },
      );
      expect(res.status, `${f.path} status`).toBe(200);
      const got = Buffer.from(await res.arrayBuffer());
      expect(got.length, `${f.path} length`).toBe(f.size);
      expect(
        got.equals(b64(f.contentBase64)),
        `${f.path} must come back byte-for-byte (${f.chunks.length} chunk refs)`,
      ).toBe(true);
      expect(res.headers.get('x-mari-manifest')).toBe(fx.manifestId);
    }
    // The multi-chunk case really is multi-chunk on this fixture.
    expect(fx.files.find((f) => f.path === '/bin/multi.bin')!.chunks.length).toBeGreaterThan(4);
  });

  it('refuses a corrupted chunk body instead of serving it', async () => {
    const readme = fx.files.find((f) => f.path === '/README.md')!;
    const ref = readme.chunks[0]!;
    const key = fx.chunks.find((c) => c.id === ref.chunk)!.key;
    const file = join(storeDir, ...key.split('/'));
    const good = b64(fx.chunks.find((c) => c.id === ref.chunk)!.storedBase64);

    await writeFile(file, Buffer.from('garbage, not a zstd frame'));
    const bad = await fetch(
      `${instance.url}/api/computers/${computerId}/file?path=${encodeURIComponent('/README.md')}`,
      { headers: { Cookie: cookie } },
    );
    expect(bad.status).toBe(500);
    const body = (await bad.json()) as { error: string; chunk: string; path: string };
    expect(body.error).toBe('chunk_undecodable');
    expect(body.chunk).toBe(ref.chunk);
    expect(body.path).toBe('/README.md');

    // Restored: the same computer serves the real bytes again.
    await writeFile(file, good);
    const ok = await fetch(
      `${instance.url}/api/computers/${computerId}/file?path=${encodeURIComponent('/README.md')}`,
      { headers: { Cookie: cookie } },
    );
    expect(ok.status).toBe(200);
    expect(Buffer.from(await ok.arrayBuffer()).equals(b64(readme.contentBase64))).toBe(true);
  });

  it('the dev seed it booted with is readable too (real blake3 ids, real frames)', async () => {
    const res = await fetch(
      `${instance.url}/api/computers/seedcomputer/file?path=${encodeURIComponent('/README.md')}`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    const { SEED_TREE } = await import('../../src/seed');
    expect(await res.text()).toBe(SEED_TREE['/README.md']);
  });
});
