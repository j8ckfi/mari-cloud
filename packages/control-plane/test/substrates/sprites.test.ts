// Sprites substrate driver tests.
//
// The bulk run against a local node:http MOCK that records every request and
// asserts the exact path, method, query, body, and auth header the driver sends
// for all six spec §3.5 functions, plus the driver's parse of the framed exec
// response. A final suite hits the REAL Sprites API and is gated on SPRITES_TOKEN.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  SpritesProvider,
  createSpritesProvider,
  SPRITES_SUBSTRATE,
} from '../../src/substrates/sprites.js';
import type { SpritesHandle } from '../../src/substrates/sprites.js';

interface RecordedRequest {
  method: string;
  path: string; // pathname only
  query: URLSearchParams;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

const TOKEN = 'test-token';

function frame(type: number, payload: Uint8Array | string): Buffer {
  const p = typeof payload === 'string' ? Buffer.from(payload) : Buffer.from(payload);
  return Buffer.concat([Buffer.from([type]), p]);
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Write exec frames one TCP segment at a time. The Sprites HTTP exec protocol
 * has no length prefix and relies on chunk boundaries (one read == one frame),
 * so the mock disables Nagle and spaces the writes out to keep them separate.
 */
async function writeExecFrames(res: ServerResponse, frames: Buffer[]): Promise<void> {
  res.socket?.setNoDelay(true);
  res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
  for (const f of frames) {
    res.write(f);
    await wait(25);
  }
  res.end();
}

describe('SpritesProvider (mock API)', () => {
  let server: Server;
  let baseUrl: string;
  let provider: SpritesProvider;
  let requests: RecordedRequest[];

  const handle = (over: Partial<SpritesHandle> = {}): SpritesHandle => ({
    substrate: SPRITES_SUBSTRATE,
    computer: 'comp-1',
    id: 'sprite-id-1',
    name: 'comp-1',
    url: 'https://comp-1-abc.sprites.app',
    env: {},
    ...over,
  });

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        requests.push({
          method: req.method ?? '',
          path: url.pathname,
          query: url.searchParams,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });

        const { method } = req;
        const path = url.pathname;

        // POST /v1/sprites — create
        if (method === 'POST' && path === '/v1/sprites') {
          const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'sprite-id-1',
              name: parsed.name,
              organization: 'test-org',
              url: `https://${parsed.name}-abc.sprites.app`,
              url_settings: parsed.url_settings,
              status: 'cold',
            }),
          );
          return;
        }

        // exec — POST /v1/sprites/:name/exec (checked before the GET/DELETE :name route)
        const execMatch = path.match(/^\/v1\/sprites\/([^/]+)\/exec$/);
        if (method === 'POST' && execMatch) {
          const cmds = url.searchParams.getAll('cmd');
          if (cmds[0] === 'true') {
            // wake's trivial ping: clean exit, no output.
            void writeExecFrames(res, [frame(3, Buffer.from([0]))]);
          } else {
            // Deterministic three-frame response exercising stdout, stderr, and
            // a non-zero exit code.
            void writeExecFrames(res, [
              frame(1, `stdout:${cmds.join(' ')}`),
              frame(2, 'e2'),
              frame(3, Buffer.from([3])),
            ]);
          }
          return;
        }

