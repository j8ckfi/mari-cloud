// FAIL CLOSED IN PRODUCTION.
//
// The hole these tests exist to keep shut: `wrangler.jsonc` ships
// `AUTH_SECRET: "change-me-in-production"` as a plain var, and auth.ts used to
// fall back to a literal dev string when it was absent. Either one on a deployed
// origin means anyone who can read the repo can SIGN A SESSION COOKIE for any
// user — no exploit, just the signing key. Same for `DEV_AUTH` (email/password
// against a seeded identity) and `DEV_SEED` (an unauthenticated route that mints
// a session).
//
// So: on a production environment the app must REFUSE TO EXIST. Not warn, not
// degrade — throw at construction, and throw again on every request path that
// could otherwise mint or accept a session.
//
// Production is detected from three independent triggers, OR'd, with no way to
// turn it off: ENVIRONMENT=production, a public-TLS BASE_URL, or a public-TLS
// REQUEST url. The third is what makes it structural: `wrangler deploy` with no
// `--env` would otherwise put the dev block's placeholder secret on a real
// workers.dev origin, where every var claims "localhost".
//
// The second half of the file holds wrangler.jsonc's production block to the
// same standard, because a binding that silently fails to inherit is the other
// way this ships broken.

import { describe, it, expect } from 'vitest';
import { env } from 'cloudflare:test';
import wranglerRaw from '../wrangler.jsonc?raw';
import { createApp } from '../src/app';
import { handleFetch } from '../src/handler';
import {
  makeAuth,
  resolveAuthConfig,
  assertProductionSafety,
  isProductionEnv,
  AuthConfigError,
  PLACEHOLDER_SECRETS,
  MIN_SECRET_LENGTH,
} from '../src/auth';
import type { Env } from '../src/types';

/** A 43-character random-looking secret: what a real deployment has. */
const REAL_SECRET = 'Zt7pQ2mV9xK4bN8sR1yH6wL3jD5gF0aC2eU7iO9kP4q';

/** Build an Env from the suite's real bindings with the vars under test. */
function envWith(vars: Partial<Env>): Env {
  return { ...env, ...vars } as Env;
}

/** A production Env that is otherwise correct. */
function goodProduction(extra: Partial<Env> = {}): Env {
  return envWith({
    ENVIRONMENT: 'production',
    BASE_URL: 'https://app.mari.sh',
    AUTH_SECRET: REAL_SECRET,
    DEV_AUTH: '0',
    DEV_SEED: '0',
    ...extra,
  });
}

const noopCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

describe('production detection', () => {
  it('treats ENVIRONMENT=production as production regardless of BASE_URL', () => {
    expect(isProductionEnv(envWith({ ENVIRONMENT: 'production', BASE_URL: 'http://localhost' }))).toBe(
      true,
    );
    // Case and whitespace do not create an escape hatch.
    expect(isProductionEnv(envWith({ ENVIRONMENT: ' Production ' }))).toBe(true);
  });

  it('treats a public TLS BASE_URL as production even with ENVIRONMENT unset', () => {
    expect(isProductionEnv(envWith({ BASE_URL: 'https://app.mari.sh' }))).toBe(true);
    expect(
      isProductionEnv(envWith({ BASE_URL: 'https://mari-control-plane.someone.workers.dev' })),
    ).toBe(true);
  });

  it('treats a public TLS REQUEST url as production, whatever the vars claim', () => {
    // This is the `wrangler deploy` (no --env) case: dev vars, real origin.
    const devVars = envWith({ BASE_URL: 'http://localhost', AUTH_SECRET: 'change-me-in-production' });
    expect(isProductionEnv(devVars)).toBe(false);
    expect(isProductionEnv(devVars, 'https://app.mari.sh/api/computers')).toBe(true);
    expect(
      isProductionEnv(devVars, 'https://mari-control-plane.someone.workers.dev/api/auth/passkey/x'),
    ).toBe(true);
  });

  it('leaves loopback and plain http alone, so dev stays ergonomic', () => {
    const dev = envWith({ BASE_URL: 'http://localhost' });
    expect(isProductionEnv(dev)).toBe(false);
    expect(isProductionEnv(dev, 'http://localhost/api/computers')).toBe(false);
    expect(isProductionEnv(dev, 'http://127.0.0.1:8787/api/computers')).toBe(false);
    expect(isProductionEnv(envWith({ BASE_URL: 'https://localhost:8787' }))).toBe(false);
    expect(isProductionEnv(envWith({ BASE_URL: 'https://127.0.0.1:8787' }))).toBe(false);
    // An unparseable BASE_URL must not be mistaken for a deployment.
    expect(isProductionEnv(envWith({ BASE_URL: 'not a url' }))).toBe(false);
  });

  it('is what the suite itself runs under, so these tests prove the dev path too', () => {
    expect(isProductionEnv(env)).toBe(false);
  });
});

