// File write + single-file read (spec 8.4, 8.5, 4.1).
//
// Spec 8.4: "For a computer that is not AWAKE, the file browser reads from the
// manifest head. A write to such a computer starts a wake." Spec 4.1: "The
// substrate disk of an AWAKE computer is the only copy that accepts writes."
//
// So a write here must: (a) start a wake, (b) NOT fabricate chunks in the store
// behind the supervisor's back, and (c) reach the supervisor EXACTLY ONCE — as a
// run, which is the only mechanism the control plane has for touching that disk.
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF } from 'cloudflare:test';
import {
  HOST,
  apiGet,
  computerStub,
  createComputer,
  delay,
  ensureSchema,
  eqBytes,
  FakeSupervisor,
  r2ObjectCount,
  seedSession,
  substrateOps,
  waitUntil,
} from './helpers';
import { fromBase64 } from '../src/bytes';
import { SEED_TREE } from '../src/seed';

interface WriteBody {
  ok: boolean;
  path: string;
  state: string;
  runId: string;
  queued: boolean;
  bytes: number;
  error?: string;
}

/** Pull the base64 payload out of the write run's shell script. */
function payloadOf(script: string): Uint8Array {
  const m = /printf '%s' '([A-Za-z0-9+/=]*)'/.exec(script);
  if (!m) throw new Error(`no base64 payload in script: ${script}`);
  return fromBase64(m[1]!);
}

/**
 * Everything a POSIX shell would treat as SYNTAX: the literal text of every
 * single-quoted segment is removed (honoring the `'\''` idiom for an embedded
 * quote). If quoting ever failed, user data would appear in this residue.
 */
function shellSyntaxOf(script: string): string {
  let out = '';
  let inQuote = false;
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    if (inQuote) {
      if (ch === "'") inQuote = false;
      continue;
    }
    if (ch === "'") {
      inQuote = true;
      continue;
    }
    if (ch === '\\') {
      i++; // an escaped literal outside quotes; not syntax
      continue;
    }
    out += ch;
  }
  if (inQuote) throw new Error('unbalanced quoting in script');
  return out;
}

// One seed per test FILE: the dev seed mints the identity, and re-running it in
// the same worker re-enters Better Auth's sign-up path.
let cookie = '';
let seededComputerId = '';
beforeAll(async () => {
  await ensureSchema();
  const seeded = await seedSession();
  cookie = seeded.cookie;
  seededComputerId = seeded.computerId;
});

