// WebSocket attach layer for terminal panes (spec 7.3, contracts.md §7).
//
// A terminal pane opens one AttachClient to the computer's Durable Object. The
// client speaks the discrete-CBOR client<->DO attach protocol from
// `@mari/shared` (NOT the framed supervisor protocol): it sends `attach`,
// `input`, `resize`, `detach`; it receives a `grid` snapshot then live
// `frame`s and `run_status`. The socket reconnects with backoff, and on every
// (re)connect it re-sends `attach` so input never stalls across a substrate
// migration (spec 7.5). Journal offsets let the caller de-duplicate frames it
// already applied after a reconnect.

import { encodeCbor, decodeCbor } from '@mari/shared';
import type {
  ClientToDo,
  DoToClient,
  DoGridSnapshot,
  DoFrame,
  DoRunStatus,
  RunId,
} from '@mari/shared';

export interface AttachHandlers {
  onGrid?(msg: DoGridSnapshot): void;
  onFrame?(msg: DoFrame): void;
  onStatus?(msg: DoRunStatus): void;
  onOpen?(): void;
  onClose?(): void;
  onError?(err: unknown): void;
}

/** Minimal WebSocket surface, so tests can inject a fake. */
export interface SocketLike {
  binaryType: string;
  send(data: ArrayBufferView | ArrayBuffer): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string) => SocketLike;

export interface AttachOptions {
  url: string;
  run: RunId;
  cols: number;
  rows: number;
  handlers: AttachHandlers;
  /** Injectable socket factory; defaults to the global `WebSocket`. */
  socketFactory?: SocketFactory;
  /** Base reconnect delay in ms (doubles up to `maxBackoffMs`). */
  backoffMs?: number;
  maxBackoffMs?: number;
  /** Injectable timers, for deterministic tests. */
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (handle: number) => void;
}

const defaultSocketFactory: SocketFactory = (url) => {
  const ws = new WebSocket(url);
  ws.binaryType = 'arraybuffer';
  return ws as unknown as SocketLike;
};

interface ResolvedAttachOptions extends AttachOptions {
  backoffMs: number;
  maxBackoffMs: number;
  socketFactory: SocketFactory;
  setTimeoutFn: (fn: () => void, ms: number) => number;
  clearTimeoutFn: (handle: number) => void;
}

export class AttachClient {
  #opts: ResolvedAttachOptions;
  #ws: SocketLike | null = null;
  #run: RunId;
  #cols: number;
  #rows: number;
  #closed = false;
  #backoff: number;
  #reconnectHandle: number | null = null;
  /** Highest journal offset applied, so re-delivered frames can be skipped. */
  #appliedOffset = 0;
  /** Whether a grid snapshot has ever been applied (first attach vs. re-attach). */
  #sawGrid = false;

