// Runtime validation for values decoded from CBOR.
//
// `any` is allowed only at this boundary (decisions.md TypeScript convention):
// `decodeCbor` returns `unknown`, and these guards narrow it to the mirrored
// types, throwing `ValidationError` on any shape that does not match. Callers
// that decode untrusted bytes should route through `decode*Message` /
// `decodeManifest` rather than casting `decodeCbor`'s result directly.

import { decodeCbor } from './cbor';
import type {
  Manifest,
  ManifestEntry,
  ChunkRef,
  EntryKind,
} from './manifest';
import type {
  ControlMessage,
  ControlMessageTag,
  SupervisorMessage,
  SupervisorMessageTag,
} from './messages';

/** Thrown when a decoded value does not match its expected shape. */
export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
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

function str(v: unknown, at: string): string {
  if (typeof v !== 'string') throw new ValidationError(`${at}: expected string, got ${typeof v}`);
  return v;
}

function u53(v: unknown, at: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new ValidationError(`${at}: expected non-negative integer, got ${String(v)}`);
  }
  if (v > 9_007_199_254_740_991) {
    throw new ValidationError(`${at}: integer ${v} exceeds JS safe range (BigInt leaked?)`);
  }
  return v;
}

function record(v: unknown, at: string): Record<string, unknown> {
  if (!isRecord(v)) throw new ValidationError(`${at}: expected object`);
  return v;
}

function arr(v: unknown, at: string): unknown[] {
  if (!Array.isArray(v)) throw new ValidationError(`${at}: expected array`);
  return v;
}

const SUPERVISOR_TAGS: ReadonlySet<string> = new Set<SupervisorMessageTag>([
  'hello',
  'journal_frame',
  'run_started',
  'run_completed',
  'snapshot_written',
  'head_advance_request',
  'attention',
  'run_heartbeat',
]);

const CONTROL_TAGS: ReadonlySet<string> = new Set<ControlMessageTag>([
  'hello_ack',
  'journal_ack',
  'start_run',
  'stop_run',
  'input',
  'resize',
  'snapshot_now',
  'prepare_for_cold',
  'head_advance_result',
  'restore_to_manifest',
]);

const ENTRY_KINDS: ReadonlySet<string> = new Set<EntryKind>(['file', 'dir', 'symlink']);

/** Narrow an already-decoded value to a {@link SupervisorMessage}. */
export function asSupervisorMessage(value: unknown): SupervisorMessage {
  const env = record(value, 'SupervisorMessage');
  const t = str(env['t'], 'SupervisorMessage.t');
  if (!SUPERVISOR_TAGS.has(t)) {
    throw new ValidationError(`SupervisorMessage.t: unknown variant "${t}"`);
  }
  // Every supervisor variant carries a payload object.
  record(env['c'], `SupervisorMessage(${t}).c`);
  if (t === 'journal_frame') {
    const c = env['c'] as Record<string, unknown>;
    str(c['run'], 'journal_frame.run');
    u53(c['offset'], 'journal_frame.offset');
    if (!ArrayBuffer.isView(c['bytes'])) {
      throw new ValidationError('journal_frame.bytes: expected byte string (Uint8Array)');
    }
  }
  return value as SupervisorMessage;
}

/** Narrow an already-decoded value to a {@link ControlMessage}. */
export function asControlMessage(value: unknown): ControlMessage {
  const env = record(value, 'ControlMessage');
  const t = str(env['t'], 'ControlMessage.t');
  if (!CONTROL_TAGS.has(t)) {
    throw new ValidationError(`ControlMessage.t: unknown variant "${t}"`);
  }
  if (t !== 'prepare_for_cold') {
    record(env['c'], `ControlMessage(${t}).c`);
  }
  if (t === 'input') {
    const c = env['c'] as Record<string, unknown>;
    str(c['run'], 'input.run');
    if (!ArrayBuffer.isView(c['bytes'])) {
      throw new ValidationError('input.bytes: expected byte string (Uint8Array)');
    }
  } else if (t === 'resize') {
    const c = env['c'] as Record<string, unknown>;
    str(c['run'], 'resize.run');
    u53(c['cols'], 'resize.cols');
    u53(c['rows'], 'resize.rows');
  }
  return value as ControlMessage;
}

function asChunkRef(value: unknown, at: string): ChunkRef {
  const r = record(value, at);
  return { chunk: str(r['chunk'], `${at}.chunk`), len: u53(r['len'], `${at}.len`) };
}

function asEntry(value: unknown, at: string): ManifestEntry {
  const r = record(value, at);
  const kind = str(r['kind'], `${at}.kind`);
  if (!ENTRY_KINDS.has(kind)) throw new ValidationError(`${at}.kind: unknown "${kind}"`);
  const target = r['symlink_target'];
  if (target !== null && typeof target !== 'string') {
    throw new ValidationError(`${at}.symlink_target: expected string or null`);
  }
  return {
    path: str(r['path'], `${at}.path`),
    kind: kind as EntryKind,
    mode: u53(r['mode'], `${at}.mode`),
    size: u53(r['size'], `${at}.size`),
    symlink_target: target,
    chunks: arr(r['chunks'], `${at}.chunks`).map((c, i) => asChunkRef(c, `${at}.chunks[${i}]`)),
  };
}

/** Narrow an already-decoded value to a {@link Manifest}. */
export function asManifest(value: unknown): Manifest {
  const r = record(value, 'Manifest');
  const parent = r['parent'];
  if (parent !== null && typeof parent !== 'string') {
    throw new ValidationError('Manifest.parent: expected string or null');
  }
  return {
    version: u53(r['version'], 'Manifest.version'),
    parent,
    created_at: u53(r['created_at'], 'Manifest.created_at'),
    entries: arr(r['entries'], 'Manifest.entries').map((e, i) =>
      asEntry(e, `Manifest.entries[${i}]`),
    ),
  };
}

/** Decode CBOR bytes and validate them as a {@link SupervisorMessage}. */
export function decodeSupervisorMessage(bytes: Uint8Array): SupervisorMessage {
  return asSupervisorMessage(decodeCbor(bytes));
}

/** Decode CBOR bytes and validate them as a {@link ControlMessage}. */
export function decodeControlMessage(bytes: Uint8Array): ControlMessage {
  return asControlMessage(decodeCbor(bytes));
}

/** Decode CBOR bytes and validate them as a {@link Manifest}. */
export function decodeManifest(bytes: Uint8Array): Manifest {
  return asManifest(decodeCbor(bytes));
}
