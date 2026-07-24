// Semantic terminal — GridEngine interface + v0 implementation.
//
// decisions.md v0 deviation 1: spec 7.2 names libghostty-vt as the semantic
// terminal (native + a Wasm module in the control plane). v0 ships a
// `GridEngine` interface with a minimal VT state machine behind it. `@xterm/
// headless` was NOT adopted here: it is a DOM-oriented package and is not a
// dependency of this workerd-targeted package, so the control plane carries its
// own small, dependency-free VT parser. marid streams raw journal bytes and
// keeps no grid; the control plane renders the grid from those bytes.
//
// >>> libghostty-vt swap point <<<
// Replace `MiniVtEngine` with a libghostty-vt-backed engine implementing the
// same `GridEngine` interface; nothing else in the control plane changes.

import type { GridCell, GridSnapshot } from '@mari/shared';

/** A server-side terminal grid fed raw journal bytes, yielding a snapshot the
 *  attach protocol (`DoGridSnapshot`) delivers to xterm.js clients. */
export interface GridEngine {
  /** Feed raw terminal output bytes. */
  write(bytes: Uint8Array): void;
  /** Current rendered grid (spec 7.3 "current grid, not a replay"). */
  snapshot(): GridSnapshot;
  /** Resize the grid, preserving as much content as fits. */
  resize(cols: number, rows: number): void;
}

const DEFAULT_FG = -1;
const DEFAULT_BG = -1;

// SGR attribute bit flags packed into GridCell.attrs.
const ATTR_BOLD = 1 << 0;
const ATTR_ITALIC = 1 << 1;
const ATTR_UNDERLINE = 1 << 2;
const ATTR_INVERSE = 1 << 3;

// Standard 16-color palette as 0xRRGGBB (indices 0..15).
const PALETTE_16 = [
  0x000000, 0xcd0000, 0x00cd00, 0xcdcd00, 0x0000ee, 0xcd00cd, 0x00cdcd, 0xe5e5e5,
  0x7f7f7f, 0xff0000, 0x00ff00, 0xffff00, 0x5c5cff, 0xff00ff, 0x00ffff, 0xffffff,
];

function blank(): GridCell {
  return { ch: ' ', attrs: 0, fg: DEFAULT_FG, bg: DEFAULT_BG };
}

/**
 * A deliberately small VT parser: enough of ECMA-48 to render agent/terminal
 * output faithfully (printable text with wrap, CR/LF/BS/TAB, cursor motion,
 * erase, and SGR color/bold/underline/inverse), with unknown sequences skipped
 * rather than corrupting the grid. It is NOT a conformant terminal — it is the
 * v0 stand-in for libghostty-vt (see swap point above).
 */
export class MiniVtEngine implements GridEngine {
  #cols: number;
  #rows: number;
  #grid: GridCell[][];
  #cx = 0;
  #cy = 0;
  #cursorVisible = true;

  // Pending SGR state applied to newly printed cells.
  #fg = DEFAULT_FG;
  #bg = DEFAULT_BG;
  #attrs = 0;

  // Parser state.
  #state: 'ground' | 'esc' | 'csi' = 'ground';
  #params: number[] = [];
  #curParam = '';
  #decoder = new TextDecoder();

  constructor(cols = 80, rows = 24) {
    this.#cols = Math.max(1, cols | 0);
    this.#rows = Math.max(1, rows | 0);
    this.#grid = this.#emptyGrid(this.#cols, this.#rows);
  }

