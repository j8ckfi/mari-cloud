import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { AttachClient, attachUrl } from '../../ws/attach';
import { EchoPredictor } from '../../terminal/predictor';
import { stopRun } from '../../api/client';
import { useEventsStore } from '../../store/events';
import { liveRun } from '../../events/reducer';
import { runStateLabel } from '../../runs/state';
import { useUiStore } from '../../store/ui';
import type { GridSnapshot } from '@mari/shared';
import type { TerminalPaneSpec } from '../../wm/pane';

const enc = new TextEncoder();

/** Render a grid snapshot (spec 7.3) into xterm as a cleared-screen redraw. */
function writeGrid(term: Terminal, grid: GridSnapshot): void {
  term.write('\x1b[2J\x1b[H');
  const lines = grid.cells.map((row) => row.map((c) => (c.ch === '' ? ' ' : c.ch)).join(''));
  term.write(lines.join('\r\n'));
}

/**
 * Terminal pane (spec 7). A view of a run — never the owner of the process
 * (spec 7.1). It renders with xterm.js + the WebGL addon (spec 7.4), falling
 * back to xterm's built-in DOM renderer when WebGL is unavailable. It attaches
 * over the client<->DO protocol (grid snapshot, then live frames), forwards
 * input, and overlays local-echo predictions (spec 7.5) via {@link
 * EchoPredictor}, which are reconciled against the authoritative frames without
 * tearing (predictions live in a separate overlay strip, never written into the
 * authoritative buffer).
 */
export function TerminalPane({
  computer,
  spec,
  focused,
}: {
  computer: string;
  spec: TerminalPaneSpec;
  focused: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const [renderer, setRenderer] = useState<'webgl' | 'dom'>('dom');
  const [predict, setPredict] = useState<{ text: string; pending: number }>({ text: '', pending: 0 });
  const live = useEventsStore((s) => liveRun(s.model, computer, spec.run));
  const setRunLauncherOpen = useUiStore((s) => s.setRunLauncherOpen);
  const openRunDiff = useUiStore((s) => s.openRunDiff);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const term = new Terminal({
      convertEol: false,
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      theme: { background: '#0b0d10', foreground: '#d7dde5', cursor: '#5b9dff' },
      scrollback: 5000,
    });
    termRef.current = term;
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);

    // WebGL renderer with a DOM fallback (spec 7.4).
    try {
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
      setRenderer('webgl');
    } catch {
      setRenderer('dom'); // built-in DOM renderer
    }

    try {
      fit.fit();
    } catch {
      /* jsdom / zero-size: ignore */
    }

    const predictor = new EchoPredictor();
    const refreshPredict = (): void => {
      const pending = predictor.pendingCount;
      setPredict({ text: pending > 0 ? predictor.predictedText() : '', pending });
    };

    const client = new AttachClient({
      url: attachUrl(computer),
      run: spec.run,
      cols: term.cols,
      rows: term.rows,
      handlers: {
        onGrid: (m) => writeGrid(term, m.grid),
        onFrame: (m) => {
          term.write(m.bytes);
          predictor.reconcile(m.bytes);
          refreshPredict();
        },
        onStatus: (m) => {
          if (!m.alive) term.write(`\r\n\x1b[2m[run ${spec.run} exited${m.exitCode != null ? ` (${m.exitCode})` : ''}]\x1b[0m\r\n`);
        },
      },
    });
    client.connect();

    const dataSub = term.onData((data) => {
      const bytes = enc.encode(data);
      predictor.input(bytes);
      refreshPredict();
      client.input(bytes);
    });

    // Keep the PTY sized to the pane.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        client.resize(term.cols, term.rows);
      } catch {
        /* ignore */
      }
    });
    ro.observe(el);

    return () => {
      ro.disconnect();
      dataSub.dispose();
      client.close();
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [computer, spec.run]);

  // Focus the terminal when its pane gains WM focus.
  useEffect(() => {
    if (focused) termRef.current?.focus();
  }, [focused]);

  return (
    <div
      style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}
      data-testid="terminal-pane"
      data-renderer={renderer}
      data-run={spec.run}
    >
      {/* A run's controls live with its view (spec 7.1: the pane is a view of
          the run, so stopping is an action ON the run, not on this pane). */}
      <div className="term-bar">
        <span className="hint" data-testid="term-run">
          {spec.run}
        </span>
        {live !== null && (
          <span className={`run-state ${live.state}`} data-testid="term-run-state">
            {runStateLabel(live.state, live.exitCode)}
          </span>
        )}
        <span className="spacer" style={{ flex: 1 }} />
        <button type="button" data-testid="term-run-command" onClick={() => setRunLauncherOpen(true)}>
          Run command
        </button>
        <button
          type="button"
          data-testid="term-stop"
          onClick={() => void stopRun(computer, spec.run).catch(() => undefined)}
        >
          Stop
        </button>
        <button
          type="button"
          data-testid="term-review"
          onClick={() => openRunDiff(computer, spec.run)}
          title="Review this run’s changes"
        >
          Changes
        </button>
      </div>
      <div className="term-wrap">
        <div className="term-host" ref={host} />
        {predict.pending > 0 && (
          <div className="term-predict" data-testid="term-predict">
            <span className="hint">predicting </span>
            <span className="predicted">{predict.text}</span>
          </div>
        )}
      </div>
    </div>
  );
}
