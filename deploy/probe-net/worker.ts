// SCRATCH — Gate 2 (outbound WebSocket) probe. Delete with the directory.
//
// One Worker + one container-enabled Durable Object. It reproduces Mari's
// production topology exactly:
//
//   container (marid's seat) --wss:443--> Cloudflare edge --> Worker --> ProbeDO
//
// The DO decodes what arrives with the REAL TypeScript codec
// (packages/shared/src/frame.ts + cbor.ts) and replies with frames it encodes
// with that same codec. The container compares those bytes against frames
// produced by the REAL Rust encoder (mari_proto::encode_frame). Both directions
// are asserted byte-exact, cross-language, over the real network.

import { FrameReader, encodeFrame } from '../../packages/shared/src/frame';
import { decodeCbor, encodeCbor } from '../../packages/shared/src/cbor';

interface Env {
  PROBE: DurableObjectNamespace;
}

// ---- the exact values the Rust generator (genfix/src/main.rs) encoded --------
// Byte-equality against the .frame files proves both sides built the same value
// AND encoded it identically.

function pattern(len: number, mul: number, add: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = (i * mul + add) & 0xff;
  return out;
}

const HELLO_C = {
  computer: 'probe-computer-1',
  epoch: 4294967297,
  token: 'probe-token-abc',
  proto_version: 1,
};
const JOURNAL_BYTES = pattern(65536, 37, 11);
const JOURNAL_OFFSET = 8589934592;

const CTL_START_RUN = {
  t: 'start_run',
  c: {
    run: 'probe-run-1',
    argv: ['/bin/sh', '-c', 'echo hi'],
    env_names: ['ANTHROPIC_API_KEY'],
    cwd: '/work',
  },
};

const CTL_INPUT = {
  t: 'input',
  c: { run: 'probe-run-1', bytes: pattern(256, 11, 3) },
};

function toHex(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += x.toString(16).padStart(2, '0');
  return s;
}

async function sha256(b: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', b);
  return toHex(new Uint8Array(d));
}

function eqBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Same normalisation ComputerDO uses (computer-do.ts `toBytes`): a binary
 *  WebSocket message arrives as an ArrayBuffer or as an ArrayBufferView. */
function toBytes(data: string | ArrayBuffer | ArrayBufferView): Uint8Array {
  if (typeof data === 'string') return new TextEncoder().encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
}

