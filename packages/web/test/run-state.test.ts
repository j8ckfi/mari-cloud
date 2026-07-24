import { describe, it, expect } from 'vitest';
import {
  INITIAL_RUN_STATE,
  hasReviewableResult,
  isActive,
  isTerminal,
  mergeRunState,
  nextRunState,
  runStateLabel,
  type RunState,
  type RunTransition,
} from '../src/runs/state';
import { mergeRuns, activeRows } from '../src/runs/merge';
import { applyEvents, initialEventsModel } from '../src/events/reducer';
import type { MariEvent, RunSummary } from '../src/api/types';

const ALL_STATES: RunState[] = ['pending', 'running', 'stopping', 'exited', 'failed'];
const ALL_TRANSITIONS: RunTransition[] = [
  { t: 'accepted' },
  { t: 'started' },
  { t: 'stop_requested' },
  { t: 'completed', exitCode: 0 },
  { t: 'failed' },
];

describe('run state machine (spec 5)', () => {
  it('walks the happy path start → run → complete', () => {
    let s = INITIAL_RUN_STATE;
    expect(s).toBe('pending');
    s = nextRunState(s, { t: 'started' });
    expect(s).toBe('running');
    s = nextRunState(s, { t: 'completed', exitCode: 0 });
    expect(s).toBe('exited');
  });

  it('NEVER resurrects a finished run from a late or reordered event', () => {
    // Spec 5.5: the completion event is the truth. A `started` that arrives
    // after it (SSE reconnect replay, or out-of-order delivery) must not put
    // the run back on the active list.
    for (const terminal of ['exited', 'failed'] as RunState[]) {
      for (const tr of ALL_TRANSITIONS) {
        expect(nextRunState(terminal, tr), `${terminal} + ${tr.t}`).toBe(terminal);
      }
    }
  });

  it('keeps `stopping` sticky against a late start', () => {
    const stopping = nextRunState('running', { t: 'stop_requested' });
    expect(stopping).toBe('stopping');
    expect(nextRunState(stopping, { t: 'started' })).toBe('stopping');
    // …but a completion still lands.
    expect(nextRunState(stopping, { t: 'completed', exitCode: 130 })).toBe('exited');
  });

  it('is idempotent for every (state, transition) pair', () => {
    for (const s of ALL_STATES) {
      for (const tr of ALL_TRANSITIONS) {
        const once = nextRunState(s, tr);
        const twice = nextRunState(once, tr);
        expect(twice, `${s} + ${tr.t} twice`).toBe(once);
      }
    }
  });

  it('treats a stale `accepted` as no news', () => {
    expect(nextRunState('running', { t: 'accepted' })).toBe('running');
    expect(nextRunState('stopping', { t: 'accepted' })).toBe('stopping');
    expect(nextRunState('pending', { t: 'accepted' })).toBe('pending');
  });

  it('classifies active vs terminal exhaustively', () => {
    expect(ALL_STATES.filter(isActive)).toEqual(['pending', 'running', 'stopping']);
    expect(ALL_STATES.filter(isTerminal)).toEqual(['exited', 'failed']);
    for (const s of ALL_STATES) expect(isActive(s)).toBe(!isTerminal(s));
  });

  it('mergeRunState keeps the further-along observation, in both orders', () => {
    expect(mergeRunState('pending', 'running')).toBe('running');
    expect(mergeRunState('running', 'pending')).toBe('running');
    expect(mergeRunState('exited', 'running')).toBe('exited');
    expect(mergeRunState('running', 'exited')).toBe('exited');
    expect(mergeRunState('stopping', 'running')).toBe('stopping');
  });

  it('labels an exit with its code, and only then', () => {
    expect(runStateLabel('exited', 0)).toBe('exit 0');
    expect(runStateLabel('exited', 137)).toBe('exit 137');
    expect(runStateLabel('exited', null)).toBe('exited');
    expect(runStateLabel('running', 0)).toBe('running');
  });

  it('offers a review only for a finished run that changed something (5.3)', () => {
    const some = { added: 1, modified: 0, removed: 0 };
    const none = { added: 0, modified: 0, removed: 0 };
    expect(hasReviewableResult('exited', some)).toBe(true);
    expect(hasReviewableResult('exited', none)).toBe(false);
    expect(hasReviewableResult('exited', null)).toBe(false);
    expect(hasReviewableResult('running', some)).toBe(false);
    expect(hasReviewableResult('failed', some)).toBe(false);
  });
});

