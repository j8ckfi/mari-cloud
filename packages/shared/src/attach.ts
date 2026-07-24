// Client <-> Durable Object attach protocol (TypeScript-only).
//
// This protocol is NOT part of the supervisor <-> control-plane wire protocol
// (`messages.ts`); it never reaches `marid`. It is what a web-app terminal pane
// speaks to the computer's Durable Object over a browser WebSocket. Because a
// WebSocket already frames messages, these are sent as discrete CBOR messages
// (via `encodeCbor`/`decodeCbor`) rather than the 4-byte length framing used on
// the raw supervisor stream. Full field/flow documentation lives in
// `docs/contracts.md`.
//
// Flow (spec 7.3): on attach the DO replies with the current grid snapshot (not
// a journal replay); it then streams live frames. Input flows
// client -> DO -> supervisor.

import type { JournalOffset, RunId } from './ids';

/** A rendered terminal cell in a grid snapshot. */
export interface GridCell {
  /** The character (may be a grapheme cluster); empty string for blank. */
  ch: string;
  /** Packed SGR attributes (bold/italic/etc.) as a bitfield; 0 = default. */
  attrs: number;
  /** Foreground color as 0xRRGGBB, or -1 for the terminal default. */
  fg: number;
  /** Background color as 0xRRGGBB, or -1 for the terminal default. */
  bg: number;
}

/** The terminal grid at attach time, produced by the control-plane GridEngine. */
export interface GridSnapshot {
  cols: number;
  rows: number;
  /** `rows` rows, each of `cols` cells (row-major). */
  cells: GridCell[][];
  /** Cursor column (0-based). */
  cursorCol: number;
  /** Cursor row (0-based). */
  cursorRow: number;
  /** Whether the cursor is visible. */
  cursorVisible: boolean;
}

// ---- client -> DO ----

/** Attach to a run's terminal. The DO answers with {@link DoGridSnapshot}. */
export interface ClientAttach {
  t: 'attach';
  run: RunId;
  /** Viewport the client can render, so the DO sizes the grid on attach. */
  cols: number;
  rows: number;
}

/** Terminal input; the DO forwards the bytes to the supervisor. */
export interface ClientInput {
  t: 'input';
  run: RunId;
  /** Raw bytes to write to the run's PTY (keystrokes, paste, etc.). */
  bytes: Uint8Array;
}

/** Viewport resize; propagated to the PTY window size. */
export interface ClientResize {
  t: 'resize';
  run: RunId;
  cols: number;
  rows: number;
}

/** Stop receiving live frames for a run. */
export interface ClientDetach {
  t: 'detach';
  run: RunId;
}

/** Any client -> DO message. */
export type ClientToDo = ClientAttach | ClientInput | ClientResize | ClientDetach;

/** Discriminant strings of {@link ClientToDo}. */
export type ClientToDoTag = ClientToDo['t'];

// ---- DO -> client ----

/** The full grid at attach time (spec 7.3: current grid, not a replay). */
export interface DoGridSnapshot {
  t: 'grid';
  run: RunId;
  grid: GridSnapshot;
  /** Journal offset the grid reflects; subsequent frames start here. */
  baseOffset: JournalOffset;
}

/** A live slice of terminal output, applied on top of the last grid/frame. */
export interface DoFrame {
  t: 'frame';
  run: RunId;
  /** Journal offset of the first byte of `bytes`. */
  offset: JournalOffset;
  /** Raw terminal bytes to feed the client's xterm.js instance. */
  bytes: Uint8Array;
}

/** The run's liveness/exit changed (mirrors supervisor lifecycle events). */
export interface DoRunStatus {
  t: 'run_status';
  run: RunId;
  /** True while the run's process is alive. */
  alive: boolean;
  /** Exit code once the process has exited, else `null`. */
  exitCode: number | null;
}

/** Any DO -> client message. */
export type DoToClient = DoGridSnapshot | DoFrame | DoRunStatus;

/** Discriminant strings of {@link DoToClient}. */
export type DoToClientTag = DoToClient['t'];
