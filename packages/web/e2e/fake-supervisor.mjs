// A fake Mari supervisor (`marid`) for the terminal e2e test.
//
// It speaks the REAL framed-CBOR supervisor<->control-plane wire protocol from
// @mari/shared (contracts.md §2/§5): a 4-byte big-endian length prefix followed
// by one CBOR-encoded message. It connects to the control plane as a supervisor
// would, says `hello`, and then acts as a trivial PTY that ECHOES whatever the
// user types — so a keystroke round-trips to output through the whole stack:
//
//   browser xterm --(attach ClientInput)--> DO --(Input)--> [this] --(journal_frame)--> DO --(DoFrame)--> xterm
//
// THE INPUT HOP: terminal input/resize are first-class ControlMessages now
// (`ControlMessage::Input { run, bytes }` / `Resize { run, cols, rows }`,
// contracts §5.2). The DO forwards a keystroke as `{ t: 'input', c: { run,
// bytes } }` and a viewport change as `{ t: 'resize', c: { run, cols, rows } }`.
// This fake decodes with the raw @mari/shared codec and echoes input back as PTY
// output; resize is accepted and ignored (a PTY echo has nothing to reflow).

import {
  FrameReader,
  encodeFrame,
  decodeCbor,
  PROTO_VERSION,
} from '@mari/shared';

const textEncoder = new TextEncoder();

/**
 * Connect a fake supervisor to the control plane.
 * @param {{ url?: string, computer?: string, token?: string, epoch?: number,
 *           preRunManifest?: string }} opts
 * @returns {Promise<{ ws: WebSocket, close: () => void, activeRuns: () => string[] }>}
 */
export async function startFakeSupervisor(opts = {}) {
  const {
    url = 'ws://127.0.0.1:8787',
    computer = 'seed-cold',
    token = 'dev-supervisor',
    epoch = 1,
    preRunManifest = 'seed-manifest',
  } = opts;

  const wsUrl = `${url.replace(/^http/, 'ws')}/supervisor/${encodeURIComponent(
    computer,
  )}?token=${encodeURIComponent(token)}&epoch=${epoch}`;

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  const reader = new FrameReader();
  /** @type {Map<string, number>} run -> next journal offset */
  const offsets = new Map();
  /** @type {Set<string>} */
  const runs = new Set();

  const send = (msg) => ws.send(encodeFrame(msg));

  const journal = (run, bytes) => {
    const offset = offsets.get(run) ?? 0;
    send({ t: 'journal_frame', c: { run, offset, bytes } });
    offsets.set(run, offset + bytes.length);
  };

  const handle = (msg) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.t) {
      case 'hello_ack':
        break;
      case 'start_run': {
        const run = msg.c.run;
        runs.add(run);
        offsets.set(run, offsets.get(run) ?? 0);
        send({ t: 'run_started', c: { run, pre_run_manifest: preRunManifest } });
        journal(run, textEncoder.encode('$ ')); // an initial prompt
        break;
      }
      case 'input': {
        // Control-plane-forwarded keystrokes (ControlMessage::Input): echo them
        // back as PTY output.
        const run = msg.c.run;
        const raw = msg.c.bytes;
        const bytes = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
        if (!runs.has(run)) runs.add(run);
        journal(run, bytes);
        break;
      }
      case 'resize':
        // ControlMessage::Resize: a real supervisor sets the PTY window size; a
        // PTY-echo fake has nothing to reflow, so accept and ignore it.
        break;
      case 'stop_run': {
        const run = msg.c.run;
        send({
          t: 'run_completed',
          c: {
            run,
            exit: { t: 'exited', c: { code: 0 } },
            post_run_manifest: preRunManifest,
            diff: { added: 0, modified: 0, removed: 0 },
          },
        });
        runs.delete(run);
        break;
      }
      case 'snapshot_now':
        send({ t: 'snapshot_written', c: { manifest: preRunManifest, epoch, reason: msg.c.reason } });
        break;
      default:
        // journal_ack, prepare_for_cold, head_advance_result, restore_to_manifest: no-op
        break;
    }
  };

  ws.addEventListener('message', (ev) => {
    reader.push(new Uint8Array(ev.data));
    let body;
    while ((body = reader.nextBody()) !== null) {
      handle(decodeCbor(body));
    }
  });

  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      send({ t: 'hello', c: { computer, epoch, token, proto_version: PROTO_VERSION } });
      resolve();
    });
    ws.addEventListener('error', (e) => reject(e));
  });

  return {
    ws,
    close: () => ws.close(),
    activeRuns: () => [...runs],
  };
}

// CLI: node e2e/fake-supervisor.mjs [controlUrl] [computer]
// (Requires a TS-capable loader for the @mari/shared import when run directly;
// the e2e imports it in-process where Playwright transpiles the graph.)
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [, , cliUrl = 'ws://127.0.0.1:8787', cliComputer = 'seed-cold'] = process.argv;
  startFakeSupervisor({ url: cliUrl, computer: cliComputer })
    .then(() => console.log(`fake supervisor connected for ${cliComputer}`))
    .catch((e) => {
      console.error('fake supervisor failed:', e);
      process.exit(1);
    });
}
