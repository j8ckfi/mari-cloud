// Runtime validation for values decoded from CBOR.
//
// `any` is allowed only at this boundary (decisions.md TypeScript convention):
// `decodeCbor` returns `unknown`, and these guards narrow it to the mirrored
// types, throwing `ValidationError` on any shape that does not match. Callers
// that decode untrusted bytes must route through `decode*Message` /
// `decodeManifest` / `decodeClientToDo` rather than casting `decodeCbor`'s
// result directly.
//
// **What is checked.** For every variant of every envelope, not just its tag:
//
// - the envelope is an object and `t` is a known variant string;
// - the payload `c` is present and an object (except payload-free
//   `prepare_for_cold`);
// - every documented field is present with its documented primitive type — ids
//   and paths are strings, byte payloads are `Uint8Array`, flags are booleans,
//   simple enums (`SnapshotReason`, `AttentionKind`, `EntryKind`) are one of
//   their known snake_case strings, and sized integers are inside their Rust
//   type's range (`u16` for `cols`/`rows`, `u32` for `proto_version`/`mode`/the
//   diff counts, `i32` for an exit code or signal);
// - every `u64`-typed field (contracts.md §3: `Epoch`, `JournalOffset`, and the
//   manifest sizes) passes the JS-safe-integer guard and is normalized to a
//   `number`.
//
// **Why the u64 guard is load-bearing on EVERY variant.** `Epoch` is the
// fencing token (contracts.md §6) and the control plane compares it with `===`.
// A `bigint` epoch is never `===` a `number` epoch, and a `u64` past 2^53
// decodes to a silently ROUNDED `number` (cbor-x `int64AsNumber`, cbor.ts), so
// an unguarded epoch can fence a legitimate supervisor out of its own computer
// — permanently, with no error raised anywhere. `journal_frame.offset` used to
// be the only guarded field; `hello.epoch`, `head_advance_request.epoch`,
// `snapshot_written.epoch`, `head_advance_result.current_epoch` and every
// `RunOffset.offset` are guarded now too.
//
// **Unknown/extra map keys are IGNORED, not rejected.** `mari-proto`'s wire
// structs do not set `serde(deny_unknown_fields)` (only marid's agent-adapter
// file does, decisions.md), so `ciborium` accepts extra keys; a stricter TS
// mirror would reject frames a conformant supervisor is free to send. The
// mirror must not be stricter than the format it mirrors. Ignoring them also
// keeps validation allocation-free and key-enumeration-free on the journal hot
// path.

import { decodeCbor } from './cbor';
import { MAX_SAFE_INTEGER } from './ids';
import type { ClientToDo, DoToClient } from './attach';
import type {
  AttentionKind,
  ControlMessage,
  SupervisorMessage,
} from './messages';
import type {
  ChunkRef,
  EntryKind,
  Manifest,
  ManifestEntry,
  SnapshotReason,
} from './manifest';

/** Thrown when a decoded value does not match its expected shape. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const U32_MAX = 4_294_967_295;
const U16_MAX = 65_535;
const I32_MIN = -2_147_483_648;
const I32_MAX = 2_147_483_647;
/** Largest 24-bit RGB value; `fg`/`bg` are `0xRRGGBB` or `-1` for default. */
const RGB_MAX = 0xff_ff_ff;
const MAX_SAFE_BIGINT = BigInt(MAX_SAFE_INTEGER);

// ---------------------------------------------------------------------------
// Primitive guards
// ---------------------------------------------------------------------------

/** Human-readable rendering of a rejected value. Error path only. */
function describeValue(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return `array(${v.length})`;
  if (ArrayBuffer.isView(v)) {
    const name = (v as { constructor?: { name?: string } }).constructor?.name;
    return name ?? 'ArrayBufferView';
  }
  switch (typeof v) {
    case 'undefined':
      return 'nothing (field missing)';
    case 'string':
      return `string ${JSON.stringify(v.length > 32 ? `${v.slice(0, 32)}...` : v)}`;
    case 'bigint':
      return `bigint ${v}n`;
    case 'object':
      return 'object';
    default:
      return `${typeof v} ${String(v)}`;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    !Array.isArray(v) &&
    !ArrayBuffer.isView(v)
  );
}

