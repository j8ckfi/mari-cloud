// Run lifecycle (spec 5.1, 5.2, 8.3, 4.3) over the REAL REST surface, a real
// ComputerDO, and a fake supervisor speaking the framed-CBOR wire protocol.
//
// The load-bearing property here is spec 5.1 + 8.3 together: a run requested on
// a COLD computer is accepted IMMEDIATELY (the request does not block on the
// wake), survives in DO storage, and is handed to the supervisor EXACTLY ONCE
// when it says `hello` — not lost when the user closes the tab, not duplicated
// when the supervisor reconnects.
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  HOST,
  apiGet,
  apiPost,
  computerStub,
  createComputer,
  delay,
  ensureSchema,
  FakeSupervisor,
  seedSession,
  substrateOps,
  waitUntil,
} from './helpers';

interface StartRunBody {
  runId: string;
  run: string;
  state: string;
  computerState: string;
  queued: boolean;
}

interface RunSummary {
  id: string;
  state: string;
  argv: string[];
  cwd: string | null;
  exitCode: number | null;
  signal: number | null;
  attention: boolean;
  startedAt: number;
  endedAt: number | null;
  preRunManifest: string | null;
  postRunManifest: string | null;
  diff: { added: number; modified: number; removed: number } | null;
  review: string;
  kind?: string;
}

