// Reading FILE CONTENT out of a store that `mari-core` wrote (spec 8.4/8.5).
//
// This is the interoperability test the file-read path never had. The fixture in
// `fixtures/mari-core-store.json` is not made here: it is the verbatim contents
// of a chunk store produced by the Rust snapshotter
// (`cargo test -p mari-core --test ts_store_fixture`) — real FastCDC cuts, real
// zstd frames, real blake3 ids. A fixture this suite generated itself would only
// prove TypeScript agrees with TypeScript, which is precisely how a reader that
// served COMPRESSED bytes to every editor and download stayed green.
//
// The store objects are loaded into the real R2 binding under their real keys,
// a computer's head is pointed at the manifest WITHOUT waking it, and the bytes
// that come back out of the HTTP routes are compared to the source files.
//
// Cases, all of them ways a chunk reader goes wrong:
//   - a small text file (one chunk)
//   - a UTF-8 file with multi-byte characters, a NUL and a lone CR
//   - an EMPTY file (zero chunk refs)
//   - a high-entropy binary (zstd cannot shrink it: a reader that skips
//     decompression returns something that is *almost* the right length)
//   - a MULTI-CHUNK file (7 chunks) — concatenation order is observable
//   - a file of repeated blocks, whose ref list names one chunk twice
//   - corruption: a garbage body, a valid frame holding the WRONG bytes, a
//     deleted chunk, and a truncated frame. Every one must be refused by id, and
//     no bytes may reach the client.

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  computerStub,
  createComputer,
  env,
  eqBytes,
  ensureSchema,
  HOST,
  seedSession,
  substrateOps,
} from './helpers';
import { fromBase64, toArrayBuffer } from '../src/bytes';
import {
  chunkIdOf,
  chunkKey,
  decodeChunkBody,
  encodeChunkBody,
  ChunkCorrupted,
  ChunkMissing,
  ChunkUndecodable,
  ChunkReadError,
  loadManifest,
  readFile,
} from '../src/manifest-store';
import fixture from './fixtures/mari-core-store.json';

interface FixtureFile {
  path: string;
  size: number;
  mode: number;
  chunks: { chunk: string; len: number }[];
  contentBase64: string;
}
interface FixtureChunk {
  id: string;
  key: string;
  storedBase64: string;
}
const fx = fixture as unknown as {
  manifestId: string;
  manifestKey: string;
  manifestCborBase64: string;
  dirs: string[];
  files: FixtureFile[];
  chunks: FixtureChunk[];
};

const file = (path: string): FixtureFile => {
  const f = fx.files.find((x) => x.path === path);
  if (!f) throw new Error(`fixture has no ${path}`);
  return f;
};
const want = (path: string): Uint8Array => fromBase64(file(path).contentBase64);

/** Load the mari-core store objects into R2 under their real keys. */
async function loadFixtureStore(): Promise<void> {
  await env.STORE.put(fx.manifestKey, toArrayBuffer(fromBase64(fx.manifestCborBase64)));
  for (const c of fx.chunks) {
    await env.STORE.put(c.key, toArrayBuffer(fromBase64(c.storedBase64)));
  }
}

