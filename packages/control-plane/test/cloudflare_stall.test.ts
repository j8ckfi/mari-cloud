// THE DESTROY→START STALL, and what the control plane owes a user during it.
//
// MEASURED PLATFORM BEHAVIOUR (docs/substrates-cloudflare.md, gate 1): a
// `destroy()` followed by a `start()` on the SAME Durable Object is refused for
// MINUTES — >563 s and ~300 s in two measurements, both eventually recovering —
// with the platform saying "There is no container instance that can be provided
// to this Durable Object, try again later" while `container.running` still
// reports `true`. A freshly deployed container application is unschedulable for a
// while with the identical message, which is also what an over-capacity account
// says. The three are indistinguishable from the message alone.
//
// Mari's tier policy makes AWAKE→COLD→AWAKE exactly that sequence, so a computer
// that just went COLD may be unwakeable for minutes. That is a platform property
// this lane cannot fix. What it CAN fix, and what this suite pins down, is the
// control plane's conduct while it lasts:
//
//   1. the wake NEVER returns success it cannot deliver;
//   2. the wake NEVER hangs a client request (every platform call is bounded);
//   3. the queued run is NOT lost, and the retry is reported honestly (202 +
//      when it will be tried again) rather than as a dead end;
//   4. when the platform relents, the computer comes up under a NEW epoch and the
//      queued run is handed over exactly once.
//
// The driver is the REAL `substrates/cloudflare.ts` over a fake `ctx.container`
// whose refusal is the platform's own message. The e2e against real containers is
// `packages/control-plane/test/substrates/cloudflare.e2e.test.ts` (MARI_CF_E2E=1)
// and `e2e/cloudflare.e2e.test.ts` (MARI_CF_E2E=1) — see docs/decisions.md,
// "Substrate death and the wedge class", for what remains unmeasured.

import { describe, it, expect, beforeAll } from 'vitest';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import {
  apiPost,
  computerStub,
  createComputer,
  ensureSchema,
  FakeSupervisor,
  seedSession,
  waitUntil,
} from './helpers';
import { createCloudflareProvider } from '../src/substrates/cloudflare';
import { FakeContainer, type FakeContainerOptions } from './substrates/fake-container';
import type { ComputerDO } from '../src/computer-do';

/** The platform's own words when it will not give this DO an instance. */
const NO_INSTANCE =
  'There is no container instance that can be provided to this Durable Object, try again later';

type Stub = ReturnType<typeof computerStub>;

async function installDriver(stub: Stub, options: FakeContainerOptions = {}): Promise<FakeContainer> {
  const fake = new FakeContainer(options);
  await runInDurableObject(stub, (instance: ComputerDO) => {
    instance.substrate = createCloudflareProvider({
      container: fake.asContainer(),
      // Small budgets: the point is the SHAPE of the refusal, not how long a
      // suite is willing to sit in it.
      startTimeoutMs: 300,
      probeIntervalMs: 10,
      execTimeoutMs: 300,
      destroyTimeoutMs: 300,
      maxInstances: 20,
    });
  });
  return fake;
}

/** A container application that refuses to schedule anything, forever. */
function refusing(): FakeContainerOptions {
  return {
    onStart: () => NO_INSTANCE,
    // `exec` refuses too — which is what makes the readiness probe fail and the
    // driver report `capacity` instead of declaring a dead instance ready.
    exec: { '*': { throws: NO_INSTANCE } },
  };
}

function metaOf(stub: Stub): Promise<Record<string, unknown>> {
  return runInDurableObject(stub, async (instance: ComputerDO) => {
    const meta = await (
      instance as unknown as { ctx: DurableObjectState }
    ).ctx.storage.get<Record<string, unknown>>('meta');
    return meta ?? {};
  });
}

interface WakeBody {
  state: string;
  epoch: number;
  error?: string;
  retrying?: boolean;
  retryAt?: number | null;
}

