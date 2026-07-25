// Better Auth wiring (decisions.md: Better Auth over D1).
//
// AUTH SURFACE, hosted (app.mari.sh): PASSKEYS are the whole story. There is no
// GitHub OAuth app and no client secret to hand over, so a brand-new account is
// created BY a WebAuthn registration ceremony — no password is set, stored or
// accepted anywhere on the hosted path. GitHub OAuth stays configured-but-
// optional (decisions.md promises both): it registers itself only when
// GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET are both present. Email/password is
// enabled ONLY when DEV_AUTH=1, which is structurally impossible in production
// (see `assertProductionSafety`).
//
// FAIL CLOSED. A deployed origin that signs sessions with a placeholder secret
// is a forged-session hole: anyone who can read wrangler.jsonc can mint a
// session cookie for any user. So on a production environment this module
// THROWS instead of falling back to a dev secret, and refuses to build at all
// while a DEV_* flag is on. `makeAuth` is the one chokepoint every entry goes
// through (Workers fetch, Node fetch, the DO attach guard, the dev seed), so
// there is no path to an auth instance that skipped the check.
//
// The drizzle adapter runs over `drizzle-orm/d1` on the D1 binding — no native
// modules, so it works on both the Workers and Node entries.

import { betterAuth } from 'better-auth';
import { APIError } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { passkey } from '@better-auth/passkey';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from './types';
import { authSchema } from './db/schema';

/** The dev-only signing secret. Unreachable on a production environment. */
const DEV_SECRET = 'mari-dev-only-secret-do-not-use-in-prod';

/**
 * Every signing secret that ships inside a config file, a Dockerfile or a code
 * default. Each is public by construction, so a production environment must not
 * be signing sessions with one — `assertProductionSafety` rejects them all.
 */
export const PLACEHOLDER_SECRETS: readonly string[] = [
  DEV_SECRET,
  // wrangler.jsonc's default-environment var (dev/test only).
  'change-me-in-production',
  // src/node/env.ts's private-instance default.
  'mari-private-instance-change-me',
  // The test bindings (vitest.config.ts, test/node/harness.ts).
  'test-secret-not-for-prod',
  'node-suite-secret-not-for-prod',
];

/** Minimum production secret length. Better Auth only warns below 32; we
 *  refuse. */
export const MIN_SECRET_LENGTH = 32;

/** Thrown at startup by `assertProductionSafety`. Deliberately never caught
 *  internally: a misconfigured production origin must not serve requests. */
export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

/** A loopback origin — a developer's machine, not a deployment. */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === '::1' ||
    h === '0.0.0.0' ||
    h.startsWith('127.')
  );
}

/** A public TLS origin: https, and not a loopback host. Nobody's laptop. */
function isPublicTlsOrigin(raw: string): boolean {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !isLoopbackHost(url.hostname);
  } catch {
    return false;
  }
}

/**
 * Is this a production environment?
 *
 * THREE independent triggers, OR'd, and deliberately NO value that switches
 * production back off:
 *   1. `ENVIRONMENT=production` — what wrangler.jsonc's production block sets.
 *   2. BASE_URL is a public TLS origin. Catches app.mari.sh and `*.workers.dev`
 *      even if the ENVIRONMENT var is forgotten or removed.
 *   3. The REQUEST arrived on a public TLS origin. This is the one that does not
 *      depend on any var being right: `wrangler deploy` with no `--env` would
 *      otherwise put the DEFAULT block — placeholder AUTH_SECRET,
 *      `BASE_URL=http://localhost` — on a real workers.dev origin, where a
 *      committed secret forges any session. A request whose own URL is
 *      `https://<something-public>` is production, whatever the vars claim.
 *
 * Loopback http (the vitest pool, `wrangler dev`, the Playwright suite, the
 * private-instance node harness) is never production, so dev stays ergonomic.
 */
