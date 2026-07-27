// The credential vault (spec 10.1), a run's working directory (spec 2), sleep on
// demand (spec 4.4), and the error shapes a client has to act on.
//
// Every case here is a gap the product shipped with:
//
//  * The vault was WRITE-ONLY. `PUT /secrets/:name` stored a value, `GET /secrets`
//    listed the name, and nothing ever read the value: `listSecretNames` was the
//    only reader in the whole codebase. marid resolves a run's `env_names` from
//    its OWN process environment (crates/marid/src/run.rs) and the DO's
//    `materialize` env carried MARI_* only, so `echo $ANTHROPIC_API_KEY` in a run
//    printed nothing. Any agent needing an API key could not work at all.
//  * A run's default cwd was `/` — the container root, OUTSIDE the computer's only
//    snapshotted tree. `git clone && npm i` in the default directory was discarded
//    at deep sleep.
//  * There was no route to sleep a computer, so an AWAKE computer billed until the
//    idle timer expired.
//  * `dismiss` answered `200 {ok:false}` for a nonexistent AND a non-numeric event
//    id, and `stop` recorded a user's cancellation of a never-started run as
//    `failed`.
import { describe, it, expect, beforeAll } from 'vitest';
import { SELF, runInDurableObject } from 'cloudflare:test';
import {
  HOST,
  apiGet,
  apiPost,
  computerStub,
  createComputer,
  ensureSchema,
  FakeSupervisor,
  seedSession,
} from './helpers';
import type { ComputerDO } from '../src/computer-do';
import type { MaterializeSpec } from '../src/substrate';

let cookie = '';
beforeAll(async () => {
  await ensureSchema();
  cookie = (await seedSession()).cookie;
});

/** The env the DO handed `materialize` for the most recent wake. */
async function materializeEnv(id: string): Promise<Record<string, string>> {
  return runInDurableObject(computerStub(id), (instance: ComputerDO) => {
    const specs = (instance.substrate as unknown as { specs: MaterializeSpec[] }).specs;
    const last = specs[specs.length - 1];
    if (!last) throw new Error('no materialize spec recorded');
    return last.env as Record<string, string>;
  });
}

