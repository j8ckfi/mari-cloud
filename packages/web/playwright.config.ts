import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './e2e/auth-paths';

// The e2e suite boots the real control plane (wrangler dev with DEV_SEED so a
// COLD computer exists, and DEV_AUTH so no interactive login is needed) plus
// the Vite dev server, then drives the app in Chromium. A separate integration
// agent runs and greens this suite; this config is the contract for how it
// boots. See decisions.md (web e2e) and the brief.

const CONTROL = process.env.MARI_CONTROL_PLANE ?? 'http://127.0.0.1:8787';
const WEB = process.env.MARI_WEB_URL ?? 'http://127.0.0.1:5173';

// `wrangler dev` binds and reads its text vars from wrangler.jsonc, NOT from the
// parent process env — so DEV_SEED/DEV_AUTH must be passed as `--var` overrides
// (the config defaults them to '0'), and the bind host/port pinned to CONTROL.
const CONTROL_URL = new URL(CONTROL);
const CONTROL_IP = CONTROL_URL.hostname || '127.0.0.1';
const CONTROL_PORT = CONTROL_URL.port || '8787';

const WEB_URL = new URL(WEB);
const WEB_IP = WEB_URL.hostname || '127.0.0.1';
const WEB_PORT = WEB_URL.port || '5173';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 45_000,
  expect: { timeout: 7_000 },
  reporter: 'list',
  use: {
    baseURL: WEB,
    trace: 'retain-on-failure',
    // A COLD render must never depend on WebGL. `--disable-gpu` reduces GPU use
    // but does NOT by itself force xterm onto its DOM renderer in headless
    // Chromium (software WebGL is still present); the terminal spec neutralizes
    // WebGL in-page so xterm falls back to the DOM renderer and its authoritative
    // buffer becomes assertable text (see e2e/terminal.spec.ts).
    launchOptions: { args: ['--disable-gpu'] },
  },
  projects: [
    // Runs first (after the webServers are up): seeds the control plane and
    // saves an authenticated storageState.
    { name: 'setup', testMatch: /global\.setup\.ts$/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: STORAGE_STATE },
      dependencies: ['setup'],
    },
  ],
  webServer: [
    {
      // Control plane: wrangler dev with the dev seed + dev auth. The vars are
      // passed as `--var` overrides because wrangler does not read them from the
      // process env (see CONTROL_* above).
      command: `pnpm --filter @mari/control-plane exec wrangler dev --ip ${CONTROL_IP} --port ${CONTROL_PORT} --var DEV_SEED:1 --var DEV_AUTH:1`,
      url: `${CONTROL}/api/fleet`,
      env: { DEV_SEED: '1', DEV_AUTH: '1' },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Web app: Vite dev server proxying /api and /attach to the control plane.
      // `--host` pins Vite to the same interface as WEB (its default `localhost`
      // binds IPv6-only on some machines, which the 127.0.0.1 URL can't reach).
      command: `pnpm --filter @mari/web exec vite --host ${WEB_IP} --port ${WEB_PORT} --strictPort`,
      url: WEB,
      env: { MARI_CONTROL_PLANE: CONTROL },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
