import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { startRun } from '../api/client';
import { queryKeys } from '../api/queries';
import { parseCommandLine } from '../runs/command';
import { useUiStore } from '../store/ui';

/**
 * The "Run command" prompt (spec 5, spec 8.1). One line in, one run out.
 *
 * It is deliberately not a shell: the line is split into `argv` (contracts §5.2
 * takes argv, not a command string) and handed to the supervisor, which owns
 * the run from then on (spec 5.1) — closing this dialog, this tab, or this
 * laptop does not stop it.
 *
 * On submit it opens the run's terminal pane immediately, before the supervisor
 * has confirmed anything: the interface must not wait for a computer (8.3).
 */
export function RunLauncher({
  computer,
  open,
  onClose,
}: {
  computer: string | null;
  open: boolean;
  onClose: () => void;
}) {
  const [line, setLine] = useState('');
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const openRunTerminal = useUiStore((s) => s.openRunTerminal);
  const qc = useQueryClient();

  // Focus on open. Deliberately does NOT clear `error`: the failure path below
  // re-opens this dialog to report that the run did not start, and clearing
  // here would wipe that message in the same render.
  useEffect(() => {
    if (open) queueMicrotask(() => inputRef.current?.focus());
  }, [open]);

  if (!open) return null;

  const submit = async (): Promise<void> => {
    if (computer === null) {
      setError('Open a computer first.');
      return;
    }
    const argv = parseCommandLine(line);
    if (argv.length === 0) {
      setError('Type a command.');
      return;
    }
    setError('');
    onClose();
    try {
      const res = await startRun(computer, { argv });
      setLine('');
      // Spec 8.3: open the run's view now; the supervisor confirms behind us.
      openRunTerminal(computer, res.runId);
      void qc.invalidateQueries({ queryKey: queryKeys.runs(computer) });
      void qc.invalidateQueries({ queryKey: queryKeys.fleet });
    } catch {
      // The run did not start. Re-open with the command still in the box, so
      // the user can fix and retry rather than retype.
      setError('Could not start the run.');
      useUiStore.getState().setRunLauncherOpen(true);
    }
  };

  return (
    <div
      className="palette-overlay"
      data-testid="run-launcher-overlay"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="palette" role="dialog" aria-label="Run command" data-testid="run-launcher">
        <input
          ref={inputRef}
          data-testid="run-launcher-input"
          placeholder="Command to run, e.g. npm test"
          value={line}
          aria-label="Command to run"
          onChange={(e) => {
            setLine(e.target.value);
            if (error !== '') setError('');
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onClose();
            } else if (e.key === 'Enter') {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <div className="palette-list">
          <div className="palette-empty" data-testid="run-launcher-hint">
            {error !== '' ? (
              <span className="attn-text">{error}</span>
            ) : (
              <>
                Runs on <b>{computer ?? 'no computer'}</b>. The supervisor owns the run — you can
                close this tab.
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
