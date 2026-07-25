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

/** How long `close()` waits for outstanding background work before abandoning it. */
const SHUTDOWN_DRAIN_MS = 5_000;

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

/**
 * Instantiate the Durable Object of every computer the fleet knows about, which
 * re-arms its persisted alarm (`NodeDurableObjectStorage.rearm`).
 *
 * The fleet table is the index of computers; a Durable Object file with no fleet
 * row belongs to a deleted computer and has nothing left to schedule. Failures
 * are logged, never fatal: a private instance must boot even if one computer's
 * storage is unreadable.
 */
async function reviveComputers(
  runtime: NodeRuntimeEnv,
  log: (message: string) => void,
): Promise<number> {
  let ids: string[] = [];
  try {
    const rows = await runtime.db.prepare(`SELECT id FROM computers`).all<{ id: string }>();
    ids = (rows.results ?? []).map((r) => String(r.id));
  } catch (err) {
    log(`could not list computers to revive their alarms: ${String(err)}`);
    return 0;
  }
  let revived = 0;
  for (const id of ids) {
    try {
      const state = runtime.computers.stateFor(id);
      await state.ready();
      if ((await state.storage.getAlarm()) !== null) revived++;
    } catch (err) {
      log(`could not revive computer ${id}: ${String(err)}`);
    }
  }
  return revived;
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

  // REVIVE EVERY COMPUTER'S DEADLINES BEFORE ANNOUNCING READY.
  //
  // A Durable Object's alarm is persisted, but the Node namespace creates objects
  // LAZILY — so after a restart the tier deadline, a pending wake retry, the
  // liveness check and the WAKING watchdog of every computer sit in SQLite and
  // fire only once something happens to touch that object. A private instance
  // restarted while a computer was AWAKE or WAKING would therefore leave it in
  // that state indefinitely, which is the same wedge class as a substrate that
  // dies without telling anyone: a state that cannot advance without an external
  // event. Touching each computer re-arms its alarm (namespace.ts), and nothing
  // else here depends on the result.
  const revived = await reviveComputers(runtime, log);
  if (revived > 0) log(`  revived       ${revived} computer alarm(s) after restart`);

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
      // BOUNDED. `drain()` waits for every outstanding `waitUntil`, and one of
      // those can be a wake sitting on a substrate call — which has its own budget
      // (WAKE_TIMEOUT_MS, up to two minutes) but must not hold a shutdown open for
      // it. Whatever is still pending is abandoned here; the computer's own
      // persisted deadlines pick it up at the next boot (see reviveComputers and
      // the WAKING watchdog), which is exactly the crash-recovery path.
      const drained = Promise.all([runtime.computers.drain(), runtime.events.drain()]);
      await Promise.race([
        drained.then(() => undefined),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, SHUTDOWN_DRAIN_MS);
          timer.unref?.();
        }),
      ]);
      runtime.computers.close();
      runtime.events.close();
      runtime.db.close();
    },
  };
}
