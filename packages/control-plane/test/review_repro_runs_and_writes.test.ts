// REVIEW REPRO (skipped): the control plane has no run-start path and no
// file-write path, and the single-file READ route the web client uses does not
// exist. These are core spec promises the web app already calls but that 404.
//
//   - spec 5 / 8.5: the web `startRun()` POSTs `/api/computers/:id/runs`
//     (EditorPane "Run brief"). No such route exists, and the DO never sends a
//     `start_run` ControlMessage — a run cannot be started from the control
//     plane at all.
//   - spec 8.4 / 8.5: the web `writeFile()` PUTs `/api/computers/:id/file`
//     (editor Save, files Upload). No PUT route exists and nothing wakes on a
//     write ("A write to such a computer starts a wake").
//   - spec 8.5: the web `fetchFile()` GETs `/api/computers/:id/file` (download,
//     editor load). The server only serves the PLURAL `/files` route, so the
//     singular path 404s while the plural one succeeds — download/editor-read
//     are wired to a non-existent route.
//
// De-skip to reproduce:
//   pnpm --filter @mari/control-plane exec vitest run test/review_repro_runs_and_writes.test.ts
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import { cookieFromSetCookie } from './helpers';

const HOST = 'http://localhost';

async function seed(): Promise<{ cookie: string; computerId: string }> {
  const res = await SELF.fetch(`${HOST}/api/dev/seed`, { method: 'POST' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { computer: { id: string } };
  const cookie = cookieFromSetCookie(res.headers.get('set-cookie'));
  return { cookie, computerId: body.computer.id };
}

describe.skip('REVIEW REPRO: missing run-start and file-write paths', () => {
  let cookie = '';
  let computerId = '';
  beforeAll(async () => {
    ({ cookie, computerId } = await seed());
  });

  it('POST /runs (web startRun / "Run brief") has no route -> 404', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/runs`, {
      method: 'POST',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ path: '/README.md' }),
    });
    expect(res.status).toBe(404); // spec 5 / 8.5: runs cannot be started
  });

  it('PUT /file (web writeFile: editor Save / Upload) has no route -> 404', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/file?path=/notes/new.txt`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: new TextEncoder().encode('hello'),
    });
    expect(res.status).toBe(404); // spec 8.4/8.5: no write path, no wake-on-write
  });

  it('GET /file (singular; web fetchFile: download / editor load) 404s, while /files works', async () => {
    const singular = await SELF.fetch(
      `${HOST}/api/computers/${computerId}/file?path=/README.md`,
      { headers: { Cookie: cookie } },
    );
    expect(singular.status).toBe(404); // the path the web client actually calls

    const plural = await SELF.fetch(
      `${HOST}/api/computers/${computerId}/files/README.md`,
      { headers: { Cookie: cookie } },
    );
    expect(plural.status).toBe(200); // the capability exists, at a different path
  });
});
