// Parsing the `/api/events` SSE payloads (spec 6.2).
//
// Two rules govern this file:
//
//  1. **Content-free.** Spec 6.2 says the attention event carries no content and
//     spec 6.3 forbids interpreting an agent prompt. So the parser accepts ONLY
//     the metadata fields below and drops everything else on the floor — an
//     event that arrived carrying terminal text could not be rendered by the UI
//     even if a server sent it, because the parsed value has nowhere to put it.
//  2. **Untrusted input.** A stream payload is decoded JSON; it is validated
//     field by field before it becomes a typed event, and a malformed event is
//     skipped rather than throwing (one bad frame must not kill the stream).

import type {
  AttentionEvent,
  MariEvent,
  RunEvent,
  RunState,
  StateEvent,
} from '../api/types';
import type { AttentionKind, ComputerState } from '@mari/shared';

const RUN_STATES: ReadonlySet<string> = new Set<RunState>([
  'pending',
  'running',
  'stopping',
  'exited',
  'failed',
]);

const COMPUTER_STATES: ReadonlySet<string> = new Set<ComputerState>([
  'awake',
  'warm',
  'cold',
  'waking',
]);

const ATTENTION_KINDS: ReadonlySet<string> = new Set<AttentionKind>([
  'bell',
  'osc',
  'blocked_read',
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/**
 * Validate one decoded event. Returns null for anything that is not a
 * well-formed event of a known type.
 *
 * `runId` is the canonical field name (matching `POST /runs` → `{ runId }`);
 * `run` is accepted as an alias because the CBOR wire (contracts §5.1) names
 * that field `run`, and a control plane that forwards the supervisor message
 * verbatim will spell it that way.
 */
export function parseMariEvent(value: unknown): MariEvent | null {
  if (!isRecord(value)) return null;

  const type = str(value['type']);
  const seq = num(value['seq']);
  const at = num(value['at']);
  const computer = str(value['computer']);
  if (type === null || seq === null || at === null || computer === null) return null;

  const runId = str(value['runId']) ?? str(value['run']);

  if (type === 'attention') {
    if (runId === null) return null;
    const state = value['state'];
    if (state !== 'waiting' && state !== 'cleared') return null;
    const kindRaw = str(value['kind']);
    const event: AttentionEvent = { type: 'attention', seq, at, computer, runId, state };
    if (kindRaw !== null && ATTENTION_KINDS.has(kindRaw)) event.kind = kindRaw as AttentionKind;
    return event;
  }

  if (type === 'run') {
    const state = str(value['state']);
    if (runId === null || state === null || !RUN_STATES.has(state)) return null;
    const event: RunEvent = { type: 'run', seq, at, computer, runId, state: state as RunState };
    const exit = value['exitCode'];
    if (exit === null) event.exitCode = null;
    else if (typeof exit === 'number' && Number.isFinite(exit)) event.exitCode = exit;
    return event;
  }

  if (type === 'state') {
    const state = str(value['state']);
    if (state === null || !COMPUTER_STATES.has(state)) return null;
    const event: StateEvent = { type: 'state', seq, at, computer, state: state as ComputerState };
    return event;
  }

  return null;
}

/** Decode one SSE `data:` payload into an event, or null if unusable. */
export function parseEventData(data: string): MariEvent | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(data);
  } catch {
    return null;
  }
  return parseMariEvent(decoded);
}