describe('a substrate that refuses to schedule (Cloudflare destroy->start)', () => {
  beforeAll(ensureSchema);

  it('never claims success, never hangs, keeps the run, and takes it when the platform relents', async () => {
    const { cookie } = await seedSession();
    const id = await createComputer(cookie, 'cf-stalled');
    const stub = computerStub(id);
    const refused = await installDriver(stub, refusing());

    // ---- a run is requested; the wake behind it is refused ----------------
    const t0 = Date.now();
    const created = await apiPost<{ runId: string; queued: boolean; computerState: string }>(
      `/api/computers/${id}/runs`,
      cookie,
      { argv: ['/bin/echo', 'stalled'] },
    );
    expect(created.status).toBe(200);
    const runId = created.body.runId;
    // spec 8.3: the request did not wait for the computer.
    expect(Date.now() - t0).toBeLessThan(5_000);

    await waitUntil(
      async () => Number((await metaOf(stub))['wakeFailures']) >= 1,
      10_000,
      'the refused wake to be recorded',
    );
    // COLD is the TRUTH here: no substrate resources exist. WAKING would be a
    // spinner (spec 8.3) and AWAKE would be the lie this whole change is about.
    expect(await stub.getState()).toBe('cold');
    // The platform was really asked, and the driver really retried inside its own
    // budget before giving up (start + probe, several times).
    expect(refused.ops().filter((o) => o === 'start').length).toBeGreaterThan(1);

    // ---- POST /wake during the stall: honest, bounded, not a dead end ------
    const t1 = Date.now();
    const wake = await apiPost<WakeBody>(`/api/computers/${id}/wake`, cookie);
    const waited = Date.now() - t1;
    // Bounded: the client is answered, not held while the platform makes up its
    // mind (the platform's own failure mode here is a HANG).
    expect(waited).toBeLessThan(10_000);
    // 202, not 200: the wake is still in progress and will be retried. A 200
    // would be a promise the code cannot keep; a 503 would be a dead end.
    expect(wake.status).toBe(202);
    expect(wake.body.error).toBe('wake_retrying');
    expect(wake.body.retrying).toBe(true);
    expect(wake.body.retryAt).toBeGreaterThan(Date.now());
    expect(wake.body.state).toBe('cold');

    // The backoff really backs off: the second failure is scheduled further out
    // than the first (WAKE_RETRY_MS), so a substrate that is out of capacity is
    // not hammered.
    const firstRetry = Number(wake.body.retryAt);
    const wake2 = await apiPost<WakeBody>(`/api/computers/${id}/wake`, cookie);
    expect(wake2.status).toBe(202);
    expect(Number(wake2.body.retryAt)).toBeGreaterThan(firstRetry);

    // The run is exactly where it should be: queued, undispatched, not lost and
    // not silently failed (spec 5.1).
    const runs = await stub.listRuns();
    expect(runs.map((r) => [r.status, r.dispatched])).toEqual([['queued', false]]);

    // Nothing was handed a fencing token it could use: no supervisor generation
    // exists for a computer that never materialized.
    expect((await metaOf(stub))['token']).toBeNull();
    expect((await metaOf(stub))['handle']).toBeNull();

    // ---- the platform relents ---------------------------------------------
    // A new container application slot becomes schedulable. (Swapping the fake is
    // how "the platform changed its mind" is expressed here; the DO's own retry is
    // what has to notice.)
    const healthy = await installDriver(stub);
    const epochBefore = Number((await metaOf(stub))['epoch']);

    expect(await runDurableObjectAlarm(stub)).toBe(true);
    await waitUntil(async () => (await stub.getState()) === 'awake', 10_000, 'the retry to wake it');

    // A FRESH generation, monotonic as the contract requires (contracts.md §6):
    // every refused wake burned an epoch, which costs nothing but a number.
    const epochAfter = Number((await metaOf(stub))['epoch']);
    expect(epochAfter).toBeGreaterThan(epochBefore);
    expect(healthy.ops()).toEqual(['start', 'exec']);
    const startOpts = healthy.startOptions();
    const env = startOpts.env as Record<string, string>;
    expect(env.MARI_EPOCH).toBe(String(epochAfter));

    // ---- and the queued run runs ------------------------------------------
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, epochAfter, env.MARI_TOKEN as string);
    const start = await sup.recv.waitForTag('start_run');
    expect(start.c.run).toBe(runId);
    expect(sup.recv.all.filter((m) => m.t === 'start_run')).toHaveLength(1);
    sup.runStarted(runId, 'a'.repeat(64));
    sup.runCompleted(runId, 'b'.repeat(64));
    await waitUntil(
      async () => (await stub.runDetail(runId))?.status === 'completed',
      5_000,
      'the stalled run to finally complete',
    );
    sup.close();
  });

  it('a refused wake with nothing waiting is a 503, not an endless retry', async () => {
    // The other half of "bounded": nobody is waiting on this computer, so the
    // control plane does not spend the account's capacity on it. The user learns
    // the truth and can ask again.
    const { cookie } = await seedSession();
    const id = await createComputer(cookie, 'cf-stalled-idle');
    const stub = computerStub(id);
    await installDriver(stub, refusing());

    const wake = await apiPost<WakeBody>(`/api/computers/${id}/wake`, cookie);
    expect(wake.status).toBe(503);
    expect(wake.body).toMatchObject({ error: 'wake_failed', state: 'cold', retrying: false });
    expect((await metaOf(stub))['wakeRetryAt']).toBeNull();
  });
});
