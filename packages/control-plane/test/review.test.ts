// Run result review (spec 5.3): "The result of a run shows as a difference
// against the pre-run manifest. The user keeps the changes or restores the
// manifest."
//
// Teeth:
//   - keep leaves the head at the POST-run manifest and is idempotent;
//   - revert moves the head back to the PRE-run manifest, sends exactly one
//     `restore_to_manifest`, and is idempotent;
//   - a revert carrying a STALE epoch is REJECTED with the head untouched and
//     no restore on the wire (contracts.md §6 applied to the head decision:
//     a newer wake owns the disk, and restoring an old baseline over it would
//     destroy that generation's work — spec 4.1);
//   - keep and revert are mutually exclusive once decided.
import { describe, it, expect, beforeAll } from 'vitest';
import {
  apiGet,
  apiPost,
  computerStub,
  createComputer,
  delay,
  ensureSchema,
  FakeSupervisor,
  seedSession,
} from './helpers';

const PRE = 'a'.repeat(64);
const POST = 'b'.repeat(64);

interface Review {
  runId: string;
  review: string;
  head: string | null;
  applied: boolean;
  currentEpoch: number;
  error?: string;
}

interface RunSummary {
  id: string;
  review: string;
  state: string;
}

/** Drive one complete run against a real DO + fake supervisor. */
async function completedRun(cookie: string, name: string) {
  const id = await createComputer(cookie, name);
  const stub = computerStub(id);
  const w = await stub.wake(id);
  const sup = await FakeSupervisor.connect(id);
  await sup.handshake(id, w.epoch, w.token);

  const started = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
    argv: ['/bin/sh', '-c', 'echo change > /f'],
  });
  const runId = started.body.runId;
  await sup.recv.waitForTag('start_run');

  sup.runStarted(runId, PRE);
  sup.headAdvance(PRE, w.epoch);
  await sup.recv.waitForTag('head_advance_result');

  sup.runCompleted(runId, POST, { t: 'exited', c: { code: 0 } }, {
    added: 1,
    modified: 0,
    removed: 0,
  });
  sup.headAdvance(POST, w.epoch);
  await sup.recv.waitForTag('head_advance_result');
  expect(await stub.getHead()).toBe(POST);

  return { id, stub, sup, runId, epoch: w.epoch };
}

