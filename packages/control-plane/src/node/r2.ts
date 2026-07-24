// The R2 equivalent for Node: a filesystem object store (spec 3.3 "R2 or an
// S3-compatible store"), keyed exactly as contracts.md §9:
//
//   chunks/{id[0..2]}/{id}          manifests/{id}.cbor
//   heat/{computer}.cbor            journal/{computer}/{run}/{seq}.seg
//
// The layout matters: `marid` opens the SAME directory through opendal's `fs`
// service (`MARI_STORE=fs:///store`, crates/marid/src/store_uri.rs), which maps
// an object key onto `root/key` byte for byte. So the supervisor writes a
// manifest and the control plane reads it back with no translation layer — the
// chunk store is the home of the computer (spec §2) and both sides see one home.
//
// Writes go through a temp file + rename, because the supervisor may be reading
// the same key concurrently and a half-written manifest is indistinguishable
// from a corrupt one.

import { createHash, randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, sep } from 'node:path';

/** Metadata R2 returns for an object. */
export interface NodeR2Object {
  key: string;
  size: number;
  etag: string;
  httpEtag: string;
  uploaded: Date;
  version: string;
}

export interface NodeR2ObjectBody extends NodeR2Object {
  arrayBuffer(): Promise<ArrayBuffer>;
  bytes(): Promise<Uint8Array>;
  text(): Promise<string>;
  json<T>(): Promise<T>;
  readonly body: ReadableStream<Uint8Array>;
}

export interface NodeR2ListOptions {
  prefix?: string;
  limit?: number;
  cursor?: string;
  delimiter?: string;
}

export interface NodeR2Objects {
  objects: NodeR2Object[];
  truncated: boolean;
  cursor?: string;
  delimitedPrefixes: string[];
}

/** A key must stay inside the store root: no absolute paths, no `..`. */
function assertSafeKey(key: string): void {
  if (key === '' || key.startsWith('/') || key.includes('\\')) {
    throw new Error(`unsafe object key: ${JSON.stringify(key)}`);
  }
  for (const part of key.split('/')) {
    if (part === '..' || part === '.') throw new Error(`unsafe object key: ${JSON.stringify(key)}`);
  }
}

function toBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const v = value as ArrayBufferView;
    return new Uint8Array(v.buffer.slice(v.byteOffset, v.byteOffset + v.byteLength));
  }
  if (typeof value === 'string') return new TextEncoder().encode(value);
  throw new TypeError('unsupported R2 value type');
}

export class NodeR2Bucket {
  constructor(readonly root: string) {}

  #path(key: string): string {
    assertSafeKey(key);
    return join(this.root, ...key.split('/'));
  }

  async put(key: string, value: unknown): Promise<NodeR2Object> {
    const bytes = toBytes(value);
    const file = this.#path(key);
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
    await writeFile(tmp, bytes);
    await rename(tmp, file);
    return this.#meta(key, bytes.length, bytes, new Date());
  }

  async get(key: string): Promise<NodeR2ObjectBody | null> {
    let bytes: Uint8Array;
    let mtime = new Date(0);
    try {
      const file = this.#path(key);
      const buf = await readFile(file);
      bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
      mtime = (await stat(file)).mtime;
    } catch {
      return null;
    }
    const base = this.#meta(key, bytes.length, bytes, mtime);
    const copy = () => {
      const ab = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(ab).set(bytes);
      return ab;
    };
    return {
      ...base,
      arrayBuffer: async () => copy(),
      bytes: async () => new Uint8Array(copy()),
      text: async () => new TextDecoder().decode(bytes),
      json: async <T,>() => JSON.parse(new TextDecoder().decode(bytes)) as T,
      get body(): ReadableStream<Uint8Array> {
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(copy()));
            controller.close();
          },
        });
      },
    };
  }

  async head(key: string): Promise<NodeR2Object | null> {
    try {
      const file = this.#path(key);
      const info = await stat(file);
      const buf = await readFile(file);
      return this.#meta(key, info.size, new Uint8Array(buf), info.mtime);
    } catch {
      return null;
    }
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of Array.isArray(keys) ? keys : [keys]) {
      await rm(this.#path(key), { force: true });
    }
  }

  async list(options: NodeR2ListOptions = {}): Promise<NodeR2Objects> {
    const all = await this.#walk(this.root, '');
    all.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const prefix = options.prefix ?? '';
    const after = options.cursor ?? '';
    const filtered = all.filter((o) => o.key.startsWith(prefix) && o.key > after);
    const limit = options.limit ?? 1000;
    const page = filtered.slice(0, limit);
    const truncated = filtered.length > page.length;
    const out: NodeR2Objects = {
      objects: page,
      truncated,
      delimitedPrefixes: [],
    };
    if (truncated) out.cursor = page[page.length - 1]?.key;
    return out;
  }

  async #walk(dir: string, prefix: string): Promise<NodeR2Object[]> {
    let entries: Dirent[];
    try {
      entries = (await readdir(dir, { withFileTypes: true })) as unknown as Dirent[];
    } catch {
      return [];
    }
    const out: NodeR2Object[] = [];
    for (const entry of entries) {
      const name = entry.name;
      if (name.endsWith('.tmp')) continue;
      const child = join(dir, name);
      const key = prefix === '' ? name : `${prefix}/${name}`;
      if (entry.isDirectory()) {
        out.push(...(await this.#walk(child, key)));
      } else if (entry.isFile()) {
        const info = await stat(child);
        out.push({
          key: key.split(sep).join('/'),
          size: info.size,
          etag: '',
          httpEtag: '',
          uploaded: info.mtime,
          version: String(info.mtimeMs),
        });
      }
    }
    return out;
  }

  #meta(key: string, size: number, bytes: Uint8Array, uploaded: Date): NodeR2Object {
    const etag = createHash('md5').update(bytes).digest('hex');
    return { key, size, etag, httpEtag: `"${etag}"`, uploaded, version: etag };
  }
}

/** Open (creating if absent) the filesystem chunk store at `root`. */
export async function openStore(root: string): Promise<NodeR2Bucket> {
  await mkdir(root, { recursive: true });
  return new NodeR2Bucket(root);
}
