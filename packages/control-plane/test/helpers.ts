// Test harness: real DO/D1/R2 bindings via @cloudflare/vitest-pool-workers.
// Provides fake supervisor + client WebSocket peers that speak the real wire
// protocol (framed CBOR supervisor-side, discrete CBOR client-side) against a
// real ComputerDO, so assertions are byte-level and behavior-level, not mocks.

import { env, SELF, runInDurableObject } from 'cloudflare:test';
import { expect } from 'vitest';
import {
  FrameReader,
  encodeFrame,
  encodeCbor,
  decodeCbor,
  PROTO_VERSION,
  type Manifest,
  type ManifestEntry,
} from '@mari/shared';
import { applySchema } from '../src/db/apply';
import { chunkKey, manifestKey } from '../src/manifest-store';
import { toArrayBuffer } from '../src/bytes';
import type { ComputerDO } from '../src/computer-do';

export { env };

export const HOST = 'http://localhost';

export function computerStub(id: string) {
  return env.COMPUTER.get(env.COMPUTER.idFromName(id));
}

export async function ensureSchema(): Promise<void> {
  await applySchema(env.DB);
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Poll `pred` until it is true, or throw after `timeoutMs`. */
export async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await delay(10);
  }
}

/** The substrate driver's recorded operations, in order. */
export async function substrateOps(stub: ReturnType<typeof computerStub>): Promise<string[]> {
  return runInDurableObject(stub, (instance: ComputerDO) =>
    (instance.substrate as { calls: { op: string }[] }).calls.map((c) => c.op),
  );
}

