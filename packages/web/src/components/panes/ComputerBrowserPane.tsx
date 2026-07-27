import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ApiError, startRun } from '../../api/client';
import { queryKeys, useRuns } from '../../api/queries';
import type { ComputerBrowserPaneSpec } from '../../wm/pane';
import { BrowserPreviewPane } from './BrowserPreviewPane';

const NOVNC_PATH = '/vnc.html?autoconnect=1&resize=scale&reconnect=1&path=websockify';

/** Chromium computer mode. The browser is a durable run: it pins the computer
 * while open/running, and its encrypted profile is checkpointed by
 * `mari-browser` before the run exits or the computer sleeps. */
export function ComputerBrowserPane({
  computer,
  spec,
}: {
  computer: string;
  spec: ComputerBrowserPaneSpec;
}) {
  const runsQ = useRuns(computer);
  const queryClient = useQueryClient();
  const starting = useRef(false);
  const launchRequested = useRef(false);
  const hadActiveRun = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [serviceReady, setServiceReady] = useState(false);

  const active = useMemo(
    () =>
      runsQ.data?.runs.find(
        (run) =>
          run.argv[0] === 'mari-browser' &&
          run.argv[1] === '--port' &&
          run.argv[2] === String(spec.port) &&
          (run.state === 'pending' || run.state === 'running' || run.state === 'stopping'),
      ) ?? null,
    [runsQ.data, spec.port],
  );

  const launch = useCallback(async () => {
    if (starting.current || launchRequested.current) return;
    starting.current = true;
    launchRequested.current = true;
    setError(null);
    try {
      await startRun(computer, {
        argv: ['mari-browser', '--port', String(spec.port)],
        cwd: '/',
        envNames: [],
      });
      await queryClient.invalidateQueries({ queryKey: queryKeys.runs(computer) });
    } catch (err) {
      launchRequested.current = false;
      if (err instanceof ApiError && err.details['error'] === 'limit_compute') {
        setError('The monthly compute limit is reached. The browser was not started.');
      } else {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      starting.current = false;
    }
  }, [computer, queryClient, spec.port]);

  useEffect(() => {
    if (active !== null) {
      hadActiveRun.current = true;
      launchRequested.current = true;
    } else if (hadActiveRun.current) {
      // The browser run ended while this pane stayed open. Re-arm one clean
      // launch rather than accumulating duplicate starts during query refresh.
      hadActiveRun.current = false;
      launchRequested.current = false;
    }
  }, [active]);

  useEffect(() => {
    if (runsQ.isSuccess && active === null && error === null) void launch();
  }, [active, error, launch, runsQ.isSuccess]);

  useEffect(() => {
    setServiceReady(false);
    if (active?.state !== 'running') return;
    // `run_started` means the launcher exists; give Xvfb/Chromium/noVNC a short
    // bounded readiness window before the first iframe request.
    const timer = window.setTimeout(() => setServiceReady(true), 2_000);
    return () => window.clearTimeout(timer);
  }, [active?.id, active?.state]);

  if (runsQ.isError && active === null) {
    return (
      <div className="empty-note" role="alert" data-testid="computer-browser-runs-error">
        Could not inspect the computer's runs, so Mari did not start a duplicate browser.
        <button type="button" onClick={() => void runsQ.refetch()}>
          Retry
        </button>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="empty-note" role="alert" data-testid="computer-browser-error">
        Could not start Chromium: {error}
        <button
          type="button"
          onClick={() => {
            launchRequested.current = false;
            void launch();
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  if (active === null || active.state === 'pending' || !serviceReady) {
    return (
      <div className="empty-note" data-testid="computer-browser-starting">
        Starting Chromium inside this computer…
      </div>
    );
  }

  return (
    <BrowserPreviewPane
      computer={computer}
      spec={{ kind: 'preview', port: spec.port, title: 'Computer browser' }}
      path={NOVNC_PATH}
    />
  );
}
