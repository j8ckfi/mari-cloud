import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DiffView } from '../src/components/DiffView';
import { DiffPane } from '../src/components/panes/DiffPane';
import { RunsPane } from '../src/components/panes/RunsPane';
import { RunLauncher } from '../src/components/RunLauncher';
import { ComputerCard } from '../src/components/ComputerCard';
import { useUiStore } from '../src/store/ui';
import { useEventsStore } from '../src/store/events';
import { paneIds, findPane } from '../src/wm/tree';
import type { DiffResponse, FleetComputer, RunSummary } from '../src/api/types';

function wrap(ui: React.ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const diff: DiffResponse = {
  runId: 'r1',
  base: 'base-manifest-id-0000',
  head: 'head-manifest-id-0000',
  summary: { added: 1, modified: 2, removed: 1 },
  entries: [
    { path: '/src/new.ts', change: 'added', oldMode: null, newMode: 0o100644, oldSize: null, newSize: 42, contentChanged: true },
    { path: '/src/app.ts', change: 'modified', oldMode: 0o100644, newMode: 0o100644, oldSize: 10, newSize: 20, contentChanged: true },
    { path: '/bin/tool', change: 'modified', oldMode: 0o100644, newMode: 0o100755, oldSize: 9, newSize: 9, contentChanged: false },
    { path: '/gone.txt', change: 'removed', oldMode: 0o100644, newMode: null, oldSize: 3, newSize: null, contentChanged: true },
  ],
};

describe('DiffView (spec 5.3 result review / 9.2 fork diff)', () => {
  it('renders every changed path with its class, mode-only distinguished', () => {
    render(<DiffView diff={diff} />);
    const rows = screen.getAllByTestId('diff-row');
    expect(rows).toHaveLength(4);

    const modeRow = rows.find((r) => r.getAttribute('data-path') === '/bin/tool')!;
    expect(modeRow.getAttribute('data-class')).toBe('mode');
    expect(within(modeRow).getByTestId('diff-row-kind').textContent).toBe('mode only');
    expect(within(modeRow).getByTestId('diff-row-mode').textContent).toBe('0644 → 0755');

    const contentRow = rows.find((r) => r.getAttribute('data-path') === '/src/app.ts')!;
    expect(contentRow.getAttribute('data-class')).toBe('content');
    expect(within(contentRow).getByTestId('diff-row-size').textContent).toBe('+10 B');

    expect(screen.getByTestId('diff-counts').textContent).toBe('+1 ~2 -1 1 mode-only');
  });

  it('groups by folder and can flatten, keeping every row either way', () => {
    render(<DiffView diff={diff} />);
    const dirs = screen.getAllByTestId('diff-group').map((g) => g.getAttribute('data-dir'));
    expect(dirs).toEqual(['/', '/bin', '/src']);
    expect(screen.getAllByTestId('diff-row')).toHaveLength(4);
  });

  it('offers NO merge or apply action of its own (spec 9.2)', () => {
    render(<DiffView diff={diff} />);
    const labels = screen.getAllByRole('button').map((b) => (b.textContent ?? '').toLowerCase());
    expect(labels.some((l) => l.includes('merge') || l.includes('apply') || l.includes('resolve'))).toBe(
      false,
    );
  });

  it('warns when the entry list does not account for the summary', () => {
    render(<DiffView diff={{ ...diff, summary: { added: 1, modified: 9, removed: 1 } }} />);
    expect(screen.getByTestId('diff-partial')).toBeTruthy();
  });

  it('renders an empty diff as a statement, not a spinner', () => {
    render(<DiffView diff={{ ...diff, entries: [], summary: { added: 0, modified: 0, removed: 0 } }} />);
    expect(screen.getByTestId('diff-empty')).toBeTruthy();
    expect(document.querySelector('[role="progressbar"], .spinner, [aria-busy="true"]')).toBeNull();
  });
});

describe('DiffPane keep / revert (spec 5.3)', () => {
  const calls: string[] = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/diff')) {
          return new Response(JSON.stringify(diff), { headers: { 'content-type': 'application/json' } });
        }
        return new Response(JSON.stringify({ runId: 'r1', review: 'kept', head: 'h' }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('POSTs keep once and then disables both decisions', async () => {
    const user = userEvent.setup();
    wrap(<DiffPane computer="c1" spec={{ kind: 'diff', run: 'r1' }} />);
    await screen.findAllByTestId('diff-row');

    await user.click(screen.getByTestId('diff-keep'));
    await waitFor(() => expect(calls).toContain('POST /api/computers/c1/runs/r1/keep'));
    // Both decisions lock once one is made: a run's result is decided once.
    await waitFor(() =>
      expect((screen.getByTestId('diff-keep') as HTMLButtonElement).disabled).toBe(true),
    );
    expect((screen.getByTestId('diff-revert') as HTMLButtonElement).disabled).toBe(true);

    await user.click(screen.getByTestId('diff-keep'));
    expect(calls.filter((c) => c.includes('/keep'))).toHaveLength(1);
  });

  it('requires a confirmation before reverting — one click destroys nothing', async () => {
    const user = userEvent.setup();
    wrap(<DiffPane computer="c1" spec={{ kind: 'diff', run: 'r1' }} />);
    await screen.findAllByTestId('diff-row');

    await user.click(screen.getByTestId('diff-revert'));
    expect(calls.some((c) => c.includes('/revert'))).toBe(false);
    expect(screen.getByTestId('diff-revert').textContent).toBe('Confirm revert');

    await user.click(screen.getByTestId('diff-revert'));
    await waitFor(() => expect(calls).toContain('POST /api/computers/c1/runs/r1/revert'));
  });
});

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'r1',
    state: 'running',
    argv: ['npm', 'test'],
    cwd: '/',
    exitCode: null,
    signal: null,
    attention: false,
    startedAt: 1000,
    endedAt: null,
    preRunManifest: 'm0',
    postRunManifest: null,
    diff: null,
    review: 'pending',
    ...over,
  };
}

