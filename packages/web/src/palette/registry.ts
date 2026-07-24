// Command palette registry + fuzzy filter (spec 8.1: "A command palette (Cmd+K)
// gives all commands. Full keyboard operation must be possible.").
//
// The palette is a registry that every feature registers commands into. The UI
// is a thin view over `filterCommands`. Both the registry and the fuzzy matcher
// are pure and independently tested; the React layer only calls `run()` on the
// selected command.

/** One invokable command. */
export interface Command {
  /** Stable unique id, e.g. `wm.split.right`. */
  id: string;
  /** Display title shown in the palette, e.g. "Split pane right". */
  title: string;
  /** Optional grouping label, e.g. "Window". */
  group?: string;
  /** Extra searchable terms not shown in the title. */
  keywords?: string[];
  /** Optional keybinding hint shown right-aligned, e.g. "⌘K". */
  hint?: string;
  /** Whether the command is currently actionable. Disabled commands still list. */
  enabled?: boolean;
  /** Effect. May be async; the palette closes before awaiting. */
  run: () => void | Promise<void>;
}

/** A command paired with its fuzzy-match result, for rendering highlights. */
export interface ScoredCommand {
  command: Command;
  score: number;
  /** Indices into `title` (lowercased length) that matched the query. */
  matched: number[];
}

/**
 * A mutable command registry. Later registration of the same id replaces the
 * earlier one (so a feature can update a command's `enabled`/`run` in place).
 * Insertion order is preserved and used as the stable tiebreak in results.
 */
export class CommandRegistry {
  #order: string[] = [];
  #byId = new Map<string, Command>();

  /** Register (or replace) a command. Returns a disposer that unregisters it. */
  register(command: Command): () => void {
    if (!this.#byId.has(command.id)) this.#order.push(command.id);
    this.#byId.set(command.id, command);
    return () => this.unregister(command.id);
  }

  /** Register many commands; returns a disposer removing all of them. */
  registerAll(commands: Command[]): () => void {
    const disposers = commands.map((c) => this.register(c));
    return () => disposers.forEach((d) => d());
  }

  unregister(id: string): void {
    if (!this.#byId.has(id)) return;
    this.#byId.delete(id);
    this.#order = this.#order.filter((x) => x !== id);
  }

  get(id: string): Command | undefined {
    return this.#byId.get(id);
  }

  /** All commands in registration order. */
  list(): Command[] {
    return this.#order.map((id) => this.#byId.get(id)).filter((c): c is Command => c !== undefined);
  }

  size(): number {
    return this.#byId.size;
  }

  /** Filter + rank the registry against a query. Empty query returns all. */
  filter(query: string): ScoredCommand[] {
    return filterCommands(this.list(), query);
  }
}

/**
 * Rank `commands` against `query`. An empty (or whitespace) query returns every
 * command in registration order, unscored. A non-empty query keeps only
 * subsequence matches (matched against `title`, `group`, and `keywords`) and
 * sorts by descending score, then by registration order for stable ties.
 */
export function filterCommands(commands: Command[], query: string): ScoredCommand[] {
  const q = query.trim();
  if (q === '') {
    return commands.map((command) => ({ command, score: 0, matched: [] }));
  }
  const scored: Array<ScoredCommand & { index: number }> = [];
  commands.forEach((command, index) => {
    const titleMatch = fuzzyMatch(command.title, q);
    // Also try the auxiliary haystack (group + keywords) but never surface its
    // match indices (they don't map onto the title we render).
    const auxHaystack = [command.group ?? '', ...(command.keywords ?? [])].join(' ');
    const auxMatch = auxHaystack.trim() === '' ? null : fuzzyMatch(auxHaystack, q);

    let best: { score: number; matched: number[] } | null = null;
    if (titleMatch) best = { score: titleMatch.score, matched: titleMatch.matched };
    if (auxMatch) {
      // Aux matches are worth less than a title match; only take them when the
      // title didn't match or the aux score (penalized) is higher.
      const penalized = auxMatch.score - 1000;
      if (best === null || penalized > best.score) best = { score: penalized, matched: [] };
    }
    if (best !== null) {
      scored.push({ command, score: best.score, matched: best.matched, index });
    }
  });

  scored.sort((a, b) => (b.score - a.score) || (a.index - b.index));
  return scored.map(({ command, score, matched }) => ({ command, score, matched }));
}

/**
 * Fuzzy subsequence match of `query` against `text`, case-insensitive. Returns
 * null if `query` is not a subsequence of `text`. The score rewards, in order
 * of weight: matching the very start of the text, matches at word boundaries
 * (after a space, `-`, `_`, `.`, `/`, or a case bump), and consecutive
 * matches. Shorter texts win ties (a query is "more of" a short title).
 */
export function fuzzyMatch(
  text: string,
  query: string,
): { score: number; matched: number[] } | null {
  const hay = text.toLowerCase();
  const needle = query.toLowerCase();
  if (needle.length === 0) return { score: 0, matched: [] };

  const matched: number[] = [];
  let score = 0;
  let hi = 0;
  let prevMatch = -2;

  for (let ni = 0; ni < needle.length; ni += 1) {
    const ch = needle[ni] as string;
    let foundAt = -1;
    for (; hi < hay.length; hi += 1) {
      if (hay[hi] === ch) {
        foundAt = hi;
        break;
      }
    }
    if (foundAt === -1) return null; // not a subsequence
    matched.push(foundAt);

    // Base point for any match.
    score += 1;
    if (foundAt === 0) score += 12; // match at very start
    else if (isBoundary(text, foundAt)) score += 8; // word-boundary match
    if (foundAt === prevMatch + 1) score += 5; // consecutive run

    prevMatch = foundAt;
    hi = foundAt + 1;
  }

  // Prefer shorter haystacks and earlier overall placement.
  score -= text.length * 0.1;
  score -= (matched[0] as number) * 0.5;
  return { score, matched };
}

const BOUNDARY_BEFORE = new Set([' ', '-', '_', '.', '/', ':', '\t']);

/** Whether position `i` in `text` begins a word (boundary char before, or camel). */
function isBoundary(text: string, i: number): boolean {
  if (i <= 0) return true;
  const prev = text[i - 1] as string;
  if (BOUNDARY_BEFORE.has(prev)) return true;
  const cur = text[i] as string;
  // camelCase bump: lowercase→uppercase.
  return prev === prev.toLowerCase() && cur !== cur.toLowerCase() && cur === cur.toUpperCase();
}
