// THE 1.3 LOOP — the product's central claim, end to end, for real.
//
//   spec 1.3: "A user starts work from the web application. The user can then
//   disconnect. The agents continue. The user can see the results from each
//   device."
//
// GATE: `MARI_LOOP_E2E=1`. Ungated this file collects no tests and exits clean.
//
//   MARI_LOOP_E2E=1 pnpm --filter @mari/e2e test
//
// Nothing in this path is faked. The control plane is the REAL private instance
// (`boot()` from packages/control-plane/src/node — the same function
// deploy/docker-compose.yml runs, spec 11.2) on a temp store and temp SQLite.
// The substrate is the REAL Docker driver selected by `selectSubstrate`
// (spec 3.6/3.7). The computer is a REAL container running the REAL `marid`
// binary from `mari/base:v0`. The run is a REAL process on a REAL PTY. The
// client is a REAL HTTP/WebSocket/SSE peer over a real socket.
//
// The four claims of 1.3 and how each is proven here:
//
//   "starts work from the web application"  a run is created through
//       `POST /api/computers/:id/runs`, the exact route the web app's run
//       launcher calls; the computer is COLD, so the wake happens behind the
//       request (spec 8.3) and materializes a container.
//   "can then disconnect"  every socket the device holds is torn down, and the
//       proof is taken from the SERVER's side: the instance's own
//       `http.Server` is watched, and during the window it must hold NO
//       connection except the supervisor's. A client-side `readyState` proves
//       only what the client believes.
//   "the agents continue"  the run keeps emitting a known, ordered byte
//       sequence while nothing is attached; the journal the control plane holds
//       must contain the disconnected window's bytes, contiguous and in order
//       (spec 4.2, 5.1: a network connection must not own a run).
//   "from each device"  a second device — a fresh connection pool, the same
//       session — reads the result: the journal, the completion event, the exit
//       status, the diff, the files.
//
// Then the storage inversion that makes the claim survive a machine going away
// (spec 4.4/4.1): the tier policy destroys the container, and a FRESH container
// comes back with the run's files byte-identical, asserted against the Docker
// daemon rather than against Mari.
//
// NOTE for macOS: the chunk store must live under `$HOME`. The daemon runs in a
// VM that shares `$HOME` but not `/tmp`; a bind mount of an unshared path is
// silently EMPTY inside the container, which looks exactly like a computer that
// lost its files.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUBSTRATE_PRICE_PER_HOUR } from '../packages/control-plane/src/pricing.js';
import { Device } from './src/device.js';
import {
  ConnectionWitness,
  Timings,
  makeSharedDir,
  removeDir,
  startInstance,
  type NodeInstance,
} from './src/instance.js';
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
  listFilesInContainer,
  readFileInContainer,
} from './src/docker.js';
import { bytesEqual, delay, firstDifference, waitUntil } from './src/wait.js';

const GATE = process.env.MARI_LOOP_E2E === '1';
const BASE_IMAGE = process.env.MARI_BASE_IMAGE ?? 'mari/base:v0';
const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url).href));

// ---------------------------------------------------------------------------
// The run: known output over ~12 s, and three files with known bytes.
// ---------------------------------------------------------------------------

const TICKS = 24;
const TICK_INTERVAL_S = 0.5;
const TICK_PREFIX = 'MARI-TICK';
const DONE_MARKER = 'MARI-RUN-DONE';
/** Time with nothing attached. Long enough that the run's midpoint falls
 *  inside the window (the disconnect happens within the first few ticks). */
const DISCONNECT_WINDOW_MS = 7_000;

/** Deterministic, shell-safe payload: the exact bytes are known end to end. */
function knownBlob(len: number, seed: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[(i * 7919 + seed * 104729) % alphabet.length];
  return out;
}

const PAYLOAD = knownBlob(4096, 11);
const COMPUTER_ROOT = '/work';
const LOG_PATH = '/loop/ticks.log';
const PAYLOAD_PATH = '/loop/payload.bin';
const DONE_PATH = '/loop/done.txt';

/** The script the run executes. POSIX sh (the base image's `/bin/sh` is dash). */
const RUN_SCRIPT = [
  'set -e',
  `mkdir -p ${COMPUTER_ROOT}/loop`,
  'i=0',
  `while [ "$i" -lt ${TICKS} ]; do`,
  `  printf '${TICK_PREFIX}-%03d\\n' "$i"`,
  `  printf 'tick %03d\\n' "$i" >> ${COMPUTER_ROOT}${LOG_PATH}`,
  '  i=$((i+1))',
  `  sleep ${TICK_INTERVAL_S}`,
  'done',
  `printf '%s' '${PAYLOAD}' > ${COMPUTER_ROOT}${PAYLOAD_PATH}`,
  `printf 'done\\n' > ${COMPUTER_ROOT}${DONE_PATH}`,
  `printf '${DONE_MARKER}\\n'`,
].join('\n');

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Exactly what the PTY must deliver: every tick, then the done marker, each
 *  terminated by the terminal's CRLF, and nothing else. */
