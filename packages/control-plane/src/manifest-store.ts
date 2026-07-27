// Reading a computer's filesystem from the chunk store WITHOUT waking it
// (spec 8.4). For a non-AWAKE computer the file browser serves directory
// listings and small file reads straight from the manifest at the head plus
// on-demand chunk fetches from R2. No substrate is touched.
//
// The TS side only READS a computer's manifests (decisions.md); `mari-core` is
// the writer. The one exception is `encodeChunkBody` at the bottom of this file,
// which exists so the dev seed and tests can produce store objects in the real
// format rather than a dialect of their own. Object layout is contracts.md §9.
//
// ---------------------------------------------------------------------------
// A CHUNK BODY IS NOT PLAINTEXT.
//
// `mari-core` stores chunk bodies **zstd-compressed** and names them by the
// blake3 of the **plaintext** (crates/mari-core/src/store.rs, contracts.md §9).
// A reader that concatenates stored bytes therefore serves a corrupt prefix of a
// compressed frame — which is exactly what this module used to do, breaking the
// editor, downloads and every content preview for every file a real supervisor
// wrote. So this module owns both halves of `mari-core`'s read contract:
//
//   1. decompress the stored body (`fzstd` — pure JS, so it runs unchanged on
//      workerd and on Node; no wasm, no native module), and
//   2. **verify then use**: re-hash the decompressed bytes with blake3 and
//      compare to the id the manifest named, before any of them are served.
//
// Verification is not optional and not sampled, and that is a measured decision,
// not an assumption. The cost is linear in file size and this path reads at most
// `MAX_INLINE_FILE_BYTES` (1 MiB), so 1 MiB is the worst case:
//
//   blake3 of 1 MiB          ~11 ms on Node 26 (V8), ~69 ms inside workerd as
//                            the vitest pool runs it (unminified, dev transform)
//   decode of a 1 MiB frame  ~0.1 ms (raw blocks) — the hash dominates
//
// A typical source file is single-digit KB, i.e. well under a millisecond even at
// the slower figure, and the ceiling holds the worst case to tens of milliseconds
// of CPU against a 30 s per-invocation budget. Serving unverified bytes to save
// that is not a trade this path makes: a silently corrupt file loaded into an
// editor gets SAVED BACK, which turns a storage fault into data loss.
// ---------------------------------------------------------------------------

import { decodeManifest, encodeCbor, type Manifest, type ManifestEntry } from '@mari/shared';
import { decompress as zstdDecompress } from 'fzstd';
import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { tenantStoreParentRoot } from './r2-credentials';

function inRoot(root: string, key: string): string {
  return root === '' ? key : `${root.replace(/\/+$/, '')}/${key}`;
}

/** Store object keys (contracts.md §9). `root` is the opaque per-account
 * namespace in hosted S3/R2 deployments. */
export function manifestKey(id: string, root = ''): string {
  return inRoot(root, `manifests/${id}.cbor`);
}

/** Chunk key: `chunks/{id[0..2]}/{id}` — the 2-hex prefix shards the keyspace. */
export function chunkKey(id: string, root = ''): string {
  return inRoot(root, `chunks/${id.slice(0, 2)}/${id}`);
}

/** A content address is 64 lowercase hex characters (contracts.md §3). */
const CONTENT_ADDRESS = /^[0-9a-f]{64}$/;

/** Lowercase blake3 hex of `bytes` — the content address of contracts.md §3. */
export function blake3Hex(bytes: Uint8Array): string {
  return bytesToHex(blake3(bytes));
}

/**
 * The chunk id of PLAINTEXT bytes: byte-for-byte what `mari-core`'s
 * `ChunkStore::chunk_id` computes. Compression is a storage detail invisible to
 * identity, so this hashes the *decompressed* content.
 */
export function chunkIdOf(plain: Uint8Array): string {
  return blake3Hex(plain);
}

/** The manifest id of a manifest's canonical CBOR (`mari-core`'s
 *  `manifest_id_of_cbor`). */
export function manifestIdOf(cbor: Uint8Array): string {
  return blake3Hex(cbor);
}

