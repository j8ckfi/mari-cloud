// ComputerDO — the ONE coordination point for a computer (spec 3.2).
//
// It persists the state (AWAKE/WARM/COLD/WAKING), the substrate handle, the
// manifest head, the journal head, the pane layout, and attention events; it
// mints the fencing epoch on each wake and enforces the head-advance CAS
// (contracts.md §6); it terminates the supervisor and client WebSockets; it
// coalesces the journal tail and persists segments; and it runs the idle tier
// policy (AWAKE->WARM->COLD) via alarms, driving the injected substrate driver.
//
// Storage: DO SQLite. Scalar state is one `meta` KV value; the journal,
// attention log, and segment index are SQL tables.

import { DurableObject } from 'cloudflare:workers';
import {
  PROTO_VERSION,
  encodeFrame,
  FrameReader,
  encodeCbor,
  decodeCbor,
  decodeSupervisorMessage,
  type ComputerState,
  type ControlMessage,
  type SupervisorMessage,
  type RunOffset,
  type ManifestId,
  type ClientToDo,
  type DoToClient,
  type GridSnapshot,
  type Hello,
} from '@mari/shared';
import type { Env } from './types';
import {
  makeSubstrate,
  type SubstrateProvider,
  type SubstrateHandle,
} from './substrate';
import { MiniVtEngine } from './grid';
import { updateComputerState } from './db/fleet';
import {
  DEFAULT_CWD,
  JOURNAL_TAIL_BYTES,
  writeRunArgv,
  type RunDetail,
  type RunDisposition,
  type RunExit,
  type RunKind,
  type RunRecord,
  type RunStatus,
} from './runs';
import { toBase64 } from './bytes';
import type { EventRunState, FleetEvent } from './events-do';

/** An event as raised inside the DO: the computer id is filled in by `#emit`. */
type EmitEvent =
  | { type: 'attention'; runId: string; state: 'waiting' | 'cleared'; kind?: string; at?: number }
  | { type: 'run'; runId: string; state: EventRunState; exitCode?: number | null; at?: number }
  | { type: 'state'; state: ComputerState; at?: number };

/** Journal coalescing window (decisions.md: DO flushes the live tail <=100ms). */
const FLUSH_MS = 25;

/** Base image ref handed to `materialize` (spec §2 "Base image"), overridable
 *  per deployment via `env.BASE_IMAGE`. The delta is restored by marid from the
 *  manifest passed in the materialize env. */
const BASE_IMAGE = 'mari/base:v0';

/** Default filesystem root of a computer inside its substrate (`MARI_ROOT`). */
const DEFAULT_COMPUTER_ROOT = '/work';

/** Default chunk-store URI as the supervisor sees it (`MARI_STORE`). */
const DEFAULT_STORE_URI = 'fs:///store';

/**
 * A driver whose WARM state FREEZES the guest — Docker's `pause` is the case in
 * point — cannot answer `prepare_for_cold`, and spec 4.5 requires the
 * supervisor to stop each agent session cleanly before COLD. Such a driver says
 * so, and the DO resumes the computer before asking. Drivers whose sleep leaves
 * the guest responsive (and the test fake) declare nothing and are untouched.
 */
interface FreezingSubstrate {
  resumeBeforeCold?(handle: SubstrateHandle): boolean;
}

/** Default tier thresholds (spec 4.4). Overridable via env. */
const DEFAULT_WARM_IDLE_MS = 5 * 60 * 1000;
const DEFAULT_COLD_IDLE_MS = 30 * 60 * 1000;

interface AttentionEvent {
  id: number;
  run: string;
  kind: string;
  at: number;
  dismissed: boolean;
}

/** What `describe()` returns to the REST layer (spec 8.2 fleet/detail data). */
export interface ComputerSnapshot {
  computerId: string | null;
  state: ComputerState;
  epoch: number;
  head: ManifestId | null;
  /** The head this computer had BEFORE the current one; the fleet view diffs
   *  head-vs-prevHead for its changed-files count (spec 8.2). */
  prevHead: ManifestId | null;
  /** Pane layout as a JSON string (opaque to the DO); `null` if unset. A string
   *  keeps the RPC return type flat (a recursive JSON type blows the RPC type
   *  checker's instantiation depth). */
  layout: string | null;
  attention: AttentionEvent[];
  /** Ids of runs that are queued, dispatched, or running (spec 8.2). */
  activeRunIds: string[];
  /** Lifetime AWAKE seconds, the cost meter's only input (spec 8.2). */
  awakeSeconds: number;
  /** Substrate driver name, for the price-sheet lookup. */
  substrate: string;
  /** Last state/head change, ms since epoch; 0 when nothing has changed yet. */
  updatedAt: number;
}

/** Result of enqueueing a run (spec 8.3: never block on the wake). */
export interface EnqueueRunResult {
  runId: string;
  /** The computer's state at the moment the run was accepted — `waking` when
   *  this request STARTED the wake. */
  state: ComputerState;
  /** True when the run is waiting for a supervisor to connect. */
  queued: boolean;
}

/** Result of `keepRun` / `revertRun` (spec 5.3). */
export interface DispositionResult {
  ok: boolean;
  /** `stale_epoch` | `not_found` | `already_kept` | `already_reverted` |
   *  `no_pre_run_manifest` | `no_post_run_manifest` | `run_active`. */
  error: string | null;
  disposition: RunDisposition;
  head: ManifestId | null;
  /** False when the call was a no-op because the disposition already held. */
  applied: boolean;
  currentEpoch: number;
}

/** Result of an on-command snapshot (spec 4.3). */
export interface SnapshotCommandResult {
  ok: boolean;
  error: string | null;
  state: ComputerState;
  head: ManifestId | null;
}

/** Result of a wake (materialize/resume): the fencing token the supervisor must
 *  echo in `hello`. The supervisor connects INBOUND to the DO, so no outbound
 *  address is needed here; exposed ports are resolved lazily via exposePort. */
export interface WakeResult {
  state: ComputerState;
  epoch: number;
  token: string;
}

interface Meta {
  computerId: string | null;
  state: ComputerState;
  epoch: number;
  token: string | null;
  head: ManifestId | null;
  prevHead: ManifestId | null;
  handle: SubstrateHandle | null;
  layout: string | null;
  idleSince: number;
  armedIdleSince: number | null;
  coldPending: boolean;
  /** Owning user id, cached from the D1 fleet row for event fan-out. */
  ownerId: string | null;
  /** Lifetime AWAKE milliseconds, closed out on each exit from AWAKE. */
  awakeMs: number;
  /** When the current AWAKE stretch began, or null when not AWAKE. */
  awakeSince: number | null;
  /** Last state/head change, ms since epoch (spec 8.2 fleet card). */
  updatedAt: number;
}

function initialMeta(): Meta {
  return {
    computerId: null,
    state: 'cold',
    epoch: 0,
    token: null,
    head: null,
    prevHead: null,
    handle: null,
    layout: null,
    idleSince: 0,
    armedIdleSince: null,
    coldPending: false,
    ownerId: null,
    awakeMs: 0,
    awakeSince: null,
    updatedAt: 0,
  };
}

/** One row of the DO's SQLite storage (values are the SQL scalar types). */
type SqlRow = Record<string, SqlStorageValue>;

