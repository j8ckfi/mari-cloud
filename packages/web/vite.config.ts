import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The web app is a static SPA served by Vite in dev and any static host in
// prod. `/api` and `/attach` (the control-plane HTTP + WebSocket surface) are
// proxied to the control-plane dev server so the browser talks to one origin.
// The control-plane dev URL is configurable for the Playwright webServer.
const CONTROL_PLANE = process.env.MARI_CONTROL_PLANE ?? 'http://127.0.0.1:8787';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: CONTROL_PLANE, changeOrigin: true },
      '/attach': { target: CONTROL_PLANE, changeOrigin: true, ws: true },
    },
  },
  build: {
    target: 'es2023',
    sourcemap: true,
  },
});
