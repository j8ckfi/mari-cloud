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
  /**
   * The built web application, served as Workers static assets so ONE Worker
   * serves both the API and the app (spec 1.3 "the user can see the results from
   * each device" — one origin, one deploy). `wrangler.jsonc` sets
   * `run_worker_first: true`, so this binding is reached ONLY from the explicit
   * fallthrough at the end of `worker.ts`: the asset router never gets a chance
   * to swallow `/api/*`, the WebSocket routes or a preview host.
   *
   * Optional because the Node entry (private instances) serves the app itself and
   * the vitest bindings do not include it.
   */
  ASSETS?: Fetcher;

  /** Preview/wake-proxy zone, e.g. `mari.sh` (decisions.md). */
  PREVIEW_ZONE?: string;
  /** `'1'` enables email/password auth (dev/test only, decisions.md Auth). */
  DEV_AUTH?: string;
  /** `'1'` enables the deterministic seed route used by the web e2e suite. */
  DEV_SEED?: string;
  /** Better Auth signing secret. On a production environment this MUST arrive
   *  from a real secret binding (`wrangler secret put AUTH_SECRET`); `auth.ts`
   *  throws at startup if it is missing or still a committed placeholder. */
  AUTH_SECRET?: string;
  /** Better Auth base URL. Also the source of the WebAuthn rpID and, in
   *  production, of the pinned ceremony origin (`auth.ts`). */
  BASE_URL?: string;
  /** Deployment environment name. `'production'` is one of the two triggers for
   *  the fail-closed auth checks (the other is a deployed https BASE_URL), and
   *  is what `wrangler.jsonc`'s `env.production` block sets. There is
   *  deliberately no value that switches those checks OFF. */
  ENVIRONMENT?: string;
  /** WebAuthn Relying Party id override. Defaults to BASE_URL's hostname, which
   *  is correct for `localhost`, `<name>.workers.dev` (workers.dev is a public
   *  suffix, so the rpID must be the full host) and `app.mari.sh`. */
  AUTH_RP_ID?: string;
  /** Human-readable Relying Party name shown by the authenticator UI. */
  AUTH_RP_NAME?: string;
  /** Extra comma-separated origins the auth layer trusts, and (in production)
   *  additionally accepts as a WebAuthn ceremony origin — e.g. a workers.dev
   *  origin alongside `https://app.mari.sh`. */
  AUTH_TRUSTED_ORIGINS?: string;
  /** GitHub OAuth app id. OAuth is configured-but-optional (decisions.md):
   *  the provider is registered only when BOTH of these are present. */
  GITHUB_CLIENT_ID?: string;
  /** GitHub OAuth app secret (secret binding, never a var). */
  GITHUB_CLIENT_SECRET?: string;
  /** Substrate driver selector: `'fake'` in tests, `'cloudflare'` for the
   *  container-backed hosted substrate, else a real injected driver. */
  SUBSTRATE_MODE?: string;
  /** wrangler `containers[].max_instances` mirrored as a var, so the Cloudflare
   *  driver's capacity error can name the real cap (it defaults to 20 and ERRORS
   *  a wake past it — it caps concurrent AWAKE computers, not fleet size). */
  CF_MAX_INSTANCES?: string;
  /** AWAKE -> WARM idle threshold, ms (default 5 min). */
  WARM_IDLE_MS?: string;
  /** WARM -> COLD idle threshold, ms (default 30 min). */
  COLD_IDLE_MS?: string;

  // ---- per-user quotas (spec 10.3; src/limits.ts owns the policy) ----------

  /** Computers one account may hold. Unset: 3 on a production environment,
   *  unlimited elsewhere. `<= 0` means explicitly unlimited. */
  LIMIT_MAX_COMPUTERS?: string;
  /** AWAKE compute-hours one account may spend per UTC month. Unset: 100 on a
   *  production environment, unlimited elsewhere. `<= 0` means unlimited. */
  LIMIT_COMPUTE_HOURS?: string;

  // ---- liveness and recovery (computer-do.ts) ------------------------------
  // A substrate evicts an instance and tells nobody; these four numbers are how
  // long Mari waits before it stops believing its own record of AWAKE.

  /** Grace after the supervisor's socket closes before the substrate is asked
   *  whether the instance is alive, ms (default 15 s). A network blip is not a
   *  dead container. */
  SUPERVISOR_GRACE_MS?: string;
  /** Health-check cadence for an AWAKE computer with work in flight, ms
   *  (default 30 s). A supervisor that spoke inside the window is its own proof,
   *  so a healthy computer costs no substrate call. */
  LIVENESS_MS?: string;
  /** How long AWAKE/WARM -> COLD waits for the supervisor's final snapshot
   *  before finalizing from the last known head, ms (default 20 s). */
  COLD_FINALIZE_MS?: string;
  /** Budget for ONE substrate call on the wake path, and the WAKING watchdog
   *  window, ms (default 120 s). A driver that hangs must not hang the client. */
  WAKE_TIMEOUT_MS?: string;

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
