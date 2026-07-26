import { defineConfig, devices } from '@playwright/test';

/** Live capstone — targets pm2 helm on :3110; no isolated webServer. */
export default defineConfig({
  testDir: './e2e',
  // A1 (F5, plan §1.8a): widened once so a newly added `<row-id>.live.spec.ts` is collected
  // alongside the pre-existing batch-cap-projects.spec.ts — previously only the latter matched,
  // so a new live spec silently ran nothing against :3110.
  testMatch: /(batch-cap-projects\.spec|[AB]\d+\.live\.spec)\.ts$/,
  timeout: 180 * 1000,
  expect: { timeout: 30 * 1000 },
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:3110',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});