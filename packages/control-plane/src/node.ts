// Node entry for private instances (spec 11.2, decisions.md deviation 4).
//
// The Node runtime runs the SAME Hono app and the SAME `ComputerDO` /`EventsDO`
// classes as the Workers entry; only the platform underneath differs, and it
// lives in `./node/`:
//
//   Durable Object   `node/namespace.ts` + `node/state.ts` — one actor per
//                    computer id, SQLite storage (`node/sql.ts`), a persisted
//                    alarm driving the tier policy (spec 4.4)
//   D1               `node/d1.ts`   — local SQLite
//   R2               `node/r2.ts`   — a directory keyed by contracts.md §9, the
//                    same directory `marid` opens as `fs:///store`
//   WebSockets       `node/server.ts` — a real `ws` server bridged onto the
//                    `WebSocketPair` the DO answers with
//   Substrate        `node/substrate.ts` — Docker/Sprites selected per wake
//                    (spec 3.6), not the test fake
//
// Run it: `node dist/node.mjs` (see deploy/README.md), or `boot()` from a test.

export { boot, type BootOptions, type NodeInstance } from './node/boot.js';
export { readConfig, createNodeRuntime, type NodeConfig, type NodeRuntimeEnv } from './node/env.js';
export { ensureBaseManifest, baseComputerId, basePointerKey } from './node/base-image.js';

import { boot } from './node/boot.js';

/** Boot when executed directly (`node dist/node.mjs`), not when imported. */
const executedDirectly =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  import.meta.url === new URL(`file://${process.argv[1]}`).href;

if (executedDirectly) {
  const instance = await boot();
  const shutdown = (signal: string) => {
    console.log(`[mari] ${signal}: shutting down`);
    void instance.close().then(() => process.exit(0));
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
