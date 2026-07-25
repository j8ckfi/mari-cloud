// The first run of a brand-new instance, and the two states a new user is most
// likely to see: an empty fleet, and a fleet that could not be read.
//
// Why this file exists at all: before it, an account with no computers rendered
// the words "No computers yet." and offered nothing — the interface had no way
// to create a computer, so a private instance that came up perfectly was a dead
// end unless you read the source and POSTed by hand. That is the gap being
// closed, so the assertions are about the PATH completing (a real POST, the
// fleet re-read, the workspace opened), not about the wording.
//
// Spec 8.1 (full keyboard operation) is asserted, not assumed: the same action
// is exercised through the command registry, because a pointer-only "New
// computer" button would violate it.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { Shell } from '../src/components/Shell';
import { FleetHome } from '../src/components/FleetHome';
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
  changedFiles: 0,
  cost: { currency: 'USD', accrued: 0, ratePerHour: 0, window: 'month to date' },
  manifestHead: 'm1',
  updatedAt: 10,
};

/**
 * A fake control plane. `fleet` is a function so a test can change what the next
 * read returns; every request is recorded as "METHOD path" so the assertions can
 * be about the exact HTTP the interface performed — including that it performed
 * no OTHER request (a first-run path that woke a computer would show up here).
 */
function stubApi(opts: {
  fleet: () => FleetComputer[] | 'fail';
  create?: () => Response;
}) {
  const seen: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = new URL(String(input), 'http://test.local');
      const method = init?.method ?? 'GET';
      seen.push(`${method} ${url.pathname}`);

      if (url.pathname === '/api/computers' && method === 'POST') {
        return (
          opts.create?.() ??
          new Response(
            JSON.stringify({ id: 'new-1', name: 'computer', state: 'cold', head: null }),
            { status: 201, headers: { 'content-type': 'application/json' } },
          )
        );
      }
      if (url.pathname === '/api/fleet') {
        const fleet = opts.fleet();
        if (fleet === 'fail') return new Response('nope', { status: 500 });
        return new Response(JSON.stringify({ computers: fleet }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/layout')) {
        return new Response(JSON.stringify({ computer: 'new-1', layout: null }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.pathname.endsWith('/runs')) {
        return new Response(JSON.stringify({ computer: 'new-1', runs: [] }), {
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ entries: [] }), {
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
    client,
    registry,
    ...render(
      <QueryClientProvider client={client}>
        <Shell registry={registry} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  useEventsStore.getState().reset();
  useUiStore.setState({
    view: 'fleet',
    workspaces: [],
    activeComputer: null,
    layouts: {},
    paletteOpen: false,
    runLauncherOpen: false,
    notice: '',
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a fleet with no computers (the first minute)', () => {
  it('offers the create action and never mounts a spinner (spec 8.3)', () => {
    render(<FleetHome computers={[]} onOpen={() => {}} onNew={() => {}} />);

    expect(screen.getByTestId('fleet-empty')).toBeTruthy();
    expect(screen.getByTestId('fleet-empty-new')).toBeTruthy();
    // The empty state is not an error state.
    expect(screen.queryByTestId('fleet-unreachable')).toBeNull();
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    expect(document.querySelector('.spinner, [aria-busy="true"]')).toBeNull();
  });

  it('without an onNew handler it offers no action it cannot perform', () => {
    render(<FleetHome computers={[]} onOpen={() => {}} />);
    expect(screen.getByTestId('fleet-empty')).toBeTruthy();
    expect(screen.queryByTestId('fleet-empty-new')).toBeNull();
    expect(screen.queryByTestId('fleet-new-computer')).toBeNull();
  });

  it('creating the first computer POSTs once, re-reads the fleet, and opens it', async () => {
    const user = userEvent.setup();
    let computers: FleetComputer[] = [];
    const { seen } = stubApi({ fleet: () => computers });
    renderShell();

    await waitFor(() => expect(screen.getByTestId('fleet-empty')).toBeTruthy());
    // The new computer exists as soon as the POST returns, so the fleet the
    // interface re-reads has it.
    computers = [{ ...COLD, id: 'new-1', hostname: 'computer' }];

    await user.click(screen.getByTestId('fleet-empty-new'));

    // Exactly one create, and the workspace for the id the server returned.
    await waitFor(() => expect(useUiStore.getState().activeComputer).toBe('new-1'));
    expect(useUiStore.getState().view).toBe('workspace');
    expect(seen.filter((r) => r === 'POST /api/computers')).toHaveLength(1);
    // The fleet was read again after the create, so the card is there when the
    // user goes back — the interface does not rely on a reload.
    expect(seen.filter((r) => r === 'GET /api/fleet').length).toBeGreaterThanOrEqual(2);

    // Creating a computer must NOT materialize one: no wake, no run, no snapshot
    // anywhere on this path (spec 8.3 — the wake happens behind the interface,
    // when there is something to run).
    expect(seen.some((r) => r.includes('/wake'))).toBe(false);
    expect(seen.some((r) => r.includes('/snapshot'))).toBe(false);

    // The outcome is reported in words, in the same place every command reports.
    expect(useUiStore.getState().notice).toMatch(/deep sleep/i);
  });

  it('the same action exists as a command, so the keyboard alone suffices (8.1)', async () => {
    let computers: FleetComputer[] = [];
    const { seen } = stubApi({ fleet: () => computers });
    const { registry } = renderShell();

    await waitFor(() => expect(screen.getByTestId('fleet-empty')).toBeTruthy());
    const cmd = registry.list().find((c) => c.id === 'computer.new');
    expect(cmd, 'computer.new must be in the palette registry').toBeTruthy();

    computers = [{ ...COLD, id: 'new-1', hostname: 'computer' }];
    await cmd!.run();

    await waitFor(() => expect(useUiStore.getState().activeComputer).toBe('new-1'));
    expect(seen.filter((r) => r === 'POST /api/computers')).toHaveLength(1);
  });

  it('a refused create says so and leaves the user on the fleet', async () => {
    const user = userEvent.setup();
    stubApi({
      fleet: () => [],
      create: () => new Response('no', { status: 500 }),
    });
    renderShell();

    await waitFor(() => expect(screen.getByTestId('fleet-empty')).toBeTruthy());
    await user.click(screen.getByTestId('fleet-empty-new'));

    await waitFor(() => expect(useUiStore.getState().notice).toMatch(/could not create/i));
    // Not navigated into a workspace that does not exist.
    expect(useUiStore.getState().activeComputer).toBeNull();
    expect(useUiStore.getState().view).toBe('fleet');
    expect(screen.getByTestId('fleet-empty')).toBeTruthy();
  });
});

describe('a fleet that could not be read', () => {
  it('is its own state — not "no computers yet"', async () => {
    stubApi({ fleet: () => 'fail' });
    renderShell();

    const panel = await waitFor(() => screen.getByTestId('fleet-unreachable'));
    // The distinction is the whole point: telling a user with 12 computers that
    // they have none invites exactly the wrong recovery.
    expect(screen.queryByTestId('fleet-empty')).toBeNull();
    // It must name a next step, not just fail.
    expect(panel.textContent).toMatch(/control plane/i);
    expect(panel.getAttribute('role')).toBe('alert');
  });

  it('retrying re-reads the fleet and recovers', async () => {
    const user = userEvent.setup();
    let ok = false;
    const { seen } = stubApi({ fleet: () => (ok ? [COLD] : 'fail') });
    renderShell();

    await waitFor(() => expect(screen.getByTestId('fleet-unreachable')).toBeTruthy());
    const before = seen.filter((r) => r === 'GET /api/fleet').length;

    ok = true;
    await user.click(screen.getByTestId('fleet-retry'));

    await waitFor(() => expect(screen.getByTestId('computer-card')).toBeTruthy());
    expect(seen.filter((r) => r === 'GET /api/fleet').length).toBeGreaterThan(before);
    expect(screen.queryByTestId('fleet-unreachable')).toBeNull();
  });

  it('a failed REFETCH keeps the last good fleet on screen', async () => {
    let ok = true;
    stubApi({ fleet: () => (ok ? [COLD] : 'fail') });
    const { client } = renderShell();

    await waitFor(() => expect(screen.getByTestId('computer-card')).toBeTruthy());

    ok = false;
    await client.invalidateQueries({ queryKey: ['fleet'] });

    // The query is in error, and the card is still there. Blanking the fleet on
    // a transient failure would make a working instance look destroyed.
    await waitFor(() => expect(client.getQueryState(['fleet'])?.error).toBeTruthy());
    expect(screen.getByTestId('computer-card')).toBeTruthy();
    expect(screen.queryByTestId('fleet-unreachable')).toBeNull();
  });
});
