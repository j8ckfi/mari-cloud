// `WebSocketPair` + the 101 upgrade `Response`, for Node.
//
// The Durable Object terminates both the supervisor channel (framed CBOR,
// contracts.md §2) and the client attach channel (discrete CBOR, §7) by
// creating a `WebSocketPair`, accepting the server half, and returning the
// client half on a `101` response. Workerd then pumps the client half onto the
// wire. Node's `Response` refuses status 101 and has no `webSocket` field, so
// this module supplies both:
//
//   * `PairSocket` — an in-process socket pair with workerd's semantics:
//     messages sent before `accept()` are queued, `close()` notifies the peer,
//     and listeners are registered with `addEventListener`.
//   * `installUpgradeResponse()` — replaces the global `Response` with a
//     subclass that carries `{ status: 101, webSocket }` untouched. Everything
//     else delegates to the platform `Response`, so Hono, Better Auth and
//     undici keep their exact behavior.
//
// `server.ts` bridges the client half to a real `ws` connection, so the DO code
// itself is byte-identical across runtimes.

type Payload = string | ArrayBuffer | ArrayBufferView;

interface SocketEvent {
  type: string;
  data?: Payload;
  code?: number;
  reason?: string;
}

type Listener = (event: SocketEvent) => void;

const CONNECTING = 0;
const OPEN = 1;
const CLOSING = 2;
const CLOSED = 3;

/** One end of an in-process WebSocket pair. */
export class PairSocket {
  static readonly CONNECTING = CONNECTING;
  static readonly OPEN = OPEN;
  static readonly CLOSING = CLOSING;
  static readonly CLOSED = CLOSED;

  readonly url: string | null = null;
  readyState: number = OPEN;

  #peer: PairSocket | null = null;
  #accepted = false;
  #inbox: SocketEvent[] = [];
  #listeners = new Map<string, Set<Listener>>();

  /** Link the two halves. Called once by `WebSocketPair`. */
  static link(a: PairSocket, b: PairSocket): void {
    a.#peer = b;
    b.#peer = a;
  }

  /** Start delivering events to listeners (workerd requires this before use). */
  accept(): void {
    if (this.#accepted) return;
    this.#accepted = true;
    const queued = this.#inbox;
    this.#inbox = [];
    for (const ev of queued) this.#dispatch(ev);
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  /** Send to the peer. A send on a closed socket is dropped, not thrown: a
   *  supervisor that vanished mid-frame must not take the DO down with it. */
  send(data: Payload): void {
    if (this.readyState !== OPEN) return;
    this.#peer?.receive({ type: 'message', data });
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === CLOSED || this.readyState === CLOSING) return;
    this.readyState = CLOSED;
    const peer = this.#peer;
    this.#dispatch({ type: 'close', code, reason });
    if (peer && peer.readyState !== CLOSED) {
      peer.readyState = CLOSED;
      peer.receive({ type: 'close', code, reason });
    }
  }

  /** Deliver an event to THIS end (queued until `accept()`). */
  receive(event: SocketEvent): void {
    if (!this.#accepted) {
      this.#inbox.push(event);
      return;
    }
    this.#dispatch(event);
  }

  #dispatch(event: SocketEvent): void {
    const set = this.#listeners.get(event.type);
    if (!set) return;
    for (const listener of [...set]) {
      try {
        listener(event);
      } catch {
        // A listener throwing must not stop the other listeners or the socket.
      }
    }
  }
}

/** workerd's `WebSocketPair`: `[client, server]`, indexable as `pair[0]/[1]`. */
export class NodeWebSocketPair {
  0: PairSocket;
  1: PairSocket;

  constructor() {
    const client = new PairSocket();
    const server = new PairSocket();
    PairSocket.link(client, server);
    this[0] = client;
    this[1] = server;
  }
}

const UPGRADE_STATUS = 101;

let installed = false;

/**
 * Replace the global `Response` with a subclass that accepts
 * `{ status: 101, webSocket }`. Idempotent.
 *
 * Undici's `Response` constructor rejects any status outside 200..599, so the
 * 101 is modeled as a 200 underneath with the status getter overridden — the
 * object still passes `instanceof Response` and behaves identically for every
 * other status, which matters because Hono and Better Auth construct thousands
 * of ordinary responses through the same global.
 */
export function installUpgradeResponse(): void {
  if (installed) return;
  installed = true;
  const Base = globalThis.Response;

  class UpgradeCapableResponse extends Base {
    constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: PairSocket }) {
      if (init && init.status === UPGRADE_STATUS) {
        const { status: _status, webSocket, ...rest } = init;
        super(null, { ...rest, status: 200 });
        // Defined on the INSTANCE rather than as a prototype accessor: undici
        // reads `this.status` while the base constructor is still running, and
        // a subclass accessor would touch fields that do not exist yet. The
        // `webSocket` half is likewise only present on an upgrade response,
        // exactly as workerd models it.
        Object.defineProperty(this, 'status', { value: UPGRADE_STATUS, configurable: true });
        Object.defineProperty(this, 'webSocket', {
          value: webSocket ?? null,
          configurable: true,
        });
      } else {
        super(body ?? null, init);
      }
    }
  }

  // `defineProperty`, because another adapter may have made `Response` a
  // non-writable own property; keep ours configurable so a later installer can
  // still replace it (and so this is re-runnable in a test process).
  Object.defineProperty(globalThis, 'Response', {
    value: UpgradeCapableResponse,
    writable: true,
    configurable: true,
  });
}

/** Install `WebSocketPair` + the upgrade-capable `Response` as globals. */
export function installWebSocketGlobals(): void {
  installUpgradeResponse();
  (globalThis as Record<string, unknown>)['WebSocketPair'] = NodeWebSocketPair;
}
