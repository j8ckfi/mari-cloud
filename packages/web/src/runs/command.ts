// Turning what the user typed into an `argv` (contracts §5.2 `start_run` takes
// `argv: string[]`, never a shell string — the supervisor execs it directly).
//
// A brief's `#!` line is one line of text. A run is the user's business (spec
// 6.3), so this does the least interpretation that still lets a shebang say
// `some-runner --flag "an arg"`: POSIX-ish quoting, nothing else. No globbing,
// no variable expansion, no operators — a runner that wants a shell says so
// (`sh -lc '…'`).

/** The default runner for a brief document (spec 8.5: "a brief … starts as a run"). */
export const BRIEF_RUNNER = 'mari-brief';

/**
 * Split a command line into argv. Honors single quotes (literal), double quotes
 * (backslash escapes `"` and `\` only), and backslash escapes outside quotes.
 * Returns [] for an empty/whitespace line. An unterminated quote is treated as
 * closed at end-of-line rather than throwing: the user is mid-typing, and the
 * interface must not refuse to show them what they have.
 */
export function parseCommandLine(line: string): string[] {
  const argv: string[] = [];
  let cur = '';
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i] as string;

    if (quote === "'") {
      if (ch === "'") quote = null;
      else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null;
      } else if (ch === '\\' && (line[i + 1] === '"' || line[i + 1] === '\\')) {
        cur += line[i + 1] as string;
        i += 1;
      } else {
        cur += ch;
      }
      continue;
    }

    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
      continue;
    }
    if (ch === '\\' && i + 1 < line.length) {
      cur += line[i + 1] as string;
      started = true;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (started) {
        argv.push(cur);
        cur = '';
        started = false;
      }
      continue;
    }
    cur += ch;
    started = true;
  }
  if (started) argv.push(cur);
  return argv;
}

/**
 * The argv for running a brief document (spec 8.5).
 *
 * A brief may name its own runner on a leading `#!` line — the user brings the
 * agents (spec 1.1), so the document says what to run. With no such line the
 * brief is handed to the default runner as `mari-brief <path>`.
 */
export function briefArgv(path: string, text: string): string[] {
  const firstLine = text.split('\n', 1)[0] ?? '';
  const shebang = /^#!\s*(\S.*)$/.exec(firstLine.trim());
  if (shebang) {
    const argv = parseCommandLine(shebang[1] as string);
    if (argv.length > 0) return [...argv, path];
  }
  return [BRIEF_RUNNER, path];
}

/** The directory a path lives in, for a run's `cwd`. */
export function dirnameOf(path: string): string {
  const trimmed = path.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  if (idx <= 0) return '/';
  return trimmed.slice(0, idx);
}
