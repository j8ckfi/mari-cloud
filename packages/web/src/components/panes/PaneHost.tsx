import { paneLabel, type PaneSpec } from '../../wm/pane';
import { useUiStore } from '../../store/ui';
import { TerminalPane } from './TerminalPane';
import { FilesPane } from './FilesPane';
import { EditorPane } from './EditorPane';
import { BrowserPreviewPane } from './BrowserPreviewPane';
import { RunsPane } from './RunsPane';
import { DiffPane } from './DiffPane';

/** Renders one leaf pane: a header plus the type-specific body. */
export function PaneHost({
  paneId,
  pane,
  computer,
  focused,
}: {
  paneId: string;
  pane: PaneSpec;
  computer: string;
  /**
   * INERT. The preview pane used to compose its own hostname from this label,
   * which the shell filled in from `VITE_USER ?? 'user'` — a build-time guess
   * that was wrong on every deployment. The per-user host label is derived from
   * the OWNER's account by the control plane and now arrives with the preview
   * URL itself (`GET /api/computers/:id/preview`), so nothing reads this. It is
   * still accepted so the layout's prop chain keeps compiling; whoever next
   * touches `Shell.tsx` should delete the chain.
   */
  user?: string;
  focused: boolean;
}) {
  const focusPane = useUiStore((s) => s.focusPane);
  const closeFocused = useUiStore((s) => s.closeFocused);

  return (
    <div
      className={`pane ${focused ? 'focused' : ''}`}
      data-testid="pane"
      data-pane-id={paneId}
      data-kind={pane.kind}
      data-focused={focused}
      onMouseDownCapture={() => {
        if (!focused) focusPane(paneId);
      }}
    >
      <div className="pane-head">
        <span className="kind">{pane.kind}</span>
        <span className="title">{paneLabel(pane)}</span>
        <button
          type="button"
          title="Close pane"
          className="hint"
          onClick={() => {
            focusPane(paneId);
            closeFocused();
          }}
        >
          ✕
        </button>
      </div>
      <div className="pane-body">
        {pane.kind === 'terminal' && (
          <TerminalPane computer={computer} spec={pane} focused={focused} />
        )}
        {pane.kind === 'files' && <FilesPane computer={computer} spec={pane} />}
        {pane.kind === 'editor' && <EditorPane computer={computer} spec={pane} />}
        {pane.kind === 'preview' && <BrowserPreviewPane computer={computer} spec={pane} />}
        {pane.kind === 'runs' && <RunsPane computer={computer} />}
        {pane.kind === 'diff' && <DiffPane computer={computer} spec={pane} />}
      </div>
    </div>
  );
}