describe('credential vault (spec 10.1)', () => {
  it('injects stored VALUES into the supervisor’s environment at wake', async () => {
    const id = await createComputer(cookie, 'vaulted');

    const put = await SELF.fetch(`${HOST}/api/computers/${id}/secrets/ANTHROPIC_API_KEY`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'sk-vault-value-42' }),
    });
    expect(put.status).toBe(200);
    // The value is never echoed back, not even to the writer.
    expect(await put.text()).not.toContain('sk-vault-value-42');

    // The listing is names only (spec 10.1: values do not leave the vault).
    const names = await apiGet<{ names: string[] }>(`/api/computers/${id}/secrets`, cookie);
    expect(names.body.names).toEqual(['ANTHROPIC_API_KEY']);
    expect(JSON.stringify(names.body)).not.toContain('sk-vault-value-42');

    await computerStub(id).wake(id);
    const env = await materializeEnv(id);
    // THE FIX: the supervisor process holds the value, which is where marid
    // resolves `env_names` from — so a run that names it actually gets it.
    expect(env.ANTHROPIC_API_KEY).toBe('sk-vault-value-42');
    // ...and marid's own configuration is intact beside it.
    expect(env.MARI_COMPUTER_ID).toBe(id);
    expect(env.MARI_TOKEN).toMatch(/.+/);

    // A run started with no explicit envNames names the vault's variables, so the
    // supervisor injects them into the child (contracts.md §5.2: NAMES only).
    const w = await computerStub(id).wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);
    const started = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sh', '-c', 'echo $ANTHROPIC_API_KEY'],
    });
    expect(started.status).toBe(200);
    const start = await sup.recv.waitForTag('start_run');
    expect(start.c.env_names).toEqual(['ANTHROPIC_API_KEY']);
    // The VALUE is not on the wire.
    expect(JSON.stringify(start.c)).not.toContain('sk-vault-value-42');
    sup.close();
  });

  it('refuses a name that would shadow marid’s own configuration', async () => {
    const id = await createComputer(cookie, 'vault-guard');
    for (const name of [
      'MARI_TOKEN',
      'MARI_EPOCH',
      'MARI_ROOT',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
    ]) {
      const res = await SELF.fetch(`${HOST}/api/computers/${id}/secrets/${name}`, {
        method: 'PUT',
        headers: { Cookie: cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ value: 'hijack' }),
      });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe('reserved_name');
    }
    for (const name of ['not a var', '9lives', 'a-b']) {
      const res = await SELF.fetch(
        `${HOST}/api/computers/${id}/secrets/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          headers: { Cookie: cookie, 'content-type': 'application/json' },
          body: JSON.stringify({ value: 'x' }),
        },
      );
      expect(res.status).toBe(400);
    }
    // Nothing was stored, so nothing can reach a wake.
    const names = await apiGet<{ names: string[] }>(`/api/computers/${id}/secrets`, cookie);
    expect(names.body.names).toEqual([]);
    await computerStub(id).wake(id);
    const env = await materializeEnv(id);
    expect(env.MARI_TOKEN).not.toBe('hijack');
    expect(env.MARI_ROOT).toBe('/work');
  });

  it('a vault entry belongs to ONE computer, and can be removed', async () => {
    const mine = await createComputer(cookie, 'vault-mine');
    const other = await createComputer(cookie, 'vault-other');
    await SELF.fetch(`${HOST}/api/computers/${mine}/secrets/OPENAI_API_KEY`, {
      method: 'PUT',
      headers: { Cookie: cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'only-mine' }),
    });

    await computerStub(other).wake(other);
    expect((await materializeEnv(other)).OPENAI_API_KEY).toBeUndefined();

    const del = await SELF.fetch(`${HOST}/api/computers/${mine}/secrets/OPENAI_API_KEY`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(del.status).toBe(200);
    const again = await SELF.fetch(`${HOST}/api/computers/${mine}/secrets/OPENAI_API_KEY`, {
      method: 'DELETE',
      headers: { Cookie: cookie },
    });
    expect(again.status).toBe(404);

    await computerStub(mine).wake(mine);
    expect((await materializeEnv(mine)).OPENAI_API_KEY).toBeUndefined();
  });

  it('requires ownership for every vault route', async () => {
    const anon = await SELF.fetch(`${HOST}/api/computers/seedcomputer/secrets`);
    expect(anon.status).toBe(401);
    const foreign = await apiGet(`/api/computers/not-mine/secrets`, cookie);
    expect(foreign.status).toBe(404);
  });
});

describe('a run’s working directory is inside the computer (spec 2, 4.1)', () => {
  it('defaults to the computer’s filesystem root, never the container root', async () => {
    const id = await createComputer(cookie, 'cwd-default');
    const w = await computerStub(id).wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const started = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sh', '-c', 'pwd; echo lost > project.txt'],
    });
    const start = await sup.recv.waitForTag('start_run');
    expect(start.c.run).toBe(started.body.runId);
    // COMPUTER_ROOT is `/work` in the test bindings, the same as the private
    // instance's default.
    expect(start.c.cwd).toBe('/work');
    expect(start.c.cwd).not.toBe('/');

    // The run record reports the same directory the supervisor was told.
    const runs = await apiGet<{ runs: { id: string; cwd: string }[] }>(
      `/api/computers/${id}/runs`,
      cookie,
    );
    expect(runs.body.runs.find((r) => r.id === started.body.runId)?.cwd).toBe('/work');
    sup.close();
  });

  it('maps a requested computer-space directory onto the root', async () => {
    const id = await createComputer(cookie, 'cwd-mapped');
    const w = await computerStub(id).wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    await apiPost(`/api/computers/${id}/runs`, cookie, { argv: ['ls'], cwd: '/project' });
    expect((await sup.recv.waitForTag('start_run')).c.cwd).toBe('/work/project');

    // A caller that already speaks substrate paths is left alone.
    await apiPost(`/api/computers/${id}/runs`, cookie, { argv: ['ls'], cwd: '/work/sub' });
    expect((await sup.recv.waitForTag('start_run')).c.cwd).toBe('/work/sub');
    sup.close();
  });
});

describe('sleep on demand (spec 4.4)', () => {
  it('AWAKE -> WARM, then WARM -> COLD (deep sleep)', async () => {
    const id = await createComputer(cookie, 'sleeper');
    await computerStub(id).wake(id);
    expect(await computerStub(id).getState()).toBe('awake');

    const warm = await apiPost<{ state: string; settled: boolean }>(
      `/api/computers/${id}/sleep`,
      cookie,
    );
    expect(warm.status).toBe(200);
    expect(warm.body.state).toBe('warm');
    expect(warm.body.settled).toBe(true);
    expect(await computerStub(id).getState()).toBe('warm');

    const cold = await apiPost<{ state: string; deep: boolean; settled: boolean }>(
      `/api/computers/${id}/sleep`,
      cookie,
      { deep: true },
    );
    expect(cold.body.deep).toBe(true);
    // No supervisor is attached, so there is nobody to write a final manifest and
    // the transition completes inline (spec 4.5's clean stop is recorded as an
    // incident by the DO, which is what makes that honest).
    expect(cold.body.state).toBe('cold');
    expect(await computerStub(id).getState()).toBe('cold');
  });

  it('deep sleep from AWAKE asks the supervisor for a final manifest first', async () => {
    const id = await createComputer(cookie, 'deep-sleeper');
    const w = await computerStub(id).wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const prepared = sup.recv.waitForTag('prepare_for_cold');
    const res = await apiPost<{ state: string; settled: boolean }>(
      `/api/computers/${id}/sleep`,
      cookie,
      { deep: true },
    );
    await prepared;
    // Honest: the computer is not COLD yet, and the response says so instead of
    // claiming a state it has not reached.
    expect(res.body.settled).toBe(false);

    const FINAL = 'e'.repeat(64);
    sup.snapshotWritten(FINAL, w.epoch, 'final');
    for (let i = 0; i < 200 && (await computerStub(id).getState()) !== 'cold'; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(await computerStub(id).getState()).toBe('cold');
    expect(await computerStub(id).getHead()).toBe(FINAL);
    sup.close();
  });

  it('requires ownership', async () => {
    const anon = await SELF.fetch(`${HOST}/api/computers/seedcomputer/sleep`, { method: 'POST' });
    expect(anon.status).toBe(401);
    const foreign = await apiPost(`/api/computers/nobody/sleep`, cookie);
    expect(foreign.status).toBe(404);
  });
});

describe('error shapes a client can act on', () => {
  it('dismiss: 400 for a non-numeric id, 404 for an unknown one, 200 once', async () => {
    const id = await createComputer(cookie, 'dismissals');
    const w = await computerStub(id).wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);
    sup.attention('run-attn', 'bell');

    let events: { id: number }[] = [];
    for (let i = 0; i < 100 && events.length === 0; i++) {
      events = (
        await apiGet<{ attention: { id: number }[] }>(`/api/computers/${id}/attention`, cookie)
      ).body.attention;
      if (events.length === 0) await new Promise((r) => setTimeout(r, 10));
    }
    expect(events.length).toBe(1);
    const eventId = events[0]!.id;

    const bad = await apiPost<{ error: string }>(
      `/api/computers/${id}/attention/not-a-number/dismiss`,
      cookie,
    );
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('bad_event_id');

    const missing = await apiPost<{ error: string }>(
      `/api/computers/${id}/attention/999999/dismiss`,
      cookie,
    );
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('attention_not_found');

    const ok = await apiPost<{ ok: boolean }>(
      `/api/computers/${id}/attention/${eventId}/dismiss`,
      cookie,
    );
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    // Idempotence is still reported as a miss, not a success.
    const twice = await apiPost<{ ok: boolean }>(
      `/api/computers/${id}/attention/${eventId}/dismiss`,
      cookie,
    );
    expect(twice.status).toBe(404);
    sup.close();
  });

  it('stop: a cancelled-before-start run is reported as cancelled, not failed', async () => {
    const id = await createComputer(cookie, 'canceller');
    // COLD: the run is queued and never dispatched.
    const started = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sh', '-c', 'true'],
    });
    const stop = await apiPost<{ state: string; status: string; cancelled: boolean; sent: boolean }>(
      `/api/computers/${id}/runs/${started.body.runId}/stop`,
      cookie,
    );
    expect(stop.status).toBe(200);
    expect(stop.body.status).toBe('cancelled');
    expect(stop.body.cancelled).toBe(true);
    expect(stop.body.sent).toBe(false);
  });
});

describe('runtime configuration (/api/config)', () => {
  it('serves the preview zone, scheme and dev-auth flag without a session', async () => {
    const res = await SELF.fetch(`${HOST}/api/config`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      previewZone: string;
      previewScheme: string;
      devAuth: boolean;
      maxWriteBytes: number;
      maxReadBytes: number;
    };
    expect(body.previewZone).toBe('mari.sh');
    expect(body.previewScheme).toBe('http'); // BASE_URL is http://localhost here
    expect(body.devAuth).toBe(true); // DEV_AUTH=1 in the test bindings
    expect(body.maxWriteBytes).toBe(body.maxReadBytes);
  });
});

describe('a brand-new computer is browsable (spec 8.3)', () => {
  it('lists an empty root instead of 404 no_manifest', async () => {
    const id = await createComputer(cookie, 'newborn');
    const listing = await apiGet<{ manifest: string | null; entries: unknown[] }>(
      `/api/computers/${id}/files?path=/`,
      cookie,
    );
    expect(listing.status).toBe(200);
    expect(listing.body.manifest).toBeNull();
    expect(listing.body.entries).toEqual([]);

    // A path inside that empty tree is still a miss.
    const inside = await apiGet(`/api/computers/${id}/files?path=/src`, cookie);
    expect(inside.status).toBe(404);
  });
});
