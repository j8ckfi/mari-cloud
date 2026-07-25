// THE THESIS TEST, against REAL Cloudflare Containers.
//
//   decisions.md, "Testing philosophy": create computer → wake → run writes
//   files → snapshot → destroy (COLD) → wake into a FRESH container → the files
//   are there, byte-identical, and the journal is continuous.
//
// docs/substrates-cloudflare.md item 6 calls this "the strongest version of that
// test anywhere", and the reason is the platform's own rule: "All disk is
// ephemeral. When a Container instance goes to sleep, the next time it is
// started, it will have a fresh disk as defined by its container image." On
// Docker a passing test can be a lie told by a surviving volume. Here the
// substrate destroys the evidence for you — and this suite proves the container
// really was new (a boot id that changed, and a marker written OUTSIDE the
// computer's root that is gone) rather than assuming it.
//
// GATE: `MARI_CF_E2E=1`. Ungated the file collects no tests and exits 0.
//
//   MARI_CF_E2E=1 CLOUDFLARE_ACCOUNT_ID=… pnpm --filter @mari/e2e test
//
//   MARI_CF_E2E_REUSE=1   reuse an already-deployed scratch app (development)
//   MARI_CF_E2E_KEEP=1    skip teardown (development)
//
// WHAT IS REAL HERE: the control plane is the REAL Worker + ComputerDO
// (deploy/cf-thesis/src/worker.ts imports them by path), deployed to a scratch
// `mari-thesis-e2e` app — never app.mari.sh, no custom domain, no DNS record.
// The substrate is the REAL `substrates/cloudflare.ts` driver on a REAL
// `ctx.container` (Firecracker microVM, standard-1, WEUR). The computer runs the
// REAL `marid` binary from the REAL `deploy/Dockerfile.mari` base image. The
// chunk store is a REAL R2 bucket. The client is a REAL HTTP + WebSocket peer
// with a REAL passkey session — auth.ts treats a workers.dev origin as
// production, so there is no dev sign-in here.
//
// TWO DELIBERATE DEVIATIONS, both reported rather than hidden, both forced by
// gaps this suite exists to find (see the header of deploy/cf-thesis/src/worker.ts):
//
//   1. `marid` is built with `--features s3` (one word added to the production
//      Dockerfile's build line). Without it `MARI_STORE=s3://…` fails at startup:
//      the production image cannot reach a chunk store on this substrate at all.
//   2. The store is reached through an S3 facade on the Worker, because
//      `ComputerDO.#maridEnv` (computer-do.ts:765) has no seam for R2 credentials and R2's real
//      S3 endpoint accepts nothing else. Chunks therefore transit a Worker
//      (the memo's path (b)) instead of decisions.md's direct-to-R2 (path (a)).
//      Byte-for-byte the round trip is the same: opendal → S3 verbs → R2.
//
// Also: the supervisor channel is plain `ws://` because `marid` has no TLS
// backend compiled in (tokio-tungstenite with no TLS feature; reqwest resolves
// with no TLS backend at all — Cargo.lock), so `wss://` cannot connect today.
// That is gate 2's finding, unfixed, and it is why the deploy uses the
// workers.dev origin's port 80.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeCbor, encodeCbor } from '@mari/shared';
import {
  Attach,
  BUCKET,
  Client,
  CONTAINER_APP,
  D1_NAME,
  Samples,
  WARM_IDLE_MS,
  WORKER_NAME,
  applyMigrations,
  assembleContext,
  bytesEqual,
  containerApp,
  delay,
  deploy,
  ensureBucket,
  ensureD1,
  instanceState,
  SUBDOMAIN,
  randomToken,
  sha256Hex,
  signUpWithPasskey,
  waitFor,
  wrangler,
  wranglerQuiet,
  writeConfig,
  type Provisioned,
} from './src/cf.js';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GATE = process.env.MARI_CF_E2E === '1';
const REUSE = process.env.MARI_CF_E2E_REUSE === '1';
const KEEP = process.env.MARI_CF_E2E_KEEP === '1';
// fileURLToPath, not `.pathname`: the repository path contains a space.
const STATE_FILE = resolve(
  fileURLToPath(new URL('../deploy/cf-thesis/.state.json', import.meta.url).href),
);

// ---------------------------------------------------------------------------
// The computer's contents: known bytes, chosen to cover the storage contract.
// ---------------------------------------------------------------------------

const ROOT = '/work';
const DIR = `${ROOT}/thesis`;
/** 1023 printable chars + '\n' = 1 KiB, repeated 3072 times = exactly 3 MiB, so
 *  `big.bin` spans many chunks at the production chunker's 64 KiB..1 MiB. */
const LINE = 'abcdefghijklmnopqrstuvwxyz0123456789'
  .repeat(29)
  .slice(0, 1023);
const BIG_LINES = 3072;
const BIG = `${LINE}\n`.repeat(BIG_LINES);
const ALPHA = 'alpha\n';
const DEEP = 'deep in a nested directory\n';
const SPACED = 'a file with a space in its name\n';
const EXEC = '#!/bin/sh\necho executable\n';

/** path (under DIR) → exact expected bytes. `link` and `empty.txt` are the
 *  awkward cases the storage contract is required to carry. */
const FILES: { path: string; content: string; mode?: string }[] = [
  { path: 'alpha.txt', content: ALPHA },
  { path: 'nested/deep.txt', content: DEEP },
  { path: 'empty.txt', content: '' },
  { path: 'exec.sh', content: EXEC, mode: '755' },
  { path: 'spaced name.txt', content: SPACED },
  { path: 'big.bin', content: BIG },
];

/** A marker OUTSIDE the computer's root. The chunk store never sees it, so on a
 *  substrate with an ephemeral disk it cannot come back — which is how this
 *  suite proves the second container is genuinely a new one. */
const OUTSIDE_MARKER = '/mari-thesis-outside-root';

const MARK = 'MARI-THESIS';
const TICKS = 6;
const DONE = 'MARI-THESIS-DONE';