/**
 * A chunk named by a manifest could not be turned back into trustworthy bytes.
 * Every case is a store-integrity failure, never a client mistake, and every
 * case names the chunk: `code` is the stable wire code the routes surface.
 *
 * The bytes of a failed chunk are never returned and never partially written
 * into a response — `readFile` assembles the whole file in memory and throws
 * before anything is handed to a `Response`.
 */
export class ChunkReadError extends Error {
  constructor(
    readonly code:
      | 'chunk_id_malformed'
      | 'chunk_missing'
      | 'chunk_undecodable'
      | 'chunk_corrupt'
      | 'chunk_length_mismatch'
      | 'manifest_size_mismatch',
    /** The chunk at fault, or `''` when the fault is the manifest's own. */
    readonly chunk: string,
    message: string,
  ) {
    super(message);
    this.name = 'ChunkReadError';
  }
}

/** The manifest named an id that is not a content address (untrusted input). */
export class ChunkIdMalformed extends ChunkReadError {
  constructor(chunk: string) {
    super(
      'chunk_id_malformed',
      chunk,
      `malformed chunk id ${JSON.stringify(chunk)}: expected 64 lowercase hex characters`,
    );
  }
}

/** The manifest referenced a chunk the store does not hold. */
export class ChunkMissing extends ChunkReadError {
  constructor(chunk: string) {
    super('chunk_missing', chunk, `chunk ${chunk} is missing from the store`);
  }
}

/** The stored body is not a decodable zstd frame. */
export class ChunkUndecodable extends ChunkReadError {
  constructor(
    chunk: string,
    readonly reason: string,
  ) {
    super('chunk_undecodable', chunk, `chunk ${chunk} is not a valid zstd frame: ${reason}`);
  }
}

/** The decompressed bytes do not hash to the id the manifest named. */
export class ChunkCorrupted extends ChunkReadError {
  constructor(
    chunk: string,
    readonly actual: string,
  ) {
    super('chunk_corrupt', chunk, `chunk ${chunk} failed blake3 verification (got ${actual})`);
  }
}

/** The chunk verified, but its length is not the length the manifest recorded. */
export class ChunkLengthMismatch extends ChunkReadError {
  constructor(
    chunk: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      'chunk_length_mismatch',
      chunk,
      `chunk ${chunk}: manifest says ${expected} bytes, chunk holds ${actual}`,
    );
  }
}

/** An entry's chunk refs do not sum to the size the entry recorded. */
export class ManifestSizeMismatch extends ChunkReadError {
  constructor(
    readonly path: string,
    readonly expected: number,
    readonly actual: number,
  ) {
    super(
      'manifest_size_mismatch',
      '',
      `${path}: entry size ${expected} but its chunks hold ${actual} bytes`,
    );
  }
}

/**
 * Turn one STORED chunk body into plaintext, honouring `mari-core`'s
 * verify-then-use contract: decompress, then re-hash and compare to `id`.
 * `expectedLen` (a manifest `ChunkRef.len`) is checked too when given.
 *
 * Throws a {@link ChunkReadError} — never returns unverified bytes.
 */
export function decodeChunkBody(stored: Uint8Array, id: string, expectedLen?: number): Uint8Array {
  if (!CONTENT_ADDRESS.test(id)) throw new ChunkIdMalformed(id);

  let plain: Uint8Array;
  try {
    // A zero-length stored body cannot be a frame; fzstd would read past its end.
    if (stored.length === 0) throw new Error('empty object');
    plain = zstdDecompress(stored);
  } catch (err) {
    throw new ChunkUndecodable(id, err instanceof Error ? err.message : String(err));
  }

  const actual = chunkIdOf(plain);
  if (actual !== id) throw new ChunkCorrupted(id, actual);
  if (expectedLen !== undefined && plain.length !== expectedLen) {
    throw new ChunkLengthMismatch(id, expectedLen, plain.length);
  }
  return plain;
}

