import { useEffect, useRef } from 'react';
import { useUiStore, defaultLayout } from '../store/ui';
import { useLayout } from '../api/queries';
import { saveLayout } from '../api/client';
import { serializeLayout, deserializeLayout } from '../wm/serialize';
import { TileView } from './TileView';

/**
 * One computer's workspace (spec 8.1: each computer is one workspace). It
 * restores the saved pane layout from the Durable Object (spec 8.6) on first
 * open, renders the tiling tree, and persists layout changes back to the DO
 * (debounced). It never blocks on the layout load — until it resolves, the
 * store's default layout is shown (spec 8.3).
 */
export function Workspace({ computer, user }: { computer: string; user: string }) {
  const layout = useUiStore((s) => s.layouts[computer]) ?? defaultLayout();
  const setLayout = useUiStore((s) => s.setLayout);
  const addPane = useUiStore((s) => s.addPane);
  const splitFocused = useUiStore((s) => s.splitFocused);
  const setRunLauncherOpen = useUiStore((s) => s.setRunLauncherOpen);

  const layoutQ = useLayout(computer);
  const hydrated = useRef<Set<string>>(new Set());
  const saveTimer = useRef<number | null>(null);

  // Restore the saved layout once per computer, when it arrives.
  useEffect(() => {
    if (!layoutQ.isFetched || hydrated.current.has(computer)) return;
    hydrated.current.add(computer);
    const restored = layoutQ.data ? deserializeLayout(layoutQ.data.layout) : null;
    if (restored && restored.root) setLayout(computer, restored);
  }, [layoutQ.isFetched, layoutQ.data, computer, setLayout]);

  // Persist layout changes (debounced) once hydration has been attempted, so we
  // never clobber the stored layout with the pre-load default.
  useEffect(() => {
    if (!hydrated.current.has(computer)) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void saveLayout(computer, serializeLayout(layout)).catch(() => {
        /* transient; the next change retries */
      });
    }, 400);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
  }, [layout, computer]);

  return (
    <div className="app" style={{ height: '100%' }} data-testid="workspace" data-computer={computer}>
      <div className="topbar" style={{ height: 30 }}>
        <span className="hint">panes:</span>
        <button type="button" onClick={() => addPane({ kind: 'terminal', run: 'shell' })}>
          + Terminal
        </button>
        <button type="button" onClick={() => addPane({ kind: 'files', path: '/' })}>
          + Files
        </button>
        <button type="button" onClick={() => addPane({ kind: 'editor', path: '/README.md' })}>
          + Editor
        </button>
        <button type="button" onClick={() => addPane({ kind: 'preview', port: 3000 })}>
          + Preview
        </button>
        <button type="button" onClick={() => addPane({ kind: 'runs' })} data-testid="add-runs-pane">
          + Runs
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <button
          type="button"
          data-testid="workspace-run-command"
          onClick={() => setRunLauncherOpen(true)}
        >
          Run command <kbd>⌥R</kbd>
        </button>
        <span className="hint">
          <kbd>⌥⏎</kbd> split · <kbd>⌥hjkl</kbd> focus · <kbd>⌥W</kbd> close
        </span>
      </div>
      <div className="main" style={{ padding: 6 }}>
        {layout.root === null ? (
          <div className="empty-note" data-testid="workspace-empty">
            No panes. Add one above, or press <kbd>⌘K</kbd>.
            <div style={{ marginTop: 8 }}>
              <button type="button" onClick={() => splitFocused('row', { kind: 'files', path: '/' })}>
                Open file browser
              </button>
            </div>
          </div>
        ) : (
          <div style={{ position: 'absolute', inset: 6, display: 'flex' }}>
            <TileView node={layout.root} computer={computer} user={user} focusedId={layout.focused} />
          </div>
        )}
      </div>
    </div>
  );
}
