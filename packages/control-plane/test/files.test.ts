// Files from the manifest head (spec 8.4): browsing a COLD computer's files is
// served straight from the manifest + chunks in R2 and MUST NOT wake it. Uses
// the real dev-seed route to populate R2 + D1 + the DO head, then asserts:
//   - directory listings + exact file bytes come back,
//   - the substrate driver recorded ZERO wake/materialize calls,
//   - the computer stayed COLD.
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, runInDurableObject } from 'cloudflare:test';
import { computerStub, cookieFromSetCookie, eqBytes } from './helpers';
import { SEED_TREE } from '../src/seed';
import type { ComputerDO } from '../src/computer-do';

const HOST = 'http://localhost';

async function seed(): Promise<{ cookie: string; computerId: string }> {
  const res = await SELF.fetch(`${HOST}/api/dev/seed`, { method: 'POST' });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { computer: { id: string }; files: string[] };
  const cookie = cookieFromSetCookie(res.headers.get('set-cookie'));
  expect(cookie).not.toBe('');
  return { cookie, computerId: body.computer.id };
}

describe('files from manifest (COLD, no wake)', () => {
  let cookie = '';
  let computerId = '';
  beforeAll(async () => {
    ({ cookie, computerId } = await seed());
  });

  it('lists the root directory from the manifest', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/files`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const listing = (await res.json()) as { path: string; entries: { name: string; kind: string }[] };
    expect(listing.path).toBe('/');
    const names = listing.entries.map((e) => e.name).sort();
    expect(names).toContain('README.md');
    expect(names).toContain('src');
    expect(names).toContain('notes');
    // `src` and `notes` are surfaced as directories.
    const src = listing.entries.find((e) => e.name === 'src');
    expect(src?.kind).toBe('dir');
  });

  it('reads a file byte-for-byte from the chunk store', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/files/README.md`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const got = new Uint8Array(await res.arrayBuffer());
    const want = new TextEncoder().encode(SEED_TREE['/README.md']!);
    expect(eqBytes(got, want)).toBe(true);
  });

  it('lists a nested directory', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/files/src`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const listing = (await res.json()) as { entries: { name: string }[] };
    const names = listing.entries.map((e) => e.name).sort();
    expect(names).toEqual(['main.ts', 'util.ts']);
  });

  it('did NOT wake the computer and it stayed COLD', async () => {
    const stub = computerStub(computerId);

    // State is still COLD.
    expect(await stub.getState()).toBe('cold');

    // The substrate driver recorded no wake/materialize calls at all.
    const ops = await runInDurableObject(stub, (instance: ComputerDO) =>
      (instance.substrate as { calls: { op: string }[] }).calls.map((c) => c.op),
    );
    expect(ops.filter((op) => op === 'wake' || op === 'materialize')).toEqual([]);
  });

  it('404s an unknown path without waking', async () => {
    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/files/nope/missing.txt`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(404);
    expect(await computerStub(computerId).getState()).toBe('cold');
  });
});
