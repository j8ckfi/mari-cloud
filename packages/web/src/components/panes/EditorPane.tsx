import { useEffect, useRef, useState } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Prec } from '@codemirror/state';
import { markdown } from '@codemirror/lang-markdown';
import { basicSetup } from 'codemirror';
import { fetchFileText, writeFile, startRun } from '../../api/client';
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
 * Editor pane (spec 8.5): CodeMirror 6 over markdown/config files. Save writes
 * through the files API (which WAKES a sleeping computer per spec 8.4). "Run
 * brief" saves then posts the document as a run (spec 8.5). It is not an IDE —
 * no LSP.
 */
export function EditorPane({ computer, spec }: { computer: string; spec: EditorPaneSpec }) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState<string>('');

  const save = async (): Promise<void> => {
    const view = viewRef.current;
    if (!view) return;
    setStatus('Saving…');
    try {
      await writeFile(computer, spec.path, view.state.doc.toString());
      setDirty(false);
      setStatus('Saved');
    } catch {
      setStatus('Save failed');
    }
  };

  const runBrief = async (): Promise<void> => {
    await save();
    setStatus('Starting run…');
    try {
      const { run } = await startRun(computer, { path: spec.path });
      setStatus(`Run ${run} started`);
    } catch {
      setStatus('Run failed');
    }
  };

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

    setStatus('Loading…');
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
        <span className="hint">{status}</span>
        <button type="button" onClick={() => void save()}>
          Save
        </button>
        <button type="button" onClick={() => void runBrief()} title="Post this document as a run">
          Run brief
        </button>
      </div>
      <div className="editor-cm" ref={host} data-testid="editor-cm" />
    </div>
  );
}
