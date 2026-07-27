// Cloudflare Containers driver — the spec §3.5 mapping, asserted call by call.
//
// No gate: this suite needs no Docker, no network and no Cloudflare account. It
// drives the REAL driver against a fake `ctx.container` that records the exact
// platform calls and THROWS on any property outside the raw container API — so
// "raw ctx.container only, never the Sandbox SDK, never keepAlive" is enforced
// here rather than promised in a comment.
//
// The real-container suite is cloudflare.e2e.test.ts (gated on MARI_CF_E2E=1).

import { describe, it, expect } from 'vitest';
import {
  CloudflareProvider,
  CloudflareSubstrateError,
  createCloudflareProvider,
  CLOUDFLARE_SUBSTRATE,
  COMPUTER_LABEL,
  EPOCH_LABEL,
  type CloudflareHandle,
} from '../../src/substrates/cloudflare.js';
import type { MaterializeSpec, SubstrateHandle } from '../../src/substrates/provider.js';
import { FakeContainer, ALLOWED_SURFACE, type FakeContainerOptions } from './fake-container.js';

/** marid's whole configuration, exactly as ComputerDO composes it. */
const MARID_ENV = {
  MARI_COMPUTER_ID: 'comp-1',
  MARI_EPOCH: '7',
  MARI_TOKEN: 'tok-secret',
  MARI_ROOT: '/work',
  MARI_STORE: 'https://acct.r2.cloudflarestorage.com/mari-store',
  MARI_CONTROL_URL: 'wss://app.mari.sh/supervisor/comp-1',
  MARI_RESTORE_MANIFEST: 'a'.repeat(64),
} as const;

function spec(overrides: Partial<MaterializeSpec> = {}): MaterializeSpec {
  return {
    computer: 'comp-1',
    image: 'mari/base:v0',
    env: { ...MARID_ENV },
    ...overrides,
  } as MaterializeSpec;
}

/** A provider over a fresh fake, with test-fast timings. */
function makeProvider(
  options: FakeContainerOptions = {},
  config: Partial<Parameters<typeof createCloudflareProvider>[0]> = {},
): { provider: CloudflareProvider; fake: FakeContainer } {
  const fake = new FakeContainer(options);
  const provider = createCloudflareProvider({
    container: fake.asContainer(),
    startTimeoutMs: 200,
    probeIntervalMs: 1,
    execTimeoutMs: 200,
    destroyTimeoutMs: 200,
    ...config,
  });
  return { provider, fake };
}

async function materialized(
  options: FakeContainerOptions = {},
  config: Partial<Parameters<typeof createCloudflareProvider>[0]> = {},
): Promise<{ provider: CloudflareProvider; fake: FakeContainer; handle: CloudflareHandle }> {
  const { provider, fake } = makeProvider(options, config);
  const handle = await provider.materialize(spec());
  return { provider, fake, handle };
}

