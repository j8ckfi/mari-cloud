// The private-instance HTTP + WebSocket server (spec 11.2).
//
// It serves exactly what the Workers entry serves — `handleFetch` (wake proxy,
// then the shared Hono app) — plus the two things a Worker gets for free from
// the platform:
//
//   * **WebSocket upgrades.** `/supervisor/:id` (framed CBOR, contracts.md §2)
//     and `/attach/:id` (discrete CBOR, §7) are terminated by the Durable
//     Object, which answers with a `101` carrying one half of a
//     `WebSocketPair`. Here that half is bridged onto a real `ws` connection,
//     byte for byte, so `marid` and the browser speak to the same DO code.
//   * **The web application.** A private instance is one origin: the built SPA
//     is served for every non-API path (spec 8.x is one app, `/api` and
//     `/attach` are its backend).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import type { Duplex } from 'node:stream';
import { getRequestListener } from '@hono/node-server';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { handleFetch } from '../handler.js';
import { parsePreviewHost } from '../host.js';
import type { Env } from '../types.js';
import type { PairSocket } from './websocket-pair.js';
import type { NodeConfig } from './env.js';

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/** Paths the control plane owns; never served from the static bundle. */
const API_PREFIXES = ['/api/', '/attach/', '/supervisor/'];

function isApiPath(pathname: string): boolean {
  return pathname === '/api' || API_PREFIXES.some((p) => pathname.startsWith(p));
}

const nodeCtx = {
  waitUntil(promise: Promise<unknown>) {
    void Promise.resolve(promise).catch(() => undefined);
  },
  passThroughOnException() {},
} as unknown as ExecutionContext;

/** Serve `webDir` for a GET/HEAD that is not an API path; SPA-fallback to
 *  index.html so client-side routes deep-link. */
async function serveStatic(request: Request, webDir: string): Promise<Response | null> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return null;
  const url = new URL(request.url);
  if (isApiPath(url.pathname)) return null;

  const rel = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  const candidates = rel === '/' || rel === '' ? ['index.html'] : [rel.slice(1), 'index.html'];
  for (const candidate of candidates) {
    const file = join(webDir, candidate);
    if (!file.startsWith(webDir)) continue; // path traversal
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      const body = await readFile(file);
      const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream';
      const copy = new ArrayBuffer(body.byteLength);
      new Uint8Array(copy).set(body);
      return new Response(request.method === 'HEAD' ? null : copy, {
        status: 200,
        headers: {
          'content-type': type,
          'content-length': String(body.byteLength),
          // index.html must not be cached, or a redeploy serves a stale app.
          'cache-control': candidate === 'index.html' ? 'no-cache' : 'public, max-age=3600',
        },
      });
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** The one fetch entry point: static first (non-API), then the shared pipeline. */
export function createFetchHandler(env: Env, config: NodeConfig) {
  return async (request: Request): Promise<Response> => {
    if (config.webDir) {
      // A preview host (`{port}--{computer}--{user}.zone`) is a wake-proxy
      // request even for `/`; it must never be answered with the SPA.
      const host = new URL(request.url).host;
      if (!parsePreviewHost(host, env.PREVIEW_ZONE ?? 'mari.sh')) {
        const stat = await serveStatic(request, config.webDir);
        if (stat) return stat;
      }
    }
    return handleFetch(request, env, nodeCtx);
  };
}

/** Bridge a Durable Object socket half onto a real `ws` connection. */
export function bridgeSocket(pair: PairSocket, socket: WsSocket): void {
  pair.accept();
  pair.addEventListener('message', (event) => {
    const data = event.data;
    if (socket.readyState !== socket.OPEN) return;
    if (typeof data === 'string') socket.send(data);
    else if (data instanceof ArrayBuffer) socket.send(Buffer.from(data));
    else if (ArrayBuffer.isView(data)) {
      const view = data as ArrayBufferView;
      socket.send(Buffer.from(view.buffer, view.byteOffset, view.byteLength));
    }
  });
  pair.addEventListener('close', (event) => {
    try {
      socket.close(normalizeCloseCode(event.code), event.reason ?? '');
    } catch {
      socket.terminate();
    }
  });
  socket.on('message', (data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
    const buf = Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data as Buffer);
    // `send` on this half delivers a `message` event on the DO's half.
    pair.send(
      isBinary
        ? new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
        : buf.toString('utf8'),
    );
  });
  socket.on('close', (code: number, reason: Buffer) => {
    pair.close(normalizeCloseCode(code), reason?.toString('utf8') ?? '');
  });
  socket.on('error', () => pair.close(1011, 'socket error'));
}

/** 1005/1006 are status codes a peer may never SEND; map them to 1000. */
function normalizeCloseCode(code: number | undefined): number {
  if (code === undefined || code === 1005 || code === 1006 || code < 1000 || code > 4999) {
    return 1000;
  }
  return code;
}

/** Build a `Request` for an HTTP upgrade (`ws` gives us only the raw message). */
function upgradeRequest(req: IncomingMessage): Request {
  const host = req.headers.host ?? 'localhost';
  const url = new URL(req.url ?? '/', `http://${host}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) headers.append(key, v);
    else headers.set(key, value);
  }
  return new Request(url, { method: 'GET', headers });
}

export interface NodeServerHandle {
  server: Server;
  port: number;
  url: string;
  close(): Promise<void>;
}

/** Start the HTTP+WS server. Resolves once it is accepting connections. */
export async function startServer(
  env: Env,
  config: NodeConfig,
  fetchHandler = createFetchHandler(env, config),
): Promise<NodeServerHandle> {
  // `overrideGlobalObjects: false` is REQUIRED, not a preference: the adapter
  // otherwise installs its own lightweight `Response` over the global with a
  // non-configurable property, which both discards the upgrade-capable
  // `Response` (WebSocketPair, status 101) and defers status validation until
  // the body is read — turning a Durable Object's 101 into a RangeError.
  const listener = getRequestListener(fetchHandler, { overrideGlobalObjects: false });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void listener(req, res);
  });
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      try {
        const response = (await fetchHandler(upgradeRequest(req))) as Response & {
          webSocket?: PairSocket | null;
        };
        const pair = response.webSocket ?? null;
        if (response.status !== 101 || !pair) {
          const status = response.status === 101 ? 500 : response.status;
          const body = await response.text().catch(() => '');
          socket.write(
            `HTTP/1.1 ${status} ${status === 401 ? 'Unauthorized' : 'Bad Request'}\r\n` +
              `content-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
          );
          socket.destroy();
          return;
        }
        wss.handleUpgrade(req, socket, head, (client: WsSocket) => bridgeSocket(pair, client));
      } catch (err) {
        if (process.env.MARI_DEBUG === '1') console.error('[mari] upgrade failed', err);
        socket.destroy();
      }
    })();
  });

  await new Promise<void>((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.hostname, () => {
      server.removeListener('error', reject);
      resolvePromise();
    });
  });

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  return {
    server,
    port,
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolvePromise) => {
        for (const client of wss.clients) client.terminate();
        wss.close();
        server.closeAllConnections?.();
        server.close(() => resolvePromise());
      }),
  };
}
