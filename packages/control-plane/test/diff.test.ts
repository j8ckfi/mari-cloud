// Manifest diff (spec 5.3 run result, spec 9.2 fork difference view).
//
// The engine is a pure function of two manifests (decisions.md), so the unit
// tests build manifests directly, and the route test drives the REAL flow: two
// manifests written into R2, a run whose supervisor reported them as its pre-
// and post-run manifests, and `GET .../diff` returning the structured result —
// with the computer never woken for the diff itself.
import { describe, it, expect, beforeAll } from 'vitest';
import type { Manifest, ManifestEntry } from '@mari/shared';
import { diffManifests, changedCount } from '../src/diff';
import {
  apiGet,
  apiPost,
  computerStub,
  createComputer,
  ensureSchema,
  FakeSupervisor,
  seedSession,
  writeManifestTree,
} from './helpers';

function file(path: string, size: number, chunk: string, mode = 0o100644): ManifestEntry {
  return {
    path,
    kind: 'file',
    mode,
    size,
    symlink_target: null,
    chunks: [{ chunk, len: size }],
  };
}

function manifest(entries: ManifestEntry[]): Manifest {
  return { version: 1, parent: null, created_at: 1_700_000_000, entries };
}

describe('diff engine (spec 9.2)', () => {
  it('classifies added / modified / removed and reports per-entry detail', () => {
    const from = manifest([
      file('/keep.txt', 3, 'c-keep'),
      file('/edit.txt', 5, 'c-old'),
      file('/gone.txt', 7, 'c-gone'),
    ]);
    const to = manifest([
      file('/keep.txt', 3, 'c-keep'),
      file('/edit.txt', 9, 'c-new'),
      file('/new.txt', 2, 'c-new2'),
    ]);

    const d = diffManifests(from, to);
    expect(d.summary).toEqual({ added: 1, modified: 1, removed: 1 });
    expect(changedCount(d.summary)).toBe(3);

    expect(d.added.map((e) => e.path)).toEqual(['/new.txt']);
    expect(d.added[0]!.size).toBe(2);
    expect(d.removed.map((e) => e.path)).toEqual(['/gone.txt']);
    expect(d.removed[0]!.size).toBe(7);

    const m = d.modified[0]!;
    expect(m.path).toBe('/edit.txt');
    expect(m.from.size).toBe(5);
    expect(m.to.size).toBe(9);
    expect(m.sizeDelta).toBe(4);
    expect(m.contentChanged).toBe(true);
    expect(m.modeChanged).toBe(false);

    // An unchanged file appears nowhere.
    expect([...d.added, ...d.modified, ...d.removed].map((e) => e.path)).not.toContain('/keep.txt');
  });

  it('detects a mode-only change without claiming the content moved', () => {
    const from = manifest([file('/run.sh', 4, 'c1', 0o100644)]);
    const to = manifest([file('/run.sh', 4, 'c1', 0o100755)]);
    const d = diffManifests(from, to);
    expect(d.summary).toEqual({ added: 0, modified: 1, removed: 0 });
    const m = d.modified[0]!;
    expect(m.modeChanged).toBe(true);
    expect(m.contentChanged).toBe(false);
    expect(m.from.mode).toBe(0o100644);
    expect(m.to.mode).toBe(0o100755);
  });

  it('detects a re-chunked file of identical size as changed content', () => {
    const from = manifest([file('/data.bin', 10, 'chunk-a')]);
    const to = manifest([file('/data.bin', 10, 'chunk-b')]);
    const d = diffManifests(from, to);
    expect(d.modified[0]!.contentChanged).toBe(true);
    expect(d.modified[0]!.sizeDelta).toBe(0);
  });

  it('notices a file replaced by a symlink', () => {
    const from = manifest([file('/link', 3, 'c1')]);
    const to = manifest([
      {
        path: '/link',
        kind: 'symlink',
        mode: 0o120777,
        size: 0,
        symlink_target: '/elsewhere',
        chunks: [],
      },
    ]);
    const d = diffManifests(from, to);
    const m = d.modified[0]!;
    expect(m.kindChanged).toBe(true);
    expect(m.symlinkChanged).toBe(true);
    expect(m.to.symlink_target).toBe('/elsewhere');
  });

  it('is empty for a manifest against itself', () => {
    const only = manifest([file('/a', 1, 'c')]);
    expect(diffManifests(only, only).summary).toEqual({ added: 0, modified: 0, removed: 0 });
  });
});

