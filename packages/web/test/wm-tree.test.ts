import { describe, it, expect } from 'vitest';
import {
  singlePane,
  splitPane,
  closePane,
  resizeSplit,
  focusPane,
  focusMove,
  computeRects,
  paneIds,
  findPane,
  emptyLayout,
  type Layout,
  type SplitNode,
} from '../src/wm/tree';
import type { PaneSpec } from '../src/wm/pane';

const term = (run: string): PaneSpec => ({ kind: 'terminal', run });

/** Build the canonical 2x2 grid with deterministic ids A|B over C|D. */
function grid2x2(): Layout {
  let l = singlePane(term('A'), 'A');
  l = splitPane(l, 'A', 'column', term('C'), 'C', 's1'); // A top, C bottom
  l = splitPane(l, 'A', 'row', term('B'), 'B', 's2'); // A left, B right (top)
  l = splitPane(l, 'C', 'row', term('D'), 'D', 's3'); // C left, D right (bottom)
  return l;
}

describe('splitPane', () => {
  it('seeds a single pane and focuses it', () => {
    const l = singlePane(term('A'), 'A');
    expect(l.root).toEqual({ type: 'pane', id: 'A', pane: term('A') });
    expect(l.focused).toBe('A');
    expect(paneIds(l.root)).toEqual(['A']);
  });

  it('replaces the target pane with a split; new pane takes slot b and focus', () => {
    const l = splitPane(singlePane(term('A'), 'A'), 'A', 'row', term('B'), 'B', 's1');
    expect(l.focused).toBe('B');
    const root = l.root as SplitNode;
    expect(root.type).toBe('split');
    expect(root.axis).toBe('row');
    expect(root.ratio).toBe(0.5);
    expect(root.a).toEqual({ type: 'pane', id: 'A', pane: term('A') });
    expect((root.b as { id: string }).id).toBe('B');
    expect(paneIds(l.root)).toEqual(['A', 'B']); // depth-first left→right
  });

  it('does not mutate the input layout', () => {
    const l0 = singlePane(term('A'), 'A');
    const before = JSON.stringify(l0);
    splitPane(l0, 'A', 'row', term('B'), 'B', 's1');
    expect(JSON.stringify(l0)).toBe(before);
  });

  it('is a no-op when the target id is absent', () => {
    const l0 = singlePane(term('A'), 'A');
    const l1 = splitPane(l0, 'ZZZ', 'row', term('B'), 'B', 's1');
    expect(l1).toBe(l0);
  });

  it('produces correct normalized rectangles for a row split', () => {
    const l = splitPane(singlePane(term('A'), 'A'), 'A', 'row', term('B'), 'B', 's1');
    const rects = computeRects(l.root);
    expect(rects.get('A')).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
    expect(rects.get('B')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });

  it('produces correct normalized rectangles for a column split', () => {
    const l = splitPane(singlePane(term('A'), 'A'), 'A', 'column', term('B'), 'B', 's1');
    const rects = computeRects(l.root);
    expect(rects.get('A')).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(rects.get('B')).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });

  it('lays out the 2x2 grid at exact quarter rectangles', () => {
    const rects = computeRects(grid2x2().root);
    expect(rects.get('A')).toEqual({ x: 0, y: 0, w: 0.5, h: 0.5 });
    expect(rects.get('B')).toEqual({ x: 0.5, y: 0, w: 0.5, h: 0.5 });
    expect(rects.get('C')).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(rects.get('D')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });
});

describe('closePane', () => {
  it('promotes the sibling into the parent slot', () => {
    const l = splitPane(singlePane(term('A'), 'A'), 'A', 'row', term('B'), 'B', 's1');
    const closed = closePane(l, 'B');
    expect(closed.root).toEqual({ type: 'pane', id: 'A', pane: term('A') });
    expect(closed.focused).toBe('A');
  });

  it('collapses one cell of the 2x2 grid, leaving the other three', () => {
    const closed = closePane(grid2x2(), 'B');
    expect(paneIds(closed.root).sort()).toEqual(['A', 'C', 'D']);
    const rects = computeRects(closed.root);
    // With B gone, A fills the whole top half.
    expect(rects.get('A')).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(rects.get('C')).toEqual({ x: 0, y: 0.5, w: 0.5, h: 0.5 });
    expect(rects.get('D')).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
  });

  it('empties the layout when the last pane is closed', () => {
    const l = singlePane(term('A'), 'A');
    expect(closePane(l, 'A')).toEqual(emptyLayout());
  });

  it('refocuses to a surviving pane when the focused pane is closed', () => {
    const l = focusPane(grid2x2(), 'B');
    const closed = closePane(l, 'B');
    expect(closed.focused).not.toBe('B');
    expect(findPane(closed.root, closed.focused as string)).not.toBeNull();
  });

  it('is a no-op for an absent id', () => {
    const l = grid2x2();
    expect(closePane(l, 'ZZZ')).toBe(l);
  });
});

describe('resizeSplit', () => {
  it('updates the ratio and reflects it in rectangles', () => {
    const l = splitPane(singlePane(term('A'), 'A'), 'A', 'row', term('B'), 'B', 's1');
    const resized = resizeSplit(l, 's1', 0.7);
    expect((resized.root as SplitNode).ratio).toBe(0.7);
    const rects = computeRects(resized.root);
    expect(rects.get('A')!.w).toBeCloseTo(0.7, 10);
    expect(rects.get('B')!.w).toBeCloseTo(0.3, 10);
  });

  it('clamps the ratio into the allowed band', () => {
    const l = splitPane(singlePane(term('A'), 'A'), 'A', 'row', term('B'), 'B', 's1');
    expect((resizeSplit(l, 's1', 5).root as SplitNode).ratio).toBe(0.95);
    expect((resizeSplit(l, 's1', -1).root as SplitNode).ratio).toBe(0.05);
  });
});

describe('focusMove', () => {
  it('moves right/left/up/down between adjacent grid cells', () => {
    const g = focusPane(grid2x2(), 'A');
    expect(focusMove(g, 'right').focused).toBe('B');
    expect(focusMove(g, 'down').focused).toBe('C');
    expect(focusMove(focusPane(g, 'B'), 'left').focused).toBe('A');
    expect(focusMove(focusPane(g, 'B'), 'down').focused).toBe('D');
    expect(focusMove(focusPane(g, 'C'), 'up').focused).toBe('A');
    expect(focusMove(focusPane(g, 'C'), 'right').focused).toBe('D');
    expect(focusMove(focusPane(g, 'D'), 'left').focused).toBe('C');
    expect(focusMove(focusPane(g, 'D'), 'up').focused).toBe('B');
  });

  it('never jumps diagonally (requires perpendicular overlap)', () => {
    // From A, moving right must reach B (overlapping row), not D (diagonal).
    const g = focusPane(grid2x2(), 'A');
    expect(focusMove(g, 'right').focused).toBe('B');
    expect(focusMove(g, 'down').focused).toBe('C');
  });

  it('returns the layout unchanged at an edge', () => {
    const g = focusPane(grid2x2(), 'A');
    expect(focusMove(g, 'left')).toBe(g); // nothing to the left of A
    expect(focusMove(g, 'up')).toBe(g); // nothing above A
  });

  it('picks the nearest pane when several lie in a direction', () => {
    // Row of three: A | B | C. From A, right resolves to B, not C.
    let l = singlePane(term('A'), 'A');
    l = splitPane(l, 'A', 'row', term('B'), 'B', 's1'); // A | B
    l = splitPane(l, 'B', 'row', term('C'), 'C', 's2'); // A | (B | C)
    l = focusPane(l, 'A');
    expect(focusMove(l, 'right').focused).toBe('B');
    expect(focusMove(focusPane(l, 'C'), 'left').focused).toBe('B');
  });
});