describe('materialize (spec §3.5)', () => {
  it('starts with the entrypoint, marid env, enableInternet and labels — and nothing else', async () => {
    const { fake, handle } = await materialized();

    // start() first, then the readiness probe. Nothing else touched the platform.
    expect(fake.ops()).toEqual(['start', 'exec']);

    const opts = fake.startOptions();
    // enableInternet is mandatory: the journal and control channel are an
    // outbound wss:// on 443.
    expect(opts.enableInternet).toBe(true);
    // marid's configuration, byte for byte, nothing added or dropped.
    expect(opts.env).toEqual(MARID_ENV);
    expect(opts.labels).toEqual({ [COMPUTER_LABEL]: 'comp-1', [EPOCH_LABEL]: '7' });
    // No entrypoint key at all when the caller did not override it, so the
    // image's own ENTRYPOINT (marid) runs.
    expect('entrypoint' in opts).toBe(false);
    // `image` and `resources` have nowhere to go on this substrate (both are
    // deploy-time properties of the DO class) and must NOT be smuggled in.
    expect(Object.keys(opts).sort()).toEqual(['enableInternet', 'env', 'labels']);

    expect(handle).toMatchObject({
      substrate: CLOUDFLARE_SUBSTRATE,
      computer: 'comp-1',
      id: 'comp-1',
      entrypoint: null,
      epoch: 7,
      ports: [],
    });
  });

  it('passes a cmd override through as the entrypoint', async () => {
    const { provider, fake } = makeProvider();
    const handle = await provider.materialize(spec({ cmd: ['/bin/sh', '-c', 'sleep 1'] }));
    expect(fake.startOptions().entrypoint).toEqual(['/bin/sh', '-c', 'sleep 1']);
    expect(handle.entrypoint).toEqual(['/bin/sh', '-c', 'sleep 1']);
  });

  it('never persists startup env or secrets on the durable handle', async () => {
    const { provider } = makeProvider();
    const mutable = { ...MARID_ENV } as Record<string, string>;
    const handle = await provider.materialize(spec({ env: mutable }));
    expect(handle).not.toHaveProperty('env');
    expect(JSON.stringify(handle)).not.toContain('tok-secret');
  });

  it('destroys the previous generation first when the single instance slot is occupied', async () => {
    // One DO = one container instance. An instance already running when a NEW
    // epoch materializes is the fenced-out generation (spec §4.1: two writable
    // copies of one computer must not exist).
    const { provider, fake } = makeProvider({ running: true });
    await provider.materialize(spec());
    expect(fake.ops()).toEqual(['destroy', 'start', 'exec']);
  });

  it('retries start() until the instance is really exec-ready (the post-destroy stall)', async () => {
    // Measured: after destroy(), start() is refused for minutes with a stale
    // running=true, and exec fails with "no container instance". The honest wake
    // is therefore: keep trying, and let the first successful exec be the signal.
    const { provider, fake } = makeProvider({
      running: true,
      onStart: (n) => (n < 2 ? 'start() cannot be called on a container that is already running.' : undefined),
      exec: {
        '*': [
          { throws: 'Error: There is no container instance that can be provided to this Durable Object' },
          { throws: 'Error: There is no container instance that can be provided to this Durable Object' },
          { exitCode: 0 },
        ],
      },
    });
    await provider.materialize(spec());
    expect(fake.calls.filter((c) => c.op === 'start').length).toBe(3);
    expect(fake.calls.filter((c) => c.op === 'exec').length).toBe(3);
  });

  it('surfaces a capacity refusal as a TYPED, bounded error instead of hanging', async () => {
    const { provider, fake } = makeProvider(
      {
        exec: {
          '*': {
            throws:
              'Error: There is no container instance that can be provided to this Durable Object, try again later',
          },
        },
      },
      { maxInstances: 5, startTimeoutMs: 30 },
    );

    const err = await provider.materialize(spec()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareSubstrateError);
    const typed = err as CloudflareSubstrateError;
    expect(typed.kind).toBe('capacity');
    expect(typed.retryable).toBe(true);
    // The message must name the real cap AND admit the ambiguity: this message is
    // indistinguishable from the post-destroy teardown stall.
    expect(typed.message).toContain('max_instances=5');
    expect(typed.message).toMatch(/still being torn down/);
    // It gave up rather than looping forever, and it did try more than once.
    expect(fake.calls.filter((c) => c.op === 'exec').length).toBeGreaterThan(1);
  });

  it('arms the exit watch through waitUntil, and not at all without one', async () => {
    const exits: unknown[] = [];
    const held: Promise<unknown>[] = [];
    const { provider, fake } = makeProvider(
      { monitor: 'resolve' },
      {
        waitUntil: (p) => held.push(p),
        onContainerExit: (info) => exits.push(info),
      },
    );
    await provider.materialize(spec());
    expect(fake.ops()).toEqual(['start', 'exec', 'monitor']);
    // monitor() is cancelled with the request's I/O context, so the promise MUST
    // be handed to waitUntil or the stop is never observed.
    expect(held.length).toBe(1);
    await held[0];
    expect(exits).toEqual([{ computer: 'comp-1', epoch: 7 }]);

    // With no waitUntil configured the watch is not armed at all — better than
    // arming a promise the runtime will silently cancel.
    const bare = await materialized({ monitor: 'resolve' });
    expect(bare.fake.ops()).toEqual(['start', 'exec']);
  });
});

describe('sleep and destroy (spec §3.5, WARM unsupported)', () => {
  it('declares WARM unsupported', () => {
    const { provider } = makeProvider();
    expect(provider.supportsWarm).toBe(false);
  });

  it('sleep DESTROYS: the disk is wiped on stop, so retaining the resource is a lie', async () => {
    const { provider, fake, handle } = await materialized();
    const before = fake.calls.length;
    await provider.sleep(handle);
    expect(fake.ops().slice(before)).toEqual(['destroy']);
    // No pause, no checkpoint, no snapshotContainer — the fake would throw on the
    // last one, and there is nothing else to call.
  });

  it('destroying an already-gone instance resolves', async () => {
    const { provider, handle } = await materialized({ destroyThrows: 'container is not running' });
    await expect(provider.destroy(handle)).resolves.toBeUndefined();
  });

  it('destroy tolerates a vanished instance ("no container instance")', async () => {
    const { provider, handle } = await materialized({
      destroyThrows: 'There is no container instance that can be provided to this Durable Object',
    });
    await expect(provider.destroy(handle)).resolves.toBeUndefined();
  });
});

