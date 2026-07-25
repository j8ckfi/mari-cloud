// A fake `ctx.container`, strict about the surface it allows.
//
// Two jobs:
//
//  1. Record the EXACT call sequence and arguments, so a test can assert what the
//     driver did to the platform (start options, exec argv, destroy order) rather
//     than that it "worked".
//  2. FORBID everything outside the raw container API the driver is allowed to
//     touch. Reading `keepAlive`, `renewActivityTimeout`, `sleepAfter`,
//     `containerFetch`, `snapshotContainer`, `mountBucket`, … throws. That is how
//     "the raw ctx.container API only, never the Sandbox SDK, never keepAlive"
//     becomes a test instead of a comment: the driver cannot quietly grow a
//     dependency on any of them.
//
// Runtime-agnostic on purpose (no node: imports, no DOM): the same fake is used by
// the driver unit suite on Node and by the Durable Object suite inside workerd.

/** One recorded platform call. */
export interface FakeCall {
  readonly op: 'start' | 'exec' | 'destroy' | 'monitor' | 'getTcpPort' | 'setInactivityTimeout';
  readonly args: readonly unknown[];
  /** Monotonic index, so a test can order container calls against other events. */
  readonly seq: number;
}

/** What one fake exec should do. */
export interface FakeExecResult {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** Throw this instead of returning (a platform refusal). */
  throws?: string;
  /** Never resolve `output()` — the documented over-capacity hang. */
  hang?: boolean;
}

export interface FakeContainerOptions {
  /** Initial `running`. */
  running?: boolean;
  /** Called for each `start()`; return a message to throw. */
  onStart?: (call: number, options: unknown) => string | void;
  /** Per-exec behaviour, keyed by the argv joined with spaces; `'*'` is the
   *  fallback. A value may be an array, consumed one entry per call. */
  exec?: Record<string, FakeExecResult | FakeExecResult[]>;
  /** Message thrown by `destroy()`. */
  destroyThrows?: string;
  /** Resolve/reject `monitor()`; default: a promise that never settles. */
  monitor?: 'resolve' | 'reject' | 'pending';
  /** Message thrown by `setInactivityTimeout`. */
  inactivityThrows?: string;
  /** Response served by `getTcpPort(port).fetch()`. */
  portResponse?: (port: number, request: Request) => Response | Promise<Response>;
}

/** The only properties the driver may read on the platform object. */
export const ALLOWED_SURFACE = [
  'running',
  'start',
  'exec',
  'destroy',
  'monitor',
  'getTcpPort',
  'setInactivityTimeout',
] as const;

/** Things whose mere PRESENCE in the driver would mean the wrong API. */
const FORBIDDEN = [
  // @cloudflare/containers Container class:
  'keepAlive',
  'renewActivityTimeout',
  'sleepAfter',
  'containerFetch',
  'onActivityExpired',
  'onStop',
  'onError',
  'startAndWaitForPorts',
  'stop',
  // Sandbox SDK:
  'mountBucket',
  'tunnels',
  'exposePort',
  'createSession',
  'startProcess',
  // Present in workerd but undocumented / rejected by the memo:
  'snapshotContainer',
  'snapshotDirectory',
  'interceptOutboundHttp',
  'interceptAllOutboundHttp',
  'interceptOutboundHttps',
  'signal',
];

export class FakeContainer {
  readonly calls: FakeCall[] = [];
  running: boolean;
  /** Every property name the driver read, so a test can assert the surface. */
  readonly accessed = new Set<string>();
  /** Ports handed to `getTcpPort`, in order. */
  readonly tcpPorts: number[] = [];
  /** stdin bytes the driver fed to each exec, in order (null when none). */
  readonly stdin: (Uint8Array | null)[] = [];
  /** How many `kill()`s the driver issued. */
  killCount = 0;

  #seq = 0;
  #startCalls = 0;
  #opts: FakeContainerOptions;
  #execQueues = new Map<string, FakeExecResult[]>();

  constructor(options: FakeContainerOptions = {}) {
    this.#opts = options;
    this.running = options.running ?? false;
    for (const [key, value] of Object.entries(options.exec ?? {})) {
      this.#execQueues.set(key, Array.isArray(value) ? [...value] : [value]);
    }
  }

  /** The object handed to the driver: a Proxy that fails the test on any access
   *  outside {@link ALLOWED_SURFACE}. */
  asContainer(): Container {
    const target = this as unknown as Record<string | symbol, unknown>;
    return new Proxy(target, {
      get: (obj, prop) => {
        if (typeof prop === 'string') {
          if (FORBIDDEN.includes(prop)) {
            throw new Error(
              `driver touched "${prop}", which is not part of the raw ctx.container API ` +
                `(it belongs to @cloudflare/containers or @cloudflare/sandbox)`,
            );
          }
          if (!RECORDING_INTERNALS.has(prop)) this.accessed.add(prop);
        }
        // Read with the TARGET as receiver and bind methods to it: the fake keeps
        // its bookkeeping in private fields, and private-field access through a
        // Proxy receiver throws.
        const value = Reflect.get(obj, prop, obj);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(this) : value;
      },
    }) as unknown as Container;
  }

