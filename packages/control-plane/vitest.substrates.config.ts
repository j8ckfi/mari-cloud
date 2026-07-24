import { defineConfig } from 'vitest/config';

// Substrate-driver tests run on plain Node (NOT the Workers pool): the Docker
// driver needs dockerode + the docker socket, and the Sprites mock uses a real
// node:http server. `pnpm --filter @mari/control-plane test:substrates` points
// here.
export default defineConfig({
  test: {
    include: ['test/substrates/**/*.test.ts'],
    environment: 'node',
    // Real container lifecycle + image pulls are slow.
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // One daemon, shared container handles across sequential `it`s — no
    // cross-file parallelism.
    fileParallelism: false,
    pool: 'forks',
  },
});
