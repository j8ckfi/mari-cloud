// "+ Terminal" and the palette's "New terminal pane" (spec 7.1, spec 8.5).
//
// Both used to call `addPane({ kind: 'terminal', run: 'shell' })`. There is no run
// called `shell`: the pane mounted, attached to a run id no supervisor had ever
// heard of, and stayed permanently blank with the title "Terminal · shell" —
// while the Runs pane's per-run Terminal button, on the same computer, attached
// correctly and round-tripped keystrokes into the PTY. The most obvious
// affordance for spec 7's headline pane was dead.
//
// A terminal pane is a view OF a run, so the button has to create the run first.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { openShellTerminal, SHELL_ARGV } from '../src/runs/shell';
import { coreCommands } from '../src/commands';
import { useUiStore } from '../src/store/ui';
import { findPaneBy } from '../src/wm/tree';
import { isTerminalFor } from '../src/wm/pane';

interface Call {
  url: string;
  method: string;
  body: unknown;
}

function stub(responder: (call: Call) => Response) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const call = { url: String(input), method: init?.method ?? 'GET', body: init?.body };
      calls.push(call);
      return responder(call);
    }),
  );
  return calls;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  useUiStore.setState({
    view: 'fleet',
    workspaces: [],
    activeComputer: null,
    layouts: {},
    notice: '',
  });
});
afterEach(() => vi.unstubAllGlobals());

describe('opening a terminal pane', () => {
  it('starts a real run and binds the pane to the id the server returned', async () => {
    const calls = stub(() => json({ runId: 'run-abc123', run: 'run-abc123', state: 'pending' }));
    useUiStore.getState().openComputer('c1');

    const runId = await openShellTerminal();
    expect(runId).toBe('run-abc123');

    // One POST, to the runs route, with an argv the supervisor can exec.
    expect(calls.length).toBe(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('/api/computers/c1/runs');
    expect(JSON.parse(String(calls[0]!.body))).toEqual({ argv: [...SHELL_ARGV] });

    // The pane exists and is bound to THAT run — never to the literal 'shell'.
    const layout = useUiStore.getState().layoutFor('c1');
    expect(findPaneBy(layout.root, (p) => isTerminalFor(p, 'run-abc123'))).not.toBeNull();
    expect(findPaneBy(layout.root, (p) => isTerminalFor(p, 'shell'))).toBeNull();
  });

  it('reports a failure instead of opening a pane that cannot work', async () => {
    stub(() => json({ error: 'argv_or_agent_required' }, 400));
    useUiStore.getState().openComputer('c2');

    expect(await openShellTerminal()).toBeNull();
    expect(useUiStore.getState().notice).toMatch(/Could not start a shell run/);
    const layout = useUiStore.getState().layoutFor('c2');
    expect(findPaneBy(layout.root, (p) => p.kind === 'terminal')).toBeNull();
  });

  it('says so when there is no computer to run on', async () => {
    const calls = stub(() => json({}));
    expect(await openShellTerminal()).toBeNull();
    expect(calls.length).toBe(0);
    expect(useUiStore.getState().notice).toMatch(/Open a computer/);
  });

  it('the palette command goes through the same path (spec 8.1)', async () => {
    const calls = stub(() => json({ runId: 'run-palette', state: 'pending' }));
    useUiStore.getState().openComputer('c3');

    const cmd = coreCommands().find((c) => c.id === 'pane.new.terminal');
    expect(cmd).toBeDefined();
    await cmd!.run();

    expect(calls.some((c) => c.method === 'POST' && c.url === '/api/computers/c3/runs')).toBe(true);
    const layout = useUiStore.getState().layoutFor('c3');
    expect(findPaneBy(layout.root, (p) => isTerminalFor(p, 'run-palette'))).not.toBeNull();
  });
});
