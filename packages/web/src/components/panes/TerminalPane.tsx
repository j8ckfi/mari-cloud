import { useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import '@xterm/xterm/css/xterm.css';
import { AttachClient, attachUrl } from '../../ws/attach';
import { EchoPredictor } from '../../terminal/predictor';
import { terminalStatus } from '../../terminal/status';
import { shortRunId } from '../../runs/state';
import { useFleet } from '../../api/queries';
import { useEventsStore } from '../../store/events';
import { liveState } from '../../events/reducer';
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
 *
 * Lifecycle honesty (spec 8.3): the pane never blocks and never spins. Until
 * the first byte it shows one line of text saying what is happening — "waking
 * your computer" when the computer is COLD/WAKING (the wake runs behind the
 * pane), plain "connecting" otherwise — and when a live socket drops it shows
 * a quiet "reconnecting" strip while the AttachClient's backoff does its work.
 * Scrollback survives a reconnect: a redundant grid replay is dropped in the
 * attach layer, so the buffer is never cleared for a network blip.
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
  // Whether the attach socket has delivered ANYTHING for this run yet, and
  // whether it is currently open. Together with the computer's lifecycle state
  // they decide the one-line status strip (see terminal/status.ts).
  const [sawData, setSawData] = useState(false);
  const [socketUp, setSocketUp] = useState(false);

  // The computer's lifecycle state: the event stream beats the polled fleet.
  const pushed = useEventsStore((s) => liveState(s.model, computer));
  const fleet = useFleet();
  const polled = fleet.data?.computers.find((c) => c.id === computer)?.state ?? null;
  const computerState = pushed ?? polled;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    setSawData(false);
    setSocketUp(false);

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
        onOpen: () => setSocketUp(true),
        onClose: () => setSocketUp(false),
        onGrid: (m) => {
          setSawData(true);
          writeGrid(term, m.grid);
        },
        onFrame: (m) => {
          setSawData(true);
          term.write(m.bytes);
          predictor.reconcile(m.bytes);
          refreshPredict();
        },
        onStatus: (m) => {
          setSawData(true);
          if (!m.alive) term.write(`\r\n\x1b[2m[run ${shortRunId(spec.run)} exited${m.exitCode != null ? ` (${m.exitCode})` : ''}]\x1b[0m\r\n`);
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

  const status = terminalStatus(sawData, socketUp, computerState);

  return (
    <div
      style={{ position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column' }}
      data-testid="terminal-pane"
      data-renderer={renderer}
      data-run={spec.run}
    >
      {/* No chrome inside a terminal: a terminal is a terminal. Stopping and
          reviewing the run live in the Runs pane and the palette (spec 8.1),
          the pane header already names the run, and everything between them is
          the shell's. */}
      <div className="term-wrap">
        <div className="term-host" ref={host} />
        {status !== null && (
          <div
            className={`term-status ${status.phase}`}
            data-testid="term-status"
            data-phase={status.phase}
          >
            <span className="hint">{status.text}</span>
          </div>
        )}
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
