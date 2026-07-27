// The terminal pane's one-line lifecycle status (spec 8.3).
//
// A terminal pane attaches the moment it mounts, but the computer behind it
// may be COLD (a wake is in flight behind the interface) and the socket may
// drop at any time (laptop sleep, a deploy, a substrate migration). The spec
// forbids a spinner in front of the interface, so what the pane shows instead
// is one line of TEXT saying exactly what is being waited on — and nothing at
// all once the run is live. Pure so it can be tested against every
// (data, socket, computer-state) combination without xterm or a server.

import type { ComputerState } from '@mari/shared';

/** What the pane's status strip should show, or null for nothing. */
export interface TerminalStatus {
  /** Machine-readable phase, for tests and styling. */
  phase: 'waking' | 'connecting' | 'reconnecting';
  /** The one line of text. */
  text: string;
}

/**
 * Decide the status line from what the pane knows.
 *
 * @param sawData   whether the attach socket ever delivered grid/frame/status
 * @param socketUp  whether the attach socket is currently open
 * @param state     the computer's lifecycle state, if known (fleet + events)
 */
export function terminalStatus(
  sawData: boolean,
  socketUp: boolean,
  state: ComputerState | null,
): TerminalStatus | null {
  if (!sawData) {
    // Before the first byte: say what is actually happening. A COLD or WAKING
    // computer is being woken behind the pane (spec 8.3) and a cold start has
    // a real, honest duration worth setting expectations for.
    if (state === 'cold' || state === 'waking') {
      return {
        phase: 'waking',
        text: 'Waking your computer — a cold start usually takes 10-30 s. Output appears the moment it answers.',
      };
    }
    return {
      phase: 'connecting',
      text: 'Connecting to the run — output appears as soon as the computer answers.',
    };
  }
  // After the run was live: a dropped socket reconnects with backoff on its
  // own. Nothing is lost — the supervisor owns the run (spec 5.1) and the
  // journal replays what was missed — so the line says that, quietly.
  if (!socketUp) {
    return {
      phase: 'reconnecting',
      text: 'Reconnecting — the run keeps going on the computer; missed output replays when the connection returns.',
    };
  }
  return null;
}
