// Vitest config for the control plane — runs on
// @cloudflare/vitest-pool-workers (Vitest 4 integration) with REAL bindings
// (DO + D1 + R2), no platform mocks (decisions.md testing philosophy). The
// substrate suite has its own config (vitest.substrates.config.ts, other lane)
// and is NOT run here.
//
// In this pool version (0.18.x, Vitest ^4.1) the integration registers as a
// Vite plugin (`cloudflareTest`), not via `test.poolOptions`.

import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: './src/worker.ts',
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Test-time binding/var overrides (override wrangler `vars`).
        bindings: {
          PREVIEW_ZONE: 'mari.sh',
          DEV_AUTH: '1',
          DEV_SEED: '1',
          SUBSTRATE_MODE: 'fake',
          AUTH_SECRET: 'test-secret-not-for-prod',
          BASE_URL: 'http://localhost',
          // Short tier thresholds; the alarm harness fires regardless of
          // wall-clock, so exact values are moot.
          WARM_IDLE_MS: '1000',
          COLD_IDLE_MS: '2000',
          // Liveness / recovery windows (computer-do.ts). The ORDER matters, not
          // just the magnitudes: the single alarm processes the EARLIEST pending
          // deadline, so the supervisor-loss grace is deliberately shorter than
          // the tier deadline (as it is in production: 15 s against 5 min) and a
          // suite that fires the alarm after a socket close gets the liveness
          // check rather than the tier policy.
          SUPERVISOR_GRACE_MS: '400',
          // Comfortably longer than any AWAKE-with-work window a suite holds
          // open: the health check must not start probing a computer a test is
          // still using. Suites that want it drive the alarm themselves.
          LIVENESS_MS: '3000',
          // Longer than the tier tests' own polling, so a clean handshake is
          // never raced by its own deadline; the suite that tests the deadline
          // fires the alarm instead of waiting.
          COLD_FINALIZE_MS: '3000',
          WAKE_TIMEOUT_MS: '2000',
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // The substrate lane owns test/substrates/**, and test/node/** is the
    // private-instance runtime (plain Node, its own config —
    // vitest.node.config.ts). Neither belongs in the Workers pool.
    exclude: ['test/substrates/**', 'test/node/**', 'node_modules/**'],
  },
});
