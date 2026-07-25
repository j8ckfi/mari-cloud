// Substrate death on the PRIVATE INSTANCE (Node runtime), on REAL timers.
//
// The Workers suite (`test/liveness.test.ts`) drives the recovery deadlines with
// the alarm harness, which fires them regardless of wall-clock. This suite fires
// nothing by hand: the DO's own persisted alarm, on a real `setTimeout`, is the
// only trigger — the same code path a private instance runs at 3am with nobody
// watching. It also covers the one thing the Workers pool cannot express, because
// there is no way to evict an object there: a RESTART of the whole control plane
// while a computer was mid-wake.
//
// No Docker needed (the substrate is the fake, whose `evict()` is `docker rm -f`);
// the real-Docker version of the orchestrator's manual repro is
// `test/node/substrate-death.e2e.test.ts`, gated on MARI_NODE_E2E=1.

import { describe, it, expect, afterEach } from 'vitest';
import { join } from 'node:path';
import type { ComputerDO, Incident } from '../../src/computer-do.js';
import type { FakeSubstrate } from '../../src/substrate.js';
import type { MaterializeSpec } from '../../src/substrates/provider.js';
import type { NodeInstance } from '../../src/node.js';
import {
  api,
  makeLocalDir,
  removeDir,
  seedSession,
  startInstance,
  waitFor,
  waitUntil,
  WireSupervisor,
} from './harness.js';

let instance: NodeInstance | null = null;
let dataDir = '';

afterEach(async () => {
  await instance?.close();
  instance = null;
  if (dataDir) await removeDir(dataDir);
  dataDir = '';
});

function fakeOf(computerDo: ComputerDO): FakeSubstrate {
  return computerDo.substrate as unknown as FakeSubstrate;
}

function specsOf(computerDo: ComputerDO): MaterializeSpec[] {
  return fakeOf(computerDo).specs;
}

/** The epoch + one-time token of the last materialize — how a real supervisor
 *  learns them (they never cross the REST boundary, contracts.md §6). */
function generationOf(computerDo: ComputerDO): { epoch: number; token: string } {
  const spec = specsOf(computerDo).at(-1);
  if (!spec) throw new Error('materialize was never called');
  return { epoch: Number(spec.env['MARI_EPOCH']), token: String(spec.env['MARI_TOKEN']) };
}

function kinds(incidents: Incident[]): string[] {
  return incidents.map((i) => i.kind);
}

