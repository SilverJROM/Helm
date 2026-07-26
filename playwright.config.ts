import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 60 * 1000,
  expect: { timeout: 10 * 1000 },
  fullyParallel: false, // shared-state e2e suite (one server + db); serial for determinism (B11)
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1, // shared single server + sqlite db across specs -> serial is required (parallel causes db/state contention; B11)
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3111',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  // Dedicated, isolated test server: fresh temp DB (triggers seed incl. implementer default),
  // USE_FAKE_TMUX so worker/master lifecycles are deterministic, port 3111 so it never collides
  // with the real pm2 'helm' on 3110. Always fresh (reuseExistingServer:false).
  webServer: {
    command: 'rm -f /tmp/helm-e2e.db* && USE_FAKE_TMUX=1 HELM_PORT=3111 HELM_HOST=127.0.0.1 HELM_DB_PATH=/tmp/helm-e2e.db node dist/index.js',
    url: 'http://localhost:3111/health',
    reuseExistingServer: false,
    timeout: 120 * 1000,
  },
});