// The WARM-unsupported tier path, and the DO ↔ Cloudflare-driver wiring.
//
// Owned by the substrate lane (see the header of src/substrates/cloudflare.ts), but
// it must live in the Workers pool rather than test/substrates/: it drives the REAL
// ComputerDO with the REAL Cloudflare driver over a fake `ctx.container`, and
// `runDurableObjectAlarm` / `runInDurableObject` only exist here.
//
// What it pins down:
//
//   * A substrate that declares `supportsWarm === false` never enters WARM. The
//     first idle deadline takes the computer AWAKE → COLD through the clean-stop
//     path, and the FINAL MANIFEST IS WRITTEN BEFORE THE CONTAINER IS DESTROYED
//     (spec §4.5) — asserted by the container's own call log, which holds no
//     `destroy` at the moment `prepare_for_cold` reaches the supervisor.
//   * `materialize` receives marid's whole configuration from the DO and hands it
//     to `start()` unchanged (contracts.md §5.1).
//   * spec §5.4's run hold reaches the driver on the marid → DO → driver path.
//   * The wake proxy (spec §8.5) serves a preview request through the container
//     port instead of fetching a URL, because on this substrate there is no URL.

import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  apiGet,
  computerStub,
  createComputer,
  delay,
  ensureSchema,
  FakeSupervisor,
  seedSession,
} from './helpers';
import { createCloudflareProvider } from '../src/substrates/cloudflare';
import { FakeContainer, type FakeContainerOptions } from './substrates/fake-container';
import type { ComputerDO } from '../src/computer-do';

/** Install the real Cloudflare driver over a fake container on a live DO. */
async function installDriver(
  stub: ReturnType<typeof computerStub>,
  options: FakeContainerOptions = {},
): Promise<FakeContainer> {
  const fake = new FakeContainer(options);
  await runInDurableObject(stub, (instance: ComputerDO) => {
    instance.substrate = createCloudflareProvider({
      container: fake.asContainer(),
      startTimeoutMs: 2_000,
      probeIntervalMs: 1,
      execTimeoutMs: 2_000,
      maxInstances: 20,
    });
    // If the DO ever falls back to fetching exposePort's string, fail loudly
    // instead of silently reaching a non-routable address.
    instance.upstreamFetch = async () => {
      throw new Error('upstreamFetch must not be used when the driver serves the port itself');
    };
  });
  return fake;
}

async function waitForState(
  stub: ReturnType<typeof computerStub>,
  want: string,
  tries = 100,
): Promise<string> {
  let state = await stub.getState();
  for (let i = 0; i < tries && state !== want; i++) {
    await delay(10);
    state = await stub.getState();
  }
  return state;
}

