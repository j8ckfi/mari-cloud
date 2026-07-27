import { useEffect, useRef, useState } from 'react';
import { useUiStore, defaultLayout } from '../store/ui';
import { useIncidents, useLayout, useLimits, useUsage, useFleet } from '../api/queries';
import { saveLayout } from '../api/client';
import { openShellTerminal } from '../runs/shell';
import { serializeLayout, deserializeLayout } from '../wm/serialize';
import { TileView } from './TileView';
import { useEventsStore } from '../store/events';
import { liveState } from '../events/reducer';
import { incidentCopy, useIncidentUiStore, visibleIncidents } from '../lifecycle/incidents';
import { useWakeStore, wakeErrorCopy } from '../lifecycle/wake';
import { formatCost } from './ComputerCard';

/**
 * One computer's workspace (spec 8.1: each computer is one workspace). It
 * restores the saved pane layout from the Durable Object (spec 8.6) on first
 * open, renders the tiling tree, and persists layout changes back to the DO
 * (debounced). It never blocks on the layout load — until it resolves, the
 * store's default layout is shown (spec 8.3).
 */
export function Workspace({ computer }: { computer: string }) {
  const layout = useUiStore((s) => s.layouts[computer]) ?? defaultLayout();
  const setLayout = useUiStore((s) => s.setLayout);
  const addPane = useUiStore((s) => s.addPane);
  const splitFocused = useUiStore((s) => s.splitFocused);

  const layoutQ = useLayout(computer);
  const hydrated = useRef(false);
  const initialLayout = useRef(JSON.stringify(serializeLayout(layout)));
  const lastSaved = useRef<string | null>(null);
  const latestLayout = useRef(JSON.stringify(serializeLayout(layout)));
  const saveTimer = useRef<number | null>(null);
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const mounted = useRef(true);
  const [syncState, setSyncState] = useState<'loading' | 'saved' | 'saving' | 'error'>('loading');

  latestLayout.current = JSON.stringify(serializeLayout(layout));

  const enqueueSave = (serialized: string): Promise<void> => {
    if (serialized === lastSaved.current) return saveChain.current;
    if (mounted.current) setSyncState('saving');
    saveChain.current = saveChain.current
      .catch(() => undefined)
      .then(async () => {
        await saveLayout(computer, JSON.parse(serialized) as ReturnType<typeof serializeLayout>);
        lastSaved.current = serialized;
        if (mounted.current) setSyncState('saved');
      })
      .catch(() => {
        if (mounted.current) setSyncState('error');
      });
    return saveChain.current;
  };

  // Restore only after an authoritative successful read. `isFetched` also means
  // "failed", and treating that as hydrated used to PUT the default layout over
  // a saved remote layout after a transient GET error.
  useEffect(() => {
    if (!layoutQ.isSuccess || hydrated.current) return;
    const current = JSON.stringify(serializeLayout(layout));
    const restored = layoutQ.data ? deserializeLayout(layoutQ.data.layout) : null;
    const remote = restored && restored.root ? JSON.stringify(serializeLayout(restored)) : current;
    hydrated.current = true;
    lastSaved.current = remote;
    // Local pane actions made while the GET was in flight win; they are saved
    // after hydration rather than being silently replaced by the late response.
    if (current === initialLayout.current && restored && restored.root) {
      setLayout(computer, restored);
    }
    setSyncState('saved');
  }, [layoutQ.isSuccess, layoutQ.data, computer, layout, setLayout]);

  // Persist layout changes (debounced) once hydration succeeded, so we
  // never clobber the stored layout with the pre-load default.
  useEffect(() => {
    if (!hydrated.current) return;
    const serialized = latestLayout.current;
    if (serialized === lastSaved.current) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void enqueueSave(serialized);
    }, 400);
    return () => {
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    };
    // enqueueSave deliberately reads refs; adding it would recreate the timer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, computer]);

  // Navigation/unmount must not cancel the last layout change. Flush the latest
  // snapshot into the ordered save chain.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
      if (hydrated.current && latestLayout.current !== lastSaved.current) {
        void enqueueSave(latestLayout.current);
      }
    };
    // One Workspace is keyed by computer in Shell, so this is per-computer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app" style={{ height: '100%' }} data-testid="workspace" data-computer={computer}>
      <div className="topbar" style={{ height: 30 }}>
        <span className="hint">panes:</span>
        {/* A terminal pane is a view of a RUN (spec 7.1), so this starts one:
            an interactive shell. Commands are typed into the shell — there is
            no separate "run command" prompt. */}
        <button
          type="button"
          data-testid="add-terminal-pane"
          onClick={() => void openShellTerminal()}
        >
          + Terminal <kbd>⌥R</kbd>
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
        <button
          type="button"
          onClick={() => addPane({ kind: 'browser', port: 6080 })}
          data-testid="add-computer-browser-pane"
        >
          + Browser
        </button>
        <button type="button" onClick={() => addPane({ kind: 'runs' })} data-testid="add-runs-pane">
          + Runs
        </button>
        <button type="button" onClick={() => addPane({ kind: 'vault' })} data-testid="add-vault-pane">
          + Vault
        </button>
        <span className="spacer" style={{ flex: 1 }} />
        <span className={`sync-state ${syncState}`} data-testid="layout-sync-state">
          {layoutQ.isError
            ? 'Layout not synced'
            : syncState === 'saving'
              ? 'Saving layout'
              : syncState === 'error'
                ? 'Layout not synced'
                : syncState === 'saved'
                  ? 'Layout saved'
                  : 'Reading layout'}
        </span>
        {(layoutQ.isError || syncState === 'error') && (
          <button
            type="button"
            data-testid="layout-sync-retry"
            onClick={() => {
              if (layoutQ.isError) void layoutQ.refetch();
              else void enqueueSave(latestLayout.current);
            }}
          >
            Retry
          </button>
        )}
        <span className="hint">
          <kbd>⌥⏎</kbd> split · <kbd>⌥hjkl</kbd> focus · <kbd>⌥W</kbd> close
        </span>
      </div>
      <WorkspaceHealth computer={computer} />
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
            <TileView node={layout.root} computer={computer} focusedId={layout.focused} />
          </div>
        )}
      </div>
    </div>
  );
}

