// The shared request pipeline: wake proxy first (a preview host is not an API
// path, spec 8.3/8.5), then the REST app. Both the Workers entry (worker.ts)
// and the Node entry (node.ts) call `handleFetch`.

import { createApp } from './app';
import { parsePreviewHost } from './host';
import { makeAuth, assertProductionSafety, resolveAuthConfig } from './auth';
import { getComputer, getOwnedComputer } from './db/fleet';
import {
  PREVIEW_COOKIE,
  PREVIEW_TOKEN_PARAM,
  previewUserLabel,
  readCookie,
  verifyPreviewToken,
} from './preview';
import { healthz, makeLogger, routeTemplate, withRequestId } from './obs';
import { tryUsageRoute } from './usage';
import { canWake } from './limits';
import type { Env } from './types';

const app = createApp();

/** Base logger for the request pipeline (docs/observability.md). */
const log = makeLogger({ service: 'control-plane' });

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
  //
  // Both parameters must be present. A private instance runs with dev sign-in
  // enabled (decisions.md Auth) while REAL supervisors dial this same route with
  // no query at all; defaulting the prime would reset the DO's minted epoch and
  // token on every such connect — fencing out the live supervisor (spec 4.1) and
  // handing a known token to whoever opened the socket.
  const devEpoch = url.searchParams.get('epoch');
  const devToken = url.searchParams.get('token');
  if (kind === 'supervisor' && env.DEV_AUTH === '1' && devEpoch !== null && devToken !== null) {
    await stub.devPrimeSupervisor(id, Number(devEpoch) || 1, devToken);
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

/** A refusal on the preview surface. Deliberately terse and identical in shape
 *  for "no such computer" and "not yours": the preview host of a computer that
 *  exists must not be distinguishable from one that does not. Nothing here
 *  touches the Durable Object, so a refused request costs no substrate call and
 *  cannot wake anything (spec 10.3's denial-of-wallet concern). */
function previewRefused(status: 401 | 404, reason: string): Response {
  return new Response(`${reason}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-mari-preview': reason },
  });
}

async function tryWakeProxy(request: Request, env: Env): Promise<Response | null> {
  const zone = env.PREVIEW_ZONE ?? 'mari.sh';
  // The request URL host is authoritative behind Cloudflare and in tests; fall
  // back to the Host header if a URL host is somehow absent.
  const url = new URL(request.url);
  const host = url.host || request.headers.get('host');
  const target = parsePreviewHost(host, zone);
  if (!target) return null;

  // ---- AUTHORIZE FIRST (SEC-03) --------------------------------------------
  //
  // This route reaches a computer's published ports and, on a computer that is
  // not AWAKE, MATERIALIZES substrate resources. Both consequences are per-user,
  // so the decision is made here, before the DO is addressed at all.
  const row = await getComputer(env.DB, target.computer);
  if (!row) return previewRefused(404, 'no_such_preview');
  // The user field is part of the address, so it is part of the check: a label
  // that is not this computer's owner's is not this computer's preview host.
  if ((await previewUserLabel(row.userId)) !== target.user) {
    return previewRefused(404, 'no_such_preview');
  }

  const secret = resolveAuthConfig(env).secret;
  const queryToken = url.searchParams.get(PREVIEW_TOKEN_PARAM);
  const cookieToken = readCookie(request.headers.get('cookie'), PREVIEW_COOKIE);

  let authorized = await verifyPreviewToken(secret, cookieToken, target.computer, target.port);
  let mintCookie: string | null = null;

  if (!authorized && queryToken !== null) {
    if (await verifyPreviewToken(secret, queryToken, target.computer, target.port)) {
      authorized = true;
      mintCookie = queryToken;
    }
  }

  if (!authorized) {
    // An owning SESSION also authorizes — an operator with curl, and any
    // deployment whose session cookie is scoped to the whole zone.
    const session = await makeAuth(env).api.getSession({ headers: request.headers });
    if (session?.user && (await getOwnedComputer(env.DB, target.computer, session.user.id))) {
      authorized = true;
    }
  }

  if (!authorized) return previewRefused(401, 'preview_unauthorized');

  // The proxy calls ComputerDO.wake() below. Apply the same account compute
  // ceiling as POST /wake and run/file triggers before addressing the DO, so a
  // preview capability cannot bypass the denial-of-wallet gate.
  const wakeGate = await canWake(env.DB, env, row.userId);
  if (!wakeGate.ok) {
    return new Response('compute limit reached\n', {
      status: 403,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-mari-preview': wakeGate.reason,
      },
    });
  }

  // A capability that arrived in the query string becomes a cookie for this
  // preview host and is redirected out of the URL, so the iframe's subsequent
  // asset requests carry it and the token stops appearing in the address bar,
  // the referrer, or a screenshot. Only for a safe method — a POST must not be
  // turned into a redirect that drops its body.
  if (mintCookie !== null && (request.method === 'GET' || request.method === 'HEAD')) {
    const clean = new URL(request.url);
    clean.searchParams.delete(PREVIEW_TOKEN_PARAM);
    const secure = clean.protocol === 'https:' ? '; Secure' : '';
    return new Response(null, {
      status: 302,
      headers: {
        location: clean.pathname + (clean.search === '' ? '' : clean.search),
        'set-cookie':
          `${PREVIEW_COOKIE}=${encodeURIComponent(mintCookie)}; Path=/; HttpOnly; ` +
          `SameSite=Lax${secure}`,
        'cache-control': 'no-store',
      },
    });
  }

  const stub = env.COMPUTER.get(env.COMPUTER.idFromName(target.computer));
  const headers = new Headers(request.headers);
  // Mari's own credentials stop here. The thing on the other side is whatever the
  // user is running on their computer; it has no business receiving the session
  // cookie or the preview capability that got the request this far.
  // `better-auth` is matched anywhere in the NAME, not just at the start: a
  // production session cookie is `__Secure-better-auth.session_token`, and a
  // prefix-only filter would forward it.
  const guestCookies = (request.headers.get('cookie') ?? '')
    .split(';')
    .map((c) => c.trim())
    .filter((c) => {
      if (c === '') return false;
      const name = c.slice(0, c.indexOf('=') === -1 ? c.length : c.indexOf('=')).toLowerCase();
      return !name.startsWith('mari_') && !name.includes('better-auth');
    });
  if (guestCookies.length === 0) headers.delete('cookie');
  else headers.set('cookie', guestCookies.join('; '));
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
  // Per-request access log (docs/observability.md): one JSON line with the
  // ROUTE TEMPLATE (never the raw path — ids and secret names are path
  // segments), the status, the duration, and a request id that is also echoed
  // as `x-request-id`. A preview host's paths belong to the USER'S server, so
  // they are logged only as the preview surface, content-free.
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  const url = new URL(request.url);
  const previewHost = parsePreviewHost(
    url.host || request.headers.get('host'),
    env.PREVIEW_ZONE ?? 'mari.sh',
  );
  const route = previewHost ? 'preview:host' : routeTemplate(url.pathname);
  const reqLog = log.child({ requestId });
  try {
    const res = await dispatch(request, env, ctx, url);
    reqLog.info('http_access', {
      method: request.method,
      route,
      status: res.status,
      durationMs: Date.now() - startedAt,
    });
    return withRequestId(res, requestId);
  } catch (err) {
    reqLog.error('http_error', {
      method: request.method,
      route,
      durationMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function dispatch(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  // FAIL CLOSED, before anything else can consult a session. This must live
  // here and not only in the Hono app, because `tryWsRoute` authenticates the
  // `/attach/:id` terminal socket and `tryWakeProxy` forwards a preview host —
  // both BEFORE the router. A `wrangler deploy` with no `--env` would otherwise
  // reach `makeAuth` with the dev block's committed placeholder secret on a real
  // public origin, and accept a session cookie forged with it.
  assertProductionSafety(env, request.url);

  const ws = await tryWsRoute(request, env);
  if (ws) return ws;
  const proxied = await tryWakeProxy(request, env);
  if (proxied) return proxied;
  // /healthz: unauthenticated, tenant-content-free, and AFTER the proxy check
  // so a preview host's own /healthz still belongs to the user's server.
  if (url.pathname === '/healthz') return healthz(env);
  // GET /api/computers/:id/usage — owner-authed inside (usage.ts); lives here
  // because app.ts is another lane's file this phase.
  const usage = await tryUsageRoute(request, env);
  if (usage) return usage;
  return app.fetch(request, env, ctx);
}
