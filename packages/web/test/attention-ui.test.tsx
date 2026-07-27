import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// The terminal pane is stubbed here: xterm.js needs a real canvas/WebGL stack,
// and its round-trip is covered by the Playwright suite against a real
// supervisor. What this file tests is the ATTENTION PATH (spec 6.2) — an event
// badges the fleet and the workspace, and activating it opens the terminal pane
// OF THAT RUN — so the stub still proves which run the pane was opened for.
vi.mock('../src/components/panes/TerminalPane', () => ({
  TerminalPane: ({ spec }: { spec: { run: string } }) => (
    <div data-testid="terminal-pane" data-run={spec.run} />
  ),
}));

import { Shell } from '../src/components/Shell';
import { CommandRegistry } from '../src/palette/registry';
import { coreCommands } from '../src/commands';
import { useEventsStore } from '../src/store/events';
import { useUiStore } from '../src/store/ui';
import type { FleetComputer } from '../src/api/types';

const COLD: FleetComputer = {
  id: 'c1',
  hostname: 'cold-box',
  state: 'cold',
  activeRuns: 0,
  attention: 0,
  changedFiles: 3,
  cost: { currency: 'USD', accrued: 500, ratePerHour: 0, window: 'month to date' },
  manifestHead: 'm1',
  updatedAt: 10,
};

function stubApi() {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      const body = url.includes('/fleet')
        ? { computers: [COLD] }
        : url.includes('/layout')
          ? { computer: 'c1', layout: null }
          : url.includes('/runs')
            ? { computer: 'c1', runs: [] }
            : { computer: 'c1', path: '/', manifest: 'm1', entries: [] };
      return new Response(JSON.stringify(body), {
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return { seen };
}

function renderShell() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  const registry = new CommandRegistry();
  registry.registerAll(coreCommands());
  return {
    registry,
    ...render(
      <QueryClientProvider client={client}>
        <Shell registry={registry} />
      </QueryClientProvider>,
    ),
  };
}

describe('attention (spec 6.2)', () => {
  beforeEach(() => {
    useEventsStore.getState().reset();
    useUiStore.setState({
      view: 'fleet',
      workspaces: [],
      activeComputer: null,
      layouts: {},
      paletteOpen: false,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('badges the fleet card and the workspace tab when a run starts waiting', async () => {
    stubApi();
    renderShell();
    await screen.findByTestId('computer-card');

    // Nothing waiting yet.
    expect(screen.queryByTestId('attention-badge')).toBeNull();
    expect(screen.queryByTestId('workspace-attention-badge')).toBeNull();
    expect(screen.queryByTestId('fleet-attention-dot')).toBeNull();

    useEventsStore.getState().push({
      type: 'attention',
      seq: 1,
      at: 100,
      computer: 'c1',
      runId: 'r-waiting',
      state: 'waiting',
      kind: 'blocked_read',
    });

    const badge = await screen.findByTestId('attention-badge');
    expect(badge.textContent).toBe('1 waiting');
    expect(screen.getByTestId('workspace-attention-badge').textContent).toBe('1');
    expect(screen.getByTestId('fleet-attention-dot')).toBeTruthy();
    expect(screen.getByTestId('attention').textContent).toBe('1');

    // Content-free (spec 6.2/6.3): the badge is a count, never a message.
    expect(badge.textContent).not.toMatch(/[?:]/);
  });

  it('OPENS THE TERMINAL PANE OF THAT RUN when the badge is activated', async () => {
    stubApi();
    const user = userEvent.setup();
    renderShell();
    await screen.findByTestId('computer-card');

    useEventsStore.getState().push({
      type: 'attention',
      seq: 1,
      at: 100,
      computer: 'c1',
      runId: 'r-waiting',
      state: 'waiting',
    });
    await user.click(await screen.findByTestId('attention-badge'));

    // The workspace of that computer is open…
    const workspace = await screen.findByTestId('workspace');
    expect(workspace.getAttribute('data-computer')).toBe('c1');
    // …with the terminal pane of THAT run, focused.
    const term = await screen.findByTestId('terminal-pane');
    expect(term.getAttribute('data-run')).toBe('r-waiting');
    const pane = term.closest('[data-testid="pane"]');
    expect(pane?.getAttribute('data-focused')).toBe('true');
  });

  it('clears the badge when the attention is resolved', async () => {
    stubApi();
    renderShell();
    await screen.findByTestId('computer-card');

    const base = { computer: 'c1', runId: 'r1' } as const;
    useEventsStore.getState().push({ type: 'attention', seq: 1, at: 1, ...base, state: 'waiting' });
    await screen.findByTestId('attention-badge');

    useEventsStore.getState().push({ type: 'attention', seq: 2, at: 2, ...base, state: 'cleared' });
    await waitFor(() => expect(screen.queryByTestId('attention-badge')).toBeNull());
  });

  it('reflects a pushed computer state without any wake request (spec 8.3)', async () => {
    const { seen } = stubApi();
    renderShell();
    await screen.findByTestId('computer-card');
    expect(screen.getByTestId('computer-state').textContent).toBe('cold');

    useEventsStore.getState().push({
      type: 'state',
      seq: 1,
      at: 10,
      computer: 'c1',
      state: 'waking',
    });
    await waitFor(() => expect(screen.getByTestId('computer-state').textContent).toBe('waking'));

    // Rendering a cold computer and folding events issued reads only.
    expect(seen.every((s) => s.startsWith('GET '))).toBe(true);
    expect(document.querySelector('[role="progressbar"], .spinner, [aria-busy="true"]')).toBeNull();
  });

  it('is reachable from the command palette with no pointer (spec 8.1)', async () => {
    stubApi();
    const { registry } = renderShell();
    await screen.findByTestId('computer-card');

    useEventsStore.getState().push({
      type: 'attention',
      seq: 1,
      at: 100,
      computer: 'c1',
      runId: 'r-kbd',
      state: 'waiting',
    });

    const cmd = registry.get('attention.open');
    expect(cmd).toBeDefined();
    await cmd!.run();

    const term = await screen.findByTestId('terminal-pane');
    expect(term.getAttribute('data-run')).toBe('r-kbd');
  });
});