function expectedJournal(): Uint8Array {
  let s = '';
  for (let i = 0; i < TICKS; i++) s += `${TICK_PREFIX}-${String(i).padStart(3, '0')}\r\n`;
  s += `${DONE_MARKER}\r\n`;
  return enc.encode(s);
}

/** Exactly what `ticks.log` must contain (written by the run, not the PTY: no
 *  CR translation on a file redirect). */
function expectedLogFile(): Uint8Array {
  let s = '';
  for (let i = 0; i < TICKS; i++) s += `tick ${String(i).padStart(3, '0')}\n`;
  return enc.encode(s);
}

/** Tick indices in `text`, in the order they appear. */
function ticksIn(text: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`${TICK_PREFIX}-(\\d{3})`, 'g');
  for (let m = re.exec(text); m !== null; m = re.exec(text)) out.push(Number(m[1]));
  return out;
}

// ---------------------------------------------------------------------------
// Shapes the REST surface returns (contracts.md Appendix C).
// ---------------------------------------------------------------------------

interface RunDetailBody {
  id: string;
  state: string;
  exitCode: number | null;
  signal: number | null;
  argv: string[];
  preRunManifest: string | null;
  postRunManifest: string | null;
  diff: { added: number; modified: number; removed: number } | null;
  journalLength: number;
  journalTailOffset: number;
  journalTail: string;
  journalTailEncoding: string;
}

interface DiffBody {
  runId: string;
  base: string;
  head: string;
  summary: { added: number; modified: number; removed: number };
  entries: { path: string; change: string; kind: string; newSize: number | null }[];
  truncated: boolean;
}

interface CostMeterBody {
  currency: string;
  accrued: number;
  ratePerHour: number;
  window: string;
  awakeSeconds: number;
}

interface FleetBody {
  computers: {
    id: string;
    state: string;
    activeRuns: number;
    changedFiles: number;
    cost: CostMeterBody;
    manifestHead: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let instance: NodeInstance;
let witness: ConnectionWitness;
let dataDir: string;
let storeDir: string;
let cookie: string;
let userId: string;
const timings = new Timings();

/** The computer, its run, and what each phase observed. */
let computerId = '';
let runId = '';
let containerA = '';
let coldHead = '';
let lastTickSeenLive = -1;
let bytesSeenLive: Uint8Array = new Uint8Array();
let journalAtReconnect: Uint8Array = new Uint8Array();
let costWhileAwake: CostMeterBody | null = null;
let costWhileWarm: CostMeterBody | null = null;

async function fleetEntry(device: Device, id: string): Promise<FleetBody['computers'][number]> {
  const res = await device.get<FleetBody>('/api/fleet');
  expect(res.status).toBe(200);
  const row = res.body.computers.find((c) => c.id === id);
  if (!row) throw new Error(`computer ${id} missing from the fleet view`);
  return row;
}

/** Drive the computer's own tier alarm until it reaches `target` (spec 4.4).
 *  The handler is the REAL one the DO armed at wake; only its clock is hurried,
 *  which is how idle time is simulated without idling for real minutes. */
async function advanceTier(id: string, target: string, timeoutMs = 180_000): Promise<void> {
  const state = instance.runtime.computers.stateFor(id);
  const stub = instance.runtime.computers.get(instance.runtime.computers.idFromName(id));
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await stub.getState()) === target) return;
    if (Date.now() > deadline) {
      throw new Error(`computer ${id} never reached ${target} (now ${await stub.getState()})`);
    }
    await state.storage.runAlarmNow();
    await delay(400);
  }
}

/** Label of the wake-latency series reported for spec 13. */
const WAKE_TO_SUPERVISOR = 'cold wake -> supervisor connected';
const WAKE_TO_FILES = 'cold wake -> run files byte-identical in a fresh container';

/** COLD -> AWAKE through the API, measuring what spec 13 asks for. Returns the
 *  new container id once `marid` has dialled back in. */
async function wakeAndMeasure(device: Device, id: string): Promise<string> {
  const stub = instance.runtime.computers.get(instance.runtime.computers.idFromName(id));
  expect(await stub.getState()).toBe('cold');
  const t0 = Date.now();
  const res = await device.postJson<{ state: string; epoch: number }>(`/api/computers/${id}/wake`);
  expect(res.status).toBe(200);
  expect(res.body.state).toBe('awake');
  timings.record('POST /wake -> awake (materialize returns)', Date.now() - t0);

  await waitUntil(
    () => witness.firstSupervisorUpgradeAfter(t0) !== null,
    180_000,
    'the restored supervisor to dial back in',
  );
  timings.record(WAKE_TO_SUPERVISOR, (witness.firstSupervisorUpgradeAfter(t0) as number) - t0);

  const ids = await containersFor(id);
  expect(ids).toHaveLength(1);
  return ids[0] as string;
}

