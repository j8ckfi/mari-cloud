import { useEffect } from 'react';
import { useUiStore } from '../store/ui';
import { useFleet } from '../api/queries';
import { FleetHome } from './FleetHome';
import { Workspace } from './Workspace';
import { CommandPalette } from './CommandPalette';
import type { CommandRegistry } from '../palette/registry';

/** Current user handle for preview hostnames; the control plane sets the real
 *  one, this is the dev/default fallback (must be a valid DNS label field). */
const USER = (import.meta.env.VITE_USER as string | undefined) ?? 'user';

/**
 * The app shell: a top bar with the fleet button and one tab per workspace
 * (Super/Alt+1..9), the main view (fleet home or the active workspace), and the
 * command palette overlay. Workspaces are populated from the fleet, and each
 * computer is registered as a palette command so the palette exposes EVERY
 * command (spec 8.1).
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

  const fleet = useFleet();
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
        </button>
        <div className="ws-tabs">
          {workspaces.map((id, i) => (
            <button
              type="button"
              key={id}
              className={`ws-tab ${view === 'workspace' && active === id ? 'active' : ''}`}
              data-testid="workspace-tab"
              data-computer-id={id}
              onClick={() => openComputer(id)}
            >
              <span className="slot">⌥{i + 1}</span>
              {nameOf(id)}
            </button>
          ))}
        </div>
        <span className="spacer" />
        <button type="button" onClick={() => setPaletteOpen(true)} data-testid="open-palette">
          <kbd>⌘K</kbd> Commands
        </button>
      </div>

      <div className="main">
        {view === 'fleet' || active === null ? (
          <FleetHome computers={computers} onOpen={openComputer} />
        ) : (
          <Workspace computer={active} user={USER} />
        )}
      </div>

      <CommandPalette registry={registry} open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </div>
  );
}
