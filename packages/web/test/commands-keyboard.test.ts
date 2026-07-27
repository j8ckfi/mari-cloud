import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleKeydown, type HotkeyHandlers } from '../src/hotkeys';
import { coreCommands } from '../src/commands';
import { CommandRegistry } from '../src/palette/registry';
import { serializeLayout, deserializeLayout } from '../src/wm/serialize';
import { singlePane, splitPane } from '../src/wm/tree';
import { paneLabel } from '../src/wm/pane';
import { useUiStore } from '../src/store/ui';
import {
  activeEditor,
  resetPaneActions,
  setActiveEditor,
  setActiveFiles,
} from '../src/store/pane-actions';

function handlers(): HotkeyHandlers & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    onWorkspaceSlot: (i) => calls.push(`slot:${i}`),
    onPaletteToggle: () => calls.push('palette'),
    onFocusMove: (d) => calls.push(`focus:${d}`),
    onSplitRight: () => calls.push('split:right'),
    onSplitDown: () => calls.push('split:down'),
    onClosePane: () => calls.push('close'),
    onFleet: () => calls.push('fleet'),
    onNewTerminal: () => calls.push('terminal'),
  };
}

function ev(o: Partial<KeyboardEvent>): KeyboardEvent {
  return { metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, key: '', ...o } as KeyboardEvent;
}

describe('terminal hotkey (spec 8.1 full keyboard operation)', () => {
  it('opens a new terminal on Mod+R under both Meta and Alt', () => {
    const h = handlers();
    expect(handleKeydown(ev({ altKey: true, key: 'r' }), h)).toBe(true);
    expect(handleKeydown(ev({ metaKey: true, key: 'R' }), h)).toBe(true);
    expect(h.calls).toEqual(['terminal', 'terminal']);
  });

  it('leaves plain "r" alone so it reaches the terminal', () => {
    const h = handlers();
    expect(handleKeydown(ev({ key: 'r' }), h)).toBe(false);
    expect(h.calls).toEqual([]);
  });

  it('does not consume Mod+R when no terminal handler is installed', () => {
    const h = handlers();
    const withoutTerminal: HotkeyHandlers = { ...h, onNewTerminal: undefined };
    expect(handleKeydown(ev({ altKey: true, key: 'r' }), withoutTerminal)).toBe(false);
  });

  it('does not swallow Mod+Shift+R (browser hard reload)', () => {
    const h = handlers();
    expect(handleKeydown(ev({ metaKey: true, shiftKey: true, key: 'R' }), h)).toBe(false);
  });
});

describe('command registry coverage (spec 8.1: the palette gives ALL commands)', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    registry = new CommandRegistry();
    registry.registerAll(coreCommands());
  });

  it('registers a command for every run/attention/computer action', () => {
    // Every pointer-reachable action of the run surface must also be here, or
    // the interface is not fully keyboard-operable.
    for (const id of [
      'pane.new.terminal',
      'run.stop',
      'run.review',
      'run.brief',
      'pane.new.runs',
      'computer.snapshot',
      'attention.open',
    ]) {
      expect(registry.get(id), id).toBeDefined();
    }
  });

  it('finds them by fuzzy query the way a user would type', () => {
    const hit = (q: string) => registry.filter(q).map((r) => r.command.id);
    // A user reaching for "run a command" must land on the terminal — the
    // command is typed into the shell, there is no separate prompt.
    expect(hit('terminal')).toContain('pane.new.terminal');
    expect(hit('shell')).toContain('pane.new.terminal');
    expect(hit('stop')).toContain('run.stop');
    expect(hit('revert')).toContain('run.review'); // keyword match
    expect(hit('snapshot')).toContain('computer.snapshot');
    expect(hit('waiting')).toContain('attention.open');
  });

  it('"New terminal pane" starts a shell run — no prompt in between', async () => {
    useUiStore.setState({ activeComputer: 'c1', layouts: {}, workspaces: ['c1'], view: 'workspace' });
    const bodies: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(init?.body as string);
        return new Response(JSON.stringify({ runId: 'sh-7', state: 'pending' }), {
          headers: { 'content-type': 'application/json' },
        });
      }),
    );
    await registry.get('pane.new.terminal')!.run();
    expect(bodies).toHaveLength(1);
    expect(JSON.parse(bodies[0]!)).toEqual({ argv: ['/bin/sh', '-i'] });
    vi.unstubAllGlobals();
  });

  it('a run command with no computer open says why instead of failing silently', async () => {
    useUiStore.setState({ activeComputer: null, layouts: {}, workspaces: [], notice: '' });

    await registry.get('run.stop')!.run();
    expect(useUiStore.getState().notice).toBe('Focus a terminal pane to stop its run.');

    await registry.get('computer.snapshot')!.run();
    expect(useUiStore.getState().notice).toBe('Open a computer to snapshot it.');

    // …and one with nothing to act on is a genuine no-op, not a crash.
    await registry.get('attention.open')!.run();
  });

  it('reports the outcome of a snapshot, success or failure', async () => {
    useUiStore.setState({ activeComputer: 'c1', notice: '' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ computer: 'c1', manifest: 'abc123', state: 'awake' }), {
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    await registry.get('computer.snapshot')!.run();
    expect(useUiStore.getState().notice).toBe('Snapshot abc123');

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 409 })));
    await registry.get('computer.snapshot')!.run();
    expect(useUiStore.getState().notice).toBe('Snapshot failed');
    vi.unstubAllGlobals();
  });
});

