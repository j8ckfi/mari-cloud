// Observability (docs/observability.md): the structured logger's redaction is
// load-bearing (a secret that reaches a log line has left the vault), /healthz
// answers honestly about its dependencies with real bindings AND on the
// degraded path, and every response carries the request id.

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, env } from 'cloudflare:test';
import {
  CONTROL_PLANE_VERSION,
  healthz,
  hashUserId,
  makeLogger,
  redact,
  routeTemplate,
  REDACTED,
  withRequestId,
  type HealthzEnv,
} from '../src/obs';
import { ensureSchema, HOST } from './helpers';

function capture(): { lines: string[]; sink: (line: string) => void } {
  const lines: string[] = [];
  return { lines, sink: (line) => lines.push(line) };
}

describe('structured logger', () => {
  it('emits one one-line JSON record with ts/level/event', () => {
    const { lines, sink } = capture();
    const log = makeLogger({ service: 'test' }, sink);
    log.info('hello', { computerId: 'c1', durationMs: 12 });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    const rec = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(rec['level']).toBe('info');
    expect(rec['event']).toBe('hello');
    expect(rec['service']).toBe('test');
    expect(rec['computerId']).toBe('c1');
    expect(rec['durationMs']).toBe(12);
    expect(typeof rec['ts']).toBe('string');
    expect(Number.isNaN(Date.parse(rec['ts'] as string))).toBe(false);
  });

  it('NEVER emits the value of a denylisted key — top-level or nested', () => {
    const { lines, sink } = capture();
    const log = makeLogger({}, sink);
    log.warn('leaky', {
      token: 'sup3r-fencing-token',
      AUTH_SECRET: 'the-signing-secret',
      Cookie: 'better-auth.session_token=abc123',
      authorization: 'Bearer xyz',
      apiKey: 'sk-live-42',
      password: 'hunter2',
      nested: { sessionCookie: 'deep-cookie-value', fine: 'visible' },
    });
    const line = lines[0] as string;
    for (const secret of [
      'sup3r-fencing-token',
      'the-signing-secret',
      'abc123',
      'Bearer xyz',
      'sk-live-42',
      'hunter2',
      'deep-cookie-value',
    ]) {
      expect(line).not.toContain(secret);
    }
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(rec['token']).toBe(REDACTED);
    expect(rec['AUTH_SECRET']).toBe(REDACTED);
    expect(rec['Cookie']).toBe(REDACTED);
    expect((rec['nested'] as Record<string, unknown>)['sessionCookie']).toBe(REDACTED);
    // The rule redacts VALUES, not the record: innocent siblings survive.
    expect((rec['nested'] as Record<string, unknown>)['fine']).toBe('visible');
  });

  it('redacts bound context too, and child context is inherited', () => {
    const { lines, sink } = capture();
    const base = makeLogger({ secret: 'bound-secret' }, sink);
    const child = base.child({ requestId: 'r-1' });
    child.info('evt');
    const rec = JSON.parse(lines[0] as string) as Record<string, unknown>;
    expect(rec['secret']).toBe(REDACTED);
    expect(rec['requestId']).toBe('r-1');
    expect(lines[0]).not.toContain('bound-secret');
  });

  it('never prints binary (journal bytes) and truncates long strings', () => {
    const { lines, sink } = capture();
    const log = makeLogger({}, sink);
    const journal = new TextEncoder().encode('export AWS_SECRET_ACCESS_KEY=oops');
    log.info('frame', { bytes: journal, tail: 'x'.repeat(1000) });
    const line = lines[0] as string;
    expect(line).not.toContain('AWS_SECRET_ACCESS_KEY');
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(rec['bytes']).toBe(`[bytes ${journal.byteLength}]`);
    expect((rec['tail'] as string).length).toBeLessThan(300);
    expect(rec['tail']).toContain('…[+');
  });

  it('redact() is exported and standalone-correct', () => {
    expect(redact({ refreshToken: 'v' })).toEqual({ refreshToken: REDACTED });
    expect(redact({ ok: 1 })).toEqual({ ok: 1 });
  });

  it('redacts credentials embedded in otherwise innocent error strings', () => {
    const value = redact({
      error:
        'upstream said Authorization: Bearer abc.def-123 and api_key=sk-abcdefghijklmnop',
      jwt: 'failed with eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.deadbeef',
    }) as Record<string, string>;
    const raw = JSON.stringify(value);
    expect(raw).not.toContain('abc.def-123');
    expect(raw).not.toContain('sk-abcdefghijklmnop');
    expect(raw).not.toContain('eyJhbGci');
    expect(raw.match(new RegExp(REDACTED, 'g'))?.length).toBeGreaterThanOrEqual(3);
  });

  it('hashUserId is stable, short, and not the id', () => {
    const id = 'user-123456789';
    expect(hashUserId(id)).toBe(hashUserId(id));
    expect(hashUserId(id)).toMatch(/^[0-9a-f]{8}$/);
    expect(hashUserId(id)).not.toContain(id);
    expect(hashUserId('other')).not.toBe(hashUserId(id));
  });
});

