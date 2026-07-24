import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

// Component + unit tests run under jsdom. The Playwright e2e suite in `e2e/`
// is deliberately EXCLUDED here — it is driven by `playwright test`, not
// vitest, and importing `@playwright/test` under vitest would fail.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['test/**/*.{test,spec}.{ts,tsx}', 'src/**/*.{test,spec}.{ts,tsx}'],
    exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
    setupFiles: ['test/setup.ts'],
    css: false,
  },
});