function summary(over: Partial<RunSummary> = {}): RunSummary {
  return {
    id: 'r1',
    state: 'running',
    argv: ['npm', 'test'],
    cwd: '/',
    exitCode: null,
    signal: null,
    attention: false,
    startedAt: 1000,
    endedAt: null,
    preRunManifest: 'm0',
    postRunManifest: null,
    diff: null,
    review: 'pending',
    ...over,
  };
}

function ev(over: Partial<MariEvent> & { type: MariEvent['type'] }): MariEvent {
  return { seq: 1, at: 1, computer: 'c1', ...over } as MariEvent;
}

describe('runs merge (REST list × live stream)', () => {
  it('shows a run that exists only in the live stream', () => {
    const live = applyEvents(initialEventsModel(), [
      ev({ type: 'run', seq: 1, at: 5000, runId: 'r-new', state: 'running' }) as MariEvent,
    ]);
    const rows = mergeRuns('c1', [], live);
    expect(rows.map((r) => r.id)).toEqual(['r-new']);
    expect(rows[0]!.liveOnly).toBe(true);
    expect(rows[0]!.state).toBe('running');
  });

  it('does not show another computer’s runs', () => {
    const live = applyEvents(initialEventsModel(), [
      ev({ type: 'run', seq: 1, at: 5000, computer: 'other', runId: 'r-x', state: 'running' }) as MariEvent,
    ]);
    expect(mergeRuns('c1', [], live)).toEqual([]);
  });

  it('lets the live stream advance a stale REST row, but never rewind it', () => {
    const live = applyEvents(initialEventsModel(), [
      ev({ type: 'run', seq: 1, at: 6000, runId: 'r1', state: 'exited', exitCode: 3 }) as MariEvent,
    ]);
    const rows = mergeRuns('c1', [summary({ state: 'running' })], live);
    expect(rows[0]!.state).toBe('exited');
    expect(rows[0]!.exitCode).toBe(3);
    expect(rows[0]!.liveOnly).toBe(false);
    // argv survives from REST — the stream carries no command line.
    expect(rows[0]!.argv).toEqual(['npm', 'test']);

    // The other direction: REST already knows it exited, a late live `running`
    // arrives. The row must stay exited.
    const stale = applyEvents(initialEventsModel(), [
      ev({ type: 'run', seq: 9, at: 7000, runId: 'r1', state: 'running' }) as MariEvent,
    ]);
    const rows2 = mergeRuns('c1', [summary({ state: 'exited', exitCode: 0 })], stale);
    expect(rows2[0]!.state).toBe('exited');
  });

  it('flags attention from either source', () => {
    const live = applyEvents(initialEventsModel(), [
      ev({ type: 'attention', seq: 1, at: 10, runId: 'r1', state: 'waiting' }) as MariEvent,
    ]);
    expect(mergeRuns('c1', [summary({ attention: false })], live)[0]!.attention).toBe(true);
    // and from REST alone
    expect(mergeRuns('c1', [summary({ attention: true })], initialEventsModel())[0]!.attention).toBe(
      true,
    );
  });

  it('orders newest first and counts active rows', () => {
    const rows = mergeRuns(
      'c1',
      [
        summary({ id: 'old', startedAt: 100, state: 'exited', exitCode: 0 }),
        summary({ id: 'new', startedAt: 900, state: 'running' }),
        summary({ id: 'mid', startedAt: 500, state: 'pending' }),
      ],
      initialEventsModel(),
    );
    expect(rows.map((r) => r.id)).toEqual(['new', 'mid', 'old']);
    expect(activeRows(rows).map((r) => r.id)).toEqual(['new', 'mid']);
  });
});
