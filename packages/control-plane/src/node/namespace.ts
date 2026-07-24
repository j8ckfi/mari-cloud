// `DurableObjectNamespace` for Node: one live actor per id, in this process.
//
// On Cloudflare, `env.COMPUTER.get(idFromName(id))` returns a stub whose method
// calls are RPC into the single instance that owns that id. A private instance
// is a single process, so the "single instance" is literally a map entry here —
// which is the whole point: `ComputerDO` remains the only coordination point
// for its computer (spec 3.2), and the code that runs is the same class.
//
// Two behaviors are load-bearing and reproduced exactly:
//   * every call waits on the object's input gate (`blockConcurrencyWhile` in
//     the constructor loads `meta` and creates the tables before anything else
//     touches them);
//   * the object is created lazily and then kept alive, so in-memory state the
//     DO relies on — the attached supervisor socket, the pending journal
//     buffer, the in-flight wake promise — persists across requests.

import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { NodeDurableObjectId, NodeDurableObjectState, openObjectDatabase } from './state.js';

/** The subset of a Durable Object the namespace itself needs. */
interface ObjectLike {
  fetch(request: Request): Response | Promise<Response>;
  alarm?(): void | Promise<void>;
}

interface Entry<T> {
  instance: T;
  state: NodeDurableObjectState;
}

/** File-system-safe, collision-free name for one object's SQLite file. */
function objectFileName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64);
  const digest = createHash('sha256').update(name).digest('hex').slice(0, 16);
  return `${safe}-${digest}.sqlite`;
}

export class NodeDurableObjectNamespace<T extends ObjectLike> {
  readonly #entries = new Map<string, Entry<T>>();
  readonly #dir: string;
  readonly #className: string;
  readonly #create: (state: NodeDurableObjectState) => T;

  constructor(opts: {
    className: string;
    dir: string;
    create: (state: NodeDurableObjectState) => T;
  }) {
    this.#className = opts.className;
    this.#dir = join(opts.dir, opts.className);
    this.#create = opts.create;
    mkdirSync(this.#dir, { recursive: true });
  }

  idFromName(name: string): NodeDurableObjectId {
    const hex = createHash('sha256').update(`${this.#className}:${name}`).digest('hex');
    return new NodeDurableObjectId(name, hex);
  }

  idFromString(hex: string): NodeDurableObjectId {
    return new NodeDurableObjectId(hex, hex);
  }

  newUniqueId(): NodeDurableObjectId {
    const hex = createHash('sha256')
      .update(`${this.#className}:${crypto.randomUUID()}`)
      .digest('hex');
    return new NodeDurableObjectId(hex, hex);
  }

  /** The live instance for `name`, created on first use. */
  #entry(name: string): Entry<T> {
    const existing = this.#entries.get(name);
    if (existing) return existing;
    const db = openObjectDatabase(join(this.#dir, objectFileName(name)));
    const state = new NodeDurableObjectState(this.idFromName(name), db);
    const instance = this.#create(state);
    const entry: Entry<T> = { instance, state };
    this.#entries.set(name, entry);
    // The tier alarm (spec 4.4) fires into the object itself, behind the same
    // input gate as any other entry point.
    state.storage.onAlarm = async () => {
      await state.ready();
      await instance.alarm?.();
    };
    void state.storage.rearm();
    return entry;
  }

  /** A stub: `fetch` plus every RPC method the class exposes. */
  get(id: NodeDurableObjectId | { name?: string; toString(): string }): T & {
    fetch(request: Request): Promise<Response>;
  } {
    const name = 'name' in id && typeof id.name === 'string' ? id.name : id.toString();
    const ns = this;
    const target = {} as Record<string | symbol, unknown>;
    return new Proxy(target, {
      get(_t, prop) {
        // A stub must not look thenable, or `await stub` (and any promise
        // library that probes for `.then`) would hang or recurse.
        if (prop === 'then' || typeof prop === 'symbol') return undefined;
        if (prop === 'id') return ns.idFromName(name);
        return async (...args: unknown[]) => {
          const entry = ns.#entry(name);
          await entry.state.ready();
          // A stub's `fetch` takes the same arguments as global `fetch`
          // (`app.ts` calls it with a URL string plus init); the object itself
          // only ever sees a `Request`.
          if (prop === 'fetch' && !(args[0] instanceof Request)) {
            args = [new Request(args[0] as string | URL, args[1] as RequestInit | undefined)];
          }
          const fn = (entry.instance as unknown as Record<string, unknown>)[prop as string];
          if (typeof fn !== 'function') {
            throw new TypeError(`${ns.#className}.${String(prop)} is not a method`);
          }
          return (fn as (...a: unknown[]) => unknown).apply(entry.instance, args);
        };
      },
    }) as unknown as T & { fetch(request: Request): Promise<Response> };
  }

  /** Direct access to a live instance — the Node equivalent of the Workers
   *  pool's `runInDurableObject`, used by tests to read driver call logs. */
  async instanceFor(name: string): Promise<T> {
    const entry = this.#entry(name);
    await entry.state.ready();
    return entry.instance;
  }

  /** The object's state (storage + alarm control), for the runtime's own
   *  bootstrap paths and for tests that drive the tier policy deterministically
   *  — the Node equivalent of `runDurableObjectAlarm`. */
  stateFor(name: string): NodeDurableObjectState {
    return this.#entry(name).state;
  }

  /** Await every `waitUntil` of every live object (shutdown + test barriers). */
  async drain(): Promise<void> {
    for (const entry of [...this.#entries.values()]) await entry.state.drain();
  }

  /** Names of the objects that exist in this process. */
  liveNames(): string[] {
    return [...this.#entries.keys()];
  }

  close(): void {
    for (const entry of this.#entries.values()) entry.state.storage.close();
    this.#entries.clear();
  }
}
