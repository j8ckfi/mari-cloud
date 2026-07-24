// A DEVICE: everything one client machine holds open against the instance.
//
// Spec 1.3 turns on the difference between a user and a connection, so the
// suite needs the connection side modelled honestly. A `Device` owns:
//
//   * its own HTTP connection pool (`http.Agent`) — pooled keep-alive sockets,
//     like a browser, so "disconnect" has to actually tear sockets down rather
//     than merely stop asking;
//   * at most one `/api/events` SSE stream (contracts.md Appendix C.4);
//   * at most one `/attach/:computer` WebSocket (contracts.md §7).
//
// `disconnect()` closes all three. A second device is constructed with the SAME
// session cookie and a FRESH agent: that is "the user can see the results from
// each device" expressed in sockets.
//
// Requests go through `node:http` rather than `fetch` deliberately: `fetch`
// hides its socket pool inside undici, and this suite has to be able to prove —
// from the server's side — that a device holds nothing open.

import { Agent, request as httpRequest, type IncomingMessage } from 'node:http';
import { WebSocket } from 'ws';
import { decodeCbor, encodeCbor } from '@mari/shared';

export interface ApiResponse<T> {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed JSON when the body is JSON, else the raw text. */
  body: T;
  /** The exact response bytes (file reads are binary). */
  bytes: Uint8Array;
}

/** One decoded DO -> client message (contracts.md §7.2). */
export interface AttachMessage {
  t: string;
  run?: string;
  offset?: number;
  bytes?: Uint8Array;
  alive?: boolean;
  exitCode?: number | null;
  [k: string]: unknown;
}

/** One parsed SSE record: `event: <type>` + `data: <json>`. */
export interface SseEvent {
  type: string;
  data: Record<string, unknown>;
}

function readBody(res: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (c: Buffer) => chunks.push(c));
    res.on('end', () => {
      const buf = Buffer.concat(chunks);
      resolve(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
    });
    res.on('error', reject);
  });
}

export class Device {
  readonly name: string;
  readonly base: string;
  cookie: string;
  #agent: Agent;
  #sse: { req: ReturnType<typeof httpRequest>; text: string; events: SseEvent[] } | null = null;
  #ws: WebSocket | null = null;
  readonly attachMessages: AttachMessage[] = [];

  constructor(name: string, base: string, cookie = '') {
    this.name = name;
    this.base = base;
    this.cookie = cookie;
    // keepAlive mirrors a browser: sockets linger after a response, so a
    // "disconnect" that only stops issuing requests would leave them open.
    this.#agent = new Agent({ keepAlive: true, maxSockets: 8 });
  }

  // ---- plain HTTP ---------------------------------------------------------