/** Decode a JSON `string[]` column, tolerating a malformed value. */
function parseStringArray(v: unknown): string[] {
  if (typeof v !== 'string' || v === '') return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function toBytes(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

export class ComputerDO extends DurableObject<Env> {
  /** The substrate driver. A FIELD so tests read `do.substrate.calls`
   *  (decisions.md: injected/fake in control-plane tests). */
  substrate: SubstrateProvider;

  /** Proxy egress. Default = global fetch; tests override via
   *  runInDurableObject to reach a fake exposed server. */
  upstreamFetch: (url: string, init: RequestInit) => Promise<Response> = (url, init) =>
    fetch(url, init);

  #meta: Meta = initialMeta();
  #supervisor: WebSocket | null = null;

  // Sockets that completed the `hello` handshake, mapped to the epoch they
  // authenticated with. This gates every non-`hello` supervisor message: an
  // un-helloed socket is absent from the map (rejected outright — it cannot
  // write the journal, raise attention, hold the computer AWAKE, or even learn
  // the current epoch), and a socket whose epoch is no longer current is a
  // fenced-out generation (its data mutations are dropped; only its
  // head-advance still receives the CAS rejection so it learns it lost).
  // Cleared on socket close (contracts.md §6, Appendix B).
  #authEpoch = new Map<WebSocket, number>();

  // Attached client sockets and the runs each is watching.
  #clients = new Map<WebSocket, Set<string>>();

  // Pending journal bytes per run, coalesced until the flush timer fires.
  #pending = new Map<string, Uint8Array[]>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-run grid engines (server-side render for attach snapshots).
  #engines = new Map<string, MiniVtEngine>();

  // The in-flight wake, so N concurrent triggers (a queued run, a file write, a
  // proxy request) materialize the computer ONCE (spec 4.1: one writable copy).
  #wakeInFlight: Promise<WakeResult> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.substrate = makeSubstrate(env.SUBSTRATE_MODE, env);
    ctx.blockConcurrencyWhile(async () => {
      this.#initSql();
      const stored = await ctx.storage.get<Meta>('meta');
      if (stored) this.#meta = { ...initialMeta(), ...stored };
    });
  }

  #initSql(): void {
    const sql = this.ctx.storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS journal (
         run TEXT NOT NULL,
         seq INTEGER NOT NULL,
         startOffset INTEGER NOT NULL,
         bytes BLOB NOT NULL,
         PRIMARY KEY (run, seq)
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS journal_head (
         run TEXT PRIMARY KEY,
         nextOffset INTEGER NOT NULL,
         nextSeq INTEGER NOT NULL
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS segments (
         run TEXT NOT NULL,
         seq INTEGER NOT NULL,
         key TEXT NOT NULL,
         startOffset INTEGER NOT NULL,
         len INTEGER NOT NULL,
         PRIMARY KEY (run, seq)
       )`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS attention (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         run TEXT NOT NULL,
         kind TEXT NOT NULL,
         at INTEGER NOT NULL,
         dismissed INTEGER NOT NULL DEFAULT 0
       )`,
    );
    // Run history (spec 5.2): every run the control plane asked for, plus the
    // ones a supervisor reported on its own. `dispatched` is the exactly-once
    // latch for handing `start_run` to a supervisor — it is persisted BEFORE the
    // frame goes out, so a reconnect (a second `hello`) never re-dispatches, and
    // a run requested while the computer was COLD is never lost.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS runs (
         id TEXT PRIMARY KEY,
         kind TEXT NOT NULL DEFAULT 'command',
         argv TEXT NOT NULL DEFAULT '[]',
         cwd TEXT NOT NULL DEFAULT '/',
         envNames TEXT NOT NULL DEFAULT '[]',
         agent TEXT,
         status TEXT NOT NULL DEFAULT 'queued',
         dispatched INTEGER NOT NULL DEFAULT 0,
         queuedAt INTEGER NOT NULL,
         dispatchedAt INTEGER,
         startedAt INTEGER,
         endedAt INTEGER,
         preManifest TEXT,
         postManifest TEXT,
         exitKind TEXT,
         exitCode INTEGER,
         diffAdded INTEGER,
         diffModified INTEGER,
         diffRemoved INTEGER,
         disposition TEXT NOT NULL DEFAULT 'pending',
         dispositionAt INTEGER,
         epoch INTEGER NOT NULL DEFAULT 0,
         writePath TEXT,
         seq INTEGER NOT NULL DEFAULT 0
       )`,
    );
  }

  async #persist(): Promise<void> {
    await this.ctx.storage.put('meta', this.#meta);
  }

  #warmIdleMs(): number {
    const v = Number(this.env.WARM_IDLE_MS);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_WARM_IDLE_MS;
  }

  #coldIdleMs(): number {
    const v = Number(this.env.COLD_IDLE_MS);
    return Number.isFinite(v) && v > 0 ? v : DEFAULT_COLD_IDLE_MS;
  }

  #setComputerId(id: string | null | undefined): void {
    if (id && !this.#meta.computerId) this.#meta.computerId = id;
  }

  // ---------------------------------------------------------------------------
  // RPC surface (called by the Hono app; see app.ts)
  // ---------------------------------------------------------------------------

  /** Bind this DO to its computer id (idempotent) and return the snapshot. */
  async describe(computerId?: string): Promise<ComputerSnapshot> {
    this.#setComputerId(computerId);
    if (computerId) await this.#persist();
    return {
      computerId: this.#meta.computerId,
      state: this.#meta.state,
      epoch: this.#meta.epoch,
      head: this.#meta.head,
      prevHead: this.#meta.prevHead,
      layout: this.#meta.layout,
      attention: this.#listAttention(),
      activeRunIds: this.#activeRunIds(),
      awakeSeconds: this.#awakeSeconds(),
      substrate: this.env.SUBSTRATE_MODE ?? 'fake',
      updatedAt: this.#meta.updatedAt,
    };
  }

  /** Lifetime AWAKE seconds including the open stretch (spec 8.2 cost meter). */
  #awakeSeconds(): number {
    const open = this.#meta.awakeSince === null ? 0 : Math.max(0, Date.now() - this.#meta.awakeSince);
    return (this.#meta.awakeMs + open) / 1000;
  }

  /** Close out the current AWAKE stretch; idempotent. */
  #closeAwakeStretch(): void {
    if (this.#meta.awakeSince === null) return;
    this.#meta.awakeMs += Math.max(0, Date.now() - this.#meta.awakeSince);
    this.#meta.awakeSince = null;
  }

  /** Seed a freshly-forked computer's head WITHOUT waking (spec 9.1). */
  async initFromManifest(computerId: string, head: ManifestId | null): Promise<void> {
    this.#setComputerId(computerId);
    this.#meta.head = head;
    this.#meta.state = 'cold';
    await this.#persist();
  }

  /**
   * DEV-ONLY (gated on DEV_SEED): return this computer to the state the dev
   * seed route claims to produce — no runs, no attention, no journal, no
   * accrued AWAKE time, no previous head.
   *
   * `wrangler dev` persists Durable Object storage across sessions, so without
   * this the "deterministic seed" (seed.ts) is deterministic only against an
   * empty store: a second run of the web e2e suite starts with the previous
   * run's run rows and undismissed attention events, and an assertion like
   * "the attention badge appears when the supervisor raises one" then passes on
   * residue rather than on the event under test. A no-op unless DEV_SEED=1, so
   * it cannot run in a deployed control plane.
   */
  async resetSeedState(computerId: string): Promise<void> {
    if (this.env.DEV_SEED !== '1') return;
    this.#setComputerId(computerId);
    const sql = this.ctx.storage.sql;
    sql.exec(`DELETE FROM runs`);
    sql.exec(`DELETE FROM attention`);
    sql.exec(`DELETE FROM journal`);
    sql.exec(`DELETE FROM journal_head`);
    sql.exec(`DELETE FROM segments`);
    this.#meta.prevHead = null;
    this.#meta.awakeMs = 0;
    this.#meta.awakeSince = null;
    this.#meta.updatedAt = 0;
    await this.#persist();
  }

  /**
   * DEV-ONLY (gated on DEV_AUTH): adopt the fencing epoch + token a fake
   * supervisor will present in `hello`, so its handshake succeeds against a DO
   * that was never really woken (no substrate). Used exclusively by the web
   * e2e's fake supervisor via the `/supervisor/:id` route. It does NOT touch
   * the D1 fleet state (the computer stays COLD in the fleet view — no wake).
   * A no-op outside dev builds.
   */
  async devPrimeSupervisor(computerId: string, epoch: number, token: string): Promise<void> {
    if (this.env.DEV_AUTH !== '1') return;
    this.#setComputerId(computerId);
    this.#meta.epoch = epoch;
    this.#meta.token = token;
    await this.#persist();
  }

  /** Ensure the computer is AWAKE, minting a new fencing epoch on each COLD/WARM
   *  -> AWAKE transition (contracts.md §6). Returns the fencing token.
   *
   *  Concurrent callers share ONE wake: a queued run, a file write and a proxy
   *  request arriving together must not materialize the computer three times. */
  async wake(computerId?: string): Promise<WakeResult> {
    this.#setComputerId(computerId);
    const inFlight = this.#wakeInFlight;
    if (inFlight) return inFlight;
    const p = this.#wakeInner();
    this.#wakeInFlight = p;
    try {
      return await p;
    } finally {
      this.#wakeInFlight = null;
    }
  }

  /** Start a wake in the BACKGROUND (spec 8.3: the interface must not wait for
   *  a computer). Returns immediately; `state` is already `waking`. */
  #wakeInBackground(): void {
    if (this.#meta.state === 'awake' && this.#meta.token && this.#meta.handle) return;
    if (this.#wakeInFlight) return;
    const p = this.wake();
    this.ctx.waitUntil(p.then(() => undefined).catch(() => undefined));
  }

  async #wakeInner(): Promise<WakeResult> {
    if (this.#meta.state === 'awake' && this.#meta.token && this.#meta.handle) {
      await this.#touch();
      await this.#persist();
      return { state: 'awake', epoch: this.#meta.epoch, token: this.#meta.token };
    }

    const wasWarm = this.#meta.state === 'warm' && this.#meta.handle !== null;
    this.#meta.state = 'waking';
    await this.#persist();
    // The interface shows the transition immediately and never waits for it
    // (spec 8.3) — a write- or run-triggered wake announces itself here.
    this.#emit({ type: 'state', state: 'waking' });

    // Mint the new epoch + one-time supervisor token BEFORE materializing, so
    // the booting supervisor receives them (in its env) and echoes the epoch in
    // `hello` (contracts.md §6).
    this.#meta.epoch += 1;
    // A wake supersedes any in-flight WARM->COLD finalize: the machine is coming
    // UP, not going down. Without this reset, a stale `snapshot_written{final}`
    // from the pre-wake generation would tear down the computer the user just
    // woke (CP-COLDRACE-1). The epoch bump additionally fences that stale
    // snapshot at the #onSupervisorMessage gate; this keeps the flag honest too.
    this.#meta.coldPending = false;
    const token = crypto.randomUUID().replace(/-/g, '');
    this.#meta.token = token;
    const computer = this.#meta.computerId ?? 'unknown';

    if (wasWarm && this.#meta.handle) {
      // WARM -> AWAKE: resume the slept resource in place (returns void).
      await this.substrate.wake(this.#meta.handle);
    } else {
      // COLD -> AWAKE: materialize from the base image; marid restores the delta
      // from the manifest head using the injected config env.
      this.#meta.handle = await this.substrate.materialize({
        computer,
        image: this.env.BASE_IMAGE ?? BASE_IMAGE,
        env: this.#maridEnv(computer, token),
        ports: [],
      });
    }
    this.#meta.state = 'awake';
    // Open a new AWAKE stretch for the cost meter (spec 8.2). Only compute time
    // accrues; WARM and COLD are storage, not compute.
    if (this.#meta.awakeSince === null) this.#meta.awakeSince = Date.now();
    await this.#touch();
    await this.#persist();
    await this.#syncFleetState();
    this.#emit({ type: 'state', state: 'awake' });
    return { state: 'awake', epoch: this.#meta.epoch, token };
  }

  /**
   * The supervisor's whole configuration, handed to `materialize` as process
   * environment (crates/marid/src/config.rs; spec 3.5's materialize carries it).
   *
   * `MARI_CONTROL_URL` must be reachable FROM the computer — a container cannot
   * dial `localhost` — so its origin is deployment config (`SUPERVISOR_URL_BASE`)
   * and only the per-computer path is added here. `MARI_RESTORE_MANIFEST` is the
   * cold-wake input (spec 4.6): this computer's own head, or, for a computer
   * that has none yet, the fleet's base-image manifest (spec §2), so a first
   * wake starts from the base image's root rather than an empty one.
   */
  #maridEnv(computer: string, token: string): Record<string, string> {
    const env: Record<string, string> = {
      MARI_COMPUTER_ID: computer,
      MARI_EPOCH: String(this.#meta.epoch),
      MARI_TOKEN: token,
      MARI_ROOT: this.env.COMPUTER_ROOT ?? DEFAULT_COMPUTER_ROOT,
      MARI_STORE: this.env.STORE_URI ?? DEFAULT_STORE_URI,
    };
    const base = this.env.SUPERVISOR_URL_BASE;
    if (base) {
      env.MARI_CONTROL_URL = `${base.replace(/\/+$/, '')}/supervisor/${encodeURIComponent(computer)}`;
    }
    const restore = this.#meta.head ?? this.env.BASE_MANIFEST ?? null;
    if (restore) env.MARI_RESTORE_MANIFEST = restore;
    return env;
  }

  /** AWAKE -> WARM now (used by the tier alarm and by the epoch-fencing flow to
   *  simulate a supervisor generation change). */
  async sleepNow(): Promise<ComputerState> {
    if (this.#meta.state === 'awake' && this.#meta.handle) {
      await this.substrate.sleep(this.#meta.handle);
      this.#meta.state = 'warm';
      this.#closeAwakeStretch();
      await this.#persist();
      await this.#syncFleetState();
      this.#emit({ type: 'state', state: 'warm' });
    }
    return this.#meta.state;
  }

  /** Current manifest head (test/introspection helper). */
  async getHead(): Promise<ManifestId | null> {
    return this.#meta.head;
  }

  async getState(): Promise<ComputerState> {
    return this.#meta.state;
  }

  async getLayout(): Promise<string | null> {
    return this.#meta.layout;
  }

  /** `layout` is an opaque JSON string; the DO does not parse it. */
  async setLayout(computerId: string, layout: string | null): Promise<void> {
    this.#setComputerId(computerId);
    this.#meta.layout = layout;
    await this.#persist();
  }

  async listAttentionEvents(): Promise<AttentionEvent[]> {
    return this.#listAttention();
  }

  async dismissAttention(id: number): Promise<boolean> {
    const row = [
      ...this.ctx.storage.sql.exec<{ run: string }>(
        `SELECT run FROM attention WHERE id = ? AND dismissed = 0`,
        id,
      ),
    ][0];
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE attention SET dismissed = 1 WHERE id = ? AND dismissed = 0`,
      id,
    );
    const dismissed = cursor.rowsWritten > 0;
    // Tell every open client the badge is gone (spec 6.2's notification has a
    // matching "no longer waiting"); still content-free.
    if (dismissed && row) this.#emit({ type: 'attention', runId: String(row.run), state: 'cleared' });
    return dismissed;
  }

  // ---------------------------------------------------------------------------
  // Runs (spec 5): request, dispatch exactly once, stop, keep/revert
  // ---------------------------------------------------------------------------

  /**
   * Record a run and get it moving (spec 5.1, 8.3).
   *
   * The run is persisted FIRST, then dispatched if a supervisor is on the wire.
   * If the computer is not AWAKE this starts a wake in the background and
   * returns immediately with the run queued — a user who closes the tab, or a
   * computer that is COLD, must not lose the run: `hello` drains the queue.
   */
  async enqueueRun(input: {
    computerId?: string;
    runId: string;
    kind?: RunKind;
    argv: string[];
    cwd?: string;
    envNames?: string[];
    agent?: string | null;
    writePath?: string | null;
  }): Promise<EnqueueRunResult> {
    this.#setComputerId(input.computerId);
    const now = Date.now();
    const seq =
      Number(
        [
          ...this.ctx.storage.sql.exec<{ next: number }>(
            `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM runs`,
          ),
        ][0]?.next ?? 1,
      ) || 1;

    this.ctx.storage.sql.exec(
      `INSERT INTO runs (id, kind, argv, cwd, envNames, agent, status, dispatched, queuedAt, seq, writePath)
       VALUES (?, ?, ?, ?, ?, ?, 'queued', 0, ?, ?, ?)`,
      input.runId,
      input.kind ?? 'command',
      JSON.stringify(input.argv),
      input.cwd ?? DEFAULT_CWD,
      JSON.stringify(input.envNames ?? []),
      input.agent ?? null,
      now,
      seq,
      input.writePath ?? null,
    );
    await this.#persist();

    // The run exists now, whatever the computer's state: tell the interface so
    // it can show a pending run while the wake happens behind it (spec 8.3).
    this.#emit({ type: 'run', runId: input.runId, state: 'pending' });

    // Hand it over now only to the CURRENT wake generation's supervisor; a
    // fenced-out socket that has not closed yet must not receive work (spec
    // 4.1). Otherwise queue it and bring the computer up behind the request —
    // `hello` drains the queue (spec 8.3).
    let dispatched = 0;
    if (this.#supervisor && this.#isCurrentSupervisor(this.#supervisor)) {
      dispatched = this.#dispatchQueued(this.#supervisor);
    }
    if (dispatched === 0) this.#wakeInBackground();

    return {
      runId: input.runId,
      state: this.#meta.state,
      queued: dispatched === 0,
    };
  }

  /** Queue a file write as a run (spec 4.1/8.4). `contentBase64` is decoded on
   *  the substrate by the run itself; the control plane never writes chunks.
   *
   *  The requested path is a MANIFEST path — rooted at the computer's
   *  filesystem root (contracts.md §4), which is what the file browser lists
   *  and what a diff names. The run, however, executes in the SUBSTRATE's
   *  filesystem, where that root may be a subdirectory (`MARI_ROOT`, e.g.
   *  `/work`). The two spaces are only identical when the root is `/`, so the
   *  script targets the substrate path while the run record keeps the manifest
   *  path. Writing the manifest path verbatim would put the bytes somewhere
   *  outside the computer entirely — present on the disk, absent from every
   *  snapshot. */
  async enqueueWrite(input: {
    computerId?: string;
    runId: string;
    path: string;
    contentBase64: string;
    envNames?: string[];
  }): Promise<EnqueueRunResult> {
    const root = (this.env.COMPUTER_ROOT ?? '').replace(/\/+$/, '');
    const target = root === '' ? input.path : `${root}${input.path}`;
    return this.enqueueRun({
      computerId: input.computerId,
      runId: input.runId,
      kind: 'write',
      argv: writeRunArgv(target, input.contentBase64),
      cwd: root === '' ? DEFAULT_CWD : root,
      envNames: input.envNames ?? [],
      writePath: input.path,
    });
  }

  /** Stop a run (spec 5.1). A run that never reached a supervisor is cancelled
   *  in place so it is not dispatched later by a `hello`. */
  async stopRun(runId: string): Promise<{ ok: boolean; status: RunStatus | null; sent: boolean }> {
    const row = this.#runRow(runId);
    if (!row) return { ok: false, status: null, sent: false };
    const status = String(row['status'] ?? 'queued') as RunStatus;
    if (status === 'completed' || status === 'cancelled') {
      return { ok: true, status, sent: false };
    }
    if (Number(row['dispatched'] ?? 0) === 0) {
      // Never reached a supervisor: cancel it in place, and latch `dispatched`
      // so a later `hello` does not start the run the user just stopped.
      this.ctx.storage.sql.exec(
        `UPDATE runs SET status = 'cancelled', dispatched = 1, endedAt = ? WHERE id = ? AND dispatched = 0`,
        Date.now(),
        runId,
      );
      this.#emit({ type: 'run', runId, state: 'failed' });
      return { ok: true, status: 'cancelled', sent: false };
    }
    this.ctx.storage.sql.exec(`UPDATE runs SET status = 'stopping' WHERE id = ?`, runId);
    this.#sendControl({ t: 'stop_run', c: { run: runId } });
    this.#emit({ type: 'run', runId, state: 'stopping' });
    return { ok: true, status: 'stopping', sent: this.#supervisor !== null };
  }

  /** Every run this computer knows about, newest first (spec 8.2/5.3). */
  async listRuns(): Promise<RunRecord[]> {
    const counts = this.#attentionCounts();
    return this.#runRows()
      .map((r) => this.#toRecord(r, counts.get(String(r.id)) ?? 0))
      .sort((a, b) => b.queuedAt - a.queuedAt);
  }

  /** One run plus its journal tail (spec 8.3 renders the detail from this). */
  async runDetail(runId: string): Promise<RunDetail | null> {
    const row = this.#runRow(runId);
    if (!row) return null;
    const counts = this.#attentionCounts();
    const record = this.#toRecord(row, counts.get(runId) ?? 0);
    const journal = this.#readJournal(runId);
    const start = Math.max(0, journal.length - JOURNAL_TAIL_BYTES);
    return {
      ...record,
      journalLength: journal.length,
      journalTailOffset: start,
      journalTail: toBase64(journal.subarray(start)),
      journalTailEncoding: 'base64',
    };
  }

  /**
   * Keep a run's changes (spec 5.3): the head STAYS at the post-run manifest.
   * Idempotent (a second keep is a no-op) and epoch-fenced: pass the epoch the
   * caller observed and the DO refuses if a newer wake has superseded it
   * (contracts.md §6 applied to a control-plane-initiated head decision).
   */
  async keepRun(runId: string, epoch?: number | null): Promise<DispositionResult> {
    const row = this.#runRow(runId);
    if (!row) return this.#disposition(false, 'not_found', 'pending', false);
    if (epoch != null && epoch !== this.#meta.epoch) {
      return this.#disposition(false, 'stale_epoch', row.disposition as RunDisposition, false);
    }
    if (row.disposition === 'reverted') {
      return this.#disposition(false, 'already_reverted', 'reverted', false);
    }
    if (row.disposition === 'kept') return this.#disposition(true, null, 'kept', false);
    if (!row.postManifest) {
      return this.#disposition(false, 'no_post_run_manifest', 'pending', false);
    }

    // The supervisor advances the head to the post-run manifest by default; if
    // that advance never landed (or a revert moved it back), keeping restores it.
    if (this.#meta.head !== row.postManifest) {
      this.#setHead(String(row.postManifest));
      await this.#persist();
      await this.#syncFleetState();
    }
    this.#markDisposition(runId, 'kept');
    return this.#disposition(true, null, 'kept', true);
  }

  /**
   * Revert a run's changes (spec 5.3): restore the disk to the PRE-run manifest
   * and move the head back. Epoch-fenced and idempotent — a second revert
   * neither re-sends `restore_to_manifest` nor moves the head again.
   */
  async revertRun(runId: string, epoch?: number | null): Promise<DispositionResult> {
    const row = this.#runRow(runId);
    if (!row) return this.#disposition(false, 'not_found', 'pending', false);
    if (epoch != null && epoch !== this.#meta.epoch) {
      // A newer wake owns the disk; restoring an old baseline over it would
      // destroy the current generation's work (spec 4.1).
      return this.#disposition(false, 'stale_epoch', row.disposition as RunDisposition, false);
    }
    if (row.disposition === 'kept') return this.#disposition(false, 'already_kept', 'kept', false);
    if (row.disposition === 'reverted') {
      return this.#disposition(true, null, 'reverted', false);
    }
    if (!row.preManifest) {
      return this.#disposition(false, 'no_pre_run_manifest', 'pending', false);
    }
    if (row.status !== 'completed' && row.status !== 'cancelled') {
      return this.#disposition(false, 'run_active', 'pending', false);
    }

    const pre = String(row.preManifest);
    this.#setHead(pre);
    await this.#persist();
    await this.#syncFleetState();
    // Ask the supervisor to put the disk back (spec 5.3 / 4.7). If none is
    // attached the head alone is authoritative: the next cold wake restores from
    // it (spec 4.6), because the chunk store holds the truth (spec 4.1).
    this.#sendControl({ t: 'restore_to_manifest', c: { manifest: pre } });
    this.#markDisposition(runId, 'reverted');
    return this.#disposition(true, null, 'reverted', true);
  }

  /** On-command snapshot (spec 4.3). Requires a live supervisor: only it can
   *  read the substrate disk, the only writable copy (spec 4.1). */
  async snapshotNow(reason: 'command' | 'scheduled' = 'command'): Promise<SnapshotCommandResult> {
    if (this.#meta.state !== 'awake' || !this.#supervisor) {
      return { ok: false, error: 'not_awake', state: this.#meta.state, head: this.#meta.head };
    }
    this.#sendControl({ t: 'snapshot_now', c: { reason } });
    return { ok: true, error: null, state: this.#meta.state, head: this.#meta.head };
  }

  // ---- run storage helpers ----

  #disposition(
    ok: boolean,
    error: string | null,
    disposition: RunDisposition,
    applied: boolean,
  ): DispositionResult {
    return {
      ok,
      error,
      disposition,
      head: this.#meta.head,
      applied,
      currentEpoch: this.#meta.epoch,
    };
  }

  #setHead(head: ManifestId | null): void {
    if (this.#meta.head === head) return;
    this.#meta.prevHead = this.#meta.head;
    this.#meta.head = head;
  }

  #markDisposition(runId: string, disposition: RunDisposition): void {
    this.ctx.storage.sql.exec(
      `UPDATE runs SET disposition = ?, dispositionAt = ? WHERE id = ?`,
      disposition,
      Date.now(),
      runId,
    );
  }

  /** Newest first. `seq` (not the clock) breaks ties, so two runs queued in the
   *  same millisecond still have a stable, insertion-ordered listing. */
  #runRows(): SqlRow[] {
    return [...this.ctx.storage.sql.exec<SqlRow>(`SELECT * FROM runs ORDER BY seq DESC`)];
  }

  #runRow(runId: string): SqlRow | undefined {
    return [
      ...this.ctx.storage.sql.exec<SqlRow>(
        `SELECT * FROM runs WHERE id = ?`,
        runId,
      ),
    ][0];
  }

  #attentionCounts(): Map<string, number> {
    const out = new Map<string, number>();
    for (const r of this.ctx.storage.sql.exec<{ run: string; n: number }>(
      `SELECT run, COUNT(*) AS n FROM attention WHERE dismissed = 0 GROUP BY run`,
    )) {
      out.set(String(r.run), Number(r.n));
    }
    return out;
  }

  #activeRunIds(): string[] {
    return [
      ...this.ctx.storage.sql.exec<{ id: string }>(
        `SELECT id FROM runs WHERE status IN ('queued', 'dispatched', 'running') ORDER BY seq`,
      ),
    ].map((r) => String(r.id));
  }

  #toRecord(row: SqlRow, attention: number): RunRecord {
    const num = (v: unknown): number | null => (v == null ? null : Number(v));
    const strOrNull = (v: unknown): string | null => (v == null ? null : String(v));
    const exitKind = strOrNull(row['exitKind']);
    const diffAdded = num(row['diffAdded']);
    return {
      id: String(row['id']),
      kind: String(row['kind'] ?? 'command') as RunKind,
      argv: parseStringArray(row['argv']),
      cwd: String(row['cwd'] ?? DEFAULT_CWD),
      envNames: parseStringArray(row['envNames']),
      agent: strOrNull(row['agent']),
      status: String(row['status'] ?? 'queued') as RunStatus,
      dispatched: Number(row['dispatched'] ?? 0) !== 0,
      queuedAt: Number(row['queuedAt'] ?? 0),
      dispatchedAt: num(row['dispatchedAt']),
      startedAt: num(row['startedAt']),
      endedAt: num(row['endedAt']),
      preManifest: strOrNull(row['preManifest']),
      postManifest: strOrNull(row['postManifest']),
      exit:
        exitKind === null
          ? null
          : { kind: exitKind as RunExit['kind'], code: Number(row['exitCode'] ?? 0) },
      diff:
        diffAdded === null
          ? null
          : {
              added: diffAdded,
              modified: Number(row['diffModified'] ?? 0),
              removed: Number(row['diffRemoved'] ?? 0),
            },
      disposition: String(row['disposition'] ?? 'pending') as RunDisposition,
      dispositionAt: num(row['dispositionAt']),
      attention,
      epoch: Number(row['epoch'] ?? 0),
      writePath: strOrNull(row['writePath']),
    };
  }

  /**
   * Hand every not-yet-dispatched run to `socket` as `start_run`, EXACTLY ONCE.
   * The `dispatched` latch is written before the frame goes out and the update
   * is conditional on it still being 0, so a reconnect, a second `hello`, or two
   * concurrent dispatch attempts cannot duplicate a run.
   */
  #dispatchQueued(socket: WebSocket): number {
    const pending = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        `SELECT * FROM runs WHERE dispatched = 0 AND status = 'queued' ORDER BY seq`,
      ),
    ];
    let sent = 0;
    for (const row of pending) {
      const id = String(row['id']);
      const claimed = this.ctx.storage.sql.exec(
        `UPDATE runs SET dispatched = 1, status = 'dispatched', dispatchedAt = ?, epoch = ?
         WHERE id = ? AND dispatched = 0`,
        Date.now(),
        this.#meta.epoch,
        id,
      );
      if (claimed.rowsWritten === 0) continue; // someone else claimed it
      try {
        this.#sendControlTo(socket, {
          t: 'start_run',
          c: {
            run: id,
            argv: parseStringArray(row['argv']),
            env_names: parseStringArray(row['envNames']),
            cwd: String(row['cwd'] ?? DEFAULT_CWD),
          },
        });
        sent++;
      } catch {
        // The socket died between the claim and the send: release the latch so
        // the next `hello` picks the run up. Losing a run is worse than the
        // (impossible-here) double send, which the latch itself prevents.
        this.ctx.storage.sql.exec(
          `UPDATE runs SET dispatched = 0, status = 'queued', dispatchedAt = NULL
            WHERE id = ? AND status = 'dispatched'`,
          id,
        );
      }
    }
    return sent;
  }

  /** Full journal bytes for a run (concatenated segments) — used by the client
   *  attach replay and by tests for byte-level assertions. */
  async readJournal(run: string): Promise<Uint8Array> {
    return this.#readJournal(run);
  }

  #readJournal(run: string): Uint8Array {
    const rows = [
      ...this.ctx.storage.sql.exec<{ bytes: ArrayBuffer }>(
        `SELECT bytes FROM journal WHERE run = ? ORDER BY seq`,
        run,
      ),
    ];
    let total = 0;
    const parts: Uint8Array[] = [];
    for (const r of rows) {
      const u = new Uint8Array(r.bytes);
      parts.push(u);
      total += u.length;
    }
    const out = new Uint8Array(total);
    let cursor = 0;
    for (const p of parts) {
      out.set(p, cursor);
      cursor += p.length;
    }
    return out;
  }

  /** Server-side grid for a run (spec 7.3), rendered from the journal by the v0
   *  GridEngine. This is the libghostty-vt swap point for attach snapshots. */
  async snapshotGrid(run: string, cols = 80, rows = 24): Promise<GridSnapshot> {
    const engine = new MiniVtEngine(cols, rows);
    engine.write(this.#readJournal(run));
    return engine.snapshot();
  }

  // ---------------------------------------------------------------------------
  // fetch(): WebSocket upgrades + wake-proxy egress
  // ---------------------------------------------------------------------------

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const computer = request.headers.get('x-mari-computer');
    this.#setComputerId(computer);

    const proxyPort = request.headers.get('x-mari-proxy-port');
    if (proxyPort !== null) {
      await this.#persist();
      return this.#handleProxy(request, Number(proxyPort), url);
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    await this.#persist();

    if (url.pathname.endsWith('/supervisor')) return this.#acceptSupervisor();
    if (url.pathname.endsWith('/client')) return this.#acceptClient();
    return new Response('not found', { status: 404 });
  }

  /** Wake proxy (spec 8.5): ensure AWAKE, expose the port, forward the request. */
  async #handleProxy(request: Request, port: number, url: URL): Promise<Response> {
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return new Response('bad port', { status: 400 });
    }
    const woken = await this.wake();
    if (!this.#meta.handle) return new Response('no substrate handle', { status: 502 });
    const exposedUrl = await this.substrate.exposePort(this.#meta.handle, port);
    const target = exposedUrl.replace(/\/$/, '') + url.pathname + url.search;

    const headers = new Headers(request.headers);
    headers.delete('x-mari-proxy-port');
    headers.delete('x-mari-computer');
    headers.set('x-mari-epoch', String(woken.epoch));

    const init: RequestInit = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }
    return this.upstreamFetch(target, init);
  }

  // ---------------------------------------------------------------------------
  // Supervisor WebSocket (framed CBOR, contracts.md §2)
  // ---------------------------------------------------------------------------

  #acceptSupervisor(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // A per-socket frame reader; do NOT mark this the active supervisor until it
    // completes the `hello` handshake (a fenced-out reconnect must not steal the
    // active channel from the current supervisor).
    const reader = new FrameReader();

    server.addEventListener('message', (event: MessageEvent) => {
      reader.push(toBytes(event.data as ArrayBuffer));
      let body: Uint8Array | null;
      while ((body = reader.nextBody()) !== null) {
        void this.#onSupervisorMessage(body, server);
      }
    });
    server.addEventListener('close', () => {
      this.#authEpoch.delete(server);
      if (this.#supervisor === server) this.#supervisor = null;
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Send to the active (last-handshook) supervisor: DO-initiated messages
   *  (journal_ack, prepare_for_cold). */
  #sendControl(msg: ControlMessage): void {
    if (this.#supervisor) this.#supervisor.send(encodeFrame(msg));
  }

  /** Reply on a specific socket: request/response messages (hello_ack,
   *  head_advance_result) must return to the socket that asked. */
  #sendControlTo(socket: WebSocket, msg: ControlMessage): void {
    socket.send(encodeFrame(msg));
  }

  async #onSupervisorMessage(body: Uint8Array, socket: WebSocket): Promise<void> {
    let msg: SupervisorMessage;
    try {
      msg = decodeSupervisorMessage(body);
    } catch {
      return; // ignore undecodable frames
    }

    // `hello` is the ONLY message accepted before authentication: it performs
    // the token+epoch handshake (contracts.md Appendix B) and marks this socket
    // authenticated. Every other frame requires a completed handshake on THIS
    // socket — an un-helloed peer must not advance the head, write the journal,
    // raise attention, hold the computer AWAKE, or even learn the current epoch
    // (SEC-01, CP-FENCE-INGEST-2).
    if (msg.t === 'hello') return this.#onHello(msg.c, socket);
    if (!this.#authEpoch.has(socket)) return;

    // `head_advance_request` is fenced by the CAS itself (contracts.md §6): an
    // authenticated-but-stale supervisor still receives `accepted:false` +
    // current_epoch so it learns it lost and stops writing. Authentication (not
    // current-epoch) is the bar here, so the rejection reply still flows.
    if (msg.t === 'head_advance_request') {
      return this.#onHeadAdvance(msg.c.manifest, msg.c.epoch, socket);
    }

    // Every remaining message mutates live run state (journal/attention/
    // heartbeat/snapshot/run status). Honor it ONLY from the current-epoch
    // generation; a fenced-out supervisor whose wake was superseded must not
    // inject into the current run (spec 4.1/4.2 single-writer).
    if (!this.#isCurrentSupervisor(socket)) return;
    switch (msg.t) {
      case 'journal_frame':
        return this.#onJournalFrame(msg.c.run, msg.c.offset, msg.c.bytes);
      case 'attention':
        return this.#onAttention(msg.c.run, msg.c.kind);
      case 'snapshot_written':
        return this.#onSnapshotWritten(msg.c.manifest, msg.c.epoch, msg.c.reason);
      case 'run_completed': {
        const exit: RunExit =
          msg.c.exit.t === 'exited'
            ? { kind: 'exited', code: msg.c.exit.c.code }
            : { kind: 'signaled', code: msg.c.exit.c.signal };
        this.#onRunCompleted(msg.c.run, exit, msg.c.post_run_manifest, msg.c.diff);
        this.#broadcastRunStatus(msg.c.run, false, exit.kind === 'exited' ? exit.code : null);
        return;
      }
      case 'run_started':
        this.#onRunStarted(msg.c.run, msg.c.pre_run_manifest);
        this.#broadcastRunStatus(msg.c.run, true, null);
        return;
      case 'run_heartbeat':
        await this.#touch();
        await this.#persist();
        return;
      default:
        return;
    }
  }

  /** True once `socket` completed `hello` AND its wake epoch is still current
   *  (the active supervisor generation). A fenced-out socket returns false. */
  #isCurrentSupervisor(socket: WebSocket): boolean {
    return this.#authEpoch.get(socket) === this.#meta.epoch;
  }

  async #onHello(c: Hello, socket: WebSocket): Promise<void> {
    this.#setComputerId(c.computer);
    const ok =
      c.proto_version === PROTO_VERSION &&
      c.epoch === this.#meta.epoch &&
      c.token === this.#meta.token &&
      this.#meta.token !== null;
    if (!ok) {
      // Bad handshake or fenced-out epoch: reject THIS socket only.
      socket.close(1008, 'handshake rejected');
      return;
    }
    // This becomes the active supervisor channel; record the epoch it
    // authenticated with so its later data messages pass the current-epoch gate
    // (and a future generation's wake fences it out automatically).
    this.#supervisor = socket;
    this.#authEpoch.set(socket, this.#meta.epoch);
    await this.#persist();
    // Reply with the durably-acked offset per run so it resumes correctly.
    const acked: RunOffset[] = this.#allRunHeads();
    this.#sendControlTo(socket, { t: 'hello_ack', c: { acked } });

    // Drain the run queue: everything requested while the computer was COLD or
    // WAKING is handed over now, exactly once (spec 5.1 — a closed laptop must
    // not lose a run; a reconnect must not run it twice).
    this.#dispatchQueued(socket);
  }

  #allRunHeads(): RunOffset[] {
    const rows = [
      ...this.ctx.storage.sql.exec<{ run: string; nextOffset: number }>(
        `SELECT run, nextOffset FROM journal_head`,
      ),
    ];
    return rows.map((r) => ({ run: r.run, offset: r.nextOffset }));
  }

  // ---- journal ----

  #onJournalFrame(run: string, _offset: number, bytes: Uint8Array): void {
    const list = this.#pending.get(run);
    if (list) list.push(bytes);
    else this.#pending.set(run, [bytes]);
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#flushTimer !== null) return;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#flushAll();
    }, FLUSH_MS);
  }

  async #flushAll(): Promise<void> {
    const runs = [...this.#pending.keys()];
    for (const run of runs) this.#flushRun(run);
    // Persisting head counters is done inside #flushRun via SQL; nothing else.
    void runs;
  }

  #flushRun(run: string): void {
    const parts = this.#pending.get(run);
    this.#pending.delete(run);
    if (!parts || parts.length === 0) return;

    let total = 0;
    for (const p of parts) total += p.length;
    const seg = new Uint8Array(total);
    let cursor = 0;
    for (const p of parts) {
      seg.set(p, cursor);
      cursor += p.length;
    }

    const head = this.#runHead(run);
    const startOffset = head.nextOffset;
    const seq = head.nextSeq;

    this.ctx.storage.sql.exec(
      `INSERT INTO journal (run, seq, startOffset, bytes) VALUES (?, ?, ?, ?)`,
      run,
      seq,
      startOffset,
      seg,
    );
    const newOffset = startOffset + seg.length;
    this.ctx.storage.sql.exec(
      `INSERT INTO journal_head (run, nextOffset, nextSeq) VALUES (?, ?, ?)
       ON CONFLICT(run) DO UPDATE SET nextOffset = excluded.nextOffset, nextSeq = excluded.nextSeq`,
      run,
      newOffset,
      seq + 1,
    );

    // Persist the segment to the object store and index it (contracts.md §9).
    const key = this.#segmentKey(run, seq);
    this.ctx.storage.sql.exec(
      `INSERT INTO segments (run, seq, key, startOffset, len) VALUES (?, ?, ?, ?, ?)`,
      run,
      seq,
      key,
      startOffset,
      seg.length,
    );
    // Best-effort direct-to-store write of the segment; the SQL journal is the
    // authoritative tail the DO replays from.
    this.ctx.waitUntil(this.env.STORE.put(key, seg).then(() => undefined).catch(() => undefined));

    // Feed the server-side grid engine (for snapshotGrid / future attach).
    this.#engineFor(run).write(seg);

    // Ack the supervisor up to the new durable offset.
    this.#sendControl({ t: 'journal_ack', c: { run, offset: newOffset } });

    // Fan out the live frame to attached clients.
    this.#broadcastFrame(run, startOffset, seg);
  }

  #segmentKey(run: string, seq: number): string {
    const c = this.#meta.computerId ?? 'unknown';
    const padded = String(seq).padStart(12, '0');
    return `journal/${c}/${run}/${padded}.seg`;
  }

  #runHead(run: string): { nextOffset: number; nextSeq: number } {
    const row = [
      ...this.ctx.storage.sql.exec<{ nextOffset: number; nextSeq: number }>(
        `SELECT nextOffset, nextSeq FROM journal_head WHERE run = ?`,
        run,
      ),
    ][0];
    return row ?? { nextOffset: 0, nextSeq: 0 };
  }

  #engineFor(run: string): MiniVtEngine {
    let e = this.#engines.get(run);
    if (!e) {
      e = new MiniVtEngine(80, 24);
      this.#engines.set(run, e);
    }
    return e;
  }

  // ---- run status reported by the supervisor (spec 5.2, 5.5) ----

  /** A run began; record its diff baseline. A run the control plane never asked
   *  for (started by the supervisor itself) is recorded too, so the history and
   *  the fleet's active-run count stay truthful. */
  #onRunStarted(run: string, preManifest: ManifestId): void {
    const existing = this.#runRow(run);
    if (!existing) {
      const seq =
        Number(
          [
            ...this.ctx.storage.sql.exec<{ next: number }>(
              `SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM runs`,
            ),
          ][0]?.next ?? 1,
        ) || 1;
      this.ctx.storage.sql.exec(
        `INSERT INTO runs (id, kind, argv, cwd, envNames, agent, status, dispatched, queuedAt, seq, epoch)
         VALUES (?, 'command', '[]', '/', '[]', NULL, 'running', 1, ?, ?, ?)`,
        run,
        Date.now(),
        seq,
        this.#meta.epoch,
      );
    }
    // A `run_started` must not resurrect a run the user already stopped, nor a
    // finished one (a late/duplicated frame after a reconnect).
    this.ctx.storage.sql.exec(
      `UPDATE runs
          SET status = CASE WHEN status IN ('stopping','completed','cancelled') THEN status ELSE 'running' END,
              startedAt = COALESCE(startedAt, ?), preManifest = ?, epoch = ?
        WHERE id = ?`,
      Date.now(),
      preManifest,
      this.#meta.epoch,
      run,
    );
    this.#emit({ type: 'run', runId: run, state: 'running' });
  }

  /** A run finished (spec 5.5): record exit, post-run manifest and diff counts,
   *  then push a content-free completion event to the user's open clients. */
  #onRunCompleted(
    run: string,
    exit: RunExit,
    postManifest: ManifestId,
    diff: { added: number; modified: number; removed: number },
  ): void {
    if (!this.#runRow(run)) this.#onRunStarted(run, postManifest);
    this.ctx.storage.sql.exec(
      `UPDATE runs SET status = 'completed', endedAt = ?, postManifest = ?, exitKind = ?, exitCode = ?,
         diffAdded = ?, diffModified = ?, diffRemoved = ? WHERE id = ?`,
      Date.now(),
      postManifest,
      exit.kind,
      exit.code,
      diff.added,
      diff.modified,
      diff.removed,
      run,
    );
    this.#emit({
      type: 'run',
      runId: run,
      state: exit.kind === 'exited' ? 'exited' : 'failed',
      exitCode: exit.kind === 'exited' ? exit.code : null,
    });
  }

  // ---- epoch fencing (contracts.md §6) ----

  async #onHeadAdvance(manifest: ManifestId, epoch: number, socket: WebSocket): Promise<void> {
    const accepted = epoch === this.#meta.epoch;
    if (accepted) {
      this.#setHead(manifest);
      await this.#persist();
      await this.#syncFleetState();
    }
    // Reply to the ASKING socket with the DO's authoritative epoch either way,
    // so a fenced-out supervisor learns it lost (contracts.md §6.3).
    this.#sendControlTo(socket, {
      t: 'head_advance_result',
      c: { accepted, current_epoch: this.#meta.epoch },
    });
  }

  // ---- attention (spec 6.2, content-free) ----

  #onAttention(run: string, kind: string): void {
    const at = Date.now();
    this.ctx.storage.sql.exec(
      `INSERT INTO attention (run, kind, at, dismissed) VALUES (?, ?, ?, 0)`,
      run,
      kind,
      at,
    );
    // Deliver it live to whatever the user has open (spec 6.2). `kind` is the
    // generic signal class from spec 6.1 — never terminal content (spec 6.3).
    this.#emit({ type: 'attention', runId: run, state: 'waiting', kind, at });
  }

  #listAttention(): AttentionEvent[] {
    const rows = [
      ...this.ctx.storage.sql.exec<{
        id: number;
        run: string;
        kind: string;
        at: number;
        dismissed: number;
      }>(`SELECT id, run, kind, at, dismissed FROM attention WHERE dismissed = 0 ORDER BY id`),
    ];
    return rows.map((r) => ({
      id: r.id,
      run: r.run,
      kind: r.kind,
      at: r.at,
      dismissed: r.dismissed !== 0,
    }));
  }

  // ---- snapshot / cold finalize ----

  async #onSnapshotWritten(manifest: ManifestId, _epoch: number, reason: string): Promise<void> {
    if (this.#meta.coldPending && reason === 'final') {
      // The supervisor stopped cleanly and wrote the final manifest: record it
      // as the head, tear down the substrate, and go COLD (spec 4.4/4.5).
      this.#setHead(manifest);
      this.#meta.coldPending = false;
      if (this.#meta.handle) {
        await this.substrate.destroy(this.#meta.handle);
        this.#meta.handle = null;
      }
      this.#meta.token = null;
      this.#meta.state = 'cold';
      this.#closeAwakeStretch();
      await this.#persist();
      await this.#syncFleetState();
      this.#emit({ type: 'state', state: 'cold' });
      this.#supervisor?.close(1000, 'cold');
      this.#supervisor = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Client WebSocket (discrete CBOR, contracts.md §7)
  // ---------------------------------------------------------------------------

  #acceptClient(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.#clients.set(server, new Set());

    server.addEventListener('message', (event: MessageEvent) => {
      let msg: ClientToDo;
      try {
        msg = decodeCbor(toBytes(event.data as ArrayBuffer)) as ClientToDo;
      } catch {
        return;
      }
      void this.#onClientMessage(server, msg);
    });
    server.addEventListener('close', () => {
      this.#clients.delete(server);
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  async #onClientMessage(sock: WebSocket, msg: ClientToDo): Promise<void> {
    switch (msg.t) {
      case 'attach': {
        const watched = this.#clients.get(sock);
        watched?.add(msg.run);
        // Send the current tail snapshot IMMEDIATELY from DO state — no wake
        // (spec 8.3). v0: marid keeps no grid, so we deliver an empty initial
        // grid then replay the exact prior journal bytes as frames from offset
        // 0; live frames continue at the journal head. (libghostty-vt swap: send
        // a populated grid via snapshotGrid() and set baseOffset to the head.)
        const emptyGrid: GridSnapshot = {
          cols: msg.cols,
          rows: msg.rows,
          cells: [],
          cursorCol: 0,
          cursorRow: 0,
          cursorVisible: true,
        };
        this.#send(sock, { t: 'grid', run: msg.run, grid: emptyGrid, baseOffset: 0 });
        const tail = this.#readJournal(msg.run);
        if (tail.length > 0) {
          this.#send(sock, { t: 'frame', run: msg.run, offset: 0, bytes: tail });
        }
        return;
      }
      case 'input':
        // Forward terminal input supervisor-ward as the first-class
        // ControlMessage::Input; marid writes the bytes to the run's PTY
        // (contracts §5.2). Dropped if no supervisor is attached.
        this.#sendControl({ t: 'input', c: { run: msg.run, bytes: msg.bytes } });
        return;
      case 'resize':
        // First-class ControlMessage::Resize -> PTY window size (spec 7.5).
        this.#sendControl({ t: 'resize', c: { run: msg.run, cols: msg.cols, rows: msg.rows } });
        return;
      case 'detach': {
        const watched = this.#clients.get(sock);
        watched?.delete(msg.run);
        return;
      }
    }
  }

  #send(sock: WebSocket, msg: DoToClient): void {
    sock.send(encodeCbor(msg));
  }

  #broadcastFrame(run: string, offset: number, bytes: Uint8Array): void {
    for (const [sock, runs] of this.#clients) {
      if (runs.has(run)) this.#send(sock, { t: 'frame', run, offset, bytes });
    }
  }

  #broadcastRunStatus(run: string, alive: boolean, exitCode: number | null): void {
    for (const [sock, runs] of this.#clients) {
      if (runs.has(run)) this.#send(sock, { t: 'run_status', run, alive, exitCode });
    }
  }

  // ---------------------------------------------------------------------------
  // Tier policy alarms (spec 4.4)
  // ---------------------------------------------------------------------------

  async #touch(): Promise<void> {
    this.#meta.idleSince = Date.now();
    if (this.#meta.state === 'awake') await this.#armTier(this.#warmIdleMs());
  }

  /** Arm the next tier alarm and AWAIT its scheduling (the alarm write must be
   *  durable before callers return, else `runDurableObjectAlarm` may race it). */
  async #armTier(afterMs: number): Promise<void> {
    this.#meta.armedIdleSince = this.#meta.idleSince;
    await this.ctx.storage.setAlarm(Date.now() + afterMs);
  }

  override async alarm(): Promise<void> {
    // Only progress if no activity happened since the alarm was armed. Under the
    // test harness `runDurableObjectAlarm` fires this regardless of wall-clock,
    // which is exactly how idle-time passage is simulated.
    if (this.#meta.armedIdleSince !== this.#meta.idleSince) {
      // Stale (activity reset the timer): re-arm from the current idle mark.
      if (this.#meta.state === 'awake') await this.#armTier(this.#warmIdleMs());
      return;
    }

    if (this.#meta.state === 'awake') {
      // AWAKE -> WARM.
      if (this.#meta.handle) await this.substrate.sleep(this.#meta.handle);
      this.#meta.state = 'warm';
      this.#closeAwakeStretch();
      // Arm the WARM -> COLD alarm (idle mark unchanged => next alarm matches).
      await this.#armTier(this.#coldIdleMs());
      await this.#persist();
      await this.#syncFleetState();
      this.#emit({ type: 'state', state: 'warm' });
      return;
    }

    if (this.#meta.state === 'warm') {
      // WARM -> COLD: ask the supervisor to stop cleanly and write the final
      // manifest; #onSnapshotWritten completes the destroy. If no supervisor is
      // attached, tear down immediately.
      if (this.#supervisor) {
        // Spec 4.5: the supervisor stops each agent session in a clean state
        // before COLD. It can only do that while it is RUNNING, so a substrate
        // whose WARM state freezes the guest is resumed first (Docker `pause`;
        // see FreezingSubstrate). Otherwise `prepare_for_cold` would sit in a
        // frozen socket buffer and the computer would never reach COLD.
        const handle = this.#meta.handle;
        if (handle && (this.substrate as FreezingSubstrate).resumeBeforeCold?.(handle)) {
          await this.substrate.wake(handle);
        }
        this.#meta.coldPending = true;
        await this.#persist();
        this.#sendControl({ t: 'prepare_for_cold' });
      } else {
        if (this.#meta.handle) {
          await this.substrate.destroy(this.#meta.handle);
          this.#meta.handle = null;
        }
        this.#meta.token = null;
        this.#meta.state = 'cold';
        this.#closeAwakeStretch();
        await this.#persist();
        await this.#syncFleetState();
        this.#emit({ type: 'state', state: 'cold' });
      }
      return;
    }
  }

  // ---------------------------------------------------------------------------

  /** Mirror state/head to the D1 fleet row so the fleet view renders without a
   *  wake (spec 8.2/8.3). Best-effort. Also stamps the last-change time the
   *  fleet card shows ("after an absence, this view is the summary", spec 8.2). */
  async #syncFleetState(): Promise<void> {
    this.#meta.updatedAt = Date.now();
    await this.#persist();
    if (!this.#meta.computerId) return;
    try {
      await updateComputerState(this.env.DB, this.#meta.computerId, this.#meta.state, this.#meta.head);
    } catch {
      // The fleet row may not exist yet in some flows; ignore.
    }
  }

  // ---------------------------------------------------------------------------
  // Live event fan-out (spec 6.2): this computer -> the owner's EventsDO -> the
  // owner's open /api/events streams. Fire-and-forget: a notification must never
  // hold up a run, a journal flush, or a state transition.
  // ---------------------------------------------------------------------------

  #emit(event: EmitEvent): void {
    const computer = this.#meta.computerId;
    if (!computer || !this.env.EVENTS) return;
    const payload = { ...event, computer, at: event.at ?? Date.now() } as FleetEvent;
    this.ctx.waitUntil(this.#publish(payload).catch(() => undefined));
  }

  async #publish(event: FleetEvent): Promise<void> {
    const owner = await this.#ownerId();
    if (!owner) return;
    await this.env.EVENTS.get(this.env.EVENTS.idFromName(owner)).publish(event);
  }

  /** The owning user id, from the D1 fleet row; cached in meta after the first
   *  lookup (ownership never moves in v0). */
  async #ownerId(): Promise<string | null> {
    if (this.#meta.ownerId) return this.#meta.ownerId;
    const id = this.#meta.computerId;
    if (!id) return null;
    try {
      const row = await this.env.DB.prepare(`SELECT userId FROM computers WHERE id = ?`)
        .bind(id)
        .first<{ userId: string }>();
      if (row?.userId) {
        this.#meta.ownerId = String(row.userId);
        await this.#persist();
        return this.#meta.ownerId;
      }
    } catch {
      // No fleet row yet (a DO can exist before its D1 row): no listener to
      // notify, and the attention log in this DO remains the durable record.
    }
    return null;
  }
}
