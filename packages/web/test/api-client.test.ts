import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  eventsUrl,
  fetchRun,
  fetchRunDiff,
  fetchRuns,
  keepRun,
  revertRun,
  snapshotComputer,
  startRun,
  stopRun,
  uploadFile,
  writeFile,
  ApiError,
} from '../src/api/client';

// These assertions pin the HTTP contract the control plane is built to match
// (see the run/file/event routes in the brief). If a URL, verb or body shape
// drifts on either side, this fails — which is the point: the two packages are
// developed concurrently and can only agree in writing.

interface Call {
  url: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
}

function stubFetch(responder: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return responder(call);
  });
  vi.stubGlobal('fetch', fn);
  return { calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('runs API (spec 5)', () => {
  it('POSTs argv/cwd/envNames and returns { runId, state }', async () => {
    const { calls } = stubFetch(() => json({ runId: 'run-7', state: 'pending' }));
    const res = await startRun('comp 1', {
      argv: ['npm', 'test'],
      cwd: '/srv',
      envNames: ['ANTHROPIC_API_KEY'],
    });

    expect(res).toEqual({ runId: 'run-7', state: 'pending' });
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('/api/computers/comp%201/runs');
    expect(JSON.parse(calls[0]!.body as string)).toEqual({
      argv: ['npm', 'test'],
      cwd: '/srv',
      envNames: ['ANTHROPIC_API_KEY'],
    });
  });

  it('omits optional fields rather than sending undefined/null', async () => {
    const { calls } = stubFetch(() => json({ runId: 'r', state: 'pending' }));
    await startRun('c', { argv: ['ls'] });
    const body = JSON.parse(calls[0]!.body as string) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(['argv']);
  });

  it('never sends a secret VALUE, only its name (spec 10.1)', async () => {
    const { calls } = stubFetch(() => json({ runId: 'r', state: 'pending' }));
    await startRun('c', { argv: ['agent'], envNames: ['ANTHROPIC_API_KEY'] });
    const raw = calls[0]!.body as string;
    expect(raw).toContain('ANTHROPIC_API_KEY');
    expect(raw).not.toMatch(/sk-|value/i);
  });

  it('addresses stop / list / detail / diff / keep / revert exactly', async () => {
    const { calls } = stubFetch((c) =>
      c.url.endsWith('/diff')
        ? json({ base: null, head: null, summary: { added: 0, modified: 0, removed: 0 }, entries: [] })
        : json({ runId: 'r1', state: 'stopping', runs: [], review: 'kept', head: null, computer: 'c' }),
    );

    await stopRun('c', 'r1');
    await fetchRuns('c');
    await fetchRun('c', 'r1');
    await fetchRunDiff('c', 'r1');
    await keepRun('c', 'r1');
    await revertRun('c', 'r1');
    await snapshotComputer('c');

    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/computers/c/runs/r1/stop',
      'GET /api/computers/c/runs',
      'GET /api/computers/c/runs/r1',
      'GET /api/computers/c/runs/r1/diff',
      'POST /api/computers/c/runs/r1/keep',
      'POST /api/computers/c/runs/r1/revert',
      'POST /api/computers/c/snapshot',
    ]);
  });

  it('reading runs and diffs uses GET only — a read never wakes (spec 8.3/8.4)', async () => {
    const { calls } = stubFetch(() =>
      json({ runs: [], base: null, head: null, summary: { added: 0, modified: 0, removed: 0 }, entries: [] }),
    );
    await fetchRuns('c');
    await fetchRunDiff('c', 'r1');
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('throws a typed ApiError with the status on failure', async () => {
    stubFetch(() => json({ error: 'not_found' }, 404));
    await expect(startRun('c', { argv: ['x'] })).rejects.toMatchObject({
      name: 'ApiError',
      status: 404,
    });
    await expect(fetchRuns('c')).rejects.toBeInstanceOf(ApiError);
  });
});

describe('file write + upload (spec 8.4)', () => {
  it('PUTs the bytes to ?path= and reports the resulting computer state', async () => {
    const { calls } = stubFetch(() => json({ ok: true, path: '/a.md', state: 'waking' }));
    const res = await writeFile('c', '/a.md', 'hello');
    expect(calls[0]!.method).toBe('PUT');
    expect(calls[0]!.url).toBe('/api/computers/c/file?path=%2Fa.md');
    expect(new TextDecoder().decode(calls[0]!.body as Uint8Array)).toBe('hello');
    // The wake is reported, not awaited: the caller gets a state to render.
    expect(res.state).toBe('waking');
  });

  it('tolerates an empty 200 body from PUT without losing the write', async () => {
    stubFetch(() => new Response('', { status: 200 }));
    const res = await writeFile('c', '/a.md', 'hi');
    expect(res.ok).toBe(true);
    expect(res.path).toBe('/a.md');
  });

  it('uploads multipart with the target path in the form', async () => {
    const { calls } = stubFetch(() => json({ ok: true, path: '/dir/f.bin', state: 'awake' }));
    const res = await uploadFile('c', '/dir/f.bin', new Blob([new Uint8Array([1, 2, 3])]));
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.url).toBe('/api/computers/c/upload');
    const form = calls[0]!.body as FormData;
    expect(form.get('path')).toBe('/dir/f.bin');
    expect(form.get('file')).toBeInstanceOf(Blob);
    expect(res.state).toBe('awake');
  });

  it('falls back to the plain file write when /upload is absent', async () => {
    // The two routes are equivalent for one file; a route-shape disagreement
    // between packages must not silently drop a user's upload.
    const { calls } = stubFetch((c) =>
      c.url.endsWith('/upload')
        ? json({ error: 'not_found' }, 404)
        : json({ ok: true, path: '/dir/f.bin', state: 'waking' }),
    );
    const res = await uploadFile('c', '/dir/f.bin', new Blob([new Uint8Array([7])]));
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'POST /api/computers/c/upload',
      'PUT /api/computers/c/file?path=%2Fdir%2Ff.bin',
    ]);
    expect(new Uint8Array(calls[1]!.body as Uint8Array)).toEqual(new Uint8Array([7]));
    expect(res.ok).toBe(true);
  });

  it('does not swallow a real upload error', async () => {
    stubFetch(() => json({ error: 'too_large' }, 413));
    await expect(uploadFile('c', '/x', new Blob(['x']))).rejects.toMatchObject({ status: 413 });
  });
});

describe('events endpoint', () => {
  it('is the same-origin /api/events SSE path', () => {
    expect(eventsUrl()).toBe('/api/events');
  });
});
