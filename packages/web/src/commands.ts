// The application command registry (spec 8.1). Every feature registers its
// commands here; the command palette (Cmd+K) is a pure view over this registry.
// A single shared instance is created at module load so hotkeys, the palette,
// and feature modules all see the same command set.
//
// Spec 8.1 requires FULL keyboard operation, which is read strictly here: every
// action the interface offers with a pointer — starting a run, stopping it,
// reviewing its changes, keeping or reverting them, snapshotting, uploading,
// opening a waiting run — is also a command in this registry, so it is
// reachable from Cmd+K with no mouse.

import { CommandRegistry, type Command } from './palette/registry';
import { useUiStore } from './store/ui';
import { useEventsStore } from './store/events';
import { activeEditor, activeFiles } from './store/pane-actions';
import { allAttention, attentionFor } from './events/reducer';
import { snapshotComputer, stopRun } from './api/client';
import { openShellTerminal } from './runs/shell';

/** The one shared registry for the running app. */
export const registry = new CommandRegistry();

/** Build the always-available core commands from the UI store's actions. */
export function coreCommands(): Command[] {
  const s = useUiStore.getState;
  const events = () => useEventsStore.getState().model;
  const active = (): string | null => s().activeComputer;

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
      hint: '⌥R',
      keywords: ['shell', 'console', 'run', 'command', 'start', 'exec', 'agent'],
      // A terminal pane is a view of a RUN (spec 7.1), so this starts one: an
      // interactive shell. Anything the user wants to run — a build, an agent —
      // is typed into the shell, not into a prompt about the shell.
      run: async () => {
        await openShellTerminal();
      },
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
    {
      id: 'pane.new.browser',
      title: 'Open computer browser',
      group: 'Pane',
      keywords: ['chromium', 'novnc', 'visual', 'website'],
      run: () => s().addPane({ kind: 'browser', port: 6080 }),
    },
    {
      id: 'pane.new.runs',
      title: 'Show runs',
      group: 'Pane',
      keywords: ['run', 'list', 'jobs', 'tasks'],
      run: () => s().addPane({ kind: 'runs' }),
    },
    {
      id: 'pane.new.vault',
      title: 'Open credential vault',
      group: 'Pane',
      keywords: ['secret', 'api key', 'credentials', 'anthropic', 'openai'],
      run: () => s().addPane({ kind: 'vault' }),
    },

    // ---- Runs (spec 5) ----
    {
      id: 'run.brief',
      title: 'Run brief',
      group: 'Run',
      keywords: ['document', 'editor', 'task', 'agent'],
      // The document lives in an editor pane, which publishes its actions (see
      // store/editor-actions). With no editor open, open one — the command
      // stays in the registry either way, so the palette never loses it.
      run: async () => {
        const editor = activeEditor();
        if (editor === null) {
          s().addPane({ kind: 'editor', path: '/README.md' });
          return;
        }
        await editor.runBrief();
      },
    },
    {
      id: 'editor.save',
      title: 'Save file',
      group: 'Editor',
      hint: '⌘S',
      keywords: ['write', 'put'],
      run: async () => {
        await activeEditor()?.save();
      },
    },
    {
      id: 'run.stop',
      title: 'Stop run',
      group: 'Run',
      keywords: ['kill', 'cancel'],
      run: async () => {
        const computer = active();
        const pane = s().focusedPane();
        if (computer === null || pane === null || pane.pane.kind !== 'terminal') {
          s().setNotice('Focus a terminal pane to stop its run.');
          return;
        }
        const runId = pane.pane.run;
        try {
          const res = await stopRun(computer, runId);
          s().setNotice(`Run ${runId} · ${res.state}`);
        } catch {
          s().setNotice(`Could not stop run ${runId}`);
        }
      },
    },
    {
      id: 'run.review',
      title: 'Review run changes',
      group: 'Run',
      keywords: ['diff', 'result', 'keep', 'revert'],
      run: () => {
        const computer = active();
        const pane = s().focusedPane();
        if (computer === null) return;
        if (pane !== null && pane.pane.kind === 'terminal') {
          s().openRunDiff(computer, pane.pane.run);
          return;
        }
        s().addPane({ kind: 'runs' });
      },
    },
    {
      id: 'computer.snapshot',
      title: 'Snapshot now',
      group: 'Computer',
      keywords: ['manifest', 'save', 'checkpoint'],
      run: async () => {
        const computer = active();
        if (computer === null) {
          s().setNotice('Open a computer to snapshot it.');
          return;
        }
        try {
          const res = await snapshotComputer(computer);
          // Spec 4.3: the manifest is written by the supervisor; report the id
          // it produced, or that the request is in flight on a sleeping box.
          s().setNotice(res.manifest === null ? `Snapshot requested · ${res.state}` : `Snapshot ${res.manifest}`);
        } catch {
          s().setNotice('Snapshot failed');
        }
      },
    },

    // ---- Files (spec 8.5) ----
    {
      id: 'files.upload',
      title: 'Upload file here',
      group: 'Files',
      keywords: ['put', 'add', 'attach', 'send'],
      run: () => {
        const files = activeFiles();
        if (files === null) {
          s().addPane({ kind: 'files', path: '/' });
          return;
        }
        files.upload();
      },
    },
    {
      id: 'files.up',
      title: 'Go to parent directory',
      group: 'Files',
      keywords: ['parent', 'back', 'up'],
      run: () => activeFiles()?.up(),
    },

    // ---- Attention (spec 6.2) ----
    {
      id: 'attention.open',
      title: 'Open waiting run',
      group: 'Attention',
      keywords: ['attention', 'waiting', 'prompt', 'blocked'],
      run: () => {
        const model = events();
        const computer = active();
        // Prefer this workspace's oldest waiting run; otherwise the fleet's.
        const here = computer === null ? [] : attentionFor(model, computer);
        const target = here[0] ?? allAttention(model)[0];
        if (target === undefined) return;
        s().openRunTerminal(target.computer, target.runId);
      },
    },
  ];
}

/** Register the core commands. Returns a disposer. */
export function registerCoreCommands(): () => void {
  return registry.registerAll(coreCommands());
}