describe('file write path (spec 8.4 wake-on-write)', () => {

  it('a write to a COLD computer starts a wake and is applied exactly once', async () => {
    const id = await createComputer(cookie, 'writable');
    const stub = computerStub(id);
    expect(await stub.getState()).toBe('cold');

    // Non-UTF8 bytes: the payload must survive byte-for-byte.
    const payload = new Uint8Array([0x00, 0xff, 0xfe, 0x68, 0x69, 0x0a, 0x80]);
    const objectsBefore = await r2ObjectCount();

    const res = await SELF.fetch(`${HOST}/api/computers/${id}/file?path=/notes/new.bin`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: payload,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as WriteBody;
    expect(body.ok).toBe(true);
    expect(body.path).toBe('/notes/new.bin');
    expect(body.bytes).toBe(payload.length);
    // The wake happens BEHIND the request (spec 8.3), so the reply says WAKING.
    expect(body.state).toBe('waking');
    expect(body.queued).toBe(true);

    // Spec 4.1: the control plane wrote NO chunks — the store is untouched
    // until the supervisor snapshots the disk it actually wrote.
    expect(await r2ObjectCount()).toBe(objectsBefore);

    // The wake really started, exactly once.
    await waitUntil(async () => (await stub.getState()) === 'awake', 3000, 'wake');
    expect((await substrateOps(stub)).filter((o) => o === 'materialize')).toEqual(['materialize']);

    // The supervisor receives ONE run that writes exactly those bytes there.
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const start = await sup.recv.waitForTag('start_run');
    expect(start.c.run).toBe(body.runId);
    expect(start.c.argv[0]).toBe('/bin/sh');
    expect(start.c.argv[1]).toBe('-c');
    const script = start.c.argv[2] as string;
    expect(script).toContain("mkdir -p '/notes'");
    expect(script).toContain("> '/notes/new.bin'");
    expect(eqBytes(payloadOf(script), payload)).toBe(true);

    await delay(60);
    expect(sup.recv.countTag('start_run')).toBe(1);

    // A reconnect must not apply the write a second time.
    sup.close();
    const sup2 = await FakeSupervisor.connect(id);
    await sup2.handshake(id, w.epoch, w.token);
    await expect(sup2.recv.waitForTag('start_run', 400)).rejects.toThrow(/timeout/);
    expect(sup2.recv.countTag('start_run')).toBe(0);
    sup2.close();

    // The write is a first-class run in the history (spec 5.2 gives it a
    // pre-run snapshot and a diff for free).
    const runs = await apiGet<{ runs: { id: string; kind?: string; writePath?: string }[] }>(
      `/api/computers/${id}/runs`,
      cookie,
    );
    const rec = runs.body.runs.find((r) => r.id === body.runId);
    expect(rec?.kind).toBe('write');
    expect(rec?.writePath).toBe('/notes/new.bin');
  });

  it('applies a write immediately when the computer is already AWAKE', async () => {
    const id = await createComputer(cookie, 'awake-writable');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const res = await SELF.fetch(`${HOST}/api/computers/${id}/file?path=/a/b/c.txt`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: new TextEncoder().encode('written while awake'),
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as WriteBody;
    expect(body.state).toBe('awake');
    expect(body.queued).toBe(false);

    const start = await sup.recv.waitForTag('start_run');
    expect(new TextDecoder().decode(payloadOf(start.c.argv[2] as string))).toBe(
      'written while awake',
    );
    expect(start.c.argv[2]).toContain("mkdir -p '/a/b'");
    sup.close();
  });

  it('quotes hostile paths and contents instead of letting them escape the shell', async () => {
    const id = await createComputer(cookie, 'quoting');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    // A benign write first: its shell SKELETON is the reference.
    const benign = await SELF.fetch(`${HOST}/api/computers/${id}/file?path=/tmp/plain.txt`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: new TextEncoder().encode('x'),
    });
    expect(benign.status).toBe(202);
    const benignScript = (await sup.recv.waitForTag('start_run')).c.argv[2] as string;

    const nasty = "/tmp/it's a file; rm -rf /.txt";
    const res = await SELF.fetch(
      `${HOST}/api/computers/${id}/file?path=${encodeURIComponent(nasty)}`,
      { method: 'PUT', headers: { Cookie: cookie }, body: new TextEncoder().encode("' ; reboot") },
    );
    expect(res.status).toBe(202);

    const start = await sup.recv.waitForTag('start_run');
    const script = start.c.argv[2] as string;
    // The apostrophe is closed, escaped, and re-opened, so the `; rm -rf /`
    // stays INSIDE the quoted argument.
    expect(script).toContain(`'/tmp/it'\\''s a file; rm -rf /.txt'`);
    // ...and the shell syntax of the hostile write is byte-identical to the
    // benign one: nothing the user supplied became a command.
    expect(shellSyntaxOf(script)).toBe(shellSyntaxOf(benignScript));
    expect(shellSyntaxOf(script)).not.toContain('rm -rf');
    expect(shellSyntaxOf(script)).not.toContain('reboot');
    sup.close();
  });

  it('rejects a traversal path, a directory target, and an oversized body', async () => {
    const id = await createComputer(cookie, 'guarded');

    const traversal = await SELF.fetch(`${HOST}/api/computers/${id}/file?path=/a/../../etc/passwd`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: new TextEncoder().encode('x'),
    });
    expect(traversal.status).toBe(400);

    const dir = await SELF.fetch(`${HOST}/api/computers/${id}/file?path=/a/b/`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: new TextEncoder().encode('x'),
    });
    expect(dir.status).toBe(400);

    const big = await SELF.fetch(`${HOST}/api/computers/${id}/file?path=/big.bin`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: new Uint8Array(256 * 1024 + 1),
    });
    expect(big.status).toBe(413);

    // None of the rejections queued a run.
    const runs = await apiGet<{ runs: unknown[] }>(`/api/computers/${id}/runs`, cookie);
    expect(runs.body.runs).toEqual([]);
  });

  it('uploads a file through the multipart route as the same queued write', async () => {
    const id = await createComputer(cookie, 'uploader');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const form = new FormData();
    form.set('path', '/uploads/photo.bin');
    form.set('file', new Blob([new Uint8Array([1, 2, 3, 250])]));
    const res = await SELF.fetch(`${HOST}/api/computers/${id}/upload`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: form,
    });
    expect(res.status).toBe(202);
    const body = (await res.json()) as WriteBody;
    expect(body.path).toBe('/uploads/photo.bin');

    const start = await sup.recv.waitForTag('start_run');
    expect(eqBytes(payloadOf(start.c.argv[2] as string), new Uint8Array([1, 2, 3, 250]))).toBe(true);
    sup.close();
  });

  it('requires ownership for a write', async () => {
    const anon = await SELF.fetch(`${HOST}/api/computers/seedcomputer/file?path=/x`, {
      method: 'PUT',
      body: new TextEncoder().encode('x'),
    });
    expect(anon.status).toBe(401);

    const foreign = await SELF.fetch(`${HOST}/api/computers/someone-else/file?path=/x`, {
      method: 'PUT',
      headers: { Cookie: cookie },
      body: new TextEncoder().encode('x'),
    });
    expect(foreign.status).toBe(404);
  });
});