  #emptyGrid(cols: number, rows: number): GridCell[][] {
    const g: GridCell[][] = [];
    for (let r = 0; r < rows; r++) {
      const row: GridCell[] = [];
      for (let c = 0; c < cols; c++) row.push(blank());
      g.push(row);
    }
    return g;
  }

  resize(cols: number, rows: number): void {
    const nc = Math.max(1, cols | 0);
    const nr = Math.max(1, rows | 0);
    const next = this.#emptyGrid(nc, nr);
    for (let r = 0; r < Math.min(nr, this.#rows); r++) {
      for (let c = 0; c < Math.min(nc, this.#cols); c++) {
        // Non-null: bounded by the mins above.
        next[r]![c] = this.#grid[r]![c]!;
      }
    }
    this.#grid = next;
    this.#cols = nc;
    this.#rows = nr;
    this.#cx = Math.min(this.#cx, nc - 1);
    this.#cy = Math.min(this.#cy, nr - 1);
  }

  write(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i]!;
      switch (this.#state) {
        case 'ground':
          this.#ground(b);
          break;
        case 'esc':
          this.#esc(b);
          break;
        case 'csi':
          this.#csi(b);
          break;
      }
    }
  }

  #ground(b: number): void {
    switch (b) {
      case 0x1b: // ESC
        this.#state = 'esc';
        return;
      case 0x0d: // CR
        this.#cx = 0;
        return;
      case 0x0a: // LF
      case 0x0b: // VT
      case 0x0c: // FF
        this.#lineFeed();
        return;
      case 0x08: // BS
        if (this.#cx > 0) this.#cx--;
        return;
      case 0x09: { // TAB -> next multiple of 8
        const next = (Math.floor(this.#cx / 8) + 1) * 8;
        this.#cx = Math.min(next, this.#cols - 1);
        return;
      }
      case 0x07: // BEL — no visual effect on the grid
        return;
      default:
        if (b < 0x20) return; // other C0 controls ignored
        this.#print(b);
    }
  }

  #print(b: number): void {
    // v0 renders bytes as Latin-1/ASCII code points. Multi-byte UTF-8 is
    // approximated per-byte; the libghostty-vt swap handles graphemes properly.
    let ch: string;
    if (b < 0x80) ch = String.fromCharCode(b);
    else ch = this.#decoder.decode(new Uint8Array([b]));
    if (this.#cx >= this.#cols) {
      // Wrap to the next line.
      this.#cx = 0;
      this.#lineFeed();
    }
    this.#grid[this.#cy]![this.#cx] = {
      ch,
      attrs: this.#attrs,
      fg: this.#fg,
      bg: this.#bg,
    };
    this.#cx++;
  }

  #lineFeed(): void {
    if (this.#cy < this.#rows - 1) {
      this.#cy++;
    } else {
      // Scroll up one line.
      this.#grid.shift();
      const row: GridCell[] = [];
      for (let c = 0; c < this.#cols; c++) row.push(blank());
      this.#grid.push(row);
    }
  }

  #esc(b: number): void {
    if (b === 0x5b) { // '['
      this.#state = 'csi';
      this.#params = [];
      this.#curParam = '';
      return;
    }
    // Unsupported ESC-x sequences (e.g. ESC ( charset): swallow one byte.
    this.#state = 'ground';
  }

  #csi(b: number): void {
    // Parameter bytes 0x30-0x3f (digits, ';', '?', etc.).
    if (b >= 0x30 && b <= 0x3f) {
      const ch = String.fromCharCode(b);
      if (ch === ';') {
        this.#params.push(this.#curParam === '' ? 0 : parseInt(this.#curParam, 10));
        this.#curParam = '';
      } else if (ch >= '0' && ch <= '9') {
        this.#curParam += ch;
      }
      // '?' and other private markers are ignored for v0.
      return;
    }
    // Intermediate bytes 0x20-0x2f: ignore.
    if (b >= 0x20 && b <= 0x2f) return;
    // Final byte 0x40-0x7e: dispatch.
    if (b >= 0x40 && b <= 0x7e) {
      this.#params.push(this.#curParam === '' ? 0 : parseInt(this.#curParam, 10));
      this.#dispatchCsi(String.fromCharCode(b));
      this.#state = 'ground';
      return;
    }
    // Anything else aborts the sequence.
    this.#state = 'ground';
  }

  #dispatchCsi(final: string): void {
    const p = this.#params;
    const first = p[0] ?? 0;
    switch (final) {
      case 'H': // CUP row;col (1-based)
      case 'f': {
        const row = (p[0] ?? 1) || 1;
        const col = (p[1] ?? 1) || 1;
        this.#cy = Math.min(Math.max(row - 1, 0), this.#rows - 1);
        this.#cx = Math.min(Math.max(col - 1, 0), this.#cols - 1);
        return;
      }
      case 'A': // cursor up
        this.#cy = Math.max(this.#cy - (first || 1), 0);
        return;
      case 'B': // cursor down
        this.#cy = Math.min(this.#cy + (first || 1), this.#rows - 1);
        return;
      case 'C': // cursor forward
        this.#cx = Math.min(this.#cx + (first || 1), this.#cols - 1);
        return;
      case 'D': // cursor back
        this.#cx = Math.max(this.#cx - (first || 1), 0);
        return;
      case 'G': // cursor to column
        this.#cx = Math.min(Math.max((first || 1) - 1, 0), this.#cols - 1);
        return;
      case 'J': // erase in display
        this.#eraseDisplay(first);
        return;
      case 'K': // erase in line
        this.#eraseLine(first);
        return;
      case 'm': // SGR
        this.#sgr(p);
        return;
      case 'h': // set mode (only DECTCEM ?25 tracked)
        if (p.includes(25)) this.#cursorVisible = true;
        return;
      case 'l':
        if (p.includes(25)) this.#cursorVisible = false;
        return;
      default:
        return; // unsupported CSI ignored
    }
  }

  #eraseLine(mode: number): void {
    const row = this.#grid[this.#cy]!;
    const from = mode === 1 ? 0 : this.#cx;
    const to = mode === 1 ? this.#cx : this.#cols - 1;
    const all = mode === 2;
    for (let c = all ? 0 : from; c <= (all ? this.#cols - 1 : to); c++) row[c] = blank();
  }

  #eraseDisplay(mode: number): void {
    if (mode === 2) {
      this.#grid = this.#emptyGrid(this.#cols, this.#rows);
      return;
    }
    if (mode === 0) {
      this.#eraseLine(0);
      for (let r = this.#cy + 1; r < this.#rows; r++) this.#grid[r] = this.#blankRow();
    } else if (mode === 1) {
      this.#eraseLine(1);
      for (let r = 0; r < this.#cy; r++) this.#grid[r] = this.#blankRow();
    }
  }

  #blankRow(): GridCell[] {
    const row: GridCell[] = [];
    for (let c = 0; c < this.#cols; c++) row.push(blank());
    return row;
  }

  #sgr(params: number[]): void {
    if (params.length === 0) params = [0];
    for (let i = 0; i < params.length; i++) {
      const n = params[i]!;
      if (n === 0) {
        this.#fg = DEFAULT_FG;
        this.#bg = DEFAULT_BG;
        this.#attrs = 0;
      } else if (n === 1) this.#attrs |= ATTR_BOLD;
      else if (n === 3) this.#attrs |= ATTR_ITALIC;
      else if (n === 4) this.#attrs |= ATTR_UNDERLINE;
      else if (n === 7) this.#attrs |= ATTR_INVERSE;
      else if (n === 22) this.#attrs &= ~ATTR_BOLD;
      else if (n === 23) this.#attrs &= ~ATTR_ITALIC;
      else if (n === 24) this.#attrs &= ~ATTR_UNDERLINE;
      else if (n === 27) this.#attrs &= ~ATTR_INVERSE;
      else if (n >= 30 && n <= 37) this.#fg = PALETTE_16[n - 30]!;
      else if (n === 39) this.#fg = DEFAULT_FG;
      else if (n >= 40 && n <= 47) this.#bg = PALETTE_16[n - 40]!;
      else if (n === 49) this.#bg = DEFAULT_BG;
      else if (n >= 90 && n <= 97) this.#fg = PALETTE_16[8 + (n - 90)]!;
      else if (n >= 100 && n <= 107) this.#bg = PALETTE_16[8 + (n - 100)]!;
      else if (n === 38 || n === 48) {
        // Extended color: 38;5;idx or 38;2;r;g;b.
        const mode = params[i + 1];
        if (mode === 5) {
          const idx = params[i + 2] ?? 0;
          const color = this.#xterm256(idx);
          if (n === 38) this.#fg = color;
          else this.#bg = color;
          i += 2;
        } else if (mode === 2) {
          const r = params[i + 2] ?? 0;
          const g = params[i + 3] ?? 0;
          const b = params[i + 4] ?? 0;
          const color = ((r & 0xff) << 16) | ((g & 0xff) << 8) | (b & 0xff);
          if (n === 38) this.#fg = color;
          else this.#bg = color;
          i += 4;
        }
      }
    }
  }

  #xterm256(idx: number): number {
    if (idx < 16) return PALETTE_16[idx]!;
    if (idx >= 16 && idx <= 231) {
      const n = idx - 16;
      const r = Math.floor(n / 36);
      const g = Math.floor((n % 36) / 6);
      const b = n % 6;
      const conv = (v: number) => (v === 0 ? 0 : 55 + v * 40);
      return (conv(r) << 16) | (conv(g) << 8) | conv(b);
    }
    const gray = 8 + (idx - 232) * 10;
    return (gray << 16) | (gray << 8) | gray;
  }

  snapshot(): GridSnapshot {
    // Deep-copy cells so callers cannot mutate engine state.
    const cells: GridCell[][] = this.#grid.map((row) =>
      row.map((cell) => ({ ch: cell.ch, attrs: cell.attrs, fg: cell.fg, bg: cell.bg })),
    );
    return {
      cols: this.#cols,
      rows: this.#rows,
      cells,
      cursorCol: this.#cx,
      cursorRow: this.#cy,
      cursorVisible: this.#cursorVisible,
    };
  }
}