export function isProductionEnv(env: Env, requestUrl?: string): boolean {
  if ((env.ENVIRONMENT ?? '').trim().toLowerCase() === 'production') return true;
  const baseUrl = (env.BASE_URL ?? '').trim();
  if (baseUrl && isPublicTlsOrigin(baseUrl)) return true;
  return requestUrl !== undefined && isPublicTlsOrigin(requestUrl);
}

/**
 * Refuse to run a production origin with a dev-shaped configuration. THROWS.
 *
 * Called by `makeAuth` (so every request path is covered) and eagerly by
 * `createApp(env)`, so a bad deploy fails at construction rather than quietly
 * accepting forged sessions or exposing a dev login.
 */
export function assertProductionSafety(env: Env, requestUrl?: string): void {
  if (!isProductionEnv(env, requestUrl)) return;

  const secret = env.AUTH_SECRET;
  if (!secret) {
    throw new AuthConfigError(
      'AUTH_SECRET is not bound on a production environment. Set it as a real secret ' +
        '(`wrangler secret put AUTH_SECRET --env production`, see deploy/README.md); ' +
        'refusing to sign sessions with a fallback.',
    );
  }
  if (PLACEHOLDER_SECRETS.includes(secret)) {
    throw new AuthConfigError(
      'AUTH_SECRET is still a committed placeholder on a production environment. ' +
        'A published secret can forge any user session. Set a real one with ' +
        '`wrangler secret put AUTH_SECRET --env production` (see deploy/README.md).',
    );
  }
  if (secret.length < MIN_SECRET_LENGTH) {
    throw new AuthConfigError(
      `AUTH_SECRET is ${secret.length} characters; production requires at least ` +
        `${MIN_SECRET_LENGTH}. Generate one with \`openssl rand -base64 32\`.`,
    );
  }
  if (env.DEV_AUTH === '1') {
    throw new AuthConfigError(
      'DEV_AUTH=1 on a production environment. Dev sign-in accepts email/password against ' +
        'a seeded identity, which on a public origin is an open login. It cannot be enabled here.',
    );
  }
  if (env.DEV_SEED === '1') {
    throw new AuthConfigError(
      'DEV_SEED=1 on a production environment. The seed route is unauthenticated and mints a ' +
        'session for a known identity; it cannot be enabled here.',
    );
  }
}

/** Everything the auth layer derives from the environment. Exported so tests and
 *  the deploy docs can assert the exact resolution rules. */
export interface ResolvedAuthConfig {
  production: boolean;
  secret: string;
  baseURL: string;
  /**
   * WebAuthn Relying Party ID: the registrable hostname the browser is on. It
   * MUST be the host the app is served from, or every ceremony fails
   * `expectedRPID` verification — which is why it is derived from BASE_URL
   * (`localhost` in dev, the full `<name>.workers.dev` host on a preview deploy
   * because workers.dev is a public suffix, `app.mari.sh` hosted) and
   * overridable with AUTH_RP_ID.
   */
  rpID: string;
  rpName: string;
  /**
   * Pinned WebAuthn ceremony origins, or `null` to accept the request's
   * `Origin` header. Dev stays header-driven so a Vite dev server on any
   * localhost port can drive a ceremony; a deployment pins the exact origins.
   */
  origin: string[] | null;
  trustedOrigins: string[];
  /** Email/password sign-in (DEV_AUTH=1; never production). */
  emailPassword: boolean;
  github: { clientId: string; clientSecret: string } | null;
}

function splitOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((s) => s.trim().replace(/\/+$/, ''))
    .filter((s) => s.length > 0);
}

function originOf(baseURL: string): string {
  try {
    return new URL(baseURL).origin;
  } catch {
    return baseURL;
  }
}

function rpIdFor(baseURL: string): string {
  try {
    return new URL(baseURL).hostname || 'localhost';
  } catch {
    return 'localhost';
  }
}

