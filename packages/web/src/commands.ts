// The application command registry (spec 8.1). Every feature registers its
// commands here; the command palette (Cmd+K) is a pure view over this registry.
// A single shared instance is created at module load so hotkeys, the palette,
// and feature modules all see the same command set.

import { CommandRegistry, type Command } from './palette/registry';
import { useUiStore } from './store/ui';

/** The one shared registry for the running app. */
export const registry = new CommandRegistry();

/** Build the always-available core commands from the UI store's actions. */
export function coreCommands(): Command[] {
  const s = useUiStore.getState;
  return [
    // ---- Window / layout ----
    {
      id: 'wm.split.right',
      title: 'Split pane right',
      group: 'Window',
      hint: '⌥⏎',
      run: () => s().splitFocused('row', { kind: 'files', path: '/' }),
    },
    {
      id: 'wm.split.down',
      title: 'Split pane down',
      group: 'Window',
      hint: '⌥⇧⏎',
      run: () => s().splitFocused('column', { kind: 'files', path: '/' }),
    },
    { id: 'wm.close', title: 'Close pane', group: 'Window', hint: '⌥W', run: () => s().closeFocused() },
    { id: 'wm.focus.left', title: 'Focus pane left', group: 'Window', hint: '⌥H', run: () => s().moveFocus('left') },
    { id: 'wm.focus.down', title: 'Focus pane down', group: 'Window', hint: '⌥J', run: () => s().moveFocus('down') },
    { id: 'wm.focus.up', title: 'Focus pane up', group: 'Window', hint: '⌥K', run: () => s().moveFocus('up') },
    { id: 'wm.focus.right', title: 'Focus pane right', group: 'Window', hint: '⌥L', run: () => s().moveFocus('right') },
    { id: 'nav.fleet', title: 'Go to fleet home', group: 'Navigation', hint: '⌥0', run: () => s().goFleet() },

    // ---- New panes ----
    {
      id: 'pane.new.terminal',
      title: 'New terminal pane',
      group: 'Pane',
      keywords: ['shell', 'console'],
      run: () => s().addPane({ kind: 'terminal', run: 'shell' }),
    },
    {
      id: 'pane.new.files',
      title: 'New files pane',
      group: 'Pane',
      keywords: ['browser', 'directory'],
      run: () => s().addPane({ kind: 'files', path: '/' }),
    },
    {
      id: 'pane.new.editor',
      title: 'New editor pane',
      group: 'Pane',
      keywords: ['codemirror', 'brief'],
      run: () => s().addPane({ kind: 'editor', path: '/README.md' }),
    },
    {
      id: 'pane.new.preview',
      title: 'New browser preview pane',
      group: 'Pane',
      keywords: ['iframe', 'port', 'web'],
      run: () => s().addPane({ kind: 'preview', port: 3000 }),
    },
  ];
}

/** Register the core commands. Returns a disposer. */
export function registerCoreCommands(): () => void {
  return registry.registerAll(coreCommands());
}