// ---------------------------------------------------------------------------

beforeAll(async () => {
  if (!GATE) return;
  if (!(await dockerAvailable())) {
    throw new Error('MARI_LOOP_E2E=1 but no Docker daemon is reachable');
  }
  if (!(await imageExists(BASE_IMAGE))) {
    const build = await docker(
      ['build', '-f', 'deploy/Dockerfile.marid', '-t', BASE_IMAGE, REPO_ROOT],
      1_800_000,
    );
    if (build.code !== 0) {
      throw new Error(`building ${BASE_IMAGE} failed:\n${build.stdout}\n${build.stderr}`);
    }
  }
  await cleanupAllMariContainers();

  dataDir = await makeSharedDir('loop');
  storeDir = join(dataDir, 'store');

  await timings.measure('boot: private instance (temp store + temp SQLite)', async () => {
    instance = await startInstance({
      dataDir,
      storeDir,
      substrateMode: 'docker',
      substrates: ['docker'],
      baseImage: BASE_IMAGE,
      computerRoot: COMPUTER_ROOT,
      // The tier transitions in this suite are fired deliberately (see
      // `advanceTier`), so a background timer cannot race an assertion.
      warmIdleMs: 3_600_000,
      coldIdleMs: 3_600_000,
    });
  });
  witness = new ConnectionWitness(instance.server.server);

  // The base image is snapshotted into the chunk store exactly once (spec §2);
  // every computer created afterwards is a delta against it.
  const baseManifest = await timings.measure('boot: base image snapshot', async () =>
    instance.baseManifest,
  );
  expect(baseManifest).toMatch(/^[0-9a-f]{64}$/);

  // A real Better Auth session (private instances run single-admin sign-in,
  // decisions.md Auth). The cookie IS the identity both devices present.
  const signup = new Device('signup', instance.url);
  const res = await signup.postJson<{ user?: { id: string } }>('/api/auth/sign-up/email', {
    email: 'loop@mari.test',
    password: 'loop-e2e-password',
    name: 'Loop',
  });
  if (res.status !== 200) throw new Error(`sign-up failed: ${res.status} ${JSON.stringify(res.body)}`);
  const setCookie = res.headers['set-cookie'];
  const raw = Array.isArray(setCookie) ? setCookie[0] : setCookie;
  cookie = (raw ?? '').split(';')[0] ?? '';
  expect(cookie).not.toBe('');
  userId = res.body.user?.id ?? '';
  expect(userId).not.toBe('');
  await signup.disconnect();
}, 1_800_000);

afterAll(async () => {
  if (!GATE) return;
  await instance?.close();
  await cleanupAllMariContainers();
  // Containers always go. The scratch store can be kept for a post-mortem with
  // MARI_LOOP_E2E_KEEP=1 (it is a chunk store: worth reading when something
  // about a restore looks wrong).
  if (dataDir && process.env.MARI_LOOP_E2E_KEEP !== '1') await removeDir(dataDir);
  else if (dataDir) console.log(`[loop-e2e] kept scratch store at ${dataDir}`);
  // Reference numbers for spec 13's open item. Printed, never asserted: a
  // latency budget is not a correctness claim, and pinning one here would turn
  // a slow laptop into a red build.
  console.log(
    timings.report('spec 13 — measured wake latency on this machine (local Docker substrate)') +
      `  ${WAKE_TO_SUPERVISOR}: n=${timings.all(WAKE_TO_SUPERVISOR).length} p50=${timings.p50(WAKE_TO_SUPERVISOR)} ms` +
      ` [${timings.all(WAKE_TO_SUPERVISOR).join(', ')}]\n` +
      `  ${WAKE_TO_FILES}: n=${timings.all(WAKE_TO_FILES).length} p50=${timings.p50(WAKE_TO_FILES)} ms` +
      ` [${timings.all(WAKE_TO_FILES).join(', ')}]\n`,
  );
});