describe('wake (spec §3.5)', () => {
  it('starts again with the recorded startup options, so marid restores from the same manifest', async () => {
    const { provider, fake, handle } = await materialized();
    fake.running = false;
    await provider.wake(handle);

    const first = fake.startOptions(0);
    const second = fake.startOptions(1);
    expect(second).toEqual(first);
    expect((second.env as Record<string, string>).MARI_RESTORE_MANIFEST).toBe('a'.repeat(64));
    expect(second.enableInternet).toBe(true);
  });

  it('re-asserts readiness (start is not the ready signal)', async () => {
    const { provider, fake, handle } = await materialized();
    const before = fake.calls.length;
    await provider.wake(handle);
    expect(fake.ops().slice(before)).toEqual(['start', 'exec']);
  });
});

describe('exec (spec §3.5)', () => {
  it('passes argv verbatim (never shell-interpreted) with cwd, env, and piped output', async () => {
    const { provider, fake, handle } = await materialized({
      exec: { 'printf hi > there': { exitCode: 3, stdout: 'out-bytes', stderr: 'err-bytes' } },
    });
    const result = await provider.exec(handle, ['printf', 'hi > there'], {
      cwd: '/work/sub dir',
      env: { EXTRA: '1' },
    });

    // The shell metacharacter survived as ONE argv element: no shell ran.
    expect(fake.execArgv(1)).toEqual(['printf', 'hi > there']);
    expect(fake.execOptions(1)).toEqual({
      stdout: 'pipe',
      stderr: 'pipe',
      cwd: '/work/sub dir',
      env: { EXTRA: '1' },
    });
    expect(result).toEqual({ exitCode: 3, stdout: 'out-bytes', stderr: 'err-bytes' });
  });

  it('feeds stdin bytes through exactly', async () => {
    const { provider, fake, handle } = await materialized();
    const payload = new Uint8Array([0x00, 0xff, 0x41, 0x0a, 0x7f, 0x80]);
    await provider.exec(handle, ['base64', '-d'], { input: payload });
    const fed = fake.stdin[1];
    expect(fed).not.toBeNull();
    expect([...(fed as Uint8Array)]).toEqual([...payload]);
  });

  it('omits cwd/env/stdin entirely when the caller passed none', async () => {
    const { provider, fake, handle } = await materialized();
    await provider.exec(handle, ['true']);
    expect(fake.execOptions(1)).toEqual({ stdout: 'pipe', stderr: 'pipe' });
    expect(fake.stdin[1]).toBeNull();
  });

  it('REFUSES on a stopped instance instead of starting one (the disk is gone)', async () => {
    const { provider, fake, handle } = await materialized();
    fake.running = false;
    const before = fake.calls.length;

    const err = await provider.exec(handle, ['ls']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareSubstrateError);
    expect((err as CloudflareSubstrateError).kind).toBe('not_running');
    expect((err as CloudflareSubstrateError).message).toMatch(/NO disk/);
    // Critically: it did not quietly start a container whose /work is the base
    // image's, which would have made the command's result a lie.
    expect(fake.calls.length).toBe(before);
  });

  it('bounds a hung exec (the documented over-capacity failure) and kills the process', async () => {
    const { provider, fake, handle } = await materialized(
      { exec: { hang: { hang: true }, '*': { exitCode: 0 } } },
      { execTimeoutMs: 25 },
    );
    const err = await provider.exec(handle, ['hang']).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CloudflareSubstrateError);
    expect((err as CloudflareSubstrateError).kind).toBe('timeout');
    expect(fake.killCount).toBe(1);
  });

  it('rejects an empty argv', async () => {
    const { provider, handle } = await materialized();
    await expect(provider.exec(handle, [])).rejects.toThrow(/non-empty argv/);
  });
});

describe('exposePort and proxyFetch (spec §8.5)', () => {
  it('reports the in-computer address and asks the platform to address the port', async () => {
    const { provider, fake, handle } = await materialized();
    const url = await provider.exposePort(handle, 8080);
    expect(url).toBe('http://127.0.0.1:8080');
    expect(fake.tcpPorts).toEqual([8080]);
    // No publish step was needed at materialize time (unlike Docker).
    expect(handle.ports).toEqual([]);
  });

  it('rejects an impossible port and a stopped instance', async () => {
    const { provider, fake, handle } = await materialized();
    await expect(provider.exposePort(handle, 0)).rejects.toThrow(/invalid port/);
    await expect(provider.exposePort(handle, 70000)).rejects.toThrow(/invalid port/);
    fake.running = false;
    const err = await provider.exposePort(handle, 8080).catch((e: unknown) => e);
    expect((err as CloudflareSubstrateError).kind).toBe('not_running');
  });

  it('proxyFetch serves the request from the container port, request intact', async () => {
    const seen: { url: string; method: string; header: string | null }[] = [];
    const { provider, fake, handle } = await materialized({
      portResponse: (port, request) => {
        seen.push({
          url: request.url,
          method: request.method,
          header: request.headers.get('x-mari-epoch'),
        });
        return new Response(`served:${port}`, { status: 201 });
      },
    });

    const res = await provider.proxyFetch(
      handle,
      3000,
      new Request('http://3000--comp-1--alice.mari.sh/app/index.html?q=1', {
        method: 'GET',
        headers: { 'x-mari-epoch': '7' },
      }),
    );
    expect(res.status).toBe(201);
    expect(await res.text()).toBe('served:3000');
    expect(fake.tcpPorts).toEqual([3000]);
    expect(seen).toEqual([
      {
        url: 'http://3000--comp-1--alice.mari.sh/app/index.html?q=1',
        method: 'GET',
        header: '7',
      },
    ]);
  });
});