        // GET /v1/sprites/:name — read
        const getMatch = path.match(/^\/v1\/sprites\/([^/]+)$/);
        if (method === 'GET' && getMatch) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 'sprite-id-1',
              name: decodeURIComponent(getMatch[1]!),
              organization: 'test-org',
              url: 'https://sprite-xyz.sprites.app',
              status: 'running',
            }),
          );
          return;
        }

        // DELETE /v1/sprites/:name — destroy
        if (method === 'DELETE' && getMatch) {
          res.writeHead(204);
          res.end();
          return;
        }

        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    provider = new SpritesProvider({ token: TOKEN, baseUrl });
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  beforeEach(() => {
    requests = [];
  });

  it('materialize POSTs /v1/sprites with the correct body, auth, and returns a handle', async () => {
    const h = await provider.materialize({
      computer: 'comp-1',
      image: 'alpine',
      env: { MARI_TOKEN: 'x', MARI_EPOCH: '3' },
      mounts: [{ source: '/store', target: '/mnt' }],
      resources: { cpus: 1, memoryMiB: 512 },
    });

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/sprites');
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['content-type']).toBe('application/json');
    expect(JSON.parse(req.body.toString('utf8'))).toEqual({
      name: 'comp-1',
      wait_for_capacity: true,
      url_settings: { auth: 'sprite' },
    });

    expect(h.substrate).toBe(SPRITES_SUBSTRATE);
    expect(h.computer).toBe('comp-1');
    expect(h.id).toBe('sprite-id-1');
    expect(h.name).toBe('comp-1');
    expect(h.url).toBe('https://comp-1-abc.sprites.app');
    // env is carried on the handle for exec-time injection (Sprites has no
    // create-time env).
    expect(h.env).toEqual({ MARI_TOKEN: 'x', MARI_EPOCH: '3' });
  });

  it('destroy DELETEs /v1/sprites/:name with auth', async () => {
    await provider.destroy(handle());
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('DELETE');
    expect(req.path).toBe('/v1/sprites/comp-1');
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sleep is a no-op that issues no request (Sprites auto-suspends)', async () => {
    await provider.sleep(handle());
    expect(requests).toHaveLength(0);
  });

  it('wake forces the implicit wake with a trivial exec of `true`', async () => {
    await provider.wake(handle());
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/sprites/comp-1/exec');
    expect(req.query.getAll('cmd')).toEqual(['true']);
    expect(req.query.get('path')).toBe('true');
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('exec builds the query, sends stdin + auth, and parses the framed response', async () => {
    const res = await provider.exec(
      handle({ env: { MARI_TOKEN: 'x' } }),
      ['echo', 'hi'],
      { cwd: '/work', env: { A: 'b' }, input: 'stdin-data' },
    );

    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('POST');
    expect(req.path).toBe('/v1/sprites/comp-1/exec');
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(req.headers['content-type']).toBe('application/octet-stream');
    // cmd repeated per argv; path = argv[0]; dir = cwd.
    expect(req.query.getAll('cmd')).toEqual(['echo', 'hi']);
    expect(req.query.get('path')).toBe('echo');
    expect(req.query.get('dir')).toBe('/work');
    expect(req.query.get('stdin')).toBe('true');
    // handle env injected, then per-exec env; order: handle env first.
    expect(req.query.getAll('env')).toEqual(['MARI_TOKEN=x', 'A=b']);
    expect(req.body.toString('utf8')).toBe('stdin-data');

    // Frames: stdout "stdout:echo hi", stderr "e2", exit 3.
    expect(res.exitCode).toBe(3);
    expect(res.stdout).toBe('stdout:echo hi');
    expect(res.stderr).toBe('e2');
  });

  it('exposePort GETs the sprite and returns the port-qualified URL', async () => {
    const addr = await provider.exposePort(handle(), 8080);
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.method).toBe('GET');
    expect(req.path).toBe('/v1/sprites/comp-1');
    expect(req.headers.authorization).toBe(`Bearer ${TOKEN}`);
    // Address derived from the sprite's own url + the port.
    expect(addr).toBe('https://sprite-xyz.sprites.app:8080');
  });

  it('surfaces API errors with status text', async () => {
    // A handle whose name 404s on DELETE is treated as success, so exercise the
    // error path via exec against a name the mock 404s... the mock always
    // answers known routes, so hit an unknown method by exposePort on a GET that
    // 404s: use a bespoke provider pointed at a bad path is overkill. Instead
    // assert exec throws when the server 500s is covered by the real API; here
    // we assert a non-2xx create rejects.
    const bad = new SpritesProvider({ token: TOKEN, baseUrl: `${baseUrl}/nope` });
    await expect(
      bad.materialize({ computer: 'x', image: 'i', env: {} }),
    ).rejects.toThrow(/Sprites create sprite failed: 404/);
  });
});

// ── Real Sprites API — gated on SPRITES_TOKEN ────────────────────────────────
const SPRITES_TOKEN = process.env.SPRITES_TOKEN;
if (!SPRITES_TOKEN) {
  // eslint-disable-next-line no-console
  console.warn('[substrates/sprites] SPRITES_TOKEN not set — skipping real Sprites API test');
}

describe.skipIf(!SPRITES_TOKEN)('SpritesProvider (real API)', () => {
  it('materialize → exec echo → destroy round-trips against api.sprites.dev', async () => {
    const provider = createSpritesProvider();
    const computer = `mari-it-${Date.now()}`;
    const h = await provider.materialize({ computer, image: 'default', env: {} });
    try {
      const res = await provider.exec(h, ['echo', 'hello from sprites']);
      expect(res.exitCode).toBe(0);
      expect(res.stdout).toContain('hello from sprites');
    } finally {
      await provider.destroy(h);
    }
  });
});
