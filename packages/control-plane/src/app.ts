// The shared Hono app factory (decisions.md: one codebase, Workers entry +
// Node entry). This module owns the REST surface and auth; the wake proxy lives
// in the fetch handler of each entry (worker.ts / node.ts) because it must run
// BEFORE the router (a preview host is not an API path).

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, Env } from './types';
import { makeAuth } from './auth';
import { runSeed } from './seed';
import { toArrayBuffer } from './bytes';
import {
  loadManifest,
  listDirectory,
  findEntry,
  readFile,
  normalizePath,
  ManifestNotFound,
  PathNotFound,
  NotAFile,
  FileTooLarge,
} from './manifest-store';
import {
  insertComputer,
  getOwnedComputer,
  listComputers,
  renameComputer,
  deleteComputer,
  insertLineage,
  listSecretNames,
  setSecret,
  type ComputerRow,
} from './db/fleet';

function newComputerId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function stubFor(env: Env, id: string) {
  return env.COMPUTER.get(env.COMPUTER.idFromName(id));
}

/** Merge a fleet row with its DO snapshot for the detail view (spec 8.2). */
async function computerDetail(env: Env, row: ComputerRow) {
  const snap = await stubFor(env, row.id).describe(row.id);
  return {
    id: row.id,
    name: row.name,
    parentComputer: row.parentComputer,
    createdAt: row.createdAt,
    excludeGlobs: row.excludeGlobs,
    state: snap.state,
    epoch: snap.epoch,
    head: snap.head ?? row.head,
    layout: parseLayout(snap.layout),
    attention: snap.attention,
  };
}

/** Layout crosses the DO RPC boundary as a JSON string; parse for HTTP JSON. */
function parseLayout(layout: string | null): unknown {
  if (layout == null) return null;
  try {
    return JSON.parse(layout);
  } catch {
    return null;
  }
}

