// Local-echo prediction for the terminal pane (spec 7.5: "The client applies
// local echo prediction to input (the mosh method). A substrate migration must
// not stop the input.").
//
// This is the simplified-mosh v0 described in the build brief: we predict the
// echo of *printable* keystrokes and *backspace* locally, mark the predicted
// cells, and reconcile them against the authoritative byte stream that arrives
// in journal frames. Predictions live in a FIFO queue; each authoritative echo
// byte either CONFIRMS the head prediction (it matched) or CORRECTS it (a wrong
// prediction is discarded along with everything queued behind it, and the
// authoritative bytes win). Reconciliation is byte-exact and order-preserving,
// so it can be pinned down by table-driven tests including mispredictions.
//
// Scope (honest v0): a single logical input row. That is enough to predict the
// echo of what the user is typing at the prompt without a full VT emulator —
// the authoritative grid still comes from the control-plane GridEngine and is
// rendered by xterm.js (spec 7.4); this overlay only hides input latency.

const DEL = 0x7f;
const BS = 0x08;
const CR = 0x0d;
const LF = 0x0a;

/** A queued prediction: one printable echo, or one backspace erase. */
export type Prediction =
  | { kind: 'char'; col: number; ch: string }
  | { kind: 'backspace'; col: number };

/** The predicted display of the input row, for the renderer and for tests. */
export interface Overlay {
  /** Dense row cells (index = column); unwritten cells are a single space. */
  cells: string[];
  /** Predicted cursor column. */
  cursor: number;
  /** Columns whose content is predicted (not yet confirmed): render dimmed. */
  marks: number[];
}

/** Result of reconciling a batch of authoritative bytes. */
export interface ReconcileResult {
  overlay: Overlay;
  /** How many predictions were confirmed by this batch. */
  confirmed: number;
  /** True if a wrong prediction was detected and the queue was flushed. */
  corrected: boolean;
}

function isPrintable(b: number): boolean {
  return b >= 0x20 && b <= 0x7e;
}

/** Read a cell, treating out-of-range as blank. */
function cellAt(cells: string[], i: number): string {
  const c = cells[i];
  return c === undefined || c === '' ? ' ' : c;
}

/** Write a cell, growing the row with blanks as needed. */
function setCell(cells: string[], i: number, ch: string): void {
  while (cells.length <= i) cells.push(' ');
  cells[i] = ch;
}

/** Input parser state: escape sequences are never predicted (v0 scope). */
type InputState = 'ground' | 'esc' | 'csi';

const ESC = 0x1b;

export class EchoPredictor {
  /** Authoritative row content, advanced only by reconciled server bytes. */
  #auth: string[] = [];
  /** Authoritative cursor column. */
  #authCursor = 0;
  /** FIFO of predictions not yet confirmed by the server. */
  #pending: Prediction[] = [];
  /** Escape-sequence tracking so we never predict e.g. arrow-key bytes. */
  #inputState: InputState = 'ground';

  /** Current number of outstanding (unconfirmed) predictions. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /** Snapshot of the pending queue (defensive copy), for tests/inspection. */
  get pending(): readonly Prediction[] {
    return this.#pending.slice();
  }

  /** The confirmed (authoritative) cursor column. */
  get authoritativeCursor(): number {
    return this.#authCursor;
  }

