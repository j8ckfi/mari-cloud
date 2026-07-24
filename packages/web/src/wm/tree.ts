// Hand-built tiling window-manager tree (spec 8.1, decisions.md: "the tiling WM
// is hand-built — it is the product; no dashboard-grid library").
//
// The layout of one workspace is a binary tree. A leaf is a pane; an internal
// node is a split of two children along an axis with a ratio. All operations
// here are PURE: they take a tree and return a new tree, never mutating the
// input. Geometry (used for directional focus movement and for rendering) is
// derived by assigning each node a normalized rectangle in the unit square.
//
// This module is the tested core of the WM. Its correctness is asserted at the
// math level: split produces the right nesting and ratios, close collapses the
// sibling into the parent's slot, and directional focus resolves to the
// geometrically nearest pane.

import type { PaneSpec } from './pane';

/** A split axis. `row` places children left|right; `column` places top/bottom. */
export type SplitAxis = 'row' | 'column';

/** Directional movement for keyboard focus (vim hjkl + arrows map here). */
export type MoveDir = 'left' | 'right' | 'up' | 'down';

/** A leaf: one pane. */
export interface PaneNode {
  type: 'pane';
  /** Stable node id (also the pane id). */
  id: string;
  pane: PaneSpec;
}

/** An internal node: two children split along `axis` at `ratio`. */
export interface SplitNode {
  type: 'split';
  id: string;
  axis: SplitAxis;
  /** Fraction [0..1] of the parent extent given to child `a`. */
  ratio: number;
  a: WmNode;
  b: WmNode;
}

export type WmNode = PaneNode | SplitNode;

/** A full workspace layout. `root` is null when the workspace has no panes. */
export interface Layout {
  root: WmNode | null;
  /** The focused pane id, or null when empty. Always references a live leaf. */
  focused: string | null;
}

/** A normalized rectangle within the unit square [0,1]x[0,1]. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const MIN_RATIO = 0.05;
const MAX_RATIO = 0.95;
const EPS = 1e-6;

let idCounter = 0;
/** Monotonic id source for new nodes. Deterministic within a process. */
export function nextNodeId(prefix = 'n'): string {
  idCounter += 1;
  return `${prefix}${idCounter}`;
}

/** An empty layout. */
export function emptyLayout(): Layout {
  return { root: null, focused: null };
}

/** A layout containing a single pane. */
export function singlePane(pane: PaneSpec, id = nextNodeId('p')): Layout {
  return { root: { type: 'pane', id, pane }, focused: id };
}

/** Every pane id in the tree, in left-to-right depth-first order. */
export function paneIds(node: WmNode | null): string[] {
  if (node === null) return [];
  if (node.type === 'pane') return [node.id];
  return [...paneIds(node.a), ...paneIds(node.b)];
}

/** Find a pane leaf by id, or null. */
export function findPane(node: WmNode | null, id: string): PaneNode | null {
  if (node === null) return null;
  if (node.type === 'pane') return node.id === id ? node : null;
  return findPane(node.a, id) ?? findPane(node.b, id);
}

/**
 * Split the pane `targetId` along `axis`, inserting `newPane`. The existing
 * pane keeps slot `a`; the new pane takes slot `b` (so a horizontal split puts
 * the new pane to the right, a vertical split puts it below). Returns the new
 * layout with focus moved to the new pane. If `targetId` is not found the
 * layout is returned unchanged.
 */
export function splitPane(
  layout: Layout,
  targetId: string,
  axis: SplitAxis,
  newPane: PaneSpec,
  newId = nextNodeId('p'),
  splitId = nextNodeId('s'),
): Layout {
  if (layout.root === null) {
    // Splitting an empty layout just seeds the first pane.
    return singlePane(newPane, newId);
  }
  let found = false;
  const replace = (node: WmNode): WmNode => {
    if (node.type === 'pane') {
      if (node.id !== targetId) return node;
      found = true;
      return {
        type: 'split',
        id: splitId,
        axis,
        ratio: 0.5,
        a: node,
        b: { type: 'pane', id: newId, pane: newPane },
      };
    }
    return { ...node, a: replace(node.a), b: replace(node.b) };
  };
  const root = replace(layout.root);
  if (!found) return layout;
  return { root, focused: newId };
}

/**
 * Close the pane `targetId`. Its sibling is promoted into the parent split's
 * slot (the split node disappears). Closing the last pane yields an empty
 * layout. Focus, if it was on the closed pane, moves to the first pane of the
 * promoted sibling subtree (or the nearest remaining pane).
 */
export function closePane(layout: Layout, targetId: string): Layout {
  if (layout.root === null) return layout;
  if (!containsPane(layout.root, targetId)) return layout;

  if (layout.root.type === 'pane') {
    if (layout.root.id !== targetId) return layout;
    return emptyLayout();
  }

  // Track the id we should focus after removal.
  let refocus: string | null = null;

  const remove = (node: WmNode): WmNode | null => {
    if (node.type === 'pane') {
      return node.id === targetId ? null : node;
    }
    const aHas = containsPane(node.a, targetId);
    const bHas = containsPane(node.b, targetId);
    if (aHas) {
      const newA = remove(node.a);
      if (newA === null) {
        // `a` collapsed to nothing: promote `b`.
        if (refocus === null) refocus = firstPaneId(node.b);
        return node.b;
      }
      return { ...node, a: newA };
    }
    if (bHas) {
      const newB = remove(node.b);
      if (newB === null) {
        if (refocus === null) refocus = firstPaneId(node.a);
        return node.a;
      }
      return { ...node, b: newB };
    }
    return node;
  };

  const root = remove(layout.root);
  if (root === null) return emptyLayout();

  let focused = layout.focused;
  if (focused === targetId || focused === null || findPane(root, focused) === null) {
    focused = refocus ?? firstPaneId(root);
  }
  return { root, focused };
}

