import { useEffect, useRef, useState } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { basicSetup } from 'codemirror';
import { useQueryClient } from '@tanstack/react-query';
import { fetchFileText, writeFile, startRun } from '../../api/client';
import { queryKeys } from '../../api/queries';
import { briefArgv, dirnameOf } from '../../runs/command';
import { setActiveEditor } from '../../store/pane-actions';
import { useUiStore } from '../../store/ui';
import type { ComputerState } from '@mari/shared';
import type { EditorPaneSpec } from '../../wm/pane';

const darkTheme = EditorView.theme(
  {
    '&': { color: 'var(--fg)', backgroundColor: 'var(--bg-1)', height: '100%' },
    '.cm-content': { fontFamily: 'var(--mono)', caretColor: 'var(--accent)' },
    '.cm-gutters': { backgroundColor: 'var(--bg-1)', color: 'var(--fg-faint)', border: 'none' },
    '.cm-activeLine': { backgroundColor: 'var(--bg-2)' },
    '.cm-activeLineGutter': { backgroundColor: 'var(--bg-2)' },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
      backgroundColor: 'var(--accent-dim)',
    },
  },
  { dark: true },
);

/**
 * Editor pane (spec 8.5): CodeMirror 6 over markdown/config files. It is not an
 * IDE — no LSP.
 *
 * Save writes through the files API, which WAKES a computer that is not AWAKE
 * (spec 8.4). Spec 8.3 forbids waiting in front of the interface for that wake,
 * so Save does exactly this: it returns as soon as the write is accepted and
 * shows the computer's resulting STATE (`waking`, `awake`) as text. There is no
 * spinner and no blocked editor — the user keeps typing while the computer
 * comes up behind the interface.
 *
 * "Run brief" saves and then starts the document as a run (spec 8.5). The
 * document decides what runs (see runs/command): the user brings the agents.
 */
export function EditorPane({ computer, spec }: { computer: string; spec: EditorPaneSpec }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [computerState, setComputerState] = useState<ComputerState | null>(null);
  const openRunTerminal = useUiStore((s) => s.openRunTerminal);
  const qc = useQueryClient();

  const save = async (): Promise<boolean> => {
    const view = viewRef.current;
    if (!view) return false;
    setStatus('Saving…');
    try {
      const res = await writeFile(computer, spec.path, view.state.doc.toString());
      setDirty(false);
      setComputerState(res.state);
      // Spec 8.4: the write started a wake. Report the transition; never wait.
      setStatus(res.state === 'awake' ? 'Saved' : `Saved · ${res.state}`);
      void qc.invalidateQueries({ queryKey: queryKeys.fleet });
      void qc.invalidateQueries({ queryKey: queryKeys.dir(computer, dirnameOf(spec.path)) });
      return true;
    } catch {
      // Say what state the file is in, not just that something went wrong: the
      // document is still here, unsaved, and retrying is safe.
      setStatus('Save failed — nothing was written. Try again.');
      return false;
    }
  };

  const runBrief = async (): Promise<void> => {
    const view = viewRef.current;
    if (!view) return;
    const text = view.state.doc.toString();
    if (!(await save())) return;
    setStatus('Starting run…');
    try {
      const { runId, state } = await startRun(computer, {
        argv: briefArgv(spec.path, text),
        cwd: dirnameOf(spec.path),
      });
      setStatus(`Run ${runId} · ${state}`);
      openRunTerminal(computer, runId);
      void qc.invalidateQueries({ queryKey: queryKeys.runs(computer) });
    } catch {
      // The save above succeeded, so the brief is on the computer; only the run
      // did not start. Saying so keeps the user from re-saving to "fix" it.
      setStatus('Saved, but the run did not start. Press ⌥R to try again.');
    }
  };

  // Publish this editor's actions so the palette's stable "Save file" / "Run
  // brief" commands act on it (spec 8.1). The commands themselves are never
  // replaced or removed — see store/editor-actions for why that matters.
  useEffect(() => {
    return setActiveEditor({ path: spec.path, save, runBrief });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computer, spec.path]);

  // Build (and rebuild on path/computer change) the editor.
  useEffect(() => {
    let disposed = false;
    const el = host.current;
    if (!el) return;

    const build = (doc: string): void => {
      if (disposed) return;
      viewRef.current?.destroy();
      const state = EditorState.create({
        doc,
        extensions: [
          basicSetup,
          markdown(),
          darkTheme,
          EditorView.lineWrapping,
          Prec.high(
            keymap.of([
              {
                key: 'Mod-s',
                run: () => {
                  void save();
                  return true;
                },
              },
            ]),
          ),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(true);
          }),
        ],
      });
      viewRef.current = new EditorView({ state, parent: el });
    };

    setStatus('');
    fetchFileText(computer, spec.path)
      .then((text) => {
        build(text);
        setStatus('');
        setDirty(false);
      })
      .catch(() => {
        build(`# ${spec.path}\n\n`);
        setStatus('New file');
      });

    return () => {
      disposed = true;
      viewRef.current?.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computer, spec.path]);

  return (
    <div className="editor" data-testid="editor-pane">
      <div className="editor-bar">
        <span className="hint" data-testid="editor-path">
          {spec.path}
          {dirty && <span className="dirty-dot"> ●</span>}
        </span>
        <span className="spacer" style={{ flex: 1 }} />
        {computerState !== null && (
          <span className={`state ${computerState}`} data-testid="editor-state">
            {computerState}
          </span>
        )}
        <span className="hint" data-testid="editor-status">
          {status}
        </span>
        <button type="button" onClick={() => void save()} data-testid="editor-save">
          Save
        </button>
        <button
          type="button"
          onClick={() => void runBrief()}
          data-testid="editor-run-brief"
          title="Save this document and start it as a run"
        >
          Run brief
        </button>
      </div>
      <div className="editor-cm" ref={host} data-testid="editor-cm" />
    </div>
  );
}
