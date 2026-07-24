import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { keepRun, revertRun } from '../../api/client';
import { queryKeys, useRunDiff } from '../../api/queries';
import { DiffView } from '../DiffView';
import type { DiffPaneSpec } from '../../wm/pane';

/**
 * The result review (spec 5.3): "The result of a run shows as a difference
 * against the pre-run manifest. The user keeps the changes or restores the
 * manifest."
 *
 * Keep and Revert are the only two outcomes, and both are explicit. Nothing is
 * applied automatically (spec 9.2), and Revert asks for confirmation because it
 * destroys the run's work — the button turns into a confirm button rather than
 * opening a modal, so the whole flow stays on the keyboard.
 */
export function DiffPane({ computer, spec }: { computer: string; spec: DiffPaneSpec }) {
  const run = spec.run ?? null;
  const diff = useRunDiff(computer, run);
  const qc = useQueryClient();
  const [status, setStatus] = useState('');
  const [confirmRevert, setConfirmRevert] = useState(false);
  const [decided, setDecided] = useState<'kept' | 'reverted' | null>(null);

  const settle = async (): Promise<void> => {
    await Promise.all([
      qc.invalidateQueries({ queryKey: queryKeys.runs(computer) }),
      qc.invalidateQueries({ queryKey: queryKeys.fleet }),
      // A revert moves the manifest head, so EVERY open directory listing of
      // this computer is now stale — invalidate the whole `dir` prefix, not
      // just the root.
      qc.invalidateQueries({ queryKey: ['dir', computer] }),
    ]);
  };

  const onKeep = async (): Promise<void> => {
    if (run === null) return;
    setStatus('Keeping…');
    try {
      const res = await keepRun(computer, run);
      setDecided('kept');
      setStatus(`Kept · head ${res.head ?? 'unchanged'}`);
      await settle();
    } catch {
      setStatus('Keep failed');
    }
  };

  const onRevert = async (): Promise<void> => {
    if (run === null) return;
    if (!confirmRevert) {
      setConfirmRevert(true);
      return;
    }
    setConfirmRevert(false);
    setStatus('Reverting…');
    try {
      const res = await revertRun(computer, run);
      setDecided('reverted');
      setStatus(`Reverted to ${res.head ?? 'the pre-run manifest'}`);
      await settle();
    } catch {
      setStatus('Revert failed');
    }
  };

  if (run === null) {
    // A manifest-to-manifest (fork) diff pane: same view, no run decisions.
    return (
      <div className="diff-pane" data-testid="diff-pane" data-mode="manifest">
        <DiffView diff={null} emptyNote="Select two manifests to compare." />
      </div>
    );
  }

  return (
    <div className="diff-pane" data-testid="diff-pane" data-mode="run" data-run={run} data-decided={decided ?? ''}>
      <DiffView
        diff={diff.data}
        emptyNote={diff.isError ? 'Could not read this run’s changes.' : 'This run changed nothing.'}
        actions={
          <>
            <span className="hint" data-testid="diff-status">
              {status}
            </span>
            <button
              type="button"
              data-testid="diff-keep"
              disabled={decided !== null}
              onClick={() => void onKeep()}
              title="Keep this run’s changes (spec 5.3)"
            >
              Keep
            </button>
            <button
              type="button"
              data-testid="diff-revert"
              data-confirming={confirmRevert}
              disabled={decided !== null}
              onClick={() => void onRevert()}
              onBlur={() => setConfirmRevert(false)}
              title="Restore the pre-run manifest, discarding this run’s changes"
            >
              {confirmRevert ? 'Confirm revert' : 'Revert'}
            </button>
          </>
        }
      />
    </div>
  );
}
