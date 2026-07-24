// Run records and the file-write-as-a-run encoding.
//
// A run is owned by the supervisor (spec 5.1); the control plane only records
// what it asked for and what came back. These types are the flat, structured-
// clone-safe shapes that cross the Durable Object RPC boundary and the REST
// surface.
//
// FILE WRITES ARE RUNS. Spec 4.1 is absolute: "The substrate disk of an AWAKE
// computer is the only copy that accepts writes." The control plane therefore
// must not synthesize chunks/manifests behind the supervisor's back for an
// editor Save — it expresses the write as a small run that the supervisor
// executes on the substrate disk, which additionally gives the write a pre-run
// snapshot, a journal, and a post-run diff for free (spec 5.2/5.3). No new
// marid control message is needed: `start_run` already carries everything.

/** Lifecycle of a run as the control plane sees it. `queued`/`dispatched` are
 *  the window before the supervisor's `run_started`; `stopping` is after a stop
 *  was requested but before the completion event (spec 5.5). */
export type RunStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'cancelled';

/** The run lifecycle as the WEB client models it (`RunState`). */
export type RunClientState = 'pending' | 'running' | 'stopping' | 'exited' | 'failed';

/** Project the control plane's run status onto the client's state machine. */
export function clientRunState(status: RunStatus, exitKind: string | null): RunClientState {
  switch (status) {
    case 'queued':
    case 'dispatched':
      return 'pending';
    case 'running':
      return 'running';
    case 'stopping':
      return 'stopping';
    case 'cancelled':
      return 'failed';
    case 'completed':
      // A signaled process did not exit on its own terms; the client shows that
      // as a failure, and the signal number is reported separately.
      return exitKind === 'signaled' ? 'failed' : 'exited';
  }
}

/** What the user does with a run's changes (spec 5.3). */
export type RunDisposition = 'pending' | 'kept' | 'reverted';

/** Why the control plane started this run. */
export type RunKind = 'command' | 'write';

/** How a run's process ended (mirrors `ExitStatus` flattened for JSON). */
export interface RunExit {
  kind: 'exited' | 'signaled';
  /** Exit code for `exited`, signal number for `signaled`. */
  code: number;
}

/** One run as stored in the DO and rendered by the REST layer. */
export interface RunRecord {
  id: string;
  kind: RunKind;
  argv: string[];
  cwd: string;
  envNames: string[];
  agent: string | null;
  status: RunStatus;
  /** True once `start_run` has been handed to a supervisor (exactly once). */
  dispatched: boolean;
  queuedAt: number;
  dispatchedAt: number | null;
  startedAt: number | null;
  endedAt: number | null;
  /** The diff baseline (spec 5.2), reported by `run_started`. */
  preManifest: string | null;
  /** The manifest after the run, reported by `run_completed`. */
  postManifest: string | null;
  exit: RunExit | null;
  diff: { added: number; modified: number; removed: number } | null;
  disposition: RunDisposition;
  dispositionAt: number | null;
  /** Undismissed attention events raised by this run (spec 6.2). */
  attention: number;
  /** The fencing epoch the run was dispatched under (0 while queued). */
  epoch: number;
  /** For a `write` run: the path it writes. */
  writePath: string | null;
}

/** A run plus its journal tail, for the detail view. */
export interface RunDetail extends RunRecord {
  /** Total journal bytes durably held by the DO for this run. */
  journalLength: number;
  /** Offset the tail starts at (`journalLength - tail.length`). */
  journalTailOffset: number;
  /** Base64 of the last {@link JOURNAL_TAIL_BYTES} journal bytes. */
  journalTail: string;
  journalTailEncoding: 'base64';
}

/** How much journal the run-detail route returns (spec 8.3 renders from this). */
export const JOURNAL_TAIL_BYTES = 8 * 1024;

/** Largest body accepted by the file-write route. The write travels inside a
 *  run's argv (below), so it must stay far under any exec argument ceiling. */
export const MAX_WRITE_BYTES = 256 * 1024;

/** Default working directory for a run when the caller does not pick one. */
export const DEFAULT_CWD = '/';

/** POSIX single-quote a string for `/bin/sh -c`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

/**
 * The argv for a file-write run: create the parent directory, then decode the
 * base64 payload onto the path. `printf '%s'` (not `echo`) keeps the payload
 * literal, and `set -e` makes a failed mkdir a non-zero exit the run history
 * records honestly.
 */
export function writeRunArgv(path: string, contentBase64: string): string[] {
  const script =
    `set -e; mkdir -p ${shellQuote(parentDir(path))}; ` +
    `printf '%s' ${shellQuote(contentBase64)} | base64 -d > ${shellQuote(path)}`;
  return ['/bin/sh', '-c', script];
}

/** Validate an absolute write target. Returns the normalized path or null. */
export function normalizeWritePath(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  let p = raw.trim();
  if (p === '') return null;
  if (!p.startsWith('/')) p = '/' + p;
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) return null; // a directory is not a write target
  if (p.split('/').includes('..')) return null; // no traversal
  if (p.includes('\0') || p.includes('\n')) return null;
  return p;
}
