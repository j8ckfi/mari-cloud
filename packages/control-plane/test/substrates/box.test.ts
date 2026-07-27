// Box substrate driver unit tests — stubbed fetch, no network.
//
// These pin the WIRE PROTOCOL: the exact method/path/headers/body the driver
// sends for every spec §3.5 function, its decode of the `{ok, type}` response
// envelopes (command.finished, box.info, error envelopes), the bounded polling
// of async transitions (provisioning → ready, archiving → archived), and that
// every deadline actually fires instead of hanging. The real API is exercised
// by box.e2e.test.ts, gated on BOX_API_KEY.

import { describe, it, expect } from 'vitest';
import {
  BoxProvider,
  BoxSubstrateError,
  createBoxProvider,
  BOX_SUBSTRATE,
  DEFAULT_BOX_BASE_URL,
} from '../../src/substrates/box.js';
import type { BoxConfig, BoxHandle } from '../../src/substrates/box.js';

const KEY = 'box_testkey';
const BASE = 'https://box.test/api/box/v1';
const BIN_URL = 'https://releases.test/marid-x86_64-musl';

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A scripted fetch: each call consumes the next responder. A responder gets the
 * recorded request and returns [status, jsonBody]. Running past the script or
 * leaving responders unconsumed fails the test — request COUNT is part of the
 * protocol (bounded polling).
 */
function stub(responders: Array<(req: Recorded) => [number, unknown]>) {
  const requests: Recorded[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init?.headers ?? {}) as Record<string, string>)) {
      headers[k.toLowerCase()] = v;
    }
    const rawBody = init?.body;
    const req: Recorded = {
      method: init?.method ?? 'GET',
      path: url.pathname.replace(/^\/api\/box\/v1/, ''),
      headers,
      body: typeof rawBody === 'string' && rawBody.length > 0 ? JSON.parse(rawBody) : undefined,
    };
    requests.push(req);
    const responder = responders.shift();
    if (!responder) throw new Error(`unexpected request #${requests.length}: ${req.method} ${req.path}`);
    const [status, body] = responder(req);
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as typeof fetch;
  return {
    fetchImpl,
    requests,
    assertDrained() {
      expect(responders).toHaveLength(0);
    },
  };
}

