// Node entry for private instances (spec 11.2, decisions.md v0 deviation 4).
//
// v0 status: the shared Hono app factory compiles and boots under Node via
// @hono/node-server, giving private instances the same REST surface. Full
// Durable Object parity on Node (SQLite-backed coordination, alarms) arrives
// with the private-instance milestone; until then the DO/D1/R2 bindings must be
// provided by a Node-native adapter. The binding object is assembled from
// `process.env` and cast at this platform boundary (decisions.md permits a cast
// at the edge, kept localized here).

import { serve } from '@hono/node-server';
import { handleFetch } from './handler';
import type { Env } from './types';

/** Assemble an `Env` from process env. Node-native DO/D1/R2 adapters are wired
 *  in the private-instance milestone; here they are left undefined and any route
 *  that needs them throws until then (documented deviation 4). */
export function nodeEnv(): Env {
  const e = process.env;
  // The platform boundary: Node has no Workers bindings yet in v0.
  const bindings = {
    PREVIEW_ZONE: e.PREVIEW_ZONE,
    DEV_AUTH: e.DEV_AUTH,
    DEV_SEED: e.DEV_SEED,
    AUTH_SECRET: e.AUTH_SECRET,
    BASE_URL: e.BASE_URL,
    SUBSTRATE_MODE: e.SUBSTRATE_MODE,
    WARM_IDLE_MS: e.WARM_IDLE_MS,
    COLD_IDLE_MS: e.COLD_IDLE_MS,
  } as unknown as Env;
  return bindings;
}

const nodeCtx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
} as unknown as ExecutionContext;

/** Boot an HTTP server bound to `port`. Returns the node-server handle. */
export function boot(port = Number(process.env.PORT ?? 8787)) {
  const env = nodeEnv();
  return serve({
    fetch: (request: Request) => handleFetch(request, env, nodeCtx),
    port,
  });
}

// Boot when executed directly (`node dist/node.js`), not when imported.
if (import.meta.url === `file://${process.argv[1]}`) {
  boot();
  // eslint-disable-next-line no-console
  console.log(`mari control-plane (node) listening on :${process.env.PORT ?? 8787}`);
}
