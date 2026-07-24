// Better Auth wiring (decisions.md: Better Auth over D1). Hosted instances add
// GitHub OAuth + passkeys; here we enable email/password ONLY when DEV_AUTH=1
// (dev/test builds) so the suite and the web e2e can drive a real session flow.
//
// The drizzle adapter runs over `drizzle-orm/d1` on the D1 binding — no native
// modules, so it works on both the Workers and Node entries.

import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from './types';
import { authSchema } from './db/schema';

function buildAuth(env: Env) {
  const db = drizzle(env.DB, { schema: authSchema });
  return betterAuth({
    appName: 'mari',
    secret: env.AUTH_SECRET ?? 'mari-dev-only-secret-do-not-use-in-prod',
    baseURL: env.BASE_URL ?? 'http://localhost',
    basePath: '/api/auth',
    database: drizzleAdapter(db, { provider: 'sqlite', schema: authSchema }),
    emailAndPassword: {
      // Gated: only dev/test builds accept password sign-in (decisions.md).
      enabled: env.DEV_AUTH === '1',
      // No email verification loop in dev/test.
      requireEmailVerification: false,
    },
    // Tests and the private instance are same-origin; trust the configured base.
    trustedOrigins: [env.BASE_URL ?? 'http://localhost'],
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
  const auth = buildAuth(env);
  cache.set(env, auth);
  return auth;
}