describe('app construction fails closed in production', () => {
  it('THROWS when AUTH_SECRET is missing', () => {
    const broken = goodProduction({ AUTH_SECRET: undefined });
    expect(() => createApp(broken)).toThrow(AuthConfigError);
    expect(() => createApp(broken)).toThrow(/AUTH_SECRET is not bound/);
    // ...and so does every request path, not just the factory.
    expect(() => makeAuth(broken)).toThrow(AuthConfigError);
  });

  it('THROWS on every committed placeholder secret', () => {
    // Not a hand-picked example: every value the repo ships anywhere.
    expect(PLACEHOLDER_SECRETS.length).toBeGreaterThanOrEqual(4);
    expect(PLACEHOLDER_SECRETS).toContain('change-me-in-production');
    expect(PLACEHOLDER_SECRETS).toContain('mari-dev-only-secret-do-not-use-in-prod');
    for (const secret of PLACEHOLDER_SECRETS) {
      const broken = goodProduction({ AUTH_SECRET: secret });
      expect(() => createApp(broken)).toThrow(AuthConfigError);
      expect(() => createApp(broken)).toThrow(/placeholder/);
      expect(() => makeAuth(broken)).toThrow(AuthConfigError);
    }
  });

  it('THROWS on a too-short secret', () => {
    const short = 'x'.repeat(MIN_SECRET_LENGTH - 1);
    expect(() => createApp(goodProduction({ AUTH_SECRET: short }))).toThrow(
      /at least 32/,
    );
    // Exactly at the boundary is accepted.
    expect(() =>
      createApp(goodProduction({ AUTH_SECRET: 'y'.repeat(MIN_SECRET_LENGTH) })),
    ).not.toThrow();
  });

  it('THROWS when DEV_AUTH is enabled', () => {
    expect(() => createApp(goodProduction({ DEV_AUTH: '1' }))).toThrow(/DEV_AUTH=1/);
    expect(() => makeAuth(goodProduction({ DEV_AUTH: '1' }))).toThrow(AuthConfigError);
  });

  it('THROWS when DEV_SEED is enabled', () => {
    expect(() => createApp(goodProduction({ DEV_SEED: '1' }))).toThrow(/DEV_SEED=1/);
    expect(() => makeAuth(goodProduction({ DEV_SEED: '1' }))).toThrow(AuthConfigError);
  });

  it('THROWS for the same reasons when production was inferred from BASE_URL alone', () => {
    // No ENVIRONMENT var at all — a deploy that only set BASE_URL.
    const inferred = envWith({
      BASE_URL: 'https://app.mari.sh',
      AUTH_SECRET: 'change-me-in-production',
    });
    expect(() => createApp(inferred)).toThrow(AuthConfigError);
    expect(() => createApp(envWith({ BASE_URL: 'https://app.mari.sh', DEV_AUTH: '1', AUTH_SECRET: REAL_SECRET }))).toThrow(
      /DEV_AUTH=1/,
    );
  });

  it('builds happily once the secret is real and the dev flags are off', () => {
    const good = goodProduction();
    expect(() => createApp(good)).not.toThrow();
    expect(() => assertProductionSafety(good)).not.toThrow();
    const config = resolveAuthConfig(good);
    expect(config.production).toBe(true);
    expect(config.secret).toBe(REAL_SECRET);
    expect(config.emailPassword).toBe(false);
    // rpID comes from BASE_URL, and the ceremony origin is PINNED in production
    // rather than echoed back from the request's Origin header.
    expect(config.rpID).toBe('app.mari.sh');
    expect(config.origin).toEqual(['https://app.mari.sh']);
  });

  it('keeps the dev environment building with no AUTH_SECRET at all', () => {
    // Ergonomics: `wrangler dev` and the node harness must not need a secret.
    const dev = envWith({ BASE_URL: 'http://localhost', AUTH_SECRET: undefined, DEV_AUTH: '1' });
    expect(() => createApp(dev)).not.toThrow();
    const config = resolveAuthConfig(dev);
    expect(config.production).toBe(false);
    expect(config.emailPassword).toBe(true);
    // Header-driven origin, so a Vite dev server on any localhost port works.
    expect(config.origin).toBeNull();
    expect(config.rpID).toBe('localhost');
  });
});

