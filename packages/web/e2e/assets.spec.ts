import { test, expect, request as playwrightRequest } from '@playwright/test';
import { CONTROL_PLANE } from './helpers';

// ONE Worker serves the API and the app.
//
// These requests go to the CONTROL PLANE origin directly — not through the Vite
// dev server — so what answers them is the deployed shape: `wrangler dev` running
// `src/worker.ts` with the assets binding pointed at `packages/web/dist`
// (playwright.config.ts builds it before this server starts).
//
// The risk this file exists to close: an assets-first configuration answers
// EVERYTHING that does not look like an API path with index.html. That would turn
// the wake proxy, the attach/supervisor WebSocket upgrades and the events stream
// into an HTML page — each failing in a different confusing way. `run_worker_first`
// plus the explicit fallthrough in worker.ts is what prevents it, and every
// assertion below is one route proving it was not swallowed.

test.describe('one Worker serves the app and the API', () => {
  test('the app is served from the control-plane origin', async () => {
    const api = await playwrightRequest.newContext({ baseURL: CONTROL_PLANE });
    const res = await api.get('/');
    expect(res.status()).toBe(200);
    expect(res.headers()['content-type']).toContain('text/html');
    const html = await res.text();
    // The real built document, not the dev-server template and not the API's
    // JSON identity response.
    expect(html).toContain('<div id="root">');
    expect(html).toContain('data-theme="dark"');
    // Vite emits a hashed module script; that it is present means these bytes
    // came from `vite build`, not from a placeholder.
    const script = /<script[^>]+src="(\/assets\/[^"]+\.js)"/.exec(html);
    expect(script, 'built index.html references a hashed asset bundle').not.toBeNull();

    // …and that asset is really served, as JavaScript.
    const asset = await api.get(script![1] as string);
    expect(asset.status()).toBe(200);
    expect(asset.headers()['content-type']).toMatch(/javascript/);
    expect((await asset.body()).byteLength).toBeGreaterThan(1000);
    await api.dispose();
  });

  test('SPA fallback: a deep link returns the app, not a 404', async () => {
    const api = await playwrightRequest.newContext({ baseURL: CONTROL_PLANE });
    // No such file exists in `dist`; `not_found_handling: single-page-application`
    // must hand back index.html so a shared workspace link opens the app.
    const res = await api.get('/workspace/seedcomputer/terminal');
    expect(res.status()).toBe(200);
    expect(await res.text()).toContain('<div id="root">');
    await api.dispose();
  });

  test('`/` is the app for every caller, exactly as on the Node entry', async () => {
    // The Node runtime for private instances serves `/` from the built app for
    // every GET (src/node/server.ts). The Workers entry must not differ — one
    // origin behaving two ways depending on an `Accept` header is the kind of
    // drift decisions.md exists to prevent.
    const api = await playwrightRequest.newContext({ baseURL: CONTROL_PLANE });
    for (const accept of ['text/html', 'application/json', '*/*']) {
      const res = await api.get('/', { headers: { accept } });
      expect(res.status(), accept).toBe(200);
      expect(res.headers()['content-type'], accept).toContain('text/html');
      expect(await res.text(), accept).toContain('<div id="root">');
    }
    await api.dispose();
  });

  test('the API is NOT swallowed by the asset router', async () => {
    const api = await playwrightRequest.newContext({ baseURL: CONTROL_PLANE });

    // Unauthenticated: the session guard answers, in JSON. If the asset router
    // had claimed this path we would get index.html with a 200.
    const fleet = await api.get('/api/fleet');
    expect(fleet.status()).toBe(401);
    expect(fleet.headers()['content-type']).toContain('application/json');
    expect(await fleet.json()).toEqual({ error: 'unauthorized' });

    // The live event stream (spec 6.2) is a GET on a path with no extension —
    // the most asset-like route in the API, and the easiest to lose.
    const events = await api.get('/api/events');
    expect(events.status()).toBe(401);
    expect(events.headers()['content-type']).toContain('application/json');

    // Better Auth's own routes reach the Worker too.
    const session = await api.get('/api/auth/get-session');
    expect(session.status()).toBe(200);
    expect(session.headers()['content-type']).toContain('application/json');

    // An UNKNOWN /api path is answered by the API — here by the session guard,
    // which runs before routing — and never by the SPA.
    const unknown = await api.get('/api/no-such-route');
    expect(unknown.status()).toBe(401);
    expect(await unknown.text()).not.toContain('<div id="root">');

    // …and a genuine router 404 (a registered path with the wrong verb, on a
    // guard-exempt prefix) stays a 404. Handing the SPA back here is the failure
    // mode this whole file exists to prevent: the client would parse
    // `<!doctype html>` as JSON and report something unrelated.
    const wrongVerb = await api.get('/api/dev/seed');
    expect(wrongVerb.status()).toBe(404);
    expect(await wrongVerb.text()).not.toContain('<div id="root">');
    await api.dispose();
  });

  test('the WebSocket routes reach the Worker', async () => {
    const api = await playwrightRequest.newContext({ baseURL: CONTROL_PLANE });
    // Without an Upgrade header the handler answers 426 — which is proof the
    // request reached `tryWsRoute` rather than the asset router (spec 7.3 attach,
    // contracts.md §2 supervisor channel).
    for (const path of ['/attach/seedcomputer', '/supervisor/seedcomputer']) {
      const res = await api.get(path);
      expect(res.status(), path).toBe(426);
      expect(await res.text(), path).toContain('expected websocket');
    }
    await api.dispose();
  });
});
