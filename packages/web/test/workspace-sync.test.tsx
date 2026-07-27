import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultLayout, useUiStore } from '../src/store/ui';

const queryState = vi.hoisted(() => ({
  layout: {
    isSuccess: false,
    isError: false,
    data: undefined as
      | { layout: import('../src/wm/serialize').SerializedLayout | null }
      | undefined,
    refetch: vi.fn(),
  },
}));

vi.mock('../src/api/queries', () => ({
  useLayout: () => queryState.layout,
  useFleet: () => ({ data: { computers: [] } }),
  useIncidents: () => ({ data: null }),
  useUsage: () => ({ data: null }),
  useLimits: () => ({ data: null }),
}));

vi.mock('../src/components/TileView', () => ({
  TileView: () => <div data-testid="mock-tile-view" />,
}));

import { Workspace } from '../src/components/Workspace';

beforeEach(() => {
  queryState.layout.isSuccess = false;
  queryState.layout.isError = false;
  queryState.layout.data = undefined;
  queryState.layout.refetch.mockReset();
  useUiStore.setState({
    view: 'workspace',
    workspaces: ['computer-1'],
    activeComputer: 'computer-1',
    layouts: { 'computer-1': defaultLayout() },
    paletteOpen: false,
    notice: '',
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Workspace durable layout synchronization', () => {
  it('does not PUT the default or local edits after a failed hydration read', async () => {
    vi.useFakeTimers();
    queryState.layout.isError = true;
    const fetch = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    render(<Workspace computer="computer-1" />);
    expect(screen.getByTestId('layout-sync-state').textContent).toBe('Layout not synced');

    fireEvent.click(screen.getByTestId('add-runs-pane'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('layout-sync-retry'));
    expect(queryState.layout.refetch).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed save and retries the same latest layout', async () => {
    queryState.layout.isSuccess = true;
    queryState.layout.data = { layout: null };
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'temporarily_unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetch);

    render(<Workspace computer="computer-1" />);
    expect(screen.getByTestId('layout-sync-state').textContent).toBe('Layout saved');

    fireEvent.click(screen.getByTestId('add-runs-pane'));
    await waitFor(() =>
      expect(screen.getByTestId('layout-sync-state').textContent).toBe('Layout not synced'),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
    const first = fetch.mock.calls[0] as [string, RequestInit];
    expect(first[0]).toBe('/api/computers/computer-1/layout');
    expect(first[1].method).toBe('PUT');
    expect(JSON.parse(first[1].body as string)).toMatchObject({
      v: 1,
      root: { type: 'split' },
    });

    fireEvent.click(screen.getByTestId('layout-sync-retry'));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    await waitFor(() =>
      expect(screen.getByTestId('layout-sync-state').textContent).toBe('Layout saved'),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((fetch.mock.calls[1] as [string, RequestInit])[1].body).toBe(first[1].body);
  });
});