describe('run lifecycle', () => {
  let cookie = '';
  beforeAll(async () => {
    await ensureSchema();
    ({ cookie } = await seedSession());
  });

  it('queues a run on a COLD computer, wakes behind the request, and dispatches it exactly once', async () => {
    const id = await createComputer(cookie, 'runner');
    const stub = computerStub(id);
    expect(await stub.getState()).toBe('cold');

    const started = await apiPost<StartRunBody>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/echo', 'queued-run'],
      cwd: '/work',
    });
    expect(started.status).toBe(200);
    const runId = started.body.runId;
    expect(runId).toMatch(/^[0-9a-f]{32}$/);
    // The RUN is pending and the COMPUTER is only WAKING: the request returned
    // before the wake finished (spec 8.3 — never block the interface on a wake).
    expect(started.body.state).toBe('pending');
    expect(started.body.computerState).toBe('waking');
    expect(started.body.queued).toBe(true);

    // The run is visible immediately, before any supervisor exists.
    const early = await apiGet<{ computer: string; runs: RunSummary[] }>(
      `/api/computers/${id}/runs`,
      cookie,
    );
    expect(early.body.computer).toBe(id);
    expect(early.body.runs.map((r) => r.id)).toEqual([runId]);
    expect(early.body.runs[0]!.state).toBe('pending');
    expect(early.body.runs[0]!.argv).toEqual(['/bin/echo', 'queued-run']);

    // The wake was really started, exactly once.
    await waitUntil(async () => (await stub.getState()) === 'awake', 3000, 'wake');
    expect((await substrateOps(stub)).filter((o) => o === 'materialize')).toEqual(['materialize']);

    // The supervisor connects with the epoch/token minted by that wake.
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const start = await sup.recv.waitForTag('start_run');
    expect(start.c.run).toBe(runId);
    expect(start.c.argv).toEqual(['/bin/echo', 'queued-run']);
    expect(start.c.cwd).toBe('/work');
    // Vault NAMES only; a value never travels in start_run (spec 10.1).
    expect(start.c.env_names).toEqual([]);
    await delay(60);
    expect(sup.recv.countTag('start_run')).toBe(1);

    // A reconnect (new socket, same wake generation) must NOT re-dispatch it.
    sup.close();
    const sup2 = await FakeSupervisor.connect(id);
    await sup2.handshake(id, w.epoch, w.token);
    await expect(sup2.recv.waitForTag('start_run', 400)).rejects.toThrow(/timeout/);
    expect(sup2.recv.countTag('start_run')).toBe(0);

    // ...and the run is still there, exactly one of it.
    const after = await apiGet<{ runs: RunSummary[] }>(`/api/computers/${id}/runs`, cookie);
    expect(after.body.runs.filter((r) => r.id === runId)).toHaveLength(1);
    sup2.close();
  });

  it('dispatches immediately when a supervisor is already attached', async () => {
    const id = await createComputer(cookie, 'hot-runner');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const started = await apiPost<StartRunBody>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/true'],
    });
    expect(started.status).toBe(200);
    expect(started.body.computerState).toBe('awake');
    expect(started.body.queued).toBe(false);

    const start = await sup.recv.waitForTag('start_run');
    expect(start.c.run).toBe(started.body.runId);
    sup.close();
  });

  it('records the supervisor’s run_started / run_completed in the run history', async () => {
    const id = await createComputer(cookie, 'history');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const started = await apiPost<StartRunBody>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sh', '-c', 'echo hi'],
    });
    const runId = started.body.runId;
    await sup.recv.waitForTag('start_run');

    const PRE = 'a'.repeat(64);
    const POST = 'b'.repeat(64);
    sup.runStarted(runId, PRE);
    await waitUntil(async () => {
      const l = await apiGet<{ runs: RunSummary[] }>(`/api/computers/${id}/runs`, cookie);
      return l.body.runs[0]!.state === 'running';
    }, 3000, 'running');

    const running = await apiGet<{ runs: RunSummary[] }>(`/api/computers/${id}/runs`, cookie);
    expect(running.body.runs[0]!.preRunManifest).toBe(PRE);
    expect(running.body.runs[0]!.endedAt).toBeNull();

    // Journal bytes arrive on the run's stream; the detail view carries the tail.
    sup.journalFrame(runId, 0, new TextEncoder().encode('hello journal'));
    sup.attention(runId, 'bell');
    sup.runCompleted(runId, POST, { t: 'exited', c: { code: 3 } }, {
      added: 2,
      modified: 1,
      removed: 0,
    });

    await waitUntil(async () => {
      const l = await apiGet<{ runs: RunSummary[] }>(`/api/computers/${id}/runs`, cookie);
      return l.body.runs[0]!.state === 'exited';
    }, 3000, 'exited');

    const done = await apiGet<{ runs: RunSummary[] }>(`/api/computers/${id}/runs`, cookie);
    const rec = done.body.runs[0]!;
    expect(rec.exitCode).toBe(3);
    expect(rec.signal).toBeNull();
    expect(rec.postRunManifest).toBe(POST);
    expect(rec.diff).toEqual({ added: 2, modified: 1, removed: 0 });
    expect(rec.attention).toBe(true);
    expect(rec.review).toBe('pending');
    expect(rec.endedAt).not.toBeNull();

    // Detail: the same record plus the journal tail, byte-for-byte. The tail
    // appears once the DO's coalescing window flushes (decisions.md <=100ms).
    type Detail = RunSummary & { journalTail: string; journalLength: number };
    let detail = await apiGet<Detail>(`/api/computers/${id}/runs/${runId}`, cookie);
    await waitUntil(
      async () => {
        detail = await apiGet<Detail>(`/api/computers/${id}/runs/${runId}`, cookie);
        return detail.body.journalLength > 0;
      },
      3000,
      'journal flush',
    );
    expect(detail.status).toBe(200);
    expect(detail.body.id).toBe(runId);
    expect(detail.body.journalLength).toBe('hello journal'.length);
    expect(atob(detail.body.journalTail)).toBe('hello journal');

    // A completed run is no longer "active" on the fleet card.
    const snap = await stub.describe(id);
    expect(snap.activeRunIds).toEqual([]);
    sup.close();
  });

  it('stops a queued run before it ever reaches a supervisor, and it is never dispatched', async () => {
    const id = await createComputer(cookie, 'stopper');
    const stub = computerStub(id);

    const started = await apiPost<StartRunBody>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sleep', '600'],
    });
    const runId = started.body.runId;

    const stopped = await apiPost<{ runId: string; state: string }>(
      `/api/computers/${id}/runs/${runId}/stop`,
      cookie,
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.state).toBe('failed'); // cancelled before it ran

    await waitUntil(async () => (await stub.getState()) === 'awake', 3000, 'wake');
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    // The run the user stopped must NOT start on the supervisor's hello.
    await expect(sup.recv.waitForTag('start_run', 400)).rejects.toThrow(/timeout/);
    sup.close();
  });

  it('forwards a stop for a live run as stop_run', async () => {
    const id = await createComputer(cookie, 'stop-live');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const started = await apiPost<StartRunBody>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sleep', '600'],
    });
    await sup.recv.waitForTag('start_run');
    sup.runStarted(started.body.runId, 'c'.repeat(64));

    const stopped = await apiPost<{ state: string; sent: boolean }>(
      `/api/computers/${id}/runs/${started.body.runId}/stop`,
      cookie,
    );
    expect(stopped.status).toBe(200);
    expect(stopped.body.state).toBe('stopping');
    const stop = await sup.recv.waitForTag('stop_run');
    expect(stop.c.run).toBe(started.body.runId);
    sup.close();
  });

  it('runs a brief with the agent the user brought, and refuses to invent a command', async () => {
    const id = await createComputer(cookie, 'brief');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const bad = await apiPost<{ error: string }>(`/api/computers/${id}/runs`, cookie, {
      path: '/brief.md',
    });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('argv_or_agent_required');

    const good = await apiPost<StartRunBody>(`/api/computers/${id}/runs`, cookie, {
      agent: 'my-agent',
      path: '/brief.md',
    });
    expect(good.status).toBe(200);
    const start = await sup.recv.waitForTag('start_run');
    expect(start.c.argv).toEqual(['my-agent', '/brief.md']);
    sup.close();
  });

  it('injects vault variable NAMES (never values) into start_run', async () => {
    const id = await createComputer(cookie, 'vaulted');
    const stub = computerStub(id);
    const put = await SELF.fetch(`${HOST}/api/computers/${id}/secrets/OPENAI_KEY`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'super-secret-value' }),
    });
    expect(put.status).toBe(200);

    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);
    await apiPost<StartRunBody>(`/api/computers/${id}/runs`, cookie, { argv: ['/bin/env'] });

    const start = await sup.recv.waitForTag('start_run');
    expect(start.c.env_names).toEqual(['OPENAI_KEY']);
    expect(JSON.stringify(start.c)).not.toContain('super-secret-value');
    sup.close();
  });

  it('sends snapshot_now on command, and refuses when the computer is not AWAKE', async () => {
    const id = await createComputer(cookie, 'snapper');
    const stub = computerStub(id);

    const cold = await apiPost<{ error: string; state: string }>(
      `/api/computers/${id}/snapshot`,
      cookie,
      { reason: 'command' },
    );
    expect(cold.status).toBe(409);
    expect(cold.body.error).toBe('not_awake');
    expect(cold.body.state).toBe('cold');
    // Refusing must not have woken anything (spec 8.4: reads/plans never wake).
    expect((await substrateOps(stub)).filter((o) => o === 'materialize')).toEqual([]);

    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const ok = await apiPost<{ computer: string; state: string }>(
      `/api/computers/${id}/snapshot`,
      cookie,
      { reason: 'command' },
    );
    expect(ok.status).toBe(200);
    expect(ok.body.state).toBe('awake');
    const msg = await sup.recv.waitForTag('snapshot_now');
    expect(msg.c.reason).toBe('command');
    sup.close();
  });

  it('scopes runs to the owner', async () => {
    const id = await createComputer(cookie, 'private');
    const anon = await SELF.fetch(`${HOST}/api/computers/${id}/runs`, { method: 'POST' });
    expect(anon.status).toBe(401);
    const foreign = await apiGet(`/api/computers/not-my-computer/runs`, cookie);
    expect(foreign.status).toBe(404);
  });
});