interface DiffResponse {
  runId: string;
  base: string | null;
  head: string | null;
  summary: { added: number; modified: number; removed: number };
  entries: {
    path: string;
    change: 'added' | 'modified' | 'removed';
    oldMode: number | null;
    newMode: number | null;
    oldSize: number | null;
    newSize: number | null;
    contentChanged: boolean;
  }[];
  truncated?: boolean;
  error?: string;
}

describe('run diff route (spec 5.3)', () => {
  let cookie = '';
  beforeAll(async () => {
    await ensureSchema();
    ({ cookie } = await seedSession());
  });

  it('returns the real structured diff of the run’s two manifests', async () => {
    const before = await writeManifestTree({
      '/README.md': 'hello',
      '/notes/todo.txt': 'wake the computer\n',
      '/same.txt': 'unchanged',
    });
    const after = await writeManifestTree({
      '/README.md': 'hello world, much longer now',
      '/src/new.ts': 'export const x = 1;\n',
      '/same.txt': 'unchanged',
    });
    expect(before).not.toBe(after);

    const id = await createComputer(cookie, 'differ');
    const stub = computerStub(id);
    const w = await stub.wake(id);
    const sup = await FakeSupervisor.connect(id);
    await sup.handshake(id, w.epoch, w.token);

    const started = await apiPost<{ runId: string }>(`/api/computers/${id}/runs`, cookie, {
      argv: ['/bin/sh', '-c', 'work'],
    });
    const runId = started.body.runId;
    await sup.recv.waitForTag('start_run');

    // Before completion the diff has no second side to compare against.
    const early = await apiGet<DiffResponse>(`/api/computers/${id}/runs/${runId}/diff`, cookie);
    expect(early.status).toBe(409);
    expect(early.body.error).toBe('run_incomplete');

    sup.runStarted(runId, before);
    sup.runCompleted(runId, after, { t: 'exited', c: { code: 0 } }, {
      added: 2,
      modified: 1,
      removed: 2,
    });

    let diff = await apiGet<DiffResponse>(`/api/computers/${id}/runs/${runId}/diff`, cookie);
    for (let i = 0; i < 100 && diff.status !== 200; i++) {
      await new Promise((r) => setTimeout(r, 10));
      diff = await apiGet<DiffResponse>(`/api/computers/${id}/runs/${runId}/diff`, cookie);
    }
    expect(diff.status).toBe(200);
    expect(diff.body.base).toBe(before);
    expect(diff.body.head).toBe(after);

    // `/src` + `/src/new.ts` added, `/notes` + `/notes/todo.txt` removed,
    // `/README.md` modified, `/same.txt` untouched.
    expect(diff.body.summary).toEqual({ added: 2, modified: 1, removed: 2 });

    const byPath = new Map(diff.body.entries.map((e) => [e.path, e]));
    expect([...byPath.keys()].sort()).toEqual([
      '/README.md',
      '/notes',
      '/notes/todo.txt',
      '/src',
      '/src/new.ts',
    ]);

    const readme = byPath.get('/README.md')!;
    expect(readme.change).toBe('modified');
    expect(readme.oldSize).toBe('hello'.length);
    expect(readme.newSize).toBe('hello world, much longer now'.length);
    expect(readme.contentChanged).toBe(true);
    expect(readme.oldMode).toBe(0o100644);

    const added = byPath.get('/src/new.ts')!;
    expect(added.change).toBe('added');
    expect(added.oldSize).toBeNull();
    expect(added.newSize).toBe('export const x = 1;\n'.length);

    const removed = byPath.get('/notes/todo.txt')!;
    expect(removed.change).toBe('removed');
    expect(removed.newMode).toBeNull();
    expect(removed.oldSize).toBe('wake the computer\n'.length);

    expect(byPath.get('/same.txt')).toBeUndefined();
    expect(diff.body.truncated).toBe(false);
    sup.close();
  });

  it('404s an unknown run and an unowned computer', async () => {
    const id = await createComputer(cookie, 'diff-404');
    const unknown = await apiGet<DiffResponse>(`/api/computers/${id}/runs/nope/diff`, cookie);
    expect(unknown.status).toBe(404);
    const foreign = await apiGet<DiffResponse>(`/api/computers/not-mine/runs/x/diff`, cookie);
    expect(foreign.status).toBe(404);
  });
});
