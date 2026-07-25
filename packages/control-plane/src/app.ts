// The shared Hono app factory (decisions.md: one codebase, Workers entry +
// Node entry). This module owns the REST surface and auth; the wake proxy lives
// in the fetch handler of each entry (worker.ts / node.ts) because it must run
// BEFORE the router (a preview host is not an API path).

import { Hono } from 'hono';
import type { Context } from 'hono';
import type { AppEnv, Env } from './types';
import { makeAuth, assertProductionSafety, isProductionEnv } from './auth';
import { runSeed } from './seed';
import { toArrayBuffer, toBase64 } from './bytes';
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
import { changedCount, diffManifestIds, type ManifestDiff } from './diff';
import { costMeter } from './pricing';
import {
  clientRunState,
  DEFAULT_CWD,
  MAX_WRITE_BYTES,
  normalizeWritePath,
  type RunRecord,
} from './runs';
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

/** Path-safe run id: it appears in journal object keys (contracts.md §9). */
function newRunId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

function stubFor(env: Env, id: string) {
  return env.COMPUTER.get(env.COMPUTER.idFromName(id));
}

/**
 * Changed-files count for the fleet card (spec 8.2): the diff of the current
 * head against the previous head, computed from the two manifests alone. A
 * missing manifest (or no previous head) is 0 — the fleet view must render from
 * control-plane data with no spinner and never fail on a storage gap (spec 8.3).
 */
