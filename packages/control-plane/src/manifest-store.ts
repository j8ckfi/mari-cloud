// Reading a computer's filesystem from the chunk store WITHOUT waking it
// (spec 8.4). For a non-AWAKE computer the file browser serves directory
// listings and small file reads straight from the manifest at the head plus
// on-demand chunk fetches from R2. No substrate is touched.
//
// The TS side only READS manifests (decisions.md); `mari-core` is the writer.
// Object layout is contracts.md §9.

import { decodeManifest, type Manifest, type ManifestEntry } from '@mari/shared';

/** Store object keys (contracts.md §9). */
export function manifestKey(id: string): string {
  return `manifests/${id}.cbor`;
}

/** Chunk key: `chunks/{id[0..2]}/{id}` — the 2-hex prefix shards the keyspace. */
export function chunkKey(id: string): string {
  return `chunks/${id.slice(0, 2)}/${id}`;
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
export async function loadManifest(store: R2Bucket, id: string): Promise<Manifest> {
  const obj = await store.get(manifestKey(id));
  if (obj === null) throw new ManifestNotFound(id);
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return decodeManifest(bytes);
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
 * Read a small file's bytes by fetching and concatenating its chunks from R2.
 * Throws `PathNotFound`/`NotAFile`/`FileTooLarge`/`ManifestNotFound` as apt.
 * Never wakes the computer (spec 8.4).
 */
export async function readFile(
  store: R2Bucket,
  manifest: Manifest,
  filePath: string,
): Promise<Uint8Array> {
  const entry = findEntry(manifest, filePath);
  if (!entry) throw new PathNotFound(normalizePath(filePath));
  if (entry.kind !== 'file') throw new NotAFile(normalizePath(filePath));
  if (entry.size > MAX_INLINE_FILE_BYTES) throw new FileTooLarge(normalizePath(filePath));

  const out = new Uint8Array(entry.size);
  let cursor = 0;
  for (const ref of entry.chunks) {
    const obj = await store.get(chunkKey(ref.chunk));
    if (obj === null) throw new PathNotFound(`missing chunk ${ref.chunk}`);
    const bytes = new Uint8Array(await obj.arrayBuffer());
    out.set(bytes.subarray(0, ref.len), cursor);
    cursor += ref.len;
  }
  if (cursor !== entry.size) {
    // The manifest and chunks disagree; refuse rather than serve garbage.
    throw new PathNotFound(`chunk length mismatch for ${entry.path}`);
  }
  return out;
}