function record(v: unknown, at: string): Record<string, unknown> {
  if (!isRecord(v)) {
    throw new ValidationError(`${at}: expected object, got ${describeValue(v)}`);
  }
  return v;
}

function arr(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) {
    throw new ValidationError(`${at}: expected array, got ${describeValue(v)}`);
  }
  return v;
}

function str(v: unknown, at: string): string {
  if (typeof v !== 'string') {
    throw new ValidationError(`${at}: expected string, got ${describeValue(v)}`);
  }
  return v;
}

function strOrNull(v: unknown, at: string): string | null {
  if (v !== null && typeof v !== 'string') {
    throw new ValidationError(`${at}: expected string or null, got ${describeValue(v)}`);
  }
  return v;
}

function bool(v: unknown, at: string): boolean {
  if (typeof v !== 'boolean') {
    throw new ValidationError(`${at}: expected boolean, got ${describeValue(v)}`);
  }
  return v;
}

function strArray(v: unknown, at: string): string[] {
  const a = arr(v, at);
  for (let i = 0; i < a.length; i += 1) str(a[i], `${at}[${i}]`);
  return a as string[];
}

/**
 * A `u64` wire field, normalized to a JS `number`.
 *
 * Rejects anything that is not a non-negative integer, and rejects — loudly —
 * any value at or past 2^53. Past that ceiling a `number` is no longer the
 * value that was sent (cbor-x rounds it) and a `bigint` breaks every `===`
 * comparison the protocol relies on, epoch fencing first among them
 * (contracts.md §6).
 */
function u53(v: unknown, at: string): number {
  if (typeof v === 'number') {
    if (!Number.isInteger(v) || v < 0) {
      throw new ValidationError(
        `${at}: expected a non-negative integer, got ${describeValue(v)}`,
      );
    }
    if (v > MAX_SAFE_INTEGER) {
      throw new ValidationError(
        `${at}: u64 ${v} is at or past 2^53 — outside the JS safe-integer range ` +
          `(contracts.md §1), so its decoded value is rounded, not the value sent`,
      );
    }
    return v;
  }
  if (typeof v === 'bigint') {
    if (v < 0n || v > MAX_SAFE_BIGINT) {
      throw new ValidationError(
        `${at}: u64 ${v}n is outside the JS safe-integer range (contracts.md §1); ` +
          `a BigInt here is never === a number, which silently breaks epoch fencing`,
      );
    }
    return Number(v);
  }
  throw new ValidationError(
    `${at}: expected a non-negative integer, got ${describeValue(v)}`,
  );
}

function boundedUint(v: unknown, at: string, max: number): number {
  const n = u53(v, at);
  if (n > max) {
    throw new ValidationError(`${at}: ${n} exceeds this field's maximum of ${max}`);
  }
  return n;
}

function boundedInt(v: unknown, at: string, min: number, max: number): number {
  let n: number;
  if (typeof v === 'bigint') {
    if (v < -MAX_SAFE_BIGINT || v > MAX_SAFE_BIGINT) {
      throw new ValidationError(
        `${at}: ${v}n is outside the JS safe-integer range`,
      );
    }
    n = Number(v);
  } else if (typeof v === 'number' && Number.isInteger(v)) {
    n = v;
  } else {
    throw new ValidationError(`${at}: expected an integer, got ${describeValue(v)}`);
  }
  if (n < min || n > max) {
    throw new ValidationError(`${at}: ${n} is outside the allowed range [${min}, ${max}]`);
  }
  return n;
}

/**
 * A CBOR byte string. Accepts a `Uint8Array` from any realm (a Worker/Node
 * boundary keeps the tag but not the identity of the constructor), and nothing
 * else — a `DataView` or `Int8Array` is not what the codec produces.
 */
