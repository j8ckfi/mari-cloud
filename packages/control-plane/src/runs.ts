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
 *  was requested but before the completion event (spec 5.5).
 *
 *  `interrupted` is spec 5.6's degradation, recorded when the computer's substrate
 *  instance died under a run that had already started: no completion is fabricated
 *  (the run did not complete), the journal is preserved exactly as it is, and one
 *  content-free attention event tells the user. A resume (marid's agent adapter,
 *  same run id) puts such a run back to `running`. */
export type RunStatus =
  | 'queued'
  | 'dispatched'
  | 'running'
  | 'stopping'
  | 'completed'
  | 'cancelled'
  | 'interrupted';

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
    case 'interrupted':
      // The client's state machine has five states (spec 8.3 renders from them)
      // and none of them is "interrupted". `failed` is the honest projection: the
      // run did not finish. WHY it did not is the attention event's job — kind
      // `interrupted`, content-free (spec 6.2/6.3) — not a sixth client state.
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

/**
 * Largest body accepted by the file-write route.
 *
 * It is deliberately EQUAL to `MAX_INLINE_FILE_BYTES` (manifest-store.ts): a
 * file the editor can open is a file the editor can save. A read cap above the
 * write cap means the interface offers a Save button that cannot work (spec 8.5
 * "Upload and download are possible" reads on both directions).
 */
export const MAX_WRITE_BYTES = 1024 * 1024;

/**
 * Largest single argv ELEMENT the write payload is split into.
 *
 * Linux caps one `execve` argument string at `MAX_ARG_STRLEN` = 32 pages =
 * 131072 bytes, INCLUDING its NUL, and the failure is `E2BIG` at spawn — not a
 * truncated write, not an error the shell can report. The whole base64 payload
 * used to be one argv element, so every write whose base64 exceeded 128 KiB (96
 * KiB of raw bytes) failed to spawn at all while the route had already answered
 * `202 {ok:true}`: the user's work was thrown away and reported as saved.
 *
 * 32 KiB leaves a 4x margin against that ceiling on every platform Mari targets
 * (macOS has no per-element cap at all, only a total).
 */
export const MAX_ARGV_ELEMENT_BYTES = 32 * 1024;

/**
 * Budget for the TOTAL exec argument block of a write run.
 *
 * Linux's total is `RLIMIT_STACK / 4` — 2 MiB with the default 8 MiB stack — and
 * counts the environment too. A `MAX_WRITE_BYTES` payload base64-encodes to
 * `ceil(1 MiB / 3) * 4` = 1,398,104 bytes, so the worst case sits at ~1.34 MiB
 * with ~660 KiB of headroom for marid's own environment. `writeArgvBytes` and
 * the test that asserts it against this budget are what keep that arithmetic
 * true if anybody raises the write cap.
 */
export const MAX_ARGV_TOTAL_BYTES = 1_600_000;

/**
 * Default working directory for a run when the caller does not pick one: empty,
 * meaning "the computer's filesystem root".
 *
 * It must NOT be `/`. Spec 2 gives a computer ONE filesystem and spec 4.1 makes
 * the substrate disk of that filesystem the only writable copy; on a substrate
 * whose root is a subdirectory (`MARI_ROOT`, `/work`) the container's `/` is
 * OUTSIDE the computer, so a run that defaulted there wrote files no manifest
 * ever recorded and deep sleep destroyed them. `resolveRunCwd` below turns this
 * into the concrete root before `start_run` goes out — marid's own `cwd`
 * fallback only covers a resumed run, not a fresh one.
 */
export const DEFAULT_CWD = '';

/**
 * The absolute directory a run executes in, resolved against the computer's
 * filesystem root.
 *
 * - no request ⇒ the root itself (`git clone && npm i` then lands in the
 *   computer, which is the only place that survives a deep sleep);
 * - a path already inside the root ⇒ verbatim (a caller that speaks substrate
 *   paths, e.g. `/work/project`, keeps working);
 * - any other absolute path ⇒ interpreted in the computer's OWN filesystem
 *   space, the space the file browser and every manifest path use, and joined
 *   onto the root. `/project` on a `/work`-rooted computer is `/work/project`.
 */
export function resolveRunCwd(root: string, requested?: string | null): string {
  const r = (root ?? '').replace(/\/+$/, '');
  const base = r === '' ? '/' : r;
  let req = (requested ?? '').trim();
  if (req === '') return base;
  if (!req.startsWith('/')) req = '/' + req;
  req = req.replace(/\/+/g, '/');
  if (req.length > 1 && req.endsWith('/')) req = req.slice(0, -1);
  if (base === '/') return req;
  if (req === base || req.startsWith(base + '/')) return req;
  return base + req;
}

/** POSIX single-quote a string for `/bin/sh -c`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function parentDir(path: string): string {
  const idx = path.lastIndexOf('/');
  if (idx <= 0) return '/';
  return path.slice(0, idx);
}

/** Split a base64 payload into argv-sized pieces (never one oversized string). */
export function splitPayload(contentBase64: string, limit = MAX_ARGV_ELEMENT_BYTES): string[] {
  if (contentBase64.length === 0) return [];
  const parts: string[] = [];
  for (let i = 0; i < contentBase64.length; i += limit) {
    parts.push(contentBase64.slice(i, i + limit));
  }
  return parts;
}

/** Bytes an argv occupies in the exec argument block: each string plus its NUL
 *  terminator plus a pointer. This is what the kernel counts. */
export function writeArgvBytes(argv: readonly string[]): number {
  let total = 0;
  for (const a of argv) total += a.length + 1 + 8;
  return total;
}

/**
 * The argv for a file-write run.
 *
 * Three properties, each of which was a defect before:
 *
 * 1. **The payload is never one argv string.** It is split into
 *    `MAX_ARGV_ELEMENT_BYTES` pieces passed as the script's positional
 *    parameters and re-joined by `printf '%s' "$@"` (POSIX: the format is reused
 *    for every operand, so the pieces concatenate with nothing between them).
 *    That keeps every element far below `MAX_ARG_STRLEN`, so the spawn cannot
 *    fail with `E2BIG` while the API has already reported success.
 * 2. **The file is replaced atomically.** The decode writes a sibling temp file
 *    and `mv`s it over the target, so a failed or partial decode leaves the
 *    previous content intact instead of a truncated file. `> target` truncates
 *    before `base64` has produced a byte.
 * 3. **The temp path is unique per run** (`token`), so two concurrent writes to
 *    one path cannot clobber each other's staging file.
 *
 * `set -e` still makes a failed `mkdir`/decode a non-zero exit the run history
 * records honestly.
 */
export function writeRunArgv(path: string, contentBase64: string, token = 'w'): string[] {
  const tmp = `${path}.mari-${token}.part`;
  const script =
    `set -e; mkdir -p ${shellQuote(parentDir(path))}; ` +
    // The staging path goes in a variable so the EXIT trap can name it without
    // re-quoting: a failed decode must not leave a half-written `.part` file on
    // the disk for the next snapshot to commit into the manifest. After a
    // successful `mv` the trap's `rm -f` finds nothing, which is what `-f` is for.
    `T=${shellQuote(tmp)}; trap 'rm -f "$T"' EXIT; ` +
    `printf '%s' "$@" | base64 -d > "$T"; ` +
    `mv -f "$T" ${shellQuote(path)}`;
  // `$0` for `sh -c`; the payload pieces are `$1`, `$2`, ... i.e. `"$@"`.
  return ['/bin/sh', '-c', script, 'mari-write', ...splitPayload(contentBase64)];
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
