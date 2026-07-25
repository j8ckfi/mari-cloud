import { defineConfig, devices } from '@playwright/test';
import { STORAGE_STATE } from './e2e/auth-paths';

// The e2e suite boots the real control plane (wrangler dev with DEV_SEED so a
// COLD computer exists, and DEV_AUTH so the seed can mint a session without an
// interactive login) plus the Vite dev server, then drives the app in Chromium.
// See decisions.md (web e2e) and the brief.

const CONTROL = process.env.MARI_CONTROL_PLANE ?? 'http://127.0.0.1:8787';

// `wrangler dev` binds and reads its text vars from wrangler.jsonc, NOT from the
// parent process env — so DEV_SEED/DEV_AUTH must be passed as `--var` overrides
// (the config defaults them to '0'), and the bind host/port pinned to CONTROL.
const CONTROL_URL = new URL(CONTROL);
const CONTROL_IP = CONTROL_URL.hostname || '127.0.0.1';
const CONTROL_PORT = CONTROL_URL.port || '8787';

// The dev server is BOUND on an explicit IPv4 address (Vite's default `localhost`
// binds IPv6-only on some machines) but the BROWSER reaches it by NAME.
//
// The name matters: a WebAuthn Relying Party ID must be a domain, and Chrome
// refuses a ceremony whose origin is an IP literal. `localhost` is the one host
// every browser accepts over plain http, so the passkey suite — and therefore the
// whole app in dev — must be visited as `http://localhost:PORT`. Chrome resolves
// `localhost` to ::1 first and falls back to 127.0.0.1, which is where Vite is.
const WEB_BIND_IP = process.env.MARI_WEB_BIND ?? '127.0.0.1';
const WEB_PORT = process.env.MARI_WEB_PORT ?? '5173';
const WEB = process.env.MARI_WEB_URL ?? `http://localhost:${WEB_PORT}`;

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
      // Control plane: wrangler dev with the dev seed + dev auth.
      //
      // `vite build` runs FIRST because wrangler's assets binding reads
      // `../web/dist` (packages/control-plane/wrangler.jsonc) — that is the
      // ONE-Worker-serves-both property, and e2e/assets.spec.ts asserts it
      // against this very server.
      //
      // BASE_URL is overridden to the origin the BROWSER uses. Better Auth
      // derives its trusted origin and the WebAuthn rpID from it, so a ceremony
      // driven from `http://localhost:5173` only verifies against a control plane
      // that knows that is where the app lives.
      //
      // `--enable-containers=false` keeps this suite off Docker. The Worker
      // declares a container image for the Cloudflare substrate, and `wrangler
      // dev` would otherwise BUILD that image before serving a single request —
      // minutes of work, and a hard dependency on a running daemon, for a suite
      // that drives the fake substrate and never materializes a computer.
      command:
        `pnpm --filter @mari/web build && ` +
        `pnpm --filter @mari/control-plane exec wrangler dev --enable-containers=false ` +
        `--ip ${CONTROL_IP} --port ${CONTROL_PORT} ` +
        `--var DEV_SEED:1 --var DEV_AUTH:1 --var BASE_URL:${WEB}`,
      url: `${CONTROL}/api/fleet`,
      env: { DEV_SEED: '1', DEV_AUTH: '1' },
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      // Web app: Vite dev server proxying /api and /attach to the control plane.
      command: `pnpm --filter @mari/web exec vite --host ${WEB_BIND_IP} --port ${WEB_PORT} --strictPort`,
      url: `http://${WEB_BIND_IP}:${WEB_PORT}`,
      env: { MARI_CONTROL_PLANE: CONTROL },
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
});