function byteString(v: unknown, at: string): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (Object.prototype.toString.call(v) === '[object Uint8Array]') {
    return v as Uint8Array;
  }
  throw new ValidationError(
    `${at}: expected a CBOR byte string (Uint8Array), got ${describeValue(v)}`,
  );
}

function enumField(v: unknown, at: string, allowed: ReadonlySet<string>): string {
  const s = str(v, at);
  if (!allowed.has(s)) {
    throw new ValidationError(
      `${at}: unknown value "${s}"; expected one of ${[...allowed].join(' | ')}`,
    );
  }
  return s;
}

// Normalizing setters: validate `holder[key]` and write the normalized `number`
// back ONLY when the decoded value was not already a `number` (i.e. a BigInt
// slipped through). A conformant message is therefore returned untouched — same
// object identity, same values — while a BigInt epoch is repaired into the
// `number` the rest of the code compares with `===`.

function setU53(holder: Record<string, unknown>, key: string, at: string): void {
  const v = holder[key];
  const n = u53(v, at);
  if (typeof v !== 'number') holder[key] = n;
}

function setUint(
  holder: Record<string, unknown>,
  key: string,
  at: string,
  max: number,
): void {
  const v = holder[key];
  const n = boundedUint(v, at, max);
  if (typeof v !== 'number') holder[key] = n;
}

function setInt(
  holder: Record<string, unknown>,
  key: string,
  at: string,
  min: number,
  max: number,
): void {
  const v = holder[key];
  const n = boundedInt(v, at, min, max);
  if (typeof v !== 'number') holder[key] = n;
}

/** The `c` payload of an adjacently-tagged envelope. */
function payload(env: Record<string, unknown>, t: string): Record<string, unknown> {
  const c = env['c'];
  if (!isRecord(c)) {
    throw new ValidationError(`${t}.c: expected payload object, got ${describeValue(c)}`);
  }
  return c;
}

// ---------------------------------------------------------------------------
// Enum value sets (contracts.md §1 "simple field enums")
// ---------------------------------------------------------------------------

const ENTRY_KINDS: ReadonlySet<string> = new Set<EntryKind>(['file', 'dir', 'symlink']);

const SNAPSHOT_REASONS: ReadonlySet<string> = new Set<SnapshotReason>([
  'pre_run',
  'scheduled',
  'command',
  'final',
]);

const ATTENTION_KINDS: ReadonlySet<string> = new Set<AttentionKind>([
  'bell',
  'osc',
  'blocked_read',
  'interrupted',
]);

// ---------------------------------------------------------------------------
// Shared payload fragments
// ---------------------------------------------------------------------------

/** `{ added, modified, removed }`, all `u32` (contracts.md §4). */
function validateDiffSummary(v: unknown, at: string): void {
  const d = record(v, at);
  setUint(d, 'added', `${at}.added`, U32_MAX);
  setUint(d, 'modified', `${at}.modified`, U32_MAX);
  setUint(d, 'removed', `${at}.removed`, U32_MAX);
}

/** `ExitStatus`, adjacently tagged like the envelopes; `code`/`signal` are `i32`. */
function validateExitStatus(v: unknown, at: string): void {
  const e = record(v, at);
  const t = str(e['t'], `${at}.t`);
  if (t === 'exited') {
    setInt(payload(e, at), 'code', `${at}.c.code`, I32_MIN, I32_MAX);
    return;
  }
  if (t === 'signaled') {
    setInt(payload(e, at), 'signal', `${at}.c.signal`, I32_MIN, I32_MAX);
    return;
  }
  throw new ValidationError(`${at}.t: unknown ExitStatus variant "${t}"`);
}

/** `RunOffset[]` — one durably-acked journal offset per run. */
function validateRunOffsets(v: unknown, at: string): void {
  const a = arr(v, at);
  for (let i = 0; i < a.length; i += 1) {
    const item = `${at}[${i}]`;
    const r = record(a[i], item);
    str(r['run'], `${item}.run`);
    setU53(r, 'offset', `${item}.offset`);
  }
}

// ---------------------------------------------------------------------------
// Supervisor -> control (contracts.md §5.1)
// ---------------------------------------------------------------------------