describe('pane-scoped commands survive their pane (spec 8.1)', () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    resetPaneActions();
    registry = new CommandRegistry();
    registry.registerAll(coreCommands());
    useUiStore.setState({ activeComputer: 'c1', layouts: {}, workspaces: ['c1'], view: 'workspace' });
  });

  it('delegates Run brief and Save to the open editor, and still exists after it closes', async () => {
    const ran: string[] = [];
    const dispose = setActiveEditor({
      path: '/brief.md',
      save: async () => void ran.push('save'),
      runBrief: async () => void ran.push('brief'),
    });

    await registry.get('run.brief')!.run();
    await registry.get('editor.save')!.run();
    expect(ran).toEqual(['brief', 'save']);

    dispose();
    // The regression this guards: a pane that REGISTERED these ids would take
    // them out of the palette on unmount, leaving the app less operable than
    // it started. They must still be here, and still safe to invoke.
    expect(registry.get('run.brief')).toBeDefined();
    expect(registry.get('editor.save')).toBeDefined();
    await registry.get('editor.save')!.run();
    await registry.get('run.brief')!.run();
    expect(ran).toEqual(['brief', 'save']); // nothing was re-run on a closed pane
  });

  it('a closing pane does not blank the actions of the pane that replaced it', async () => {
    const ran: string[] = [];
    const disposeFirst = setActiveEditor({
      path: '/a.md',
      save: async () => void ran.push('a'),
      runBrief: async () => {},
    });
    setActiveEditor({ path: '/b.md', save: async () => void ran.push('b'), runBrief: async () => {} });

    disposeFirst(); // the older pane closes second
    expect(activeEditor()?.path).toBe('/b.md');
    await registry.get('editor.save')!.run();
    expect(ran).toEqual(['b']);
  });

  it('delegates Upload to the open files pane', () => {
    const ran: string[] = [];
    setActiveFiles({ path: '/src', upload: () => ran.push('upload'), up: () => ran.push('up') });
    void registry.get('files.upload')!.run();
    void registry.get('files.up')!.run();
    expect(ran).toEqual(['upload', 'up']);
  });
});

describe('layout persistence of the new pane kinds (spec 8.6)', () => {
  it('round-trips runs and diff panes through serialization', () => {
    let layout = singlePane({ kind: 'runs' });
    layout = splitPane(layout, layout.focused as string, 'row', { kind: 'diff', run: 'r1' });
    const restored = deserializeLayout(serializeLayout(layout));
    expect(restored).not.toBeNull();
    expect(JSON.stringify(restored)).toBe(JSON.stringify(layout));
  });

  it('still rejects an unknown pane kind rather than rendering nothing', () => {
    const bad = { v: 1, root: { type: 'pane', id: 'p1', pane: { kind: 'hologram' } }, focused: 'p1' };
    expect(deserializeLayout(bad)).toBeNull();
  });

  it('labels the new panes', () => {
    expect(paneLabel({ kind: 'runs' })).toBe('Runs');
    expect(paneLabel({ kind: 'diff', run: 'r7' })).toBe('Changes · r7');
    expect(paneLabel({ kind: 'diff' })).toBe('Changes');
  });
});
