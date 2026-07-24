import { useEffect } from 'react';
import { useUiStore } from '../store/ui';
import { useFleet } from '../api/queries';
import { useEventsStore } from '../store/events';
import { allAttention, attentionFor, badgeCount } from '../events/reducer';
import { FleetHome } from './FleetHome';
import { Workspace } from './Workspace';
import { CommandPalette } from './CommandPalette';
import { RunLauncher } from './RunLauncher';
import type { CommandRegistry } from '../palette/registry';

/** Current user handle for preview hostnames; the control plane sets the real
 *  one, this is the dev/default fallback (must be a valid DNS label field). */
const USER = (import.meta.env.VITE_USER as string | undefined) ?? 'user';

/**
 * The app shell: a top bar with the fleet button and one tab per workspace
 * (Super/Alt+1..9), the main view (fleet home or the active workspace), the
 * command palette overlay, and the run launcher. Workspaces are populated from
 * the fleet, and each computer is registered as a palette command so the
 * palette exposes EVERY command (spec 8.1).
 *
 * Attention (spec 6.2) surfaces here: the live event stream badges the fleet
 * card and the workspace tab, and activating a badge opens the terminal pane of
 * the run that is waiting. The events are content-free and so is this: a badge
 * is a count and a run id, never a message.
 */
export function Shell({ registry }: { registry: CommandRegistry }) {
  const view = useUiStore((s) => s.view);
  const workspaces = useUiStore((s) => s.workspaces);
  const active = useUiStore((s) => s.activeComputer);
  const openComputer = useUiStore((s) => s.openComputer);
  const goFleet = useUiStore((s) => s.goFleet);
  const setWorkspaces = useUiStore((s) => s.setWorkspaces);
  const paletteOpen = useUiStore((s) => s.paletteOpen);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
  const runLauncherOpen = useUiStore((s) => s.runLauncherOpen);
  const setRunLauncherOpen = useUiStore((s) => s.setRunLauncherOpen);
  const openRunTerminal = useUiStore((s) => s.openRunTerminal);
  const addPane = useUiStore((s) => s.addPane);
  const notice = useUiStore((s) => s.notice);

  const fleet = useFleet();
  const events = useEventsStore((s) => s.model);
  const computers = fleet.data?.computers ?? [];
  const idsKey = computers.map((c) => c.id).join(',');
  const namesKey = computers.map((c) => `${c.id}:${c.hostname}`).join('|');

  // Map fleet order onto workspace slots (Super/Alt+1..9).
  useEffect(() => {
    if (computers.length > 0) setWorkspaces(computers.map((c) => c.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [idsKey, setWorkspaces]);

  // Register each computer as a "Switch to …" palette command.
  useEffect(() => {
    const cmds = computers.map((c, i) => ({
      id: `ws.open.${c.id}`,
      title: `Switch to ${c.hostname}`,
      group: 'Workspace',
      keywords: [c.id, c.state],
      hint: i < 9 ? `⌥${i + 1}` : undefined,
      run: () => openComputer(c.id),
    }));
    return registry.registerAll(cmds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [namesKey, registry]);

  const nameOf = (id: string): string => computers.find((c) => c.id === id)?.hostname ?? id;

  /**
   * Spec 6.2: "The notification opens the terminal pane of the run." Take the
   * oldest waiting run of that computer and open its terminal, focused. With no
   * live attention on record (a badge from the polled fleet count, e.g. after a
   * reload) fall back to the runs list, which is where the waiting run is.
   */
  const activateAttention = (computerId: string): void => {
    const waiting = attentionFor(events, computerId);
    const first = waiting[0];
    if (first !== undefined) {
      openRunTerminal(first.computer, first.runId);
      return;
    }
    openComputer(computerId);
    addPane({ kind: 'runs' });
  };

  const attentionCountFor = (id: string): number => {
    const server = computers.find((c) => c.id === id)?.attention ?? 0;
    return badgeCount(server, attentionFor(events, id).length);
  };

  const totalAttention = allAttention(events).length;

  return (
    <div className="app">
      <div className="topbar">
        <span className="brand">MARI</span>
        <button
          type="button"
          className={`ws-tab ${view === 'fleet' ? 'active' : ''}`}
          data-testid="fleet-tab"
          onClick={goFleet}
        >
          <span className="slot">⌥0</span> Fleet
          {totalAttention > 0 && (
            <span className="attn-dot" data-testid="fleet-attention-dot" aria-label="attention waiting" />
          )}
        </button>
        <div className="ws-tabs">
          {workspaces.map((id, i) => {
            const attention = attentionCountFor(id);
            return (
              <button
                type="button"
                key={id}
                className={`ws-tab ${view === 'workspace' && active === id ? 'active' : ''}`}
                data-testid="workspace-tab"
                data-computer-id={id}
                data-attention={attention}
                onClick={() => openComputer(id)}
              >
                <span className="slot">⌥{i + 1}</span>
                {nameOf(id)}
                {attention > 0 && (
                  <span
                    className="attn-badge sm"
                    data-testid="workspace-attention-badge"
                    title="This computer is waiting for you"
                  >
                    {attention}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <span className="spacer" />
        {/* Plain-text outcome of the last palette command (never a spinner). */}
        <span className="hint" data-testid="notice">
          {notice}
        </span>
        <button type="button" onClick={() => setPaletteOpen(true)} data-testid="open-palette">
          <kbd>⌘K</kbd> Commands
        </button>
      </div>

      <div className="main">
        {view === 'fleet' || active === null ? (
          <FleetHome computers={computers} onOpen={openComputer} onAttention={activateAttention} />
        ) : (
          <Workspace computer={active} user={USER} />
        )}
      </div>

      <CommandPalette registry={registry} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <RunLauncher
        computer={active}
        open={runLauncherOpen}
        onClose={() => setRunLauncherOpen(false)}
      />
    </div>
  );
}
