// review #3 (per-task recheck): the OrchestratorLoop rechecks the ACTUALLY-resolved per-task/rung seat
// binary at the dispatch boundary (before transport.spawn), via the injected verifySeatBinary hook — so a
// model resolved AFTER the run-start roster preflight cannot spawn a doomed seat that only fails as a
// generic 30-60s ready-probe timeout.
process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { OrchestratorLoop } from './orchestrator-loop.js';

// Minimal escalation stub: resolves a validator rung-0 seat to codex/gpt-5.5 (the harness's escalation
// target — exactly the kind of "resolved later" binary review #3 is about).
const fakeEsc: any = {
  getModelForRung: () => 'gpt-5.5',
  getProviderForRung: () => 'codex',
  getLaunchableModel: (m: string) => m,
  getProviderForModel: () => 'codex',
  getRouteForModel: () => null
};

describe('review #3 — dispatch-boundary seat-binary recheck (verifySeatBinary)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r3-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# r3\n', 'utf8');
  });
  afterEach(async () => {
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('a MISSING resolved binary → refuses BEFORE spawn (no doomed seat), clear error', async () => {
    let spawnCalled = false;
    const transport: any = {
      spawn: async () => { spawnCalled = true; return { handle: 'h', role: 'validator' }; },
      reap: async () => {}
    };
    const loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-R3',
      escalationService: fakeEsc,
      verifySeatBinary: async (_p: string, _m: string) => ({ ok: false, reason: `codex/gpt-5.5 CLI 'codex' not found on seat PATH` })
    });

    await expect(
      (loop as any).performRolePhase('validator', 'validate this', ['PASS', 'FAIL'])
    ).rejects.toThrow(/seat binary missing at dispatch.*not on seat PATH/i);
    expect(spawnCalled).toBe(false); // never spawned a doomed seat
  });

  it('a PRESENT resolved binary → proceeds to spawn (recheck is a no-op on the happy path)', async () => {
    let spawnCalled = false;
    let verifiedWith: string[] = [];
    const transport: any = {
      // record that spawn was reached, then short-circuit so the test doesn't wait for a callback.
      spawn: async () => { spawnCalled = true; throw new Error('SPAWN_REACHED_SENTINEL'); },
      reap: async () => {}
    };
    const loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-R3',
      escalationService: fakeEsc,
      verifySeatBinary: async (p: string, m: string) => { verifiedWith = [p, m]; return { ok: true, bin: 'codex' }; }
    });

    await expect(
      (loop as any).performRolePhase('validator', 'validate this', ['PASS', 'FAIL'])
    ).rejects.toThrow(/SPAWN_REACHED_SENTINEL/);
    expect(spawnCalled).toBe(true);
    expect(verifiedWith).toEqual(['codex', 'gpt-5.5']); // rechecked the actually-resolved seat
  });
});
