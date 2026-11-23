import { defineConfig, devices } from '@playwright/test';

// Port 5179 is this project's fixed preview port.
const PORT = 5179;

export default defineConfig({
  testDir: 'tests/e2e',
  forbidOnly: !!process.env.CI,
  // One browser at a time: the full runs drive real-time WebGL in software and share the CPU.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
  },
  // Bundled Chromium only; it launches headless on the dev host and in CI.
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `npm run build && npm run preview -- --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Always a fresh production build: a server already on 5179 (say a stale dev server) fails
    // the run instead of being tested.
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