describe('run keep / revert (spec 5.3)', () => {
  let cookie = '';
  beforeAll(async () => {
    await ensureSchema();
    ({ cookie } = await seedSession());
  });

  it('keep leaves the head at the post-run manifest and is idempotent', async () => {
    const { id, stub, sup, runId, epoch } = await completedRun(cookie, 'keeper');

    const first = await apiPost<Review>(`/api/computers/${id}/runs/${runId}/keep`, cookie, {
      epoch,
    });
    expect(first.status).toBe(200);
    expect(first.body.review).toBe('kept');
    expect(first.body.head).toBe(POST);
    expect(await stub.getHead()).toBe(POST);

    const again = await apiPost<Review>(`/api/computers/${id}/runs/${runId}/keep`, cookie, {
      epoch,
    });
    expect(again.status).toBe(200);
    expect(again.body.review).toBe('kept');
    expect(again.body.applied).toBe(false);
    expect(await stub.getHead()).toBe(POST);

    // Keeping never asks the supervisor to restore anything.
    await delay(60);
    expect(sup.recv.countTag('restore_to_manifest')).toBe(0);

    // A revert after a keep is a conflict, and the head does not move.
    const conflict = await apiPost<Review>(`/api/computers/${id}/runs/${runId}/revert`, cookie, {
      epoch,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('already_kept');
    expect(await stub.getHead()).toBe(POST);

    const list = await apiGet<{ runs: RunSummary[] }>(`/api/computers/${id}/runs`, cookie);
    expect(list.body.runs[0]!.review).toBe('kept');
    sup.close();
  });

  it('revert restores the pre-run manifest exactly once and refuses a stale epoch', async () => {
    const { id, stub, sup, runId, epoch } = await completedRun(cookie, 'reverter');

    // (1) A stale epoch is refused: no head movement, nothing on the wire.
    const stale = await apiPost<Review>(`/api/computers/${id}/runs/${runId}/revert`, cookie, {
      epoch: epoch - 1,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale_epoch');
    expect(stale.body.currentEpoch).toBe(epoch);
    expect(await stub.getHead()).toBe(POST);
    await delay(60);
    expect(sup.recv.countTag('restore_to_manifest')).toBe(0);

    // (2) The current epoch is accepted: head back to the baseline, and the
    // supervisor is told to put the disk back (spec 5.3 / 4.7).
    const ok = await apiPost<Review>(`/api/computers/${id}/runs/${runId}/revert`, cookie, {
      epoch,
    });
    expect(ok.status).toBe(200);
    expect(ok.body.review).toBe('reverted');
    expect(ok.body.applied).toBe(true);
    expect(ok.body.head).toBe(PRE);
    expect(await stub.getHead()).toBe(PRE);

    const restore = await sup.recv.waitForTag('restore_to_manifest');
    expect(restore.c.manifest).toBe(PRE);

    // (3) Idempotent: a second revert changes nothing and does not re-send.
    const repeat = await apiPost<Review>(`/api/computers/${id}/runs/${runId}/revert`, cookie, {
      epoch,
    });
    expect(repeat.status).toBe(200);
    expect(repeat.body.applied).toBe(false);
    expect(await stub.getHead()).toBe(PRE);
    await delay(60);
    expect(sup.recv.countTag('restore_to_manifest')).toBe(1);

    // (4) Keeping a reverted run is a conflict.
    const conflict = await apiPost<Review>(`/api/computers/${id}/runs/${runId}/keep`, cookie, {
      epoch,
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('already_reverted');
    expect(await stub.getHead()).toBe(PRE);

    const list = await apiGet<{ runs: RunSummary[] }>(`/api/computers/${id}/runs`, cookie);
    expect(list.body.runs[0]!.review).toBe('reverted');
    sup.close();
  });

  it('a revert under a superseded wake generation is fenced out', async () => {
    const { id, stub, sup, runId, epoch } = await completedRun(cookie, 'fenced');

    // A new wake generation takes the computer (WARM rollback / migration).
    await stub.sleepNow();
    const w2 = await stub.wake(id);
    expect(w2.epoch).toBe(epoch + 1);

    // A client still holding the OLD epoch tries to revert: refused.
    const stale = await apiPost<Review>(`/api/computers/${id}/runs/${runId}/revert`, cookie, {
      epoch,
    });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('stale_epoch');
    expect(stale.body.currentEpoch).toBe(w2.epoch);
    expect(await stub.getHead()).toBe(POST);

    // The current generation may revert.
    const fresh = await apiPost<Review>(`/api/computers/${id}/runs/${runId}/revert`, cookie, {
      epoch: w2.epoch,
    });
    expect(fresh.status).toBe(200);
    expect(await stub.getHead()).toBe(PRE);
    sup.close();
  });

  it('refuses to review a run that has not finished, and 404s an unknown run', async () => {
    const id = await createComputer(cookie, 'unfinished');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const started = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sleep', '600'],
    });
    await sup.recv.waitForTag('start_run');
    sup.runStarted(started.body.runId, PRE);
    await delay(60);

    const early = await apiPost<Review>(
      `/api/computers/${id}/runs/${started.body.runId}/revert`,
      cookie,
      { epoch: w.epoch },
    );
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('run_active');

    const missing = await apiPost<Review>(`/api/computers/${id}/runs/nope/keep`, cookie, {});
    expect(missing.status).toBe(404);
    expect(missing.body.error).toBe('not_found');
    sup.close();
  });
});