async function getFile(
  computerId: string,
  cookie: string,
  path: string,
): Promise<{ status: number; bytes: Uint8Array; headers: Headers; text: string }> {
  const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/file?path=${encodeURIComponent(path)}`, {
    headers: { Cookie: cookie },
  });
  const buf = await res.arrayBuffer();
  return {
    status: res.status,
    bytes: new Uint8Array(buf),
    headers: res.headers,
    text: new TextDecoder().decode(buf),
  };
}

describe('file content from a store written by mari-core', () => {
  let cookie = '';
  let computerId = '';

  beforeAll(async () => {
    await ensureSchema();
    ({ cookie } = await seedSession());
    await loadFixtureStore();
    computerId = await createComputer(cookie, 'rust-written');
    // Point the head at the mari-core manifest with no wake (spec 8.4), the
    // same call the dev seed uses.
    await computerStub(computerId).initFromManifest(computerId, fx.manifestId);
  });

  it('the fixture really was written by mari-core, not by this suite', () => {
    // Stored bodies are zstd frames (magic 0xFD2FB528, little-endian) and are
    // NOT the plaintext — the bug this test exists for was serving these bytes.
    expect(fx.chunks.length).toBeGreaterThan(10);
    for (const c of fx.chunks) {
      const stored = fromBase64(c.storedBase64);
      expect([...stored.subarray(0, 4)]).toEqual([0x28, 0xb5, 0x2f, 0xfd]);
      expect(c.key).toBe(chunkKey(c.id));
      // The id is the blake3 of the DECOMPRESSED bytes — Rust's blake3 and this
      // pure-JS one must agree exactly, or nothing below can work.
      const plain = decodeChunkBody(stored, c.id);
      expect(chunkIdOf(plain)).toBe(c.id);
      expect(eqBytes(stored, plain)).toBe(false);
    }
    // At least one chunk is high-entropy, i.e. its frame is BIGGER than the
    // plaintext: length alone cannot be used to guess "this looks compressed".
    const grew = fx.chunks.filter((c) => {
      const stored = fromBase64(c.storedBase64);
      return stored.length > decodeChunkBody(stored, c.id).length;
    });
    expect(grew.length).toBeGreaterThan(0);
  });

  it('serves a small text file byte-for-byte', async () => {
    const got = await getFile(computerId, cookie, '/README.md');
    expect(got.status).toBe(200);
    expect(eqBytes(got.bytes, want('/README.md'))).toBe(true);
    expect(got.text).toBe('# real computer\n\nThis tree was written by mari-core.\n');
    expect(got.headers.get('x-mari-manifest')).toBe(fx.manifestId);
    expect(got.headers.get('content-length')).toBe(String(file('/README.md').size));
  });

  it('serves UTF-8 with multi-byte characters, a NUL and a CR byte-for-byte', async () => {
    const got = await getFile(computerId, cookie, '/notes/utf8.txt');
    expect(got.status).toBe(200);
    const expected = want('/notes/utf8.txt');
    expect(got.bytes.length).toBe(expected.length);
    expect(eqBytes(got.bytes, expected)).toBe(true);
    // Not a UTF-8 code-point comparison: the exact bytes, NUL included.
    expect([...got.bytes].includes(0)).toBe(true);
  });

  it('serves an empty file as zero bytes', async () => {
    expect(file('/empty.bin').chunks).toEqual([]);
    const got = await getFile(computerId, cookie, '/empty.bin');
    expect(got.status).toBe(200);
    expect(got.bytes.length).toBe(0);
    expect(got.headers.get('content-length')).toBe('0');
  });

  it('serves a high-entropy binary file byte-for-byte', async () => {
    const expected = want('/bin/entropy.bin');
    expect(expected.length).toBe(4096);
    const got = await getFile(computerId, cookie, '/bin/entropy.bin');
    expect(got.status).toBe(200);
    expect(got.bytes.length).toBe(expected.length);
    expect(eqBytes(got.bytes, expected)).toBe(true);
  });

  it('serves a MULTI-CHUNK file with its chunks in the right order', async () => {
    const f = file('/bin/multi.bin');
    expect(f.chunks.length).toBeGreaterThan(4);
    expect(f.chunks.reduce((n, r) => n + r.len, 0)).toBe(f.size);
    const expected = want('/bin/multi.bin');
    const got = await getFile(computerId, cookie, '/bin/multi.bin');
    expect(got.status).toBe(200);
    expect(got.bytes.length).toBe(expected.length);
    expect(eqBytes(got.bytes, expected)).toBe(true);

    // Teeth on ORDER specifically: reversing the ref list must produce different
    // bytes, so byte-equality above is not accidentally order-insensitive.
    const manifest = await loadManifest(env.STORE, fx.manifestId);
    const entry = manifest.entries.find((e) => e.path === '/bin/multi.bin')!;
    const reversed = { ...manifest, entries: manifest.entries.map((e) => (e === entry ? { ...e, chunks: [...e.chunks].reverse() } : e)) };
    const scrambled = await readFile(env.STORE, reversed, '/bin/multi.bin');
    expect(scrambled.length).toBe(expected.length);
    expect(eqBytes(scrambled, expected)).toBe(false);
  });

  it('serves a file whose ref list names the same chunk twice', async () => {
    const f = file('/bin/repeat.bin');
    const distinct = new Set(f.chunks.map((r) => r.chunk));
    expect(f.chunks.length).toBeGreaterThan(distinct.size);
    const expected = want('/bin/repeat.bin');
    const got = await getFile(computerId, cookie, '/bin/repeat.bin');
    expect(got.status).toBe(200);
    expect(eqBytes(got.bytes, expected)).toBe(true);
  });

  it('the file-browser route serves the same bytes as the file route', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/files/bin/multi.bin`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(eqBytes(new Uint8Array(await res.arrayBuffer()), want('/bin/multi.bin'))).toBe(true);
  });

  it('read all of it without waking the computer (spec 8.4)', async () => {
    expect(await computerStub(computerId).getState()).toBe('cold');
    expect((await substrateOps(computerStub(computerId))).filter((o) => o === 'wake' || o === 'materialize')).toEqual([]);
    // And the DO still reports the mari-core manifest as its head.
    expect(await computerStub(computerId).getHead()).toBe(fx.manifestId);
  });
});

