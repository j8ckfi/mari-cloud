// Cloudflare Workers entry (spec 3.1). The Durable Object class is re-exported
// so wrangler can bind it; the fetch handler delegates to the shared pipeline
// (wake proxy, then REST app), and anything the pipeline does not claim falls
// through to the built web application on the ASSETS binding.

import { handleFetch } from './handler';
import { parsePreviewHost } from './host';
import type { Env } from './types';

export { ComputerDO } from './computer-do';
export { EventsDO } from './events-do';

/**
 * Paths the Worker owns outright. A request to one of these is answered by the
 * pipeline even when it 404s — falling through to the SPA would turn a missing
 * API route into an HTML page, which is how a client ends up trying to parse
 * `<!doctype html>` as JSON.
 *
 * Everything else (`/`, `/assets/*`, a deep link, a favicon) is the app.
 */
const WORKER_OWNED = /^\/(api|attach|supervisor)(\/|$)/;

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const requestUrl = new URL(request.url);

    // `/` is the application, and it needs saying explicitly because the REST app
    // answers `/` with a service-identity object — a 200, so the fallthrough
    // below (which only rescues a 404) would never reach the assets and the
    // origin's front door would serve JSON to a person.
    //
    // Unconditional, NOT negotiated on `Accept`: the Node entry for private
    // instances already serves `/` from the built app for every GET
    // (`node/server.ts`), and one behaviour across both runtimes is worth more
    // than keeping a health route that a private instance does not have either.
    // `GET /api/fleet` (401 unauthenticated) is the liveness probe.
    if (
      env.ASSETS !== undefined &&
      (request.method === 'GET' || request.method === 'HEAD') &&
      requestUrl.pathname === '/' &&
      !parsePreviewHost(requestUrl.host || request.headers.get('host'), env.PREVIEW_ZONE ?? 'mari.sh')
    ) {
      return env.ASSETS.fetch(request);
    }

    const res = await handleFetch(request, env, ctx);

    // `wrangler.jsonc` sets `assets.run_worker_first: true`, so the asset router
    // never sees a request before this function does. That is deliberate and it
    // is the whole mechanism: the wake proxy (a preview HOST, on any path — spec
    // 8.5), the client attach and supervisor WebSocket upgrades, `/api/events`
    // and every REST route are matched by `handleFetch` first and so cannot be
    // swallowed by the asset router. Only what is left over reaches the assets.
    if (env.ASSETS === undefined) return res;
    if (res.status !== 404) return res;
    if (WORKER_OWNED.test(requestUrl.pathname)) return res;
    // A preview host is a window onto a computer's port (spec 8.5), never the
    // app: a 404 from the user's own server must stay a 404, not become Mari's
    // index.html.
    if (
      parsePreviewHost(requestUrl.host || request.headers.get('host'), env.PREVIEW_ZONE ?? 'mari.sh')
    ) {
      return res;
    }

    // SPA fallback is configured on the binding (`not_found_handling`), so an
    // unknown application path returns index.html and the client takes it.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
