// A2 (e2e-hang fix): runProjectTests wraps the project test command under
// `bash -lc 'set -o pipefail; timeout --signal=TERM --kill-after=Ks Ns <cmd>'` so a hung child
// (e.g. a Playwright webServer that never tears down) is genuinely SIGKILLed — not left to survive Node's
// SIGTERM-only execFile timeout. ANY nonzero exit → FAIL; 124/137 (timeout/killed) get a distinct note.
process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { OrchestratorLoop } from './orchestrator-loop.js';

const ENV_KEYS = ['HELM_PROJECT_TEST_CMD', 'HELM_PROJECT_TEST_ARGS', 'HELM_PROJECT_TEST_TIMEOUT_S', 'HELM_PROJECT_TEST_KILL_AFTER_S', 'HELM_A2_PIDFILE'];

describe('A2 runProjectTests timeout-wrap (fail-closed on a hung child)', () => {
  let runDir: string;
  let projectDir: string;
  let loop: OrchestratorLoop;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-a2-run-'));
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-a2-proj-'));
    loop = new OrchestratorLoop(new FakeTransport(), { runDir, batchId: 'batch-A2' });
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  });

  afterEach(async () => {
    for (const k of ENV_KEYS) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k]!;
    }
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(projectDir, { recursive: true, force: true }).catch(() => {});
  });

  it('exit-0 command → PASS', async () => {
    process.env.HELM_PROJECT_TEST_CMD = 'echo';
    process.env.HELM_PROJECT_TEST_ARGS = 'gate-ok';
    process.env.HELM_PROJECT_TEST_TIMEOUT_S = '30';
    const res = await (loop as any).runProjectTests(projectDir);
    expect(res.state).toBe('PASS');
    expect(res.note).toMatch(/PASS/);
    expect(res.note).toMatch(/gate-ok/);
  });

  it('nonzero-exit command → FAIL (plain FAIL note, not a timeout note)', async () => {
    process.env.HELM_PROJECT_TEST_CMD = 'false';
    process.env.HELM_PROJECT_TEST_ARGS = 'boom';
    process.env.HELM_PROJECT_TEST_TIMEOUT_S = '30';
    const res = await (loop as any).runProjectTests(projectDir);
    expect(res.state).toBe('FAIL');
    expect(res.note).toMatch(/FAIL/);
    expect(res.note).not.toMatch(/TIMEOUT/);
  });

  it('a TERM-IGNORING process tree under a 1s timeout → force-SIGKILLed, FAIL with a TIMEOUT note, NO descendant survives', async () => {
    // The incident case: a child that traps/ignores SIGTERM (like a detached webServer) survives the plain
    // TERM — only the --kill-after SIGKILL (sent to the whole `timeout` process GROUP) reaps it and its
    // descendants. `sleep` (which exits on TERM) would NOT prove this; a TERM-ignoring TREE does.
    const pidfile = path.join(projectDir, 'descendant.pid');
    const script = path.join(projectDir, 'hang.sh');
    await fs.writeFile(
      script,
      [
        '#!/usr/bin/env bash',
        "trap '' TERM",                                   // main ignores SIGTERM
        // a TERM-ignoring descendant that records its own pid and lives long (survives TERM; needs SIGKILL):
        `bash -c 'trap "" TERM; echo $$ > "$HELM_A2_PIDFILE"; while :; do sleep 0.5; done' &`,
        'wait'
      ].join('\n'),
      'utf8'
    );
    process.env.HELM_A2_PIDFILE = pidfile;
    process.env.HELM_PROJECT_TEST_CMD = 'bash';
    process.env.HELM_PROJECT_TEST_ARGS = script;
    process.env.HELM_PROJECT_TEST_TIMEOUT_S = '1';
    process.env.HELM_PROJECT_TEST_KILL_AFTER_S = '1'; // fast SIGKILL escalation for the test

    const t0 = Date.now();
    const res = await (loop as any).runProjectTests(projectDir);
    const elapsedMs = Date.now() - t0;

    expect(res.state).toBe('FAIL');
    expect(res.note).toMatch(/TIMEOUT/);
    // fast: TERM at 1s (ignored) + SIGKILL at ~2s — well under the child's own 300s+ lifetime.
    expect(elapsedMs).toBeLessThan(12000);

    // the descendant that IGNORED SIGTERM must have been force-killed (no surviving descendant).
    const pidRaw = await fs.readFile(pidfile, 'utf8').catch(() => '');
    const descPid = parseInt(pidRaw.trim(), 10);
    expect(Number.isFinite(descPid)).toBe(true);
    // poll briefly for the orphaned+killed pid to be reaped (ESRCH) — no more than a couple seconds.
    let alive = true;
    for (let i = 0; i < 30; i++) {
      try { process.kill(descPid, 0); alive = true; } catch { alive = false; }
      if (!alive) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    if (alive) { try { process.kill(descPid, 'SIGKILL'); } catch {} } // safety net so a leaked proc never lingers
    expect(alive).toBe(false);
  }, 20000);

  it('empty projectDir short-circuits to PASS (deterministic gate skipped)', async () => {
    const res = await (loop as any).runProjectTests('');
    expect(res.state).toBe('PASS');
    expect(res.note).toMatch(/skipped/);
  });
});