/** Narrow an already-decoded value to a {@link SupervisorMessage}. */
export function asSupervisorMessage(value: unknown): SupervisorMessage {
  const env = record(value, 'SupervisorMessage');
  const t = str(env['t'], 'SupervisorMessage.t');
  // Cases are ordered by wire frequency: journal frames dominate the stream,
  // heartbeats come next, and the rest are per-run or per-snapshot events.
  switch (t) {
    case 'journal_frame': {
      const c = payload(env, t);
      str(c['run'], 'journal_frame.run');
      setU53(c, 'offset', 'journal_frame.offset');
      byteString(c['bytes'], 'journal_frame.bytes');
      break;
    }
    case 'run_heartbeat': {
      str(payload(env, t)['run'], 'run_heartbeat.run');
      break;
    }
    case 'hello': {
      const c = payload(env, t);
      str(c['computer'], 'hello.computer');
      setU53(c, 'epoch', 'hello.epoch');
      str(c['token'], 'hello.token');
      setUint(c, 'proto_version', 'hello.proto_version', U32_MAX);
      break;
    }
    case 'run_started': {
      const c = payload(env, t);
      str(c['run'], 'run_started.run');
      str(c['pre_run_manifest'], 'run_started.pre_run_manifest');
      break;
    }
    case 'run_completed': {
      const c = payload(env, t);
      str(c['run'], 'run_completed.run');
      validateExitStatus(c['exit'], 'run_completed.exit');
      str(c['post_run_manifest'], 'run_completed.post_run_manifest');
      validateDiffSummary(c['diff'], 'run_completed.diff');
      break;
    }
    case 'snapshot_written': {
      const c = payload(env, t);
      str(c['manifest'], 'snapshot_written.manifest');
      setU53(c, 'epoch', 'snapshot_written.epoch');
      enumField(c['reason'], 'snapshot_written.reason', SNAPSHOT_REASONS);
      break;
    }
    case 'head_advance_request': {
      const c = payload(env, t);
      str(c['manifest'], 'head_advance_request.manifest');
      setU53(c, 'epoch', 'head_advance_request.epoch');
      break;
    }
    case 'attention': {
      const c = payload(env, t);
      str(c['run'], 'attention.run');
      enumField(c['kind'], 'attention.kind', ATTENTION_KINDS);
      break;
    }
    case 'rollback_detected': {
      const c = payload(env, t);
      str(c['disk_manifest'], 'rollback_detected.disk_manifest');
      strOrNull(c['recorded_manifest'], 'rollback_detected.recorded_manifest');
      validateDiffSummary(c['diff'], 'rollback_detected.diff');
      const runs = arr(c['runs'], 'rollback_detected.runs');
      for (let i = 0; i < runs.length; i += 1) {
        const at = `rollback_detected.runs[${i}]`;
        const r = record(runs[i], at);
        str(r['run'], `${at}.run`);
        setU53(r, 'control_offset', `${at}.control_offset`);
        setU53(r, 'disk_offset', `${at}.disk_offset`);
        bool(r['replayed'], `${at}.replayed`);
      }
      break;
    }
    default:
      throw new ValidationError(`SupervisorMessage.t: unknown variant "${t}"`);
  }
  return value as SupervisorMessage;
}

// ---------------------------------------------------------------------------
// Control -> supervisor (contracts.md §5.2)
// ---------------------------------------------------------------------------