describe.runIf(GATE)('spec 1.3 — start, disconnect, continue, see it from another device', () => {
  it('starts work from the web application: an HTTP run request materializes a real container', async () => {
    const device = new Device('device-A', instance.url, cookie);

    const created = await device.postJson<{ id: string; state: string }>('/api/computers', {
      name: 'loop',
    });
    expect(created.status).toBe(201);
    computerId = created.body.id;
    // A new computer is data, not a machine: nothing exists on the substrate.
    expect(created.body.state).toBe('cold');
    expect(await containersFor(computerId)).toEqual([]);

    // Device A is the web application: the event stream is open before any run
    // exists, exactly as the fleet view holds it (contracts.md Appendix C.4).
    await device.openEvents();

    // The run request. The computer is COLD, so this must NOT block on a wake
    // (spec 8.3): it returns immediately with the run queued, and the wake
    // happens behind the interface.
    const t0 = Date.now();
    const started = await device.postJson<{
      runId: string;
      state: string;
      computerState: string;
      queued: boolean;
    }>(`/api/computers/${computerId}/runs`, {
      argv: ['/bin/sh', '-c', RUN_SCRIPT],
      cwd: COMPUTER_ROOT,
    });
    timings.record('POST /runs on a COLD computer returns', Date.now() - t0);
    expect(started.status).toBe(200);
    runId = started.body.runId;
    expect(runId).not.toBe('');
    expect(started.body.state).toBe('pending');
    expect(started.body.queued).toBe(true);
    expect(started.body.computerState).toBe('waking');

    // The terminal pane attaches while the computer is still WAKING — no
    // spinner in front of the interface (spec 8.3, 7.1).
    await device.attach(computerId, runId);
    expect(device.attachOpen).toBe(true);

    // ...and a real container appears, running the real marid.
    await waitUntil(
      async () => (await containersFor(computerId)).length === 1,
      180_000,
      'a container to be materialized',
    );
    containerA = (await containersFor(computerId))[0] as string;
    timings.record('POST /runs -> container materialized', Date.now() - t0);
    await waitUntil(
      () => witness.firstSupervisorUpgradeAfter(t0) !== null,
      180_000,
      'the supervisor to dial back in',
    );
    // This first wake is a COLD wake too (of the base image), so it belongs to
    // the same latency series as the two below.
    timings.record(WAKE_TO_SUPERVISOR, (witness.firstSupervisorUpgradeAfter(t0) as number) - t0);
    expect(await containerStatus(containerA)).toBe('running');

    // materialize carried marid's whole configuration (spec 3.5); the daemon's
    // own record is the witness, not Mari's.
    const env = await containerEnv(containerA);
    expect(env['MARI_COMPUTER_ID']).toBe(computerId);
    expect(env['MARI_ROOT']).toBe(COMPUTER_ROOT);
    expect(env['MARI_STORE']).toBe('fs:///store');
    expect(env['MARI_RESTORE_MANIFEST']).toBe(instance.runtime.env.BASE_MANIFEST);
    expect(await containerMounts(containerA)).toContainEqual({ source: storeDir, target: '/store' });

    // The supervisor dialled back in and the run reached the PTY: device A sees
    // the first ticks LIVE, as terminal frames on its attach socket.
    await waitUntil(
      async () =>
        ticksIn(dec.decode(device.attachBytes(runId))).length >= 2,
      240_000,
      `device A to see live ticks (marid: ${await containerLogs(containerA, 30)})`,
    );
    timings.record('POST /runs -> first live terminal bytes at the client', Date.now() - t0);

    const seen = ticksIn(dec.decode(device.attachBytes(runId)));
    expect(seen[0]).toBe(0);
    lastTickSeenLive = Math.max(...seen);
    // Keep exactly what this device saw: the journal must later CONTINUE these
    // bytes, not merely contain something like them.
    bytesSeenLive = device.attachBytes(runId);
    // The run is genuinely mid-flight, not finished: this is the point the user
    // is about to walk away from.
    const detail = await device.get<RunDetailBody>(`/api/computers/${computerId}/runs/${runId}`);
    expect(detail.status).toBe(200);
    expect(detail.body.state).toBe('running');
    expect(lastTickSeenLive).toBeLessThan(TICKS - 1);

    // Cost accrues while AWAKE (spec 8.2) — sampled here, frozen later.
    costWhileAwake = (await fleetEntry(device, computerId)).cost;
    expect(costWhileAwake.awakeSeconds).toBeGreaterThan(0);

    // ---- DISCONNECT ------------------------------------------------------
    await timings.measure('device A disconnect (WS + SSE + pooled sockets)', () =>
      device.disconnect(),
    );

    // Proven from the SERVER's side: the instance holds no client connection at
    // all. The only socket left is the supervisor's, which is not a client — it
    // is the owner of the run (spec 5.1).
    await witness.waitForNoClients(15_000);
    expect(witness.liveClient()).toEqual([]);
    expect(witness.liveSupervisor().length).toBe(1);
    // The kernel agrees, independently of that bookkeeping: exactly one socket
    // is open on this server, and it is the supervisor's.
    await waitUntil(
      async () => (await witness.openSocketCount()) === 1,
      10_000,
      'the server to hold exactly one socket (the supervisor)',
    );
    // No SSE either: the connection that carried `GET /api/events` existed and
    // is one of the sockets just proven destroyed.
    const sseConns = witness.connections.filter((c) =>
      c.paths.some((p) => p.startsWith('/api/events')),
    );
    expect(sseConns.length).toBe(1);
    expect((sseConns[0] as { socket: { destroyed: boolean } }).socket.destroyed).toBe(true);
    // ...and so is the one that carried the terminal attach (contracts.md §7).
    const attachConns = witness.connections.filter((c) =>
      c.paths.some((p) => p.startsWith('/attach/')),
    );
    expect(attachConns.length).toBe(1);
    expect((attachConns[0] as { socket: { destroyed: boolean } }).socket.destroyed).toBe(true);
  }, 600_000);

  it('the agents continue: the run keeps writing the journal with nothing attached (spec 5.1)', async () => {
    expect(runId).not.toBe('');
    const t0 = Date.now();

    // Nothing is attached for the whole window. Everything sampled inside it is
    // read IN-PROCESS — through the Durable Object object itself and through the
    // Docker CLI — because issuing an HTTP request would be the very thing the
    // window is supposed to be free of.
    const computerDo = await instance.runtime.computers.instanceFor(computerId);
    const journalGrowth: number[] = [];
    const deadline = Date.now() + DISCONNECT_WINDOW_MS;
    while (Date.now() < deadline) {
      await delay(250);
      expect(witness.liveClient()).toEqual([]);
      journalGrowth.push((await computerDo.readJournal(runId)).length);
    }
    expect(await witness.openSocketCount()).toBe(1);
    timings.record('disconnected window (no client attached)', Date.now() - t0);

    // Sampled AT THE TIME, not reconstructed afterwards: the journal the control
    // plane holds grew, monotonically, while zero client sockets existed.
    expect(journalGrowth.length).toBeGreaterThan(4);
    for (let i = 1; i < journalGrowth.length; i++) {
      expect(journalGrowth[i] as number).toBeGreaterThanOrEqual(journalGrowth[i - 1] as number);
    }
    expect(journalGrowth[journalGrowth.length - 1] as number).toBeGreaterThan(
      journalGrowth[0] as number,
    );
    // ...and the computer was held AWAKE for its run the whole time (spec 5.4),
    // with no client asking it to be.
    expect(await containerStatus(containerA)).toBe('running');

    // ---- RECONNECT AS A DIFFERENT DEVICE ---------------------------------
    // A fresh connection pool, the same session. Nothing of device A's state is
    // carried over; the only continuity is the user's identity.
    const device = new Device('device-B', instance.url, cookie);
    // Same user, new connection: the session is the only thing that crossed
    // over, which is what "from each device" means.
    const session = await device.get<{ user?: { id: string } }>('/api/auth/get-session');
    expect(session.status).toBe(200);
    expect(session.body.user?.id).toBe(userId);
    await device.openEvents();

    const detail = await device.get<RunDetailBody>(`/api/computers/${computerId}/runs/${runId}`);
    expect(detail.status).toBe(200);
    // The run survived the disconnect: a closed laptop does not stop a run.
    expect(detail.body.state).toBe('running');

    journalAtReconnect = new Uint8Array(Buffer.from(detail.body.journalTail, 'base64'));
    const ticks = ticksIn(dec.decode(journalAtReconnect));

    // THE CLAIM. Bytes produced while nobody was watching are in the journal
    // the control plane holds (spec 4.2: that journal is the truth).
    const producedWhileAway = ticks.filter((t) => t > lastTickSeenLive);
    expect(producedWhileAway.length).toBeGreaterThan(0);
    // The window really did straddle the midpoint: the last thing anyone saw
    // was in the first half, and the run is past the middle now.
    expect(lastTickSeenLive).toBeLessThan(Math.floor(TICKS / 2));
    expect(Math.max(...ticks)).toBeGreaterThan(Math.floor(TICKS / 2));

    // Contiguous and in order: 0..max with no gaps, no repeats, ascending, and
    // byte-exact separators — the journal is the concatenation of the ticks,
    // not a set of them.
    const max = Math.max(...ticks);
    expect(ticks).toEqual(Array.from({ length: max + 1 }, (_, i) => i));
    let prefix = '';
    for (let i = 0; i <= max; i++) prefix += `${TICK_PREFIX}-${String(i).padStart(3, '0')}\r\n`;
    expect(dec.decode(journalAtReconnect).startsWith(prefix)).toBe(true);
    expect(detail.body.journalLength).toBeGreaterThanOrEqual(prefix.length);
    // The tail is the whole journal here (well under JOURNAL_TAIL_BYTES), so
    // offset 0 is where it starts — the reconnecting device is not being handed
    // a window that hides the gap.
    expect(detail.body.journalTailOffset).toBe(0);
    expect(detail.body.journalLength).toBe(journalAtReconnect.length);

    // The new device attaches and receives the prior journal, byte for byte,
    // then live frames (contracts.md Appendix B "attach snapshot (v0)").
    await device.attach(computerId, runId);
    await waitUntil(
      () => device.attachMessages.some((m) => m.t === 'grid'),
      15_000,
      'the attach grid on device B',
    );
    await waitUntil(
      () => ticksIn(dec.decode(device.attachBytes(runId))).includes(max),
      15_000,
      'device B to receive the journal it missed',
    );
    const replayed = dec.decode(device.attachBytes(runId));
    expect(replayed.startsWith(prefix)).toBe(true);

    // ---- completion, seen live on the new device -------------------------
    await waitUntil(
      () => device.attachMessages.some((m) => m.t === 'run_status' && m.alive === false),
      120_000,
      'the run to finish',
    );
    const status = device.attachMessages.find((m) => m.t === 'run_status' && m.alive === false);
    expect(status?.exitCode).toBe(0);

    // The completion event reached the event stream this device opened AFTER
    // the disconnect (spec 5.5 + 6.2 delivery leg).
    await waitUntil(
      () =>
        device.sseEvents.some(
          (e) => e.type === 'run' && e.data['runId'] === runId && e.data['state'] === 'exited',
        ),
      60_000,
      'the run completion event on device B',
    );
    const completion = device.sseEvents.find(
      (e) => e.type === 'run' && e.data['runId'] === runId && e.data['state'] === 'exited',
    );
    expect(completion?.data['exitCode']).toBe(0);
    expect(completion?.data['computer']).toBe(computerId);

    // ...and it is RETRIEVABLE, not merely pushed: a device that was asleep for
    // the whole run gets the same answer from the API.
    await waitUntil(
      async () => {
        const res = await device.get<RunDetailBody>(`/api/computers/${computerId}/runs/${runId}`);
        return res.body.state === 'exited';
      },
      60_000,
      'the run detail to report exited',
    );
    const finished = await device.get<RunDetailBody>(
      `/api/computers/${computerId}/runs/${runId}`,
    );
    expect(finished.body.exitCode).toBe(0);
    expect(finished.body.signal).toBeNull();
    expect(finished.body.preRunManifest).toMatch(/^[0-9a-f]{64}$/);
    expect(finished.body.postRunManifest).toMatch(/^[0-9a-f]{64}$/);
    expect(finished.body.postRunManifest).not.toBe(finished.body.preRunManifest);

    // The whole journal, byte for byte: every tick and the done marker, each
    // with the PTY's CRLF, and nothing fabricated around them.
    let full = new Uint8Array();
    await waitUntil(
      async () => {
        const res = await device.get<RunDetailBody>(`/api/computers/${computerId}/runs/${runId}`);
        full = new Uint8Array(Buffer.from(res.body.journalTail, 'base64'));
        return full.length >= expectedJournal().length;
      },
      60_000,
      'the final journal bytes',
    );
    const want = expectedJournal();
    expect(full.length).toBe(want.length);
    expect(firstDifference(full, want)).toBe(-1);
    // The journal CONTINUED across the whole story: it starts with exactly the
    // bytes device A watched go by before it disconnected, continues with
    // exactly the snapshot device B first read, and ends with the rest. One
    // stream, one order, no restart and no seam.
    expect(bytesSeenLive.length).toBeGreaterThan(0);
    expect(bytesEqual(full.subarray(0, bytesSeenLive.length), bytesSeenLive)).toBe(true);
    expect(bytesEqual(full.subarray(0, journalAtReconnect.length), journalAtReconnect)).toBe(true);

    // ---- the run's result is a difference (spec 5.3) ---------------------
    const diff = await device.get<DiffBody>(`/api/computers/${computerId}/runs/${runId}/diff`);
    expect(diff.status).toBe(200);
    expect(diff.body.base).toBe(finished.body.preRunManifest);
    expect(diff.body.head).toBe(finished.body.postRunManifest);
    expect(diff.body.truncated).toBe(false);
    // EXACTLY the files the run wrote (plus the directory it created), and
    // nothing else — the supervisor's own `.mari` state is excluded from
    // manifests, so a journal on disk must not show up as a change.
    expect(diff.body.entries.map((e) => `${e.change} ${e.kind} ${e.path}`).sort()).toEqual(
      [
        `added dir /loop`,
        `added file ${DONE_PATH}`,
        `added file ${LOG_PATH}`,
        `added file ${PAYLOAD_PATH}`,
      ].sort(),
    );
    expect(diff.body.summary).toEqual({ added: 4, modified: 0, removed: 0 });
    const logEntry = diff.body.entries.find((e) => e.path === LOG_PATH);
    expect(logEntry?.newSize).toBe(expectedLogFile().length);
    const payloadEntry = diff.body.entries.find((e) => e.path === PAYLOAD_PATH);
    expect(payloadEntry?.newSize).toBe(PAYLOAD.length);

    // The fleet view a returning user lands on shows the result (spec 8.2).
    const row = await fleetEntry(device, computerId);
    expect(row.activeRuns).toBe(0);
    expect(row.state).toBe('awake');
    expect(row.manifestHead).toBe(finished.body.postRunManifest);
    // The head moved and the previous head is remembered, so the card can say
    // how much changed while the user was away (0 would mean it forgot).
    expect(row.changedFiles).toBeGreaterThan(0);

    await device.disconnect();
    await witness.waitForNoClients(15_000);
  }, 600_000);

  it('goes COLD through the tier policy and wakes into a FRESH container with byte-identical files', async () => {
    const device = new Device('device-C', instance.url, cookie);

    // The tier alarm the wake armed is genuinely pending (spec 4.4); the loop
    // below hurries its clock, it does not invent the policy.
    const armed = await instance.runtime.computers.stateFor(computerId).storage.getAlarm();
    expect(armed).not.toBeNull();

    // ---- AWAKE -> WARM is a real pause -----------------------------------
    await timings.measure('tier: AWAKE -> WARM (docker pause)', () => advanceTier(computerId, 'warm'));
    expect(await containerStatus(containerA)).toBe('paused');
    costWhileWarm = (await fleetEntry(device, computerId)).cost;
    expect(costWhileWarm.ratePerHour).toBe(0);

    // ---- WARM -> COLD is a real destroy, after a final manifest -----------
    await timings.measure('tier: WARM -> COLD (final snapshot + destroy)', () =>
      advanceTier(computerId, 'cold'),
    );
    await waitUntil(async () => (await containerStatus(containerA)) === null, 120_000, 'container A to be destroyed');
    expect(await containersFor(computerId)).toEqual([]);

    const computerDo = await instance.runtime.computers.instanceFor(computerId);
    coldHead = (await computerDo.getHead()) as string;
    expect(coldHead).toMatch(/^[0-9a-f]{64}$/);
    expect((await stat(join(storeDir, 'manifests', `${coldHead}.cbor`))).size).toBeGreaterThan(0);

    // A COLD computer is fully browsable from its manifest alone (spec 8.4):
    // no substrate exists at this instant, and nothing is woken to answer.
    const listing = await device.get<{ entries: { path: string; kind: string; size: number }[] }>(
      `/api/computers/${computerId}/files?path=/loop`,
    );
    expect(listing.status).toBe(200);
    expect(listing.body.entries.map((e) => e.path).sort()).toEqual(
      [DONE_PATH, LOG_PATH, PAYLOAD_PATH].sort(),
    );
    expect(listing.body.entries.find((e) => e.path === PAYLOAD_PATH)?.size).toBe(PAYLOAD.length);
    expect(await containersFor(computerId)).toEqual([]);

    // ---- COLD -> AWAKE, twice, into a FRESH container each time ----------
    // Twice because the wake latency is spec 13's open item and one sample is
    // an anecdote; each cycle also re-proves the restore is repeatable.
    let previousContainer = containerA;
    // Each COLD transition writes a fresh final manifest, so the restore input
    // of cycle 2 is the head cycle 1 left behind — not the first one.
    let headBefore = coldHead;
    for (let cycle = 1; cycle <= 2; cycle++) {
      const t0 = Date.now();
      const container = await wakeAndMeasure(device, computerId);
      expect(container).not.toBe(previousContainer);
      expect(await containerStatus(container)).toBe('running');
      expect((await containerEnv(container))['MARI_RESTORE_MANIFEST']).toBe(headBefore);

      // The storage inversion, asserted against DOCKER: the bytes the run wrote
      // are inside a container that did not exist when they were written.
      const wantLog = expectedLogFile();
      let log: Uint8Array = new Uint8Array();
      await waitUntil(
        async () => {
          try {
            log = await readFileInContainer(container, `${COMPUTER_ROOT}${LOG_PATH}`);
          } catch {
            return false;
          }
          return log.length === wantLog.length;
        },
        180_000,
        `restore of ${LOG_PATH} into ${container.slice(0, 12)} (marid: ${await containerLogs(container, 30)})`,
      );
      timings.record(WAKE_TO_FILES, Date.now() - t0);
      expect(firstDifference(log, wantLog)).toBe(-1);
      expect(
        bytesEqual(
          await readFileInContainer(container, `${COMPUTER_ROOT}${PAYLOAD_PATH}`),
          enc.encode(PAYLOAD),
        ),
      ).toBe(true);
      expect(
        bytesEqual(
          await readFileInContainer(container, `${COMPUTER_ROOT}${DONE_PATH}`),
          enc.encode('done\n'),
        ),
      ).toBe(true);
      // Nothing extra was restored into the computer's root either (the
      // supervisor's own `.mari` tree is its state, not the computer's files).
      const onDisk = (await listFilesInContainer(container, COMPUTER_ROOT)).filter(
        (p) => !p.startsWith(`${COMPUTER_ROOT}/.mari`),
      );
      expect(onDisk).toEqual([
        `${COMPUTER_ROOT}/loop`,
        `${COMPUTER_ROOT}${DONE_PATH}`,
        `${COMPUTER_ROOT}${LOG_PATH}`,
        `${COMPUTER_ROOT}${PAYLOAD_PATH}`,
      ].sort());

      // The run history came back with it.
      const history = await device.get<{ runs: { id: string; state: string; exitCode: number | null }[] }>(
        `/api/computers/${computerId}/runs`,
      );
      const record = history.body.runs.find((r) => r.id === runId);
      expect(record?.state).toBe('exited');
      expect(record?.exitCode).toBe(0);

      previousContainer = container;
      if (cycle < 2) {
        await advanceTier(computerId, 'warm');
        await advanceTier(computerId, 'cold');
        await waitUntil(
          async () => (await containersFor(computerId)).length === 0,
          120_000,
          'the container to be destroyed',
        );
        headBefore = (await computerDo.getHead()) as string;
        expect(headBefore).toMatch(/^[0-9a-f]{64}$/);
        expect((await stat(join(storeDir, 'manifests', `${headBefore}.cbor`))).size).toBeGreaterThan(0);
      }
    }

    await device.disconnect();
  }, 900_000);

  it('meters AWAKE seconds and stops accruing when the computer is COLD (spec 8.2)', async () => {
    const device = new Device('device-D', instance.url, cookie);
    const rate = SUBSTRATE_PRICE_PER_HOUR['docker'] as number;

    // While AWAKE the meter runs.
    const first = (await fleetEntry(device, computerId)).cost;
    expect(first.awakeSeconds).toBeGreaterThan(0);
    expect(first.currency).toBe('USD');
    expect(first.ratePerHour).toBe(rate);
    // The accrual is the price sheet applied to those seconds, not a number of
    // its own (local Docker is priced at zero, so this is what "non-zero AWAKE
    // seconds" can be checked against without inventing a charge).
    expect(first.accrued).toBeCloseTo((first.awakeSeconds / 3600) * rate, 9);
    await delay(1_200);
    const second = (await fleetEntry(device, computerId)).cost;
    expect(second.awakeSeconds).toBeGreaterThan(first.awakeSeconds);

    // The earlier samples ordered as the states did: AWAKE during the run,
    // frozen from the moment the computer stopped being AWAKE.
    expect(costWhileAwake).not.toBeNull();
    expect(costWhileWarm).not.toBeNull();
    expect((costWhileWarm as CostMeterBody).awakeSeconds).toBeGreaterThan(
      (costWhileAwake as CostMeterBody).awakeSeconds,
    );

    // ---- COLD: the meter stops -------------------------------------------
    await advanceTier(computerId, 'warm');
    await advanceTier(computerId, 'cold');
    expect(await containersFor(computerId)).toEqual([]);

    const cold = (await fleetEntry(device, computerId)).cost;
    expect(cold.ratePerHour).toBe(0);
    expect(cold.awakeSeconds).toBeGreaterThanOrEqual(second.awakeSeconds);
    await delay(1_500);
    const coldAgain = (await fleetEntry(device, computerId)).cost;
    // Not "grew slowly" — identical. A COLD computer costs object storage only
    // (spec §2), and compute time is the only input to this meter.
    expect(coldAgain.awakeSeconds).toBe(cold.awakeSeconds);
    expect(coldAgain.accrued).toBe(cold.accrued);
    expect(coldAgain.ratePerHour).toBe(0);

    await device.disconnect();
  }, 600_000);

  it('leaves no substrate resources behind', async () => {
    for (const name of instance.runtime.computers.liveNames()) {
      const stub = instance.runtime.computers.get(instance.runtime.computers.idFromName(name));
      if ((await stub.getState()) === 'awake') await advanceTier(name, 'warm');
      if ((await stub.getState()) === 'warm') await advanceTier(name, 'cold');
      expect(await containersFor(name)).toEqual([]);
    }
    // ...and the chunk store still holds the computer: COLD is data, not loss.
    const manifest = join(storeDir, 'manifests', `${coldHead}.cbor`);
    expect((await readFile(manifest)).byteLength).toBeGreaterThan(0);
  }, 600_000);
});