/** Deterministic time: sleeps advance a fake clock instantly. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleepFn: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
  };
}

function provider(fetchImpl: typeof fetch, over: Partial<BoxConfig> = {}): BoxProvider {
  const clock = fakeClock();
  return new BoxProvider({
    apiKey: KEY,
    baseUrl: BASE,
    maridBinaryUrl: BIN_URL,
    fetch: fetchImpl,
    now: clock.now,
    sleepFn: clock.sleepFn,
    ...over,
  });
}

function box(state: string, over: Record<string, unknown> = {}) {
  return { id: 'bx_abcdefgh', name: 'mari-1', state, subdomain: 'silly-word-slug', ...over };
}

const okCommand = (over: Record<string, unknown> = {}) => ({
  ok: true,
  type: 'command.finished',
  success: true,
  exitCode: 0,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  ...over,
});

const handle = (over: Partial<BoxHandle> = {}): BoxHandle => ({
  substrate: BOX_SUBSTRATE,
  computer: 'comp-1',
  id: 'bx_abcdefgh',
  env: { MARI_TOKEN: 'tok', MARI_EPOCH: '3' },
  cmd: null,
  maridBinaryUrl: BIN_URL,
  ports: [],
  subdomain: 'silly-word-slug',
  ...over,
});

describe('BoxProvider materialize', () => {
  it('creates, polls provisioning→ready, then bootstraps marid detached', async () => {
    const s = stub([
      // POST /boxes — the create body is the whole platform contract here.
      (req) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/boxes');
        expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
        expect(req.headers['content-type']).toBe('application/json');
        expect(req.body).toEqual({
          // Platform TTL disabled: it counts from CREATION; the DO tier alarm
          // owns idle policy.
          ttlSeconds: null,
          env: { MARI_COMPUTER_ID: 'comp-1', MARI_EPOCH: '7', MARI_TOKEN: 's3cret' },
          // A Mari computer never inherits the Ascii account's secrets.
          noEnv: true,
        });
        return [202, { ok: true, type: 'box.created', status: 'provisioning', box: box('provisioning') }];
      },
      // Bounded poll: two GETs until ready.
      (req) => {
        expect(req.method).toBe('GET');
        expect(req.path).toBe('/boxes/bx_abcdefgh');
        return [200, { ok: true, type: 'box.info', box: box('provisioning') }];
      },
      () => [200, { ok: true, type: 'box.info', box: box('ready') }],
      // Bootstrap command.
      (req) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/boxes/bx_abcdefgh/commands');
        const body = req.body as { command: string; timeoutSeconds: number };
        expect(body.timeoutSeconds).toBe(60);
        const c = body.command;
        // Download-if-absent from the deployment var URL, then chmod.
        expect(c).toContain(`if [ ! -x '/usr/local/bin/marid' ]`);
        expect(c).toContain(`curl -fsSL '${BIN_URL}' -o '/usr/local/bin/marid'`);
        expect(c).toContain(`chmod +x '/usr/local/bin/marid'`);
        // The whole marid env exported, values single-quoted.
        expect(c).toContain(`export MARI_COMPUTER_ID='comp-1'`);
        expect(c).toContain(`export MARI_EPOCH='7'`);
        expect(c).toContain(`export MARI_TOKEN='s3cret'`);
        // Detached start: the command returns while marid keeps running.
        expect(c).toContain(
          `setsid nohup '/usr/local/bin/marid' >> '/var/log/marid.log' 2>&1 < /dev/null &`,
        );
        return [200, okCommand({ stdout: 'mari-box-bootstrap-ok\n' })];
      },
    ]);

    const p = provider(s.fetchImpl);
    const h = await p.materialize({
      computer: 'comp-1',
      image: 'mari/base:v0', // no image API exists; recorded, not sent
      env: { MARI_COMPUTER_ID: 'comp-1', MARI_EPOCH: '7', MARI_TOKEN: 's3cret' },
      ports: [8080],
    });

    expect(h).toEqual({
      substrate: 'box',
      computer: 'comp-1',
      id: 'bx_abcdefgh',
      env: { MARI_COMPUTER_ID: 'comp-1', MARI_EPOCH: '7', MARI_TOKEN: 's3cret' },
      cmd: null,
      maridBinaryUrl: BIN_URL,
      ports: [8080],
      subdomain: 'silly-word-slug',
    });
    s.assertDrained();
  });

  it('a cmd override replaces the marid program and skips the download', async () => {
    const s = stub([
      () => [202, { ok: true, type: 'box.created', box: box('provisioning') }],
      () => [200, { ok: true, type: 'box.info', box: box('idle') }],
      (req) => {
        const c = (req.body as { command: string }).command;
        expect(c).not.toContain('curl');
        expect(c).toContain(`setsid nohup '/bin/sh' '-c' 'echo hi' >> '/var/log/marid.log'`);
        return [200, okCommand({ stdout: 'mari-box-bootstrap-ok\n' })];
      },
    ]);
    const p = provider(s.fetchImpl, { maridBinaryUrl: undefined });
    const h = await p.materialize({
      computer: 'comp-1',
      image: 'x',
      env: {},
      cmd: ['/bin/sh', '-c', 'echo hi'],
    });
    expect(h.cmd).toEqual(['/bin/sh', '-c', 'echo hi']);
    expect(h.maridBinaryUrl).toBeNull();
    s.assertDrained();
  });

  it('refuses to materialize without MARID_BINARY_URL and without a cmd', async () => {
    const s = stub([]);
    const p = provider(s.fetchImpl, { maridBinaryUrl: undefined });
    await expect(p.materialize({ computer: 'c', image: 'x', env: {} })).rejects.toThrow(
      /MARID_BINARY_URL/,
    );
    expect(s.requests).toHaveLength(0); // fails BEFORE creating a billable box
  });

  it('a box that lands in `error` fails immediately, not at the deadline', async () => {
    const s = stub([
      () => [202, { ok: true, type: 'box.created', box: box('provisioning') }],
      () => [200, { ok: true, type: 'box.info', box: box('error') }],
    ]);
    const p = provider(s.fetchImpl);
    await expect(
      p.materialize({ computer: 'c', image: 'x', env: {} }),
    ).rejects.toMatchObject({ name: 'BoxSubstrateError', kind: 'api' });
    s.assertDrained();
  });

  it('polling is bounded: a box stuck provisioning times out with a typed error', async () => {
    // Enough responders for the whole budget; the deadline must stop the loop
    // long before they run out.
    const responders = Array.from({ length: 50 }, (_, i) =>
      i === 0
        ? () => [202, { ok: true, type: 'box.created', box: box('provisioning') }] as [number, unknown]
        : () => [200, { ok: true, type: 'box.info', box: box('provisioning') }] as [number, unknown],
    );
    const s = stub(responders);
    const p = provider(s.fetchImpl, { createTimeoutMs: 5_000, pollIntervalMs: 1_000 });
    const err = await p.materialize({ computer: 'c', image: 'x', env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(BoxSubstrateError);
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
    expect(err.message).toContain('last state: "provisioning"');
    // create + ~6 polls (1 s apart against a 5 s budget), nowhere near 50.
    expect(s.requests.length).toBeLessThanOrEqual(8);
  });

  it('a failed bootstrap archives the box before reporting (no orphan billing)', async () => {
    const s = stub([
      () => [202, { ok: true, type: 'box.created', box: box('provisioning') }],
      () => [200, { ok: true, type: 'box.info', box: box('ready') }],
      () => [200, okCommand({ exitCode: 1, stderr: 'curl: (22) 404' })],
      (req) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/boxes/bx_abcdefgh/stop');
        return [202, { ok: true, type: 'box.stopping', status: 'archiving' }];
      },
    ]);
    const p = provider(s.fetchImpl);
    await expect(p.materialize({ computer: 'c', image: 'x', env: {} })).rejects.toThrow(
      /bootstrap.*failed \(exit 1\).*404/s,
    );
    s.assertDrained();
  });
});

describe('BoxProvider exec', () => {
  it('POSTs a shell-quoted argv with timeoutSeconds and decodes command.finished', async () => {
    const s = stub([
      (req) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/boxes/bx_abcdefgh/commands');
        expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
        // argv is NOT shell-interpreted: each element single-quoted.
        expect(req.body).toEqual({ command: `'echo' 'hello world' '$HOME'`, timeoutSeconds: 60 });
        return [200, okCommand({ exitCode: 3, stdout: 'out-bytes', stderr: 'err-bytes' })];
      },
    ]);
    const p = provider(s.fetchImpl);
    const res = await p.exec(handle(), ['echo', 'hello world', '$HOME']);
    expect(res).toEqual({ exitCode: 3, stdout: 'out-bytes', stderr: 'err-bytes' });
    s.assertDrained();
  });

  it('compiles cwd, per-exec env, and stdin into the shell string', async () => {
    const s = stub([
      (req) => {
        const { command } = req.body as { command: string };
        // cd (absolute in-computer path; the API cwd field is relative-only),
        // then stdin via base64 pipe, then env(1), then the argv.
        expect(command).toBe(
          `cd '/work/dir' && printf %s 'aGkA/w==' | base64 -d | env 'A=b c' 'B=2' 'cat' '-'`,
        );
        return [200, okCommand({ stdout: 'hi' })];
      },
    ]);
    const p = provider(s.fetchImpl);
    // "hi\x00\xff" — a NUL and a high byte: bytes must survive the transport.
    const res = await p.exec(handle(), ['cat', '-'], {
      cwd: '/work/dir',
      env: { A: 'b c', B: '2' },
      input: new Uint8Array([0x68, 0x69, 0x00, 0xff]),
    });
    expect(res.exitCode).toBe(0);
    s.assertDrained();
  });

  it('single quotes in argv survive the quoting', async () => {
    const s = stub([
      (req) => {
        expect((req.body as { command: string }).command).toBe(`'echo' 'it'\\''s'`);
        return [200, okCommand()];
      },
    ]);
    await provider(s.fetchImpl).exec(handle(), ['echo', "it's"]);
    s.assertDrained();
  });

  it('normalizes a signal death to 128 + signal', async () => {
    const s = stub([() => [200, okCommand({ exitCode: null, signal: 'SIGKILL' })]]);
    const res = await provider(s.fetchImpl).exec(handle(), ['sleep', '999']);
    expect(res.exitCode).toBe(137);
    s.assertDrained();
  });

  it('maps machine_not_running to a typed not_running error (never auto-starts)', async () => {
    const s = stub([
      () => [
        400,
        {
          ok: false,
          type: 'box.error',
          status: 400,
          code: 'machine_not_running',
          message: 'box is archived',
          requestId: 'req_1',
        },
      ],
    ]);
    const err = await provider(s.fetchImpl).exec(handle(), ['true']).catch((e) => e);
    expect(err).toBeInstanceOf(BoxSubstrateError);
    expect(err.kind).toBe('not_running');
    expect(err.code).toBe('machine_not_running');
    expect(err.requestId).toBe('req_1');
    expect(s.requests).toHaveLength(1); // no start was attempted
  });

  it('a server-side command timeout is a typed timeout error, not a fake exit code', async () => {
    const s = stub([() => [200, okCommand({ exitCode: null, timedOut: true })]]);
    const err = await provider(s.fetchImpl).exec(handle(), ['sleep', '999']).catch((e) => e);
    expect(err).toBeInstanceOf(BoxSubstrateError);
    expect(err.kind).toBe('timeout');
  });

  it('rejects an empty argv and an invalid env name before any request', async () => {
    const s = stub([]);
    const p = provider(s.fetchImpl);
    await expect(p.exec(handle(), [])).rejects.toThrow(/non-empty argv/);
    await expect(p.exec(handle(), ['x'], { env: { 'BAD NAME': '1' } })).rejects.toThrow(
      /invalid environment variable name/,
    );
    expect(s.requests).toHaveLength(0);
  });
});

describe('BoxProvider sleep / wake', () => {
  it('sleep POSTs stop and polls archiving → archived', async () => {
    const s = stub([
      (req) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/boxes/bx_abcdefgh/stop');
        return [202, { ok: true, type: 'box.stopping', id: 'bx_abcdefgh', status: 'archiving' }];
      },
      () => [200, { ok: true, type: 'box.info', box: box('archiving') }],
      () => [200, { ok: true, type: 'box.info', box: box('archived') }],
    ]);
    await provider(s.fetchImpl).sleep(handle());
    s.assertDrained();
  });

  it('sleep times out (typed, retryable) if archiving never completes', async () => {
    const responders: Array<(req: Recorded) => [number, unknown]> = [
      () => [202, { ok: true, type: 'box.stopping', status: 'archiving' }],
      ...Array.from(
        { length: 50 },
        () => (): [number, unknown] => [200, { ok: true, type: 'box.info', box: box('archiving') }],
      ),
    ];
    const s = stub(responders);
    const p = provider(s.fetchImpl, { archiveTimeoutMs: 3_000, pollIntervalMs: 1_000 });
    const err = await p.sleep(handle()).catch((e) => e);
    expect(err).toBeInstanceOf(BoxSubstrateError);
    expect(err.kind).toBe('timeout');
    expect(s.requests.length).toBeLessThanOrEqual(6);
  });

  it('wake resumes, polls to ready, and re-runs the bootstrap (reboot semantics)', async () => {
    const s = stub([
      (req) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/boxes/bx_abcdefgh/resume');
        return [202, { ok: true, type: 'box.resuming', box: box('provisioning') }];
      },
      () => [200, { ok: true, type: 'box.info', box: box('provisioning') }],
      () => [200, { ok: true, type: 'box.info', box: box('ready') }],
      (req) => {
        expect(req.path).toBe('/boxes/bx_abcdefgh/commands');
        const c = (req.body as { command: string }).command;
        // Same bootstrap, rebuilt from the handle alone: env re-exported, and
        // the download self-skips (the restored disk still has the binary).
        expect(c).toContain(`export MARI_TOKEN='tok'`);
        expect(c).toContain(`if [ ! -x '/usr/local/bin/marid' ]`);
        expect(c).toContain('setsid nohup');
        return [200, okCommand({ stdout: 'mari-box-bootstrap-ok' })];
      },
    ]);
    await provider(s.fetchImpl).wake(handle());
    s.assertDrained();
  });

  it('wake tolerates a 409 resume conflict when the box is already running', async () => {
    const s = stub([
      () => [
        409,
        { ok: false, type: 'box.error', status: 409, code: 'box_not_archived', message: 'running' },
      ],
      () => [200, { ok: true, type: 'box.info', box: box('idle') }],
      () => [200, okCommand({ stdout: 'mari-box-bootstrap-ok' })],
    ]);
    await provider(s.fetchImpl).wake(handle());
    s.assertDrained();
  });
});

describe('BoxProvider destroy', () => {
  it('destroy is archive+forget: POST stop, no poll (no delete endpoint exists)', async () => {
    const s = stub([
      (req) => {
        expect(req.method).toBe('POST');
        expect(req.path).toBe('/boxes/bx_abcdefgh/stop');
        return [202, { ok: true, type: 'box.stopping', status: 'archiving' }];
      },
    ]);
    await provider(s.fetchImpl).destroy(handle());
    s.assertDrained();
  });

  it('destroying an already-gone box (404) resolves without error', async () => {
    const s = stub([
      () => [404, { ok: false, type: 'box.error', status: 404, code: 'not_found' }],
    ]);
    await provider(s.fetchImpl).destroy(handle());
    s.assertDrained();
  });

  it('a 409 whose state reads archived is success; any other 409 is not', async () => {
    const ok = stub([
      () => [409, { ok: false, type: 'box.error', status: 409, code: 'conflict' }],
      () => [200, { ok: true, type: 'box.info', box: box('archived') }],
    ]);
    await provider(ok.fetchImpl).destroy(handle());
    ok.assertDrained();

    const bad = stub([
      () => [409, { ok: false, type: 'box.error', status: 409, code: 'conflict' }],
      () => [200, { ok: true, type: 'box.info', box: box('running') }],
    ]);
    await expect(provider(bad.fetchImpl).destroy(handle())).rejects.toMatchObject({
      kind: 'conflict',
    });
  });
});

describe('BoxProvider exposePort', () => {
  it('registers via `host <port>` then returns the URL `host url <port>` prints', async () => {
    const s = stub([
      (req) => {
        expect(req.body).toMatchObject({ command: `'host' '8080'` });
        return [200, okCommand({ stdout: 'hosted port 8080\n' })];
      },
      (req) => {
        expect(req.body).toMatchObject({ command: `'host' 'url' '8080'` });
        return [
          200,
          okCommand({ stdout: 'https://silly-word-slug-8080.on.ascii.dev?_token=t0k3n\n' }),
        ];
      },
    ]);
    const url = await provider(s.fetchImpl).exposePort(handle(), 8080);
    expect(url).toBe('https://silly-word-slug-8080.on.ascii.dev?_token=t0k3n');
    s.assertDrained();
  });

  it('a failing host command surfaces its stderr; an invalid port never sends', async () => {
    const s = stub([() => [200, okCommand({ exitCode: 1, stderr: 'nothing listening' })]]);
    const p = provider(s.fetchImpl);
    await expect(p.exposePort(handle(), 8080)).rejects.toThrow(/nothing listening/);
    await expect(p.exposePort(handle(), 0)).rejects.toThrow(/invalid port/);
    await expect(p.exposePort(handle(), 70000)).rejects.toThrow(/invalid port/);
  });
});

describe('BoxProvider instanceStatus', () => {
  const cases: Array<[string, string]> = [
    ['ready', 'alive'],
    ['running', 'alive'],
    ['provisioning', 'alive'],
    ['archiving', 'alive'],
    // The one this method exists for: an archived box RESUMES WITH ITS DISK —
    // that is WARM, not gone; `gone` would trigger a needless recovery.
    ['archived', 'alive'],
    // The platform does not vouch for an errored machine's disk; bounded
    // `unknown`, neither trusted nor destroyed.
    ['error', 'unknown'],
  ];
  for (const [state, verdict] of cases) {
    it(`state "${state}" → ${verdict}`, async () => {
      const s = stub([() => [200, { ok: true, type: 'box.info', box: box(state) }]]);
      expect(await provider(s.fetchImpl).instanceStatus(handle())).toBe(verdict);
    });
  }

  it('404 → gone (deleted platform-side; only the chunk store holds the computer)', async () => {
    const s = stub([() => [404, { ok: false, type: 'box.error', status: 404, code: 'not_found' }]]);
    expect(await provider(s.fetchImpl).instanceStatus(handle())).toBe('gone');
  });

  it('an unreachable API is unknown, never gone — and never a throw', async () => {
    const failing = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    expect(await provider(failing).instanceStatus(handle())).toBe('unknown');
  });

  it('a foreign handle is unknown', async () => {
    const s = stub([]);
    expect(
      await provider(s.fetchImpl).instanceStatus({ substrate: 'docker', computer: 'c', id: 'x' }),
    ).toBe('unknown');
  });
});

describe('BoxProvider holdAwake', () => {
  it('is a no-op under the default ttlSeconds: null', async () => {
    const s = stub([]);
    await provider(s.fetchImpl).holdAwake(handle());
    expect(s.requests).toHaveLength(0);
  });

  it('re-asserts a configured TTL via PATCH, and swallows failures', async () => {
    const s = stub([
      (req) => {
        expect(req.method).toBe('PATCH');
        expect(req.path).toBe('/boxes/bx_abcdefgh');
        expect(req.body).toEqual({ ttlSeconds: 7200 });
        return [200, { ok: true, type: 'box.updated' }];
      },
    ]);
    await provider(s.fetchImpl, { ttlSeconds: 7200 }).holdAwake(handle());
    s.assertDrained();

    const failing = stub([() => [500, { ok: false, type: 'box.error', status: 500 }]]);
    await provider(failing.fetchImpl, { ttlSeconds: 7200 }).holdAwake(handle()); // no throw
  });
});

describe('BoxProvider deadlines and envelopes', () => {
  it('every HTTP call has a hard deadline: a hung fetch becomes a typed timeout', async () => {
    // A fetch that resolves only on abort — the platform hanging, not erroring.
    const hanging = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as typeof fetch;
    const p = new BoxProvider({
      apiKey: KEY,
      baseUrl: BASE,
      fetch: hanging,
      requestTimeoutMs: 50, // real timer: this test proves the abort actually fires
      execTimeoutMs: 50,
    });
    const err = await p.exec(handle(), ['true']).catch((e) => e);
    expect(err).toBeInstanceOf(BoxSubstrateError);
    expect(err.kind).toBe('timeout');
    expect(err.retryable).toBe(true);
    // And the never-throwing probe reads the same hang as `unknown`.
    expect(await p.instanceStatus(handle())).toBe('unknown');
  });

  it('error envelopes map to typed kinds', async () => {
    const cases: Array<[number, string, string]> = [
      [401, 'unauthorized', 'auth'],
      [402, 'billing_required', 'auth'],
      [404, 'not_found', 'not_found'],
      [409, 'provider_not_configured', 'conflict'],
      [429, 'rate_limited', 'capacity'],
      [500, 'internal', 'api'],
    ];
    for (const [status, code, kind] of cases) {
      const s = stub([
        () => [status, { ok: false, type: 'box.error', status, code, message: 'm', requestId: 'r' }],
      ]);
      const err = await provider(s.fetchImpl).exec(handle(), ['true']).catch((e) => e);
      expect(err, `status ${status}`).toBeInstanceOf(BoxSubstrateError);
      expect(err.kind).toBe(kind);
      expect(err.status).toBe(status);
      expect(err.message).toContain(code);
      expect(err.message).toContain('requestId r');
    }
  });

  it('a 200 whose envelope says ok:false is still an error', async () => {
    const s = stub([
      () => [200, { ok: false, type: 'box.error', code: 'weird', message: 'nope' }],
    ]);
    await expect(provider(s.fetchImpl).exec(handle(), ['true'])).rejects.toThrow(/weird/);
  });

  it('rejects a handle from another substrate', async () => {
    const s = stub([]);
    const foreign = { substrate: 'sprites', computer: 'c', id: 'x' };
    await expect(provider(s.fetchImpl).exec(foreign, ['true'])).rejects.toThrow(/"sprites" handle/);
    await expect(provider(s.fetchImpl).destroy(foreign)).rejects.toThrow(/"sprites" handle/);
  });
});

describe('createBoxProvider / registry surface', () => {
  it('reads BOX_API_KEY / BOX_BASE_URL / MARID_BINARY_URL from env', () => {
    const p = createBoxProvider({
      BOX_API_KEY: 'box_k',
      BOX_BASE_URL: 'https://example.test/v1',
      MARID_BINARY_URL: BIN_URL,
    });
    expect(p.name).toBe(BOX_SUBSTRATE);
    expect(() => createBoxProvider({})).toThrow(/BOX_API_KEY/);
  });

  it('declares WARM supported (archive IS warm) and resume-before-cold', () => {
    const p = provider(stub([]).fetchImpl);
    expect(p.supportsWarm).toBe(true);
    // An archived box runs no processes: the DO must resume it before asking
    // the supervisor to prepare_for_cold (computer-do's FreezingSubstrate).
    expect(p.resumeBeforeCold(handle())).toBe(true);
    expect(DEFAULT_BOX_BASE_URL).toBe('https://ascii.dev/api/box/v1');
  });
});