describe('rpID, origins and optional OAuth are config-driven', () => {
  it('derives rpID from BASE_URL for localhost, workers.dev and app.mari.sh', () => {
    expect(resolveAuthConfig(envWith({ BASE_URL: 'http://localhost:5173' })).rpID).toBe('localhost');
    expect(
      resolveAuthConfig(
        goodProduction({ BASE_URL: 'https://mari-control-plane.someone.workers.dev' }),
      ).rpID,
      // workers.dev is a public suffix, so the rpID must be the FULL host —
      // deriving it from BASE_URL gets that right without a special case.
    ).toBe('mari-control-plane.someone.workers.dev');
    expect(resolveAuthConfig(goodProduction()).rpID).toBe('app.mari.sh');
  });

  it('honours AUTH_RP_ID and AUTH_RP_NAME overrides', () => {
    const config = resolveAuthConfig(
      goodProduction({ AUTH_RP_ID: 'mari.sh', AUTH_RP_NAME: 'Mari Cloud' }),
    );
    expect(config.rpID).toBe('mari.sh');
    expect(config.rpName).toBe('Mari Cloud');
  });

  it('adds AUTH_TRUSTED_ORIGINS to both the trusted and the pinned ceremony origins', () => {
    const config = resolveAuthConfig(
      goodProduction({
        AUTH_TRUSTED_ORIGINS:
          'https://mari-control-plane.someone.workers.dev, https://staging.mari.sh/',
      }),
    );
    expect(config.origin).toEqual([
      'https://app.mari.sh',
      'https://mari-control-plane.someone.workers.dev',
      'https://staging.mari.sh',
    ]);
    expect(config.trustedOrigins).toContain('https://staging.mari.sh');
  });

  it('leaves GitHub OAuth OFF unless both credentials are present', () => {
    expect(resolveAuthConfig(goodProduction()).github).toBeNull();
    expect(resolveAuthConfig(goodProduction({ GITHUB_CLIENT_ID: 'id' })).github).toBeNull();
    expect(resolveAuthConfig(goodProduction({ GITHUB_CLIENT_SECRET: 'shh' })).github).toBeNull();
    expect(
      resolveAuthConfig(goodProduction({ GITHUB_CLIENT_ID: 'id', GITHUB_CLIENT_SECRET: 'shh' }))
        .github,
    ).toEqual({ clientId: 'id', clientSecret: 'shh' });
  });
});

