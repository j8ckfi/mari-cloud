// The dev seed's two promises the web e2e suite leans on (contracts.md
// Appendix A), asserted through the real REST surface, a real ComputerDO and a
// real R2 store.
//
//  1. It writes a SECOND real manifest (`postRunManifest`) that differs from the
//     head by exactly one added, one modified and one removed entry. A run's
//     result is a difference between two manifests (spec 5.3) and only
//     marid/mari-core can write one, so without this the e2e's fake supervisor
//     has to invent a post-run id — which makes `GET /runs/:id/diff` a
//     `404 manifest_missing` and moves the head onto an object that is not in
//     the store when the user chooses Keep.
//  2. Re-running the seed RESETS each seeded computer. `wrangler dev` persists
//     Durable Object storage between sessions, so a "deterministic" seed that
//     kept the previous session's runs and undismissed attention events would
//     let an e2e assertion pass on residue instead of on what it did.

import { describe, it, expect, beforeAll } from 'vitest';
import {
  apiGet,
  apiPost,
  computerStub,
  ensureSchema,
  FakeSupervisor,
  seedSession,
  waitUntil,
} from './helpers';
import { SEED_RUN_CHANGES } from '../src/seed';

interface DiffBody {
  runId: string;
  base: string;
  head: string;
  summary: { added: number; modified: number; removed: number };
  entries: Array<{
    path: string;
    change: 'added' | 'modified' | 'removed';
    oldSize: number | null;
    newSize: number | null;
    contentChanged: boolean;
    kind: string;
  }>;
  truncated: boolean;
}

describe('dev seed', () => {
  beforeAll(async () => {
    await ensureSchema();
  });

  it('writes a post-run manifest that the diff route reads as +1 ~1 -1 at the seeded paths', async () => {
    const { cookie, computerId, manifest, postRunManifest } = await seedSession();
    expect(postRunManifest).toMatch(/^[0-9a-f]{64}$/);
    expect(postRunManifest).not.toBe(manifest);

    // Drive it exactly as the web e2e does: a run through the REST surface,
    // reported by a supervisor with those two manifest ids.
    const stub = computerStub(computerId);
    const started = await apiPost<{ runId: string }>(
      `/api/computers/${computerId}/runs`,
      cookie,
      { argv: ['/bin/true'] },
    );
    const runId = started.body.runId;
    await waitUntil(async () => (await stub.getState()) === 'awake', 3000, 'wake');
    const w = await stub.wake(computerId);
    const sup = await FakeSupervisor.connect(computerId);
    await sup.handshake(computerId, w.epoch, w.token);
    await sup.recv.waitForTag('start_run');

    sup.runStarted(runId, manifest);
    sup.runCompleted(runId, postRunManifest, { t: 'exited', c: { code: 0 } }, {
      added: 1,
      modified: 1,
      removed: 1,
    });
    await waitUntil(
      async () =>
        (await apiGet<DiffBody>(`/api/computers/${computerId}/runs/${runId}/diff`, cookie))
          .status === 200,
      3000,
      'diff available',
    );

    const diff = await apiGet<DiffBody>(`/api/computers/${computerId}/runs/${runId}/diff`, cookie);
    expect(diff.status).toBe(200);
    expect(diff.body.base).toBe(manifest);
    expect(diff.body.head).toBe(postRunManifest);
    expect(diff.body.summary).toEqual({ added: 1, modified: 1, removed: 1 });
    expect(diff.body.truncated).toBe(false);

    const byChange = (change: string): string[] =>
      diff.body.entries.filter((e) => e.change === change).map((e) => e.path);
    expect(byChange('added')).toEqual([...SEED_RUN_CHANGES.added]);
    expect(byChange('modified')).toEqual([...SEED_RUN_CHANGES.modified]);
    expect(byChange('removed')).toEqual([...SEED_RUN_CHANGES.removed]);

    // The modified entry really has different bytes on the two sides — a diff
    // that only compared paths would pass everything above and be worthless.
    const modified = diff.body.entries.find((e) => e.path === SEED_RUN_CHANGES.modified[0])!;
    expect(modified.contentChanged).toBe(true);
    expect(modified.oldSize).toBeGreaterThan(0);
    expect(modified.newSize).toBeGreaterThan(modified.oldSize as number);

    sup.close();
  });

  it('re-seeding clears the runs and attention a previous session left in the DO', async () => {
    const { cookie, computerId, manifest } = await seedSession();
    const stub = computerStub(computerId);

    const started = await apiPost<{ runId: string }>(
      `/api/computers/${computerId}/runs`,
      cookie,
      { argv: ['/bin/sleep', '30'] },
    );
    const runId = started.body.runId;
    await waitUntil(async () => (await stub.getState()) === 'awake', 3000, 'wake');
    const w = await stub.wake(computerId);
    const sup = await FakeSupervisor.connect(computerId);
    await sup.handshake(computerId, w.epoch, w.token);
    await sup.recv.waitForTag('start_run');
    sup.runStarted(runId, manifest);
    sup.attention(runId, 'blocked_read');

    // Residue exists: one live run and one undismissed attention event.
    await waitUntil(
      async () => (await stub.describe(computerId)).attention.length === 1,
      3000,
      'attention recorded',
    );
    const before = await apiGet<{ runs: Array<{ id: string }> }>(
      `/api/computers/${computerId}/runs`,
      cookie,
    );
    expect(before.body.runs.map((r) => r.id)).toContain(runId);
    expect((await stub.describe(computerId)).activeRunIds).toContain(runId);
    sup.close();

    // A fresh seed — the same call the e2e's setup project makes — wipes it.
    const again = await seedSession();
    expect(again.computerId).toBe(computerId);
    const after = await apiGet<{ runs: Array<{ id: string }> }>(
      `/api/computers/${computerId}/runs`,
      again.cookie,
    );
    expect(after.body.runs).toEqual([]);
    const snap = await stub.describe(computerId);
    expect(snap.attention).toEqual([]);
    expect(snap.activeRunIds).toEqual([]);
    expect(snap.head).toBe(again.manifest);
    expect(snap.state).toBe('cold');
  });
});
