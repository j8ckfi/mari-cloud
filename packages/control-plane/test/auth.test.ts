// Auth (decisions.md: Better Auth; email/password gated behind DEV_AUTH=1).
// Unauthenticated /api/* is rejected; a real session (minted by the seed via
// Better Auth's server API) unlocks the fleet API.
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { cookieFromSetCookie } from './helpers';

const HOST = 'http://localhost';

describe('auth session lifecycle', () => {
  let cookie = '';

  beforeAll(async () => {
    const res = await SELF.fetch(`${HOST}/api/dev/seed`, { method: 'POST' });
    expect(res.status).toBe(200);
    cookie = cookieFromSetCookie(res.headers.get('set-cookie'));
    expect(cookie).toMatch(/=/);
  });

  it('rejects unauthenticated /api/* with 401', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers`);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('unauthorized');
  });

  it('rejects a bogus session cookie with 401', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers`, {
      headers: { Cookie: 'better-auth.session_token=not-a-real-token' },
    });
    expect(res.status).toBe(401);
  });

  it('accepts a valid session and returns the fleet', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers`, { headers: { Cookie: cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { computers: { id: string }[] };
    expect(Array.isArray(body.computers)).toBe(true);
    // The seed computer is owned by the seed session's user.
    expect(body.computers.some((c) => c.id === 'seedcomputer')).toBe(true);
  });

  it('enforces the session on a mutating route (create computer)', async () => {
    // No cookie: rejected.
    const denied = await SELF.fetch(`${HOST}/api/computers`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'nope' }),
    });
    expect(denied.status).toBe(401);

    // With the session: created, and it shows up in the owner's fleet.
    const created = await SELF.fetch(`${HOST}/api/computers`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'authored' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };

    const detail = await SELF.fetch(`${HOST}/api/computers/${id}`, { headers: { Cookie: cookie } });
    expect(detail.status).toBe(200);
    const d = (await detail.json()) as { name: string; state: string };
    expect(d.name).toBe('authored');
    expect(d.state).toBe('cold');
  });
});