describe('a request arriving on a public origin cannot be served by dev config', () => {
  it('refuses the request instead of minting or accepting a session', async () => {
    // The app is constructed exactly as handler.ts does it: no Env.
    const app = createApp();
    const devEnv = envWith({
      BASE_URL: 'http://localhost',
      AUTH_SECRET: 'change-me-in-production',
      DEV_AUTH: '1',
      DEV_SEED: '1',
    });

    // Same app, same env, loopback request: fine (this is `wrangler dev`).
    const local = await app.fetch(new Request('http://localhost/'), devEnv, noopCtx);
    expect(local.status).toBe(200);

    // The identical env behind a public TLS origin: refused.
    for (const url of [
      'https://app.mari.sh/',
      'https://app.mari.sh/api/computers',
      'https://mari-control-plane.someone.workers.dev/api/auth/passkey/generate-authenticate-options',
    ]) {
      const res = await app.fetch(new Request(url), devEnv, noopCtx);
      expect(res.status).toBe(500);
      expect(res.headers.getSetCookie().length).toBe(0);
    }
  });

  it('refuses BEFORE the pre-router paths that authenticate on their own', async () => {
    // `handleFetch` runs the attach-socket session check and the preview wake
    // proxy BEFORE the Hono router, so the app's own guard middleware would
    // never see those requests. A forged cookie signed with the committed
    // placeholder must not reach either one.
    const devEnv = envWith({
      BASE_URL: 'http://localhost',
      AUTH_SECRET: 'change-me-in-production',
      DEV_AUTH: '1',
    });
    for (const url of [
      // the terminal attach socket (cross-tenant read + keystroke injection)
      'https://app.mari.sh/attach/somecomputer',
      // the supervisor channel
      'https://app.mari.sh/supervisor/somecomputer',
      // a browser-preview host, which never reaches the router at all
      'https://8080--abc123--alice.mari.sh/',
    ]) {
      await expect(
        handleFetch(
          new Request(url, { headers: { Upgrade: 'websocket' } }),
          devEnv,
          noopCtx,
        ),
      ).rejects.toThrow(AuthConfigError);
    }
    // The same paths on loopback are untouched (they fail their own way, not
    // with a config error).
    await expect(
      handleFetch(new Request('http://localhost/attach/somecomputer'), devEnv, noopCtx),
    ).resolves.toBeInstanceOf(Response);
  });

  it('will not run the session-minting dev seed on a public origin', async () => {
    const app = createApp();
    const seedable = envWith({ BASE_URL: 'http://localhost', DEV_SEED: '1', DEV_AUTH: '1' });

    // Locally the seed is the suite's own login path, so it must still work.
    const ok = await app.fetch(
      new Request('http://localhost/api/dev/seed', { method: 'POST' }),
      seedable,
      noopCtx,
    );
    expect(ok.status).toBe(200);

    // On a public origin it must not hand out a session, by any status.
    const res = await app.fetch(
      new Request('https://app.mari.sh/api/dev/seed', { method: 'POST' }),
      seedable,
      noopCtx,
    );
    expect(res.status).not.toBe(200);
    expect(res.headers.getSetCookie().length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// wrangler.jsonc: the production environment block
// ---------------------------------------------------------------------------

/** Strip JSONC comments while respecting string literals — `"https://x"` must
 *  survive, and it would not survive a naive `//` regex. */
function stripJsonc(text: string): string {
  let out = '';
  let inString = false;
  let escaped = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Trailing commas are legal in JSONC.
  return out.replace(/,(\s*[}\]])/g, '$1');
}

interface WranglerConfig {
  compatibility_date: string;
  vars: Record<string, string>;
  durable_objects?: unknown;
  d1_databases?: { binding: string; database_name: string; database_id: string }[];
  r2_buckets?: { binding: string; bucket_name: string }[];
  containers?: unknown[];
  assets?: unknown;
  migrations?: { tag: string }[];
  env: {
    production: {
      account_id: string;
      vars: Record<string, string>;
      secrets?: { required?: string[] };
      durable_objects?: { bindings: { name: string; class_name: string }[] };
      d1_databases?: {
        binding: string;
        database_name: string;
        database_id: string;
        migrations_dir?: string;
      }[];
      r2_buckets?: { binding: string; bucket_name: string }[];
      containers?: unknown[];
    } & Record<string, unknown>;
  } & Record<string, unknown>;
}

/**
 * Keys wrangler does NOT inherit into a named environment. Extracted from
 * wrangler 4.114's own `notInheritable(...)` call sites; if a key here exists at
 * the top level and not in `env.production`, the deployed Worker simply does not
 * have it.
 */
const NON_INHERITABLE = [
  'vars',
  'durable_objects',
  'd1_databases',
  'r2_buckets',
  'kv_namespaces',
  'queues',
  'services',
  'containers',
  'analytics_engine_datasets',
  'hyperdrive',
  'vectorize',
  'workflows',
  'send_email',
  'mtls_certificates',
  'dispatch_namespaces',
  'pipelines',
  'secrets_store_secrets',
  'unsafe',
  'ai',
  'browser',
  'images',
  'version_metadata',
  'tail_consumers',
  'ratelimits',
  'worker_loaders',
] as const;

describe('wrangler.jsonc production environment', () => {
  const config = JSON.parse(stripJsonc(wranglerRaw)) as WranglerConfig;
  const prod = config.env.production;

  it('parses, and the default environment is untouched by the production block', () => {
    // The vitest pool binds against the DEFAULT block; these are the values the
    // whole existing suite depends on.
    expect(config.vars.BASE_URL).toBe('http://localhost');
    expect(config.vars.DEV_AUTH).toBe('0');
    expect(config.vars.DEV_SEED).toBe('0');
    expect(config.vars.PREVIEW_ZONE).toBe('mari.sh');
    // Still present, still harmless: auth.ts refuses to use it on any public
    // origin (see the tests above).
    expect(config.vars.AUTH_SECRET).toBe('change-me-in-production');
    expect(config.vars.ENVIRONMENT).toBeUndefined();
  });

  it('names the right account, database and bucket', () => {
    expect(prod.account_id).toBe('5b7019b38a2b1c0ce119ecf64e92fd92');
    const d1 = prod.d1_databases?.[0];
    expect(d1?.binding).toBe('DB');
    expect(d1?.database_name).toBe('mari');
    expect(d1?.database_id).toBe('b423acd3-0b26-482c-a0be-9998393b0cfc');
    // The migration runner needs to know where the SQL lives.
    expect(d1?.migrations_dir).toBe('migrations');
    expect(prod.r2_buckets?.[0]).toEqual({ binding: 'STORE', bucket_name: 'mari-store' });
  });

  it('carries the Durable Object bindings and the SQLite migrations', () => {
    const names = (prod.durable_objects?.bindings ?? []).map((b) => `${b.name}:${b.class_name}`);
    expect(names).toEqual(['COMPUTER:ComputerDO', 'EVENTS:EventsDO']);
    // `migrations` IS inherited, so the top-level tags are what production gets.
    expect((config.migrations ?? []).map((m) => m.tag)).toEqual(['v1', 'v2']);
  });

  it('sets the hosted origin, the Relying Party and the dev flags off', () => {
    expect(prod.vars.ENVIRONMENT).toBe('production');
    expect(prod.vars.BASE_URL).toBe('https://app.mari.sh');
    expect(prod.vars.PREVIEW_ZONE).toBe('mari.sh');
    expect(prod.vars.AUTH_RP_ID).toBe('app.mari.sh');
    expect(prod.vars.DEV_AUTH).toBe('0');
    expect(prod.vars.DEV_SEED).toBe('0');
  });

  it('does NOT ship AUTH_SECRET as a var, and declares it as a required secret', () => {
    // The whole point: on the production environment the secret must come from a
    // secret binding, never from a file in the repo.
    expect(prod.vars.AUTH_SECRET).toBeUndefined();
    expect('AUTH_SECRET' in prod.vars).toBe(false);
    expect(prod.secrets?.required).toContain('AUTH_SECRET');
    // GitHub OAuth is optional; requiring it would block the deploy.
    expect(prod.secrets?.required).not.toContain('GITHUB_CLIENT_ID');
    expect(prod.secrets?.required).not.toContain('GITHUB_CLIENT_SECRET');
  });

  it('repeats every non-inheritable key the top level defines', () => {
    const missing = NON_INHERITABLE.filter(
      (key) => key in config && !(key in prod),
    );
    expect(missing).toEqual([]);
  });

  it('deploys no route, custom domain or DNS record — the orchestrator owns that', () => {
    for (const key of ['routes', 'route']) {
      expect(key in config).toBe(false);
      expect(key in prod).toBe(false);
    }
  });
});
