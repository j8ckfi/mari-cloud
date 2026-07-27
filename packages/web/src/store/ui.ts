// UI + window-manager state (zustand). decisions.md: "zustand for UI/WM state,
// TanStack Query for server state". This store owns the workspace list, the
// active view, the per-computer pane layouts, and the command-palette open
// flag. Server data (fleet, files, layouts-from-DO) never lives here — it comes
// from TanStack Query and is only pushed in via `hydrateLayout`.

import { create } from 'zustand';
import {
  autoPlace,
  emptyLayout,
  singlePane,
  splitPane,
  closePane as closePaneOp,
  findPane,
  findPaneBy,
  focusMove as focusMoveOp,
  focusPane as focusPaneOp,
  resizeSplit as resizeSplitOp,
  type Layout,
  type MoveDir,
  type PaneNode,
  type SplitAxis,
} from '../wm/tree';
import { isDiffFor, isTerminalFor, samePane, type PaneSpec } from '../wm/pane';

export type View = 'fleet' | 'workspace';

/** Width/height ratio of the workspace viewport, for balanced auto-placement. */
function workspaceAspect(): number {
  if (typeof window === 'undefined' || window.innerHeight <= 0) return 16 / 9;
  return window.innerWidth / window.innerHeight;
}

/** The default layout for a freshly opened computer: a COLD-safe file browser. */
export function defaultLayout(): Layout {
  return singlePane({ kind: 'files', path: '/' });
}

interface UiState {
  view: View;
  /** Computer ids in slot order; slot i is Super/Alt+(i+1). */
  workspaces: string[];
  activeComputer: string | null;
  /** Per-computer pane layout. */
  layouts: Record<string, Layout>;
  paletteOpen: boolean;
  /**
   * One line of plain text reporting the outcome of a command the user ran
   * from the palette (a snapshot, a stop). It is text, not a spinner: spec 8.3
   * forbids blocking the interface, but a command that reports NOTHING is not
   * operable either — the user cannot tell success from a dead key.
   */
  notice: string;

  // ---- navigation ----
  setWorkspaces(ids: string[]): void;
  openComputer(id: string): void;
  switchToSlot(index: number): void;
  goFleet(): void;

  // ---- layout ----
  layoutFor(id: string): Layout;
  hydrateLayout(id: string, layout: Layout): void;
  setLayout(id: string, layout: Layout): void;
  addPane(pane: PaneSpec): void;
  splitFocused(axis: SplitAxis, pane: PaneSpec): void;
  closeFocused(): void;
  moveFocus(dir: MoveDir): void;
  focusPane(id: string): void;
  resizeFocusedSplit(splitId: string, ratio: number): void;
  /** The focused pane leaf of the active computer, or null. */
  focusedPane(): PaneNode | null;

  // ---- runs (spec 5) ----
  /** Focus the terminal pane of `run` on `computer`, opening one if absent. */
  openRunTerminal(computer: string, run: string): void;
  /** Focus the difference pane of `run`, opening one if absent (spec 5.3). */
  openRunDiff(computer: string, run: string): void;

  // ---- palette ----
  setPaletteOpen(open: boolean): void;
  togglePalette(): void;
  setNotice(text: string): void;
}

export const useUiStore = create<UiState>((set, get) => ({
  view: 'fleet',
  workspaces: [],
  activeComputer: null,
  layouts: {},
  paletteOpen: false,
  notice: '',

  setWorkspaces: (ids) => set({ workspaces: ids }),

  openComputer: (id) =>
    set((s) => {
      const workspaces = s.workspaces.includes(id) ? s.workspaces : [...s.workspaces, id];
      const layouts = s.layouts[id] ? s.layouts : { ...s.layouts, [id]: defaultLayout() };
      return { workspaces, activeComputer: id, view: 'workspace', layouts };
    }),

  switchToSlot: (index) => {
    const id = get().workspaces[index];
    if (id === undefined) return;
    get().openComputer(id);
  },

  goFleet: () => set({ view: 'fleet' }),

  layoutFor: (id) => get().layouts[id] ?? defaultLayout(),

  hydrateLayout: (id, layout) =>
    set((s) => (s.layouts[id] ? s : { layouts: { ...s.layouts, [id]: layout } })),

  setLayout: (id, layout) => set((s) => ({ layouts: { ...s.layouts, [id]: layout } })),

  addPane: (pane) => {
    const id = get().activeComputer;
    if (id === null) return;
    const layout = get().layoutFor(id);
    // A pane that already shows exactly this is focused, not duplicated —
    // double-clicking a file must not open the same editor twice.
    const existing = findPaneBy(layout.root, (p) => samePane(p, pane));
    if (existing !== null) {
      get().setLayout(id, focusPaneOp(layout, existing.id));
      return;
    }
    // Balanced placement: split the largest pane, not the focused one, so
    // adding panes tiles the workspace instead of nesting narrow columns.
    get().setLayout(id, autoPlace(layout, pane, workspaceAspect()));
  },

  splitFocused: (axis, pane) => {
    const id = get().activeComputer;
    if (id === null) return;
    const layout = get().layoutFor(id);
    if (layout.root === null || layout.focused === null) {
      get().setLayout(id, singlePane(pane));
      return;
    }
    get().setLayout(id, splitPane(layout, layout.focused, axis, pane));
  },

  closeFocused: () => {
    const id = get().activeComputer;
    if (id === null) return;
    const layout = get().layoutFor(id);
    if (layout.focused === null) return;
    get().setLayout(id, closePaneOp(layout, layout.focused));
  },

  moveFocus: (dir) => {
    const id = get().activeComputer;
    if (id === null) return;
    get().setLayout(id, focusMoveOp(get().layoutFor(id), dir));
  },

  focusPane: (paneId) => {
    const id = get().activeComputer;
    if (id === null) return;
    get().setLayout(id, focusPaneOp(get().layoutFor(id), paneId));
  },

  resizeFocusedSplit: (splitId, ratio) => {
    const id = get().activeComputer;
    if (id === null) return;
    get().setLayout(id, resizeSplitOp(get().layoutFor(id), splitId, ratio));
  },

  focusedPane: () => {
    const id = get().activeComputer;
    if (id === null) return null;
    const layout = get().layoutFor(id);
    if (layout.focused === null) return null;
    return findPane(layout.root, layout.focused);
  },

  openRunTerminal: (computer, run) => {
    get().openComputer(computer);
    const layout = get().layoutFor(computer);
    const existing = findPaneBy(layout.root, (p) => isTerminalFor(p, run));
    if (existing !== null) {
      get().setLayout(computer, focusPaneOp(layout, existing.id));
      return;
    }
    const pane: PaneSpec = { kind: 'terminal', run };
    get().setLayout(computer, autoPlace(layout, pane, workspaceAspect()));
  },

  openRunDiff: (computer, run) => {
    get().openComputer(computer);
    const layout = get().layoutFor(computer);
    const existing = findPaneBy(layout.root, (p) => isDiffFor(p, run));
    if (existing !== null) {
      get().setLayout(computer, focusPaneOp(layout, existing.id));
      return;
    }
    const pane: PaneSpec = { kind: 'diff', run };
    get().setLayout(computer, autoPlace(layout, pane, workspaceAspect()));
  },

  setPaletteOpen: (open) => set({ paletteOpen: open }),
  togglePalette: () => set((s) => ({ paletteOpen: !s.paletteOpen })),
  setNotice: (text) => set({ notice: text }),
}));

/** Non-hook accessor for imperative callers (hotkeys, command runners). */
export const uiStore = useUiStore;

// Re-export for consumers that only need the empty layout constant.
export { emptyLayout };
