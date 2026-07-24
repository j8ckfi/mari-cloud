// Bindings and environment for the Mari control plane.
//
// The same `Env` shape is consumed by the Workers entry (`worker.ts`), the Node
// entry (`node.ts`), the Hono app factory (`app.ts`), and the Durable Object
// (`computer-do.ts`). Bindings come from `wrangler.jsonc`; the `vars` are plain
// strings (Workers has no boolean/number env), so flags are compared as `'1'`.

import type { ComputerDO } from './computer-do';

/** A structured-clone / JSON-serializable value. Used for RPC-safe payloads
 *  (Durable Object method signatures must be serializable, not `unknown`). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Env {
  /** One Durable Object per computer (spec 3.2). SQLite-backed. */
  COMPUTER: DurableObjectNamespace<ComputerDO>;
  /** Fleet-level relational data (users, computers, lineage, secrets). */
  DB: D1Database;
  /** Chunk + manifest + journal-segment object store (spec 3.3). */
  STORE: R2Bucket;

  /** Preview/wake-proxy zone, e.g. `mari.sh` (decisions.md). */
  PREVIEW_ZONE?: string;
  /** `'1'` enables email/password auth (dev/test only, decisions.md Auth). */
  DEV_AUTH?: string;
  /** `'1'` enables the deterministic seed route used by the web e2e suite. */
  DEV_SEED?: string;
  /** Better Auth signing secret. */
  AUTH_SECRET?: string;
  /** Better Auth base URL. */
  BASE_URL?: string;
  /** Substrate driver selector: `'fake'` in tests, else a real driver. */
  SUBSTRATE_MODE?: string;
  /** AWAKE -> WARM idle threshold, ms (default 5 min). */
  WARM_IDLE_MS?: string;
  /** WARM -> COLD idle threshold, ms (default 30 min). */
  COLD_IDLE_MS?: string;
}

/** The authenticated principal attached to a request by the session guard. */
export interface AuthedUser {
  id: string;
  email: string;
}

/** Hono generics for the control-plane app. */
export interface AppEnv {
  Bindings: Env;
  Variables: {
    user: AuthedUser;
  };
}