/** Durable lifecycle/incident/usage facts, visible without blocking the panes. */
function WorkspaceHealth({ computer }: { computer: string }) {
  const model = useEventsStore((s) => s.model);
  const connected = useEventsStore((s) => s.connected);
  const fleet = useFleet();
  const polled = fleet.data?.computers.find((c) => c.id === computer)?.state ?? null;
  const state = liveState(model, computer) ?? polled;
  const incidentsQ = useIncidents(computer);
  const usageQ = useUsage(computer);
  const limitsQ = useLimits();
  const dismissed = useIncidentUiStore((s) => s.dismissed);
  const dismiss = useIncidentUiStore((s) => s.dismiss);
  const wakeNotice = useWakeStore((s) => s.notices[computer] ?? null);
  const requestWake = useWakeStore((s) => s.requestWake);
  const incidents = visibleIncidents(computer, incidentsQ.data?.incidents ?? [], dismissed);
  const wakeCopy = wakeNotice === null ? null : wakeErrorCopy(wakeNotice.error);
  const usage = usageQ.data;
  const limits = limitsQ.data;

  return (
    <>
      <div className="workspace-health" data-testid="workspace-health">
        <span className={`state ${state ?? 'unknown'}`}>{state ?? 'unknown'}</span>
        {!connected && <span className="sync-state error">Live updates reconnecting</span>}
        {(state === 'cold' || state === 'warm' || wakeNotice !== null) && (
          <button type="button" data-testid="wake-computer" onClick={() => void requestWake(computer)}>
            {wakeNotice?.phase === 'retrying' ? 'Retrying wake' : 'Wake computer'}
          </button>
        )}
        {usage !== null && usage !== undefined && (
          <span className="hint" data-testid="usage-meter">
            {formatCost(usage.estimatedUsd, 'USD')} estimated ·{' '}
            {(usage.awakeMs / 3_600_000).toFixed(2)} active h
            {usage.boxMs > 0 ? ` · ${(usage.boxMs / 3_600_000).toFixed(2)} Box h` : ''}
          </span>
        )}
        {limits !== null && limits !== undefined && (
          <span className="hint" data-testid="limits-meter">
            {limits.computeSecondsCap === null
              ? `${(limits.computeSecondsUsed / 3600).toFixed(1)} h · unlimited compute`
              : `${(limits.computeSecondsUsed / 3600).toFixed(1)} / ${(limits.computeSecondsCap / 3600).toFixed(1)} compute h`}
            {' · '}
            {limits.maxComputers === null
              ? `${limits.computers} computers`
              : `${limits.computers} / ${limits.maxComputers} computers`}
          </span>
        )}
      </div>
      {wakeCopy !== null && (
        <div className={`lifecycle-notice ${wakeNotice?.phase ?? ''}`} role="alert">
          <strong>{wakeCopy.title}</strong>
          <span>{wakeCopy.body}</span>
          <button type="button" onClick={() => void requestWake(computer)}>
            Try again
          </button>
        </div>
      )}
      {incidents.map((incident) => {
        const copy = incidentCopy(incident.kind);
        return (
          <div className="lifecycle-notice incident" key={incident.id} role="status">
            <strong>{copy.title}</strong>
            <span>{copy.body} {copy.action}</span>
            <button type="button" onClick={() => dismiss(computer, incident)}>
              Dismiss
            </button>
          </div>
        );
      })}
    </>
  );
}
