// THE ORCHESTRATOR'S MANUAL REPRO, AUTOMATED, AGAINST REAL DOCKER.
//
// Reproduced by hand against a private instance and then wedged forever:
//
//   1. computer AWAKE on the Docker substrate, a real container, a run that
//      completed exit 0;
//   2. `docker rm -f` that container — a substrate eviction, which on Cloudflare
//      happens routinely and wipes the disk on every stop;
//   3. `POST /api/computers/:id/runs` returned 200 with the run queued, the
//      computer reported state "awake" with activeRuns 1 — and NOTHING happened.
//      No container was re-materialized. The run stayed pending indefinitely;
//   4. `POST /api/computers/:id/wake` returned 200 {"state":"awake","epoch":1}
//      and did nothing, because the DO believed it was already awake.
//
// This file is that sequence, with the assertions the manual run could only make
// by eye — and it is the case the whole suite missed, which is why it drives the
// REAL daemon rather than a fake: the container is really removed, the recovery is
// really a second container, and the restored bytes are read with `docker exec`
// rather than asked of Mari.
//
// GATE: `MARI_NODE_E2E=1` (needs a Docker daemon and the `mari/base:v0` image,
// built here if missing — deploy/Dockerfile.marid).
//
//   MARI_NODE_E2E=1 pnpm --filter @mari/control-plane test:node
//
// NOTE for macOS: the chunk store must live under `$HOME`. The daemon runs in a
// VM that shares `$HOME` but not `/tmp`, and a bind mount of an unshared path is
// silently EMPTY inside the container.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { resolve } from 'node:path';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBaseManifest } from '../../src/node.js';
import type { ComputerDO, Incident } from '../../src/computer-do.js';
import type { NodeInstance } from '../../src/node.js';
import {
  api,
  bytesEqual,
  fromBase64,
  makeSharedDir,
  removeDir,
  seedSession,
  startInstance,
  waitUntil,
} from './harness.js';
import {
  cleanupAllMariContainers,
  containerEnv,
  containerLogs,
  containerStatus,
  containersFor,
  docker,
  dockerAvailable,
  imageExists,
  readFileInContainer,
} from './docker.js';

const GATE = process.env.MARI_NODE_E2E === '1';
const BASE_IMAGE = process.env.MARI_BASE_IMAGE ?? 'mari/base:v0';
const REPO_ROOT = resolve(fileURLToPath(new URL('../../../..', import.meta.url)));

/** Known bytes written before the eviction; they may only come back from the
 *  chunk store, because the container that held them is deleted. */
const SURVIVOR = 'mari-survives-the-eviction-0f3a91';
const SURVIVOR_PATH = '/work/survivor.txt';
/** What the recovered run prints, so its journal is identifiable byte for byte. */
const RECOVERED_MARK = 'ran-after-recovery-77d2';

let instance: NodeInstance;
let dataDir: string;
let storeDir: string;
let cookie: string;

interface RunBody {
  id: string;
  state: string;
  status: string;
  exitCode: number | null;
  journalLength: number;
  journalTail: string;
  epoch: number;
}

