import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Private-instance (Node runtime) tests. They run on plain Node — NOT the
// Workers pool — because the whole point is the Node platform: SQLite-backed
// Durable Objects, a filesystem chunk store, a real `ws` server, and a REAL
// Docker substrate.
//
// `cloudflare:workers` is aliased to the Node base class (src/node/cloudflare-workers.ts)
// so `computer-do.ts` / `events-do.ts` run UNFORKED here — the same source file
// serves both runtimes, which is the whole reason this alias exists rather than
// a second implementation.
//
// The Docker-dependent suite is gated on MARI_NODE_E2E=1 (see test/node/*.e2e.test.ts).

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('./src/node/cloudflare-workers.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/node/**/*.test.ts'],
    environment: 'node',
    // Container lifecycle, image work and real tier transitions are slow.
    testTimeout: 300_000,
    hookTimeout: 300_000,
    // One Docker daemon, one port space, shared container labels: no parallelism.
    fileParallelism: false,
    pool: 'forks',
  },
});