/**
 * Resolve auth configuration for this environment, asserting production safety
 * FIRST. Everything WebAuthn needs is config-driven, so one build serves
 * `http://localhost`, `https://<name>.workers.dev` and `https://app.mari.sh`.
 */
export function resolveAuthConfig(env: Env): ResolvedAuthConfig {
  assertProductionSafety(env);
  const production = isProductionEnv(env);
  const baseURL = env.BASE_URL ?? 'http://localhost';
  const pinned = [originOf(baseURL), ...splitOrigins(env.AUTH_TRUSTED_ORIGINS)];
  const github =
    env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
      ? { clientId: env.GITHUB_CLIENT_ID, clientSecret: env.GITHUB_CLIENT_SECRET }
      : null;
  return {
    production,
    // Production already threw above if this is absent or a placeholder.
    secret: env.AUTH_SECRET ?? DEV_SECRET,
    baseURL,
    rpID: env.AUTH_RP_ID ?? rpIdFor(baseURL),
    rpName: env.AUTH_RP_NAME ?? 'Mari',
    origin: production ? [...new Set(pinned)] : null,
    trustedOrigins: [...new Set([baseURL, ...pinned])],
    emailPassword: env.DEV_AUTH === '1',
    github,
  };
}

/** Marker id for a passkey-first ceremony that has no user row yet (below). */
const PENDING = 'pending:';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const PASSKEY_SIGNUP_ERRORS = {
  INVALID_EMAIL: 'Enter a valid email address to create an account.',
  ACCOUNT_EXISTS: 'An account with that email already exists — sign in instead.',
} as const;

function signupEmail(raw: string | null | undefined): string {
  const email = (raw ?? '').trim().toLowerCase();
  if (email.length > 320 || !EMAIL_RE.test(email)) {
    throw APIError.from('BAD_REQUEST', {
      code: 'INVALID_EMAIL',
      message: PASSKEY_SIGNUP_ERRORS.INVALID_EMAIL,
    });
  }
  return email;
}

function accountExists(): never {
  throw APIError.from('BAD_REQUEST', {
    code: 'ACCOUNT_EXISTS',
    message: PASSKEY_SIGNUP_ERRORS.ACCOUNT_EXISTS,
  });
}

/**
 * Does this user hold ANY credential — a passkey, a password, a linked OAuth
 * account?
 *
 * A user row with none is unreachable: there is no password to reset and no
 * email loop, so a hosted account created by a ceremony that then failed to
 * store its credential would lock that email address out of the product
 * forever. An unauthenticated passkey registration is allowed to ADOPT such a
 * row (below); one that holds any credential is never adoptable, because that
 * would be takeover by email address.
 */
async function hasCredentials(
  ctx: { context: { adapter: unknown; internalAdapter: unknown } },
  userId: string,
): Promise<boolean> {
  const inner = ctx.context as {
    adapter: {
      findMany: (args: {
        model: string;
        where: { field: string; value: string }[];
      }) => Promise<unknown[]>;
    };
    internalAdapter: { findAccounts: (userId: string) => Promise<unknown[]> };
  };
  const passkeys = await inner.adapter.findMany({
    model: 'passkey',
    where: [{ field: 'userId', value: userId }],
  });
  if (passkeys.length > 0) return true;
  const accounts = await inner.internalAdapter.findAccounts(userId);
  return accounts.length > 0;
}

