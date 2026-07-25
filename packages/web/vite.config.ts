import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app is a static SPA. In dev, Vite serves it and proxies `/api` and
// `/attach` (the control-plane HTTP + WebSocket surface) to the control-plane dev
// server so the browser talks to one origin. In production the SAME one-origin
// property holds for real: `pnpm --filter @mari/web build` writes `dist/`, which
// `packages/control-plane/wrangler.jsonc` binds as the Worker's static assets, so
// one Worker serves the app and the API.
const CONTROL_PLANE = process.env.MARI_CONTROL_PLANE ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      // `changeOrigin` rewrites only the HOST header. The browser's `Origin`
      // header passes through untouched, which is what Better Auth's trusted-
      // origin check and WebAuthn's `expectedOrigin` verification both read — so
      // a ceremony driven through this proxy is verified against the origin the
      // browser is really on (see the `BASE_URL` override in playwright.config).
      '/api': { target: CONTROL_PLANE, changeOrigin: true },
      '/attach': { target: CONTROL_PLANE, changeOrigin: true, ws: true },
    },
  },
  build: {
    // The Workers assets binding reads this directory (see wrangler.jsonc).
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2023',
    sourcemap: true,
  },
});
