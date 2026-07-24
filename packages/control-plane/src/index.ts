// Mari control plane: Hono app factory (Workers + Node parity), one Durable
// Object per computer, wake proxy, auth. Public surface re-exported here.

export { createApp } from './app';
export { handleFetch } from './handler';
export { ComputerDO } from './computer-do';
export { parsePreviewHost, type PreviewTarget } from './host';
export { MiniVtEngine, type GridEngine } from './grid';
export {
  makeSubstrate,
  FakeSubstrate,
  type SubstrateProvider,
  type SubstrateHandle,
  type MaterializeSpec,
  type ExecResult,
} from './substrate';
export * as manifestStore from './manifest-store';
export { default as worker } from './worker';
export type { Env, AppEnv, AuthedUser } from './types';
