import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComputerBrowserPane } from '../src/components/panes/ComputerBrowserPane';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('ComputerBrowserPane', () => {
  it('starts one durable mari-browser run without duplicating it during query refresh', async () => {
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        calls.push({
          url,
          method,
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
        if (method === 'POST') {
          return new Response(JSON.stringify({ runId: 'browser-run', state: 'pending' }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ computer: 'c1', runs: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }),
    );

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 0 } },
    });
    render(
      <QueryClientProvider client={client}>
        <ComputerBrowserPane computer="c1" spec={{ kind: 'browser', port: 6080 }} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1));
    await client.invalidateQueries({ queryKey: ['runs', 'c1'] });
    await waitFor(() => expect(calls.filter((call) => call.method === 'GET').length).toBeGreaterThan(1));

    const posts = calls.filter((call) => call.method === 'POST');
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toContain('/api/computers/c1/runs');
    expect(posts[0]?.body).toEqual({
      argv: ['mari-browser', '--port', '6080'],
      cwd: '/',
      envNames: [],
    });
  });
});
