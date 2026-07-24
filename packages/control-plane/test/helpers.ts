// Test harness: real DO/D1/R2 bindings via @cloudflare/vitest-pool-workers.
// Provides fake supervisor + client WebSocket peers that speak the real wire
// protocol (framed CBOR supervisor-side, discrete CBOR client-side) against a
// real ComputerDO, so assertions are byte-level and behavior-level, not mocks.

import { env } from 'cloudflare:test';
import {
  FrameReader,
  encodeFrame,
  encodeCbor,
  decodeCbor,
  PROTO_VERSION,
} from '@mari/shared';
import { applySchema } from '../src/db/apply';

export { env };

export function computerStub(id: string) {
  return env.COMPUTER.get(env.COMPUTER.idFromName(id));
}

export async function ensureSchema(): Promise<void> {
  await applySchema(env.DB);
}

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