describe('tier policy on a substrate without WARM (spec 4.4/4.5)', () => {
  beforeAll(ensureSchema);

  it('goes AWAKE -> COLD directly, writing the final manifest BEFORE the destroy', async () => {
    const id = 'cfwarmless';
    const stub = computerStub(id);
    const fake = await installDriver(stub);

    // ── wake: the DO materializes through the driver ──────────────────────────
    const w = await stub.wake(id);
    expect(w.ok).toBe(true);
    expect(await stub.getState()).toBe('awake');
    expect(fake.ops()).toEqual(['start', 'exec']);

    // marid's whole configuration arrived at `start()` unchanged.
    const startOpts = fake.startOptions();
    expect(startOpts.enableInternet).toBe(true);
    const env = startOpts.env as Record<string, string>;
    expect(env.MARI_COMPUTER_ID).toBe(id);
    expect(env.MARI_EPOCH).toBe(String(w.epoch));
    expect(env.MARI_TOKEN).toBe(w.token);
    expect(env.MARI_ROOT).toBe('/work');
    expect(env.MARI_STORE).toBe('fs:///store');
    expect(startOpts.labels).toEqual({ 'mari.computer': id, 'mari.epoch': String(w.epoch) });

    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    // ── the run hold reaches the driver (spec 5.4) ────────────────────────────
    sup.send({ t: 'run_heartbeat', c: { run: 'run-1' } });
    for (let i = 0; i < 100 && !fake.ops().includes('setInactivityTimeout'); i++) await delay(10);
    expect(fake.ops()).toContain('setInactivityTimeout');
    // Never keepAlive: the fake throws on that property, so getting here proves it.

    // ── the idle deadline: NO WARM ────────────────────────────────────────────
    const prepared = sup.recv.waitForTag('prepare_for_cold');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await prepared;

    // The computer is still AWAKE (never WARM — WARM would have been recorded
    // synchronously in the alarm), and NOTHING has been destroyed yet: the
    // supervisor is being asked to stop cleanly and write the manifest first.
    expect(await stub.getState()).toBe('awake');
    expect(fake.ops()).not.toContain('destroy');

    // ── the supervisor answers; only now does the container die ───────────────
    const MFINAL = 'c'.repeat(64);
    sup.snapshotWritten(MFINAL, w.epoch, 'final');
    expect(await waitForState(stub, 'cold')).toBe('cold');

    expect(await stub.getHead()).toBe(MFINAL);
    const ops = fake.ops();
    expect(ops.at(-1)).toBe('destroy');
    // Exactly one teardown, and it came after the manifest.
    expect(ops.filter((o) => o === 'destroy').length).toBe(1);

    sup.close();
  });

  it('tears down immediately when no supervisor can write a manifest', async () => {
    const id = 'cfwarmless2';
    const stub = computerStub(id);
    const fake = await installDriver(stub);
    await stub.wake(id);

    // One alarm, not two: there is no WARM stop to pass through.
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.getState()).toBe('cold');
    expect(fake.ops()).toEqual(['start', 'exec', 'destroy']);
  });

  it('a computer that is busy at the deadline is not torn down by the late final snapshot', async () => {
    // The AWAKE -> COLD path asks for the manifest while the computer is still
    // AWAKE, so a run heartbeat inside that window must supersede the finalize
    // (the same rule a wake follows). Otherwise the supervisor's answer would
    // destroy a computer that had just gone back to work.
    const id = 'cfwarmless3';
    const stub = computerStub(id);
    const fake = await installDriver(stub);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const prepared = sup.recv.waitForTag('prepare_for_cold');
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await prepared;

    // Activity inside the finalize window.
    sup.send({ t: 'run_heartbeat', c: { run: 'run-busy' } });
    await delay(50);

    // The supervisor's (now superseded) final snapshot arrives.
    sup.snapshotWritten('d'.repeat(64), w.epoch, 'final');
    await delay(80);

    expect(await stub.getState()).toBe('awake');
    expect(fake.ops()).not.toContain('destroy');
    sup.close();
  });
});

describe('wake proxy over a container port (spec 8.5)', () => {
  beforeAll(ensureSchema);

  it('serves the preview request through the container instead of a URL', async () => {
    // The preview surface is authorized (test/proxy.test.ts owns those rules), so
    // this needs a REAL owned computer and a session: the substrate assertions
    // below are unchanged, only the way the request gets past the gate is.
    const cookie = (await seedSession()).cookie;
    const id = await createComputer(cookie, 'cfproxy');
    const seen: { url: string; epoch: string | null }[] = [];
    const stub = computerStub(id);
    await installDriver(stub, {
      portResponse: (port, request) => {
        seen.push({ url: request.url, epoch: request.headers.get('x-mari-epoch') });
        return new Response(`from-port-${port}:${new URL(request.url).pathname}`, { status: 200 });
      },
    });

    const info = await apiGet<{ host: string }>(`/api/computers/${id}/preview?port=8080`, cookie);
    expect(info.status).toBe(200);
    const host = info.body.host;

    const res = await SELF.fetch(`http://${host}/app/index.html?q=1`, {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('from-port-8080:/app/index.html');

    // The request reached the container with its path, query and the DO's epoch
    // stamp intact — and the internal routing headers stripped.
    expect(seen.length).toBe(1);
    expect(seen[0]!.url).toBe(`http://${host}/app/index.html?q=1`);
    expect(seen[0]!.epoch).toBe('1');

    const fake = await runInDurableObject(stub, (instance: ComputerDO) => {
      const provider = instance.substrate as unknown as { supportsWarm: boolean };
      return provider.supportsWarm;
    });
    expect(fake).toBe(false);
    expect(await stub.getState()).toBe('awake');
  });
});
