// Global keyboard handling (spec 8.1: "Super+1 to Super+9 change the
// workspace. A command palette (Cmd+K) gives all commands. Full keyboard
// operation must be possible.").
//
// The OS/browser frequently swallows the Super/Meta key (Cmd tab-switching,
// window management), so every Super binding also accepts ALT as a documented
// fallback modifier. The palette opens on Cmd/Ctrl+K. Directional focus and
// splits use the same Mod (Meta or Alt) so they never collide with characters
// typed into a focused terminal — the WM intercepts and preventDefaults them
// before xterm sees the key.

import type { MoveDir } from './wm/tree';

export interface HotkeyHandlers {
  /** Super/Alt + digit (1..9): switch to workspace slot (0-based index). */
  onWorkspaceSlot(index: number): void;
  /** Cmd/Ctrl + K: toggle the command palette. */
  onPaletteToggle(): void;
  /** Super/Alt + hjkl / arrows: move pane focus. */
  onFocusMove(dir: MoveDir): void;
  /** Super/Alt + Enter: split the focused pane to the right. */
  onSplitRight(): void;
  /** Super/Alt + Shift + Enter: split the focused pane downward. */
  onSplitDown(): void;
  /** Super/Alt + W: close the focused pane. */
  onClosePane(): void;
  /** Super/Alt + 0 (or Backquote): go to the fleet home. */
  onFleet(): void;
}

const FOCUS_KEYS: Record<string, MoveDir> = {
  h: 'left',
  j: 'down',
  k: 'up',
  l: 'right',
  ArrowLeft: 'left',
  ArrowDown: 'down',
  ArrowUp: 'up',
  ArrowRight: 'right',
};

/** True if the Super-or-fallback modifier is held (and not Ctrl, to disambiguate). */
function hasMod(e: KeyboardEvent): boolean {
  return (e.metaKey || e.altKey) && !e.ctrlKey;
}

/**
 * Handle one keydown. Returns true if the event was consumed (the caller should
 * `preventDefault`). Pure and framework-free so it can be unit-tested by
 * feeding synthetic events.
 */
export function handleKeydown(e: KeyboardEvent, h: HotkeyHandlers): boolean {
  // Command palette: Cmd+K or Ctrl+K.
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'k' || e.key === 'K')) {
    h.onPaletteToggle();
    return true;
  }

  if (hasMod(e)) {
    // Workspace switching: Mod+1..9, and Mod+0 / Mod+` for the fleet home.
    if (!e.shiftKey && /^[0-9]$/.test(e.key)) {
      if (e.key === '0') h.onFleet();
      else h.onWorkspaceSlot(Number(e.key) - 1);
      return true;
    }
    if (!e.shiftKey && (e.key === '`' || e.key === '~')) {
      h.onFleet();
      return true;
    }

    // Split / close.
    if (e.key === 'Enter') {
      if (e.shiftKey) h.onSplitDown();
      else h.onSplitRight();
      return true;
    }
    if (!e.shiftKey && (e.key === 'w' || e.key === 'W')) {
      h.onClosePane();
      return true;
    }

    // Directional focus (hjkl + arrows).
    const dir = FOCUS_KEYS[e.key];
    if (dir !== undefined && !e.shiftKey) {
      h.onFocusMove(dir);
      return true;
    }
  }

  return false;
}

/** Install the global keydown listener; returns a disposer. */
export function installHotkeys(h: HotkeyHandlers, target: Window = window): () => void {
  const listener = (e: KeyboardEvent): void => {
    if (handleKeydown(e, h)) {
      e.preventDefault();
      e.stopPropagation();
    }
  };
  target.addEventListener('keydown', listener, { capture: true });
  return () => target.removeEventListener('keydown', listener, { capture: true } as EventListenerOptions);
}