/** Set the split ratio of the split node whose id is `splitId`, clamped. */
export function resizeSplit(layout: Layout, splitId: string, ratio: number): Layout {
  if (layout.root === null) return layout;
  const clamped = clampRatio(ratio);
  let changed = false;
  const walk = (node: WmNode): WmNode => {
    if (node.type === 'pane') return node;
    if (node.id === splitId) {
      changed = true;
      return { ...node, ratio: clamped };
    }
    return { ...node, a: walk(node.a), b: walk(node.b) };
  };
  const root = walk(layout.root);
  return changed ? { ...layout, root } : layout;
}

/** Explicitly focus a pane by id, if it exists. */
export function focusPane(layout: Layout, id: string): Layout {
  if (findPane(layout.root, id) === null) return layout;
  return { ...layout, focused: id };
}

/**
 * Move focus geometrically from the focused pane toward `dir`. Computes each
 * pane's rectangle, then picks the nearest pane on the far side of the moving
 * edge whose perpendicular span overlaps the focused pane. Returns the layout
 * unchanged if there is no pane in that direction.
 */
export function focusMove(layout: Layout, dir: MoveDir): Layout {
  if (layout.root === null || layout.focused === null) return layout;
  const rects = computeRects(layout.root);
  const from = rects.get(layout.focused);
  if (from === undefined) return layout;

  let best: string | null = null;
  let bestPrimary = Infinity;
  let bestPerp = Infinity;

  for (const [id, r] of rects) {
    if (id === layout.focused) continue;
    // Primary distance is along the movement axis (must be positive: the
    // candidate has to be on the far side). Perpendicular distance breaks ties
    // and requires overlap so we do not jump diagonally.
    let primary: number;
    let overlap: boolean;
    let perp: number;
    switch (dir) {
      case 'right':
        primary = r.x - (from.x + from.w);
        overlap = spansOverlap(from.y, from.h, r.y, r.h);
        perp = perpDistance(from.y, from.h, r.y, r.h);
        break;
      case 'left':
        primary = from.x - (r.x + r.w);
        overlap = spansOverlap(from.y, from.h, r.y, r.h);
        perp = perpDistance(from.y, from.h, r.y, r.h);
        break;
      case 'down':
        primary = r.y - (from.y + from.h);
        overlap = spansOverlap(from.x, from.w, r.x, r.w);
        perp = perpDistance(from.x, from.w, r.x, r.w);
        break;
      case 'up':
        primary = from.y - (r.y + r.h);
        overlap = spansOverlap(from.x, from.w, r.x, r.w);
        perp = perpDistance(from.x, from.w, r.x, r.w);
        break;
    }
    if (primary < -EPS) continue; // candidate is behind us
    if (!overlap) continue; // no perpendicular overlap: not a neighbor
    if (
      primary < bestPrimary - EPS ||
      (Math.abs(primary - bestPrimary) <= EPS && perp < bestPerp - EPS)
    ) {
      best = id;
      bestPrimary = primary;
      bestPerp = perp;
    }
  }

  if (best === null) return layout;
  return { ...layout, focused: best };
}

/** Assign each pane a normalized rectangle. Exposed for rendering and tests. */
export function computeRects(node: WmNode | null): Map<string, Rect> {
  const out = new Map<string, Rect>();
  const walk = (n: WmNode, r: Rect): void => {
    if (n.type === 'pane') {
      out.set(n.id, r);
      return;
    }
    if (n.axis === 'row') {
      const aw = r.w * n.ratio;
      walk(n.a, { x: r.x, y: r.y, w: aw, h: r.h });
      walk(n.b, { x: r.x + aw, y: r.y, w: r.w - aw, h: r.h });
    } else {
      const ah = r.h * n.ratio;
      walk(n.a, { x: r.x, y: r.y, w: r.w, h: ah });
      walk(n.b, { x: r.x, y: r.y + ah, w: r.w, h: r.h - ah });
    }
  };
  if (node !== null) walk(node, { x: 0, y: 0, w: 1, h: 1 });
  return out;
}

// ---- internals ----

function clampRatio(ratio: number): number {
  if (Number.isNaN(ratio)) return 0.5;
  return Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio));
}

function containsPane(node: WmNode, id: string): boolean {
  if (node.type === 'pane') return node.id === id;
  return containsPane(node.a, id) || containsPane(node.b, id);
}

/** The id of the first (leftmost/topmost) pane leaf in a subtree. */
export function firstPaneId(node: WmNode): string {
  let cur: WmNode = node;
  while (cur.type === 'split') cur = cur.a;
  return cur.id;
}

/** Whether two 1-D intervals [a0,a0+al] and [b0,b0+bl] overlap (open). */
function spansOverlap(a0: number, al: number, b0: number, bl: number): boolean {
  return a0 < b0 + bl - EPS && b0 < a0 + al - EPS;
}

/** Center-to-center perpendicular distance of two intervals. */
function perpDistance(a0: number, al: number, b0: number, bl: number): number {
  return Math.abs(a0 + al / 2 - (b0 + bl / 2));
}
