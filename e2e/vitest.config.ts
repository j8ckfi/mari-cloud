import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// The cross-lane e2e suites run on plain Node against the REAL private instance
// (packages/control-plane/src/node), the REAL Docker substrate and the REAL
// `marid` binary. Nothing is stubbed.
//
// `root` is the REPO root because these tests import the control plane by path:
// `@mari/control-plane` publishes no entry map (it is bundled by esbuild for
// deployment), so the honest way in is the same relative import its own suites
// use. That also makes the `cloudflare:workers` alias below mandatory —
// `computer-do.ts` / `events-do.ts` are UNFORKED between the two runtimes and
// resolve that builtin to the Node base class (decisions.md, private-instance
// appendix).

const repoRoot = fileURLToPath(new URL('..', import.meta.url).href);

export default defineConfig({
  resolve: {
    alias: {
      'cloudflare:workers': fileURLToPath(
        new URL('../packages/control-plane/src/node/cloudflare-workers.ts', import.meta.url).href,
      ),
    },
  },
  test: {
    root: repoRoot,
    include: ['e2e/**/*.e2e.test.ts'],
    environment: 'node',
    // Container lifecycle, cold restores and a ~10 s run: these are minutes, not
    // milliseconds. Every wait inside the suites is separately bounded.
    testTimeout: 900_000,
    hookTimeout: 1_800_000,
    // One Docker daemon, one label namespace, one port space.
    fileParallelism: false,
    pool: 'forks',
    // Ungated (no MARI_LOOP_E2E=1) the suites collect zero tests on purpose;
    // `pnpm -r test` must stay green on a machine with no Docker.
    passWithNoTests: true,
    // The measured transition times (spec 13's open item) are the point of a
    // green run, not only of a red one; vitest's console interception hides
    // stdout from a file that passed.
    disableConsoleIntercept: true,
  },
});
