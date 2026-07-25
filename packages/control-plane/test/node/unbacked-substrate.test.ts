// A DEPLOYED Mari with no real substrate must not report AWAKE.
//
// The fake substrate (`src/substrate.ts`) answers `materialize` with a handle,
// reports every instance `alive`, and starts no process. In the suites that is
// the point. On a deployed origin it is the same wedge class the liveness lane
// closed — a state that cannot advance, dressed as success: `POST /wake` answers
// `200 {"state":"awake"}`, the fleet shows `activeRuns: 1`, and no supervisor
// will ever connect to take the work, for the life of the deployment, with
// nothing in the logs. `wrangler.jsonc`'s production environment ships
// `SUBSTRATE_MODE: "fake"` today (deliberately — a real driver must not be
// switched on by the change that defines it), so this is a configuration a
// deploy can genuinely have.
//
// This suite runs on the NODE runtime and not the Workers pool for one reason:
// the verdict is a property of the DEPLOYMENT (`isProductionEnv(env)` × which
// driver the object holds), and the Workers pool's `env` comes from
// wrangler.jsonc — a test there cannot make the Durable Object's own environment
// production-shaped. Here the environment is the test's to build, and
// `ComputerDO` is the same unforked class (vitest.node.config.ts aliases
// `cloudflare:workers`).
//
// Not gated: no Docker, no network, no image. It is the fake substrate that is
// under test.

import { afterEach, describe, expect, it } from 'vitest';
import { boot, type NodeInstance } from '../../src/node.js';
import { FakeSubstrate } from '../../src/substrate.js';
import { makeLocalDir, removeDir } from './harness.js';

/** A 32+ character secret, so `auth.ts` accepts the production environment for
 *  the reason under test rather than refusing it for the secret. */
const REAL_ENOUGH_SECRET = 'unbacked-substrate-suite-secret-0123456789';

interface Booted {
  instance: NodeInstance;
  dirs: string[];
}

const booted: Booted[] = [];

/**
 * Boot a private instance whose `Env` is production-shaped or not, with the FAKE
 * substrate either way.
 *
 * `baseUrl` is the trigger being used: `isProductionEnv` fires on
 * `ENVIRONMENT=production`, on a public-TLS `BASE_URL`, or on a public-TLS
 * request URL, and the Node runtime composes `BASE_URL` from config. Pinning
 * `supervisorUrlBase` too is load-bearing — with `port: 0`, `applyBoundPort`
 * rewrites the derived URLs after `listen` unless the operator pinned them, and
 * that rewrite would put `http://localhost:<port>` back into `BASE_URL` and
 * quietly undo the production shape this test is about.
 */
async function bootWith(baseUrl: string): Promise<NodeInstance> {
  const dataDir = await makeLocalDir('unbacked-data');
  const storeDir = await makeLocalDir('unbacked-store');
  const previous = { ...process.env };
  process.env.DEV_AUTH = '0';
  process.env.DEV_SEED = '0';
  process.env.AUTH_SECRET = REAL_ENOUGH_SECRET;
  delete process.env.MARI_AUTH_SECRET;
  delete process.env.BASE_URL;
  delete process.env.MARI_SUPERVISOR_URL;
  try {
    const instance = await boot({
      port: 0,
      hostname: '127.0.0.1',
      webDir: null,
      log: () => {},
      dataDir,
      storeDir,
      substrateMode: 'fake',
      baseUrl,
      supervisorUrlBase: 'wss://app.mari.sh',
    });
    booted.push({ instance, dirs: [dataDir, storeDir] });
    return instance;
  } finally {
    for (const key of ['DEV_AUTH', 'DEV_SEED', 'AUTH_SECRET']) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
}

afterEach(async () => {
  for (const { instance, dirs } of booted.splice(0)) {
    await instance.close();
    for (const dir of dirs) await removeDir(dir);
  }
});

describe('a production deployment with the fake substrate', () => {
  it('refuses to wake instead of claiming AWAKE, and stays at the state it is really in', async () => {
    const instance = await bootWith('https://app.mari.sh');
    // The environment really is the one under test: fake driver, production origin.
    expect(instance.runtime.env.SUBSTRATE_MODE).toBe('fake');
    expect(instance.runtime.env.BASE_URL).toBe('https://app.mari.sh');

    const id = 'c_unbacked';
    const computer = await instance.runtime.computers.instanceFor(id);
    expect(computer.substrate).toBeInstanceOf(FakeSubstrate);
    const fake = computer.substrate as FakeSubstrate;

    const before = await computer.getState();
    expect(before).toBe('cold');

    const res = await computer.wake(id);

    // The refusal, named. Not `wake_failed`: nothing was attempted and no retry
    // could help, so the operator must be able to tell a missing substrate from
    // one that said no.
    expect(res.ok).toBe(false);
    expect(res.error).toBe('substrate_not_configured');
    expect(res.token).toBe('');
    expect(res.retrying).toBe(false);
    expect(res.retryAt).toBeNull();

    // Nothing was asked of the substrate — that is what makes the refusal free —
    // and no epoch was spent on a generation that cannot exist.
    expect(fake.calls).toEqual([]);
    expect(fake.issued).toEqual([]);
    expect(res.epoch).toBe(0);

    // And the computer is not parked in WAKING, which is the wedge shape: a
    // transition nothing will ever complete.
    expect(res.state).toBe('cold');
    expect(await computer.getState()).toBe('cold');
  });

  it('leaves a queued run queued and the computer COLD, rather than AWAKE with work nobody will take', async () => {
    const instance = await bootWith('https://app.mari.sh');
    const id = 'c_unbacked_run';
    const computer = await instance.runtime.computers.instanceFor(id);
    const fake = computer.substrate as FakeSubstrate;

    const enqueued = await computer.enqueueRun({
      computerId: id,
      runId: 'r_never',
      argv: ['/bin/sh', '-c', 'echo hello'],
    });
    // The run exists (spec 8.3: the interface does not wait for a computer)…
    expect(enqueued.runId).toBe('r_never');

    // …and the DO's background wake has had every chance to run. `waitUntil` on
    // the Node runtime is a real promise, so give the microtask queue and one
    // timer tick a chance to produce the AWAKE this test says must not appear.
    await new Promise((r) => setTimeout(r, 250));

    expect(await computer.getState()).toBe('cold');
    expect(fake.calls).toEqual([]);

    const runs = await computer.listRuns();
    const run = runs.find((r) => r.id === 'r_never');
    expect(run).toBeDefined();
    // Queued, never dispatched: no supervisor was ever told about it, so nothing
    // may claim it started.
    expect(run?.status).toBe('queued');
    expect(run?.startedAt ?? null).toBeNull();
  });

  it('is scoped to production: the same fake substrate still wakes a dev origin', async () => {
    // The polarity control. Without it this suite would pass just as well if the
    // fake had simply been broken, and every existing suite (which drives the
    // fake against `http://localhost`) would have to be the thing that noticed.
    const instance = await bootWith('http://localhost:8787');
    const id = 'c_dev_ok';
    const computer = await instance.runtime.computers.instanceFor(id);
    expect(computer.substrate).toBeInstanceOf(FakeSubstrate);
    const fake = computer.substrate as FakeSubstrate;

    const res = await computer.wake(id);
    expect(res.ok).toBe(true);
    expect(res.error).toBeNull();
    expect(res.state).toBe('awake');
    expect(res.epoch).toBe(1);
    expect(res.token).not.toBe('');
    expect(fake.calls.map((c) => c.op)).toEqual(['materialize']);
  });
});
