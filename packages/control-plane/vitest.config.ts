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
        },
      },
    }),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    // The substrate lane owns test/substrates/**; keep it out of this run.
    exclude: ['test/substrates/**', 'node_modules/**'],
  },
});
