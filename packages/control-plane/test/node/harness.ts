// Harness for the private-instance (Node runtime) suites.
//
// Everything here drives the REAL thing: a real HTTP server on a real port, a
// real `ws` connection speaking the real framed-CBOR protocol (contracts.md §2),
// a real SQLite-backed Durable Object, and a real filesystem chunk store. There
// are no mocks below this line; the only thing a suite may substitute is the
// SUBSTRATE, and the Docker suite does not even do that.

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import {
  FrameReader,
  PROTO_VERSION,
  decodeCbor,
  encodeCbor,
  encodeFrame,
} from '@mari/shared';
import { boot, type BootOptions, type NodeInstance } from '../../src/node.js';

export const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Poll `pred` until true, or throw. Every wait in these suites is bounded. */
export async function waitUntil(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 10_000,
  label = 'condition',
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await pred()) return;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await delay(50);
  }
}

/** Poll until `fn` returns a non-null value, then return it. */
export async function waitFor<T>(
  fn: () => Promise<T | null | undefined> | T | null | undefined,
  timeoutMs = 10_000,
  label = 'value',
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== null && v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}`);
    await delay(50);
  }
}

/**
 * A scratch directory the DOCKER DAEMON can also see. On macOS the daemon runs
 * in a VM that shares `$HOME` but not `/tmp`, so a chunk store bind-mounted from
 * `/tmp` would silently be an EMPTY directory inside the container — the exact
 * failure mode that makes a "restored" file look missing. Under `$HOME` both
 * sides see one store.
 */
export async function makeSharedDir(prefix: string): Promise<string> {
  const root = process.env.MARI_NODE_E2E_DIR ?? join(homedir(), '.mari', 'node-e2e');
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root, { recursive: true });
  return mkdtemp(join(root, `${prefix}-`));
}

/** A scratch directory for suites that never bind-mount into a container. */
export function makeLocalDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `${prefix}-`));
}

export interface TestInstanceOptions extends BootOptions {
  devAuth?: boolean;
  devSeed?: boolean;
  warmIdleMs?: number;
  coldIdleMs?: number;
}

/** Boot a private instance on an ephemeral port. */
export async function startInstance(options: TestInstanceOptions = {}): Promise<NodeInstance> {
  const { devAuth = true, devSeed = true, warmIdleMs, coldIdleMs, ...bootOptions } = options;
  process.env.DEV_AUTH = devAuth ? '1' : '0';
  process.env.DEV_SEED = devSeed ? '1' : '0';
  process.env.AUTH_SECRET = 'node-suite-secret-not-for-prod';
  if (warmIdleMs !== undefined) process.env.WARM_IDLE_MS = String(warmIdleMs);
  else delete process.env.WARM_IDLE_MS;
  if (coldIdleMs !== undefined) process.env.COLD_IDLE_MS = String(coldIdleMs);
  else delete process.env.COLD_IDLE_MS;
  delete process.env.BASE_URL;
  delete process.env.MARI_SUPERVISOR_URL;
  return boot({
    port: 0,
    hostname: '127.0.0.1',
    webDir: null,
    log: () => {},
    ...bootOptions,
  });
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// HTTP helpers (real fetch against the real server)
// ---------------------------------------------------------------------------

export interface Session {
  cookie: string;
  computerId: string;
  manifest: string;
}

/** Run the dev seed and return a usable session cookie + seeded computer. */
export async function seedSession(base: string): Promise<Session> {
  const res = await fetch(`${base}/api/dev/seed`, { method: 'POST' });
  if (res.status !== 200) throw new Error(`seed failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { computer: { id: string }; manifest: string };
  const setCookie = res.headers.get('set-cookie') ?? '';
  return {
    cookie: setCookie.split(';')[0] ?? '',
    computerId: body.computer.id,
    manifest: body.manifest,
  };
}