/** Narrow an already-decoded value to a {@link ControlMessage}. */
export function asControlMessage(value: unknown): ControlMessage {
  const env = record(value, 'ControlMessage');
  const t = str(env['t'], 'ControlMessage.t');
  switch (t) {
    case 'journal_ack': {
      const c = payload(env, t);
      str(c['run'], 'journal_ack.run');
      setU53(c, 'offset', 'journal_ack.offset');
      break;
    }
    case 'input': {
      const c = payload(env, t);
      str(c['run'], 'input.run');
      byteString(c['bytes'], 'input.bytes');
      break;
    }
    case 'resize': {
      // `cols`/`rows` are `u16` in mari-proto: a larger value is one ciborium
      // refuses to decode, which would break the supervisor's frame stream.
      const c = payload(env, t);
      str(c['run'], 'resize.run');
      setUint(c, 'cols', 'resize.cols', U16_MAX);
      setUint(c, 'rows', 'resize.rows', U16_MAX);
      break;
    }
    case 'hello_ack': {
      validateRunOffsets(payload(env, t)['acked'], 'hello_ack.acked');
      break;
    }
    case 'start_run': {
      const c = payload(env, t);
      str(c['run'], 'start_run.run');
      strArray(c['argv'], 'start_run.argv');
      // Vault variable NAMES only; values never travel here (spec 10.1).
      strArray(c['env_names'], 'start_run.env_names');
      str(c['cwd'], 'start_run.cwd');
      break;
    }
    case 'stop_run': {
      str(payload(env, t)['run'], 'stop_run.run');
      break;
    }
    case 'snapshot_now': {
      enumField(payload(env, t)['reason'], 'snapshot_now.reason', SNAPSHOT_REASONS);
      break;
    }
    case 'prepare_for_cold':
      // Payload-free: `c` is omitted entirely (contracts.md §1).
      break;
    case 'head_advance_result': {
      const c = payload(env, t);
      bool(c['accepted'], 'head_advance_result.accepted');
      setU53(c, 'current_epoch', 'head_advance_result.current_epoch');
      break;
    }
    case 'restore_to_manifest': {
      str(payload(env, t)['manifest'], 'restore_to_manifest.manifest');
      break;
    }
    default:
      throw new ValidationError(`ControlMessage.t: unknown variant "${t}"`);
  }
  return value as ControlMessage;
}

// ---------------------------------------------------------------------------
// Client <-> Durable Object attach protocol (contracts.md §7)
// ---------------------------------------------------------------------------

/** Narrow an already-decoded value to a {@link ClientToDo}. */
export function asClientToDo(value: unknown): ClientToDo {
  const m = record(value, 'ClientToDo');
  const t = str(m['t'], 'ClientToDo.t');
  switch (t) {
    case 'input': {
      str(m['run'], 'ClientToDo(input).run');
      byteString(m['bytes'], 'ClientToDo(input).bytes');
      break;
    }
    case 'attach':
    case 'resize': {
      // Bounded as `u16` because the DO re-frames a resize as
      // `ControlMessage::Resize { cols: u16, rows: u16 }` (contracts.md App. B):
      // an unbounded client number would produce a frame ciborium cannot decode.
      str(m['run'], `ClientToDo(${t}).run`);
      setUint(m, 'cols', `ClientToDo(${t}).cols`, U16_MAX);
      setUint(m, 'rows', `ClientToDo(${t}).rows`, U16_MAX);
      break;
    }
    case 'detach': {
      str(m['run'], 'ClientToDo(detach).run');
      break;
    }
    default:
      throw new ValidationError(`ClientToDo.t: unknown variant "${t}"`);
  }
  return value as ClientToDo;
}

function validateGridSnapshot(value: unknown, at: string): void {
  const g = record(value, at);
  setUint(g, 'cols', `${at}.cols`, U16_MAX);
  setUint(g, 'rows', `${at}.rows`, U16_MAX);
  setUint(g, 'cursorCol', `${at}.cursorCol`, U16_MAX);
  setUint(g, 'cursorRow', `${at}.cursorRow`, U16_MAX);
  bool(g['cursorVisible'], `${at}.cursorVisible`);
  const rows = arr(g['cells'], `${at}.cells`);
  for (let r = 0; r < rows.length; r += 1) {
    const rowAt = `${at}.cells[${r}]`;
    const row = arr(rows[r], rowAt);
    for (let c = 0; c < row.length; c += 1) {
      const cellAt = `${rowAt}[${c}]`;
      const cell = record(row[c], cellAt);
      str(cell['ch'], `${cellAt}.ch`);
      setUint(cell, 'attrs', `${cellAt}.attrs`, U32_MAX);
      setInt(cell, 'fg', `${cellAt}.fg`, -1, RGB_MAX);
      setInt(cell, 'bg', `${cellAt}.bg`, -1, RGB_MAX);
    }
  }
}