function concat(parts: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** Byte-level verification of the values Mari actually cares about. */
function checkValue(value: unknown): Record<string, unknown> {
  const v = value as { t?: string; c?: Record<string, unknown> };
  const c = v.c ?? {};
  if (v.t === 'hello') {
    return {
      computer: c.computer === HELLO_C.computer,
      // The u64 > 2^32 parity rule (contracts §1): must decode as a JS number.
      epoch: c.epoch === HELLO_C.epoch && typeof c.epoch === 'number',
      token: c.token === HELLO_C.token,
      proto_version: c.proto_version === 1,
    };
  }
  if (v.t === 'journal_frame') {
    const bytes = c.bytes as Uint8Array;
    const isBytes = bytes instanceof Uint8Array;
    return {
      run: c.run === 'probe-run-1',
      offset: c.offset === JOURNAL_OFFSET && typeof c.offset === 'number',
      bytesIsUint8Array: isBytes,
      bytesLen: isBytes ? bytes.length : -1,
      bytesByteExact: isBytes && eqBytes(bytes, JOURNAL_BYTES),
    };
  }
  return { unexpected: v.t };
}

export class ProbeDO {
  private ctx: DurableObjectState;
  private env: Env;
  private reader = new FrameReader();
  private nFrames = 0;
  private nBytesIn = 0;
  private monitorArmed = false;
  private failures = 0;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
    ctx.storage.sql.exec(
      'CREATE TABLE IF NOT EXISTS ev (i INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER, kind TEXT, data TEXT)',
    );
  }

  private log(kind: string, data: unknown = null): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO ev (ts, kind, data) VALUES (?, ?, ?)',
      Date.now(),
      kind,
      JSON.stringify(data ?? null),
    );
  }

  private events(): unknown[] {
    return [...this.ctx.storage.sql.exec('SELECT i, ts, kind, data FROM ev ORDER BY i').toArray()].map(
      (r) => ({ i: r.i, ts: r.ts, kind: r.kind, data: JSON.parse(r.data as string) }),
    );
  }

  /** Durable liveness tape. Records `running` every 20s so a platform stop is
   *  timestamped even if this DO is later evicted. */
  async alarm(): Promise<void> {
    const until = (await this.ctx.storage.get<number>('watchUntil')) ?? 0;
    const startedAt = (await this.ctx.storage.get<number>('startedAt')) ?? Date.now();
    const running = this.ctx.container?.running ?? null;
    const last = (await this.ctx.storage.get<boolean | null>('lastRunning')) ?? null;
    if (running !== last) {
      this.log('liveness', { running, sinceStartMs: Date.now() - startedAt });
      await this.ctx.storage.put('lastRunning', running);
    }
    if (Date.now() < until) await this.ctx.storage.setAlarm(Date.now() + 20_000);
    else this.log('watch_ended', { sinceStartMs: Date.now() - startedAt });
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    if (path === '/echo') return this.echo(req);

    if (path === '/report') {
      const body = await req.json();
      this.log('report', body);
      return Response.json({ ok: true });
    }

    if (path === '/start') {
      const hold = url.searchParams.get('hold') ?? '200';
      const inactivity = Number(url.searchParams.get('inactivity') ?? '0');
      const internet = url.searchParams.get('internet') !== '0';
      const wsUrl = url.searchParams.get('ws') ?? '';
      const mode = url.searchParams.get('mode') ?? 'full';
      const c = this.ctx.container;
      if (!c) return Response.json({ error: 'no container binding' }, { status: 500 });
      if (c.running) return Response.json({ error: 'already running' }, { status: 409 });

      this.ctx.storage.sql.exec('DELETE FROM ev');
      this.reader = new FrameReader();
      this.nFrames = 0;
      this.nBytesIn = 0;
      this.failures = 0;

      const env: Record<string, string> = {
        PROBE_WS_URL: wsUrl,
        PROBE_HOLD_SECONDS: hold,
        PROBE_MODE: mode,
      };
      this.log('start_called', { hold, inactivity, internet, wsUrl, mode });
      const t0 = Date.now();
      c.start({ enableInternet: internet, env });

      if (inactivity > 0) {
        await c.setInactivityTimeout(inactivity * 1000);
        this.log('inactivity_timeout_set', { seconds: inactivity });
      }

      if (!this.monitorArmed) {
        this.monitorArmed = true;
        const started = Date.now();
        // waitUntil, or the continuation is cancelled with the /start request's
        // I/O context and a platform-initiated stop goes unrecorded.
        this.ctx.waitUntil(
          c
            .monitor()
            .then(() => this.log('container_exited', { afterMs: Date.now() - started }))
            .catch((e: unknown) =>
              this.log('container_exit_error', { afterMs: Date.now() - started, error: String(e) }),
            ),
        );
      }
      // A durable liveness tape: an alarm samples `running` every 20s, so the
      // moment the platform stops the container survives a DO eviction.
      await this.ctx.storage.put('watchUntil', Date.now() + 25 * 60 * 1000);
      await this.ctx.storage.put('startedAt', Date.now());
      await this.ctx.storage.setAlarm(Date.now() + 20_000);
      return Response.json({ ok: true, startCallMs: Date.now() - t0 });
    }

    if (path === '/status') {
      // Passive: reads recorded rows only. Must NOT touch the container, or the
      // read would itself count as activity and poison the inactivity test.
      return Response.json({
        now: Date.now(),
        running: this.ctx.container?.running ?? null,
        frames: this.nFrames,
        bytesIn: this.nBytesIn,
        failures: this.failures,
        events: this.events(),
      });
    }

    if (path === '/inbound') {
      // An INBOUND request into the container's listener (memo item 5): does it
      // renew the timer, and does WebSocket proxying work on this path?
      const c = this.ctx.container;
      if (!c) return Response.json({ error: 'no container' }, { status: 500 });
      const port = Number(url.searchParams.get('port') ?? '8080');
      const t0 = Date.now();
      const res = await c.getTcpPort(port).fetch(
        new Request('http://container/' + (url.searchParams.get('p') ?? ''), {
          headers: req.headers,
        }),
      );
      const text = res.webSocket ? '<websocket>' : (await res.text()).slice(0, 400);
      this.log('inbound_fetch', { port, status: res.status, ms: Date.now() - t0 });
      return Response.json({ status: res.status, ms: Date.now() - t0, body: text });
    }

    if (path === '/exec') {
      const c = this.ctx.container;
      if (!c) return Response.json({ error: 'no container' }, { status: 500 });
      const cmd = url.searchParams.getAll('a');
      const p = await c.exec(cmd.length ? cmd : ['/bin/sh', '-c', 'echo no-cmd']);
      const out = await p.output();
      return Response.json({ cmd, exitCode: out.exitCode, stdout: out.stdout, stderr: out.stderr });
    }

    if (path === '/destroy') {
      await this.ctx.container?.destroy();
      this.log('destroyed');
      return Response.json({ ok: true });
    }

    return new Response('probe do', { status: 404 });
  }

  private echo(req: Request): Response {
    if (req.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const server = pair[1];
    server.accept(); // non-hibernatable, exactly as ComputerDO does today
    // At compatibility_date 2026-07-15 a binary message arrives as a **Blob**,
    // not an ArrayBuffer. ComputerDO's `toBytes` (computer-do.ts:276) would
    // silently turn that into a zero-length Uint8Array. See the local
    // binaryType experiment in the gate report.
    // `?binary=default` leaves it alone, to measure what the runtime hands us.
    if (new URL(req.url).searchParams.get('binary') !== 'default') {
      server.binaryType = 'arraybuffer';
    }
    const cf = (req as unknown as { cf?: Record<string, unknown> }).cf ?? {};
    this.log('ws_open', {
      colo: cf.colo ?? null,
      country: cf.country ?? null,
      httpProtocol: cf.httpProtocol ?? null,
      tlsVersion: cf.tlsVersion ?? null,
      clientTcpRtt: cf.clientTcpRtt ?? null,
    });

    // `mode=size` is a raw byte-count echo used to find the largest single
    // WebSocket message that survives the edge, without desyncing the framed
    // protocol connection.
    const sizeMode = new URL(req.url).searchParams.get('mode') === 'size';
    server.addEventListener('message', (ev: MessageEvent) => {
      if (sizeMode) {
        const n = toBytes(ev.data as ArrayBuffer).length;
        this.log('size_echo', { n });
        server.send(JSON.stringify({ len: n }));
        return;
      }
      try {
        this.onMessage(server, ev);
      } catch (e) {
        this.failures++;
        this.log('handler_threw', {
          error: String(e),
          stack: String((e as Error)?.stack ?? '').slice(0, 800),
          dataType: typeof ev.data,
          ctor: (ev.data as object)?.constructor?.name ?? null,
        });
      }
    });
    server.addEventListener('close', (ev: CloseEvent) =>
      this.log('ws_close', { code: ev.code, reason: ev.reason, frames: this.nFrames }),
    );
    server.addEventListener('error', (ev: Event) =>
      this.log('ws_error', { msg: String((ev as unknown as { message?: string }).message) }),
    );

    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** Synchronous: FrameReader draining must not interleave across messages. */
  private onMessage(server: WebSocket, ev: MessageEvent): void {
    if (typeof ev.data === 'string') {
      let parsed: unknown = ev.data;
      try {
        parsed = JSON.parse(ev.data);
      } catch {
        /* keep raw */
      }
      this.log('ws_text', parsed);
      return;
    }

    const raw = toBytes(ev.data as ArrayBuffer);
    this.nBytesIn += raw.length;
    if (this.nFrames < 3) {
      this.log('msg_in', {
        len: raw.length,
        ctor: (ev.data as object)?.constructor?.name ?? null,
        head: [...raw.slice(0, 8)],
      });
    }
    this.reader.push(raw);

    const replies: Uint8Array[] = [];
    const drained: { seq: number; t: string; body: Uint8Array; parity: boolean }[] = [];

    let body: Uint8Array | null;
    while ((body = this.reader.nextBody()) !== null) {
      this.nFrames++;
      const seq = this.nFrames;
      const value = decodeCbor(body);
      const t = ((value as { t?: string }).t ?? '?') as string;

      // Cross-language byte parity: re-encode what we decoded with the TS codec
      // and require it to equal the bytes the Rust encoder put on the wire.
      const parity = eqBytes(encodeCbor(value), body);
      const check = checkValue(value);
      const ok = parity && Object.values(check).every((x) => x !== false && x !== -1);
      if (!ok) this.failures++;

      // Log the first exchanges in full, plus every failure, plus a periodic
      // heartbeat so a 200-second hold does not write 200 rows.
      if (seq <= 8 || !ok || seq % 10 === 0) {
        drained.push({ seq, t, body, parity });
        this.log('frame_in', { seq, t, bodyLen: body.length, reencodeByteIdentical: parity, check, wsMsgBytes: raw.length });
      }

      if (t === 'hello') replies.push(encodeFrame(CTL_START_RUN));
      else if (t === 'journal_frame') replies.push(encodeFrame(CTL_INPUT));
      else {
        this.failures++;
        this.log('frame_unexpected', { seq, t });
      }
    }

    // Hash the first few bodies out-of-band (async) for the record.
    for (const d of drained.slice(0, 4)) {
      sha256(d.body)
        .then((h) => this.log('frame_sha256', { seq: d.seq, t: d.t, sha256: h }))
        .catch(() => {});
    }

    if (replies.length === 1) server.send(replies[0]);
    // Coalesce back-to-back frames into ONE WebSocket message, exercising the
    // peer's FrameReader (contracts §2).
    else if (replies.length > 1) server.send(concat(replies));
  }
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const id = url.searchParams.get('id') ?? 'probe-1';
    if (url.pathname === '/') {
      return Response.json({
        probe: 'mari-probe-net',
        routes: ['/start', '/status', '/echo', '/report', '/exec', '/destroy'],
      });
    }
    if (url.pathname === '/wecho') {
      // Control: the same echo handled in the Worker itself, no DO hop.
      const pair = new WebSocketPair();
      pair[1].accept();
      pair[1].addEventListener('message', (ev: MessageEvent) => {
        const n = typeof ev.data === 'string' ? ev.data.length : (ev.data as ArrayBuffer).byteLength;
        pair[1].send(JSON.stringify({ worker: true, len: n }));
      });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const stub = env.PROBE.get(env.PROBE.idFromName(id));
    return stub.fetch(req);
  },
};