export function createApp(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', (c) => c.json({ service: 'mari-control-plane', ok: true }));

  // ---- Better Auth ----
  app.on(['GET', 'POST'], '/api/auth/*', (c) => makeAuth(c.env).handler(c.req.raw));

  // ---- dev seed (env-gated; unauthenticated: it mints the session) ----
  app.post('/api/dev/seed', async (c) => {
    if (c.env.DEV_SEED !== '1') return c.json({ error: 'not_found' }, 404);
    const opts = (await c.req.json().catch(() => ({}))) as {
      email?: string;
      password?: string;
      name?: string;
    };
    const seed = await runSeed(c.env, opts);
    const res = c.json(seed.body, 200);
    if (seed.setCookie) res.headers.append('set-cookie', seed.setCookie);
    return res;
  });

  // ---- session guard for the rest of /api/* (spec 10, decisions.md Auth) ----
  app.use('/api/*', async (c, next) => {
    const path = new URL(c.req.url).pathname;
    if (path.startsWith('/api/auth') || path.startsWith('/api/dev')) return next();
    const session = await makeAuth(c.env).api.getSession({ headers: c.req.raw.headers });
    if (!session?.user) return c.json({ error: 'unauthorized' }, 401);
    c.set('user', { id: session.user.id, email: session.user.email });
    return next();
  });

  // ---- fleet home (spec 8.2) ----
  // The web app codes against this rich shape (api/types.ts FleetResponse):
  // every summary field renders from control-plane data ALONE, so a COLD
  // computer's card is fully populated with no wake and no spinner (spec 8.3).
  // The denormalized state/head on the D1 row is written by the DO on each
  // transition, so this needs no DO round-trip and never wakes anything.
  app.get('/api/fleet', async (c) => {
    const rows = await listComputers(c.env.DB, c.get('user').id);
    return c.json({
      computers: rows.map((r) => ({
        id: r.id,
        hostname: r.name,
        state: r.state,
        // v0: run/attention/changed counts and the cost meter are surfaced as
        // zeroed placeholders wired to the shape (decisions.md: the 8.2 cost
        // meter is internal accounting, independent of billing, absent in v0).
        activeRuns: 0,
        attention: 0,
        changedFiles: 0,
        cost: { currency: 'USD', accrued: 0, ratePerHour: 0, window: 'month to date' },
        manifestHead: r.head,
        updatedAt: r.createdAt,
      })),
    });
  });

  // ---- computers CRUD ----
  app.get('/api/computers', async (c) => {
    const rows = await listComputers(c.env.DB, c.get('user').id);
    return c.json({
      computers: rows.map((r) => ({
        id: r.id,
        name: r.name,
        state: r.state,
        head: r.head,
        parentComputer: r.parentComputer,
        createdAt: r.createdAt,
      })),
    });
  });

  app.post('/api/computers', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    const name = (body.name ?? 'computer').toString().slice(0, 200);
    const id = newComputerId();
    const row = await insertComputer(c.env.DB, { id, name, userId: c.get('user').id });
    await stubFor(c.env, id).initFromManifest(id, null);
    return c.json({ id: row.id, name: row.name, state: row.state, head: row.head }, 201);
  });

  app.get('/api/computers/:id', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json(await computerDetail(c.env, row));
  });

  app.patch('/api/computers/:id', async (c) => {
    const id = c.req.param('id');
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };
    if (typeof body.name !== 'string') return c.json({ error: 'name_required' }, 400);
    const ok = await renameComputer(c.env.DB, id, c.get('user').id, body.name.slice(0, 200));
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ id, name: body.name });
  });

  app.delete('/api/computers/:id', async (c) => {
    const ok = await deleteComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!ok) return c.json({ error: 'not_found' }, 404);
    return c.json({ ok: true });
  });

  // ---- wake ----
  app.post('/api/computers/:id/wake', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const res = await stubFor(c.env, row.id).wake(row.id);
    return c.json({ state: res.state, epoch: res.epoch });
  });

  // ---- fork (spec 9.1: head copy + lineage, zero bulk data) ----
  app.post('/api/computers/:id/fork', async (c) => {
    const src = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!src) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { name?: string };

    // Source head is authoritative in the DO (may be ahead of the D1 mirror).
    const srcHead = (await stubFor(c.env, src.id).describe(src.id)).head ?? src.head;

    const id = newComputerId();
    const name = (body.name ?? `${src.name} (fork)`).toString().slice(0, 200);
    const row = await insertComputer(c.env.DB, {
      id,
      name,
      userId: c.get('user').id,
      parentComputer: src.id,
      head: srcHead,
      state: 'cold',
      excludeGlobs: src.excludeGlobs,
    });
    await insertLineage(c.env.DB, id, src.id);
    // Seed the fork's DO head; NO chunk copy (spec 9.1 transfers no bulk data).
    await stubFor(c.env, id).initFromManifest(id, srcHead);

    return c.json(
      { id: row.id, name: row.name, state: 'cold', head: srcHead, parentComputer: src.id },
      201,
    );
  });

  // ---- pane layout persistence (spec 8.6) ----
  app.get('/api/computers/:id/layout', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const layout = await stubFor(c.env, row.id).getLayout();
    return c.json({ layout: parseLayout(layout) });
  });

  app.put('/api/computers/:id/layout', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const layout: unknown = await c.req.json().catch(() => null);
    await stubFor(c.env, row.id).setLayout(row.id, layout == null ? null : JSON.stringify(layout));
    return c.json({ ok: true });
  });

  // ---- attention list + dismiss (spec 6.2) ----
  app.get('/api/computers/:id/attention', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const events = await stubFor(c.env, row.id).listAttentionEvents();
    return c.json({ attention: events });
  });

  app.post('/api/computers/:id/attention/:eventId/dismiss', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const eventId = Number(c.req.param('eventId'));
    const ok = await stubFor(c.env, row.id).dismissAttention(eventId);
    return c.json({ ok });
  });

  // ---- credential vault names (spec 10.1) ----
  app.get('/api/computers/:id/secrets', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json({ names: await listSecretNames(c.env.DB, row.id) });
  });

  app.put('/api/computers/:id/secrets/:name', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { value?: string };
    if (typeof body.value !== 'string') return c.json({ error: 'value_required' }, 400);
    await setSecret(c.env.DB, row.id, c.req.param('name'), body.value);
    return c.json({ ok: true, name: c.req.param('name') });
  });

  // ---- files from the manifest head (spec 8.4: must not wake) ----
  const filesHandler = async (c: Context<AppEnv>): Promise<Response> => {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'bad_request' }, 400);
    const row = await getOwnedComputer(c.env.DB, id, c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);

    // Head from the DO snapshot (no wake); fall back to the D1 mirror.
    const head = (await stubFor(c.env, id).describe(id)).head ?? row.head;
    if (!head) return c.json({ error: 'no_manifest' }, 404);

    // Two equivalent path spellings are accepted: the URL suffix
    // (`/files/src`, used by the control-plane's own tests) and a `?path=`
    // query (used by the web file browser). The query wins when present.
    const url = new URL(c.req.url);
    const queryPath = url.searchParams.get('path');
    let rel: string;
    if (queryPath !== null) {
      rel = queryPath;
    } else {
      const pathname = url.pathname;
      const at = pathname.indexOf('/files');
      const relRaw = at === -1 ? '' : pathname.slice(at + '/files'.length);
      try {
        rel = decodeURIComponent(relRaw);
      } catch {
        rel = relRaw;
      }
    }
    const path = normalizePath(rel);

    try {
      const manifest = await loadManifest(c.env.STORE, head);
      const entry = findEntry(manifest, path);
      if (entry && entry.kind === 'file') {
        const bytes = await readFile(c.env.STORE, manifest, path);
        return new Response(toArrayBuffer(bytes), {
          status: 200,
          headers: {
            'content-type': 'application/octet-stream',
            'content-length': String(bytes.length),
            'x-mari-path': path,
          },
        });
      }
      const listing = listDirectory(manifest, path);
      return c.json(listing);
    } catch (err) {
      if (err instanceof ManifestNotFound) return c.json({ error: 'manifest_missing' }, 404);
      if (err instanceof PathNotFound) return c.json({ error: 'not_found', path }, 404);
      if (err instanceof NotAFile) return c.json({ error: 'not_a_file', path }, 400);
      if (err instanceof FileTooLarge) return c.json({ error: 'too_large', path }, 413);
      throw err;
    }
  };
  app.get('/api/computers/:id/files', filesHandler);
  app.get('/api/computers/:id/files/*', filesHandler);

  return app;
}