describe('single-file read (spec 8.5 editor load / download)', () => {
  let computerId = '';
  beforeAll(() => {
    computerId = seededComputerId;
  });

  it('serves a COLD computer’s file from the manifest without waking it', async () => {
    const before = await substrateOps(computerStub(computerId));
    const res = await SELF.fetch(
      `${HOST}/api/computers/${computerId}/file?path=/README.md`,
      { headers: { Cookie: cookie } },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('x-mari-state')).toBe('cold');
    expect(res.headers.get('x-mari-source')).toBe('manifest');
    const got = new Uint8Array(await res.arrayBuffer());
    expect(eqBytes(got, new TextEncoder().encode(SEED_TREE['/README.md']!))).toBe(true);

    expect(await computerStub(computerId).getState()).toBe('cold');
    expect(await substrateOps(computerStub(computerId))).toEqual(before);
  });

  it('serves the same file for an AWAKE computer', async () => {
    const stub = computerStub(computerId);
    await stub.wake(computerId);
    expect(await stub.getState()).toBe('awake');

    const res = await SELF.fetch(`${HOST}/api/computers/${computerId}/file?path=/src/main.ts`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-mari-state')).toBe('awake');
    const got = new Uint8Array(await res.arrayBuffer());
    expect(eqBytes(got, new TextEncoder().encode(SEED_TREE['/src/main.ts']!))).toBe(true);
  });

  it('404s a missing path and 400s a directory', async () => {
    const missing = await SELF.fetch(`${HOST}/api/computers/${computerId}/file?path=/nope.txt`, {
      headers: { Cookie: cookie },
    });
    expect(missing.status).toBe(404);

    const dir = await SELF.fetch(`${HOST}/api/computers/${computerId}/file?path=/src`, {
      headers: { Cookie: cookie },
    });
    expect(dir.status).toBe(400);
  });

  it('the directory listing names its computer and manifest', async () => {
    const listing = await apiGet<{
      computer: string;
      manifest: string;
      path: string;
      entries: { name: string; symlinkTarget: string | null }[];
    }>(`/api/computers/${computerId}/files?path=/src`, cookie);
    expect(listing.status).toBe(200);
    expect(listing.body.computer).toBe(computerId);
    expect(listing.body.manifest).toMatch(/^[0-9a-f]{64}$/);
    expect(listing.body.entries.map((e) => e.name).sort()).toEqual(['main.ts', 'util.ts']);
    expect(listing.body.entries[0]!.symlinkTarget).toBeNull();
  });
});
