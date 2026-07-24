// Boot a private instance: one call, one process (spec 11.2 "A private instance
// starts with one command").
//
// Order matters. The server is listening before the base image is snapshotted,
// because a materialized computer dials BACK into this server (`MARI_CONTROL_URL`)
// — the base-image bootstrap itself is one such computer.

import {
  applyBoundPort,
  createNodeRuntime,
  readConfig,
  type NodeConfig,
  type NodeRuntimeEnv,
} from './env.js';
import { createFetchHandler, startServer, type NodeServerHandle } from './server.js';
import { ensureBaseManifest } from './base-image.js';

export interface BootOptions extends Partial<NodeConfig> {
  /** Snapshot the base image at boot (spec §2). Default: true with a real
   *  substrate; the `fake` substrate has no container to snapshot. */
  baseSnapshot?: boolean;
  /** Progress sink; defaults to `console.log`. Pass `() => {}` in tests. */
  log?: (message: string) => void;
}

export interface NodeInstance {
  runtime: NodeRuntimeEnv;
  server: NodeServerHandle;
  /** `http://127.0.0.1:<port>` — the loopback address of this instance. */
  url: string;
  port: number;
  /** Resolves once the base image is snapshotted (or has failed). */
  baseManifest: Promise<string | null>;
  close(): Promise<void>;
}

export async function boot(options: BootOptions = {}): Promise<NodeInstance> {
  const { baseSnapshot, log: logOpt, ...configOverrides } = options;
  const log = logOpt ?? ((m: string) => console.log(`[mari] ${m}`));
  const config = readConfig(configOverrides);
  const runtime = await createNodeRuntime(config);
  const server = await startServer(runtime.env, config, createFetchHandler(runtime.env, config));
  applyBoundPort(runtime, server.port);

  log(`control plane listening on http://${config.hostname}:${server.port}`);
  log(`  chunk store   ${config.storeDir}${config.storeHostDir !== config.storeDir ? ` (daemon sees ${config.storeHostDir})` : ''}`);
  log(`  data          ${config.dataDir}`);
  log(`  substrate     ${runtime.substrate ? runtime.substrate.available.join(', ') : 'fake (no real substrate)'}`);
  log(`  computers dial ${config.supervisorUrlBase}/supervisor/{computer}`);
  log(`  web app       ${config.webDir ?? 'not built (API only)'}`);

  const wantsBase = baseSnapshot ?? runtime.substrate !== null;
  const baseManifest = wantsBase
    ? ensureBaseManifest(runtime, { log }).catch((err: unknown) => {
        log(`base image snapshot failed: ${String(err)}`);
        return null;
      })
    : Promise.resolve(null);

  return {
    runtime,
    server,
    url: server.url,
    port: server.port,
    baseManifest,
    async close() {
      await server.close();
      await runtime.computers.drain();
      await runtime.events.drain();
      runtime.computers.close();
      runtime.events.close();
      runtime.db.close();
    },
  };
}