describe('a chunk that cannot be trusted is refused, never served', () => {
  let cookie = '';
  let computerId = '';
  /** The single chunk of /README.md in the mari-core fixture. */
  const readme = () => {
    const f = fx.files.find((x) => x.path === '/README.md')!;
    return f.chunks[0]!;
  };

  beforeAll(async () => {
    await ensureSchema();
    ({ cookie } = await seedSession());
    await loadFixtureStore();
    computerId = await createComputer(cookie, 'corruptible');
    await computerStub(computerId).initFromManifest(computerId, fx.manifestId);
  });

  it('is healthy before corruption', async () => {
    const got = await getFile(computerId, cookie, '/README.md');
    expect(got.status).toBe(200);
    expect(eqBytes(got.bytes, want('/README.md'))).toBe(true);
  });

  it('rejects a body that is not a zstd frame at all', async () => {
    const ref = readme();
    await env.STORE.put(chunkKey(ref.chunk), toArrayBuffer(new TextEncoder().encode('not a frame')));
    const got = await getFile(computerId, cookie, '/README.md');
    expect(got.status).toBe(500);
    const body = JSON.parse(got.text) as { error: string; chunk: string; path: string };
    expect(body.error).toBe('chunk_undecodable');
    expect(body.chunk).toBe(ref.chunk);
    expect(body.path).toBe('/README.md');
    // Not one byte of the file leaked into the error response.
    expect(got.text).not.toContain('real computer');
    // And the typed error is what the reader throws.
    const manifest = await loadManifest(env.STORE, fx.manifestId);
    await expect(readFile(env.STORE, manifest, '/README.md')).rejects.toBeInstanceOf(ChunkUndecodable);
    await loadFixtureStore();
  });

  it('rejects a VALID zstd frame that holds the wrong bytes (blake3 mismatch)', async () => {
    const ref = readme();
    const lie = new TextEncoder().encode('# real computer\n\nThis tree was written by mari-core!\n');
    expect(chunkIdOf(lie)).not.toBe(ref.chunk);
    // A perfectly decodable frame of the same LENGTH — only verification catches it.
    expect(lie.length).toBe(ref.len);
    await env.STORE.put(chunkKey(ref.chunk), toArrayBuffer(encodeChunkBody(lie)));

    const got = await getFile(computerId, cookie, '/README.md');
    expect(got.status).toBe(500);
    const body = JSON.parse(got.text) as { error: string; chunk: string };
    expect(body.error).toBe('chunk_corrupt');
    expect(body.chunk).toBe(ref.chunk);
    // The substituted content was NOT served.
    expect(got.text).not.toContain('mari-core!');

    const manifest = await loadManifest(env.STORE, fx.manifestId);
    const err = await readFile(env.STORE, manifest, '/README.md').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkCorrupted);
    expect((err as ChunkCorrupted).chunk).toBe(ref.chunk);
    expect((err as ChunkCorrupted).actual).toBe(chunkIdOf(lie));
    await loadFixtureStore();
  });

  it('rejects a truncated frame (a half-uploaded chunk)', async () => {
    const ref = readme();
    const stored = fromBase64(fx.chunks.find((c) => c.id === ref.chunk)!.storedBase64);
    await env.STORE.put(chunkKey(ref.chunk), toArrayBuffer(stored.subarray(0, stored.length - 5)));
    const got = await getFile(computerId, cookie, '/README.md');
    expect(got.status).toBe(500);
    const body = JSON.parse(got.text) as { error: string; chunk: string };
    // Either the frame no longer parses or it decodes to different bytes; both
    // are refusals naming this chunk, and neither serves content.
    expect(['chunk_undecodable', 'chunk_corrupt', 'chunk_length_mismatch']).toContain(body.error);
    expect(body.chunk).toBe(ref.chunk);
    expect(got.text).not.toContain('real computer');
    await loadFixtureStore();
  });

  it('rejects a missing chunk by id instead of 404ing the path', async () => {
    const ref = readme();
    await env.STORE.delete(chunkKey(ref.chunk));
    const got = await getFile(computerId, cookie, '/README.md');
    expect(got.status).toBe(500);
    const body = JSON.parse(got.text) as { error: string; chunk: string };
    expect(body.error).toBe('chunk_missing');
    expect(body.chunk).toBe(ref.chunk);

    const manifest = await loadManifest(env.STORE, fx.manifestId);
    await expect(readFile(env.STORE, manifest, '/README.md')).rejects.toBeInstanceOf(ChunkMissing);
    await loadFixtureStore();
  });

  it('a corrupt chunk in the MIDDLE of a multi-chunk file serves nothing at all', async () => {
    const f = file('/bin/multi.bin');
    const victim = f.chunks[3]!;
    const lie = new Uint8Array(victim.len).fill(0x41);
    await env.STORE.put(chunkKey(victim.chunk), toArrayBuffer(encodeChunkBody(lie)));

    const got = await getFile(computerId, cookie, '/bin/multi.bin');
    expect(got.status).toBe(500);
    const body = JSON.parse(got.text) as { error: string; chunk: string };
    expect(body.error).toBe('chunk_corrupt');
    expect(body.chunk).toBe(victim.chunk);
    // No prefix of the file was streamed out before the failure.
    expect(got.bytes.length).toBeLessThan(200);
    const original = want('/bin/multi.bin');
    expect(got.text.includes('AAAA')).toBe(false);
    expect(got.bytes.length).not.toBe(original.length);
    await loadFixtureStore();
  });

  it('refuses a manifest whose chunk refs do not sum to the entry size', async () => {
    const manifest = await loadManifest(env.STORE, fx.manifestId);
    const readme = manifest.entries.find((e) => e.path === '/README.md')!;
    const lying = {
      ...manifest,
      entries: manifest.entries.map((e) => (e === readme ? { ...e, size: e.size + 1 } : e)),
    };
    const err = await readFile(env.STORE, lying, '/README.md').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkReadError);
    expect((err as ChunkReadError).code).toBe('manifest_size_mismatch');
  });

  it('refuses the same chunk named twice with different lengths', async () => {
    const manifest = await loadManifest(env.STORE, fx.manifestId);
    const readme = manifest.entries.find((e) => e.path === '/README.md')!;
    const ref = readme.chunks[0]!;
    const doubled = {
      ...manifest,
      entries: manifest.entries.map((e) =>
        e === readme
          ? {
              ...e,
              size: ref.len * 2,
              // The second ref names the same chunk but claims a different length.
              chunks: [ref, { chunk: ref.chunk, len: ref.len - 1 }],
            }
          : e,
      ),
    };
    const err = await readFile(env.STORE, doubled, '/README.md').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkReadError);
    expect((err as ChunkReadError).code).toBe('chunk_length_mismatch');
    expect((err as ChunkReadError).chunk).toBe(ref.chunk);
  });

  it('refuses a chunk id that is not a content address, before touching the store', async () => {
    const manifest = await loadManifest(env.STORE, fx.manifestId);
    const evil = {
      ...manifest,
      entries: manifest.entries.map((e) =>
        e.path === '/README.md'
          ? { ...e, chunks: [{ chunk: '../../manifests/' + fx.manifestId, len: e.size }] }
          : e,
      ),
    };
    const err = await readFile(env.STORE, evil, '/README.md').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ChunkReadError);
    expect((err as ChunkReadError).code).toBe('chunk_id_malformed');
  });

  it('is healthy again after every corruption case restored the fixture', async () => {
    const got = await getFile(computerId, cookie, '/README.md');
    expect(got.status).toBe(200);
    expect(eqBytes(got.bytes, want('/README.md'))).toBe(true);
    const multi = await getFile(computerId, cookie, '/bin/multi.bin');
    expect(multi.status).toBe(200);
    expect(eqBytes(multi.bytes, want('/bin/multi.bin'))).toBe(true);
  });
});