async function newComputer(name: string): Promise<string> {
  const res = await api<{ id: string }>(instance.url, cookie, '/api/computers', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

async function runDetail(id: string, runId: string): Promise<RunBody> {
  const res = await api<RunBody>(instance.url, cookie, `/api/computers/${id}/runs/${runId}`);
  expect(res.status).toBe(200);
  return res.body;
}

async function startRun(id: string, script: string): Promise<string> {
  const res = await api<{ runId: string; computerState: string; queued: boolean }>(
    instance.url,
    cookie,
    `/api/computers/${id}/runs`,
    { method: 'POST', body: JSON.stringify({ argv: ['/bin/sh', '-c', script], cwd: '/work' }) },
  );
  expect(res.status).toBe(200);
  return res.body.runId;
}

async function awaitExit(id: string, runId: string, timeoutMs = 180_000): Promise<RunBody> {
  let last: RunBody | null = null;
  await waitUntil(
    async () => {
      last = await runDetail(id, runId);
      return last.state === 'exited' || last.state === 'failed';
    },
    timeoutMs,
    `run ${runId} to finish`,
  );
  return last as unknown as RunBody;
}

/**
 * The run's journal, once it CONTAINS `needle`.
 *
 * The DO coalesces the live tail in <=100 ms windows (decisions.md), so
 * `run_completed` can arrive a beat before the last frames are durable. Waiting on
 * the exit alone would read an empty tail and call it a missing journal.
 */
async function awaitJournal(
  id: string,
  runId: string,
  needle: string,
  timeoutMs = 60_000,
): Promise<string> {
  let text = '';
  await waitUntil(
    async () => {
      text = new TextDecoder().decode(fromBase64((await runDetail(id, runId)).journalTail));
      return text.includes(needle);
    },
    timeoutMs,
    `journal of ${runId} to contain ${needle}`,
  );
  return text;
}

beforeAll(async () => {
  if (!GATE) return;
  if (!(await dockerAvailable())) {
    throw new Error('MARI_NODE_E2E=1 but no Docker daemon is reachable');
  }
  if (!(await imageExists(BASE_IMAGE))) {
    const build = await docker(
      ['build', '-f', `${REPO_ROOT}/deploy/Dockerfile.marid`, '-t', BASE_IMAGE, REPO_ROOT],
      1_800_000,
    );
    if (build.code !== 0) {
      throw new Error(`building ${BASE_IMAGE} failed:\n${build.stdout}\n${build.stderr}`);
    }
  }
  await cleanupAllMariContainers();

  dataDir = await makeSharedDir('death');
  storeDir = join(dataDir, 'store');
  instance = await startInstance({
    dataDir,
    storeDir,
    // The container dials back over the Docker network.
    hostname: '0.0.0.0',
    substrateMode: 'docker',
    substrates: ['docker'],
    baseImage: BASE_IMAGE,
    baseSnapshot: false,
    // The tier policy must not be what moves this computer: the eviction is.
    warmIdleMs: 3_600_000,
    coldIdleMs: 3_600_000,
    // Short recovery windows so a real timer answers inside a test's patience.
    // Production defaults are 15 s / 30 s.
    supervisorGraceMs: 1_500,
    livenessMs: 2_000,
  });
  cookie = (await seedSession(instance.url)).cookie;
  // Every computer starts from the base image's root (spec §2 / 4.6(a)), so the
  // restore after recovery has a real manifest to work from.
  await ensureBaseManifest(instance.runtime, { log: () => {} });
}, 1_800_000);

afterAll(async () => {
  if (!GATE) return;
  await instance?.close();
  await cleanupAllMariContainers();
  if (dataDir) await removeDir(dataDir);
});

describe.runIf(GATE)('substrate death on real Docker', () => {
  it('docker rm -f under an AWAKE computer: recovers into a FRESH container and runs the queued run', async () => {
    const id = await newComputer('evicted');

    // ---- step 1: AWAKE, a real container, a run that completed exit 0 ------
    const wake = await api<{ state: string; epoch: number }>(
      instance.url,
      cookie,
      `/api/computers/${id}/wake`,
      { method: 'POST' },
    );
    expect(wake.body.state).toBe('awake');
    const epoch1 = wake.body.epoch;

    const containersA = await containersFor(id);
    expect(containersA).toHaveLength(1);
    const containerA = containersA[0] as string;
    expect(await containerStatus(containerA)).toBe('running');

    const firstRun = await startRun(
      id,
      `printf '%s' '${SURVIVOR}' > ${SURVIVOR_PATH}; printf 'first-run-done\\n'`,
    );
    const first = await awaitExit(id, firstRun).catch(async (err: unknown) => {
      throw new Error(`${String(err)}\nmarid log:\n${await containerLogs(containerA, 40)}`);
    });
    expect(first.exitCode).toBe(0);
    expect(first.epoch).toBe(epoch1);
    // Its journal, once durable (the tail trails the exit by a flush window).
    const firstJournal = await awaitJournal(id, firstRun, 'first-run-done');
    const firstLength = (await runDetail(id, firstRun)).journalLength;
    // The bytes are on the container's disk AND, because marid snapshotted after
    // the run, in the chunk store under the computer's head.
    expect(
      bytesEqual(
        await readFileInContainer(containerA, SURVIVOR_PATH),
        new TextEncoder().encode(SURVIVOR),
      ),
    ).toBe(true);
    const computerDo = (await instance.runtime.computers.instanceFor(id)) as ComputerDO;
    const headAtEviction = await waitUntil(
      async () => (await computerDo.getHead()) !== null,
      60_000,
      'marid to advance the manifest head after the run',
    ).then(() => computerDo.getHead());
    expect(headAtEviction).toMatch(/^[0-9a-f]{64}$/);

    // ---- step 2: the eviction. `docker rm -f`, nobody is told -------------
    const removed = await docker(['rm', '-f', containerA], 120_000);
    expect(removed.code).toBe(0);
    await waitUntil(async () => (await containerStatus(containerA)) === null, 60_000, 'container A gone');

    // ---- step 3: a run is requested ---------------------------------------
    // This returned 200 with the run queued, the computer "awake", and nothing
    // ever happened. Now the DO notices on its own (its supervisor's socket died
    // with the container; the grace deadline then ASKS THE DAEMON, which answers
    // 404) and recovers.
    const secondRun = await startRun(id, `printf '${RECOVERED_MARK}\\n'; cat ${SURVIVOR_PATH}`);

    const containerB = await waitUntil(
      async () => {
        const live = (await containersFor(id)).filter((c) => c !== containerA);
        return live.length === 1;
      },
      120_000,
      'a FRESH container to be materialized',
    ).then(async () => ((await containersFor(id)).filter((c) => c !== containerA)[0] as string));
    expect(containerB).not.toBe(containerA);
    expect(await containerStatus(containerB)).toBe('running');

    // A NEW generation, and it restores from the head the chunk store holds —
    // which is the whole storage thesis: the computer is data, the container was
    // a cache (spec 1.1 / 4.1).
    const envB = await containerEnv(containerB);
    expect(Number(envB['MARI_EPOCH'])).toBeGreaterThan(epoch1);
    expect(envB['MARI_RESTORE_MANIFEST']).toBe(headAtEviction);
    expect(envB['MARI_TOKEN']).not.toBe('');

    // ---- the queued run really runs, in the fresh container ---------------
    const second = await awaitExit(id, secondRun, 240_000).catch(async (err: unknown) => {
      throw new Error(`${String(err)}\nmarid log:\n${await containerLogs(containerB, 60)}`);
    });
    expect(second.exitCode).toBe(0);
    expect(second.epoch).toBe(Number(envB['MARI_EPOCH']));
    const journal = await awaitJournal(id, secondRun, RECOVERED_MARK);
    // Its own output, and the survivor's bytes read back from the RESTORED file.
    expect(journal).toContain(RECOVERED_MARK);
    expect(journal).toContain(SURVIVOR);
    // Exactly once: the recovery did not double-dispatch the run.
    expect(journal.split(RECOVERED_MARK).length - 1).toBe(1);

    // The file is byte-identical inside the new container, asserted against the
    // DAEMON rather than against Mari.
    expect(
      bytesEqual(
        await readFileInContainer(containerB, SURVIVOR_PATH),
        new TextEncoder().encode(SURVIVOR),
      ),
    ).toBe(true);

    // ---- the bookkeeping is honest ----------------------------------------
    const incidents = await api<{ incidents: Incident[] }>(
      instance.url,
      cookie,
      `/api/computers/${id}/incidents`,
    );
    expect(incidents.body.incidents.map((i) => i.kind)).toContain('substrate_lost');
    // The journal ingest ledger recorded no gap, no duplicate and no divergence
    // across the seam (a gap IS recorded rather than absorbed, so this is a real
    // assertion about continuity).
    expect(await computerDo.journalAnomalies()).toEqual([]);
    // The first run is still exactly what it was.
    const firstAgain = await runDetail(id, firstRun);
    expect(firstAgain.status).toBe('completed');
    expect(firstAgain.exitCode).toBe(0);
    // Byte for byte what it was before the eviction: a recovery does not edit
    // history (spec 4.2 — the journal in the control plane is the truth).
    expect(firstAgain.journalLength).toBe(firstLength);
    expect(new TextDecoder().decode(fromBase64(firstAgain.journalTail))).toBe(firstJournal);
    // And the fleet view tells the truth: awake, nothing pending.
    const fleet = await api<{ computers: { id: string; state: string; activeRuns: number }[] }>(
      instance.url,
      cookie,
      '/api/fleet',
    );
    const card = fleet.body.computers.find((c) => c.id === id);
    expect(card?.state).toBe('awake');
    expect(card?.activeRuns).toBe(0);
  }, 900_000);

  it('step 4: POST /wake on an evicted AWAKE computer materializes a new container', async () => {
    // The same lie from the other direction, and with no run to hide behind: the
    // DO said {"state":"awake","epoch":1} and did nothing at all.
    const id = await newComputer('wake-honest');
    const wake = await api<{ state: string; epoch: number }>(
      instance.url,
      cookie,
      `/api/computers/${id}/wake`,
      { method: 'POST' },
    );
    expect(wake.body.state).toBe('awake');
    const containerA = (await containersFor(id))[0] as string;
    expect(containerA).toBeTruthy();

    expect((await docker(['rm', '-f', containerA], 120_000)).code).toBe(0);
    // Past the grace window: a network blip is not a dead container, so the DO
    // waits before it stops believing its own record (production default 15 s).
    await new Promise((r) => setTimeout(r, 2_000));

    const again = await api<{ state: string; epoch: number }>(
      instance.url,
      cookie,
      `/api/computers/${id}/wake`,
      { method: 'POST' },
    );
    expect(again.status).toBe(200);
    expect(again.body.state).toBe('awake');
    expect(again.body.epoch).toBeGreaterThan(wake.body.epoch);

    const containerB = (await containersFor(id)).filter((c) => c !== containerA);
    expect(containerB).toHaveLength(1);
    expect(await containerStatus(containerB[0] as string)).toBe('running');
    expect(Number((await containerEnv(containerB[0] as string))['MARI_EPOCH'])).toBe(
      again.body.epoch,
    );
  }, 600_000);

  it('an in-flight run is interrupted once, keeps its journal, and the computer comes back', async () => {
    // The degradation spec 5.6 defines, driven by a real eviction: the run had
    // started and produced output, so it is NOT replayed — it is interrupted, its
    // journal is preserved, and the user is told exactly once.
    const id = await newComputer('interrupted');
    await api(instance.url, cookie, `/api/computers/${id}/wake`, { method: 'POST' });
    const containerA = (await containersFor(id))[0] as string;

    const runId = await startRun(
      id,
      "i=0; while [ \"$i\" -lt 600 ]; do printf 'tick-%03d\\n' \"$i\"; i=$((i+1)); sleep 0.5; done",
    );
    // Wait until the control plane durably holds part of its journal.
    await waitUntil(
      async () => {
        const r = await runDetail(id, runId);
        return new TextDecoder().decode(fromBase64(r.journalTail)).includes('tick-003');
      },
      120_000,
      'the long run to emit ticks',
    );
    const before = await runDetail(id, runId);
    const journalBefore = fromBase64(before.journalTail);
    expect(before.status).toBe('running');

    expect((await docker(['rm', '-f', containerA], 120_000)).code).toBe(0);

    // The DO notices and interrupts the run rather than losing it or pretending it
    // completed.
    await waitUntil(
      async () => (await runDetail(id, runId)).status === 'interrupted',
      120_000,
      'the in-flight run to be interrupted',
    );
    const after = await runDetail(id, runId);
    expect(after.exitCode).toBeNull();
    // The journal it produced is still there, byte for byte, and never rewritten.
    const journalAfter = fromBase64(after.journalTail);
    expect(new TextDecoder().decode(journalAfter).startsWith(
      new TextDecoder().decode(journalBefore).slice(0, 32),
    )).toBe(true);
    expect(after.journalLength).toBeGreaterThanOrEqual(before.journalLength);

    // Exactly one content-free attention event (spec 6.2/6.3) — the control plane
    // raised it, and marid's own `interrupted` event for the same run does not
    // add a second badge.
    const attention = await api<{
      attention: { id: number; run: string; kind: string; at: number; dismissed: boolean }[];
    }>(instance.url, cookie, `/api/computers/${id}/attention`);
    const mine = attention.body.attention.filter((a) => a.run === runId);
    expect(mine).toHaveLength(1);
    expect(mine[0]?.kind).toBe('interrupted');
    expect(Object.keys(mine[0] ?? {}).sort()).toEqual(
      ['at', 'dismissed', 'id', 'kind', 'run'].sort(),
    );

    // And the computer is usable again: a new run lands in a fresh container.
    const proof = await startRun(id, "printf 'usable-again\\n'");
    const done = await awaitExit(id, proof, 240_000);
    expect(done.exitCode).toBe(0);
    expect(await awaitJournal(id, proof, 'usable-again')).toContain('usable-again');
    const live = (await containersFor(id)).filter((c) => c !== containerA);
    expect(live.length).toBeGreaterThanOrEqual(1);
  }, 900_000);
});