async function newComputer(url: string, cookie: string, name: string): Promise<string> {
  const res = await api<{ id: string }>(url, cookie, '/api/computers', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

describe('private instance: a computer whose substrate died', () => {
  it('recovers on its OWN timer and runs the queued run in a fresh instance', async () => {
    dataDir = await makeLocalDir('mari-liveness');
    instance = await startInstance({
      dataDir,
      storeDir: join(dataDir, 'store'),
      substrateMode: 'fake',
      baseSnapshot: false,
      // Long tier deadlines so the ONLY thing that can move this computer is the
      // liveness path under test.
      warmIdleMs: 3_600_000,
      coldIdleMs: 3_600_000,
      supervisorGraceMs: 300,
      livenessMs: 300,
    });
    const { cookie } = await seedSession(instance.url);
    const id = await newComputer(instance.url, cookie, 'evicted');

    // ---- AWAKE, with a run in flight -------------------------------------
    const wake = await api<{ state: string; epoch: number }>(
      instance.url,
      cookie,
      `/api/computers/${id}/wake`,
      { method: 'POST' },
    );
    expect(wake.body.state).toBe('awake');
    const computerDo = await instance.runtime.computers.instanceFor(id);
    const gen1 = generationOf(computerDo);

    const sup1 = await WireSupervisor.connect(instance.url, id);
    await sup1.handshake(id, gen1.epoch, gen1.token);
    const dispatched = sup1.recv.waitForTag('start_run');
    const created = await api<{ runId: string }>(instance.url, cookie, `/api/computers/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ argv: ['/bin/sh', '-c', 'work'] }),
    });
    const runId = created.body.runId;
    await dispatched;
    const OUT = new TextEncoder().encode('half a line');
    sup1.send({ t: 'run_started', c: { run: runId, pre_run_manifest: 'a'.repeat(64) } });
    sup1.send({ t: 'journal_frame', c: { run: runId, offset: 0, bytes: OUT } });
    await sup1.recv.waitForTag('journal_ack');

    // ---- the machine is removed out from under it -------------------------
    expect(fakeOf(computerDo).evictAll()).toBe(1);
    sup1.close(); // the container's death takes the socket with it

    // NOTHING is fired by hand from here on. The grace deadline was armed by the
    // socket close, and a real timer runs it.
    await waitUntil(
      async () => (await computerDo.getState()) === 'awake' && specsOf(computerDo).length === 2,
      15_000,
      'the DO to notice on its own and materialize a FRESH instance',
    );

    const gen2 = generationOf(computerDo);
    expect(gen2.epoch).toBe(gen1.epoch + 1);
    expect(gen2.token).not.toBe(gen1.token);
    expect(kinds(await computerDo.listIncidents())).toContain('substrate_lost');
    // The dead instance was destroyed, not leaked.
    expect(fakeOf(computerDo).calls.map((c) => c.op)).toEqual([
      'materialize',
      'destroy',
      'materialize',
    ]);

    // The interrupted run kept its journal and raised exactly one attention event
    // (spec 5.6 / 6.2).
    const detail = await api<{ status: string; state: string; journalTail: string }>(
      instance.url,
      cookie,
      `/api/computers/${id}/runs/${runId}`,
    );
    expect(detail.body.status).toBe('interrupted');
    expect(detail.body.state).toBe('failed');
    expect(Buffer.from(detail.body.journalTail, 'base64').toString('utf8')).toBe('half a line');
    const attention = await api<{ attention: { run: string; kind: string }[] }>(
      instance.url,
      cookie,
      `/api/computers/${id}/attention`,
    );
    expect(attention.body.attention).toEqual([
      expect.objectContaining({ run: runId, kind: 'interrupted' }),
    ]);
    // ...and it is visible as an incident through the REST surface too.
    const incidents = await api<{ incidents: Incident[] }>(
      instance.url,
      cookie,
      `/api/computers/${id}/incidents`,
    );
    expect(kinds(incidents.body.incidents)).toContain('substrate_lost');

    // ---- the fresh generation is usable ----------------------------------
    const sup2 = await WireSupervisor.connect(instance.url, id);
    await sup2.handshake(id, gen2.epoch, gen2.token);
    const next = sup2.recv.waitForTag('start_run');
    const second = await api<{ runId: string }>(instance.url, cookie, `/api/computers/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ argv: ['/bin/echo', 'after'] }),
    });
    expect((await next).c?.['run']).toBe(second.body.runId);
    sup2.send({
      t: 'run_completed',
      c: {
        run: second.body.runId,
        exit: { t: 'exited', c: { code: 0 } },
        post_run_manifest: 'b'.repeat(64),
        diff: { added: 0, modified: 0, removed: 0 },
      },
    });
    await waitFor(
      async () => {
        const r = await api<{ state: string }>(
          instance!.url,
          cookie,
          `/api/computers/${id}/runs/${second.body.runId}`,
        );
        return r.body.state === 'exited' ? r.body.state : null;
      },
      10_000,
      'the post-recovery run to complete',
    );

    // The dead generation cannot come back: its credentials no longer handshake.
    const zombie = await WireSupervisor.connect(instance.url, id);
    const closed = new Promise<number>((resolve) => zombie.ws.once('close', (c) => resolve(c)));
    zombie.send({
      t: 'hello',
      c: { computer: id, epoch: gen1.epoch, token: gen1.token, proto_version: 1 },
    });
    expect(await closed).toBe(1008);
    sup2.close();
  });

  it('rolls back a computer left WAKING by a control-plane restart', async () => {
    // The wedge no Workers test can reach: the object is gone mid-wake. Here the
    // whole process is. WAKING is a transition, and no tier deadline acts on it,
    // so without the watchdog (and without re-arming persisted alarms at boot)
    // this computer could never be moved again.
    dataDir = await makeLocalDir('mari-waking');
    const storeDir = join(dataDir, 'store');
    const options = {
      dataDir,
      storeDir,
      substrateMode: 'fake',
      baseSnapshot: false,
      warmIdleMs: 3_600_000,
      coldIdleMs: 3_600_000,
      // Long enough that the DO's own budget cannot end this wake: the point is
      // the RESTART, not the timeout (which has its own test in the Workers pool).
      wakeTimeoutMs: 60_000,
    } as const;
    instance = await startInstance(options);
    const { cookie } = await seedSession(instance.url);
    const id = await newComputer(instance.url, cookie, 'waking');

    // A materialize that never answers, and a run waiting behind it.
    const computerDo = await instance.runtime.computers.instanceFor(id);
    (computerDo.substrate as unknown as { materialize: unknown }).materialize = () =>
      new Promise(() => undefined);
    await api(instance.url, cookie, `/api/computers/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ argv: ['/bin/true'] }),
    });
    await waitUntil(
      async () => (await computerDo.getState()) === 'waking',
      5_000,
      'the computer to enter WAKING',
    );

    // The instance dies RIGHT THERE, with no graceful shutdown: a power cut, a
    // container kill, an OOM. Deliberately not `instance.close()` — that one
    // drains background work first, and the wake is the background work.
    await instance.server.close();
    instance.runtime.computers.close();
    instance.runtime.events.close();
    instance.runtime.db.close();
    instance = null;
    instance = await startInstance(options);

    // Boot re-armed the persisted alarm, and the watchdog rolled the transition
    // back. Nothing external prodded it.
    const revived = await instance.runtime.computers.instanceFor(id);
    await waitUntil(
      async () => (await revived.getState()) === 'cold',
      15_000,
      'the WAKING watchdog to roll the computer back after the restart',
    );
    expect(kinds(await revived.listIncidents())).toContain('wake_abandoned');

    // The run is still there (spec 5.1) and the computer is wakeable again.
    const runs = await api<{ runs: { status: string }[] }>(
      instance.url,
      cookie,
      `/api/computers/${id}/runs`,
    );
    expect(runs.body.runs.map((r) => r.status)).toEqual(['queued']);
    await waitUntil(
      async () => (await revived.getState()) === 'awake',
      15_000,
      'the queued run to bring the computer up again',
    );
    const spec = specsOf(revived).at(-1);
    expect(Number(spec?.env['MARI_EPOCH'])).toBeGreaterThan(1);
  });
});
