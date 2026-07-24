import { describe, it, expect } from 'vitest';
import { encodeCbor, decodeCbor } from '@mari/shared';
import type { ClientToDo, DoFrame, DoGridSnapshot } from '@mari/shared';
import { AttachClient, asDoToClient, attachUrl, type SocketLike } from '../src/ws/attach';

/** A controllable fake WebSocket recording everything the client sends. */
class FakeSocket implements SocketLike {
  binaryType = '';
  sent: ClientToDo[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  closed = false;

  constructor(readonly url: string) {}

  send(data: ArrayBufferView | ArrayBuffer): void {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(decodeCbor(bytes) as ClientToDo);
  }

  close(): void {
    this.closed = true;
  }

  // test drivers
  open(): void {
    this.onopen?.({});
  }
  deliver(msg: unknown): void {
    this.onmessage?.({ data: encodeCbor(msg) });
  }
  fail(): void {
    this.onclose?.({});
  }
}

/** A manual timer queue so reconnect scheduling is deterministic. */
function makeTimers() {
  const queue: Array<{ id: number; fn: () => void }> = [];
  let id = 1;
  return {
    set: (fn: () => void): number => {
      const h = id++;
      queue.push({ id: h, fn });
      return h;
    },
    clear: (h: number): void => {
      const i = queue.findIndex((t) => t.id === h);
      if (i >= 0) queue.splice(i, 1);
    },
    runAll: (): void => {
      const pending = queue.splice(0);
      for (const t of pending) t.fn();
    },
    pending: (): number => queue.length,
  };
}

function setup() {
  const sockets: FakeSocket[] = [];
  const timers = makeTimers();
  const grids: DoGridSnapshot[] = [];
  const frames: DoFrame[] = [];
  let opens = 0;
  let closes = 0;
  const client = new AttachClient({
    url: 'ws://x/attach/c1',
    run: 'run-1',
    cols: 80,
    rows: 24,
    socketFactory: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    setTimeoutFn: timers.set,
    clearTimeoutFn: timers.clear,
    handlers: {
      onGrid: (m) => grids.push(m),
      onFrame: (m) => frames.push(m),
      onOpen: () => void (opens += 1),
      onClose: () => void (closes += 1),
    },
  });
  return {
    client,
    timers,
    grids,
    frames,
    last: () => sockets[sockets.length - 1] as FakeSocket,
    count: () => sockets.length,
    opens: () => opens,
    closes: () => closes,
  };
}

describe('AttachClient', () => {
  it('sends an attach message with the viewport on open', () => {
    const t = setup();
    t.client.connect();
    t.last().open();
    expect(t.opens()).toBe(1);
    expect(t.last().sent[0]).toEqual({ t: 'attach', run: 'run-1', cols: 80, rows: 24 });
  });

  it('forwards input bytes as an input message', () => {
    const t = setup();
    t.client.connect();
    t.last().open();
    t.client.input(new Uint8Array([0x6c, 0x73])); // "ls"
    const msg = t.last().sent.find((m) => m.t === 'input');
    expect(msg).toEqual({ t: 'input', run: 'run-1', bytes: new Uint8Array([0x6c, 0x73]) });
  });

  it('applies a grid snapshot and tracks its base offset', () => {
    const t = setup();
    t.client.connect();
    t.last().open();
    const grid: DoGridSnapshot = {
      t: 'grid',
      run: 'run-1',
      baseOffset: 100,
      grid: { cols: 80, rows: 24, cells: [], cursorCol: 0, cursorRow: 0, cursorVisible: true },
    };
    t.last().deliver(grid);
    expect(t.grids).toHaveLength(1);
    expect(t.client.appliedOffset).toBe(100);
  });

  it('advances the applied offset on frames and de-duplicates replays', () => {
    const t = setup();
    t.client.connect();
    t.last().open();
    t.last().deliver({
      t: 'grid',
      run: 'run-1',
      baseOffset: 0,
      grid: { cols: 80, rows: 24, cells: [], cursorCol: 0, cursorRow: 0, cursorVisible: true },
    });
    t.last().deliver({ t: 'frame', run: 'run-1', offset: 0, bytes: new Uint8Array([65, 66]) });
    expect(t.client.appliedOffset).toBe(2);
    // A replayed frame at an already-applied offset is dropped.
    t.last().deliver({ t: 'frame', run: 'run-1', offset: 0, bytes: new Uint8Array([65, 66]) });
    expect(t.frames).toHaveLength(1);
    // A fresh frame is applied.
    t.last().deliver({ t: 'frame', run: 'run-1', offset: 2, bytes: new Uint8Array([67]) });
    expect(t.frames).toHaveLength(2);
    expect(t.client.appliedOffset).toBe(3);
  });

  it('reconnects with backoff and re-sends attach', () => {
    const t = setup();
    t.client.connect();
    t.last().open();
    expect(t.count()).toBe(1);
    // Socket drops.
    t.last().fail();
    expect(t.closes()).toBe(1);
    expect(t.timers.pending()).toBe(1); // reconnect scheduled
    // Fire the reconnect timer: a new socket is created and attaches on open.
    t.timers.runAll();
    expect(t.count()).toBe(2);
    t.last().open();
    expect(t.last().sent[0]).toEqual({ t: 'attach', run: 'run-1', cols: 80, rows: 24 });
  });

  it('stops reconnecting after close()', () => {
    const t = setup();
    t.client.connect();
    t.last().open();
    t.client.close();
    expect(t.last().closed).toBe(true);
    t.last().fail(); // a late close event must not schedule a reconnect
    expect(t.timers.pending()).toBe(0);
  });
});

describe('asDoToClient / attachUrl', () => {
  it('accepts valid DO messages and rejects junk', () => {
    expect(asDoToClient({ t: 'frame', run: 'r', offset: 0, bytes: new Uint8Array() })?.t).toBe(
      'frame',
    );
    expect(asDoToClient({ t: 'nope' })).toBeNull();
    expect(asDoToClient(null)).toBeNull();
    expect(asDoToClient(42)).toBeNull();
  });

  it('builds ws/wss URLs from the origin', () => {
    expect(attachUrl('c1', { protocol: 'http:', host: 'localhost:5173' })).toBe(
      'ws://localhost:5173/attach/c1',
    );
    expect(attachUrl('c 1', { protocol: 'https:', host: 'mari.sh' })).toBe(
      'wss://mari.sh/attach/c%201',
    );
  });
});