  /** The predicted cursor column after applying all pending predictions. */
  predictedCursor(): number {
    let c = this.#authCursor;
    for (const p of this.#pending) c = p.kind === 'char' ? p.col + 1 : p.col;
    return c;
  }

  /**
   * Predict the local echo of input `bytes`. Printable bytes predict the
   * character appearing at the cursor and the cursor advancing; DEL/BS predict
   * the previous cell erased and the cursor retreating (a no-op at column 0).
   * Non-printable, non-backspace bytes are not predicted (they may do anything
   * remotely) and are left entirely to the authoritative stream. Returns the
   * updated overlay.
   */
  input(bytes: Uint8Array): Overlay {
    let cursor = this.predictedCursor();
    for (const b of bytes) {
      // Walk a tiny escape-sequence state machine first: bytes that are part of
      // an ESC / CSI sequence (arrow keys, function keys, …) are consumed
      // without prediction — their remote effect is unknowable locally.
      if (this.#inputState === 'esc') {
        this.#inputState = b === 0x5b /* '[' */ ? 'csi' : 'ground';
        continue;
      }
      if (this.#inputState === 'csi') {
        // A CSI final byte is in 0x40..0x7e; everything before it is a param.
        if (b >= 0x40 && b <= 0x7e) this.#inputState = 'ground';
        continue;
      }
      if (b === ESC) {
        this.#inputState = 'esc';
        continue;
      }
      if (isPrintable(b)) {
        this.#pending.push({ kind: 'char', col: cursor, ch: String.fromCharCode(b) });
        cursor += 1;
      } else if (b === DEL || b === BS) {
        if (cursor > 0) {
          cursor -= 1;
          this.#pending.push({ kind: 'backspace', col: cursor });
        }
        // At column 0 a backspace does nothing; predict nothing.
      }
      // else: other control bytes are unpredicted; ignore for the overlay.
    }
    return this.overlay();
  }

  /**
   * Reconcile a batch of authoritative bytes (from a journal frame) against the
   * pending predictions. Each printable/backspace byte is matched FIFO against
   * the head prediction:
   *   - a matching echo CONFIRMS and dequeues the head;
   *   - a mismatching echo CORRECTS: the head and everything behind it are
   *     dropped, and the authoritative bytes are what remains on screen.
   * Control bytes (CR/LF/other) advance the authoritative row but are not
   * treated as keystroke echoes, so they never consume a prediction.
   */
  reconcile(bytes: Uint8Array): ReconcileResult {
    let confirmed = 0;
    let corrected = false;

    for (const b of bytes) {
      // 1) Advance the authoritative row.
      if (isPrintable(b)) {
        setCell(this.#auth, this.#authCursor, String.fromCharCode(b));
        this.#authCursor += 1;
      } else if (b === DEL) {
        this.#authCursor = Math.max(0, this.#authCursor - 1);
        setCell(this.#auth, this.#authCursor, ' '); // DEL erases
      } else if (b === BS) {
        this.#authCursor = Math.max(0, this.#authCursor - 1); // BS: move only
      } else if (b === CR) {
        this.#authCursor = 0;
      } else if (b === LF) {
        // Single-row model: a newline resets to a fresh input row.
        this.#auth = [];
        this.#authCursor = 0;
        this.#pending = [];
        continue;
      }

      // 2) Match against the head prediction, if this byte is a keystroke echo.
      const head = this.#pending[0];
      if (head === undefined) continue; // nothing predicted: spontaneous output

      if (isPrintable(b)) {
        const echoed = String.fromCharCode(b);
        const wroteCol = this.#authCursor - 1;
        if (head.kind === 'char' && head.ch === echoed && head.col === wroteCol) {
          this.#pending.shift();
          confirmed += 1;
        } else {
          this.#flush();
          corrected = true;
        }
      } else if (b === DEL || b === BS) {
        if (head.kind === 'backspace' && head.col === this.#authCursor) {
          this.#pending.shift();
          confirmed += 1;
        } else {
          this.#flush();
          corrected = true;
        }
      }
      // control bytes: no prediction consumed
    }

    return { overlay: this.overlay(), confirmed, corrected };
  }

  /** Compute the predicted overlay = authoritative row + pending predictions. */
  overlay(): Overlay {
    const cells = this.#auth.slice();
    const marks: number[] = [];
    let cursor = this.#authCursor;
    for (const p of this.#pending) {
      if (p.kind === 'char') {
        setCell(cells, p.col, p.ch);
        marks.push(p.col);
        cursor = p.col + 1;
      } else {
        setCell(cells, p.col, ' ');
        marks.push(p.col);
        cursor = p.col;
      }
    }
    return { cells, cursor, marks };
  }

  /** The predicted row as text, trailing blanks trimmed. */
  predictedText(): string {
    return trimEnd(this.overlay().cells.map((c) => (c === '' ? ' ' : c)).join(''));
  }

  /** The confirmed row as text, trailing blanks trimmed. */
  authoritativeText(): string {
    return trimEnd(this.#auth.map((c) => (c === '' ? ' ' : c)).join(''));
  }

  #flush(): void {
    this.#pending = [];
  }
}

/** Read a cell of an overlay, blank if out of range. Exposed for tests. */
export function overlayCell(overlay: Overlay, col: number): string {
  return cellAt(overlay.cells, col);
}

function trimEnd(s: string): string {
  return s.replace(/ +$/, '');
}