function buildAuth(env: Env) {
  const config = resolveAuthConfig(env);
  const db = drizzle(env.DB, { schema: authSchema });
  return betterAuth({
    appName: 'mari',
    secret: config.secret,
    baseURL: config.baseURL,
    basePath: '/api/auth',
    database: drizzleAdapter(db, { provider: 'sqlite', schema: authSchema }),
    emailAndPassword: {
      // Gated: only dev/test builds accept password sign-in (decisions.md).
      // `assertProductionSafety` has already refused to build when DEV_AUTH=1 on
      // a production environment, so this cannot be true there.
      enabled: config.emailPassword,
      // No email verification loop in dev/test.
      requireEmailVerification: false,
    },
    // Configured-but-optional (decisions.md Auth): registered only once the
    // owner has actually created a GitHub OAuth app and set both values. Absent
    // otherwise, so the hosted origin advertises passkeys alone.
    ...(config.github ? { socialProviders: { github: config.github } } : {}),
    plugins: [
      passkey({
        rpName: config.rpName,
        rpID: config.rpID,
        // In production the ceremony origin is pinned to the deployment's own
        // origins rather than echoed from the request's `Origin` header.
        origin: config.origin,
        authenticatorSelection: {
          // DISCOVERABLE credentials, required rather than preferred: the
          // authenticator itself remembers who you are, which is what makes
          // usernameless sign-in possible. With `preferred` an authenticator may
          // hand back a non-resident credential and that account could then only
          // ever sign in by first naming itself — and on the hosted path there
          // is no password to fall back to.
          residentKey: 'required',
          userVerification: 'preferred',
        },
        registration: {
          // Passkey-FIRST sign-up. The plugin's default requires an existing
          // session to register a passkey, which would mean every account is
          // born from some other credential (a password) — so a hosted Mari
          // could never be passwordless. With `requireSession: false` a visitor
          // with no account creates one WITH the ceremony.
          requireSession: false,
          // Runs only when there is no session. The returned id merely labels
          // the challenge; NO user row is written here, so an abandoned or
          // failed ceremony cannot leave an orphan account behind.
          resolveUser: async ({ ctx, context }) => {
            const email = signupEmail(context ?? ctx.query?.name);
            const existing = await ctx.context.internalAdapter.findUserByEmail(email);
            if (existing) {
              // Adopting a credential-less row is recovery; adopting one with a
              // credential would be account takeover.
              if (await hasCredentials(ctx, existing.user.id)) accountExists();
              return { id: existing.user.id, name: email, displayName: email };
            }
            return { id: `${PENDING}${email}`, name: email, displayName: email };
          },
          // The credential verified. Only now does the account exist.
          afterVerification: async ({ ctx, user }) => {
            // A signed-in user adding a second passkey took the session path in
            // `resolveUser`, so its id is a real user id: nothing to create.
            if (!user.id.startsWith(PENDING)) return;
            const email = user.id.slice(PENDING.length);
            // Re-check: another signup for the same address may have landed
            // between the two halves of the ceremony.
            if (await ctx.context.internalAdapter.findUserByEmail(email)) accountExists();
            const created = await ctx.context.internalAdapter.createUser({
              email,
              name: email,
              emailVerified: false,
            });
            // End sign-up signed IN: one ceremony creates the account and its
            // session. A later visit uses the discoverable-credential sign-in
            // path, which mints its own session.
            const session = await ctx.context.internalAdapter.createSession(created.id);
            await setSessionCookie(ctx, { session, user: created });
            return { userId: created.id };
          },
        },
      }),
    ],
    // Tests and the private instance are same-origin; a deployment adds its own
    // via AUTH_TRUSTED_ORIGINS.
    trustedOrigins: config.trustedOrigins,
  });
}

/** The concrete Better Auth instance type (options-specialized). */
export type Auth = ReturnType<typeof buildAuth>;

// Memoize one Better Auth instance per Env (per isolate). Rebuilding it on every
// request is wasteful; the Env object is stable within an isolate.
const cache = new WeakMap<Env, Auth>();

export function makeAuth(env: Env): Auth {
  const existing = cache.get(env);
  if (existing) return existing;
  // THROWS on a misconfigured production environment (see
  // `assertProductionSafety`). Nothing is cached on failure, so every
  // subsequent request re-throws rather than serving a half-built auth layer.
  const auth = buildAuth(env);
  cache.set(env, auth);
  return auth;
}