/** Total objects currently in the R2 store (chunks + manifests + segments). */
export async function r2ObjectCount(): Promise<number> {
  let count = 0;
  let cursor: string | undefined;
  do {
    const page = await env.STORE.list(cursor ? { cursor } : undefined);
    count += page.objects.length;
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return count;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toArrayBuffer(bytes));
  let hex = '';
  for (const b of new Uint8Array(digest)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Write a real manifest + its chunks into the R2 store from a `path -> contents`
 * tree, and return the manifest id. Same content-addressing stand-in as the dev
 * seed (SHA-256 for blake3, contracts.md Appendix A) — the diff and file-read
 * paths only require ids to be self-consistent with the chunks they name.
 */
export async function writeManifestTree(tree: Record<string, string>): Promise<string> {
  const enc = new TextEncoder();
  const entries: ManifestEntry[] = [];
  const dirs = new Set<string>();
  for (const p of Object.keys(tree)) {
    const parts = p.split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      dirs.add(cur);
    }
  }
  for (const dir of dirs) {
    entries.push({ path: dir, kind: 'dir', mode: 0o040755, size: 0, symlink_target: null, chunks: [] });
  }
  for (const [path, contents] of Object.entries(tree)) {
    const bytes = enc.encode(contents);
    const id = await sha256Hex(bytes);
    await env.STORE.put(chunkKey(id), bytes);
    entries.push({
      path,
      kind: 'file',
      mode: 0o100644,
      size: bytes.length,
      symlink_target: null,
      chunks: [{ chunk: id, len: bytes.length }],
    });
  }
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const manifest: Manifest = { version: 1, parent: null, created_at: 1_700_000_000, entries };
  const cbor = encodeCbor(manifest);
  const id = await sha256Hex(cbor);
  await env.STORE.put(manifestKey(id), cbor);
  return id;
}

/** Run the dev seed and return a usable session cookie + the seeded computer.
 *  `postRunManifest` is the seed's SECOND manifest (contracts.md Appendix A):
 *  the same tree after a run touched it, for diff/review paths. */
export async function seedSession(): Promise<{
  cookie: string;
  computerId: string;
  manifest: string;
  postRunManifest: string;
}> {
  const res = await SELF.fetch(`${HOST}/api/dev/seed`, { method: 'POST' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    computer: { id: string };
    manifest: string;
    postRunManifest: string;
  };
  const cookie = cookieFromSetCookie(res.headers.get('set-cookie'));
  expect(cookie).toMatch(/=/);
  return {
    cookie,
    computerId: body.computer.id,
    manifest: body.manifest,
    postRunManifest: body.postRunManifest,
  };
}

/** Create a fresh COLD computer through the real API; returns its id. */
export async function createComputer(cookie: string, name: string): Promise<string> {
  const res = await SELF.fetch(`${HOST}/api/computers`, {
    method: 'POST',
    headers: { Cookie: cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/** `GET` an authenticated JSON endpoint. */
export async function apiGet<T>(path: string, cookie: string): Promise<{ status: number; body: T }> {
  const res = await SELF.fetch(`${HOST}${path}`, { headers: { Cookie: cookie } });
  return { status: res.status, body: (await res.json()) as T };
}

/** `POST` JSON to an authenticated endpoint. */
export async function apiPost<T>(
  path: string,
  cookie: string,
  body?: unknown,
): Promise<{ status: number; body: T }> {
  const res = await SELF.fetch(`${HOST}${path}`, {
    method: 'POST',
    headers:
      body === undefined
        ? { Cookie: cookie }
        : { Cookie: cookie, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as T };
}

export function toU8(data: unknown): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const v = data as ArrayBufferView;
    return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  }
  if (typeof data === 'string') return new TextEncoder().encode(data);
  throw new Error('unexpected ws data type');
}

export function bytes(...vals: number[]): Uint8Array {
  return new Uint8Array(vals);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let c = 0;
  for (const p of parts) {
    out.set(p, c);
    c += p.length;
  }
  return out;
}

export function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

interface Waiter {
  pred: (m: any) => boolean;
  resolve: (m: any) => void;
  reject: (e: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** An async matching queue over decoded messages. */
class MessageQueue {
  readonly all: any[] = [];
  #pending: any[] = [];
  #waiters: Waiter[] = [];

  push(m: any): void {
    this.all.push(m);
    for (let i = 0; i < this.#waiters.length; i++) {
      const w = this.#waiters[i]!;
      if (w.pred(m)) {
        this.#waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(m);
        return;
      }
    }
    this.#pending.push(m);
  }

  waitFor(pred: (m: any) => boolean, timeoutMs = 3000): Promise<any> {
    for (let i = 0; i < this.#pending.length; i++) {
      if (pred(this.#pending[i])) return Promise.resolve(this.#pending.splice(i, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.#waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.#waiters.splice(idx, 1);
        reject(new Error('timeout waiting for message'));
      }, timeoutMs);
      this.#waiters.push({ pred, resolve, reject, timer });
    });
  }

  waitForTag(tag: string, timeoutMs = 3000): Promise<any> {
    return this.waitFor((m) => m && m.t === tag, timeoutMs);
  }

  countTag(tag: string): number {
    return this.all.filter((m) => m && m.t === tag).length;
  }
}

async function openSocket(id: string, path: string): Promise<WebSocket> {
  const res = await computerStub(id).fetch(
    new Request(`https://do/${path}`, {
      headers: { Upgrade: 'websocket', 'x-mari-computer': id },
    }),
  );
  const ws = (res as unknown as { webSocket: WebSocket | null }).webSocket;
  if (!ws) throw new Error(`no webSocket on upgrade response (status ${res.status})`);
  ws.accept();
  // Past compatibility_date 2026-04-01 (bumped for the Cloudflare container
  // binding) binary messages are delivered as Blobs, which `toU8` cannot read
  // synchronously. The DO pins its own halves the same way (computer-do.ts).
  ws.binaryType = 'arraybuffer';
  return ws;
}

/** A fake supervisor: framed CBOR both ways (contracts.md §2). */
export class FakeSupervisor {
  readonly recv = new MessageQueue();
  #reader = new FrameReader();

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (event: MessageEvent) => {
      this.#reader.push(toU8(event.data));
      let body: Uint8Array | null;
      while ((body = this.#reader.nextBody()) !== null) {
        this.recv.push(decodeCbor(body));
      }
    });
  }

  static async connect(id: string): Promise<FakeSupervisor> {
    return new FakeSupervisor(await openSocket(id, 'supervisor'));
  }

  send(msg: unknown): void {
    this.ws.send(encodeFrame(msg));
  }

  async handshake(id: string, epoch: number, token: string): Promise<void> {
    this.send({ t: 'hello', c: { computer: id, epoch, token, proto_version: PROTO_VERSION } });
    await this.recv.waitForTag('hello_ack');
  }

  journalFrame(run: string, offset: number, data: Uint8Array): void {
    this.send({ t: 'journal_frame', c: { run, offset, bytes: data } });
  }

  headAdvance(manifest: string, epoch: number): void {
    this.send({ t: 'head_advance_request', c: { manifest, epoch } });
  }

  snapshotWritten(manifest: string, epoch: number, reason: string): void {
    this.send({ t: 'snapshot_written', c: { manifest, epoch, reason } });
  }

  runStarted(run: string, preRunManifest: string): void {
    this.send({ t: 'run_started', c: { run, pre_run_manifest: preRunManifest } });
  }

  runCompleted(
    run: string,
    postRunManifest: string,
    exit: { t: 'exited'; c: { code: number } } | { t: 'signaled'; c: { signal: number } } = {
      t: 'exited',
      c: { code: 0 },
    },
    diff = { added: 0, modified: 0, removed: 0 },
  ): void {
    this.send({
      t: 'run_completed',
      c: { run, exit, post_run_manifest: postRunManifest, diff },
    });
  }

  attention(run: string, kind: 'bell' | 'osc' | 'blocked_read'): void {
    this.send({ t: 'attention', c: { run, kind } });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** A fake client: discrete CBOR both ways (contracts.md §7). */
export class FakeClient {
  readonly recv = new MessageQueue();

  private constructor(readonly ws: WebSocket) {
    ws.addEventListener('message', (event: MessageEvent) => {
      this.recv.push(decodeCbor(toU8(event.data)));
    });
  }

  static async connect(id: string): Promise<FakeClient> {
    return new FakeClient(await openSocket(id, 'client'));
  }

  send(msg: unknown): void {
    this.ws.send(encodeCbor(msg));
  }

  attach(run: string, cols = 80, rows = 24): void {
    this.send({ t: 'attach', run, cols, rows });
  }

  input(run: string, data: Uint8Array): void {
    this.send({ t: 'input', run, bytes: data });
  }

  resize(run: string, cols: number, rows: number): void {
    this.send({ t: 'resize', run, cols, rows });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** Extract a usable `Cookie` header value from a `Set-Cookie` header. */
export function cookieFromSetCookie(setCookie: string | null): string {
  if (!setCookie) return '';
  return setCookie.split(';')[0] ?? '';
}
