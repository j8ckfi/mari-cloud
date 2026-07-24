// GridEngine v0 (MiniVtEngine): a real VT state machine, asserted at the cell
// level — printing, CR/LF, wrap, cursor motion, erase, and SGR color.
import { describe, it, expect } from 'vitest';
import { MiniVtEngine } from '../src/grid';

const enc = (s: string) => new TextEncoder().encode(s);

describe('MiniVtEngine', () => {
  it('prints text and tracks the cursor', () => {
    const e = new MiniVtEngine(20, 5);
    e.write(enc('hello'));
    const g = e.snapshot();
    expect(g.cells[0]!.slice(0, 5).map((c) => c.ch).join('')).toBe('hello');
    expect(g.cursorRow).toBe(0);
    expect(g.cursorCol).toBe(5);
  });

  it('handles CR + LF as column reset + new line', () => {
    const e = new MiniVtEngine(20, 5);
    e.write(enc('ab\r\ncd'));
    const g = e.snapshot();
    expect(g.cells[0]!.slice(0, 2).map((c) => c.ch).join('')).toBe('ab');
    expect(g.cells[1]!.slice(0, 2).map((c) => c.ch).join('')).toBe('cd');
    expect(g.cursorRow).toBe(1);
    expect(g.cursorCol).toBe(2);
  });

  it('wraps at the right margin', () => {
    const e = new MiniVtEngine(3, 3);
    e.write(enc('abcd'));
    const g = e.snapshot();
    expect(g.cells[0]!.map((c) => c.ch).join('')).toBe('abc');
    expect(g.cells[1]![0]!.ch).toBe('d');
  });

  it('scrolls when output exceeds the last row', () => {
    const e = new MiniVtEngine(4, 2);
    // Three lines into a 2-row grid: the first line scrolls off the top.
    e.write(enc('11\r\n22\r\n33'));
    const g = e.snapshot();
    expect(g.cells[0]!.map((c) => c.ch).join('').trimEnd()).toBe('22');
    expect(g.cells[1]!.map((c) => c.ch).join('').trimEnd()).toBe('33');
    expect(g.cursorRow).toBe(1);
  });

  it('applies SGR foreground color and bold, then resets', () => {
    const e = new MiniVtEngine(20, 2);
    e.write(enc('\x1b[1;31mRED\x1b[0mx'));
    const g = e.snapshot();
    const r = g.cells[0]!;
    expect(r[0]!.ch).toBe('R');
    expect(r[0]!.fg).toBe(0xcd0000); // palette red (index 1)
    expect(r[0]!.attrs & 1).toBe(1); // bold bit
    // After reset, 'x' is default fg and not bold.
    expect(r[3]!.ch).toBe('x');
    expect(r[3]!.fg).toBe(-1);
    expect(r[3]!.attrs & 1).toBe(0);
  });

  it('honors CUP absolute cursor positioning', () => {
    const e = new MiniVtEngine(10, 5);
    e.write(enc('\x1b[3;5HZ'));
    const g = e.snapshot();
    expect(g.cells[2]![4]!.ch).toBe('Z');
  });

  it('erases to end of line with CSI K', () => {
    const e = new MiniVtEngine(10, 2);
    e.write(enc('abcdef'));
    e.write(enc('\x1b[3G')); // cursor to column 3 (0-based col 2)
    e.write(enc('\x1b[0K')); // erase from cursor to end of line
    const g = e.snapshot();
    expect(g.cells[0]!.map((c) => c.ch).join('').trimEnd()).toBe('ab');
  });
});
