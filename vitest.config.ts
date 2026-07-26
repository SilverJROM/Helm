import { defineConfig } from 'vitest/config';

// Several integration tests (p1-5a/p1-6a/p1-6b) launch a REAL tmux master session for the same OVM project
// (session name helm-<slug>). vitest runs test FILES in parallel by default, which races those tests on the
// shared OS-level tmux session (intermittent "new-session failed" / seq pollution). Serialize file execution so
// tmux-touching tests don't collide. This is correctness for shared-external-state integration tests, not a shim.
export default defineConfig({
  test: {
    fileParallelism: false,
    include: ['src/**/*.test.ts'],
    // T1: force all tests to use temp HELM_DB_PATH (set in setup before any loadConfig).
    // This makes it impossible for tests to ever resolve to the live data/helm.db via config.
    setupFiles: ['./src/test-setup.ts'],
    // POCFIX15: real-path waitForCallback/waitForVerdict are role-aware; the startRun integration tests
    // (planning→impl→validator→red-team in fake mode) legitimately exceed vitest's 5s default. 30s headroom.
    testTimeout: 30000,
  },
});
