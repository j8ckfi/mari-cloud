// Opening a terminal pane on a REAL run (spec 7.1: "a terminal pane is a view of
// a run. It is not the owner of a process").
//
// The "+ Terminal" button and the palette's "New terminal pane" both used to do
// `addPane({ kind: 'terminal', run: 'shell' })` — a pane bound to the literal run
// id `'shell'`, which no supervisor has ever heard of. The pane mounted, attached
// to nothing, and stayed permanently blank with the title "Terminal · shell". The
// most obvious affordance for spec 7's headline pane was dead, and the working
// path (the Runs pane's per-run Terminal button) was three clicks away.
//
// A terminal is a view OF something, so the button has to create that something:
// start an interactive shell run, then open the pane bound to the run id the
// control plane returned.

import { startRun } from '../api/client';
import { shortRunId } from './state';
import { uiStore } from '../store/ui';

/**
 * The interactive shell a terminal pane starts.
 *
 * `/bin/sh` because it is the one interpreter every base image has (spec 1.1:
 * everything else the user brings), and `-i` because a terminal pane is a PTY —
 * marid spawns runs on a real PTY, so an interactive shell gets its prompt, its
 * job control and its line editing.
 */
export const SHELL_ARGV: readonly string[] = ['/bin/sh', '-i'];

/**
 * Start a shell run on the active computer and open its terminal pane.
 *
 * Never blocks the interface (spec 8.3): `POST /runs` returns as soon as the run
 * is recorded — on a COLD computer the wake happens behind the pane, and the pane
 * shows the run's output as soon as the supervisor takes it. Returns the run id,
 * or null with a one-line notice when there was nothing to start it on.
 */
export async function openShellTerminal(): Promise<string | null> {
  const s = uiStore.getState;
  const computer = s().activeComputer;
  if (computer === null) {
    s().setNotice('Open a computer to start a terminal.');
    return null;
  }
  try {
    const { runId } = await startRun(computer, { argv: [...SHELL_ARGV] });
    s().openRunTerminal(computer, runId);
    s().setNotice(`Terminal · run ${shortRunId(runId)}`);
    return runId;
  } catch {
    // A failure has to be visible: the old behaviour's whole problem was a pane
    // that looked fine and did nothing.
    s().setNotice('Could not start a shell run.');
    return null;
  }
}