/** Fetch one chunk from the store and return its VERIFIED plaintext bytes. */
export async function getChunk(
  store: R2Bucket,
  id: string,
  expectedLen?: number,
  root = '',
): Promise<Uint8Array> {
  if (!CONTENT_ADDRESS.test(id)) throw new ChunkIdMalformed(id);
  const obj = await store.get(chunkKey(id, root));
  if (obj === null) throw new ChunkMissing(id);
  return decodeChunkBody(new Uint8Array(await obj.arrayBuffer()), id, expectedLen);
}

// ---- writing a chunk body (dev seed + tests only) -------------------------

/** Largest raw block a zstd frame may carry (RFC 8878 §3.1.1.2.3). */
const RAW_BLOCK_MAX = 128 * 1024;

/**
 * Encode plaintext as a chunk body in the STORED form: a zstd frame.
 *
 * `mari-core` is the only writer of a real computer's chunks; this exists for
 * the dev seed and for tests, which must produce bodies the reader above (and
 * `mari-core`, and `zstd(1)`) accept. There is no pure-JS zstd *compressor* that
 * runs on workerd, so the frame is emitted with **raw (uncompressed) blocks** —
 * a fully conformant zstd frame that simply achieves a 1:1 ratio: magic number,
 * single-segment header with an explicit 4-byte content size, then raw blocks.
 * Verified against `fzstd`, Node's libzstd bindings and the `zstd` CLI, and the
 * reader cannot tell it apart from a compressed frame.
 *
 * Seed/test data is tiny, so the lost ratio costs nothing; real chunks are
 * written by `mari-core` at zstd level 3.
 */
export function encodeChunkBody(plain: Uint8Array): Uint8Array {
  const blocks = Math.max(1, Math.ceil(plain.length / RAW_BLOCK_MAX));
  const out = new Uint8Array(4 + 1 + 4 + blocks * 3 + plain.length);
  const view = new DataView(out.buffer);
  let o = 0;
  // Magic number 0xFD2FB528, little-endian.
  out[o++] = 0x28;
  out[o++] = 0xb5;
  out[o++] = 0x2f;
  out[o++] = 0xfd;
  // Frame header descriptor: Frame_Content_Size_flag=2 (4 bytes),
  // Single_Segment_flag=1 (no window descriptor; window = content size),
  // no checksum, no dictionary.
  out[o++] = 0xa0;
  view.setUint32(o, plain.length, true);
  o += 4;
  let off = 0;
  for (let i = 0; i < blocks; i++) {
    const size = Math.min(RAW_BLOCK_MAX, plain.length - off);
    // Block header (24-bit LE): bit0 Last_Block, bits1-2 Block_Type (0=raw),
    // bits3-23 Block_Size.
    const header = (i === blocks - 1 ? 1 : 0) | (size << 3);
    out[o++] = header & 0xff;
    out[o++] = (header >>> 8) & 0xff;
    out[o++] = (header >>> 16) & 0xff;
    out.set(plain.subarray(off, off + size), o);
    o += size;
    off += size;
  }
  return out.subarray(0, o);
}

/** Largest file the browser will inline without waking (spec 8.5 "small file
 *  reads"). Larger reads require a wake; the caller returns 413. */
export const MAX_INLINE_FILE_BYTES = 1024 * 1024;

/** One row in a directory listing. */
export interface DirEntry {
  name: string;
  path: string;
  kind: ManifestEntry['kind'];
  mode: number;
  size: number;
  symlink_target: string | null;
}

/** A directory listing served from the manifest. */
export interface DirListing {
  path: string;
  entries: DirEntry[];
}

export class ManifestNotFound extends Error {}
export class PathNotFound extends Error {}
export class NotAFile extends Error {}
export class FileTooLarge extends Error {}

/** Load and decode the manifest at `id` from R2, or throw `ManifestNotFound`. */
export async function loadManifest(store: R2Bucket, id: string, root = ''): Promise<Manifest> {
  const obj = await store.get(manifestKey(id, root));
  if (obj === null) throw new ManifestNotFound(id);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return decodeManifest(bytes);
}