describe('holdAwake (spec §5.4 run hold)', () => {
  it('re-asserts the platform inactivity timer and never reaches for keepAlive', async () => {
    const { provider, fake, handle } = await materialized({}, { holdAwakeMs: 900_000 });
    await provider.holdAwake(handle);
    expect(fake.calls.at(-1)).toMatchObject({ op: 'setInactivityTimeout', args: [900_000] });
    // The fake THROWS on `keepAlive` / `renewActivityTimeout` / `sleepAfter`, so
    // reaching the end of this test is the proof that none were touched.
  });

  it('swallows a refusal — an undocumented platform knob must not fail a run', async () => {
    const { provider, handle } = await materialized({ inactivityThrows: 'not implemented' });
    await expect(provider.holdAwake(handle)).resolves.toBeUndefined();
  });

  it('does nothing when the instance is not running', async () => {
    const { provider, fake, handle } = await materialized();
    fake.running = false;
    const before = fake.calls.length;
    await provider.holdAwake(handle);
    expect(fake.calls.length).toBe(before);
  });
});

describe('the surface the driver is allowed to touch', () => {
  it('reads nothing outside the raw ctx.container API across a whole lifecycle', async () => {
    const held: Promise<unknown>[] = [];
    const { provider, fake } = makeProvider(
      { monitor: 'resolve' },
      { waitUntil: (p) => held.push(p), onContainerExit: () => undefined },
    );
    const handle = await provider.materialize(spec({ ports: [8080] }));
    await provider.exec(handle, ['echo', 'hi']);
    await provider.exposePort(handle, 8080);
    await provider.proxyFetch(handle, 8080, new Request('http://preview/'));
    await provider.holdAwake(handle);
    await provider.sleep(handle);
    fake.running = false;
    await provider.wake(handle);
    await provider.destroy(handle);

    for (const key of fake.accessed) {
      expect(ALLOWED_SURFACE as readonly string[]).toContain(key);
    }
    // And it really did use all of it (a test that asserts a subset of nothing
    // would also pass).
    expect([...fake.accessed].sort()).toEqual(
      ['destroy', 'exec', 'getTcpPort', 'monitor', 'running', 'setInactivityTimeout', 'start'],
    );
  });
});

describe('deployment and handle hygiene', () => {
  it('constructs without a container binding, then fails every operation loudly', async () => {
    const provider = createCloudflareProvider({ container: undefined });
    const handle: CloudflareHandle = {
      substrate: CLOUDFLARE_SUBSTRATE,
      computer: 'comp-1',
      id: 'comp-1',
      entrypoint: null,
      env: {},
      epoch: 1,
      ports: [],
    };
    for (const op of [
      () => provider.materialize(spec()),
      () => provider.destroy(handle),
      () => provider.sleep(handle),
      () => provider.wake(handle),
      () => provider.exec(handle, ['true']),
      () => provider.exposePort(handle, 80),
      () => provider.proxyFetch(handle, 80, new Request('http://p/')),
    ]) {
      const err = await op().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CloudflareSubstrateError);
      expect((err as CloudflareSubstrateError).kind).toBe('no_binding');
      expect((err as CloudflareSubstrateError).retryable).toBe(false);
    }
    // holdAwake is best-effort by contract: it must not throw here either.
    await expect(provider.holdAwake(handle)).resolves.toBeUndefined();
  });

  it('refuses another substrate’s handle', async () => {
    const { provider } = makeProvider();
    const foreign = { substrate: 'docker', computer: 'comp-1', id: 'deadbeef' } as SubstrateHandle;
    await expect(provider.destroy(foreign)).rejects.toThrow(/received a "docker" handle/);
    await expect(provider.exec(foreign, ['true'])).rejects.toThrow(/received a "docker" handle/);
  });
});