  /** Call ops in order, e.g. `['start', 'exec', 'destroy']`. */
  ops(): string[] {
    return this.calls.map((c) => c.op);
  }

  /** The options passed to the n-th `start()`. */
  startOptions(n = 0): Record<string, unknown> {
    const starts = this.calls.filter((c) => c.op === 'start');
    return (starts[n]?.args[0] ?? {}) as Record<string, unknown>;
  }

  /** The argv of the n-th `exec()`. */
  execArgv(n = 0): string[] {
    const execs = this.calls.filter((c) => c.op === 'exec');
    return (execs[n]?.args[0] ?? []) as string[];
  }

  /** The options of the n-th `exec()`. */
  execOptions(n = 0): Record<string, unknown> {
    const execs = this.calls.filter((c) => c.op === 'exec');
    return (execs[n]?.args[1] ?? {}) as Record<string, unknown>;
  }

  // ── the raw container API ──────────────────────────────────────────────────

  start(options?: unknown): void {
    this.#record('start', [options]);
    const n = this.#startCalls++;
    const thrown = this.#opts.onStart?.(n, options);
    if (typeof thrown === 'string') throw new Error(thrown);
    this.running = true;
  }

  async destroy(): Promise<void> {
    this.#record('destroy', []);
    if (this.#opts.destroyThrows) throw new Error(this.#opts.destroyThrows);
    this.running = false;
  }

  monitor(): Promise<void> {
    this.#record('monitor', []);
    const mode = this.#opts.monitor ?? 'pending';
    if (mode === 'resolve') return Promise.resolve();
    if (mode === 'reject') return Promise.reject(new Error('container stopped with an error'));
    return new Promise<void>(() => {
      /* never settles */
    });
  }

  async setInactivityTimeout(ms: number | bigint): Promise<void> {
    this.#record('setInactivityTimeout', [Number(ms)]);
    if (this.#opts.inactivityThrows) throw new Error(this.#opts.inactivityThrows);
  }

  getTcpPort(port: number): Fetcher {
    this.#record('getTcpPort', [port]);
    this.tcpPorts.push(port);
    const serve = this.#opts.portResponse;
    return {
      fetch: async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const request = input instanceof Request ? input : new Request(String(input), init);
        if (!serve) return new Response(`fake-port-${port}`, { status: 200 });
        return serve(port, request);
      },
    } as unknown as Fetcher;
  }

  async exec(argv: string[], options?: Record<string, unknown>): Promise<ExecProcess> {
    this.#record('exec', [[...argv], options ? { ...options } : undefined]);
    this.stdin.push(await drainStdin(options?.stdin));

    const key = argv.join(' ');
    const queue = this.#execQueues.get(key) ?? this.#execQueues.get('*');
    const spec: FakeExecResult = (queue && (queue.length > 1 ? queue.shift() : queue[0])) ?? {};
    if (spec.throws) throw new Error(spec.throws);

    const enc = new TextEncoder();
    const output: ExecOutput = {
      exitCode: spec.exitCode ?? 0,
      stdout: toArrayBuffer(enc.encode(spec.stdout ?? '')),
      stderr: toArrayBuffer(enc.encode(spec.stderr ?? '')),
    };
    const self = this;
    return {
      pid: 4242,
      stdin: null,
      stdout: null,
      stderr: null,
      exitCode: Promise.resolve(output.exitCode),
      output(): Promise<ExecOutput> {
        if (spec.hang) {
          return new Promise<ExecOutput>(() => {
            /* the documented over-capacity hang */
          });
        }
        return Promise.resolve(output);
      },
      kill(): void {
        self.killCount++;
      },
    } as unknown as ExecProcess;
  }

  #record(op: FakeCall['op'], args: readonly unknown[]): void {
    this.calls.push({ op, args, seq: this.#seq++ });
  }
}

/** Names that are part of the fake's own bookkeeping, not the platform surface. */
const RECORDING_INTERNALS = new Set([
  'calls',
  'accessed',
  'tcpPorts',
  'stdin',
  'killCount',
  'ops',
  'startOptions',
  'execArgv',
  'execOptions',
  'asContainer',
  'then',
  'constructor',
]);

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const out = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(out).set(bytes);
  return out;
}

async function drainStdin(stdin: unknown): Promise<Uint8Array | null> {
  if (stdin == null || typeof stdin === 'string') return null;
  const stream = stdin as ReadableStream<Uint8Array>;
  if (typeof stream.getReader !== 'function') return null;
  const reader = stream.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      parts.push(value);
      total += value.length;
    }
  }
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const p of parts) {
    out.set(p, cursor);
    cursor += p.length;
  }
  return out;
}
