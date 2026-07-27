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

  it('sanitizes unknown paths instead of echoing them', () => {
    // A 32-hex id in an unknown path still collapses.
    const t = routeTemplate(`/unknown/${'a'.repeat(32)}/leafy`);
    expect(t).toBe('/unknown/:id/leafy');
    // Long paths are capped, so an attacker cannot inflate log cardinality.
    const deep = routeTemplate('/a/b/c/d/e/f/g/h/i');
    expect(deep).toBe('/a/b/c/d/e/f/*');
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
