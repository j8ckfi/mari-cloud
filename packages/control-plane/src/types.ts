// Bindings and environment for the Mari control plane.
//
// The same `Env` shape is consumed by the Workers entry (`worker.ts`), the Node
// entry (`node.ts`), the Hono app factory (`app.ts`), and the Durable Object
// (`computer-do.ts`). Bindings come from `wrangler.jsonc`; the `vars` are plain
// strings (Workers has no boolean/number env), so flags are compared as `'1'`.

import type { ComputerDO } from './computer-do';
import type { EventsDO } from './events-do';
import type { SubstrateProvider } from './substrates/provider';

/** A structured-clone / JSON-serializable value. Used for RPC-safe payloads
 *  (Durable Object method signatures must be serializable, not `unknown`). */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface Env {
  /** One Durable Object per computer (spec 3.2). SQLite-backed. */
  COMPUTER: DurableObjectNamespace<ComputerDO>;
  /** One event hub per USER: the fan-out point for live attention / run /
   *  state events pushed to `/api/events` subscribers (spec 6.2). */
  EVENTS: DurableObjectNamespace<EventsDO>;
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

  // ---- materialize configuration (spec 3.5 `materialize`, spec 11.2) -------
  // The Durable Object hands `marid` its whole configuration when it
  // materializes a computer (crates/marid/src/config.rs). Everything below is
  // deployment-shaped rather than computer-shaped, so it arrives as vars; the
  // Node runtime fills them in from the private instance's config, and the
  // Workers entry leaves them unset (its tests drive the fake driver).

  /** Base image ref for `materialize` (spec §2 "Base image"). */
  BASE_IMAGE?: string;
  /** The computer's filesystem root inside the substrate (`MARI_ROOT`). */
  COMPUTER_ROOT?: string;
  /** Chunk store URI as the SUPERVISOR sees it, e.g. `fs:///store` (`MARI_STORE`). */
  STORE_URI?: string;
  /** WebSocket origin a materialized computer dials back on; the DO appends
   *  `/supervisor/{computer}` (`MARI_CONTROL_URL`). Must be reachable FROM the
   *  container, so never `localhost`. */
  SUPERVISOR_URL_BASE?: string;
  /** Manifest of the base image's computer root, snapshotted once by the fleet
   *  (spec §2). A computer with no head of its own restores from it. */
  BASE_MANIFEST?: string;

  /**
   * NODE ONLY: the real substrate driver, injected by the private-instance
   * runtime (spec 3.6/3.7 selection happens there, over Docker/Sprites). The
   * Workers entry never sets this and falls back to the fake driver, so no
   * Node-only module is reachable from the Workers bundle.
   */
  SUBSTRATE?: SubstrateProvider;
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
