// The shared request pipeline: wake proxy first (a preview host is not an API
// path, spec 8.3/8.5), then the REST app. Both the Workers entry (worker.ts)
// and the Node entry (node.ts) call `handleFetch`.

import { createApp } from './app';
import { parsePreviewHost } from './host';
import { makeAuth } from './auth';
import { getOwnedComputer } from './db/fleet';
import type { Env } from './types';

const app = createApp();

/** One WebSocket label under the control-plane origin: `/attach/:id` (a client
 *  terminal attach, spec 7.3) or `/supervisor/:id` (the marid supervisor
 *  channel, contracts.md §2). Both upgrade to the per-computer Durable Object,
 *  which distinguishes them by the path suffix (`/client` vs `/supervisor`).
 *  These are NOT `/api/*` paths, so the session guard does not apply — the
 *  supervisor authenticates with its fencing token, the client attach is a
 *  read of live grid state. */
const WS_ROUTE = /^\/(attach|supervisor)\/([^/?]+)\/?$/;

async function tryWsRoute(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const match = WS_ROUTE.exec(url.pathname);
  if (!match) return null;
  if ((request.headers.get('Upgrade') ?? '').toLowerCase() !== 'websocket') {
    return new Response('expected websocket', { status: 426 });
  }
  const kind = match[1] as 'attach' | 'supervisor';
  const id = decodeURIComponent(match[2] as string);

  // The client terminal attach (spec 7.3) is a privileged per-computer channel:
  // it replays the run's journal (terminal output — spec 6.3, "the user's
  // business", routinely secret-bearing) and forwards `input` keystrokes to the
  // PTY. It MUST be authenticated to a session that OWNS this computer, or it is
  // a cross-tenant read + keystroke-injection hole (SEC-02). The supervisor
  // channel authenticates by its one-time fencing token via `hello`
  // (contracts.md Appendix B), so this session gate applies to `attach` ONLY.
  if (kind === 'attach') {
    const session = await makeAuth(env).api.getSession({ headers: request.headers });
    if (!session?.user) return new Response('unauthorized', { status: 401 });
    const owned = await getOwnedComputer(env.DB, id, session.user.id);
    if (!owned) return new Response('forbidden', { status: 403 });
  }

  const stub = env.COMPUTER.get(env.COMPUTER.idFromName(id));

  // DEV-ONLY: prime the DO with the fencing epoch/token the fake supervisor
  // presents, so its `hello` handshake succeeds without a real substrate wake.
  if (kind === 'supervisor' && env.DEV_AUTH === '1') {
    const epoch = Number(url.searchParams.get('epoch') ?? '1') || 1;
    const token = url.searchParams.get('token') ?? 'dev-supervisor';
    await stub.devPrimeSupervisor(id, epoch, token);
  }

  // The DO routes on the path suffix; carry the computer id in a header.
  const doPath = kind === 'supervisor' ? 'supervisor' : 'client';
  const headers = new Headers(request.headers);
  headers.set('x-mari-computer', id);
  const forwarded = new Request(`https://do/${doPath}`, {
    method: request.method,
    headers,
  });
  return stub.fetch(forwarded);
}

async function tryWakeProxy(request: Request, env: Env): Promise<Response | null> {
  const zone = env.PREVIEW_ZONE ?? 'mari.sh';
  // The request URL host is authoritative behind Cloudflare and in tests; fall
  // back to the Host header if a URL host is somehow absent.
  const host = new URL(request.url).host || request.headers.get('host');
  const target = parsePreviewHost(host, zone);
  if (!target) return null;

  const stub = env.COMPUTER.get(env.COMPUTER.idFromName(target.computer));
  const headers = new Headers(request.headers);
  headers.set('x-mari-proxy-port', String(target.port));
  headers.set('x-mari-computer', target.computer);
  const forwarded = new Request(request.url, {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
  });
  return stub.fetch(forwarded);
}

export async function handleFetch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const ws = await tryWsRoute(request, env);
  if (ws) return ws;
  const proxied = await tryWakeProxy(request, env);
  if (proxied) return proxied;
  return app.fetch(request, env, ctx);
}
