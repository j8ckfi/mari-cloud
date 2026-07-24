import { test as setup, expect } from '@playwright/test';
import { STORAGE_STATE } from './auth-paths';

// Auth setup for the e2e suite. The control plane runs with DEV_SEED=1 (a
// deterministic COLD fleet exists) and DEV_AUTH=1 (email/password sign-in is
// enabled for tests). The dev-seed route both writes the seed data AND mints a
// Better Auth session, returning a Set-Cookie. We call it ONCE here, through
// the web origin (so the host-only session cookie is scoped to the same host
// the browser talks to), and persist the resulting cookies as `storageState`.
//
// Every test in the `chromium` project then starts already authenticated, so no
// test performs a login mutation during page load — which keeps the COLD
// fleet/files no-wake assertions (spec 8.3/8.4) honest: the only requests those
// pages make are GET reads.

setup('authenticate via dev seed', async ({ request }) => {
  // Same-origin as the browser (Vite proxies /api -> control plane). The
  // response carries the seed fleet AND a Better Auth session cookie.
  const res = await request.post('/api/dev/seed', { data: {} });
  expect(res.status(), await res.text()).toBe(200);

  const body = (await res.json()) as {
    computer: { id: string; state: string };
    files: string[];
  };
  // Sanity: the deterministic seed produced a COLD computer with a real tree.
  expect(body.computer.state).toBe('cold');
  expect(body.files.length).toBeGreaterThan(0);

  // Persist the session cookie so the browser context is authenticated.
  await request.storageState({ path: STORAGE_STATE });
});