/**
 * Copy one legacy/global base manifest and its referenced chunks into an
 * account namespace if that namespace does not have it yet.
 *
 * This is the only intentional global read in the hosted storage path. The id
 * comes from the operator-controlled `BASE_MANIFEST` or from a computer's
 * already-owned D1/DO head; clients cannot choose it. All subsequent supervisor
 * writes and control-plane reads stay inside `root`.
 */
export async function ensureManifestNamespace(
  store: R2Bucket,
  id: string,
  root: string,
): Promise<void> {
  if (root === '' || (await store.head(manifestKey(id, root))) !== null) return;

  const sourceRoot = tenantStoreParentRoot(root);
  if (sourceRoot === null) {
    throw new Error('refusing to bootstrap a manifest into an invalid tenant namespace');
  }
  const source = await store.get(manifestKey(id, sourceRoot));
  if (source === null) throw new ManifestNotFound(id);
  const manifestBytes = new Uint8Array(await source.arrayBuffer());
  const manifest = decodeManifest(manifestBytes);
  const chunks = [
    ...new Set(
      manifest.entries.flatMap((entry) => entry.chunks.map((chunk) => chunk.chunk)),
    ),
  ];

  // Keep R2 fan-out bounded. Base images can contain many chunks and a wake
  // must not create an unbounded Promise.all in a Durable Object invocation.
  for (let i = 0; i < chunks.length; i += 32) {
    await Promise.all(
      chunks.slice(i, i + 32).map(async (chunk) => {
        const targetKey = chunkKey(chunk, root);
        if ((await store.head(targetKey)) !== null) return;
        const body = await store.get(chunkKey(chunk, sourceRoot));
        if (body === null) throw new ChunkMissing(chunk);
        await store.put(targetKey, await body.arrayBuffer());
      }),
    );
  }
  // Publish the manifest last: its presence means every referenced chunk is
  // already available in the account namespace.
  await store.put(manifestKey(id, root), manifestBytes);
}

/** Hosted default base for the production image's intentionally empty `/work`.
 * It is content-addressed and deterministic (`created_at: 0`), so every account
 * begins from the same operator-authored manifest even when no manual
 * `BASE_MANIFEST` var has been provisioned yet. */
export async function ensureEmptyBaseManifest(store: R2Bucket, root = ''): Promise<string> {
  const bytes = encodeCbor({
    version: 1,
    parent: null,
    created_at: 0,
    entries: [],
  } satisfies Manifest);
  const id = manifestIdOf(bytes);
  const key = manifestKey(id, root);
  if ((await store.head(key)) === null) await store.put(key, bytes);
  return id;
}

/** Normalize a browse path to an absolute, slash-collapsed, no-trailing-slash
 *  form (except root `/`). `""`/`"."`/`"/"` all map to `/`. */
export function normalizePath(input: string): string {
  let p = input.trim();
  if (p === '' || p === '.') return '/';
  if (!p.startsWith('/')) p = '/' + p;
  // Collapse duplicate slashes.
  p = p.replace(/\/+/g, '/');
  // Drop a trailing slash except for root.
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
}

function parentDir(path: string): string {
  if (path === '/') return '/';
  const idx = path.lastIndexOf('/');
  return idx <= 0 ? '/' : path.slice(0, idx);
}

function baseName(path: string): string {
  if (path === '/') return '/';
  const idx = path.lastIndexOf('/');
  return path.slice(idx + 1);
}

/** Find the entry for an exact path, or `undefined`. Entries are path-sorted. */
export function findEntry(manifest: Manifest, path: string): ManifestEntry | undefined {
  const target = normalizePath(path);
  return manifest.entries.find((e) => normalizePath(e.path) === target);
}

/**
 * List the immediate children of `dirPath` from the manifest. Root (`/`) is
 * always listable even without an explicit entry. Throws `PathNotFound` if the
 * path names something that is neither the root, a directory entry, nor an
 * implied parent of some entry.
 */
