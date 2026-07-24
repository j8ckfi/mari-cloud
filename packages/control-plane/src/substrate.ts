// Control-plane view of the substrate driver.
//
// The canonical provider interface (spec 3.5's six functions) is owned by the
// substrate lane at `./substrates/provider.ts`. This module imports that
// interface (type-only, so no driver code — dockerode etc. — is pulled into the
// control-plane/Workers bundle) and provides:
//   - `FakeSubstrate`: the injected/faked driver for control-plane tests
//     (decisions.md), recording every call for behavioral assertions;
//   - `makeSubstrate`: the selector used by the Durable Object.
//
// Real drivers (Docker, Sprites) are constructed via the substrate lane's
// `createSubstrate` / `selectSubstrate` (`./substrates`), which the wake path
// wires at the private-instance / Docker-e2e milestone; v0 control-plane tests
// drive the fake.

import type {
  SubstrateProvider,
  SubstrateHandle,
  MaterializeSpec,
  ExecOptions,
  ExecResult,
} from './substrates/provider';

export type {
  SubstrateProvider,
  SubstrateHandle,
  MaterializeSpec,
  ExecOptions,
  ExecResult,
} from './substrates/provider';

/** One recorded driver call, for test observability. */
export interface SubstrateCall {
  op: 'materialize' | 'destroy' | 'sleep' | 'wake' | 'exec' | 'exposePort';
  at: number;
  detail?: unknown;
}

/**
 * In-memory fake implementing the canonical {@link SubstrateProvider}. Stored as
 * a field on the Durable Object so a test reaches its `calls` log via
 * `runInDurableObject(stub, (do) => do.substrate.calls)`.
 */
export class FakeSubstrate implements SubstrateProvider {
  readonly calls: SubstrateCall[] = [];
  /** Every `materialize` spec, so a test can assert the CONFIGURATION the DO
   *  hands `marid` (contracts.md §5.1 / crates/marid/src/config.rs) and not just
   *  that a call happened. */
  readonly specs: MaterializeSpec[] = [];
  #seq = 0;

  /** Count of wake-ish operations, for "did browsing wake it?" assertions. */
  get wakeCount(): number {
    return this.calls.filter((c) => c.op === 'wake' || c.op === 'materialize').length;
  }

  /** The most recent materialize spec, or null. */
  get lastSpec(): MaterializeSpec | null {
    return this.specs.length === 0 ? null : (this.specs[this.specs.length - 1] as MaterializeSpec);
  }

  async materialize(spec: MaterializeSpec): Promise<SubstrateHandle> {
    this.calls.push({ op: 'materialize', at: Date.now(), detail: spec.computer });
    this.specs.push(spec);
    return { substrate: 'fake', computer: spec.computer, id: `fake-${++this.#seq}` };
  }

  async destroy(handle: SubstrateHandle): Promise<void> {
    this.calls.push({ op: 'destroy', at: Date.now(), detail: handle.id });
  }

  async sleep(handle: SubstrateHandle): Promise<void> {
    this.calls.push({ op: 'sleep', at: Date.now(), detail: handle.id });
  }

  async wake(handle: SubstrateHandle): Promise<void> {
    this.calls.push({ op: 'wake', at: Date.now(), detail: handle.id });
  }

  async exec(
    handle: SubstrateHandle,
    argv: readonly string[],
    _opts?: ExecOptions,
  ): Promise<ExecResult> {
    this.calls.push({ op: 'exec', at: Date.now(), detail: argv });
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  async exposePort(handle: SubstrateHandle, port: number): Promise<string> {
    this.calls.push({ op: 'exposePort', at: Date.now(), detail: port });
    // A deterministic address; the DO proxy reaches it through an injectable
    // `upstreamFetch`, so the host here is intercepted in tests.
    return `http://${handle.id}.exposed.invalid:${port}`;
  }
}

/** The part of `Env` this module reads. Typed structurally so `substrate.ts`
 *  does not import the binding types (and so nothing Node-only is reachable
 *  from the Workers bundle — see below). */
interface SubstrateEnv {
  SUBSTRATE_MODE?: string;
  SUBSTRATE?: SubstrateProvider;
}

/**
 * Choose the substrate driver for a Durable Object.
 *
 * A REAL driver is never constructed here: Docker needs dockerode and a daemon
 * socket, neither of which exists on Workers, and even a dynamic `import()`
 * would drag the module into the Workers bundle. Instead the private-instance
 * runtime performs the spec §3.6 selection itself (`src/node/substrate.ts`) and
 * INJECTS the ready driver as `env.SUBSTRATE`. The Workers entry leaves that
 * unset and gets the fake, so the DO never accidentally hits a real API.
 */
export function makeSubstrate(
  mode: string | undefined,
  env?: SubstrateEnv,
): SubstrateProvider {
  const injected = env?.SUBSTRATE;
  if (injected && mode !== 'fake') return injected;
  switch (mode) {
    case 'fake':
    default:
      return new FakeSubstrate();
  }
}
