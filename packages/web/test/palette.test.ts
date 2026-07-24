import { describe, it, expect } from 'vitest';
import {
  CommandRegistry,
  filterCommands,
  fuzzyMatch,
  type Command,
} from '../src/palette/registry';

function cmd(id: string, title: string, extra: Partial<Command> = {}): Command {
  return { id, title, run: () => {}, ...extra };
}

describe('CommandRegistry', () => {
  it('registers, lists in order, and reports size', () => {
    const r = new CommandRegistry();
    r.register(cmd('a', 'Alpha'));
    r.register(cmd('b', 'Beta'));
    expect(r.size()).toBe(2);
    expect(r.list().map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('replaces a command in place without changing its order', () => {
    const r = new CommandRegistry();
    r.register(cmd('a', 'Alpha'));
    r.register(cmd('b', 'Beta'));
    r.register(cmd('a', 'Alpha v2', { hint: 'X' }));
    expect(r.size()).toBe(2);
    expect(r.list().map((c) => c.id)).toEqual(['a', 'b']);
    expect(r.get('a')!.title).toBe('Alpha v2');
    expect(r.get('a')!.hint).toBe('X');
  });

  it('disposes a registration', () => {
    const r = new CommandRegistry();
    const off = r.register(cmd('a', 'Alpha'));
    off();
    expect(r.get('a')).toBeUndefined();
    expect(r.size()).toBe(0);
  });

  it('registerAll returns a disposer that removes all of them', () => {
    const r = new CommandRegistry();
    const off = r.registerAll([cmd('a', 'Alpha'), cmd('b', 'Beta')]);
    expect(r.size()).toBe(2);
    off();
    expect(r.size()).toBe(0);
  });

  it('actually invokes the selected command', () => {
    const r = new CommandRegistry();
    let ran = 0;
    r.register(cmd('a', 'Alpha', { run: () => void (ran += 1) }));
    r.get('a')!.run();
    expect(ran).toBe(1);
  });
});

describe('filterCommands', () => {
  const commands = [
    cmd('split.right', 'Split pane right'),
    cmd('split.down', 'Split pane down'),
    cmd('close', 'Close pane'),
    cmd('focus.left', 'Focus left'),
    cmd('theme', 'Toggle theme', { keywords: ['dark', 'light'] }),
    cmd('dark', 'Dark mode'),
  ];

  it('returns every command in order for an empty query', () => {
    const out = filterCommands(commands, '   ');
    expect(out.map((s) => s.command.id)).toEqual(commands.map((c) => c.id));
  });

  it('keeps only subsequence matches', () => {
    const ids = filterCommands(commands, 'focus').map((s) => s.command.id);
    expect(ids).toEqual(['focus.left']);
  });

  it('returns nothing when no command matches', () => {
    expect(filterCommands(commands, 'zzzzz')).toEqual([]);
  });

  it('ranks the shortest boundary match first for "pane"', () => {
    const ids = filterCommands(commands, 'pane').map((s) => s.command.id);
    expect(ids[0]).toBe('close'); // "Close pane" is the shortest title
    expect(ids).toContain('split.right');
    expect(ids).toContain('split.down');
  });

  it('ranks a title match above a keyword-only match', () => {
    const ids = filterCommands(commands, 'dark').map((s) => s.command.id);
    // "Dark mode" (title match) must outrank "Toggle theme" (keyword match).
    expect(ids[0]).toBe('dark');
    expect(ids).toContain('theme');
    expect(ids.indexOf('dark')).toBeLessThan(ids.indexOf('theme'));
  });

  it('is stable: equal scores keep registration order', () => {
    const same = [cmd('x1', 'Run task'), cmd('x2', 'Run task')];
    const ids = filterCommands(same, 'run').map((s) => s.command.id);
    expect(ids).toEqual(['x1', 'x2']);
  });
});

describe('fuzzyMatch', () => {
  it('matches a subsequence and reports the matched indices', () => {
    const m = fuzzyMatch('Split pane right', 'sr');
    expect(m).not.toBeNull();
    expect(m!.matched).toEqual([0, 11]);
  });

  it('is case-insensitive', () => {
    expect(fuzzyMatch('Split', 'SPLIT')).not.toBeNull();
    expect(fuzzyMatch('SPLIT', 'split')).not.toBeNull();
  });

  it('returns null when the query is not a subsequence', () => {
    expect(fuzzyMatch('abc', 'ba')).toBeNull();
    expect(fuzzyMatch('abc', 'abcd')).toBeNull();
  });

  it('scores a start-of-string match above a mid-word match', () => {
    const start = fuzzyMatch('pane close', 'pane')!;
    const mid = fuzzyMatch('close pane', 'pane')!;
    expect(start.score).toBeGreaterThan(mid.score);
  });

  it('scores consecutive matches above scattered ones', () => {
    const consec = fuzzyMatch('abcdef', 'abc')!;
    const scattered = fuzzyMatch('axbxcx', 'abc')!;
    expect(consec.score).toBeGreaterThan(scattered.score);
  });

  it('rewards word-boundary matches (after a separator)', () => {
    const boundary = fuzzyMatch('run-brief', 'b')!; // 'b' after '-'
    const inWord = fuzzyMatch('robber', 'b')!; // 'b' mid-word
    expect(boundary.score).toBeGreaterThan(inWord.score);
  });
});
