// The private-instance thesis test: a computer is data (spec 1.1, 4.1, 4.4, 11.2).
//
// GATE: `MARI_NODE_E2E=1` (needs a Docker daemon and the `mari/base:v0` image,
// which this suite builds if it is missing — deploy/Dockerfile.marid).
//
//   MARI_NODE_E2E=1 pnpm --filter @mari/control-plane test:node
//
// Everything here is real: the Node control plane on a real port, the REAL
// Docker substrate selected by `selectSubstrate` (spec 3.6), a REAL container
// running the REAL `marid` binary, a real framed-CBOR WebSocket between them,
// and a filesystem chunk store both sides open (the control plane as its R2
// equivalent, marid as `fs:///store`).
//
// Substrate state is asserted against the DOCKER DAEMON, not against Mari's own
// API: paused means `.State.Status == "paused"`, destroyed means the container
// is gone from `docker ps -a`, and restored means `docker exec cat` returns the
// same bytes. Every container is removed by label in `afterAll`, on every path.
//
// NOTE for macOS: the chunk store must live under `$HOME`. The daemon runs in a
// VM that shares `$HOME` but not `/tmp`, and a bind mount of an unshared path is
// silently EMPTY inside the container.

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NodeInstance } from '../../src/node.js';
import { ensureBaseManifest } from '../../src/node.js';
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
  containerMounts,
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

/** Deterministic, shell-safe payload so the exact bytes are known end to end. */
function knownBlob(len: number, seed: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) {
    out += alphabet[(i * 7919 + seed * 104729) % alphabet.length];
  }
  return out;
}

interface RunSummary {
  id: string;
  state: string;
  exitCode: number | null;
  journalTail?: string;
  journalLength?: number;
  preRunManifest: string | null;
  postRunManifest: string | null;
}

let instance: NodeInstance;
let dataDir: string;
let storeDir: string;
let cookie: string;

async function newComputer(name: string): Promise<string> {
  const res = await api<{ id: string }>(instance.url, cookie, '/api/computers', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Fire the computer's own tier alarm until it reaches `target` (spec 4.4). The
 *  alarm is the real one the DO armed; only its clock is being hurried. */
async function advanceTier(id: string, target: string, timeoutMs = 120_000): Promise<void> {
  const state = instance.runtime.computers.stateFor(id);
  const stub = instance.runtime.computers.get(instance.runtime.computers.idFromName(id));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await stub.getState()) === target) return;
    if (Date.now() > deadline) {
      throw new Error(`computer ${id} never reached ${target} (now ${await stub.getState()})`);
    }
    await state.storage.runAlarmNow();
    await new Promise((r) => setTimeout(r, 500));
  }
}

beforeAll(async () => {
  if (!GATE) return;
  if (!(await dockerAvailable())) {
    throw new Error('MARI_NODE_E2E=1 but no Docker daemon is reachable');
  }
  if (!(await imageExists(BASE_IMAGE))) {
    // Build the base image the same way deploy/README.md documents.
    const build = await docker(
      ['build', '-f', 'deploy/Dockerfile.marid', '-t', BASE_IMAGE, REPO_ROOT],
      1_800_000,
    );
    if (build.code !== 0) {
      throw new Error(`building ${BASE_IMAGE} failed:\n${build.stdout}\n${build.stderr}`);
    }
  }
  await cleanupAllMariContainers();

  dataDir = await makeSharedDir('cp');
  storeDir = join(dataDir, 'store');
  instance = await startInstance({
    dataDir,
    storeDir,
    // Bind on all interfaces: the container dials back over the Docker network.
    hostname: '0.0.0.0',
    substrateMode: 'docker',
    substrates: ['docker'],
    baseImage: BASE_IMAGE,
    baseSnapshot: false, // driven explicitly by the first test
    // Long thresholds: the tier transitions here are fired deliberately, so a
    // background timer cannot race the assertions.
    warmIdleMs: 3_600_000,
    coldIdleMs: 3_600_000,
  });
  cookie = (await seedSession(instance.url)).cookie;
}, 1_800_000);

afterAll(async () => {
  if (!GATE) return;
  await instance?.close();
  await cleanupAllMariContainers();
  if (dataDir) await removeDir(dataDir);
});