/** Narrow an already-decoded value to a {@link DoToClient}. */
export function asDoToClient(value: unknown): DoToClient {
  const m = record(value, 'DoToClient');
  const t = str(m['t'], 'DoToClient.t');
  switch (t) {
    case 'frame': {
      str(m['run'], 'DoToClient(frame).run');
      setU53(m, 'offset', 'DoToClient(frame).offset');
      byteString(m['bytes'], 'DoToClient(frame).bytes');
      break;
    }
    case 'grid': {
      str(m['run'], 'DoToClient(grid).run');
      setU53(m, 'baseOffset', 'DoToClient(grid).baseOffset');
      validateGridSnapshot(m['grid'], 'DoToClient(grid).grid');
      break;
    }
    case 'run_status': {
      str(m['run'], 'DoToClient(run_status).run');
      bool(m['alive'], 'DoToClient(run_status).alive');
      if (m['exitCode'] !== null) {
        setInt(m, 'exitCode', 'DoToClient(run_status).exitCode', I32_MIN, I32_MAX);
      }
      break;
    }
    default:
      throw new ValidationError(`DoToClient.t: unknown variant "${t}"`);
  }
  return value as DoToClient;
}

// ---------------------------------------------------------------------------
// Manifest (contracts.md §4)
// ---------------------------------------------------------------------------

function asChunkRef(value: unknown, at: string): ChunkRef {
  const r = record(value, at);
  return { chunk: str(r['chunk'], `${at}.chunk`), len: u53(r['len'], `${at}.len`) };
}

function asEntry(value: unknown, at: string): ManifestEntry {
  const r = record(value, at);
  const kind = enumField(r['kind'], `${at}.kind`, ENTRY_KINDS) as EntryKind;
  return {
    path: str(r['path'], `${at}.path`),
    kind,
    mode: boundedUint(r['mode'], `${at}.mode`, U32_MAX),
    size: u53(r['size'], `${at}.size`),
    symlink_target: strOrNull(r['symlink_target'], `${at}.symlink_target`),
    chunks: arr(r['chunks'], `${at}.chunks`).map((c, i) => asChunkRef(c, `${at}.chunks[${i}]`)),
  };
}

/** Narrow an already-decoded value to a {@link Manifest}. */
export function asManifest(value: unknown): Manifest {
  const r = record(value, 'Manifest');
  return {
    version: boundedUint(r['version'], 'Manifest.version', U32_MAX),
    parent: strOrNull(r['parent'], 'Manifest.parent'),
    created_at: u53(r['created_at'], 'Manifest.created_at'),
    entries: arr(r['entries'], 'Manifest.entries').map((e, i) =>
      asEntry(e, `Manifest.entries[${i}]`),
    ),
  };
}

// ---------------------------------------------------------------------------
// Decode + validate
// ---------------------------------------------------------------------------

/** Decode CBOR bytes and validate them as a {@link SupervisorMessage}. */
export function decodeSupervisorMessage(bytes: Uint8Array): SupervisorMessage {
  return asSupervisorMessage(decodeCbor(bytes));
}

/** Decode CBOR bytes and validate them as a {@link ControlMessage}. */
export function decodeControlMessage(bytes: Uint8Array): ControlMessage {
  return asControlMessage(decodeCbor(bytes));
}

/** Decode CBOR bytes and validate them as a {@link ClientToDo} (attach §7.1). */
export function decodeClientToDo(bytes: Uint8Array): ClientToDo {
  return asClientToDo(decodeCbor(bytes));
}

/** Decode CBOR bytes and validate them as a {@link DoToClient} (attach §7.2). */
export function decodeDoToClient(bytes: Uint8Array): DoToClient {
  return asDoToClient(decodeCbor(bytes));
}

/** Decode CBOR bytes and validate them as a {@link Manifest}. */
export function decodeManifest(bytes: Uint8Array): Manifest {
  return asManifest(decodeCbor(bytes));
}
