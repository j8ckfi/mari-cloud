// The Node runtime IS the control plane (spec 11.2, decisions.md deviation 4).
//
// These tests run the SAME `ComputerDO`, the SAME Hono app and the SAME wire
// protocol as the Workers suite, but on the Node platform: SQLite Durable
// Object storage, a filesystem chunk store keyed by contracts.md §9, a real
// `ws` server, and real alarm timers driving the tier policy (spec 4.4).
//
// No Docker required — the substrate here is the fake, because what is under
// test is the PLATFORM. The real Docker substrate has its own suite
// (`docker.e2e.test.ts`, gated on MARI_NODE_E2E=1).

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { MaterializeSpec } from '../../src/substrates/provider.js';
import type { ComputerDO } from '../../src/computer-do.js';
import type { NodeInstance } from '../../src/node.js';
import {
  api,
  bytesEqual,
  fromBase64,
  makeLocalDir,
  removeDir,
  seedSession,
  startInstance,
  waitUntil,
  WireClient,
  WireSupervisor,
} from './harness.js';

interface RunSummary {
  id: string;
  state: string;
  argv: string[];
  journalLength?: number;
  journalTail?: string;
  preRunManifest: string | null;
  postRunManifest: string | null;
}

let dataDir: string;
let storeDir: string;
let instance: NodeInstance;
let cookie: string;
let seedManifest: string;

/** The fake driver's recorded materialize specs (test observability only). */
function specsOf(computerDo: ComputerDO): MaterializeSpec[] {
  return (computerDo.substrate as unknown as { specs: MaterializeSpec[] }).specs;
}

function opsOf(computerDo: ComputerDO): string[] {
  return (computerDo.substrate as unknown as { calls: { op: string }[] }).calls.map((c) => c.op);
}

/** Create a fresh COLD computer through the real API. */
async function newComputer(name: string): Promise<string> {
  const res = await api<{ id: string }>(instance.url, cookie, '/api/computers', {
    method: 'POST',
    body: JSON.stringify({ name }),
  });
  expect(res.status).toBe(201);
  return res.body.id;
}

/** Wake a computer and return everything a supervisor needs to hand-shake. */
async function wakeWithToken(id: string): Promise<{ epoch: number; token: string }> {
  const wake = await api<{ state: string; epoch: number }>(
    instance.url,
    cookie,
    `/api/computers/${id}/wake`,
    { method: 'POST' },
  );
  expect(wake.status).toBe(200);
  expect(wake.body.state).toBe('awake');
  const computerDo = await instance.runtime.computers.instanceFor(id);
  const spec = specsOf(computerDo).at(-1);
  if (!spec) throw new Error('materialize was never called');
  // The one-time token never crosses the REST boundary: only `materialize` gets
  // it (contracts §6). Reading it from the driver's spec is exactly how a real
  // supervisor receives it.
  return { epoch: Number(spec.env['MARI_EPOCH']), token: spec.env['MARI_TOKEN'] as string };
}

beforeAll(async () => {
  dataDir = await makeLocalDir('mari-node-data');
  storeDir = join(dataDir, 'store');
  instance = await startInstance({
    dataDir,
    storeDir,
    substrateMode: 'fake',
    baseSnapshot: false,
    warmIdleMs: 300,
    coldIdleMs: 300,
  });
  const session = await seedSession(instance.url);
  cookie = session.cookie;
  seedManifest = session.manifest;
});

afterAll(async () => {
  await instance?.close();
  await removeDir(dataDir);
});