describe.runIf(GATE)('private instance on the real Docker substrate', () => {
  it('selects a real driver, never the fake (spec 3.6/3.7)', () => {
    expect(instance.runtime.substrate).not.toBeNull();
    expect(instance.runtime.substrate?.available).toEqual(['docker']);
  });

  it('snapshots the base image ONCE into the chunk store (spec §2)', async () => {
    const manifest = await ensureBaseManifest(instance.runtime, { log: () => {} });
    expect(manifest).toMatch(/^[0-9a-f]{64}$/);

    // Written by marid through mari-core, into the store the control plane owns.
    const manifestPath = join(storeDir, 'manifests', `${manifest}.cbor`);
    expect((await stat(manifestPath)).size).toBeGreaterThan(0);
    const pointerPath = join(storeDir, 'base', `${BASE_IMAGE.replace(/[^A-Za-z0-9._-]/g, '_')}.json`);
    const pointerAt = JSON.parse(new TextDecoder().decode(await readFile(pointerPath))) as {
      manifest: string;
      at: number;
    };
    expect(pointerAt.manifest).toBe(manifest);

    // The bootstrap computer left NO substrate resources behind (spec 4.4 COLD).
    const leftovers = await containersFor('base-maribasev0');
    expect(leftovers).toEqual([]);

    // "The fleet stores each base image once": a second call reuses the stored
    // pointer — same manifest, untouched timestamp, no new container.
    const again = await ensureBaseManifest(instance.runtime, { log: () => {} });
    expect(again).toBe(manifest);
    const pointerAgain = JSON.parse(new TextDecoder().decode(await readFile(pointerPath))) as {
      manifest: string;
      at: number;
    };
    expect(pointerAgain.at).toBe(pointerAt.at);
    expect(await containersFor('base-maribasev0')).toEqual([]);
    // Every later computer starts from it (spec 4.6(a)).
    expect(instance.runtime.env.BASE_MANIFEST).toBe(manifest);
  }, 600_000);

  it('wakes into a real container, runs a real run, and goes COLD then back with byte-identical files', async () => {
    const id = await newComputer('thesis');
    const blob = knownBlob(2048, 7);
    const marker = 'mari-e2e-marker-9f2a';

    // ---- wake: a REAL container, running the REAL marid -------------------
    const wake = await api<{ state: string; epoch: number }>(instance.url, cookie, `/api/computers/${id}/wake`, {
      method: 'POST',
    });
    expect(wake.body.state).toBe('awake');

    const first = await containersFor(id);
    expect(first).toHaveLength(1);
    const containerA = first[0] as string;
    expect(await containerStatus(containerA)).toBe('running');

    // materialize handed marid its whole configuration (spec 3.5): the daemon's
    // own record of the container's environment is the assertion.
    const env = await containerEnv(containerA);
    expect(env['MARI_COMPUTER_ID']).toBe(id);
    expect(env['MARI_EPOCH']).toBe(String(wake.body.epoch));
    expect(env['MARI_TOKEN']).toMatch(/^[0-9a-f]{32}$/);
    expect(env['MARI_ROOT']).toBe('/work');
    expect(env['MARI_STORE']).toBe('fs:///store');
    expect(env['MARI_CONTROL_URL']).toBe(
      `ws://${instance.runtime.config.controlHost}:${instance.port}/supervisor/${id}`,
    );
    // A brand new computer restores the base image's root (spec §2 / 4.6(a)).
    expect(env['MARI_RESTORE_MANIFEST']).toBe(instance.runtime.env.BASE_MANIFEST);
    // The chunk store is the computer's home, mounted, not proxied.
    expect(await containerMounts(containerA)).toContainEqual({
      source: storeDir,
      target: '/store',
    });

    // ---- a run started through the REST API produces journal bytes --------
    const created = await api<{ runId: string }>(instance.url, cookie, `/api/computers/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify({
        argv: ['/bin/sh', '-c', `printf '%s' '${blob}' > /work/log.txt; printf '${marker}\\n'`],
        cwd: '/work',
      }),
    });
    const runId = created.body.runId;

    let detail: RunSummary | null = null;
    await waitUntil(
      async () => {
        const res = await api<RunSummary>(
          instance.url,
          cookie,
          `/api/computers/${id}/runs/${runId}`,
        );
        detail = res.body;
        return res.status === 200 && res.body.state === 'exited';
      },
      180_000,
      `run ${runId} to exit (marid log: ${await containerLogs(containerA, 20)})`,
    );
    const finished = detail as unknown as RunSummary;
    expect(finished.exitCode).toBe(0);

    // The journal the supervisor streamed is retrievable through the API and
    // carries the exact bytes the run printed (spec 4.2). It is coalesced in
    // <=100 ms windows (decisions.md), so it can trail the exit by a beat.
    let journal = new Uint8Array();
    await waitUntil(
      async () => {
        const res = await api<RunSummary>(
          instance.url,
          cookie,
          `/api/computers/${id}/runs/${runId}`,
        );
        journal = fromBase64(res.body.journalTail ?? '');
        return new TextDecoder().decode(journal).includes(marker);
      },
      30_000,
      `journal bytes for ${runId} (marid log: ${await containerLogs(containerA, 20)})`,
    );
    expect(new TextDecoder().decode(journal)).toContain(marker);
    // Byte-level: the PTY line is the marker plus the terminal's CRLF, and
    // nothing else was fabricated around it.
    expect(journal).toEqual(new TextEncoder().encode(`${marker}\r\n`));
    expect(finished.preRunManifest).toMatch(/^[0-9a-f]{64}$/);
    expect(finished.postRunManifest).toMatch(/^[0-9a-f]{64}$/);
    expect(finished.postRunManifest).not.toBe(finished.preRunManifest);

    // The run's difference is computed in the control plane from the two REAL
    // manifests mari-core wrote (spec 5.3 / 9.2) — a cross-language read of
    // blake3-addressed CBOR.
    const diff = await api<{
      summary: { added: number; modified: number; removed: number };
      entries: { path: string; change: string }[];
    }>(instance.url, cookie, `/api/computers/${id}/runs/${runId}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.body.entries.map((e) => `${e.change} ${e.path}`)).toContain('added /log.txt');

    // ---- a file WRITE is a run, applied on the substrate disk (spec 4.1) --
    // The control plane never synthesizes chunks: it queues a run that writes
    // the bytes, so the only writable copy stays the AWAKE disk.
    const written = new Uint8Array([0, 1, 2, 250, 251, 252, 10, 13, 65, 66]);
    const put = await fetch(`${instance.url}/api/computers/${id}/file?path=/notes/put.bin`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/octet-stream' },
      body: written,
    });
    expect(put.status).toBe(202);
    await waitUntil(
      async () => {
        try {
          const onDisk = await readFileInContainer(containerA, '/work/notes/put.bin');
          return bytesEqual(onDisk, written);
        } catch {
          return false;
        }
      },
      60_000,
      'the write run to land on the container disk',
    );

    // ---- the sizes that used to be SILENTLY LOST -------------------------
    //
    // 96 KiB of bytes is 131072 base64 characters — one over Linux's
    // `MAX_ARG_STRLEN` with its NUL. While the payload was one argv element the
    // supervisor's spawn failed with `E2BIG`, the run ended `signal=6`, nothing
    // reached the disk, and this route had already answered `202 {ok:true}`.
    // Nothing in the suite noticed, because the only write it made was 10 bytes.
    // These two go through the REAL supervisor onto the REAL disk.
    for (const size of [96 * 1024, 200 * 1024]) {
      const payload = new Uint8Array(size);
      for (let i = 0; i < size; i++) payload[i] = (i * 31 + (i >> 8)) & 0xff;
      const res = await fetch(`${instance.url}/api/computers/${id}/file?path=/notes/big${size}.bin`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'content-type': 'application/octet-stream' },
        body: payload,
      });
      expect(res.status).toBe(202);
      const runIdBig = ((await res.json()) as { runId: string }).runId;
      await waitUntil(
        async () => {
          try {
            return bytesEqual(
              await readFileInContainer(containerA, `/work/notes/big${size}.bin`),
              payload,
            );
          } catch {
            return false;
          }
        },
        60_000,
        `the ${size}-byte write to land byte-identically on the container disk`,
      );
      // ...and the run that did it SUCCEEDED: not signaled, not failed. A
      // spawn that aborts leaves `signal` set, which is what made the loss
      // silent — the API had already said "ok".
      const rec = await api<{ state: string; signal: number | null; exitCode: number | null }>(
        instance.url,
        cookie,
        `/api/computers/${id}/runs/${runIdBig}`,
      );
      expect(rec.body.signal, `signal for ${size}`).toBeNull();
      expect(rec.body.exitCode, `exit for ${size}`).toBe(0);
      // No staging file is left behind for the next snapshot to commit.
      await expect(
        readFileInContainer(containerA, `/work/notes/big${size}.bin.mari-${runIdBig}.part`),
      ).rejects.toThrow();
    }

    // ---- tier policy: AWAKE -> WARM is a REAL pause (spec 4.4) ------------
    await advanceTier(id, 'warm');
    expect(await containerStatus(containerA)).toBe('paused');

    // ---- WARM -> COLD is a REAL destroy, after a clean final snapshot -----
    await advanceTier(id, 'cold');
    await waitUntil(async () => (await containerStatus(containerA)) === null, 60_000, 'container A gone');
    expect(await containersFor(id)).toEqual([]);

    const computerDo = await instance.runtime.computers.instanceFor(id);
    const coldHead = await computerDo.getHead();
    expect(coldHead).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(join(storeDir, 'manifests', `${coldHead}.cbor`))).size).toBeGreaterThan(0);

    // A COLD computer is still browsable from its manifest alone (spec 8.4):
    // no substrate exists at all right now.
    const listing = await api<{ entries: { path: string }[] }>(
      instance.url,
      cookie,
      `/api/computers/${id}/files?path=/`,
    );
    expect(listing.status).toBe(200);
    expect(listing.body.entries.map((e) => e.path).sort()).toEqual(['/log.txt', '/notes']);

    // ---- wake again: a FRESH container, restored from the chunk store -----
    const rewake = await api<{ state: string; epoch: number }>(
      instance.url,
      cookie,
      `/api/computers/${id}/wake`,
      { method: 'POST' },
    );
    expect(rewake.body.state).toBe('awake');
    expect(rewake.body.epoch).toBeGreaterThan(wake.body.epoch);

    const second = await containersFor(id);
    expect(second).toHaveLength(1);
    const containerB = second[0] as string;
    expect(containerB).not.toBe(containerA);
    expect(await containerStatus(containerB)).toBe('running');
    expect((await containerEnv(containerB))['MARI_RESTORE_MANIFEST']).toBe(coldHead);

    // The file is byte-identical INSIDE the new container — the storage
    // inversion, asserted against Docker and not against Mari (spec 1.1/4.1).
    const expected = new TextEncoder().encode(blob);
    let restored = new Uint8Array();
    await waitUntil(
      async () => {
        try {
          restored = await readFileInContainer(containerB, '/work/log.txt');
        } catch {
          return false;
        }
        return restored.length === expected.length;
      },
      120_000,
      `restore of /work/log.txt into ${containerB.slice(0, 12)}`,
    );
    expect(bytesEqual(restored, expected)).toBe(true);
    // ...and so is the file that arrived through the write API.
    expect(bytesEqual(await readFileInContainer(containerB, '/work/notes/put.bin'), written)).toBe(
      true,
    );

    // And the run history survived the trip through COLD.
    const history = await api<{ runs: { id: string; state: string }[] }>(
      instance.url,
      cookie,
      `/api/computers/${id}/runs`,
    );
    expect(history.body.runs.find((r) => r.id === runId)?.state).toBe('exited');
  }, 900_000);

  it('leaves no containers behind once every computer is COLD', async () => {
    // Take anything this file woke back to COLD, then assert the daemon agrees.
    for (const name of instance.runtime.computers.liveNames()) {
      const stub = instance.runtime.computers.get(instance.runtime.computers.idFromName(name));
      const state = await stub.getState();
      if (state === 'awake') await advanceTier(name, 'warm');
      if ((await stub.getState()) === 'warm') await advanceTier(name, 'cold');
      expect(await containersFor(name)).toEqual([]);
    }
  }, 600_000);
});
