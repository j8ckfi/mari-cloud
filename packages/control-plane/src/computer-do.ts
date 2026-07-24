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

/** Journal coalescing window (decisions.md: DO flushes the live tail <=100ms). */
const FLUSH_MS = 25;

/** Base image ref handed to `materialize` (spec §2 "Base image"). v0 placeholder
 *  until base images are cataloged; the delta is restored by marid from the
 *  manifest head passed in the materialize env. */
const BASE_IMAGE = 'mari/base:v0';

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
  /** Pane layout as a JSON string (opaque to the DO); `null` if unset. A string
   *  keeps the RPC return type flat (a recursive JSON type blows the RPC type
   *  checker's instantiation depth). */
  layout: string | null;
  attention: AttentionEvent[];
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
  handle: SubstrateHandle | null;
  layout: string | null;
  idleSince: number;
  armedIdleSince: number | null;
  coldPending: boolean;
}

function initialMeta(): Meta {
  return {
    computerId: null,
    state: 'cold',
    epoch: 0,
    token: null,
    head: null,
    handle: null,
    layout: null,
    idleSince: 0,
    armedIdleSince: null,
    coldPending: false,
  };
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

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.substrate = makeSubstrate(env.SUBSTRATE_MODE);
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
      layout: this.#meta.layout,
      attention: this.#listAttention(),
    };
  }

  /** Seed a freshly-forked computer's head WITHOUT waking (spec 9.1). */
  async initFromManifest(computerId: string, head: ManifestId | null): Promise<void> {
    this.#setComputerId(computerId);
    this.#meta.head = head;
    this.#meta.state = 'cold';
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
   *  -> AWAKE transition (contracts.md §6). Returns the fencing token. */
  async wake(computerId?: string): Promise<WakeResult> {
    this.#setComputerId(computerId);
    if (this.#meta.state === 'awake' && this.#meta.token && this.#meta.handle) {
      await this.#touch();
      await this.#persist();
      return { state: 'awake', epoch: this.#meta.epoch, token: this.#meta.token };
    }

    const wasWarm = this.#meta.state === 'warm' && this.#meta.handle !== null;
    this.#meta.state = 'waking';
    await this.#persist();

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
      const env: Record<string, string> = {
        MARI_COMPUTER: computer,
        MARI_EPOCH: String(this.#meta.epoch),
        MARI_TOKEN: token,
      };
      if (this.#meta.head) env.MARI_MANIFEST = this.#meta.head;
      this.#meta.handle = await this.substrate.materialize({
        computer,
        image: BASE_IMAGE,
        env,
        ports: [],
      });
    }
    this.#meta.state = 'awake';
    await this.#touch();
    await this.#persist();
    await this.#syncFleetState();
    return { state: 'awake', epoch: this.#meta.epoch, token };
  }

  /** AWAKE -> WARM now (used by the tier alarm and by the epoch-fencing flow to
   *  simulate a supervisor generation change). */
  async sleepNow(): Promise<ComputerState> {
    if (this.#meta.state === 'awake' && this.#meta.handle) {
      await this.substrate.sleep(this.#meta.handle);
      this.#meta.state = 'warm';
      await this.#persist();
      await this.#syncFleetState();
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
    const cursor = this.ctx.storage.sql.exec(
      `UPDATE attention SET dismissed = 1 WHERE id = ? AND dismissed = 0`,
      id,
    );
    return cursor.rowsWritten > 0;
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
      case 'run_completed':
        this.#broadcastRunStatus(msg.c.run, false, msg.c.exit.t === 'exited' ? msg.c.exit.c.code : null);
        return;
      case 'run_started':
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

  // ---- epoch fencing (contracts.md §6) ----

  async #onHeadAdvance(manifest: ManifestId, epoch: number, socket: WebSocket): Promise<void> {
    const accepted = epoch === this.#meta.epoch;
    if (accepted) {
      this.#meta.head = manifest;
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
    this.ctx.storage.sql.exec(
      `INSERT INTO attention (run, kind, at, dismissed) VALUES (?, ?, ?, 0)`,
      run,
      kind,
      Date.now(),
    );
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
      this.#meta.head = manifest;
      this.#meta.coldPending = false;
      if (this.#meta.handle) {
        await this.substrate.destroy(this.#meta.handle);
        this.#meta.handle = null;
      }
      this.#meta.token = null;
      this.#meta.state = 'cold';
      await this.#persist();
      await this.#syncFleetState();
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
      // Arm the WARM -> COLD alarm (idle mark unchanged => next alarm matches).
      await this.#armTier(this.#coldIdleMs());
      await this.#persist();
      await this.#syncFleetState();
      return;
    }

    if (this.#meta.state === 'warm') {
      // WARM -> COLD: ask the supervisor to stop cleanly and write the final
      // manifest; #onSnapshotWritten completes the destroy. If no supervisor is
      // attached, tear down immediately.
      if (this.#supervisor) {
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
        await this.#persist();
        await this.#syncFleetState();
      }
      return;
    }
  }

  // ---------------------------------------------------------------------------

  /** Mirror state/head to the D1 fleet row so the fleet view renders without a
   *  wake (spec 8.2/8.3). Best-effort. */
  async #syncFleetState(): Promise<void> {
    if (!this.#meta.computerId) return;
    try {
      await updateComputerState(this.env.DB, this.#meta.computerId, this.#meta.state, this.#meta.head);
    } catch {
      // The fleet row may not exist yet in some flows; ignore.
    }
  }
}