/** The work run: writes every file, then emits a known marker block on the PTY. */
const WORK_SCRIPT = [
  'set -e',
  `mkdir -p '${DIR}/nested'`,
  `printf '%s' '${ALPHA}' > '${DIR}/alpha.txt'`,
  `printf '%s' '${DEEP}' > '${DIR}/nested/deep.txt'`,
  `: > '${DIR}/empty.txt'`,
  `printf '%s' '${EXEC.replace(/'/g, `'\\''`)}' > '${DIR}/exec.sh'`,
  `chmod 755 '${DIR}/exec.sh'`,
  `printf '%s' '${SPACED}' > '${DIR}/spaced name.txt'`,
  `yes '${LINE}' | head -n ${BIG_LINES} > '${DIR}/big.bin'`,
  `ln -sf alpha.txt '${DIR}/link'`,
  `printf 'outside\\n' > '${OUTSIDE_MARKER}'`,
  `i=0; while [ "$i" -lt ${TICKS} ]; do printf '${MARK}-%03d\\n' "$i"; i=$((i+1)); done`,
  `printf '${DONE}\\n'`,
].join('\n');

/** Exactly what the PTY must deliver for the marker block (CRLF: it is a tty). */
function expectedMarkers(): string {
  let s = '';
  for (let i = 0; i < TICKS; i++) s += `${MARK}-${String(i).padStart(3, '0')}\r\n`;
  return `${s}${DONE}\r\n`;
}

/** The verification run: content hashes, modes, the symlink, the boot id, and
 *  whether anything outside the computer's root survived. */
const VERIFY_SCRIPT = [
  `cd '${DIR}'`,
  `printf 'BOOT=%s\\n' "$(cat /proc/sys/kernel/random/boot_id)"`,
  `printf 'UPTIME=%s\\n' "$(cut -d' ' -f1 /proc/uptime)"`,
  `for f in alpha.txt nested/deep.txt empty.txt exec.sh 'spaced name.txt' big.bin; do`,
  `  printf 'SHA %s %s\\n' "$(sha256sum "$f" | cut -d' ' -f1)" "$f"`,
  `  printf 'MODE %s %s\\n' "$(stat -c '%a' "$f")" "$f"`,
  `done`,
  `printf 'LINK %s\\n' "$(readlink link)"`,
  `printf 'DIRMODE %s\\n' "$(stat -c '%a' nested)"`,
  `if [ -e '${OUTSIDE_MARKER}' ]; then printf 'OUTSIDE present\\n'; else printf 'OUTSIDE absent\\n'; fi`,
  `printf 'VERIFY-DONE\\n'`,
].join('\n');

/**
 * The recovery check for the EVICTION computer, whose filesystem only ever held
 * the in-flight run's own output. It answers the two questions an eviction
 * raises: which machine am I on now, and how much of the interrupted run's work
 * came back out of the chunk store?
 */
const EVICT_VERIFY_SCRIPT = [
  `printf 'BOOT=%s\\n' "$(cat /proc/sys/kernel/random/boot_id)"`,
  `if [ -e '${DIR}/evict/log.txt' ]; then`,
  `  printf 'EVICTLOG lines=%s\\n' "$(wc -l < '${DIR}/evict/log.txt')"`,
  `else`,
  `  printf 'EVICTLOG absent\\n'`,
  `fi`,
  `if [ -e '${OUTSIDE_MARKER}' ]; then printf 'OUTSIDE present\\n'; else printf 'OUTSIDE absent\\n'; fi`,
  `printf 'VERIFY-DONE\\n'`,
].join('\n');

/** The probe run: proves what kind of machine this is (spec §10.4 / gate 1). */
const PROBE_SCRIPT = [
  `printf 'BOOT=%s\\n' "$(cat /proc/sys/kernel/random/boot_id)"`,
  `printf 'KERNEL=%s\\n' "$(uname -r)"`,
  `printf 'UID=%s\\n' "$(id -u)"`,
  `printf 'HOST=%s\\n' "$(hostname)"`,
  `printf 'PID1=%s\\n' "$(cat /proc/1/comm)"`,
  `printf 'PROBE-DONE\\n'`,
].join('\n');

// ---------------------------------------------------------------------------
// REST shapes (contracts.md Appendix C)
// ---------------------------------------------------------------------------

interface RunBody {
  id: string;
  state: string;
  exitCode: number | null;
  signal: number | null;
  dispatched?: boolean;
  preRunManifest: string | null;
  postRunManifest: string | null;
  diff: { added: number; modified: number; removed: number } | null;
  journalLength: number;
  journalTailOffset: number;
  journalTail: string;
  journalTailEncoding: string;
}

interface ComputerBody {
  id: string;
  state: string;
  head: string | null;
  runs?: { id: string; state: string }[];
}

interface AttentionBody {
  attention: { id: number; run: string; kind: string; at: number; dismissed: boolean }[];
}

interface FilesBody {
  computer: string;
  manifest: string | null;
  path: string;
  entries: {
    name: string;
    path: string;
    kind: string;
    size: number;
    mode: number;
    symlinkTarget: string | null;
  }[];
}

// ---------------------------------------------------------------------------
// Suite state
// ---------------------------------------------------------------------------

let p: Provisioned;
let client: Client;
let computerId = '';
let bootA = '';
let workRunId = '';
let workJournal = new Uint8Array();
let workJournalLength = -1;
let headAfterSnapshot = '';
let coldHead = '';
let evictRunId = '';
/** The eviction test runs on its OWN computer: a computer whose container was
 *  killed out from under the control plane is not a fixture the other phases
 *  should have to share. */
let evictComputerId = '';

const wakeToSupervisor = new Samples('cold wake -> supervisor connected (run dispatched)');
const wakeToVerified = new Samples('cold wake -> files byte-identical in a fresh container');
const awakeToCold = new Samples('idle AWAKE -> COLD (container destroyed)');
const notes: string[] = [];

function record(line: string): void {
  notes.push(line);
  console.log(`[thesis] ${line}`);
}

// ---------------------------------------------------------------------------
// REST helpers
// ---------------------------------------------------------------------------

async function computer(id = computerId): Promise<ComputerBody> {
  const res = await client.get<ComputerBody>(`/api/computers/${id}`);
  if (res.status !== 200) throw new Error(`GET computer -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function run(runId: string, id = computerId): Promise<RunBody> {
  const res = await client.get<RunBody>(`/api/computers/${id}/runs/${runId}`);
  if (res.status !== 200) throw new Error(`GET run -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}

async function startRun(script: string, id = computerId): Promise<string> {
  const res = await client.post<{ runId: string; computerState: string }>(
    `/api/computers/${id}/runs`,
    { argv: ['/bin/sh', '-c', script], cwd: ROOT },
  );
  if (res.status !== 200) throw new Error(`POST runs -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.runId;
}

const RUN_TIMEOUT_MS = 600_000;

/** Wait until a run has been handed to a supervisor. Contracts C.1's dispatch
 *  latch is written BEFORE the `start_run` frame, so this is exactly "a
 *  supervisor is connected and took the work". */
async function waitDispatched(
  runId: string,
  timeoutMs = RUN_TIMEOUT_MS,
  id = computerId,
): Promise<number> {
  await waitFor(
    `run ${runId} dispatched`,
    async () => {
      const r = await run(runId, id);
      return r.dispatched === true || r.state === 'running' || r.state === 'exited' ? r : null;
    },
    timeoutMs,
    250,
  );
  return Date.now();
}

async function waitExited(
  runId: string,
  timeoutMs = RUN_TIMEOUT_MS,
  id = computerId,
): Promise<RunBody> {
  return waitFor(
    `run ${runId} to exit`,
    async () => {
      const r = await run(runId, id);
      return r.state === 'exited' || r.state === 'failed' ? r : null;
    },
    timeoutMs,
    300,
  );
}

async function waitState(target: string, timeoutMs = 600_000, id = computerId): Promise<number> {
  await waitFor(
    `computer ${id} to reach ${target}`,
    async () => ((await computer(id)).state === target ? true : null),
    timeoutMs,
    2_000,
  );
  return Date.now();
}

/**
 * Take a computer to COLD, with NOTHING TO HELP IT.
 *
 * THE DEFECT THIS USED TO WORK AROUND (fixed in the control-plane lane):
 * `ComputerDO.#beginCold()` sent `prepare_for_cold` to the supervisor, set
 * `coldPending`, and armed NO fallback alarm. If that supervisor never answered —
 * its container was stopped by the platform, or the socket outlived it — the
 * computer stayed AWAKE **forever**: no alarm was scheduled, `#wakeInBackground()`
 * early-returned because the DO still believed it held a live handle, and a run
 * enqueued afterwards sat queued and never dispatched (spec 5.1's "a run is never
 * lost" degraded into "a run is never run"). Observed on a real deployment: the
 * platform reported the instance `inactive` while D1's fleet mirror still said
 * `awake`, 15 minutes later. This suite used to nudge that transition with
 * `POST /wake` and count the nudges — and a test helper working around a product
 * defect IS the defect.
 *
 * The handshake now has its own deadline (`COLD_FINALIZE_MS`): if the final
 * snapshot does not arrive, the DO finalizes from the last known head, destroys
 * the instance, and records a `final_snapshot_missed` incident. So this helper
 * only waits — no nudge, no rescue call — and a stall is a FAILURE, not a note.
 */
async function reachCold(id = computerId, budgetMs = 180_000): Promise<number> {
  return waitState('cold', budgetMs, id);
}

/** The run's whole journal as the control plane holds it. The tail route caps at
 *  8 KiB (`JOURNAL_TAIL_BYTES`), so anything longer is read through an attach
 *  socket, which replays the exact prior tail at offset 0 (contracts Appendix B). */
function tailBytes(r: RunBody): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(Buffer.from(r.journalTail, 'base64'));
}

/** Parse `KEY value` lines out of PTY output. */
function lines(text: string): string[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

function e2eFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${p.origin}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'x-e2e-token': p.e2eToken },
  });
}

