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
  #seq = 0;

  /** Count of wake-ish operations, for "did browsing wake it?" assertions. */
  get wakeCount(): number {
    return this.calls.filter((c) => c.op === 'wake' || c.op === 'materialize').length;
  }

  async materialize(spec: MaterializeSpec): Promise<SubstrateHandle> {
    this.calls.push({ op: 'materialize', at: Date.now(), detail: spec.computer });
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

/**
 * Choose a substrate driver from the environment. v0 control-plane: only the
 * fake is constructed here (real drivers live behind `./substrates`'
 * `createSubstrate`/`selectSubstrate`, wired at the Docker-e2e / private-instance
 * milestone). Defaults to the fake so the DO never accidentally hits a real API.
 */
export function makeSubstrate(mode: string | undefined): SubstrateProvider {
  switch (mode) {
    case 'fake':
    default:
      return new FakeSubstrate();
  }
}