  async request<T = unknown>(
    method: string,
    path: string,
    init: { body?: string | Uint8Array; headers?: Record<string, string> } = {},
  ): Promise<ApiResponse<T>> {
    const url = new URL(path, this.base);
    const headers: Record<string, string> = { ...init.headers };
    if (this.cookie) headers['cookie'] = this.cookie;
    if (init.body !== undefined && headers['content-type'] === undefined) {
      headers['content-type'] =
        typeof init.body === 'string' ? 'application/json' : 'application/octet-stream';
    }
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          agent: this.#agent,
          method,
          hostname: url.hostname,
          port: url.port,
          path: `${url.pathname}${url.search}`,
          headers,
        },
        (res) => {
          void readBody(res).then((bytes) => {
            const text = Buffer.from(bytes).toString('utf8');
            let body: unknown = text;
            try {
              body = JSON.parse(text);
            } catch {
              // Not JSON (a file read); the raw text/bytes stand.
            }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: body as T, bytes });
          }, reject);
        },
      );
      req.on('error', reject);
      if (init.body !== undefined) req.write(init.body);
      req.end();
    });
  }

  get<T>(path: string): Promise<ApiResponse<T>> {
    return this.request<T>('GET', path);
  }

  postJson<T>(path: string, body: unknown = {}): Promise<ApiResponse<T>> {
    return this.request<T>('POST', path, { body: JSON.stringify(body) });
  }

  // ---- SSE (`GET /api/events`, contracts.md Appendix C.4) -----------------

  /** Open the fleet event stream. Resolves once the server has answered 200. */
  async openEvents(): Promise<void> {
    if (this.#sse) throw new Error(`${this.name}: event stream already open`);
    const url = new URL('/api/events', this.base);
    const state = { req: null as unknown as ReturnType<typeof httpRequest>, text: '', events: [] as SseEvent[] };
    await new Promise<void>((resolve, reject) => {
      const req = httpRequest(
        {
          agent: this.#agent,
          method: 'GET',
          hostname: url.hostname,
          port: url.port,
          path: url.pathname,
          headers: { cookie: this.cookie, accept: 'text/event-stream' },
        },
        (res) => {
          if (res.statusCode !== 200) {
            reject(new Error(`${this.name}: /api/events -> ${res.statusCode}`));
            return;
          }
          const type = String(res.headers['content-type'] ?? '');
          if (!type.includes('text/event-stream')) {
            reject(new Error(`${this.name}: /api/events content-type ${type}`));
            return;
          }
          res.on('data', (chunk: Buffer) => {
            state.text += chunk.toString('utf8');
            let cut = state.text.indexOf('\n\n');
            while (cut !== -1) {
              const record = state.text.slice(0, cut);
              state.text = state.text.slice(cut + 2);
              const typeLine = record.split('\n').find((l) => l.startsWith('event: '));
              const dataLine = record.split('\n').find((l) => l.startsWith('data: '));
              if (typeLine && dataLine) {
                try {
                  state.events.push({
                    type: typeLine.slice('event: '.length),
                    data: JSON.parse(dataLine.slice('data: '.length)) as Record<string, unknown>,
                  });
                } catch {
                  // A malformed record is a failure of the server, not of the
                  // parser; the assertions on `events` will show it as missing.
                }
              }
              cut = state.text.indexOf('\n\n');
            }
          });
          res.on('error', () => undefined);
          resolve();
        },
      );
      req.on('error', reject);
      req.end();
      state.req = req;
    });
    this.#sse = state;
  }

  get sseEvents(): SseEvent[] {
    return this.#sse?.events ?? [];
  }

  // ---- attach WebSocket (contracts.md §7) ---------------------------------

  /** Open the terminal attach socket and attach to `run`. */
  async attach(computerId: string, run: string, cols = 80, rows = 24): Promise<void> {
    if (this.#ws) throw new Error(`${this.name}: attach socket already open`);
    const url = new URL(`/attach/${encodeURIComponent(computerId)}`, this.base);
    url.protocol = 'ws:';
    const ws = new WebSocket(url.toString(), { headers: { Cookie: this.cookie } });
    ws.on('message', (data: Buffer) => {
      try {
        this.attachMessages.push(
          decodeCbor(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)) as AttachMessage,
        );
      } catch {
        // Undecodable frames are a protocol break; assertions on
        // `attachMessages` surface it as a missing message.
      }
    });
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('unexpected-response', (_req, res) => reject(new Error(`upgrade refused: ${res.statusCode}`)));
    });
    this.#ws = ws;
    ws.send(Buffer.from(encodeCbor({ t: 'attach', run, cols, rows })));
  }

  get attachOpen(): boolean {
    return this.#ws !== null && this.#ws.readyState === WebSocket.OPEN;
  }

  /** All bytes this device received as live terminal frames, in arrival order. */
  attachBytes(run: string): Uint8Array {
    const parts = this.attachMessages
      .filter((m) => m.t === 'frame' && m.run === run && m.bytes instanceof Uint8Array)
      .map((m) => m.bytes as Uint8Array);
    const total = parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(total);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }

  // ---- disconnect ---------------------------------------------------------

  /**
   * Close EVERYTHING this device holds: the attach socket, the event stream,
   * and every pooled HTTP socket. After this the server must see nothing from
   * this device — which the suite then verifies from the server's side.
   */
  async disconnect(): Promise<void> {
    if (this.#ws) {
      const ws = this.#ws;
      this.#ws = null;
      await new Promise<void>((resolve) => {
        ws.once('close', () => resolve());
        ws.close();
        setTimeout(() => {
          ws.terminate();
          resolve();
        }, 2_000).unref?.();
      });
    }
    if (this.#sse) {
      this.#sse.req.destroy();
      this.#sse = null;
    }
    this.#agent.destroy();
    // A destroyed agent cannot be reused; a device that reconnects makes a new
    // one, exactly as a reopened browser tab would.
    this.#agent = new Agent({ keepAlive: true, maxSockets: 8 });
  }
}