export async function api<T>(
  base: string,
  cookie: string,
  path: string,
  init: RequestInit = {},
): Promise<{ status: number; body: T }> {
  const headers = new Headers(init.headers);
  headers.set('Cookie', cookie);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  const res = await fetch(`${base}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // non-JSON body (file reads); leave as text
  }
  return { status: res.status, body: body as T };
}

// ---------------------------------------------------------------------------
// Wire peers (real WebSocket clients)
// ---------------------------------------------------------------------------

interface Waiter {
  pred: (m: WireMessage) => boolean;
  resolve: (m: WireMessage) => void;
  reject: (e: unknown) => void;
  timer: NodeJS.Timeout;
}

/** A decoded protocol message: `{ t, c }` (contracts.md §1). */
export interface WireMessage {
  t: string;
  c?: Record<string, unknown>;
  [key: string]: unknown;
}

class MessageQueue {
  readonly all: WireMessage[] = [];
  #pending: WireMessage[] = [];
  #waiters: Waiter[] = [];

  push(m: WireMessage): void {
    this.all.push(m);
    for (let i = 0; i < this.#waiters.length; i++) {
      const w = this.#waiters[i] as Waiter;
      if (w.pred(m)) {
        this.#waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(m);
        return;
      }
    }
    this.#pending.push(m);
  }

  waitFor(pred: (m: WireMessage) => boolean, timeoutMs = 15_000): Promise<WireMessage> {
    for (let i = 0; i < this.#pending.length; i++) {
      if (pred(this.#pending[i] as WireMessage)) {
        return Promise.resolve(this.#pending.splice(i, 1)[0] as WireMessage);
      }
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.#waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.#waiters.splice(idx, 1);
        reject(new Error(`timeout waiting for message (seen: ${this.all.map((m) => m.t).join(',')})`));
      }, timeoutMs);
      this.#waiters.push({ pred, resolve, reject, timer });
    });
  }

  waitForTag(tag: string, timeoutMs = 15_000): Promise<WireMessage> {
    return this.waitFor((m) => m.t === tag, timeoutMs);
  }

  countTag(tag: string): number {
    return this.all.filter((m) => m.t === tag).length;
  }
}

function open(url: string, headers?: Record<string, string>): Promise<WebSocket> {
  const ws = new WebSocket(url, headers ? { headers } : undefined);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => {
      reject(new Error(`upgrade refused: ${res.statusCode}`));
    });
  });
}

/** A supervisor peer: length-framed CBOR both ways (contracts.md §2). */
export class WireSupervisor {
  readonly recv = new MessageQueue();
  #reader = new FrameReader();

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      this.#reader.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      let body: Uint8Array | null;
      while ((body = this.#reader.nextBody()) !== null) {
        this.recv.push(decodeCbor(body) as WireMessage);
      }
    });
  }

  static async connect(base: string, computerId: string): Promise<WireSupervisor> {
    const url = base.replace(/^http/, 'ws');
    return new WireSupervisor(await open(`${url}/supervisor/${encodeURIComponent(computerId)}`));
  }

  send(msg: unknown): void {
    this.ws.send(Buffer.from(encodeFrame(msg)));
  }

  async handshake(computerId: string, epoch: number, token: string): Promise<WireMessage> {
    this.send({
      t: 'hello',
      c: { computer: computerId, epoch, token, proto_version: PROTO_VERSION },
    });
    return this.recv.waitForTag('hello_ack');
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

/** A browser attach peer: discrete CBOR both ways (contracts.md §7). */
export class WireClient {
  readonly recv = new MessageQueue();

  private constructor(readonly ws: WebSocket) {
    ws.on('message', (data: Buffer) => {
      this.recv.push(
        decodeCbor(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) as WireMessage,
      );
    });
  }

  static async connect(base: string, computerId: string, cookie: string): Promise<WireClient> {
    const url = base.replace(/^http/, 'ws');
    return new WireClient(
      await open(`${url}/attach/${encodeURIComponent(computerId)}`, { Cookie: cookie }),
    );
  }

  send(msg: unknown): void {
    this.ws.send(Buffer.from(encodeCbor(msg)));
  }

  attach(run: string, cols = 80, rows = 24): void {
    this.send({ t: 'attach', run, cols, rows });
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closed */
    }
  }
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function fromBase64(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'));
}