async function storeKeys(prefix = ''): Promise<{ key: string; size: number }[]> {
  const res = await e2eFetch(`/__e2e/store/list?prefix=${encodeURIComponent(prefix)}`);
  const body = (await res.json()) as { keys: { key: string; size: number }[] };
  return body.keys;
}

// ---------------------------------------------------------------------------

describe.runIf(GATE)('the thesis, on real Cloudflare Containers', () => {
  beforeAll(async () => {
    const storeKeyId = randomToken(12);
    const storeSecret = randomToken(24);
    const e2eToken = randomToken(24);
    const authSecret = randomToken(32);

    if (REUSE && existsSync(STATE_FILE)) {
      const s = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Provisioned & { host: string };
      p = { ...s, reused: true };
      record(`reusing the deployed scratch app at ${p.origin}`);
    } else {
      const d1Id = ensureD1();
      ensureBucket();
      const host = `${WORKER_NAME}.${SUBDOMAIN}.workers.dev`;
      const origin = `https://${host}`;
      // The image carries the store's endpoint and credentials, so it has to be
      // built for a known origin. workers.dev names are deterministic; the deploy
      // below verifies the URL it actually got.
      const { dockerfile, base } = assembleContext({
        endpoint: `http://${host}/__store`,
        keyId: storeKeyId,
        secret: storeSecret,
      });
      // The delta against the PRODUCTION base image is exactly two things.
      const added = dockerfile.split('\n').filter((l) => !base.includes(l) && l.trim().length > 0);
      expect(dockerfile).toContain('cargo build -p marid --locked --release --features s3');
      expect(added.some((l) => l.startsWith('ENV AWS_ENDPOINT_URL='))).toBe(true);

      writeConfig({
        origin,
        host,
        wsOrigin: `ws://${host}`,
        d1Id,
        authSecret,
        storeKeyId,
        e2eToken,
      });
      applyMigrations();
      const deployed = deploy();
      expect(deployed.origin).toBe(origin);
      p = {
        origin,
        host,
        wsOrigin: `ws://${host}`,
        e2eToken,
        storeKeyId,
        storeSecret,
        d1Id,
        reused: false,
      };
      writeFileSync(STATE_FILE, JSON.stringify(p, null, 2));
      record(`deployed the scratch control plane at ${origin} (container app ${CONTAINER_APP})`);
    }

    // A real account, created by a real WebAuthn ceremony (there is no dev
    // sign-in on a public origin).
    client = new Client(p.origin);
    const email = `thesis-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, '')}@mari.test`;
    const { userId } = await signUpWithPasskey(client, email);
    expect(userId).not.toBe('');

    const created = await client.post<{ id: string; state: string }>('/api/computers', {
      name: 'thesis',
    });
    expect(created.status).toBe(201);
    computerId = created.body.id;
    expect((await computer()).state).toBe('cold');
    record(`computer ${computerId} created COLD for ${email}`);
  }, 3_600_000);

  afterAll(async () => {
    for (const s of [wakeToSupervisor, wakeToVerified, awakeToCold]) {
      if (s.n > 0) record(s.line());
    }
    if (KEEP || !GATE) return;
    // Teardown, narrowly: only resources named mari-thesis-e2e*.
    //
    // The bucket must be EMPTY before it can be deleted, and emptying it is a
    // client-side loop: one Worker request cannot delete thousands of objects
    // (each R2 delete spends from the request's subrequest budget), so the
    // route deletes one batch per call.
    let wiped = 0;
    for (let i = 0; i < 500; i++) {
      try {
        const res = await e2eFetch('/__e2e/store/wipe?n=150', { method: 'POST' });
        const body = (await res.json()) as { deleted: number; done: boolean };
        wiped += body.deleted;
        if (body.done) break;
      } catch {
        break; // the bucket delete below reports whatever is left
      }
    }
    record(`cleanup: wiped ${wiped} objects from ${BUCKET}`);
    const attempts: [string, () => string][] = [
      // `-c` on the WORKER delete is deliberate: run from the control-plane
      // package, a config-less wrangler would load app.mari.sh's own
      // wrangler.jsonc. `--name` already targets the scratch worker, and the
      // scratch config names it too, so both agree on what is being deleted.
      ['worker', () => wrangler(['delete', '--name', WORKER_NAME], 300_000, true)],
      [
        'container app',
        () => {
          const app = containerApp();
          return app ? wrangler(['containers', 'delete', app.id], 300_000, false) : 'already gone';
        },
      ],
      [
        // The pushed image outlives its application, and account image storage
        // is capped at 50 GB — a scratch image left behind is a real cost.
        'container images',
        () => {
          const list = wranglerQuiet(['containers', 'images', 'list'], 120_000);
          const tags = list
            .split('\n')
            .filter((l) => l.includes(CONTAINER_APP))
            .map((l) => l.trim().split(/\s+/))
            .filter((cells) => cells.length >= 2)
            .map((cells) => `${cells[0]}:${cells[1]}`);
          return tags
            .map((t) => wranglerQuiet(['containers', 'images', 'delete', t], 300_000))
            .join('\n');
        },
      ],
      ['d1', () => wrangler(['d1', 'delete', D1_NAME, '-y'], 300_000, false)],
      [
        'bucket',
        () => {
          // R2 refuses a non-empty bucket, and a delete can race the wipe's
          // last batch; retry a few times before reporting it as a leftover.
          let last = '';
          for (let i = 0; i < 5; i++) {
            try {
              return wrangler(['r2', 'bucket', 'delete', BUCKET], 300_000, false);
            } catch (err) {
              last = String((err as Error).message);
            }
          }
          throw new Error(last);
        },
      ],
    ];
    for (const [what, fn] of attempts) {
      try {
        fn();
        record(`cleanup: deleted ${what}`);
      } catch (err) {
        record(`cleanup: ${what} FAILED: ${(err as Error).message.split('\n')[0]}`);
      }
    }
    // Prove the account is clean, by NAME and nothing else — the account runs
    // unrelated container applications and the real Mari resources, and this
    // suite may never list-and-delete by pattern.
    const leftovers: string[] = [];
    const audit: [string, string[]][] = [
      ['worker', ['deployments', 'list', '--name', WORKER_NAME]],
      ['container app', ['containers', 'list']],
      ['d1', ['d1', 'list']],
      ['bucket', ['r2', 'bucket', 'list']],
      ['container images', ['containers', 'images', 'list']],
    ];
    for (const [what, args] of audit) {
      let out = '';
      try {
        out = wrangler(args, 120_000, false);
      } catch (err) {
        out = String((err as Error).message);
      }
      const needle =
        what === 'worker'
          ? WORKER_NAME
          : what === 'd1'
            ? D1_NAME
            : what === 'bucket'
              ? BUCKET
              : CONTAINER_APP;
      // A worker that no longer exists makes `deployments list` FAIL, which is
      // the success case here.
      const present = what === 'worker' ? /Created:|Version ID/.test(out) : out.includes(needle);
      if (present) leftovers.push(what);
    }
    record(leftovers.length === 0 ? 'cleanup: nothing named mari-thesis-e2e* is left on the account' : `cleanup: LEFTOVERS ${leftovers.join(', ')}`);
    expect(leftovers, 'scratch resources left on the account').toEqual([]);
  }, 1_800_000);

  // -------------------------------------------------------------------------

  it('wakes a COLD computer into a real Cloudflare container and the supervisor connects', async () => {
    const t0 = Date.now();
    const probe = await startRun(PROBE_SCRIPT);
    // A run on a COLD computer returns immediately and wakes behind the request
    // (spec 8.3): the DO materializes a container, `marid` boots, dials back, and
    // the queued run is handed over on its `hello`.
    const dispatchedAt = await waitDispatched(probe);
    wakeToSupervisor.add(dispatchedAt - t0);
    const r = await waitExited(probe);
    expect(r.exitCode).toBe(0);

    const out = Buffer.from(tailBytes(r)).toString('utf8');
    const kv = new Map(
      lines(out)
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)] as [string, string]),
    );
    expect(out).toContain('PROBE-DONE');
    bootA = kv.get('BOOT') ?? '';
    expect(bootA).toMatch(/^[0-9a-f-]{36}$/);
    // This is a Cloudflare Firecracker microVM, not a local Docker daemon
    // (spec §10.4: isolation is the substrate's job).
    expect(kv.get('KERNEL') ?? '').toContain('cloudflare');
    expect(kv.get('HOST') ?? '').toBe('cloudchamber');
    // PID 1 is the supervisor itself: the image's ENTRYPOINT, which is what makes
    // a platform SIGTERM land on `marid` (see the eviction test).
    expect(kv.get('PID1') ?? '').toBe('marid');
    record(
      `container: kernel=${kv.get('KERNEL')} uid=${kv.get('UID')} pid1=${kv.get('PID1')} boot=${bootA}`,
    );
    record(`cold wake -> supervisor connected: ${dispatchedAt - t0} ms`);
  });

  it('runs a real PTY job that writes known files and streams a known journal', async () => {
    // A client is attached for the whole run: the same socket the web app's
    // terminal pane holds (contracts.md §7).
    const attach = await Attach.open(p.origin, client.cookie, computerId, decodeCbor);
    workRunId = await startRun(WORK_SCRIPT);
    attach.send(encodeCbor({ t: 'attach', run: workRunId, cols: 80, rows: 24 }));

    const r = await waitExited(workRunId);
    expect(r.exitCode).toBe(0);
    expect(r.signal).toBeNull();

    // The journal the CONTROL PLANE holds carries the exact marker block.
    workJournal = tailBytes(r);
    workJournalLength = r.journalLength;
    const text = Buffer.from(workJournal).toString('utf8');
    expect(text).toContain(expectedMarkers());
    expect(r.journalLength).toBeGreaterThan(0);

    // …and the live client saw the same bytes (spec 7.1/7.3: the pane is a view
    // of the run, and the run is owned by the supervisor).
    await waitFor(
      'the attached client to receive the run output',
      async () => Buffer.from(attach.frames(workRunId)).toString('utf8').includes(DONE) || null,
      60_000,
      250,
    );
    const live = Buffer.from(attach.frames(workRunId)).toString('utf8');
    expect(live).toContain(expectedMarkers());
    expect(attach.closed).toBeNull();
    attach.close();

    // A run's result is a difference against its pre-run manifest (spec 5.2/5.3).
    expect(r.preRunManifest).toBeTruthy();
    expect(r.postRunManifest).toBeTruthy();
    const diff = await client.get<{ summary: { added: number }; entries: { path: string }[] }>(
      `/api/computers/${computerId}/runs/${workRunId}/diff`,
    );
    expect(diff.status).toBe(200);
    const paths = diff.body.entries.map((e) => e.path);
    for (const f of FILES) expect(paths).toContain(`/thesis/${f.path}`);
    expect(paths).toContain('/thesis/link');
    // The marker outside the computer's root is NOT part of the computer.
    expect(paths).not.toContain(OUTSIDE_MARKER);
    record(`work run ${workRunId}: ${diff.body.summary.added} entries added, journal ${r.journalLength} B`);
  });

  it('snapshots into R2: the head advances and the chunk store holds the manifest', async () => {
    const before = (await computer()).head;
    const snap = await client.post<{ manifest: string | null; state: string }>(
      `/api/computers/${computerId}/snapshot`,
      { reason: 'command' },
    );
    expect(snap.status).toBe(200);

    const head = await waitFor(
      'the manifest head to advance',
      async () => {
        const h = (await computer()).head;
        return h && h !== before ? h : null;
      },
      120_000,
    );
    headAfterSnapshot = head;
    expect(head).toMatch(/^[0-9a-f]{64}$/);

    // The store really holds it: the manifest object plus the chunks the run's
    // bytes were split into (contracts.md §9). Written by `marid` through
    // opendal → S3 → R2, read here through the same bucket.
    const keys = await storeKeys();
    const manifestKey = `manifests/${head}.cbor`;
    expect(keys.map((k) => k.key)).toContain(manifestKey);
    const chunks = keys.filter((k) => k.key.startsWith('chunks/'));
    // 3 MiB of `big.bin` alone cannot be one chunk at 64 KiB..1 MiB.
    expect(chunks.length).toBeGreaterThanOrEqual(4);
    const runRecords = keys.filter((k) => k.key.startsWith(`runs/${computerId}/`));
    expect(runRecords.length).toBeGreaterThanOrEqual(1);
    record(
      `store: ${keys.length} objects, ${chunks.length} chunks, manifest ${head.slice(0, 12)}…, ` +
        `${runRecords.length} run records`,
    );

    // KNOWN GAP, and here it is on a real deployment (decisions.md, the loop-e2e
    // appendix found it latent): the journal reaches the store TWICE. `marid`
    // writes `journal/{computer}/{run}/{seq:08}.seg`
    // (crates/marid/src/journal.rs) and `ComputerDO` writes the same bytes to
    // `.../{seq:012}.seg` (`#segmentKey`), so the two zero-pad widths never
    // overwrite each other and a reader that lists the prefix would replay the
    // journal twice, out of order. On this substrate it is also money: every
    // journal segment is a doubled R2 Class A write.
    //
    // CANARY: when contracts §9 gives that prefix an owner, this flips.
    const segs = await waitFor(
      'the journal segments to reach the store',
      async () => {
        const k = await storeKeys(`journal/${computerId}/${workRunId}/`);
        return k.length > 0 ? k : null;
      },
      60_000,
      1_000,
    );
    const byWidth = new Map<number, Map<number, number>>();
    for (const k of segs) {
      const name = (k.key.split('/').pop() ?? '').split('.')[0] ?? '';
      const w = name.length;
      if (!byWidth.has(w)) byWidth.set(w, new Map());
      byWidth.get(w)?.set(Number(name), k.size);
    }
    expect([...byWidth.keys()].sort((a, b) => a - b)).toEqual([8, 12]);
    for (const [seq, size] of byWidth.get(8) ?? []) {
      expect(byWidth.get(12)?.get(seq), `segment ${seq} written by both writers`).toBe(size);
    }
    record(
      `journal segments in the store: ${segs.length} objects for one run — the same bytes ` +
        `under both zero-pad widths (marid :08 and ComputerDO :012)`,
    );

    // The file browser reads the manifest, not the substrate (spec 8.4).
    const files = await client.get<FilesBody>(
      `/api/computers/${computerId}/files?path=${encodeURIComponent('/thesis')}`,
    );
    expect(files.status).toBe(200);
    const byName = new Map(files.body.entries.map((e) => [e.name, e]));
    expect(byName.get('big.bin')?.size).toBe(BIG.length);
    expect(byName.get('empty.txt')?.size).toBe(0);
    expect(byName.get('alpha.txt')?.size).toBe(ALPHA.length);
    expect(byName.get('spaced name.txt')?.size).toBe(SPACED.length);
    expect((byName.get('exec.sh')?.mode ?? 0) & 0o777).toBe(0o755);
    expect(byName.get('link')?.kind).toBe('symlink');
    expect(byName.get('link')?.symlinkTarget).toBe('alpha.txt');
  });

  it('the tier policy destroys the container and the computer goes COLD', async () => {
    const appId = containerApp()?.id ?? '';
    expect(appId, 'the container application must exist').not.toBe('');
    const awakeInstance = instanceState(appId, computerId);

    const t0 = Date.now();
    const at = await waitState('cold', 300_000);
    awakeToCold.add(at - t0);
    const c = await computer();
    expect(c.state).toBe('cold');

    // Spec 4.5: the supervisor stops cleanly and Mari writes a FINAL manifest
    // before the substrate is destroyed — on this substrate that is what makes a
    // discarded disk safe, so the head advances one last time on the way down.
    expect(c.head).toMatch(/^[0-9a-f]{64}$/);
    expect(c.head).not.toBe(headAfterSnapshot);
    coldHead = c.head as string;
    const keys = await storeKeys('manifests/');
    expect(keys.map((k) => k.key)).toContain(`manifests/${coldHead}.cbor`);

    // The COLD computer is still a whole computer: the file browser reads the
    // final manifest with no substrate at all (spec 8.4).
    const files = await client.get<FilesBody>(
      `/api/computers/${computerId}/files?path=${encodeURIComponent('/thesis')}`,
    );
    expect(files.status).toBe(200);
    expect(files.body.manifest).toBe(coldHead);
    const byName = new Map(files.body.entries.map((e) => [e.name, e]));
    expect(byName.get('big.bin')?.size).toBe(BIG.length);
    expect(byName.get('empty.txt')?.size).toBe(0);
    expect(byName.get('link')?.symlinkTarget).toBe('alpha.txt');

    // …and the PLATFORM agrees the container is gone. This is the one check in
    // the suite that does not come from Mari: `wrangler containers instances`
    // names each instance after the Durable Object that owns it. Polled, because
    // that listing lags the event by seconds — it can confirm a teardown, it
    // cannot time one.
    const coldInstance = await waitFor(
      'the platform to stop reporting a running instance for this computer',
      async () => {
        const st = instanceState(appId, computerId);
        return st !== 'running' ? st : null;
      },
      180_000,
      5_000,
    );
    expect(coldInstance).not.toBe('running');
    record(
      `AWAKE -> COLD in ${at - t0} ms (idle deadline ${WARM_IDLE_MS} ms); final manifest ` +
        `${coldHead.slice(0, 12)}… written before teardown; platform instance ` +
        `${awakeInstance} -> ${coldInstance}`,
    );
  });

  it('wakes into a NECESSARILY fresh container and every byte comes back', async () => {
    const t0 = Date.now();
    const verify = await startRun(VERIFY_SCRIPT);
    const dispatchedAt = await waitDispatched(verify);
    wakeToSupervisor.add(dispatchedAt - t0);
    const r = await waitExited(verify);
    expect(r.exitCode).toBe(0);
    wakeToVerified.add(Date.now() - t0);

    const out = Buffer.from(tailBytes(r)).toString('utf8');
    expect(out).toContain('VERIFY-DONE');
    const ls = lines(out);

    // ---- the container is a NEW one, proven twice ------------------------
    const bootB = (ls.find((l) => l.startsWith('BOOT=')) ?? '').slice('BOOT='.length);
    expect(bootB).toMatch(/^[0-9a-f-]{36}$/);
    expect(bootB).not.toBe(bootA);
    // "All disk is ephemeral": what was written outside the computer's root is
    // gone, because only the chunk store carries a computer across COLD.
    expect(ls).toContain('OUTSIDE absent');

    // ---- and the computer's own bytes are identical ----------------------
    const sha = new Map(
      ls
        .filter((l) => l.startsWith('SHA '))
        .map((l) => {
          const rest = l.slice('SHA '.length);
          const sp = rest.indexOf(' ');
          return [rest.slice(sp + 1), rest.slice(0, sp)] as [string, string];
        }),
    );
    const mode = new Map(
      ls
        .filter((l) => l.startsWith('MODE '))
        .map((l) => {
          const rest = l.slice('MODE '.length);
          const sp = rest.indexOf(' ');
          return [rest.slice(sp + 1), rest.slice(0, sp)] as [string, string];
        }),
    );
    for (const f of FILES) {
      expect(sha.get(f.path), `sha256 of ${f.path}`).toBe(sha256Hex(f.content));
      if (f.mode) expect(mode.get(f.path), `mode of ${f.path}`).toBe(f.mode);
    }
    expect(ls).toContain('LINK alpha.txt');
    record(
      `fresh container boot=${bootB} (was ${bootA}); ${FILES.length} files byte-identical ` +
        `in ${Date.now() - t0} ms`,
    );

    // ---- the journal is continuous ---------------------------------------
    // The work run's journal is exactly what it was before the computer was
    // destroyed: same length, same bytes, no replay and no truncation.
    const work = await run(workRunId);
    expect(work.journalLength, 'the journal length recorded before the COLD cycle').toBe(
      workJournalLength,
    );
    expect(bytesEqual(tailBytes(work), workJournal)).toBe(true);
    const text = Buffer.from(tailBytes(work)).toString('utf8');
    expect(text).toContain(expectedMarkers());
    // Every marker appears exactly once across the whole journal: nothing was
    // duplicated by the wake, and nothing was lost.
    for (let i = 0; i < TICKS; i++) {
      const marker = `${MARK}-${String(i).padStart(3, '0')}`;
      expect(text.split(marker).length - 1, `${marker} occurrences`).toBe(1);
    }
  });

  it('measures cold wake p50/p99 (spec §13, this substrate)', async () => {
    const CYCLES = Number(process.env.MARI_CF_E2E_CYCLES ?? '3');
    for (let i = 0; i < CYCLES; i++) {
      await reachCold();
      const t0 = Date.now();
      const r = await startRun(VERIFY_SCRIPT);
      const dispatchedAt = await waitDispatched(r);
      wakeToSupervisor.add(dispatchedAt - t0);
      const done = await waitExited(r);
      expect(done.exitCode).toBe(0);
      const out = Buffer.from(tailBytes(done)).toString('utf8');
      // Every cycle re-asserts byte identity: a latency sample is only worth
      // recording if the wake it timed actually restored the computer.
      for (const f of FILES) expect(out).toContain(`SHA ${sha256Hex(f.content)} ${f.path}`);
      expect(out).toContain('OUTSIDE absent');
      wakeToVerified.add(Date.now() - t0);
      record(`cycle ${i + 1}/${CYCLES}: connected ${dispatchedAt - t0} ms, verified ${Date.now() - t0} ms`);
    }
    expect(wakeToSupervisor.n).toBeGreaterThanOrEqual(CYCLES);
    expect(wakeToVerified.n).toBeGreaterThanOrEqual(CYCLES);
  });

  it('survives an eviction mid-run: the machine torn down under a running computer', async () => {
    // Cloudflare "does not guarantee that any instance will run for any set
    // period": a rollout, a maintenance move or a manual stop ends the instance,
    // and the documented mechanism is SIGTERM to the container's main process —
    // which in this image is `marid` itself (PID1=marid, asserted in the first
    // test). This test takes a computer with a run in flight, establishes that
    // `marid` would not survive that signal by proving it handles none, tears
    // the machine down, and then asks what recovered.
    //
    // It runs on its OWN computer: a computer whose container was killed out
    // from under the control plane is not a fixture the other phases should
    // have to share, and keeping it separate is what makes this test re-runnable.
    const created = await client.post<{ id: string }>('/api/computers', { name: 'thesis-evict' });
    expect(created.status).toBe(201);
    evictComputerId = created.body.id;
    const appId = containerApp()?.id ?? '';

    const attach = await Attach.open(p.origin, client.cookie, evictComputerId, decodeCbor);

    const LONG = [
      'set -e',
      `mkdir -p '${DIR}/evict'`,
      // The machine identifies itself first, so "a NEW container served the
      // recovery" is provable from the kernel rather than from Mari.
      `printf 'BOOT=%s\\n' "$(cat /proc/sys/kernel/random/boot_id)"`,
      'i=0',
      'while [ "$i" -lt 600 ]; do',
      `  printf 'EVICT-%03d\\n' "$i"`,
      `  printf 'tick %s\\n' "$i" >> '${DIR}/evict/log.txt'`,
      '  i=$((i+1))',
      '  sleep 0.5',
      'done',
    ].join('\n');
    evictRunId = await startRun(LONG, evictComputerId);
    attach.send(encodeCbor({ t: 'attach', run: evictRunId, cols: 80, rows: 24 }));
    await waitDispatched(evictRunId, RUN_TIMEOUT_MS, evictComputerId);

    // Let it get going, so the control plane durably holds part of the journal.
    const before = await waitFor(
      'the long run to emit its first ticks',
      async () => {
        const r = await run(evictRunId, evictComputerId);
        return Buffer.from(tailBytes(r)).toString('utf8').includes('EVICT-005') ? r : null;
      },
      180_000,
      250,
    );
    const journalBeforeKill = tailBytes(before);
    const headBeforeKill = (await computer(evictComputerId)).head;
    const instanceWhileAwake = appId ? instanceState(appId, evictComputerId) : 'unknown';

    // ---- step 1: signals to PID 1 from inside are a NO-OP, and that is the
    //             proof that `marid` handles none of them --------------------
    // `containers_pid_namespace` makes `marid` PID 1 of its own namespace, and
    // the kernel delivers a signal to a namespace's init ONLY if init installed
    // a handler for it — SIGKILL and SIGSTOP included. So a container that
    // SURVIVES `kill -TERM 1` is a runtime proof that `marid` installs no
    // SIGTERM handler, which is exactly what the platform's own eviction
    // (SIGTERM, 15 minutes, then SIGKILL) will find. Two consequences, both
    // measured here: a runaway agent cannot kill the supervisor, and an
    // eviction gets no graceful shutdown.
    const signalRun = await startRun(
      `kill -TERM 1; kill -KILL 1; sleep 2; printf 'PID1-SURVIVED=%s\\n' "$(cat /proc/1/comm)"`,
      evictComputerId,
    );
    const signalled = await waitExited(signalRun, 120_000, evictComputerId);
    expect(
      Buffer.from(tailBytes(signalled)).toString('utf8'),
      'PID 1 died from an in-namespace SIGTERM/SIGKILL: `marid` gained a signal handler (or the ' +
        'PID namespace flag is off) — update this canary',
    ).toContain('PID1-SURVIVED=marid');
    record(
      'SIGTERM and SIGKILL to PID 1 from inside the container: both ignored, marid still PID 1 ' +
        '— marid installs no signal handler, and a namespace init only receives signals it handles',
    );

    // ---- step 2: the eviction --------------------------------------------
    // The microVM is torn down under the running computer with no warning and no
    // clean stop — what an evicted, migrated or crashed instance looks like from
    // Mari's side. (sysrq is the only lever a test has, precisely because
    // signals to PID 1 do not work: /proc/sys/kernel/sysrq is 1 in the sandbox.
    // While `marid` handles no signals the outcome is identical to the
    // platform's SIGTERM: the process is gone with nothing written.)
    const killedAt = Date.now();
    await startRun('echo b > /proc/sysrq-trigger', evictComputerId);

    // The container really died: a run that was emitting two ticks a second
    // stops emitting entirely. (`wrangler containers instances` is recorded too,
    // but only as a note — the platform's listing lags by seconds, so it cannot
    // carry an assertion about a 3-second-old event.)
    await delay(10_000);
    const stalled = await run(evictRunId, evictComputerId);
    const stalledLength = stalled.journalLength;
    await delay(8_000);
    const stillStalled = await run(evictRunId, evictComputerId);
    expect(
      stillStalled.journalLength,
      'the run kept producing output after the microVM was torn down',
    ).toBe(stalledLength);
    record(
      `eviction: the in-flight run stopped emitting (journal frozen at ${stalledLength} B); ` +
        `platform instance was ${instanceWhileAwake}, now ` +
        `${appId ? instanceState(appId, evictComputerId) : 'unknown'}`,
    );

    // ---- what the CLIENT saw --------------------------------------------
    // A computer going away is not a client disconnect (spec 5.1: a network
    // connection must not own a run; spec 8.3: the interface must not wait for a
    // computer). The pane's socket is to the Durable Object, not to the machine.
    expect(attach.closed, 'the client attach socket closed when the container died').toBeNull();
    expect(attach.open).toBe(true);

    // ---- what the CONTROL PLANE did -------------------------------------
    // NOTHING IS NUDGED HERE. The DO learns its machine is gone by itself: the
    // supervisor's socket closing arms a grace deadline, and — because a torn-down
    // microVM can leave that socket OPEN — a computer with work in flight is
    // health-checked on a cadence (LIVENESS_MS) and the substrate is ASKED. So
    // this is a wait-for-success with a budget, not a measurement of whether it
    // ever happens.
    const RECOVERY_BUDGET_MS = 240_000;
    const stateAfter = await waitFor(
      'the control plane to notice the container is gone (any state but awake)',
      async () => {
        const st = (await computer(evictComputerId)).state;
        return st !== 'awake' ? st : null;
      },
      RECOVERY_BUDGET_MS,
      2_000,
    );
    const noticedMs = Date.now() - killedAt;
    // Captured HERE, before any later run can move the head for its own reasons:
    // this is the head as of "the container is gone and Mari has reacted".
    const headAfterEviction = (await computer(evictComputerId)).head;
    record(
      `eviction -> control plane state ${stateAfter} after ${noticedMs} ms, unaided ` +
        `(supervisor-loss grace, then the substrate is asked whether the instance exists)`,
    );
    // The recovery is recorded as what it was, content-free (spec 6.3) — a COLD
    // reached without the final snapshot spec 4.5 asks for is not a clean success.
    const incidents = await client.get<{ incidents: { kind: string; epoch: number }[] }>(
      `/api/computers/${evictComputerId}/incidents`,
    );
    expect(incidents.status).toBe(200);
    expect(
      incidents.body.incidents.map((i) => i.kind),
      'the eviction was recorded as an incident',
    ).toContain('substrate_lost');

    // Recovery: the next run must wake a brand-new container and run there.
    // This is the user-visible question — "is my computer usable again?" — and
    // it is the number the operator cares about after an eviction.
    const recoverFrom = Date.now();
    const after = await startRun(EVICT_VERIFY_SCRIPT, evictComputerId);
    await waitDispatched(after, RECOVERY_BUDGET_MS, evictComputerId);
    const verified = await waitExited(after, RUN_TIMEOUT_MS, evictComputerId);
    expect(verified.exitCode).toBe(0);
    const recoveredMs = Date.now() - recoverFrom;
    record(
      `eviction -> computer usable again: ${Date.now() - killedAt} ms total ` +
        `(${recoveredMs} ms for the wake once a run asked for it)`,
    );
    // The fresh container is a different machine, and the computer's own files
    // came back out of the chunk store.
    const vout = Buffer.from(tailBytes(verified)).toString('utf8');
    expect(vout).toContain('VERIFY-DONE');
    // Whatever the chunk store held for this computer is what came back: the
    // eviction computer's tree only ever contained the in-flight run's own
    // output, so the marker written outside the computer's root is gone and the
    // in-flight run's file is measured below (the SIGTERM canary).
    expect(vout).toContain('OUTSIDE absent');
    // A DIFFERENT machine: the boot id the killed container printed cannot be
    // the boot id of the one that recovered.
    const bootKilled = /BOOT=([0-9a-f-]{36})/.exec(
      Buffer.from(journalBeforeKill).toString('utf8'),
    )?.[1];
    const bootRecovered = /BOOT=([0-9a-f-]{36})/.exec(vout)?.[1];
    expect(bootKilled).toMatch(/^[0-9a-f-]{36}$/);
    expect(bootRecovered).toMatch(/^[0-9a-f-]{36}$/);
    expect(bootRecovered).not.toBe(bootKilled);

    // ---- the interrupted run --------------------------------------------
    // `marid`'s continuation (decisions.md appendix) reads its own run records
    // out of the chunk store on the fresh container, finds a run that never
    // finished, and — with no agent adapter declaring a resume — takes the
    // defined degradation: INTERRUPTED, plus one content-free attention event.
    const attention = await waitFor(
      'the interrupted attention event',
      async () => {
        const res = await client.get<AttentionBody>(
          `/api/computers/${evictComputerId}/attention`,
        );
        const hit = res.body.attention.filter((a) => a.run === evictRunId);
        return hit.length > 0 ? hit : null;
      },
      180_000,
      1_000,
    );
    expect(attention.length).toBe(1);
    expect(attention[0]?.kind).toBe('interrupted');
    // Content-free (spec 6.2/6.3): metadata only. No terminal bytes, no prompt
    // text, nothing about WHAT the run was doing.
    expect(Object.keys(attention[0] ?? {}).sort()).toEqual(
      ['at', 'dismissed', 'id', 'kind', 'run'].sort(),
    );

    // ---- the journal across the seam ------------------------------------
    // No bytes lost, none duplicated: every tick the control plane held before
    // the kill is still held, and every tick appears exactly once in order.
    const afterKill = await run(evictRunId, evictComputerId);
    expect(afterKill.journalLength).toBeGreaterThanOrEqual(before.journalLength);
    const beforeText = Buffer.from(journalBeforeKill).toString('utf8');
    const afterText = Buffer.from(tailBytes(afterKill)).toString('utf8');
    const ticksBefore = [...beforeText.matchAll(/EVICT-(\d{3})/g)].map((m) => Number(m[1]));
    const ticksAfter = [...afterText.matchAll(/EVICT-(\d{3})/g)].map((m) => Number(m[1]));
    expect(ticksAfter.length).toBeGreaterThanOrEqual(ticksBefore.length);
    for (let i = 1; i < ticksAfter.length; i++) {
      expect(ticksAfter[i]!, `tick order at ${i}`).toBeGreaterThan(ticksAfter[i - 1]!);
    }
    for (const t of ticksBefore) expect(ticksAfter).toContain(t);
    record(
      `journal across the seam: ${ticksBefore.length} ticks before the kill, ` +
        `${ticksAfter.length} after, strictly increasing, none duplicated`,
    );

    // ---- THE GAP THIS TEST EXISTS TO MEASURE ----------------------------
    // Spec 4.4/4.5 want a final manifest written inside the platform's SIGTERM
    // grace window ("SIGTERM + 15 min"). `marid` installs no signal handler —
    // proven at runtime in step 1 — so an eviction kills it outright and
    // everything written since the last snapshot is lost.
    //
    // MEASURED IN LINES, not in "did the head move": the head DOES move here,
    // and not for a good reason. Every run takes a pre-run snapshot (spec 5.2),
    // so merely *starting* the run that kills the machine snapshots the tree.
    // That accident is the only thing standing between an eviction and total
    // loss of the in-flight run's work today.
    //
    // The in-flight run appends one line per tick and emits that tick on the
    // PTY, so the journal (which the control plane holds durably) says exactly
    // how many lines existed at the moment the machine died, and the restored
    // file says how many survived.
    const linesEmitted = Math.max(...ticksAfter) + 1;
    const restoredLines = Number(/EVICTLOG lines=(\d+)/.exec(vout)?.[1] ?? '-1');
    const headAdvanced = headAfterEviction !== headBeforeKill;
    record(
      `SIGTERM grace window: the run had written ${linesEmitted} lines when the machine died, ` +
        `${restoredLines} came back — ${linesEmitted - restoredLines} lines lost. The head did ` +
        `${headAdvanced ? '' : 'NOT '}advance, and where it did it was the KILL RUN'S OWN pre-run ` +
        `snapshot (spec 5.2), not a shutdown: marid installs no SIGTERM handler, so spec 4.5's ` +
        `pre-transition manifest is never written on an eviction`,
    );
    expect(restoredLines).toBeGreaterThanOrEqual(0);
    // CANARY. When `marid` learns SIGTERM and writes a final manifest inside the
    // grace window, nothing will be lost and this is the line to flip.
    expect(
      restoredLines,
      'nothing was lost across an eviction: marid gained a SIGTERM handler — update this canary',
    ).toBeLessThan(linesEmitted);

    attach.close();
  });
});
