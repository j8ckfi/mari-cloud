// REVIEW REGRESSION (live): the three reviewed gaps that made the product's
// central loop (spec 1.3) undrivable from the control plane. Each `it` below
// reproduces the exact call the web client makes and asserts the FIXED
// behavior; before the fix each of these 404'd.
//
//   - spec 5 / 8.5: the web `startRun()` POSTs `/api/computers/:id/runs`
//     (EditorPane "Run brief"). There was no route and the DO never sent a
//     `start_run` ControlMessage — a run could not be started at all.
//   - spec 8.4 / 8.5: the web `writeFile()` PUTs `/api/computers/:id/file`
//     (editor Save, files Upload). There was no PUT route and nothing woke on a
//     write ("A write to such a computer starts a wake").
//   - spec 8.5: the web `fetchFile()` GETs `/api/computers/:id/file` (download,
//     editor load). Only the PLURAL `/files` route existed, so the singular path
//     404'd while the plural one succeeded.
//
// Deeper behavior for each lives in runs.test.ts / writes.test.ts; this file is
// the reviewer's repro, kept as the regression guard.
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { HOST, computerStub, ensureSchema, eqBytes, seedSession, waitUntil } from './helpers';
import { SEED_TREE } from '../src/seed';

describe('REVIEW REGRESSION: run-start and file-write paths exist', () => {
  let cookie = '';
  let computerId = '';
  beforeAll(async () => {
    await ensureSchema();
    ({ cookie, computerId } = await seedSession());
  });

  it('POST /runs (web startRun / "Run brief") starts a run', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/runs`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ agent: 'my-agent', path: '/README.md' }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { runId: string; run: string; state: string };
    expect(body.runId).toMatch(/^[0-9a-f]{32}$/);
    expect(body.run).toBe(body.runId);
    expect(body.state).toBe('pending');

    // It is real: the run is in the computer's history, waiting for a supervisor.
    const listed = await SELF.fetch(`${HOST}/api/computers/${computerId}/runs`, {
      headers: { Cookie: cookie },
    });
    const runs = (await listed.json()) as { runs: { id: string; argv: string[] }[] };
    expect(runs.runs.find((r) => r.id === body.runId)?.argv).toEqual(['my-agent', '/README.md']);
  });

  it('PUT /file (web writeFile: editor Save / Upload) accepts a write and wakes', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/file?path=/notes/new.txt`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: new TextEncoder().encode('hello'),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as { ok: boolean; path: string; state: string };
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/notes/new.txt');
    // spec 8.4: "A write to such a computer starts a wake."
    expect(['waking', 'awake']).toContain(body.state);
    await waitUntil(
      async () => (await computerStub(computerId).getState()) === 'awake',
      3000,
      'wake on write',
    );
  });

  it('GET /file (singular; web fetchFile: download / editor load) serves the bytes', async () => {
    const singular = await SELF.fetch(
      `${HOST}/api/computers/${computerId}/file?path=/README.md`,
      { headers: { Cookie: cookie } },
    );
    expect(singular.status).toBe(200);
    const got = new Uint8Array(await singular.arrayBuffer());
    expect(eqBytes(got, new TextEncoder().encode(SEED_TREE['/README.md']!))).toBe(true);

    // The plural route still serves the same bytes (both spellings work).
    const plural = await SELF.fetch(`${HOST}/api/computers/${computerId}/files/README.md`, {
      headers: { Cookie: cookie },
    });
    expect(plural.status).toBe(200);
    expect(eqBytes(new Uint8Array(await plural.arrayBuffer()), got)).toBe(true);
  });
});