describe('node runtime: platform parity', () => {
  it('serves a COLD computer from the manifest, stored in the contracts §9 layout', async () => {
    // The seed wrote a real manifest + chunks through the R2 equivalent. The KEY
    // LAYOUT is the contract `marid` reads the same store by (opendal fs maps a
    // key onto root/key), so assert the bytes are exactly where it will look.
    const manifestPath = join(storeDir, 'manifests', `${seedManifest}.cbor`);
    expect((await stat(manifestPath)).size).toBeGreaterThan(0);

    const listing = await api<{ entries: { path: string }[]; manifest: string }>(
      instance.url,
      cookie,
      `/api/computers/seedcomputer/files?path=/`,
    );
    expect(listing.status).toBe(200);
    expect(listing.body.manifest).toBe(seedManifest);
    expect(listing.body.entries.map((e) => e.path).sort()).toEqual(['/README.md', '/notes', '/src']);

    const file = await fetch(`${instance.url}/api/computers/seedcomputer/file?path=/README.md`, {
      headers: { Cookie: cookie },
    });
    expect(file.status).toBe(200);
    expect(file.headers.get('x-mari-source')).toBe('manifest');
    expect(file.headers.get('x-mari-state')).toBe('cold');
    const contents = new TextDecoder().decode(new Uint8Array(await file.arrayBuffer()));
    expect(contents).toContain('# seed computer');

    // Serving those bytes must not have woken anything (spec 8.4).
    const computerDo = await instance.runtime.computers.instanceFor('seedcomputer');
    expect(opsOf(computerDo)).toEqual([]);
    expect(await computerDo.getState()).toBe('cold');
  });

  it('hands marid its whole configuration at materialize (spec 3.5, config.rs)', async () => {
    const id = await newComputer('config');
    await wakeWithToken(id);
    const computerDo = await instance.runtime.computers.instanceFor(id);
    const spec = specsOf(computerDo).at(-1);
    if (!spec) throw new Error('no materialize spec');

    expect(spec.image).toBe(instance.runtime.config.baseImage);
    expect(spec.env['MARI_COMPUTER_ID']).toBe(id);
    expect(spec.env['MARI_TOKEN']).toMatch(/^[0-9a-f]{32}$/);
    expect(spec.env['MARI_EPOCH']).toBe('1');
    expect(spec.env['MARI_ROOT']).toBe('/work');
    expect(spec.env['MARI_STORE']).toBe('fs:///store');
    // Reachable FROM the container: never localhost, and pointing at the port
    // this instance actually bound.
    expect(spec.env['MARI_CONTROL_URL']).toBe(
      `ws://${instance.runtime.config.controlHost}:${instance.port}/supervisor/${id}`,
    );
    expect(spec.env['MARI_CONTROL_URL']).not.toContain('localhost');
    // A computer with no head of its own and no base image manifest has nothing
    // to restore.
    expect(spec.env['MARI_RESTORE_MANIFEST']).toBeUndefined();
  });

  it('runs the supervisor protocol over a real WebSocket: dispatch, journal, attach, fencing', async () => {
    const id = await newComputer('wire');
    const { epoch, token } = await wakeWithToken(id);

    const sup = await WireSupervisor.connect(instance.url, id);
    const ack = await sup.handshake(id, epoch, token);
    expect(ack.t).toBe('hello_ack');

    // A run requested through the REST API reaches the supervisor as start_run.
    const started = sup.recv.waitForTag('start_run');
    const created = await api<{ runId: string; state: string }>(
      instance.url,
      cookie,
      `/api/computers/${id}/runs`,
      { method: 'POST', body: JSON.stringify({ argv: ['echo', 'hello'], cwd: '/work' }) },
    );
    expect(created.status).toBe(200);
    const runId = created.body.runId;
    expect((await started).c).toMatchObject({ run: runId, argv: ['echo', 'hello'], cwd: '/work' });

    // Journal: exact bytes in over the wire, exact bytes out through the API.
    const payload = new Uint8Array([0x68, 0x69, 0x0a, 0x00, 0xff, 0x7f, 0x80, 0x01]);
    sup.send({ t: 'run_started', c: { run: runId, pre_run_manifest: 'a'.repeat(64) } });
    sup.send({ t: 'journal_frame', c: { run: runId, offset: 0, bytes: payload } });
    const acked = await sup.recv.waitForTag('journal_ack');
    expect(acked.c).toMatchObject({ run: runId, offset: payload.length });

    const detail = await api<RunSummary>(instance.url, cookie, `/api/computers/${id}/runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.journalLength).toBe(payload.length);
    expect(bytesEqual(fromBase64(detail.body.journalTail as string), payload)).toBe(true);

    // The segment lands in the object store under the contracts §9 key.
    const segKey = join(storeDir, 'journal', id, runId, '000000000000.seg');
    await waitUntil(
      async () => {
        try {
          return (await stat(segKey)).size === payload.length;
        } catch {
          return false;
        }
      },
      5000,
      'journal segment in the store',
    );
    expect(new Uint8Array(await readFile(segKey))).toEqual(payload);

    // An attached browser client replays those exact bytes and can type back.
    const client = await WireClient.connect(instance.url, id, cookie);
    client.attach(runId);
    expect(await client.recv.waitForTag('grid')).toMatchObject({ run: runId });
    const frame = await client.recv.waitForTag('frame');
    expect(bytesEqual(new Uint8Array(frame['bytes'] as Uint8Array), payload)).toBe(true);

    const inputSeen = sup.recv.waitForTag('input');
    client.send({ t: 'input', run: runId, bytes: new Uint8Array([0x71, 0x0d]) });
    const input = await inputSeen;
    expect(bytesEqual(new Uint8Array((input.c as { bytes: Uint8Array }).bytes), new Uint8Array([0x71, 0x0d]))).toBe(true);
    client.close();

    // Epoch fencing (spec 4.1 / contracts §6): stale is REJECTED, head unmoved.
    const stale = sup.recv.waitForTag('head_advance_result');
    sup.send({ t: 'head_advance_request', c: { manifest: 'b'.repeat(64), epoch: epoch - 1 } });
    expect((await stale).c).toMatchObject({ accepted: false, current_epoch: epoch });
    const computerDo = await instance.runtime.computers.instanceFor(id);
    expect(await computerDo.getHead()).toBeNull();

    const fresh = sup.recv.waitForTag('head_advance_result');
    sup.send({ t: 'head_advance_request', c: { manifest: 'c'.repeat(64), epoch } });
    expect((await fresh).c).toMatchObject({ accepted: true });
    expect(await computerDo.getHead()).toBe('c'.repeat(64));

    sup.close();
  });

  it("refuses an unauthenticated terminal attach (the journal is the user's business)", async () => {
    const id = await newComputer('attach-guard');
    await expect(WireClient.connect(instance.url, id, 'mari.session_token=nonsense')).rejects.toThrow(
      /upgrade refused: 40[13]/,
    );
  });

  it('closes a supervisor socket that presents the wrong token (contracts Appendix B)', async () => {
    const id = await newComputer('token-guard');
    const { epoch } = await wakeWithToken(id);
    const sup = await WireSupervisor.connect(instance.url, id);
    const closed = new Promise<number>((resolve) => sup.ws.once('close', (code) => resolve(code)));
    sup.send({
      t: 'hello',
      c: { computer: id, epoch, token: 'not-the-minted-token', proto_version: 1 },
    });
    expect(await closed).toBe(1008);
  });

  it('drives the tier policy on REAL timers (spec 4.4), calling the driver in order', async () => {
    const id = await newComputer('tier');
    await wakeWithToken(id);
    const computerDo = await instance.runtime.computers.instanceFor(id);
    expect(opsOf(computerDo)).toEqual(['materialize']);

    // Nothing is fired by hand: WARM_IDLE_MS=300 was armed by the wake and the
    // scheduled alarm must fire on its own, then arm the WARM->COLD one.
    await waitUntil(async () => (await computerDo.getState()) === 'warm', 10_000, 'AWAKE -> WARM');
    expect(opsOf(computerDo)).toEqual(['materialize', 'sleep']);
    await waitUntil(async () => (await computerDo.getState()) === 'cold', 10_000, 'WARM -> COLD');
    expect(opsOf(computerDo)).toEqual(['materialize', 'sleep', 'destroy']);

    const fleet = await api<{ computers: { id: string; state: string }[] }>(
      instance.url,
      cookie,
      '/api/fleet',
    );
    expect(fleet.body.computers.find((c) => c.id === id)?.state).toBe('cold');
  });

  it('streams live, content-free events to /api/events (spec 6.2) across two Durable Objects', async () => {
    const id = await newComputer('events');
    const { epoch, token } = await wakeWithToken(id);

    // A real SSE subscription: ComputerDO -> EventsDO(user) -> this stream.
    const stream = await fetch(`${instance.url}/api/events`, { headers: { Cookie: cookie } });
    expect(stream.status).toBe(200);
    expect(stream.headers.get('content-type')).toContain('text/event-stream');
    const reader = (stream.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let seen = '';
    const readUntil = async (needle: string, timeoutMs = 10_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (!seen.includes(needle)) {
        if (Date.now() > deadline) throw new Error(`timeout waiting for ${needle} in ${seen}`);
        const { value, done } = await reader.read();
        if (done) throw new Error(`event stream closed; saw: ${seen}`);
        seen += decoder.decode(value, { stream: true });
      }
    };
    await readUntil(': ready');

    const sup = await WireSupervisor.connect(instance.url, id);
    await sup.handshake(id, epoch, token);
    const started = sup.recv.waitForTag('start_run');
    const created = await api<{ runId: string }>(instance.url, cookie, `/api/computers/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ argv: ['agent'] }),
    });
    await started;
    const runId = created.body.runId;
    sup.send({ t: 'attention', c: { run: runId, kind: 'bell' } });

    await readUntil('event: attention');
    const record = seen
      .split('\n\n')
      .find((block) => block.startsWith('event: attention')) as string;
    const payload = JSON.parse(record.split('data: ')[1] as string) as Record<string, unknown>;
    expect(payload).toMatchObject({
      type: 'attention',
      computer: id,
      runId,
      state: 'waiting',
      kind: 'bell',
    });
    // Content-free (spec 6.3): the record carries metadata and nothing else.
    expect(Object.keys(payload).sort()).toEqual(
      ['at', 'computer', 'kind', 'runId', 'seq', 'state', 'type'].sort(),
    );

    await reader.cancel();
    sup.close();
  });

  it('survives a restart: head, run history and journal bytes are durable', async () => {
    const id = await newComputer('durable');
    const { epoch, token } = await wakeWithToken(id);

    const sup = await WireSupervisor.connect(instance.url, id);
    await sup.handshake(id, epoch, token);
    const started = sup.recv.waitForTag('start_run');
    const created = await api<{ runId: string }>(instance.url, cookie, `/api/computers/${id}/runs`, {
      method: 'POST',
      body: JSON.stringify({ argv: ['sleep', '1'] }),
    });
    await started;
    const runId = created.body.runId;
    const payload = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
    sup.send({ t: 'journal_frame', c: { run: runId, offset: 0, bytes: payload } });
    await sup.recv.waitForTag('journal_ack');
    const head = 'd'.repeat(64);
    const advanced = sup.recv.waitForTag('head_advance_result');
    sup.send({ t: 'head_advance_request', c: { manifest: head, epoch } });
    expect((await advanced).c).toMatchObject({ accepted: true });
    sup.close();

    // Restart the runtime against the same data directory.
    await instance.close();
    instance = await startInstance({
      dataDir,
      storeDir,
      substrateMode: 'fake',
      baseSnapshot: false,
      warmIdleMs: 60_000,
      coldIdleMs: 60_000,
    });

    const after = await api<RunSummary>(instance.url, cookie, `/api/computers/${id}/runs/${runId}`);
    expect(after.status).toBe(200);
    expect(after.body.argv).toEqual(['sleep', '1']);
    expect(bytesEqual(fromBase64(after.body.journalTail as string), payload)).toBe(true);

    const restarted = await instance.runtime.computers.instanceFor(id);
    expect(await restarted.getHead()).toBe(head);
    // The fencing epoch survives the restart and never goes backwards
    // (contracts §6). The substrate HANDLE survived too: the computer is still
    // AWAKE as far as the coordination point is concerned, so sleeping and
    // waking it resumes that handle rather than materializing a second copy of
    // the computer (spec 4.1 — two writable copies must not exist).
    expect((await restarted.describe(id)).epoch).toBe(epoch);
    expect(await restarted.sleepNow()).toBe('warm');
    const rewake = await api<{ state: string; epoch: number }>(
      instance.url,
      cookie,
      `/api/computers/${id}/wake`,
      { method: 'POST' },
    );
    expect(rewake.body).toMatchObject({ state: 'awake', epoch: epoch + 1 });
    expect(opsOf(restarted)).toEqual(['sleep', 'wake']);
    expect(specsOf(restarted)).toHaveLength(0);
  });
});