describe('RunsPane (spec 5, spec 8.2)', () => {
  const calls: string[] = [];
  let runs: RunSummary[] = [];

  beforeEach(() => {
    calls.length = 0;
    useEventsStore.getState().reset();
    useUiStore.setState({ activeComputer: 'c1', layouts: {}, workspaces: ['c1'], view: 'workspace' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return new Response(JSON.stringify({ computer: 'c1', runs }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('lists runs with state and offers Stop only while active', async () => {
    runs = [
      summary({ id: 'live', state: 'running' }),
      summary({ id: 'done', state: 'exited', exitCode: 0, startedAt: 500, diff: { added: 0, modified: 0, removed: 0 } }),
    ];
    const user = userEvent.setup();
    wrap(<RunsPane computer="c1" />);

    const rows = await screen.findAllByTestId('run-row');
    expect(rows.map((r) => r.getAttribute('data-run-id'))).toEqual(['live', 'done']);
    expect(within(rows[0]!).getByTestId('run-state').textContent).toBe('running');
    expect(within(rows[1]!).getByTestId('run-state').textContent).toBe('exit 0');
    expect(within(rows[1]!).queryByTestId('run-stop')).toBeNull();
    // A run that changed nothing has nothing to review (spec 5.3).
    expect(within(rows[1]!).queryByTestId('run-review')).toBeNull();

    await user.click(within(rows[0]!).getByTestId('run-stop'));
    await waitFor(() => expect(calls).toContain('POST /api/computers/c1/runs/live/stop'));
  });

  it('offers Review for a finished run that changed files, and opens a diff pane', async () => {
    runs = [summary({ id: 'r9', state: 'exited', exitCode: 0, diff: { added: 2, modified: 0, removed: 0 } })];
    const user = userEvent.setup();
    wrap(<RunsPane computer="c1" />);

    const row = (await screen.findAllByTestId('run-row'))[0]!;
    expect(within(row).getByTestId('run-diff-counts').textContent).toBe('+2 ~0 -0');
    await user.click(within(row).getByTestId('run-review'));

    const layout = useUiStore.getState().layoutFor('c1');
    const focused = findPane(layout.root, layout.focused as string)!;
    expect(focused.pane).toEqual({ kind: 'diff', run: 'r9' });
  });

  it('shows a run that only the live stream knows about', async () => {
    runs = [];
    wrap(<RunsPane computer="c1" />);
    await screen.findByTestId('runs-empty');

    useEventsStore.getState().push({
      type: 'run',
      seq: 1,
      at: 5,
      computer: 'c1',
      runId: 'fresh',
      state: 'pending',
    });

    const row = (await screen.findAllByTestId('run-row'))[0]!;
    expect(row.getAttribute('data-run-id')).toBe('fresh');
    expect(within(row).getByTestId('run-state').textContent).toBe('pending');
  });

  it('badges a waiting run and opens its terminal pane when activated (spec 6.2)', async () => {
    runs = [summary({ id: 'waits', state: 'running' })];
    const user = userEvent.setup();
    wrap(<RunsPane computer="c1" />);
    await screen.findAllByTestId('run-row');

    useEventsStore.getState().push({
      type: 'attention',
      seq: 1,
      at: 5,
      computer: 'c1',
      runId: 'waits',
      state: 'waiting',
      kind: 'blocked_read',
    });

    const badge = await screen.findByTestId('run-attention');
    await user.click(badge);

    const layout = useUiStore.getState().layoutFor('c1');
    const focused = findPane(layout.root, layout.focused as string)!;
    expect(focused.pane).toEqual({ kind: 'terminal', run: 'waits' });
  });
});

function fleetComputer(over: Partial<FleetComputer> = {}): FleetComputer {
  return {
    id: 'c1',
    hostname: 'box',
    state: 'cold',
    activeRuns: 0,
    attention: 0,
    changedFiles: 0,
    cost: { currency: 'USD', accrued: 0, ratePerHour: 0, window: 'month to date' },
    manifestHead: null,
    updatedAt: 0,
    ...over,
  };
}

describe('ComputerCard attention badge (spec 6.2)', () => {
  it('activates the attention without also opening the workspace', async () => {
    const onOpen = vi.fn();
    const onAttention = vi.fn();
    const user = userEvent.setup();
    render(
      <ComputerCard
        computer={fleetComputer({ attention: 0 })}
        onOpen={onOpen}
        onAttention={onAttention}
        attentionCount={1}
      />,
    );
    await user.click(screen.getByTestId('attention-badge'));
    expect(onAttention).toHaveBeenCalledWith('c1');
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('shows no badge when nothing is waiting', () => {
    render(<ComputerCard computer={fleetComputer()} onOpen={() => {}} onAttention={() => {}} />);
    expect(screen.queryByTestId('attention-badge')).toBeNull();
  });

  it('prefers the live state over the polled fleet state', () => {
    render(
      <ComputerCard
        computer={fleetComputer({ state: 'cold' })}
        onOpen={() => {}}
        liveState="waking"
        liveActiveRuns={2}
      />,
    );
    expect(screen.getByTestId('computer-state').textContent).toBe('waking');
    expect(screen.getByTestId('active-runs').textContent).toBe('2');
  });

  it('opens the computer from the keyboard', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<ComputerCard computer={fleetComputer()} onOpen={onOpen} />);
    screen.getByTestId('computer-card').focus();
    await user.keyboard('{Enter}');
    expect(onOpen).toHaveBeenCalledWith('c1');
  });
});

describe('RunLauncher (spec 5.1, spec 8.1)', () => {
  beforeEach(() => {
    useUiStore.setState({ activeComputer: 'c1', layouts: {}, workspaces: ['c1'], view: 'workspace' });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('starts the typed command as argv and opens its terminal', async () => {
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(init?.body as string);
        return new Response(JSON.stringify({ runId: 'run-9', state: 'pending' }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    const user = userEvent.setup();
    const onClose = vi.fn();
    wrap(<RunLauncher computer="c1" open onClose={onClose} />);

    await user.type(screen.getByTestId('run-launcher-input'), 'git commit -m "wip thing"');
    await user.keyboard('{Enter}');

    await waitFor(() => expect(bodies.length).toBe(1));
    expect(JSON.parse(bodies[0]!)).toEqual({ argv: ['git', 'commit', '-m', 'wip thing'] });
    expect(onClose).toHaveBeenCalled();

    await waitFor(() => {
      const layout = useUiStore.getState().layoutFor('c1');
      expect(findPane(layout.root, layout.focused as string)!.pane).toEqual({
        kind: 'terminal',
        run: 'run-9',
      });
    });
  });

  it('refuses an empty command instead of posting one', async () => {
    const fetchFn = vi.fn();
    vi.stubGlobal('fetch', fetchFn);
    const user = userEvent.setup();
    wrap(<RunLauncher computer="c1" open onClose={() => {}} />);
    await user.keyboard('{Enter}');
    expect(fetchFn).not.toHaveBeenCalled();
    expect(screen.getByTestId('run-launcher-hint').textContent).toBe('Type a command.');
  });

  it('re-opens with the command intact and reports a failed start', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 })),
    );
    const user = userEvent.setup();
    // The real wiring: the store owns `open`, exactly as the Shell renders it.
    function Harness() {
      const open = useUiStore((s) => s.runLauncherOpen);
      const setOpen = useUiStore((s) => s.setRunLauncherOpen);
      return <RunLauncher computer="c1" open={open} onClose={() => setOpen(false)} />;
    }
    useUiStore.getState().setRunLauncherOpen(true);
    wrap(<Harness />);

    await user.type(screen.getByTestId('run-launcher-input'), 'npm test');
    await user.keyboard('{Enter}');

    // The failure is reported, not swallowed, and the dialog is back with the
    // command still typed so the user can retry.
    await waitFor(() =>
      expect(screen.getByTestId('run-launcher-hint').textContent).toBe('Could not start the run.'),
    );
    expect((screen.getByTestId('run-launcher-input') as HTMLInputElement).value).toBe('npm test');
  });
});

/** How many terminal panes in this layout are views of `run`. */
function terminalPanesFor(layout: { root: import('../src/wm/tree').WmNode | null }, run: string): number {
  return paneIds(layout.root)
    .map((id) => findPane(layout.root, id)!)
    .filter((p) => p.pane.kind === 'terminal' && p.pane.run === run).length;
}

describe('opening a run’s terminal (spec 6.2 target)', () => {
  beforeEach(() => {
    useUiStore.setState({ activeComputer: null, layouts: {}, workspaces: [], view: 'fleet' });
  });

  it('focuses the EXISTING terminal pane for that run instead of stacking a second', () => {
    useUiStore.getState().openRunTerminal('c1', 'r1');
    const first = useUiStore.getState().layoutFor('c1');
    expect(terminalPanesFor(first, 'r1')).toBe(1);
    const paneCount = paneIds(first.root).length;

    // Move focus elsewhere (a second pane), then re-activate the attention.
    useUiStore.getState().addPane({ kind: 'files', path: '/etc' });
    const withFiles = useUiStore.getState().layoutFor('c1');
    const filesPaneId = withFiles.focused as string;
    expect(paneIds(withFiles.root)).toHaveLength(paneCount + 1);

    useUiStore.getState().openRunTerminal('c1', 'r1');
    const after = useUiStore.getState().layoutFor('c1');
    // No duplicate terminal for the same run, and no new pane at all.
    expect(terminalPanesFor(after, 'r1')).toBe(1);
    expect(paneIds(after.root)).toHaveLength(paneCount + 1);
    expect(after.focused).not.toBe(filesPaneId);
    expect(findPane(after.root, after.focused as string)!.pane).toEqual({
      kind: 'terminal',
      run: 'r1',
    });
  });

  it('switches to that computer’s workspace when the attention is elsewhere', () => {
    useUiStore.getState().openComputer('c1');
    useUiStore.getState().openRunTerminal('c2', 'r2');
    expect(useUiStore.getState().activeComputer).toBe('c2');
    expect(useUiStore.getState().view).toBe('workspace');
    const layout = useUiStore.getState().layoutFor('c2');
    expect(findPane(layout.root, layout.focused as string)!.pane).toEqual({
      kind: 'terminal',
      run: 'r2',
    });
  });

  it('focuses an existing identical pane instead of stacking a twin (double-clicked file)', () => {
    useUiStore.getState().openComputer('c1');
    useUiStore.getState().addPane({ kind: 'editor', path: '/a.md' });
    const opened = useUiStore.getState().layoutFor('c1');
    const editorId = opened.focused as string;
    const before = paneIds(opened.root).length;

    // Focus elsewhere, then "open" the same file again (the double-click case).
    useUiStore.getState().addPane({ kind: 'runs' });
    useUiStore.getState().addPane({ kind: 'editor', path: '/a.md' });

    const after = useUiStore.getState().layoutFor('c1');
    expect(paneIds(after.root)).toHaveLength(before + 1); // only the runs pane was new
    expect(after.focused).toBe(editorId);
  });

  it('opens a separate pane for a different run', () => {
    useUiStore.getState().openRunTerminal('c1', 'r1');
    const before = paneIds(useUiStore.getState().layoutFor('c1').root).length;
    useUiStore.getState().openRunTerminal('c1', 'r2');
    const layout = useUiStore.getState().layoutFor('c1');
    expect(paneIds(layout.root)).toHaveLength(before + 1);
    expect(terminalPanesFor(layout, 'r1')).toBe(1);
    expect(terminalPanesFor(layout, 'r2')).toBe(1);
  });
});
