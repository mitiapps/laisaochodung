import { defineConfig, devices } from '@playwright/test';

// Fixed ports of this project: the preview build on 5179, the vite dev server on 5180. E2E_PORT and
// E2E_DEV_PORT move them, and E2E_SERVERS (`preview`, `dev` or the default `both`) starts only one,
// so a host with a single free port can run the two projects one after the other.
const PORT = Number(process.env.E2E_PORT ?? 5179);
const DEV_PORT = Number(process.env.E2E_DEV_PORT ?? 5180);
const SERVERS = process.env.E2E_SERVERS ?? 'both';
if (!['both', 'preview', 'dev'].includes(SERVERS)) throw new Error(`E2E_SERVERS must be both, preview or dev, got "${SERVERS}"`);

/**
 * Specs that need the dev server: the dev-only `window.__laisaochodung.debugInfo()` and the dev UI
 * preview page (`dev/ui-preview.html`), which the production build leaves out.
 */
const DEV_SPECS = /(traffic-perf|hud-preview)\.spec\.js$/u;

const previewServer = {
  command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
  url: `http://localhost:${PORT}`,
  // Always a fresh production build: a server already on the port (say a stale dev server) fails
  // the run instead of being tested.
  reuseExistingServer: false,
  timeout: 180_000,
};
const devServer = {
  command: `npm run dev -- --port ${DEV_PORT} --strictPort`,
  url: `http://localhost:${DEV_PORT}`,
  reuseExistingServer: false,
  timeout: 180_000,
};

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  // One browser at a time: the full runs drive real-time WebGL in software and share the CPU.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: { trace: 'retain-on-failure' },
  // Bundled Chromium only; it launches headless on the dev host and in CI.
  projects: [
    ...(SERVERS === 'dev'
      ? []
      : [{ name: 'chromium', testIgnore: DEV_SPECS, use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${PORT}` } }]),
    ...(SERVERS === 'preview'
      ? []
      : [{ name: 'dev', testMatch: DEV_SPECS, use: { ...devices['Desktop Chrome'], baseURL: `http://localhost:${DEV_PORT}` } }]),
  ],
  webServer: [...(SERVERS === 'dev' ? [] : [previewServer]), ...(SERVERS === 'preview' ? [] : [devServer])],
});
