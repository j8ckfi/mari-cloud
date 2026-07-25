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
  decodeClientToDo,
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
  FakeSubstrate,
  makeSubstrate,
  type InstanceStatus,
  type SubstrateProvider,
  type SubstrateHandle,
} from './substrate';
// The Cloudflare driver is the one substrate whose construction the Durable
// Object must perform itself: its only dependency is `ctx.container`, the live
// container binding of THIS object, which exists nowhere else. It is Workers-safe
// to import statically (no Node modules, no SDK — see substrates/cloudflare.ts).
import {
  CLOUDFLARE_SUBSTRATE,
  createCloudflareProvider,
} from './substrates/cloudflare';
// ONE definition of "this is a deployed origin" for the whole control plane
// (auth.ts's three OR'd triggers). A second copy here is the drift that would let
// the auth layer and the substrate layer disagree about what production means.
import { isProductionEnv } from './auth';
import { MiniVtEngine } from './grid';
import { updateComputerState, listSecrets } from './db/fleet';
import {
  DEFAULT_CWD,
  JOURNAL_TAIL_BYTES,
  resolveRunCwd,
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

/**
 * Journal coalescing window (decisions.md: DO flushes the live tail <=100ms).
 *
 * COST, not taste — this constant is the single most expensive number in the
 * system (docs/substrates-cloudflare.md, "Durable Object rows written"). Durable
 * Objects bill $1.00 per million ROWS WRITTEN, and each flush writes 3 rows
 * (`journal`, `journal_head`, `segments`). At the old 25 ms a continuously
 * streaming terminal cost 40 flushes/s x 3 rows = 432,000 rows/h ~ $0.43/h,
 * about 10x the $0.045/h of the container being journaled. At 100 ms — which is
 * the window decisions.md already promised — it is 108,000 rows/h ~ $0.11/h.
 *
 * The remaining 3x wants the `segments` and `journal_head` rows folded into the
 * `journal` row (both are derivable from it); that is a DO storage-schema change
 * and is NOT done here. Note that batching the three inserts into one `sql.exec`
 * would NOT have helped: billing counts rows, not statements, and real workerd
 * rejects it anyway — "When executing multiple SQL statements in a single call,
 * only the last statement can have parameters", and the journal row's payload is
 * a bound BLOB.
 */
const FLUSH_MS = 100;

/**
 * A wake that fails (no capacity, image pull error, daemon down) with a run
 * still queued behind it is retried on an alarm, with a bounded backoff. Bounded
 * because a substrate that is out of capacity must not be hammered forever; once
 * the budget is spent the computer sits COLD with its run still queued (spec 5.1
 * — a run is never lost) and the next request or user action retries.
 *
 * THE SCHEDULE SPANS ~12 MINUTES ON PURPOSE. On Cloudflare Containers a
 * `destroy()` followed by a `start()` on the SAME Durable Object is refused for
 * MINUTES — measured >563 s and ~300 s, both eventually recovering, with the
 * platform reporting "no container instance" (the same message as an
 * over-capacity account) while `container.running` still says `true`. Mari's tier
 * policy makes AWAKE→COLD→AWAKE exactly that sequence, so a computer that just
 * went COLD can be unwakeable for several minutes through no fault of the control
 * plane. The answer here is the only honest one available above the platform:
 * never claim success, never hang the client, and keep the queued work moving on
 * a bounded retry while the fleet view reports the truth (COLD, with a retry
 * pending). See docs/decisions.md, "Substrate death and the wedge class".
 */
const WAKE_RETRY_MS = [5_000, 20_000, 60_000, 120_000, 240_000, 300_000];

/**
 * Grace after the supervisor's socket closes while AWAKE, before the substrate is
 * asked whether the instance is still alive.
 *
 * A closed socket is the FIRST signal that a computer's supervisor is gone, and
 * it is not sufficient: a network blip is not a dead container, and marid
 * reconnects with the same epoch and token (contracts.md §6). So the socket close
 * schedules this deadline; only after it, with no supervisor back, does the DO
 * ask the substrate — and only a substrate that says the instance is gone (or
 * cannot say, twice) moves the computer.
 */
const DEFAULT_SUPERVISOR_GRACE_MS = 15_000;

/**
 * How often an AWAKE computer with work in flight is health-checked.
 *
 * A closed socket cannot be the only trigger: on Cloudflare a torn-down microVM
 * left the DO's supervisor socket OPEN and the computer read `awake` 15 minutes
 * later (measured on a real deployment). So while work is pending the DO keeps a
 * deadline armed; if the supervisor has said nothing for a whole window — marid
 * heartbeats every 5 s during a run (crates/marid/src/supervisor.rs) — the
 * substrate is asked. A healthy computer costs one alarm per window and NO
 * substrate call, because a supervisor that spoke recently is its own liveness
 * proof.
 */
const DEFAULT_LIVENESS_MS = 30_000;

/**
 * How long the AWAKE/WARM → COLD handshake waits for the supervisor's final
 * snapshot before finalizing anyway.
 *
 * `#beginCold` asks the supervisor to stop cleanly and write the final manifest
 * (spec 4.5). If that supervisor is already dead — its container stopped, or the
 * socket outlived it — the answer never comes, and before this deadline existed
 * the computer stayed AWAKE forever with no alarm armed: a run enqueued
 * afterwards sat queued and never dispatched (spec 5.1's "a run is never lost"
 * degraded into "a run is never run"). The e2e suite had to nudge that transition
 * with POST /wake and count the nudges; a test helper working around a product
 * defect IS the defect.
 */
const DEFAULT_COLD_FINALIZE_MS = 20_000;

/**
 * Budget for ONE substrate call on the wake path (materialize or resume), and the
 * watchdog window for a WAKING computer.
 *
 * Two failure modes, one number. A driver whose platform call hangs (dockerode
 * has no timeouts of its own) must not hang the client request behind it (spec
 * 8.3), and a computer whose Durable Object was evicted mid-materialize must not
 * be left in WAKING, which is a transition and not a resting place.
 */
const DEFAULT_WAKE_TIMEOUT_MS = 120_000;

/** Watchdog window given to a computer found in WAKING at object construction —
 *  short, because the wake it was waiting for belonged to a process that is gone.
 *  Not zero, so a restart loop does not fight itself. */
const WAKING_REVIVE_MS = 500;

/**
 * How many inconclusive liveness answers are tolerated before the computer is
 * recovered anyway.
 *
 * `unknown` is not `gone` (provider.ts), so it is never treated as one directly —
 * but a computer whose supervisor is gone AND whose substrate cannot be asked is
 * unusable either way, and leaving it AWAKE forever is the wedge this whole path
 * exists to remove. Recovery is safe under exactly the same rules as any other:
 * the resources are destroyed best-effort, the head is untouched (the chunk store
 * holds the truth, spec 4.1), and the next wake mints a NEW epoch, so the old
 * generation can never advance anything even if it turns out to be alive.
 */
const LIVENESS_STRIKES_MAX = 2;

/**
 * How many recoveries in a row are attempted before the computer is left COLD
 * with its work still queued.
 *
 * Reset by any successful `hello`. Without it a container that dies at boot every
 * time (a broken image, a substrate refusing to run it) would be re-materialized
 * forever, which costs money and never converges. When the streak is spent the
 * computer sits COLD, the run is still there (spec 5.1), and the incident log
 * says why.
 */
const RECOVERY_STREAK_MAX = 3;

/**
 * How many times a run that provably never began may be re-queued by a recovery.
 *
 * One. A run whose machine dies before it produces a byte is indistinguishable
 * from one that was never started, so starting it again is safe — but a run that
 * does this repeatedly may be the reason the machine died (the Cloudflare e2e
 * tears its microVM down from INSIDE a run), and re-queueing it forever would
 * spend instances until the recovery budget ran out. After the retry it takes the
 * same degradation an interrupted run takes: recorded, notified once, not lost.
 */
const MAX_RUN_REQUEUES = 1;

/** The cheapest possible "can this instance run a process" (spec 3.5 `exec`),
 *  used when a driver declares no liveness capability of its own. */
const LIVENESS_PROBE_ARGV = ['/bin/sh', '-c', 'exit 0'] as const;

/** Journal bytes buffered for one run, and the offset they start at. The start
 *  is the durable head at the moment the buffer opened, so `start + len` is the
 *  next journal offset this DO expects — the dedup baseline for a replay. */
interface PendingJournal {
  start: number;
  len: number;
  parts: Uint8Array[];
}

/** What went wrong at the journal ingest gate. `duplicate`: a re-sent frame
 *  whose bytes matched what we already hold (benign, deduped). `divergent`: a
 *  re-sent frame whose bytes DIFFER at the same offset — two writers disagree
 *  about the truth (spec 4.1/4.2). `gap`: bytes below the frame's offset never
 *  reached this control plane. */
type JournalAnomalyKind = 'duplicate' | 'divergent' | 'gap';

/** One recorded ingest anomaly (offsets and lengths only — never content). */
export interface JournalAnomaly {
  id: number;
  run: string;
  kind: JournalAnomalyKind;
  atOffset: number;
  len: number;
  at: number;
}

/** How many anomaly rows a computer keeps (newest win). */
const JOURNAL_ANOMALY_KEEP = 200;

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

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

/**
 * A computer-level incident, recorded when Mari had to act on a fact it did not
 * choose: the substrate instance was gone, a final snapshot never arrived, a wake
 * was abandoned. Attention events are per-RUN (spec 6.2) and cannot carry these,
 * and an operator (and a test) must be able to see that a transition completed
 * WITHOUT the thing it asked for rather than reading it as a clean success.
 *
 * CONTENT-FREE, exactly like the attention log (spec 6.3): a kind, a time, and
 * the epoch it happened under. No terminal bytes, no paths, no messages.
 */
export type IncidentKind =
  /** The substrate says the instance behind the handle no longer exists. */
  | 'substrate_lost'
  /** The substrate could not be asked, repeatedly, so the computer was recovered
   *  anyway rather than left wedged. */
  | 'substrate_unknown'
  /** The instance was alive but no supervisor of the current generation was
   *  reachable within the grace window, with work pending. */
  | 'supervisor_lost'
  /** COLD was finalized from the last known head because the supervisor never
   *  delivered its final snapshot (spec 4.5's manifest was MISSED). */
  | 'final_snapshot_missed'
  /** A destroy the control plane asked for did not succeed; the computer still
   *  moved on, because a handle nobody can destroy must not wedge a computer. */
  | 'destroy_failed'
  /** A wake was left mid-flight (the object was evicted, or the substrate call
   *  exceeded its budget) and had to be rolled back. */
  | 'wake_abandoned'
  /** Recovery was attempted RECOVERY_STREAK_MAX times without a supervisor ever
   *  authenticating; the computer is left COLD with its work queued. */
  | 'recovery_exhausted';

/** One recorded incident (kinds and times only — never content). */
export interface Incident {
  id: number;
  kind: IncidentKind;
  at: number;
  epoch: number;
}

/** How many incident rows a computer keeps (newest win). */
const INCIDENT_KEEP = 100;

/**
 * What one liveness check concluded (see `ComputerDO.healthCheck`).
 *
 * `supervised` and `idle` cost nothing: a supervisor that spoke inside the window
 * is its own proof. `inconclusive` and `mute` are the BOUNDED middle — the
 * substrate could not be asked, or a socket is open but silent — and repeat until
 * the strike budget runs out. `recovered` means the computer was moved.
 */
export type LivenessVerdict =
  | 'not_awake'
  | 'idle'
  | 'supervised'
  | 'unsupervised_idle'
  | 'inconclusive'
  | 'mute'
  | 'recovered';

/** The deadline slots multiplexed onto the Durable Object's ONE alarm.
 *
 *  A DO has exactly one alarm (spec 3.2's single coordination point), and before
 *  this every new deadline had to fight the tier policy for it — which is why
 *  several transitions had no deadline at all and could never advance without an
 *  external event. Processing order is the order below: recovery before policy. */
const DEADLINES = ['wakeRetry', 'waking', 'liveness', 'cold', 'tier'] as const;
type DeadlineName = (typeof DEADLINES)[number];

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
 *  address is needed here; exposed ports are resolved lazily via exposePort.
 *
 *  A substrate that refuses is a RESULT, not a rejection — the same convention
 *  the other DO decisions use (`DispositionResult`, `SnapshotCommandResult`).
 *  `ok: false` carries the state the computer actually landed in; `token` is
 *  then empty and must not be used. */
export interface WakeResult {
  ok: boolean;
  /** `wake_failed` when the substrate refused, else `null`. */
  error: string | null;
  state: ComputerState;
  epoch: number;
  token: string;
  /**
   * True when the substrate refused but the DO has ARMED A RETRY: the wake is
   * still in progress from the user's point of view and the queued work will be
   * taken as soon as the substrate accepts it. This is what makes a refusal
   * honest instead of either a lie ("awake") or a dead end ("failed") on a
   * substrate whose own recovery takes minutes — Cloudflare's destroy→start
   * refusal being the measured case (see WAKE_RETRY_MS).
   */
  retrying: boolean;
  /** When that retry is due (ms since epoch), or null when none is armed. */
  retryAt: number | null;
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
  /** When a failed wake is to be retried by the alarm, or null when none is
   *  pending. One of the deadline slots multiplexed onto the single alarm. */
  wakeRetryAt: number | null;
  /** Consecutive failed wakes; reset by any successful one. Bounds the retry. */
  wakeFailures: number;
  /** Tier-policy deadline (spec 4.4), or null when none is pending. */
  tierAt: number | null;
  /** Liveness deadline: the supervisor-loss grace window, and the recurring
   *  health check while work is in flight. */
  livenessAt: number | null;
  /** Deadline for the AWAKE/WARM → COLD handshake to complete on its own. */
  coldAt: number | null;
  /** Watchdog for a computer left in WAKING (a transition, not a state). */
  wakingAt: number | null;
  /** When the CURRENT wake generation reached AWAKE, or null when not AWAKE.
   *  A generation younger than the grace window is still allowed to be booting. */
  generationAt: number | null;
  /** True once a supervisor completed `hello` in the CURRENT generation. Reset
   *  when a new epoch is minted. */
  supervisorSeen: boolean;
  /** When the last current-generation supervisor socket closed while AWAKE. */
  supervisorLostAt: number | null;
  /** Consecutive inconclusive liveness answers (an `unknown` verdict, or a live
   *  socket that has gone mute). Reset by any supervisor message. */
  livenessStrikes: number;
  /** Consecutive recoveries with no successful `hello` in between. Bounds the
   *  recover→wake→recover loop a permanently broken image would otherwise cause. */
  recoveryStreak: number;
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
    wakeRetryAt: null,
    wakeFailures: 0,
    tierAt: null,
    livenessAt: null,
    coldAt: null,
    wakingAt: null,
    generationAt: null,
    supervisorSeen: false,
    supervisorLostAt: null,
    livenessStrikes: 0,
    recoveryStreak: 0,
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

/** Parse a numeric `var` (Workers env values are always strings). */
function numberVar(v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
  #pending = new Map<string, PendingJournal>();
  #flushTimer: ReturnType<typeof setTimeout> | null = null;

  // Per-run grid engines (server-side render for attach snapshots).
  #engines = new Map<string, MiniVtEngine>();

  // The in-flight wake, so N concurrent triggers (a queued run, a file write, a
  // proxy request) materialize the computer ONCE (spec 4.1: one writable copy).
  #wakeInFlight: Promise<WakeResult> | null = null;

  // When the active supervisor last said ANYTHING on an authenticated socket.
  // In memory only, and deliberately: it is read by the liveness deadline within
  // one object lifetime, and persisting it would add a storage write per journal
  // frame — the most expensive thing this object does (see FLUSH_MS). If the
  // object is re-created the sockets died with it, so 0 correctly means "nothing
  // has spoken to me yet".
  #lastSupervisorAt = 0;

  // A recovery in progress, so a liveness deadline, a wake and a REST call cannot
  // each tear the same dead generation down (the mirror of #wakeInFlight).
  #recoveryInFlight: Promise<void> | null = null;

  // How many liveness probes this object has asked the substrate for. Reported by
  // `healthCheck`, so a test can assert that a HEALTHY computer costs none.
  #probeCount = 0;

  /**
   * This deployment's substrate is the IN-MEMORY FAKE and this is a production
   * environment — so nothing this object asks for can ever exist.
   *
   * The fake answers `materialize` with a handle, reports every instance `alive`,
   * and starts no process. On a dev origin that is exactly what the suites want.
   * On a deployed origin it is a LIE with the same shape as the wedge the
   * liveness lane closed: the computer reads AWAKE, `POST /wake` answers 200, the
   * fleet shows `activeRuns`, and no supervisor will ever connect to take the
   * work — for as long as the deployment lives, with nothing in the logs.
   *
   * So `wake` refuses instead (`substrate_not_configured`, HTTP 503) and the
   * computer stays at the state it really is in. Everything a COLD computer can
   * serve without a substrate — sign-in, the fleet view, browsing the manifest
   * head (spec 8.4) — keeps working, which is what makes this a refusal rather
   * than a dead deployment. Read-only honesty is not a substitute for a
   * substrate; it is what makes the missing one visible.
   *
   * Decided in the constructor because that is where the driver is chosen: the
   * verdict is a property of the deployment, never of a request.
   */
  readonly #unbackedInProduction: boolean;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.substrate =
      env.SUBSTRATE_MODE === CLOUDFLARE_SUBSTRATE && !env.SUBSTRATE
        ? createCloudflareProvider({
            // Undefined when the class has no `containers` binding: the driver
            // then fails every operation with a typed `no_binding` error, which
            // keeps a misdeployment loud without bricking the read-only paths a
            // COLD computer serves without any substrate (spec 8.4).
            container: ctx.container,
            maxInstances: numberVar(env.CF_MAX_INSTANCES),
            waitUntil: (p) => ctx.waitUntil(p.then(() => undefined)),
            // A platform-initiated stop is otherwise UNOBSERVABLE (the monitor
            // promise dies with the request's I/O context). Recording it is what
            // lets spec 4.7 tell a cold wake from a stop nobody asked for.
            onContainerExit: (info) => {
              console.warn(
                `mari: container exited computer=${info.computer} epoch=${info.epoch ?? '?'} ` +
                  `doState=${this.#meta.state}${info.error ? ` error=${info.error}` : ''}`,
              );
            },
          })
        : makeSubstrate(env.SUBSTRATE_MODE, env);
    // `instanceof FakeSubstrate` rather than re-reading SUBSTRATE_MODE: the
    // question is what driver this object actually holds, and the selection above
    // has already answered it (an unknown mode also lands on the fake). Two
    // sources for one verdict is how they drift.
    this.#unbackedInProduction = isProductionEnv(env) && this.substrate instanceof FakeSubstrate;
    ctx.blockConcurrencyWhile(async () => {
      this.#initSql();
      const stored = await ctx.storage.get<Meta>('meta');
      if (stored) this.#meta = { ...initialMeta(), ...stored };
      // A computer found in WAKING when this object is CREATED had its wake in
      // flight inside a process that no longer exists — this instance is new, so
      // nothing is in flight now. That is the private-instance restart and the
      // Durable Object eviction, and nothing else in the system acts on WAKING
      // (the tier policy does not), so it gets a fresh, short watchdog window
      // rather than waiting out a deadline the dead process wrote.
      if (this.#meta.state === 'waking') {
        this.#meta.wakingAt = Date.now() + WAKING_REVIVE_MS;
        await ctx.storage.put('meta', this.#meta);
        await this.#armAlarm();
      }
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
    // Journal ingest anomalies (spec 4.2: the journal here is the TRUTH, so a
    // frame that did not land exactly where it claimed is recorded, never
    // silently absorbed). Offsets and lengths ONLY — this table must stay
    // content-free (spec 6.3).
    sql.exec(
      `CREATE TABLE IF NOT EXISTS journal_anomaly (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         run TEXT NOT NULL,
         kind TEXT NOT NULL,
         atOffset INTEGER NOT NULL,
         len INTEGER NOT NULL,
         at INTEGER NOT NULL
       )`,
    );
    // Computer-level incidents (see IncidentKind). Content-free by construction:
    // there is nowhere in this table to put a byte of a user's data.
    sql.exec(
      `CREATE TABLE IF NOT EXISTS incident (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         kind TEXT NOT NULL,
         at INTEGER NOT NULL,
         epoch INTEGER NOT NULL
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
         seq INTEGER NOT NULL DEFAULT 0,
         requeues INTEGER NOT NULL DEFAULT 0
       )`,
    );
    // Additive migration for objects created before `requeues` existed (a private
    // instance's Durable Object storage outlives a deploy). SQLite has no
    // `ADD COLUMN IF NOT EXISTS`, so the second attempt throwing "duplicate
    // column name" IS the success case.
    try {
      sql.exec(`ALTER TABLE runs ADD COLUMN requeues INTEGER NOT NULL DEFAULT 0`);
    } catch {
      // Already present.
    }
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

  /** The computer's filesystem root inside the substrate (`MARI_ROOT`). Every
   *  run's working directory is resolved against it (spec 2: ONE filesystem). */
  #computerRoot(): string {
    const root = (this.env.COMPUTER_ROOT ?? DEFAULT_COMPUTER_ROOT).replace(/\/+$/, '');
    return root === '' ? '/' : root;
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
    sql.exec(`DELETE FROM journal_anomaly`);
    sql.exec(`DELETE FROM segments`);
    // The coalescing buffer holds pre-reset offsets; keeping it would make the
    // next frame look like a replay of bytes the reset just deleted.
    this.#pending.clear();
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
   *  -> AWAKE transition (contracts.md §6). Returns the fencing token, or
   *  `ok: false` and the state the computer landed in when the substrate refused
   *  (see `#failWake`) — CHECK IT before using `token`.
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
   *  a computer). Returns immediately; `state` is already `waking`.
   *
   *  It must NOT early-return on the DO's own belief that it is AWAKE — that
   *  belief is exactly what a dead substrate invalidates, and trusting it is what
   *  wedged a computer whose container had been removed: the run was queued, the
   *  state read `awake`, and nothing ever materialized an instance to run it. A
   *  live supervisor is the only proof of AWAKE that costs nothing; without one
   *  the full `wake()` path runs and verifies liveness. */
  #wakeInBackground(): void {
    if (this.#meta.state === 'awake' && this.#meta.token && this.#meta.handle) {
      if (this.#liveSupervisor()) return;
    }
    if (this.#wakeInFlight) return;
    const p = this.wake();
    this.ctx.waitUntil(p.then(() => undefined).catch(() => undefined));
  }

  async #wakeInner(): Promise<WakeResult> {
    // No substrate, no wake, and say so — BEFORE any state is touched. See
    // `#unbackedInProduction`: the alternative is a deployment that reports AWAKE
    // for the rest of its life and runs nothing.
    if (this.#unbackedInProduction) {
      console.error(
        `mari: refusing to wake computer=${this.#meta.computerId ?? '?'}: ` +
          `SUBSTRATE_MODE=${this.env.SUBSTRATE_MODE ?? '(unset)'} selects the in-memory fake ` +
          'substrate on a production environment, so no instance can exist. Deploy with a real ' +
          'substrate (deploy/DEPLOY.md).',
      );
      return {
        ok: false,
        error: 'substrate_not_configured',
        state: this.#meta.state,
        epoch: this.#meta.epoch,
        token: '',
        retrying: false,
        retryAt: null,
      };
    }
    if (this.#meta.state === 'awake' && this.#meta.token && this.#meta.handle) {
      const verdict = await this.#verifyAwake();
      if (verdict === 'supervised' || verdict === 'booting') {
        await this.#touch();
        await this.#persist();
        return {
          ok: true,
          error: null,
          state: 'awake',
          epoch: this.#meta.epoch,
          token: this.#meta.token,
          retrying: false,
          retryAt: null,
        };
      }
      // AWAKE was a claim this control plane can no longer stand behind. Recover
      // honestly (COLD at the last manifest head — its truth is the chunk store,
      // spec 4.1) and fall through to materialize a FRESH instance below under a
      // NEW epoch, so the dead generation can never advance anything.
      //
      // This is what makes POST /wake honest: before it, an AWAKE computer whose
      // container had been removed answered `{"state":"awake"}` and did nothing.
      await this.#recover(verdict, { rewake: false });
    }

    const wasWarm = this.#meta.state === 'warm' && this.#meta.handle !== null;
    this.#meta.state = 'waking';
    // WAKING is a transition, and a transition needs a deadline: if this object is
    // evicted (or the runtime restarted) between here and the substrate's answer,
    // nothing else would ever move the computer again. The watchdog below is what
    // makes that recoverable instead of terminal.
    this.#setDeadline('waking', Date.now() + this.#wakeTimeoutMs() * 2);
    await this.#armAlarm();
    await this.#persist();
    // The interface shows the transition immediately and never waits for it
    // (spec 8.3) — a write- or run-triggered wake announces itself here.
    this.#emit({ type: 'state', state: 'waking' });

    // Mint the new epoch + one-time supervisor token BEFORE materializing, so
    // the booting supervisor receives them (in its env) and echoes the epoch in
    // `hello` (contracts.md §6).
    this.#meta.epoch += 1;
    // A NEW generation: nothing the previous supervisor did or said counts, and
    // the grace/liveness bookkeeping starts over.
    this.#meta.supervisorSeen = false;
    this.#meta.supervisorLostAt = null;
    this.#meta.livenessStrikes = 0;
    this.#lastSupervisorAt = 0;
    // A wake supersedes any in-flight WARM->COLD finalize: the machine is coming
    // UP, not going down. Without this reset, a stale `snapshot_written{final}`
    // from the pre-wake generation would tear down the computer the user just
    // woke (CP-COLDRACE-1). The epoch bump additionally fences that stale
    // snapshot at the #onSupervisorMessage gate; this keeps the flag honest too.
    this.#meta.coldPending = false;
    const token = crypto.randomUUID().replace(/-/g, '');
    this.#meta.token = token;
    const computer = this.#meta.computerId ?? 'unknown';
    // PERSIST THE MINT BEFORE THE SUBSTRATE CALL. The epoch is monotonic by
    // contract (contracts.md §6) and the whole fencing argument rests on it, so a
    // crash between here and the substrate's answer must not let the NEXT wake
    // hand out the same number to a different generation — the supervisor this
    // wake is booting already has it in its environment.
    await this.#persist();

    try {
      if (wasWarm && this.#meta.handle) {
        // WARM -> AWAKE: resume the slept resource in place (returns void).
        // BOUNDED: a driver whose platform call hangs (dockerode has no timeout of
        // its own, and Cloudflare's over-capacity failure mode is a HANG rather
        // than an error) must not hang the request behind it — spec 8.3.
        await this.#bounded(this.substrate.wake(this.#meta.handle), this.#wakeTimeoutMs(), 'resume');
      } else {
        // COLD -> AWAKE: materialize from the base image; marid restores the
        // delta from the manifest head using the injected config env.
        const handle = await this.#bounded(
          this.substrate.materialize({
            computer,
            image: this.env.BASE_IMAGE ?? BASE_IMAGE,
            env: await this.#maridEnv(computer, token),
            ports: [],
          }),
          this.#wakeTimeoutMs(),
          'materialize',
        );
        // PERSIST THE HANDLE FIRST, before anything else can fail. Everything
        // after this point can throw or be evicted, and a handle this object
        // never wrote down is a substrate resource nobody can destroy — an
        // orphan holding the computer's single instance slot.
        this.#meta.handle = handle;
        await this.#persist();
      }
    } catch (err) {
      // A substrate that refuses is an OUTCOME of a wake, not an exception in
      // the control plane: it is reported as a result so every caller has to
      // look at it, and so a failed wake cannot become an unhandled rejection
      // crossing the DO's RPC boundary. A client learns `wake_failed` and the
      // state it landed in, never a provider's internals — but the operator has
      // to learn WHY, and no substrate driver logs on its own, so the reason is
      // recorded here and nowhere else.
      console.warn(
        `mari: wake failed computer=${computer} epoch=${this.#meta.epoch} ` +
          `path=${wasWarm ? 'resume' : 'materialize'}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // A RESUME that failed asks a second question: is the resource still there
      // at all? If the substrate says it is GONE, WARM was a claim no future wake
      // could ever honour — every attempt would resume something that does not
      // exist. That is the eviction path, not a refusal: recover (COLD at the last
      // manifest head) and materialize a FRESH instance in this same call, because
      // a usable computer is what the caller asked for. `unknown` keeps WARM — the
      // resource may well be there, and a resume is cheaper than a restore.
      if (wasWarm && this.#meta.handle !== null && (await this.#probeInstance()) === 'gone') {
        await this.#recover('substrate_lost', { rewake: false });
        // One retry, now on the COLD path (state cold, no handle). A failure there
        // ends in `#failWake` with `wasWarm` false, so this cannot recurse again.
        return this.#wakeInner();
      }
      await this.#failWake(wasWarm);
      return {
        ok: false,
        error: 'wake_failed',
        state: this.#meta.state,
        epoch: this.#meta.epoch,
        token: '',
        retrying: this.#meta.wakeRetryAt !== null,
        retryAt: this.#meta.wakeRetryAt,
      };
    }
    this.#meta.state = 'awake';
    this.#meta.wakeFailures = 0;
    this.#meta.wakeRetryAt = null;
    this.#meta.generationAt = Date.now();
    this.#setDeadline('waking', null);
    // Open a new AWAKE stretch for the cost meter (spec 8.2). Only compute time
    // accrues; WARM and COLD are storage, not compute.
    if (this.#meta.awakeSince === null) this.#meta.awakeSince = Date.now();
    await this.#touch();
    await this.#persist();
    await this.#syncFleetState();
    this.#emit({ type: 'state', state: 'awake' });
    return {
      ok: true,
      error: null,
      state: 'awake',
      epoch: this.#meta.epoch,
      token,
      retrying: false,
      retryAt: null,
    };
  }

  /**
   * Is this computer's AWAKE actually true?
   *
   * The DO's own `state` is a record of what it last asked for, not an
   * observation. A substrate evicts an instance (routine on Cloudflare, one
   * `docker rm -f` on Docker) without telling anyone, and then AWAKE is a claim
   * about a machine that does not exist: runs queue behind a supervisor that will
   * never connect, and `POST /wake` answers "already awake".
   *
   * Three answers, in the order they cost:
   *
   *  1. A live current-generation supervisor is proof. It costs nothing and it is
   *     the case in every healthy computer.
   *  2. A generation younger than the grace window is still allowed to be
   *     booting; marid dials in within ~115 ms measured, but a substrate under
   *     load is slower and tearing that wake down would fight the caller.
   *  3. Otherwise ASK THE SUBSTRATE (provider.ts's liveness capability, or spec
   *     3.5's `exec` as the probe). Only `alive` keeps a computer AWAKE — and not
   *     even that when there is nothing to serve the work with, because an
   *     instance with no supervisor cannot run anything.
   */
  async #verifyAwake(): Promise<'supervised' | 'booting' | IncidentKind> {
    if (this.#liveSupervisor()) return 'supervised';
    const age = Date.now() - (this.#meta.generationAt ?? 0);
    if (age < this.#supervisorGraceMs()) return 'booting';
    const status = await this.#probeInstance();
    if (status === 'gone') return 'substrate_lost';
    if (status === 'unknown') return 'substrate_unknown';
    // `alive` with no supervisor past the grace window is a machine that cannot
    // serve its computer. It is replaced rather than reported as AWAKE: its disk
    // is a cache (spec §2) and the head in the chunk store is the truth.
    return 'supervisor_lost';
  }

  /**
   * A wake failed (no capacity, image pull error, daemon down). Leave WAKING.
   *
   * WAKING is a transition, not a resting place: nothing else moves a computer
   * out of it. The tier alarm acts on AWAKE and WARM only, and no alarm is armed
   * during a wake — so a computer left in WAKING is a permanent spinner in the
   * fleet view (spec 8.3 forbids exactly that), with a `state: waking` already
   * on `/api/events` and no event after it. Worse, a WARM computer whose resume
   * threw would, on the next attempt, no longer look WARM and would MATERIALIZE
   * a second resource beside the one it still holds — two writable copies of one
   * computer (spec 4.1).
   *
   * So: fall back to the state the substrate is actually in, tell the fleet and
   * the event stream, and hand the caller `ok: false` (see `WakeResult`).
   * The epoch stays where it is — it is monotonic by contract (contracts.md §6);
   * a wake that failed still burned one, which costs nothing but a number.
   */
  async #failWake(wasWarm: boolean): Promise<void> {
    // WARM is only truthful while the slept resource exists; a failed
    // materialize left none, so the computer is COLD — in the chunk store only.
    const resumable = wasWarm && this.#meta.handle !== null;
    const state: ComputerState = resumable ? 'warm' : 'cold';
    this.#meta.state = state;
    if (!resumable) {
      // A handle recorded by a materialize that then failed (the readiness probe
      // timed out, the platform call exceeded its budget) names a resource that
      // may well exist. Destroy it best-effort before dropping it: an instance
      // this object forgets is an orphan holding the computer's slot, and on
      // Cloudflare that slot is the only one there is.
      await this.#tearDownInstance('failed wake');
      // A supervisor that somehow booted from the failed materialize is an
      // orphan this DO cannot manage: without the token it cannot handshake, so
      // it can neither write the journal nor advance the head (spec 4.1).
      this.#meta.token = null;
    }
    this.#meta.generationAt = null;
    this.#meta.supervisorSeen = false;
    this.#setDeadline('waking', null);
    this.#setDeadline('liveness', null);
    this.#closeAwakeStretch();
    this.#meta.wakeFailures += 1;
    this.#meta.wakeRetryAt = null;

    // A run queued behind this wake must not sit there because the substrate
    // hiccuped once (spec 5.1: a run is never lost). Retry on the alarm, with a
    // bounded backoff — long enough to outlast Cloudflare's measured
    // destroy→start refusal (see WAKE_RETRY_MS), bounded so a substrate that is
    // genuinely out of capacity is not hammered forever.
    const attempt = this.#meta.wakeFailures - 1;
    if (attempt < WAKE_RETRY_MS.length && this.#pendingWork() > 0) {
      this.#meta.wakeRetryAt = Date.now() + (WAKE_RETRY_MS[attempt] as number);
    }
    if (state === 'warm') {
      // Back to WARM with its deadline restored: the tier policy (spec 4.4) must
      // still be able to take this computer COLD, even though the alarm that was
      // pending may have fired (to no effect) while the state read WAKING.
      this.#setDeadline('tier', Date.now() + this.#coldIdleMs());
      this.#meta.armedIdleSince = this.#meta.idleSince;
    }
    await this.#armAlarm();

    await this.#persist();
    await this.#syncFleetState();
    this.#emit({ type: 'state', state });
  }

  /** True while at least one run is waiting for a supervisor. */
  #hasQueuedRuns(): boolean {
    const row = [
      ...this.ctx.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs WHERE dispatched = 0 AND status = 'queued'`,
      ),
    ][0];
    return Number(row?.n ?? 0) > 0;
  }

  /** Runs that still need a live computer: queued, handed over, running, or being
   *  stopped. This is what "there is something at stake here" means — it decides
   *  whether the DO keeps a liveness deadline armed and whether a failed or lost
   *  wake is retried. */
  #pendingWork(): number {
    const row = [
      ...this.ctx.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM runs WHERE status IN ('queued','dispatched','running','stopping')`,
      ),
    ][0];
    return Number(row?.n ?? 0);
  }

  // ---------------------------------------------------------------------------
  // Liveness and recovery
  //
  // THE BUG CLASS THIS SECTION EXISTS FOR: a state that cannot advance without an
  // external event. A substrate evicts an instance — routine on Cloudflare, one
  // `docker rm -f` locally — and tells nobody. Everything Mari needs in order to
  // come back already existed (snapshot, epoch fencing, restore, adapter resume);
  // what did not exist was the TRIGGER. So: the supervisor's socket closing arms a
  // grace deadline, a computer with work in flight is health-checked on a cadence,
  // and a computer whose instance the substrate says is gone is recovered — COLD
  // at its last manifest head (its truth is the chunk store, spec 4.1), one
  // content-free state event, in-flight runs degraded honestly (spec 5.6), and a
  // fresh instance under a NEW epoch when there is work to do.
  // ---------------------------------------------------------------------------

  /** True when a socket that completed `hello` for the CURRENT epoch is attached.
   *  The cheapest and strongest proof that a computer is really AWAKE. */
  #liveSupervisor(): boolean {
    return this.#supervisor !== null && this.#isCurrentSupervisor(this.#supervisor);
  }

  #supervisorGraceMs(): number {
    return numberVar(this.env.SUPERVISOR_GRACE_MS) ?? DEFAULT_SUPERVISOR_GRACE_MS;
  }

  #livenessMs(): number {
    return numberVar(this.env.LIVENESS_MS) ?? DEFAULT_LIVENESS_MS;
  }

  #coldFinalizeMs(): number {
    return numberVar(this.env.COLD_FINALIZE_MS) ?? DEFAULT_COLD_FINALIZE_MS;
  }

  #wakeTimeoutMs(): number {
    return numberVar(this.env.WAKE_TIMEOUT_MS) ?? DEFAULT_WAKE_TIMEOUT_MS;
  }

  /** Race `promise` against a budget. The loser is never awaited again, and its
   *  rejection is swallowed so a hung platform call cannot surface later as an
   *  unhandled rejection crossing the DO boundary. */
  async #bounded<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`substrate ${what} exceeded ${ms} ms`)), ms);
    });
    try {
      promise.catch(() => undefined);
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  /**
   * Ask the substrate whether this computer's instance still exists.
   *
   * A driver that declares provider.ts's liveness capability answers precisely
   * (Docker: `inspect`, where a removed container is a 404; Cloudflare: `running`
   * plus the platform's own refusal). A driver that does not is probed through
   * spec 3.5's `exec` — the cheapest command that proves a process can run there.
   * A refusal from that probe cannot be classified without the driver's help, so
   * it is `unknown`, never `gone`: the caller bounds how many `unknown`s it will
   * take (LIVENESS_STRIKES_MAX) instead of guessing that a user's computer was
   * destroyed.
   */
  async #probeInstance(): Promise<InstanceStatus> {
    const handle = this.#meta.handle;
    if (!handle) return 'gone';
    this.#probeCount++;
    const budget = Math.max(1_000, Math.min(this.#wakeTimeoutMs(), 15_000));
    const declared = this.substrate.instanceStatus;
    try {
      if (declared) {
        return await this.#bounded(declared.call(this.substrate, handle), budget, 'instanceStatus');
      }
      await this.#bounded(
        this.substrate.exec(handle, LIVENESS_PROBE_ARGV, { cwd: '/' }),
        budget,
        'liveness exec',
      );
      // Any answer at all — including a non-zero exit — means a process ran.
      return 'alive';
    } catch (err) {
      console.warn(
        `mari: liveness probe inconclusive computer=${this.#meta.computerId ?? '?'} ` +
          `epoch=${this.#meta.epoch}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return 'unknown';
    }
  }

  /** Destroy the recorded instance, best effort, and forget it. A destroy that
   *  fails must not wedge the computer: the resource is unusable to Mari either
   *  way (its supervisor is fenced out by the next epoch, spec 4.1), so the
   *  failure is RECORDED and the transition continues. */
  async #tearDownInstance(context: string): Promise<void> {
    const handle = this.#meta.handle;
    if (!handle) return;
    try {
      await this.#bounded(this.substrate.destroy(handle), this.#wakeTimeoutMs(), 'destroy');
    } catch (err) {
      this.#recordIncident('destroy_failed');
      console.warn(
        `mari: destroy failed computer=${this.#meta.computerId ?? '?'} handle=${handle.id} ` +
          `context=${context}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    this.#meta.handle = null;
  }

  /**
   * The computer's instance is gone (or unusable). Land the computer where it
   * truthfully is and get the work moving again.
   *
   * WHAT RECOVERY IS: the chunk store is the home of the computer (spec §2), so a
   * computer whose substrate resources have vanished is COLD **at its last
   * manifest head** — the head is not touched, and nothing is invented. The
   * resources are destroyed best-effort, the fencing token is dropped, one
   * content-free `state` event goes out (spec 6.2/6.3), in-flight runs take the
   * defined degradation (see `#degradeInFlightRuns`), and if there is work to do
   * the computer is woken again — which materializes a FRESH instance and mints a
   * NEW epoch, so the dead generation can never advance the head even if it turns
   * out to be alive somewhere (spec 4.1, contracts.md §6).
   */
  async #recover(
    reason: IncidentKind,
    options: { rewake?: boolean } = {},
  ): Promise<void> {
    const inFlight = this.#recoveryInFlight;
    if (inFlight) return inFlight;
    const p = this.#recoverInner(reason, options.rewake ?? true);
    this.#recoveryInFlight = p;
    try {
      await p;
    } finally {
      this.#recoveryInFlight = null;
    }
  }

  async #recoverInner(reason: IncidentKind, rewake: boolean): Promise<void> {
    const computer = this.#meta.computerId ?? 'unknown';
    const deadEpoch = this.#meta.epoch;
    const hadWork = this.#pendingWork() > 0;
    this.#recordIncident(reason);
    console.warn(
      `mari: recovering computer=${computer} epoch=${deadEpoch} reason=${reason} ` +
        `state=${this.#meta.state} pendingWork=${hadWork}`,
    );

    await this.#tearDownInstance(`recover:${reason}`);
    this.#meta.token = null;
    this.#meta.state = 'cold';
    this.#meta.coldPending = false;
    this.#meta.generationAt = null;
    this.#meta.supervisorSeen = false;
    this.#meta.supervisorLostAt = null;
    this.#meta.livenessStrikes = 0;
    this.#meta.recoveryStreak += 1;
    this.#closeAwakeStretch();
    this.#setDeadline('liveness', null);
    this.#setDeadline('cold', null);
    this.#setDeadline('waking', null);
    this.#setDeadline('tier', null);
    // The dead generation's socket, if it is somehow still open, is finished here:
    // it cannot authenticate again (the token is gone) and it must not be handed
    // work by `#dispatchQueued`.
    this.#dropSupervisorSockets('substrate lost');
    await this.#persist();
    await this.#syncFleetState();
    // Content-free, and the UI's whole notification of this (spec 6.2/6.3): the
    // computer is COLD now, at the head the fleet view already renders from.
    this.#emit({ type: 'state', state: 'cold' });

    // Runs never silently disappear (spec 5.1).
    this.#degradeInFlightRuns();
    await this.#persist();

    if (!rewake) return;
    if (this.#meta.recoveryStreak > RECOVERY_STREAK_MAX) {
      // Recovering again would materialize an instance that has failed to produce
      // a supervisor RECOVERY_STREAK_MAX times running (a broken image, a
      // substrate refusing to run it). Stop spending money on it: the computer is
      // COLD, its work is still queued (spec 5.1), and the incident log says why.
      this.#recordIncident('recovery_exhausted');
      console.warn(
        `mari: recovery budget spent computer=${computer} streak=${this.#meta.recoveryStreak}; ` +
          `leaving it COLD with ${this.#pendingWork()} run(s) queued`,
      );
      await this.#persist();
      await this.#armAlarm();
      return;
    }
    if (hadWork || this.#hasQueuedRuns()) {
      // Work was in flight or is waiting: bring the computer up again on a fresh
      // instance. A run that a resume can continue needs the computer for that
      // (spec 5.6), and a queued run has never run at all.
      this.#wakeInBackground();
      return;
    }
    await this.#armAlarm();
  }

  /**
   * Runs that were in flight when the computer's instance died (spec 5.6's
   * degradation, applied by the control plane because the supervisor that owned
   * them no longer exists).
   *
   * Two cases, and the line between them is whether the run PROVABLY never began:
   *
   *  - **No start, no journal byte, no pre-run manifest** — it was handed to a
   *    supervisor that died before acking it, so it never ran. It is RE-QUEUED and
   *    the dispatch latch released: starting it now is indistinguishable from
   *    starting it the first time, which is exactly the rule marid uses for a
   *    replay after a rollback (decisions.md appendix, "safe to replay"). Without
   *    this the run is lost forever — `dispatched = 1` and no supervisor will ever
   *    be handed it again.
   *  - **It ran** — the journal is left EXACTLY as it is (spec 4.2: the journal in
   *    the control plane is the truth) and the run is marked `interrupted`, with
   *    one content-free attention event so the user is told (spec 6.2). No
   *    completion is fabricated: the run did not complete. If a wake follows and
   *    the run's agent adapter declares a resume, marid continues it under the
   *    same run id and `run_started` puts it back to `running`.
   */
  #degradeInFlightRuns(): void {
    const rows = [
      ...this.ctx.storage.sql.exec<SqlRow>(
        `SELECT id, startedAt, preManifest, requeues FROM runs WHERE status IN ('dispatched','running','stopping')`,
      ),
    ];
    const now = Date.now();
    for (const row of rows) {
      const id = String(row['id']);
      const ran =
        row['startedAt'] != null ||
        row['preManifest'] != null ||
        this.#runHead(id).nextOffset > 0 ||
        // Bytes still in the coalescing buffer count: they are output this run
        // produced, they are simply younger than one flush window (FLUSH_MS).
        (this.#pending.get(id)?.len ?? 0) > 0;
      // A run that never began is re-queued — ONCE. A run whose machine dies every
      // time it is handed over is not a run that keeps deserving a fresh machine:
      // it may well be what killed it (the e2e that tears a microVM down does it
      // from inside a run), and re-queueing forever would materialize instances
      // until the recovery budget ran out. One retry, then the same honest
      // degradation an interrupted run gets.
      const retriable = Number(row['requeues'] ?? 0) < MAX_RUN_REQUEUES;
      if (!ran && retriable) {
        this.ctx.storage.sql.exec(
          `UPDATE runs SET status = 'queued', dispatched = 0, dispatchedAt = NULL, epoch = 0,
             requeues = requeues + 1
            WHERE id = ? AND status IN ('dispatched','running','stopping')`,
          id,
        );
        this.#emit({ type: 'run', runId: id, state: 'pending' });
        continue;
      }
      this.ctx.storage.sql.exec(
        `UPDATE runs SET status = 'interrupted', endedAt = COALESCE(endedAt, ?) WHERE id = ?`,
        now,
        id,
      );
      this.#raiseInterrupted(id);
      this.#emit({ type: 'run', runId: id, state: 'failed' });
    }
  }

  /** One content-free attention event for an interrupted run, at most one badge
   *  at a time. marid raises the same event when it restarts and finds the run
   *  unfinished (decisions.md appendix); the user must not get two notifications
   *  for one interruption, and `#onAttention` applies the same rule from the other
   *  direction. */
  #raiseInterrupted(run: string): void {
    if (this.#hasUndismissedInterrupted(run)) return;
    this.#onAttention(run, 'interrupted');
  }

  #hasUndismissedInterrupted(run: string): boolean {
    const row = [
      ...this.ctx.storage.sql.exec<{ n: number }>(
        `SELECT COUNT(*) AS n FROM attention WHERE run = ? AND kind = 'interrupted' AND dismissed = 0`,
        run,
      ),
    ][0];
    return Number(row?.n ?? 0) > 0;
  }

  /** Close every supervisor socket and forget the generation's authentication. */
  #dropSupervisorSockets(why: string): void {
    for (const socket of [...this.#authEpoch.keys()]) {
      try {
        socket.close(1001, why);
      } catch {
        // Already closed; the map entry below is what matters.
      }
    }
    this.#authEpoch.clear();
    if (this.#supervisor) {
      try {
        this.#supervisor.close(1001, why);
      } catch {
        // Already closed.
      }
    }
    this.#supervisor = null;
  }

  /** Record a content-free incident (see {@link IncidentKind}). */
  #recordIncident(kind: IncidentKind): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO incident (kind, at, epoch) VALUES (?, ?, ?)`,
      kind,
      Date.now(),
      this.#meta.epoch,
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM incident WHERE id NOT IN (SELECT id FROM incident ORDER BY id DESC LIMIT ?)`,
      INCIDENT_KEEP,
    );
  }

  /** Recorded incidents, newest first (ops, the detail view, and tests). */
  async listIncidents(limit = 50): Promise<Incident[]> {
    const rows = [
      ...this.ctx.storage.sql.exec<{ id: number; kind: string; at: number; epoch: number }>(
        `SELECT id, kind, at, epoch FROM incident ORDER BY id DESC LIMIT ?`,
        Math.max(1, Math.min(INCIDENT_KEEP, Math.trunc(limit))),
      ),
    ];
    return rows.map((r) => ({
      id: Number(r.id),
      kind: String(r.kind) as IncidentKind,
      at: Number(r.at),
      epoch: Number(r.epoch),
    }));
  }

  // ---- deadline slots (one alarm, several policies) ----

  #deadlineAt(name: DeadlineName): number | null {
    switch (name) {
      case 'wakeRetry':
        return this.#meta.wakeRetryAt;
      case 'waking':
        return this.#meta.wakingAt;
      case 'liveness':
        return this.#meta.livenessAt;
      case 'cold':
        return this.#meta.coldAt;
      case 'tier':
        return this.#meta.tierAt;
    }
  }

  #setDeadline(name: DeadlineName, at: number | null): void {
    switch (name) {
      case 'wakeRetry':
        this.#meta.wakeRetryAt = at;
        return;
      case 'waking':
        this.#meta.wakingAt = at;
        return;
      case 'liveness':
        this.#meta.livenessAt = at;
        return;
      case 'cold':
        this.#meta.coldAt = at;
        return;
      case 'tier':
        this.#meta.tierAt = at;
        return;
    }
  }

  /** How long to wait before re-running a deadline whose handler threw. */
  #retryWindowFor(name: DeadlineName): number {
    switch (name) {
      case 'liveness':
        return this.#livenessMs();
      case 'cold':
        return this.#coldFinalizeMs();
      case 'waking':
        return this.#wakeTimeoutMs();
      case 'wakeRetry':
        return WAKE_RETRY_MS[0] as number;
      case 'tier':
        return this.#warmIdleMs();
    }
  }

  /** Point the ONE alarm at the earliest pending deadline (or clear it). */
  async #armAlarm(): Promise<void> {
    let earliest: number | null = null;
    for (const name of DEADLINES) {
      const at = this.#deadlineAt(name);
      if (at !== null && (earliest === null || at < earliest)) earliest = at;
    }
    if (earliest === null) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    await this.ctx.storage.setAlarm(earliest);
  }

  /** Arm the recurring liveness check, but only when something is at stake: work
   *  in flight, or a supervisor that has gone. An idle AWAKE computer with a
   *  healthy supervisor needs no probe — the tier deadline collects it. */
  #armLiveness(): void {
    if (this.#meta.state !== 'awake') {
      this.#setDeadline('liveness', null);
      return;
    }
    const atStake = this.#meta.supervisorLostAt !== null || this.#pendingWork() > 0;
    if (!atStake) {
      this.#setDeadline('liveness', null);
      return;
    }
    const window =
      this.#meta.supervisorLostAt !== null ? this.#supervisorGraceMs() : this.#livenessMs();
    const at = Date.now() + window;
    const current = this.#deadlineAt('liveness');
    // Keep the earliest pending check rather than pushing it out on every event.
    if (current !== null && current <= at) return;
    this.#setDeadline('liveness', at);
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
  async #maridEnv(computer: string, token: string): Promise<Record<string, string>> {
    const env: Record<string, string> = {};

    // ---- the credential vault (spec 10.1) --------------------------------
    //
    // "Agent credentials stay in the control plane vault. The supervisor injects
    // credentials at run start." The injection point is marid: `start_run`
    // carries `env_names` and marid resolves each name out of its OWN process
    // environment (crates/marid/src/run.rs), which is exactly what keeps VALUES
    // off the wire message (contracts.md §5.2). So the values have to arrive
    // here, in the supervisor's process configuration, and nowhere else.
    //
    // Written FIRST so no vault entry can shadow a MARI_* variable: a computer
    // whose vault held `MARI_TOKEN` or `MARI_EPOCH` would otherwise fence itself
    // out (or hand its own token to a run). The vault is per computer, so this is
    // also the ownership boundary — a computer never sees another's credentials.
    if (this.#meta.computerId) {
      try {
        for (const s of await listSecrets(this.env.DB, this.#meta.computerId)) {
          if (s.name.startsWith('MARI_')) continue;
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(s.name)) continue;
          env[s.name] = s.value;
        }
      } catch (err) {
        // A vault read that fails must not block the wake; the run then fails on
        // a missing variable, which the agent reports, rather than the computer
        // never coming up at all.
        console.warn(
          `mari: vault read failed computer=${computer}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    env.MARI_COMPUTER_ID = computer;
    env.MARI_EPOCH = String(this.#meta.epoch);
    env.MARI_TOKEN = token;
    env.MARI_ROOT = this.env.COMPUTER_ROOT ?? DEFAULT_COMPUTER_ROOT;
    env.MARI_STORE = this.env.STORE_URI ?? DEFAULT_STORE_URI;
    const base = this.env.SUPERVISOR_URL_BASE;
    if (base) {
      env.MARI_CONTROL_URL = `${base.replace(/\/+$/, '')}/supervisor/${encodeURIComponent(computer)}`;
    }
    const restore = this.#meta.head ?? this.env.BASE_MANIFEST ?? null;
    if (restore) env.MARI_RESTORE_MANIFEST = restore;
    return env;
  }

  /** AWAKE -> WARM now (used by the tier alarm and by the epoch-fencing flow to
   *  simulate a supervisor generation change).
   *
   *  A sleep that the substrate refuses does NOT record WARM: the resources are
   *  not in the state that claim describes, and the next wake would resume
   *  something that is not there. WARM also gets its WARM->COLD deadline armed
   *  here — a computer parked in WARM by anything other than the tier alarm used
   *  to have no deadline at all, and a state with no deadline is a wedge. */
  async sleepNow(): Promise<ComputerState> {
    if (this.#meta.state === 'awake' && this.#meta.handle) {
      try {
        await this.#bounded(this.substrate.sleep(this.#meta.handle), this.#wakeTimeoutMs(), 'sleep');
      } catch (err) {
        console.warn(
          `mari: sleep refused computer=${this.#meta.computerId ?? '?'}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        const status = await this.#probeInstance();
        if (status === 'gone') await this.#recover('substrate_lost');
        return this.#meta.state;
      }
      this.#meta.state = 'warm';
      this.#closeAwakeStretch();
      this.#setDeadline('liveness', null);
      this.#meta.supervisorLostAt = null;
      this.#meta.armedIdleSince = this.#meta.idleSince;
      this.#setDeadline('tier', Date.now() + this.#coldIdleMs());
      await this.#armAlarm();
      await this.#persist();
      await this.#syncFleetState();
      this.#emit({ type: 'state', state: 'warm' });
    }
    return this.#meta.state;
  }

  /**
   * Deep sleep NOW on a user command: AWAKE/WARM -> COLD through the same clean
   * path the tier alarm uses (spec 4.4 names COLD "deep sleep", spec 4.5 requires
   * the clean stop + final manifest). A COLD computer costs only its delta in
   * object storage, so this is the one action that actually stops a computer
   * costing anything — waiting out the idle timer keeps paying for resources the
   * user has already finished with.
   *
   * Returns the state it reached: `cold` when the transition completed inline,
   * `awake`/`warm` while the supervisor's final-snapshot handshake is still in
   * flight (it has its own deadline, see `#onColdDeadline`).
   */
  async deepSleepNow(): Promise<ComputerState> {
    if (this.#meta.state === 'cold') return 'cold';
    await this.#beginCold();
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
      // NEVER the container's `/`: a run's working directory must be inside the
      // computer's own filesystem, the only tree that is snapshotted (spec 2,
      // 4.1). `resolveRunCwd` maps an unset or computer-space path onto
      // `MARI_ROOT` and leaves an already-rooted one alone.
      resolveRunCwd(this.#computerRoot(), input.cwd),
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
    if (dispatched === 0) {
      this.#wakeInBackground();
    } else {
      // Work is in flight now, so the computer is health-checked until it is done:
      // a supervisor that took the run and then died with its machine must not
      // leave the run pending forever (spec 5.1).
      this.#armLiveness();
      await this.#armAlarm();
      await this.#persist();
    }

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
      // The run id is the staging-file token, so two writes racing on one path
      // cannot clobber each other's temp file (runs.ts).
      argv: writeRunArgv(target, input.contentBase64, input.runId),
      cwd: DEFAULT_CWD,
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
    if (status === 'completed' || status === 'cancelled' || status === 'interrupted') {
      // Terminal: there is no process left to stop. An interrupted run's journal
      // and attention event stay exactly as they are (spec 5.6).
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
    if (
      row.status !== 'completed' &&
      row.status !== 'cancelled' &&
      // An interrupted run is over (its supervisor and its machine are gone), and
      // its half-finished changes are exactly what a user wants to revert.
      row.status !== 'interrupted'
    ) {
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
      // The same resolution `#dispatchQueued` sends, so what a client is shown is
      // what the supervisor was told.
      cwd: resolveRunCwd(this.#computerRoot(), row['cwd'] == null ? '' : String(row['cwd'])),
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
            // Resolved again on the way out so a row written before the root was
            // configured (or with a NULL cwd) still names a directory inside the
            // computer. marid's own empty-cwd fallback covers a RESUMED run only
            // (crates/marid/src/run.rs), so an empty string must never go out.
            cwd: resolveRunCwd(this.#computerRoot(), row['cwd'] == null ? '' : String(row['cwd'])),
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
    // The substrate refused (capacity, image, daemon). The computer has been
    // rolled back out of WAKING; tell the requester plainly rather than leaving
    // a preview request hanging behind a spinner that never resolves (spec 8.3).
    if (!woken.ok) return new Response('wake failed', { status: 503 });
    if (!this.#meta.handle) return new Response('no substrate handle', { status: 502 });

    const headers = new Headers(request.headers);
    headers.delete('x-mari-proxy-port');
    headers.delete('x-mari-computer');
    headers.set('x-mari-epoch', String(woken.epoch));

    // A substrate whose exposed port has NO fetchable address — Cloudflare
    // Containers, where the port lives behind `ctx.container.getTcpPort(port)` on
    // this very Durable Object — serves the request itself (provider.ts
    // `proxyFetch`). It must be called from HERE, the DO's own `fetch`: a
    // WebSocket cannot be serialized across the Worker→DO RPC boundary, so a stub
    // call could never carry a preview app's socket. This also keeps the control
    // plane a mandatory hop, which an edge tunnel to the container would not.
    // EVERY failure below is reported, and reported as itself. A port that was
    // never published, a port with nothing listening, and a driver that refused
    // are three different things the user can act on; all three used to surface
    // as an empty HTTP 500 with no log line, which is indistinguishable from a
    // bug in the control plane.
    const proxyFetch = this.substrate.proxyFetch;
    if (proxyFetch) {
      const forwarded = new Request(request, { headers });
      try {
        return await proxyFetch.call(this.substrate, this.#meta.handle, port, forwarded);
      } catch (err) {
        return this.#proxyFailed('proxy_fetch', port, err);
      }
    }

    let exposedUrl: string;
    try {
      exposedUrl = await this.substrate.exposePort(this.#meta.handle, port);
    } catch (err) {
      // The Docker driver's message is actionable ("include it in
      // MaterializeSpec.ports"), so it is carried through rather than swallowed.
      return this.#proxyFailed('expose_port', port, err);
    }
    const target = exposedUrl.replace(/\/$/, '') + url.pathname + url.search;
    const init: RequestInit = { method: request.method, headers };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      init.body = await request.arrayBuffer();
    }
    try {
      return await this.upstreamFetch(target, init);
    } catch (err) {
      // Nothing is listening on the port, or it closed the connection. This is
      // the single most common preview failure and the user has to be able to
      // tell it from a Mari fault.
      return this.#proxyFailed('upstream_unreachable', port, err);
    }
  }

  /** One shape for every preview-proxy failure: a 502 (the upstream is the thing
   *  that failed, not this hop), a stable machine-readable reason header, the
   *  substrate's own message, and exactly one log line. */
  #proxyFailed(reason: string, port: number, err: unknown): Response {
    const detail = err instanceof Error ? err.message : String(err);
    console.warn(
      `mari: preview proxy ${reason} computer=${this.#meta.computerId ?? '?'} port=${port}: ${detail}`,
    );
    return new Response(`preview ${reason} on port ${port}: ${detail}\n`, {
      status: 502,
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'x-mari-preview-error': reason,
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Supervisor WebSocket (framed CBOR, contracts.md §2)
  // ---------------------------------------------------------------------------

  #acceptSupervisor(): Response {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // MANDATORY, and load-bearing for the Cloudflare substrate: from
    // compatibility_date 2026-04-01 the runtime delivers binary WebSocket
    // messages as a `Blob` instead of an `ArrayBuffer`. `toBytes` has no Blob
    // branch (a Blob cannot be read synchronously at all), so every framed-CBOR
    // supervisor message would decode to ZERO bytes — no exception, no log, the
    // channel just goes mute. Measured by bisection against real workerd:
    // 2026-03-01 ArrayBuffer, 2026-04-01 Blob. The container work requires the
    // date bump (`containers_pid_namespace`), so pin the wire type here.
    server.binaryType = 'arraybuffer';
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
      const wasCurrent = this.#authEpoch.get(server) === this.#meta.epoch;
      this.#authEpoch.delete(server);
      if (this.#supervisor === server) this.#supervisor = null;
      // THE FIRST SIGNAL that a computer's supervisor is gone — and deliberately
      // not treated as proof: a network blip is not a dead container, and marid
      // reconnects with the same epoch and token. So this only schedules the
      // grace deadline; `#onLivenessDeadline` is what asks the substrate.
      if (wasCurrent && !this.#liveSupervisor() && this.#meta.state === 'awake') {
        this.ctx.waitUntil(this.#onSupervisorLost());
      }
    });
    return new Response(null, { status: 101, webSocket: client });
  }

  /** The current generation's supervisor socket closed while the computer is
   *  AWAKE. Arm the grace window; nothing else changes yet. */
  async #onSupervisorLost(): Promise<void> {
    if (this.#meta.state !== 'awake') return;
    if (this.#liveSupervisor()) return;
    this.#meta.supervisorLostAt = Date.now();
    this.#setDeadline('liveness', Date.now() + this.#supervisorGraceMs());
    await this.#armAlarm();
    await this.#persist();
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

    // The supervisor said something on an authenticated socket. This is the
    // liveness signal that keeps a healthy computer from ever being probed: a
    // journal frame or a heartbeat (every 5 s during a run) is proof that the
    // machine and its supervisor are both there. In memory only — see the field.
    this.#lastSupervisorAt = Date.now();
    this.#meta.livenessStrikes = 0;

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
        // Spec 5.4's run hold. `#touch` renews the DO's own tier alarm, which is
        // the authoritative hold for EVERY substrate — and on Cloudflare it is the
        // only one that works: there is no renewable `sleepAfter` on the raw
        // container API, `setInactivityTimeout` is undocumented and measured not
        // to fire, and an open outbound WebSocket (the journal!) is invisible to
        // any platform activity timer by construction. A driver with an idle timer
        // of its own also gets it renewed, best-effort: never `keepAlive`, and
        // never allowed to fail a run.
        await this.#touch();
        await this.#persist();
        if (this.#meta.handle && this.substrate.holdAwake) {
          try {
            await this.substrate.holdAwake(this.#meta.handle);
          } catch (err) {
            console.warn(
              `mari: holdAwake failed computer=${this.#meta.computerId ?? '?'}: ` +
                `${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
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
    // A supervisor of the current generation is here: this computer is genuinely
    // AWAKE, the grace window is closed, and the recovery budget is restored
    // (a recovery that produced a working generation is not part of a loop).
    this.#lastSupervisorAt = Date.now();
    this.#meta.supervisorSeen = true;
    this.#meta.supervisorLostAt = null;
    this.#meta.livenessStrikes = 0;
    this.#meta.recoveryStreak = 0;
    this.#meta.wakeFailures = 0;
    if (this.#meta.generationAt === null) this.#meta.generationAt = Date.now();
    this.#armLiveness();
    await this.#armAlarm();
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

  /**
   * Ingest one `journal_frame` AT THE OFFSET IT CLAIMS (contracts.md §5.1).
   *
   * The journal in the control plane is the truth (spec 4.2), so a frame the
   * supervisor re-sends must not be able to write the same bytes twice. A replay
   * needs no supervisor bug to occur:
   *
   *  - `hello_ack` reports the DURABLE head (`journal_head`), which excludes
   *    whatever is still sitting in this coalescing buffer, and marid resumes
   *    from exactly that offset (`crates/marid/src/supervisor.rs`, `HelloAck`
   *    resets its per-connection `sent` mark);
   *  - a reconnecting supervisor of the SAME wake generation re-authenticates on
   *    a second socket (the fencing token stays valid until COLD), so the epoch
   *    ingest gate does not close on the first one — frames still in flight from
   *    it arrive AFTER the new socket has resumed.
   *
   * Blind appending then writes those bytes twice, shifts every later offset,
   * and — because the next `journal_ack` would name an offset above what the
   * supervisor actually sent — makes the supervisor SKIP real output on its next
   * resume. Duplication now, silent loss later, in what spec 4.2 calls truth.
   */
  #onJournalFrame(run: string, offset: number, bytes: Uint8Array): void {
    if (bytes.length === 0) return;
    const pending = this.#pendingFor(run);
    const next = pending.start + pending.len; // the offset we expect next
    let slice = bytes;

    if (offset < next) {
      // REPLAY: this range is already held (durable or buffered). Compare before
      // discarding — identical bytes are a benign re-send, but DIFFERENT bytes
      // at the same offset mean two writers disagree about the truth (spec 4.1
      // single-writer), which is an integrity signal, not a no-op.
      const overlap = Math.min(bytes.length, next - offset);
      const held = this.#journalHeld(run, offset, offset + overlap, pending);
      const diverged = held !== null && !bytesEqual(held, bytes.subarray(0, overlap));
      this.#recordJournalAnomaly(run, diverged ? 'divergent' : 'duplicate', offset, overlap);
      // What is durable wins; only the part beyond our head is new.
      if (overlap >= bytes.length) return;
      slice = bytes.subarray(overlap);
    } else if (offset > next) {
      // GAP: the bytes below this frame never reached us — a resumed run whose
      // earlier life this control plane never saw (spec 5.6), or a buffer lost
      // with the DO. They cannot be invented, and dropping the frame would stall
      // the run's journal forever (the supervisor only ever streams forward), so
      // the bytes are taken at the head we do have and the hole is RECORDED.
      this.#recordJournalAnomaly(run, 'gap', next, offset - next);
    }

    pending.parts.push(slice);
    pending.len += slice.length;
    this.#scheduleFlush();
  }

  /** The open coalescing buffer for `run`, anchored at the durable head. */
  #pendingFor(run: string): PendingJournal {
    let p = this.#pending.get(run);
    if (!p) {
      p = { start: this.#runHead(run).nextOffset, len: 0, parts: [] };
      this.#pending.set(run, p);
    }
    return p;
  }

  /** The bytes this DO already holds for `[from, to)` — durable segments plus
   *  the coalescing buffer — or `null` if the range is not fully covered (then
   *  no divergence claim can honestly be made). */
  #journalHeld(
    run: string,
    from: number,
    to: number,
    pending: PendingJournal,
  ): Uint8Array | null {
    if (to <= from) return new Uint8Array(0);
    const out = new Uint8Array(to - from);
    const covered = new Uint8Array(to - from);
    const put = (start: number, src: Uint8Array): void => {
      const lo = Math.max(from, start);
      const hi = Math.min(to, start + src.length);
      if (hi <= lo) return;
      out.set(src.subarray(lo - start, hi - start), lo - from);
      covered.fill(1, lo - from, hi - from);
    };
    for (const row of this.ctx.storage.sql.exec<{ startOffset: number; bytes: ArrayBuffer }>(
      `SELECT startOffset, bytes FROM journal
        WHERE run = ? AND startOffset < ? AND startOffset + length(bytes) > ?
        ORDER BY seq`,
      run,
      to,
      from,
    )) {
      put(Number(row.startOffset), new Uint8Array(row.bytes));
    }
    let cursor = pending.start;
    for (const part of pending.parts) {
      put(cursor, part);
      cursor += part.length;
    }
    for (const c of covered) if (c === 0) return null;
    return out;
  }

  /** Record an ingest anomaly (metadata only — a journal byte must never reach
   *  a log or this table, spec 6.3). */
  #recordJournalAnomaly(
    run: string,
    kind: JournalAnomalyKind,
    atOffset: number,
    len: number,
  ): void {
    this.ctx.storage.sql.exec(
      `INSERT INTO journal_anomaly (run, kind, atOffset, len, at) VALUES (?, ?, ?, ?, ?)`,
      run,
      kind,
      atOffset,
      len,
      Date.now(),
    );
    this.ctx.storage.sql.exec(
      `DELETE FROM journal_anomaly
        WHERE id NOT IN (SELECT id FROM journal_anomaly ORDER BY id DESC LIMIT ?)`,
      JOURNAL_ANOMALY_KEEP,
    );
    if (kind === 'divergent') {
      // Two writers claim different bytes at one offset: surface it. A duplicate
      // or a gap is recorded but not shouted about — both are normal outcomes of
      // a resume, this is not.
      console.warn(
        `mari: journal divergence computer=${this.#meta.computerId ?? 'unknown'} run=${run} offset=${atOffset} len=${len}`,
      );
    }
  }

  /** Recorded journal ingest anomalies, newest first (ops + tests). */
  async journalAnomalies(run?: string): Promise<JournalAnomaly[]> {
    // The row shape is what SQLite hands back (`kind` is a bare string there);
    // the narrowing to `JournalAnomalyKind` happens in the mapping below.
    type AnomalyRow = {
      id: number;
      run: string;
      kind: string;
      atOffset: number;
      len: number;
      at: number;
    };
    const rows = run
      ? [
          ...this.ctx.storage.sql.exec<AnomalyRow>(
            `SELECT id, run, kind, atOffset, len, at FROM journal_anomaly WHERE run = ? ORDER BY id DESC`,
            run,
          ),
        ]
      : [
          ...this.ctx.storage.sql.exec<AnomalyRow>(
            `SELECT id, run, kind, atOffset, len, at FROM journal_anomaly ORDER BY id DESC`,
          ),
        ];
    return rows.map((r) => ({
      id: Number(r.id),
      run: String(r.run),
      kind: String(r.kind) as JournalAnomalyKind,
      atOffset: Number(r.atOffset),
      len: Number(r.len),
      at: Number(r.at),
    }));
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
    for (const run of runs) {
      try {
        this.#flushRun(run);
      } catch (err) {
        // A flush that cannot write must not take the runtime down with it. The
        // case that actually happens is shutdown: this timer is scheduled 100 ms
        // out, and a private instance whose storage has already been closed
        // answers "statement has been finalized". The bytes are not lost — marid
        // re-sends from the offset the last `journal_ack` named (contracts.md
        // §5.2) — but the operator has to know the tail did not land, and the
        // offsets are all that is said about it (spec 6.3: never content).
        console.warn(
          `mari: journal flush failed computer=${this.#meta.computerId ?? '?'} run=${run}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    // Persisting head counters is done inside #flushRun via SQL; nothing else.
    void runs;
  }

  #flushRun(run: string): void {
    const pending = this.#pending.get(run);
    this.#pending.delete(run);
    if (!pending || pending.len === 0) return;

    const seg = new Uint8Array(pending.len);
    let cursor = 0;
    for (const p of pending.parts) {
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
    // ONE badge per interruption. marid raises `attention{interrupted}` when it
    // restarts and finds a run it cannot continue (decisions.md appendix), and the
    // control plane raises the same event when it recovers a computer whose
    // substrate died under that run — the same interruption seen from both sides.
    // A user must be told once, not twice; once the badge is dismissed, a NEW
    // interruption raises a new one.
    if (kind === 'interrupted' && this.#hasUndismissedInterrupted(run)) return;
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
      await this.#finalizeCold(manifest);
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
    // See #acceptSupervisor: past compatibility_date 2026-04-01 binary frames
    // arrive as Blobs and `toBytes` would silently yield nothing.
    server.binaryType = 'arraybuffer';
    this.#clients.set(server, new Set());

    server.addEventListener('message', (event: MessageEvent) => {
      let msg: ClientToDo;
      try {
        // Validated, not cast: this is browser-supplied input. `cols`/`rows`
        // in particular are re-framed as `ControlMessage::Resize { cols: u16,
        // rows: u16 }` for the supervisor, and an unbounded number there would
        // put a frame on the wire that ciborium cannot decode.
        msg = decodeClientToDo(toBytes(event.data as ArrayBuffer));
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
    if (this.#meta.state === 'awake') {
      // Activity supersedes an in-flight finalize, the same way a wake does
      // (CP-COLDRACE-1). This only ever fires on a substrate with no WARM state,
      // where the finalize is asked for while the computer is still AWAKE: a run
      // heartbeat or a new request inside that window must not be answered by
      // tearing the computer down when the supervisor's `snapshot_written{final}`
      // lands. The next idle deadline asks again.
      this.#meta.coldPending = false;
      this.#setDeadline('cold', null);
      await this.#armTier(this.#warmIdleMs());
    }
  }

  /** Arm the next tier deadline and AWAIT the alarm write (it must be durable
   *  before callers return, else `runDurableObjectAlarm` may race it). */
  async #armTier(afterMs: number): Promise<void> {
    this.#meta.armedIdleSince = this.#meta.idleSince;
    this.#setDeadline('tier', Date.now() + afterMs);
    this.#armLiveness();
    await this.#armAlarm();
  }

  /**
   * The one alarm, several deadlines (see DEADLINES).
   *
   * Each slot is a policy that must be able to advance WITHOUT an external event:
   * a wake retry, the WAKING watchdog, the liveness check, the COLD handshake
   * deadline, the tier policy. Every one of them was, at some point, either absent
   * or fighting the tier policy for the single alarm slot — which is precisely how
   * a computer ends up in a state nothing can move it out of.
   */
  override async alarm(): Promise<void> {
    const now = Date.now();
    let due: DeadlineName[] = DEADLINES.filter((name) => {
      const at = this.#deadlineAt(name);
      return at !== null && at <= now;
    });
    if (due.length === 0) {
      // Fired ahead of its scheduled time. Both test harnesses do exactly this —
      // `runDurableObjectAlarm` (workers pool) and `runAlarmNow` (Node) are how a
      // suite simulates the passage of idle time — and the platform is free to fire
      // early too. The earliest pending deadline is the one this alarm was for.
      let earliest: DeadlineName | null = null;
      for (const name of DEADLINES) {
        const at = this.#deadlineAt(name);
        if (at === null) continue;
        const best = earliest === null ? null : this.#deadlineAt(earliest);
        if (best === null || at < best) earliest = name;
      }
      if (earliest === null) return;
      due = [earliest];
    }

    for (const name of due) {
      // Clear the slot BEFORE running the handler: a handler that re-arms (the
      // tier's WARM->COLD, the recurring liveness check) sets it again, and a
      // handler that throws must not leave a deadline that can never be reached
      // pinned in front of every other policy.
      this.#setDeadline(name, null);
      await this.#persist();
      try {
        switch (name) {
          case 'wakeRetry':
            await this.#onWakeRetryDeadline();
            break;
          case 'waking':
            await this.#onWakingDeadline();
            break;
          case 'liveness':
            await this.#onLivenessDeadline();
            break;
          case 'cold':
            await this.#onColdDeadline();
            break;
          case 'tier':
            await this.#onTierDeadline();
            break;
        }
      } catch (err) {
        // A policy that throws must not silently take its own deadline with it —
        // that is the wedge again, one level up. Log it and put the deadline back
        // one window out, so the policy keeps running.
        console.warn(
          `mari: ${name} deadline failed computer=${this.#meta.computerId ?? '?'}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
        if (this.#deadlineAt(name) === null) {
          this.#setDeadline(name, Date.now() + this.#retryWindowFor(name));
        }
      }
    }
    await this.#persist();
    await this.#armAlarm();
  }

  /** A wake that failed with work still pending: try again, behind the request,
   *  exactly as the original trigger did (spec 8.3). */
  async #onWakeRetryDeadline(): Promise<void> {
    if (this.#meta.state === 'awake') return;
    if (this.#pendingWork() > 0) this.#wakeInBackground();
  }

  /**
   * A computer left in WAKING. WAKING is a transition, not a resting place: no
   * tier deadline acts on it, so without this watchdog an object evicted (or a
   * private instance restarted) between "state = waking" and the substrate's
   * answer leaves a computer nothing can ever move again.
   */
  async #onWakingDeadline(): Promise<void> {
    if (this.#meta.state !== 'waking') return;
    if (this.#wakeInFlight) {
      // A wake IS running (a slow materialize, or a driver retrying a platform
      // that is refusing). Give it another window rather than fighting it.
      this.#setDeadline('waking', Date.now() + this.#wakeTimeoutMs());
      return;
    }
    this.#recordIncident('wake_abandoned');
    console.warn(
      `mari: WAKING with no wake in flight computer=${this.#meta.computerId ?? '?'} ` +
        `epoch=${this.#meta.epoch}; rolling it back`,
    );
    // Roll back to the state the substrate is actually in, retry if work is
    // pending, and tell the fleet — the same path a refused wake takes.
    await this.#failWake(false);
  }

  /**
   * Run the liveness check NOW and report what it concluded.
   *
   * The same code the liveness deadline runs, exposed as an RPC: an operator
   * asking "is this computer really alive?" and the alarm asking it are the same
   * question, and there must not be two implementations of the answer.
   */
  async healthCheck(): Promise<{ state: ComputerState; verdict: LivenessVerdict; probes: number }> {
    const before = this.#probeCount;
    const verdict = await this.#onLivenessDeadline();
    await this.#persist();
    await this.#armAlarm();
    return { state: this.#meta.state, verdict, probes: this.#probeCount - before };
  }

  /**
   * The liveness deadline: either the grace window after the supervisor's socket
   * closed, or the recurring health check while work is in flight.
   *
   * The cheap answers come first. A supervisor that spoke inside the last window
   * is its own proof (marid heartbeats every 5 s during a run), so a healthy
   * computer never costs a substrate call. Only silence gets one.
   */
  async #onLivenessDeadline(): Promise<LivenessVerdict> {
    if (this.#meta.state !== 'awake') return 'not_awake';
    const live = this.#liveSupervisor();
    const pending = this.#pendingWork();
    if (live && pending === 0) {
      // Nothing at stake: the tier deadline collects an idle computer.
      this.#meta.supervisorLostAt = null;
      return 'idle';
    }
    const spokeRecently =
      this.#lastSupervisorAt > 0 && Date.now() - this.#lastSupervisorAt < this.#livenessMs();
    if (live && spokeRecently) {
      this.#meta.livenessStrikes = 0;
      this.#armLiveness();
      return 'supervised';
    }

    const status = await this.#probeInstance();
    if (status === 'gone') {
      await this.#recover('substrate_lost');
      return 'recovered';
    }
    if (status === 'unknown') {
      this.#meta.livenessStrikes += 1;
      if (this.#meta.livenessStrikes >= LIVENESS_STRIKES_MAX) {
        // Not a guess that it is gone (provider.ts is explicit that `unknown` is
        // not `gone`): a computer whose supervisor is absent AND whose substrate
        // cannot be asked is unusable, and recovery is safe under the epoch rule.
        await this.#recover('substrate_unknown');
        return 'recovered';
      }
      this.#armLiveness();
      return 'inconclusive';
    }

    // The instance is alive.
    if (!live) {
      if (pending > 0) {
        // A machine with no supervisor cannot run the work that is waiting: the
        // generation is replaced (fresh instance, new epoch, restore from the head)
        // rather than left to look AWAKE while nothing happens.
        await this.#recover('supervisor_lost');
        return 'recovered';
      }
      // Nothing to run: leave it to the tier deadline instead of paying for a
      // materialize nobody asked for.
      this.#meta.supervisorLostAt = null;
      return 'unsupervised_idle';
    }
    // A socket that is open but has said nothing for a whole window while work is
    // in flight — the shape a torn-down microVM took on a real deployment, where
    // the DO's supervisor socket stayed open and the computer read `awake` 15
    // minutes later. Bounded, then recovered.
    this.#meta.livenessStrikes += 1;
    if (this.#meta.livenessStrikes >= LIVENESS_STRIKES_MAX) {
      await this.#recover('supervisor_lost');
      return 'recovered';
    }
    this.#armLiveness();
    return 'mute';
  }

  /**
   * The AWAKE/WARM → COLD handshake did not complete on its own.
   *
   * `#beginCold` asked the supervisor for a clean stop and a final manifest (spec
   * 4.5). If that supervisor is dead the answer never comes — and before this
   * deadline the computer stayed AWAKE with NO alarm armed, forever: the e2e suite
   * had to nudge it with `POST /wake` and count the nudges. Finalize from the last
   * known head instead, and record that the final snapshot was MISSED rather than
   * reporting a clean transition.
   */
  async #onColdDeadline(): Promise<void> {
    if (!this.#meta.coldPending) return; // completed, or superseded by activity
    if (this.#meta.state === 'cold') return;
    this.#recordIncident('final_snapshot_missed');
    console.warn(
      `mari: cold finalize timed out computer=${this.#meta.computerId ?? '?'} ` +
        `epoch=${this.#meta.epoch}; finalizing from head=${this.#meta.head ?? 'none'} ` +
        `WITHOUT the supervisor's final snapshot (spec 4.5)`,
    );
    await this.#finalizeCold(null);
  }

  /** The tier policy (spec 4.4). */
  async #onTierDeadline(): Promise<void> {
    // Only progress if no activity happened since the deadline was armed.
    if (this.#meta.armedIdleSince !== this.#meta.idleSince) {
      // Stale (activity reset the timer): re-arm from the current idle mark.
      if (this.#meta.state === 'awake') await this.#armTier(this.#warmIdleMs());
      return;
    }

    if (this.#meta.state === 'awake') {
      // A substrate that cannot keep the disk across a stop has NO WARM state
      // (spec 2 as amended by decisions.md "WARM is a fast cold wake" — the
      // amended definition still says "the substrate disk still holds the
      // computer"). Recording WARM there would be a lie the next wake pays for:
      // it would call `substrate.wake` to resume a resource that holds nothing.
      // So the first idle deadline takes such a computer AWAKE -> COLD directly,
      // through the SAME clean-stop path (prepare_for_cold -> final manifest ->
      // destroy), because spec 4.5's pre-transition manifest is exactly what
      // makes a discarded disk safe. WARM_IDLE_MS is then the single idle
      // deadline and COLD_IDLE_MS is unused.
      if (this.substrate.supportsWarm === false) {
        await this.#beginCold();
        return;
      }
      // AWAKE -> WARM. A substrate that cannot even be asked to sleep is not
      // WARM, whatever this object would like to record: the failure is checked
      // rather than thrown out of the alarm, because an alarm that throws leaves
      // the computer exactly where it was — AWAKE, with the deadline consumed.
      if (this.#meta.handle) {
        try {
          await this.#bounded(this.substrate.sleep(this.#meta.handle), this.#wakeTimeoutMs(), 'sleep');
        } catch (err) {
          console.warn(
            `mari: sleep failed computer=${this.#meta.computerId ?? '?'} ` +
              `epoch=${this.#meta.epoch}: ${err instanceof Error ? err.message : String(err)}`,
          );
          // Is the instance even there? If it is gone this is the eviction path;
          // if it is alive but unsleepable, take the computer COLD instead — the
          // chunk store holds it either way (spec 4.1) and a wedge is not an
          // option.
          const status = await this.#probeInstance();
          if (status === 'gone') await this.#recover('substrate_lost');
          else await this.#beginCold();
          return;
        }
      }
      this.#meta.state = 'warm';
      this.#closeAwakeStretch();
      this.#setDeadline('liveness', null);
      // Arm the WARM -> COLD deadline (idle mark unchanged => next one matches).
      await this.#armTier(this.#coldIdleMs());
      await this.#persist();
      await this.#syncFleetState();
      this.#emit({ type: 'state', state: 'warm' });
      return;
    }

    if (this.#meta.state === 'warm') {
      await this.#beginCold();
      return;
    }
  }

  /** Begin the transition to COLD (spec 4.4/4.5): ask the supervisor to stop
   *  cleanly and write the final manifest; `#onSnapshotWritten` records that
   *  manifest as the head and completes the destroy. If no supervisor is
   *  attached there is nobody to write a manifest, so tear down immediately.
   *
   *  Reached from WARM on a substrate that has WARM, and from AWAKE directly on
   *  one that does not. */
  async #beginCold(): Promise<void> {
    if (this.#liveSupervisor()) {
      // Spec 4.5: the supervisor stops each agent session in a clean state
      // before COLD. It can only do that while it is RUNNING, so a substrate
      // whose WARM state freezes the guest is resumed first (Docker `pause`;
      // see FreezingSubstrate). Otherwise `prepare_for_cold` would sit in a
      // frozen socket buffer and the computer would never reach COLD.
      const handle = this.#meta.handle;
      if (handle && (this.substrate as FreezingSubstrate).resumeBeforeCold?.(handle)) {
        try {
          await this.#bounded(this.substrate.wake(handle), this.#wakeTimeoutMs(), 'resume for cold');
        } catch (err) {
          // The resource cannot be resumed, so no supervisor can write the final
          // manifest from it. Finalize from the head rather than waiting for an
          // answer that cannot come.
          console.warn(
            `mari: resume-before-cold failed computer=${this.#meta.computerId ?? '?'}: ` +
              `${err instanceof Error ? err.message : String(err)}`,
          );
          this.#recordIncident('final_snapshot_missed');
          await this.#finalizeCold(null);
          return;
        }
      }
      this.#meta.coldPending = true;
      // THE HANDSHAKE GETS A DEADLINE. Everything after this point depends on a
      // supervisor answering, and a supervisor whose container is already gone
      // never will — that is the stall the e2e suite had to nudge around.
      this.#setDeadline('cold', Date.now() + this.#coldFinalizeMs());
      await this.#armAlarm();
      await this.#persist();
      this.#sendControl({ t: 'prepare_for_cold' });
      return;
    }
    // Nobody can write a manifest: finalize from the last known head. This is not
    // a silent success — a COLD reached without the snapshot spec 4.5 asks for is
    // recorded, because work since the last snapshot is genuinely not in the
    // chunk store.
    if (this.#meta.state === 'awake' && this.#meta.handle) {
      this.#recordIncident('final_snapshot_missed');
    }
    await this.#finalizeCold(null);
  }

  /**
   * Complete the transition to COLD: record the final manifest if there is one,
   * destroy the substrate resources, drop the fencing token, and settle.
   *
   * Shared by every road to COLD — the supervisor's `snapshot_written{final}`, the
   * handshake deadline, and a `#beginCold` with no supervisor to ask — so a COLD
   * computer always looks the same afterwards: no handle, no token, one `state`
   * event, and a wake retry armed if work is still queued (otherwise a run
   * enqueued during the transition would sit there with nothing to run it).
   */
  async #finalizeCold(finalManifest: ManifestId | null): Promise<void> {
    if (finalManifest) this.#setHead(finalManifest);
    this.#meta.coldPending = false;
    await this.#tearDownInstance('cold finalize');
    this.#meta.token = null;
    this.#meta.state = 'cold';
    this.#meta.generationAt = null;
    this.#meta.supervisorSeen = false;
    this.#meta.supervisorLostAt = null;
    this.#meta.livenessStrikes = 0;
    this.#closeAwakeStretch();
    this.#setDeadline('liveness', null);
    this.#setDeadline('cold', null);
    this.#setDeadline('tier', null);
    this.#setDeadline('waking', null);
    await this.#persist();
    await this.#syncFleetState();
    this.#emit({ type: 'state', state: 'cold' });
    this.#dropSupervisorSockets('cold');

    // A run that was handed to the supervisor that just went away, or one queued
    // during the transition, must still happen (spec 5.1).
    this.#degradeInFlightRuns();
    if (this.#hasQueuedRuns()) {
      this.#meta.wakeFailures = 0;
      this.#meta.wakeRetryAt = Date.now() + (WAKE_RETRY_MS[0] as number);
    }
    await this.#persist();
    await this.#armAlarm();
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
