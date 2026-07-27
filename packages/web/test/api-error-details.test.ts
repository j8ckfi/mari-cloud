import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchFleet, startRun } from '../src/api/client';

function reply(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ApiError refusal details', () => {
  it('preserves a POST quota code and its numbers for actionable UI copy', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        reply({ error: 'limit_compute', usedMs: 7_200_000, capMs: 7_200_000 }, 403),
      ),
    );

    const error = await startRun('computer-1', { argv: ['/bin/sh', '-i'] }).catch(
      (caught: unknown) => caught,
    );

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 403,
      details: {
        error: 'limit_compute',
        usedMs: 7_200_000,
        capMs: 7_200_000,
      },
    });
  });

  it('preserves a GET refusal body too', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({ error: 'temporarily_unavailable', retryAfter: 12 }, 503)),
    );

    const error = await fetchFleet().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 503,
      details: { error: 'temporarily_unavailable', retryAfter: 12 },
    });
  });

  it('falls back to empty details for a non-JSON error response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('upstream reset', { status: 502 })),
    );

    const error = await fetchFleet().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ status: 502, details: {} });
  });
});
