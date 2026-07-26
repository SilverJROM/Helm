// T1: global test DB isolation.
// This runs via vitest setupFiles BEFORE test files load and any loadConfig() calls.
// Forces EVERY test (even those using loadConfig) to a unique per-process temp db.
// Never data/helm.db. Cleaned on process exit (temp files are fine to leak a bit).
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const tmp = path.join(os.tmpdir(), `helm-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
process.env.HELM_DB_PATH = tmp;

// Best-effort cleanup (tests should not leave it, but guard live)
process.on('exit', () => {
  try {
    fs.unlinkSync(tmp);
    fs.unlinkSync(tmp + '-wal');
    fs.unlinkSync(tmp + '-shm');
  } catch {}
});

// Also support vitest global cleanup hooks if available
try {
  // @ts-ignore - vitest may provide
  if (typeof afterAll === 'function') {
    // @ts-ignore
    afterAll(() => {
      try { fs.unlinkSync(tmp); fs.unlinkSync(tmp+'-wal'); fs.unlinkSync(tmp+'-shm'); } catch {}
    });
  }
} catch {}