export function listDirectory(manifest: Manifest, dirPath: string): DirListing {
  const dir = normalizePath(dirPath);

  const entry = findEntry(manifest, dir);
  if (dir !== '/' && entry && entry.kind !== 'dir') {
    throw new NotAFile(`not a directory: ${dir}`);
  }

  const prefix = dir === '/' ? '/' : dir + '/';
  const children = new Map<string, DirEntry>();
  let sawAnythingUnderDir = dir === '/' || entry !== undefined;

  for (const e of manifest.entries) {
    const p = normalizePath(e.path);
    if (p === dir) continue;
    if (!p.startsWith(prefix)) continue;
    sawAnythingUnderDir = true;
    if (parentDir(p) === dir) {
      // A direct child: surface it exactly as recorded.
      children.set(p, {
        name: baseName(p),
        path: p,
        kind: e.kind,
        mode: e.mode,
        size: e.size,
        symlink_target: e.symlink_target,
      });
    } else {
      // A deeper descendant implies an intermediate directory child.
      const rest = p.slice(prefix.length);
      const seg = rest.slice(0, rest.indexOf('/'));
      const childPath = prefix + seg;
      if (!children.has(childPath)) {
        children.set(childPath, {
          name: seg,
          path: childPath,
          kind: 'dir',
          mode: 0o040755,
          size: 0,
          symlink_target: null,
        });
      }
    }
  }

  if (!sawAnythingUnderDir) throw new PathNotFound(dir);

  const entries = [...children.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
  return { path: dir, entries };
}

/**
 * Read a small file's bytes: fetch each chunk the manifest names, decompress it,
 * verify its blake3, and concatenate the plaintext **in ref order**.
 *
 * Throws `PathNotFound`/`NotAFile`/`FileTooLarge`/`ManifestNotFound` for the
 * request, and a {@link ChunkReadError} when the store cannot produce
 * trustworthy bytes. Nothing is returned unless every chunk verified and the
 * assembled length is exactly the size the manifest recorded — a caller can
 * therefore never emit a partially-written or partially-verified body.
 *
 * Never wakes the computer (spec 8.4).
 */
export async function readFile(
  store: R2Bucket,
  manifest: Manifest,
  filePath: string,
  root = '',
): Promise<Uint8Array> {
  const entry = findEntry(manifest, filePath);
  if (!entry) throw new PathNotFound(normalizePath(filePath));
  if (entry.kind !== 'file') throw new NotAFile(normalizePath(filePath));
  if (entry.size > MAX_INLINE_FILE_BYTES) throw new FileTooLarge(normalizePath(filePath));

  const out = new Uint8Array(entry.size);
  let cursor = 0;
  // Content-defined chunking makes a repeated region ONE chunk referenced many
  // times, so a file of repeated blocks would otherwise fetch (and re-verify) the
  // same object once per reference. Bounded by the file, which is bounded by
  // MAX_INLINE_FILE_BYTES.
  const fetched = new Map<string, Uint8Array>();
  for (const ref of entry.chunks) {
    // `ref.len` is the PLAINTEXT length; the stored object is a zstd frame whose
    // size has nothing to do with it. Trusting the ref for the copy while the
    // chunk holds something else is how a corrupt file becomes a silent one, so
    // `getChunk` refuses any chunk whose verified plaintext is not `ref.len`.
    let plain = fetched.get(ref.chunk);
    if (plain === undefined) {
      plain = await getChunk(store, ref.chunk, ref.len, root);
      fetched.set(ref.chunk, plain);
    } else if (plain.length !== ref.len) {
      // The same chunk named with two different lengths: one of them is a lie.
      throw new ChunkLengthMismatch(ref.chunk, ref.len, plain.length);
    }
    if (cursor + plain.length > out.length) {
      // The refs sum to more than the recorded size: refuse before writing past
      // what the manifest promised.
      throw new ManifestSizeMismatch(entry.path, entry.size, cursor + plain.length);
    }
    out.set(plain, cursor);
    cursor += plain.length;
  }
  if (cursor !== entry.size) {
    // The manifest disagrees with itself; refuse rather than serve garbage.
    throw new ManifestSizeMismatch(entry.path, entry.size, cursor);
  }
  return out;
}