  constructor(opts: AttachOptions) {
    this.#opts = {
      backoffMs: 250,
      maxBackoffMs: 5000,
      socketFactory: defaultSocketFactory,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeoutFn: (h) => clearTimeout(h),
      ...opts,
    };
    this.#run = opts.run;
    this.#cols = opts.cols;
    this.#rows = opts.rows;
    this.#backoff = this.#opts.backoffMs;
  }

  /** Highest journal offset this client has applied. */
  get appliedOffset(): number {
    return this.#appliedOffset;
  }

  /** Open the socket and attach. Idempotent while already connected. */
  connect(): void {
    if (this.#closed || this.#ws !== null) return;
    const ws = this.#opts.socketFactory(this.#opts.url);
    ws.binaryType = 'arraybuffer';
    this.#ws = ws;
    ws.onopen = () => {
      this.#backoff = this.#opts.backoffMs; // reset backoff on a clean open
      this.#sendRaw({ t: 'attach', run: this.#run, cols: this.#cols, rows: this.#rows });
      this.#opts.handlers.onOpen?.();
    };
    ws.onmessage = (ev) => this.#onMessage(ev.data);
    ws.onerror = (err) => this.#opts.handlers.onError?.(err);
    ws.onclose = () => {
      this.#ws = null;
      this.#opts.handlers.onClose?.();
      if (!this.#closed) this.#scheduleReconnect();
    };
  }

  /** Send terminal input bytes (client -> DO -> supervisor PTY). */
  input(bytes: Uint8Array): void {
    this.#sendRaw({ t: 'input', run: this.#run, bytes });
  }

  /** Resize the attached viewport. Remembered for reconnect. */
  resize(cols: number, rows: number): void {
    this.#cols = cols;
    this.#rows = rows;
    this.#sendRaw({ t: 'resize', run: this.#run, cols, rows });
  }

  /** Detach from live frames without tearing down the socket. */
  detach(): void {
    this.#sendRaw({ t: 'detach', run: this.#run });
  }

  /** Permanently close: detach, stop reconnecting, drop the socket. */
  close(): void {
    this.#closed = true;
    if (this.#reconnectHandle !== null) {
      this.#opts.clearTimeoutFn(this.#reconnectHandle);
      this.#reconnectHandle = null;
    }
    if (this.#ws !== null) {
      try {
        this.detach();
      } catch {
        // socket may already be gone
      }
      this.#ws.close();
      this.#ws = null;
    }
  }

  #sendRaw(msg: ClientToDo): void {
    const ws = this.#ws;
    if (ws === null) return;
    ws.send(encodeCbor(msg));
  }

  #onMessage(data: unknown): void {
    const bytes = toBytes(data);
    if (bytes === null) return;
    let decoded: unknown;
    try {
      decoded = decodeCbor(bytes);
    } catch (err) {
      this.#opts.handlers.onError?.(err);
      return;
    }
    const msg = asDoToClient(decoded);
    if (msg === null) return;
    switch (msg.t) {
      case 'grid':
        // A RE-ATTACH replays the grid the DO already sent us. If nothing was
        // missed while the socket was down (the snapshot's base offset is not
        // beyond what this client already applied), the terminal's buffer is
        // ALREADY the truth: repainting would clear the viewport for no reason
        // and a caller that resets scrollback on a grid would lose history over
        // a network blip. So a redundant snapshot is dropped and the applied
        // offset keeps its high-water mark — later frames still de-duplicate
        // by offset exactly as before. A snapshot from BEYOND our offset means
        // output happened while we were away, and only then do we repaint.
        if (this.#sawGrid && msg.baseOffset <= this.#appliedOffset) return;
        this.#sawGrid = true;
        this.#appliedOffset = msg.baseOffset;
        this.#opts.handlers.onGrid?.(msg);
        break;
      case 'frame':
        // Skip a frame we already applied (possible after a reconnect replay).
        if (msg.offset < this.#appliedOffset) return;
        this.#appliedOffset = msg.offset + msg.bytes.length;
        this.#opts.handlers.onFrame?.(msg);
        break;
      case 'run_status':
        this.#opts.handlers.onStatus?.(msg);
        break;
    }
  }

  #scheduleReconnect(): void {
    if (this.#reconnectHandle !== null) return;
    const delay = this.#backoff;
    this.#backoff = Math.min(this.#backoff * 2, this.#opts.maxBackoffMs);
    this.#reconnectHandle = this.#opts.setTimeoutFn(() => {
      this.#reconnectHandle = null;
      this.connect();
    }, delay);
  }
}

function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return null;
}

const DO_TAGS = new Set<DoToClient['t']>(['grid', 'frame', 'run_status']);

/** Narrow a decoded value to a DoToClient message, or null. */
export function asDoToClient(value: unknown): DoToClient | null {
  if (typeof value !== 'object' || value === null) return null;
  const t = (value as { t?: unknown }).t;
  if (typeof t !== 'string' || !DO_TAGS.has(t as DoToClient['t'])) return null;
  return value as DoToClient;
}

/** Build the attach WebSocket URL for a computer from the current origin. */
export function attachUrl(computer: string, origin?: { protocol: string; host: string }): string {
  const loc = origin ?? { protocol: globalThis.location.protocol, host: globalThis.location.host };
  const proto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${loc.host}/attach/${encodeURIComponent(computer)}`;
}