async function changedFilesCount(
  store: R2Bucket,
  cache: Map<string, number>,
  prev: string | null,
  head: string | null,
): Promise<number> {
  if (!prev || !head || prev === head) return 0;
  const key = `${prev}->${head}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  try {
    const n = changedCount((await diffManifestIds(store, prev, head)).summary);
    cache.set(key, n);
    return n;
  } catch {
    cache.set(key, 0);
    return 0;
  }
}

/** Merge a fleet row with its DO snapshot for the detail view (spec 8.2). */
async function computerDetail(env: Env, row: ComputerRow) {
  const stub = stubFor(env, row.id);
  const snap = await stub.describe(row.id);
  const runs = await stub.listRuns();
  const head = snap.head ?? row.head;
  return {
    id: row.id,
    name: row.name,
    hostname: row.name,
    parentComputer: row.parentComputer,
    createdAt: row.createdAt,
    updatedAt: snap.updatedAt || row.createdAt,
    excludeGlobs: row.excludeGlobs,
    state: snap.state,
    epoch: snap.epoch,
    head,
    manifestHead: head,
    layout: parseLayout(snap.layout),
    // The event LIST (ids included, for dismissal) plus its count, which is what
    // the fleet card renders.
    attention: snap.attention,
    attentionCount: snap.attention.length,
    activeRuns: snap.activeRunIds.length,
    activeRunIds: snap.activeRunIds,
    changedFiles: await changedFilesCount(env.STORE, new Map(), snap.prevHead, head),
    cost: costMeter(snap.substrate, snap.awakeSeconds, snap.state),
    runs,
  };
}

/** Cap on the entries a diff response carries; the count summary is exact. */
const MAX_DIFF_ENTRIES = 5000;

const EMPTY_SUMMARY = { added: 0, modified: 0, removed: 0 };

/** Accept `argv` only as a non-empty array of strings. */
function coerceArgv(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  const argv = v.filter((x): x is string => typeof x === 'string' && x !== '');
  return argv.length === v.length ? argv : [];
}

/** Project a control-plane run record onto the web's `RunSummary`. */
function toRunSummary(r: RunRecord) {
  return {
    id: r.id,
    state: clientRunState(r.status, r.exit?.kind ?? null),
    argv: r.argv,
    cwd: r.cwd,
    exitCode: r.exit && r.exit.kind === 'exited' ? r.exit.code : null,
    signal: r.exit && r.exit.kind === 'signaled' ? r.exit.code : null,
    attention: r.attention > 0,
    startedAt: r.startedAt ?? r.queuedAt,
    endedAt: r.endedAt,
    preRunManifest: r.preManifest,
    postRunManifest: r.postManifest,
    diff: r.diff,
    review: r.disposition,
    // Control-plane detail beyond the web's minimum (harmless extra fields).
    kind: r.kind,
    agent: r.agent,
    queuedAt: r.queuedAt,
    dispatched: r.dispatched,
    dispatchedAt: r.dispatchedAt,
    writePath: r.writePath,
    attentionCount: r.attention,
    epoch: r.epoch,
  };
}

/** Flatten a structured manifest diff into the web's per-path entry list. */
function toDiffEntries(d: ManifestDiff) {
  const entries = [
    ...d.added.map((e) => ({
      path: e.path,
      change: 'added' as const,
      oldMode: null,
      newMode: e.mode,
      oldSize: null,
      newSize: e.size,
      contentChanged: e.kind === 'file',
      kind: e.kind,
      symlinkTarget: e.symlink_target,
    })),
    ...d.modified.map((m) => ({
      path: m.path,
      change: 'modified' as const,
      oldMode: m.from.mode,
      newMode: m.to.mode,
      oldSize: m.from.size,
      newSize: m.to.size,
      contentChanged: m.contentChanged,
      kind: m.to.kind,
      symlinkTarget: m.to.symlink_target,
    })),
    ...d.removed.map((e) => ({
      path: e.path,
      change: 'removed' as const,
      oldMode: e.mode,
      newMode: null,
      oldSize: e.size,
      newSize: null,
      contentChanged: e.kind === 'file',
      kind: e.kind,
      symlinkTarget: e.symlink_target,
    })),
  ];
  return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * Keep / revert (spec 5.3), sharing one handler because they differ only in the
 * decision. Both are epoch-fenced: an `epoch` in the body (or `?epoch=`) is
 * compared against the DO's current fencing epoch, and a stale one is refused
 * with 409 rather than stomping a newer generation's disk (spec 4.1).
 */
async function reviewRoute(c: Context<AppEnv>, mode: 'keep' | 'revert'): Promise<Response> {
  const id = c.req.param('id');
  const runId = c.req.param('runId');
  if (!id || !runId) return c.json({ error: 'bad_request' }, 400);
  const row = await getOwnedComputer(c.env.DB, id, c.get('user').id);
  if (!row) return c.json({ error: 'not_found' }, 404);

  const body = (await c.req.json().catch(() => ({}))) as { epoch?: unknown };
  const queryEpoch = new URL(c.req.url).searchParams.get('epoch');
  const epochRaw = body.epoch ?? (queryEpoch === null ? undefined : Number(queryEpoch));
  const epoch =
    typeof epochRaw === 'number' && Number.isFinite(epochRaw) ? epochRaw : undefined;

  const stub = stubFor(c.env, row.id);
  const res = mode === 'keep' ? await stub.keepRun(runId, epoch) : await stub.revertRun(runId, epoch);

  const payload = {
    runId,
    review: res.disposition,
    head: res.head,
    applied: res.applied,
    currentEpoch: res.currentEpoch,
  };
  if (res.ok) return c.json(payload);
  if (res.error === 'not_found') return c.json({ ...payload, error: res.error }, 404);
  return c.json({ ...payload, error: res.error }, 409);
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

/**
 * The Hono app.
 *
 * `env` is optional so the module-scope construction in handler.ts (which has no
 * Env yet) is unchanged. When it IS supplied, production safety is asserted
 * EAGERLY and `createApp` throws — that is the deploy-time tripwire. Either way
 * the same assertion runs per request through `makeAuth` (and the guard
 * middleware below), so a misconfigured production origin cannot serve a single
 * request no matter which entry constructed the app.
 */
export function createApp(env?: Env): Hono<AppEnv> {
  if (env) assertProductionSafety(env);
  const app = new Hono<AppEnv>();

  // Fail closed even when the app was constructed without an Env (handler.ts),
  // and even when the vars lie about where this is running: the request's own
  // URL is the third production trigger, so `wrangler deploy` with no `--env`
  // cannot serve the dev block's placeholder secret from a public origin.
  // `assertProductionSafety` is a handful of string comparisons, not a hot-path
  // cost.
  app.use('*', async (c, next) => {
    assertProductionSafety(c.env, c.req.url);
    return next();
  });

  app.get('/', (c) => c.json({ service: 'mari-control-plane', ok: true }));

  // ---- Better Auth (incl. the passkey ceremonies under /api/auth/passkey/*) ----
  app.on(['GET', 'POST'], '/api/auth/*', (c) => makeAuth(c.env).handler(c.req.raw));

  // ---- dev seed (env-gated; unauthenticated: it mints the session) ----
  app.post('/api/dev/seed', async (c) => {
    // Two independent gates. The flag must be on AND the environment must not be
    // production: `assertProductionSafety` already throws for DEV_SEED=1 there,
    // so this is belt-and-braces against any future path that skips it.
    if (c.env.DEV_SEED !== '1' || isProductionEnv(c.env, c.req.url)) {
      return c.json({ error: 'not_found' }, 404);
    }
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
    const diffCache = new Map<string, number>();
    const computers = await Promise.all(
      rows.map(async (r) => {
        // `describe` is a pure read of the computer's own coordination point: it
        // reports state, attention and active runs WITHOUT touching a substrate,
        // so the fleet renders a COLD computer fully and wakes nothing.
        const snap = await stubFor(c.env, r.id).describe(r.id);
        const head = snap.head ?? r.head;
        return {
          id: r.id,
          hostname: r.name,
          state: snap.state,
          activeRuns: snap.activeRunIds.length,
          activeRunIds: snap.activeRunIds,
          attention: snap.attention.length,
          changedFiles: await changedFilesCount(c.env.STORE, diffCache, snap.prevHead, head),
          cost: costMeter(snap.substrate, snap.awakeSeconds, snap.state),
          manifestHead: head,
          // Last state/head change; a computer that never moved shows when it
          // was created.
          updatedAt: snap.updatedAt || r.createdAt,
        };
      }),
    );
    return c.json({ computers });
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
    if (!res.ok) {
      // A wake can fail for reasons the control plane does not control (no
      // capacity, image pull, daemon down). The DO has already rolled itself out
      // of WAKING; report the failure and the state it actually landed in, so
      // the interface shows a computer the user can act on rather than a spinner
      // that never resolves (spec 8.3).
      return c.json({ error: res.error ?? 'wake_failed', state: res.state, epoch: res.epoch }, 503);
    }
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

  // ---- live event stream (spec 6.2) ----
  // A fleet-wide, content-free push channel: attention, run lifecycle, and
  // computer state. It is per USER, so one open tab covers every computer.
  app.get('/api/events', async (c) => {
    const hub = c.env.EVENTS.get(c.env.EVENTS.idFromName(c.get('user').id));
    const upstream = await hub.fetch('https://events/subscribe', {
      headers: { accept: 'text/event-stream' },
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    });
  });

  // ---- runs (spec 5) ----

  /** Start a run (spec 5.1). Never blocks on a wake (spec 8.3). */
  app.post('/api/computers/:id/runs', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as {
      argv?: unknown;
      cwd?: unknown;
      envNames?: unknown;
      agent?: unknown;
      path?: unknown;
    };

    const argv = coerceArgv(body.argv);
    const agent = typeof body.agent === 'string' && body.agent !== '' ? body.agent : null;
    const briefPath = typeof body.path === 'string' && body.path !== '' ? body.path : null;
    // A brief "starts as a run" (spec 8.5): the agent the user brought is the
    // program, the brief is its argument. The control plane never invents a
    // command — with no argv and no agent there is nothing honest to execute.
    const finalArgv =
      argv.length > 0
        ? argv
        : agent
          ? briefPath
            ? [agent, briefPath]
            : [agent]
          : [];
    if (finalArgv.length === 0) {
      return c.json({ error: 'argv_or_agent_required' }, 400);
    }

    // Vault variable NAMES only (spec 10.1); values never leave the vault and
    // never travel in `start_run` (contracts §5.2).
    const envNames = Array.isArray(body.envNames)
      ? body.envNames.map(String)
      : await listSecretNames(c.env.DB, row.id);

    const runId = newRunId();
    const res = await stubFor(c.env, row.id).enqueueRun({
      computerId: row.id,
      runId,
      kind: 'command',
      argv: finalArgv,
      cwd: typeof body.cwd === 'string' && body.cwd !== '' ? body.cwd : DEFAULT_CWD,
      envNames,
      agent,
    });
    return c.json({
      runId: res.runId,
      // `run` is the older alias the web's brief runner reads.
      run: res.runId,
      // The RUN's state (the web `RunState`): a run is pending until the
      // supervisor reports it started.
      state: 'pending',
      /** The COMPUTER's state — `waking` when this request started the wake. */
      computerState: res.state,
      queued: res.queued,
    });
  });

  /** All runs of a computer (spec 8.2 detail: status, exit, manifests, diff). */
  app.get('/api/computers/:id/runs', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const runs = await stubFor(c.env, row.id).listRuns();
    return c.json({ computer: row.id, runs: runs.map(toRunSummary) });
  });

  /** One run, including the journal tail so a detail view renders instantly. */
  app.get('/api/computers/:id/runs/:runId', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const detail = await stubFor(c.env, row.id).runDetail(c.req.param('runId'));
    if (!detail) return c.json({ error: 'run_not_found' }, 404);
    return c.json({
      ...toRunSummary(detail),
      journalLength: detail.journalLength,
      journalTailOffset: detail.journalTailOffset,
      journalTail: detail.journalTail,
      journalTailEncoding: detail.journalTailEncoding,
    });
  });

  /** Stop a run (contracts §5.2 `stop_run`). */
  app.post('/api/computers/:id/runs/:runId/stop', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const runId = c.req.param('runId');
    const res = await stubFor(c.env, row.id).stopRun(runId);
    if (!res.ok) return c.json({ error: 'run_not_found' }, 404);
    return c.json({
      runId,
      state: clientRunState(res.status ?? 'stopping', null),
      sent: res.sent,
    });
  });

  /** Keep a run's changes: the head stays at the post-run manifest (spec 5.3). */
  app.post('/api/computers/:id/runs/:runId/keep', async (c) => {
    return reviewRoute(c, 'keep');
  });

  /** Revert a run: restore the pre-run manifest and move the head back (5.3). */
  app.post('/api/computers/:id/runs/:runId/revert', async (c) => {
    return reviewRoute(c, 'revert');
  });

  /** The run's structured difference against its pre-run manifest (spec 5.3),
   *  computed here from the two manifests in R2 (spec 9.2's engine). */
  app.get('/api/computers/:id/runs/:runId/diff', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const runId = c.req.param('runId');
    const detail = await stubFor(c.env, row.id).runDetail(runId);
    if (!detail) return c.json({ error: 'run_not_found' }, 404);

    const base = detail.preManifest;
    const head = detail.postManifest;
    if (!base || !head) {
      return c.json(
        { error: 'run_incomplete', runId, base, head, summary: EMPTY_SUMMARY, entries: [] },
        409,
      );
    }
    try {
      const diff = await diffManifestIds(c.env.STORE, base, head);
      const entries = toDiffEntries(diff);
      return c.json({
        runId,
        base,
        head,
        summary: diff.summary,
        entries: entries.slice(0, MAX_DIFF_ENTRIES),
        truncated: entries.length > MAX_DIFF_ENTRIES,
      });
    } catch (err) {
      if (err instanceof ManifestNotFound) return c.json({ error: 'manifest_missing' }, 404);
      throw err;
    }
  });

  /** Write a manifest now (spec 4.3, on a user command). */
  app.post('/api/computers/:id/snapshot', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { reason?: unknown };
    const reason = body.reason === 'scheduled' ? 'scheduled' : 'command';
    const res = await stubFor(c.env, row.id).snapshotNow(reason);
    const payload = { computer: row.id, manifest: res.head, state: res.state };
    if (!res.ok) return c.json({ ...payload, error: res.error }, 409);
    return c.json(payload);
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
      return c.json({
        computer: id,
        manifest: head,
        path: listing.path,
        // `symlinkTarget` is the web's spelling; `symlink_target` is the
        // manifest's (contracts §4). Both are emitted so neither side guesses.
        entries: listing.entries.map((e) => ({ ...e, symlinkTarget: e.symlink_target })),
      });
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

  // ---- single file read (spec 8.5 editor load + download) ----
  // Served from the manifest head in EVERY state. For a COLD/WARM computer that
  // is spec 8.4 by the letter; for an AWAKE one the head is the latest snapshot
  // the supervisor wrote (spec 4.3) — the control plane cannot read the live
  // substrate disk, and inventing a read path around the supervisor would
  // violate spec 4.1's single-writer rule. `x-mari-manifest` names exactly which
  // snapshot the bytes came from, so a client is never misled about freshness.
  app.get('/api/computers/:id/file', async (c) => {
    const id = c.req.param('id');
    const row = await getOwnedComputer(c.env.DB, id, c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const snap = await stubFor(c.env, id).describe(id);
    const head = snap.head ?? row.head;
    if (!head) return c.json({ error: 'no_manifest' }, 404);

    const path = normalizePath(new URL(c.req.url).searchParams.get('path') ?? '');
    try {
      const manifest = await loadManifest(c.env.STORE, head);
      const entry = findEntry(manifest, path);
      if (!entry) return c.json({ error: 'not_found', path }, 404);
      if (entry.kind !== 'file') return c.json({ error: 'not_a_file', path }, 400);
      const bytes = await readFile(c.env.STORE, manifest, path);
      return new Response(toArrayBuffer(bytes), {
        status: 200,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': String(bytes.length),
          'x-mari-path': path,
          'x-mari-manifest': head,
          'x-mari-state': snap.state,
          'x-mari-source': 'manifest',
        },
      });
    } catch (err) {
      if (err instanceof ManifestNotFound) return c.json({ error: 'manifest_missing' }, 404);
      if (err instanceof PathNotFound) return c.json({ error: 'not_found', path }, 404);
      if (err instanceof NotAFile) return c.json({ error: 'not_a_file', path }, 400);
      if (err instanceof FileTooLarge) return c.json({ error: 'too_large', path }, 413);
      throw err;
    }
  });

  // ---- file WRITE (spec 8.4: "A write to such a computer starts a wake") ----
  //
  // The write is applied by the SUPERVISOR on the substrate disk — the only copy
  // that accepts writes (spec 4.1) — expressed as a small run (see runs.ts). If
  // the computer is not AWAKE the write is queued in the DO, a wake starts
  // behind the interface (spec 8.3), and `hello` dispatches it exactly once.
  const writeHandler = async (c: Context<AppEnv>, rawPath: string | null, body: Uint8Array) => {
    const id = c.req.param('id') as string;
    const path = normalizeWritePath(rawPath);
    if (!path) return c.json({ ok: false, error: 'bad_path' }, 400);
    if (body.length > MAX_WRITE_BYTES) {
      return c.json({ ok: false, error: 'too_large', path, limit: MAX_WRITE_BYTES }, 413);
    }
    const res = await stubFor(c.env, id).enqueueWrite({
      computerId: id,
      runId: newRunId(),
      path,
      contentBase64: toBase64(body),
    });
    // 202: accepted, applied on the substrate when the supervisor takes it.
    return c.json(
      { ok: true, path, state: res.state, runId: res.runId, queued: res.queued, bytes: body.length },
      202,
    );
  };

  app.put('/api/computers/:id/file', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const body = new Uint8Array(await c.req.arrayBuffer());
    return writeHandler(c, new URL(c.req.url).searchParams.get('path'), body);
  });

  app.post('/api/computers/:id/upload', async (c) => {
    const row = await getOwnedComputer(c.env.DB, c.req.param('id'), c.get('user').id);
    if (!row) return c.json({ error: 'not_found' }, 404);
    const url = new URL(c.req.url);
    const contentType = c.req.header('content-type') ?? '';

    if (contentType.includes('multipart/form-data')) {
      const form = await c.req.formData().catch(() => null);
      if (!form) return c.json({ ok: false, error: 'bad_multipart' }, 400);
      const file = form.get('file');
      if (typeof file === 'string' || file === null) {
        return c.json({ ok: false, error: 'file_required' }, 400);
      }
      const formPath = form.get('path');
      const name = (file as File).name;
      const target =
        typeof formPath === 'string' && formPath !== ''
          ? formPath
          : `${(url.searchParams.get('dir') ?? '/').replace(/\/$/, '')}/${name || 'upload.bin'}`;
      const bytes = new Uint8Array(await (file as Blob).arrayBuffer());
      return writeHandler(c, target, bytes);
    }

    // A raw body upload (`?path=`) is the same operation without the envelope.
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    return writeHandler(c, url.searchParams.get('path'), bytes);
  });

  return app;
}