describe('route templates (log cardinality)', () => {
  it('maps known routes to their template, ids collapsed', () => {
    expect(routeTemplate('/healthz')).toBe('/healthz');
    expect(routeTemplate('/api/fleet')).toBe('/api/fleet');
    expect(routeTemplate('/api/computers/9a3f9a3f9a3f9a3f9a3f9a3f9a3f9a3f')).toBe(
      '/api/computers/:id',
    );
    expect(routeTemplate('/api/computers/abc/runs/def/keep')).toBe(
      '/api/computers/:id/runs/:runId/keep',
    );
    expect(routeTemplate('/api/computers/abc/secrets/OPENAI_API_KEY')).toBe(
      '/api/computers/:id/secrets/:name',
    );
    expect(routeTemplate('/api/computers/abc/usage')).toBe('/api/computers/:id/usage');
    expect(routeTemplate('/attach/abc123')).toBe('/attach/:id');
    expect(routeTemplate('/api/auth/passkey/list-user-passkeys')).toBe('/api/auth/*');
    expect(routeTemplate('/api/computers/abc/files/src/index.ts')).toBe(
      '/api/computers/:id/files/*',
    );
  });

  it('collapses every unknown path to one content-free cardinality bucket', () => {
    expect(routeTemplate(`/unknown/${'a'.repeat(32)}/leafy`)).toBe('/unknown');
    expect(routeTemplate('/a/b/c/d/e/f/g/h/i')).toBe('/unknown');
    // Short "safe looking" segments may still be a vault name or tenant
    // content, so the fallback must not preserve even one of them.
    expect(routeTemplate('/customer/acme/private-key-name')).toBe('/unknown');
  });
});

describe('GET /healthz (real bindings)', () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  it('answers 200 with per-dependency status and no tenant content', async () => {
    const res = await SELF.fetch(`${HOST}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      version: string;
      d1: string;
      r2: string;
      do: string;
      time: number;
    };
    expect(body.ok).toBe(true);
    expect(body.d1).toBe('ok');
    expect(body.r2).toBe('ok');
    expect(body.do).toBe('ok');
    expect(body.version).toBe(CONTROL_PLANE_VERSION);
    expect(body.time).toBeGreaterThan(0);
    // Content-free about tenants: nothing user- or computer-shaped.
    const raw = JSON.stringify(body);
    expect(raw).not.toContain('userId');
    expect(raw).not.toContain('computerId');
  });

  it('is reachable without any session (before auth)', async () => {
    const res = await SELF.fetch(`${HOST}/healthz`, { headers: {} });
    expect(res.status).toBe(200);
  });

  it('degrades to 503 with per-dep detail when D1 fails', async () => {
    const broken: HealthzEnv = {
      DB: {
        prepare: () => ({
          first: () => Promise.reject(new Error('D1_ERROR: no such database')),
        }),
      },
      STORE: env.STORE,
      COMPUTER: env.COMPUTER,
    };
    const res = await healthz(broken);
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      ok: boolean;
      d1: string;
      r2: string;
      detail?: Record<string, string>;
    };
    expect(body.ok).toBe(false);
    expect(body.d1).toBe('fail');
    expect(body.r2).toBe('ok');
    expect(body.detail?.['d1']).toContain('D1_ERROR');
  });

  it('bounds a HUNG dependency instead of hanging the probe', async () => {
    const hung: HealthzEnv = {
      DB: { prepare: () => ({ first: () => new Promise<never>(() => {}) }) },
      STORE: { head: () => new Promise<never>(() => {}) },
    };
    const res = await healthz(hung, { timeoutMs: 50 });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { d1: string; r2: string; detail?: Record<string, string> };
    expect(body.d1).toBe('fail');
    expect(body.r2).toBe('fail');
    expect(body.detail?.['d1']).toContain('timed out');
  });

  it('fails S3 health when scoped-credential configuration is incomplete', async () => {
    const missing = await healthz({
      DB: env.DB,
      STORE: env.STORE,
      STORE_URI: 's3://mari-store',
      CF_ACCOUNT_ID: 'account',
    });
    expect(missing.status).toBe(503);
    const missingBody = (await missing.json()) as {
      ok: boolean;
      storeConfig: string;
      detail?: Record<string, string>;
    };
    expect(missingBody.ok).toBe(false);
    expect(missingBody.storeConfig).toBe('fail');
    expect(missingBody.detail?.['storeConfig']).toContain('R2_PARENT_ACCESS_KEY_ID');

    const configured = await healthz({
      DB: env.DB,
      STORE: env.STORE,
      STORE_URI: 's3://mari-store',
      CF_ACCOUNT_ID: 'account',
      R2_PARENT_ACCESS_KEY_ID: 'parent',
      R2_PARENT_API_TOKEN: 'token',
    });
    expect(configured.status).toBe(200);
    expect((await configured.json()) as { storeConfig: string }).toMatchObject({
      storeConfig: 'ok',
    });
  });

  it('redacts secrets embedded in dependency failure details', async () => {
    const broken: HealthzEnv = {
      DB: {
        prepare: () => ({
          first: () =>
            Promise.reject(new Error('upstream Authorization: Bearer do-not-log-this-token')),
        }),
      },
      STORE: env.STORE,
    };
    const res = await healthz(broken);
    const raw = await res.text();
    expect(res.status).toBe(503);
    expect(raw).not.toContain('do-not-log-this-token');
    expect(raw).toContain(REDACTED);
  });
});

describe('request id echo', () => {
  it('every pipeline response carries x-request-id', async () => {
    const res = await SELF.fetch(`${HOST}/api/config`);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
    const health = await SELF.fetch(`${HOST}/healthz`);
    expect(health.headers.get('x-request-id')).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('withRequestId leaves a 101 upgrade alone', () => {
    const upgrade = { status: 101, headers: new Headers() } as unknown as Response;
    expect(withRequestId(upgrade, 'rid')).toBe(upgrade);
  });
});
