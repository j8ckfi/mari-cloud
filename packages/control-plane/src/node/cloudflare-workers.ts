// The `cloudflare:workers` module, for Node (spec 11.2 private instances).
//
// `computer-do.ts` and `events-do.ts` are the ONE implementation of their logic
// (decisions.md forbids a second copy), so the Node runtime does not fork them:
// it aliases the `cloudflare:workers` builtin to this module (vitest
// `resolve.alias`, esbuild `alias` — see vitest.node.config.ts and
// scripts/build-node.mjs) and supplies the platform underneath.
//
// The base class is deliberately as thin as workerd's: it holds `ctx` and `env`
// and nothing else. Everything a Durable Object actually uses — SQLite storage,
// KV, alarms, `blockConcurrencyWhile`, `waitUntil`, WebSocket upgrade responses
// — lives in the state/namespace shims (`state.ts`, `namespace.ts`), which is
// where the semantics have to match.

/** Minimal structural mirror of workerd's `DurableObjectState`. */
export interface NodeDurableObjectState {
  readonly id: { toString(): string; readonly name?: string };
  readonly storage: unknown;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * The base class every Durable Object extends. Mirrors
 * `cloudflare:workers`' `DurableObject`: the constructor stores the state and
 * environment, and subclasses override `fetch`/`alarm`.
 */
export class DurableObject<Env = unknown> {
  constructor(
    readonly ctx: NodeDurableObjectState,
    readonly env: Env,
  ) {}

  /** Overridden by subclasses that terminate HTTP/WebSocket requests. */
  fetch(_request: Request): Response | Promise<Response> {
    return new Response('not found', { status: 404 });
  }

  /** Overridden by subclasses that schedule alarms (the tier policy). */
  alarm(): void | Promise<void> {}
}

/** Present for API-shape parity; unused by Mari's objects. */
export class RpcTarget {}

/** Present for API-shape parity; unused by Mari's objects. */
export class WorkerEntrypoint<Env = unknown> {
  constructor(
    readonly ctx: unknown,
    readonly env: Env,
  ) {}
}
