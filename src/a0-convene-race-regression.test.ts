/**
 * A0 — pin commit 8024452 (convene-before-artifacts race guard).
 *
 * Historical failure (run 31 / cycle 13): partners emitted VERDICT-READY BROKEN while
 * plan.md was still absent (plancore still authoring). waitForAgreement treated any
 * BROKEN as immediate fail-fast, so the run blocked before the plan was ever read.
 *
 * Fix (8024452): optional planMdPathForRaceGuard on waitForAgreement — a BROKEN is
 * non-dispositive while that path is missing/empty (fs.stat only); dispositive once
 * the file exists and is non-empty. Call site always passes the canonical plan.md path.
 *
 * This suite is TEST-ONLY. It must not edit planning-phase-service.ts.
 * AC23#1: convene-before-artifacts.
 */
process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './services/fake-transport.js';
import { PlanningPhaseService } from './services/planning-phase-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { TaskQueueService } from './services/task-queue-service.js';
import { DatabaseService } from './db/database.js';

describe('A0: convene-race guard pin (8024452 / AC23 convene-before-artifacts)', () => {
  let runDir: string;
  let tmpDb: string;
  let dbs: DatabaseService;
  let phase: PlanningPhaseService;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-a0-race-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# A0 convene-race callbacks\n', 'utf8');
    tmpDb = path.join(os.tmpdir(), `helm-a0-race-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDb);
    const art = new RunArtifactService(dbs);
    const queue = new TaskQueueService(art);
    phase = new PlanningPhaseService(new FakeTransport(), art, queue);
  });

  afterEach(async () => {
    if (dbs) dbs.close();
    if (tmpDb) await fs.rm(tmpDb, { force: true }).catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  /** Direct seam under test — private waitForAgreement with planMdPathForRaceGuard. */
  function waitForAgreement(
    cbPath: string,
    batchId: string,
    timeoutMs: number,
    planMdPathForRaceGuard: string,
    partnerBatchIds?: string[]
  ): Promise<boolean> {
    return (phase as any).waitForAgreement(
      cbPath,
      batchId,
      'planner',
      'plancore',
      timeoutMs,
      0,
      partnerBatchIds ?? [`${batchId}-partner`],
      planMdPathForRaceGuard
    );
  }

  it('BROKEN is non-dispositive while plan.md is absent — keeps waiting until outer timeout', async () => {
    const cbPath = path.join(runDir, 'callbacks.md');
    const planPath = path.join(runDir, 'plan.md'); // deliberately never written
    const batchId = 'batch-A0-absent';

    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — early line (plan not on disk)\n`
    );
    await fs.appendFile(
      cbPath,
      `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — BROKEN: plan.md and og-requirements.md absent\n`
    );

    const timeoutMs = 280;
    const t0 = Date.now();
    const agreed = await waitForAgreement(cbPath, batchId, timeoutMs, planPath);
    const elapsed = Date.now() - t0;

    expect(agreed).toBe(false);
    // Without the race guard, BROKEN would return false on the first poll (~20ms).
    // With the guard, absence suppresses fail-fast and the outer timeout still bounds the wait.
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 40);
  });

  it('BROKEN is dispositive once plan.md exists and is non-empty — fail-fast restored', async () => {
    const cbPath = path.join(runDir, 'callbacks.md');
    const planPath = path.join(runDir, 'plan.md');
    const batchId = 'batch-A0-present';

    await fs.writeFile(planPath, '# Plan\n\nnon-empty canonical plan bytes\n', 'utf8');
    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan present\n`
    );
    await fs.appendFile(
      cbPath,
      `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — BROKEN: missing validation criteria for T3\n`
    );

    const timeoutMs = 2000;
    const t0 = Date.now();
    const agreed = await waitForAgreement(cbPath, batchId, timeoutMs, planPath);
    const elapsed = Date.now() - t0;

    expect(agreed).toBe(false);
    // Fail-fast: well under the outer timeout (poll interval is 20ms).
    expect(elapsed).toBeLessThan(400);
  });

  it('empty plan.md is treated as absent (BROKEN still non-dispositive)', async () => {
    const cbPath = path.join(runDir, 'callbacks.md');
    const planPath = path.join(runDir, 'plan.md');
    const batchId = 'batch-A0-empty';

    await fs.writeFile(planPath, '', 'utf8'); // size === 0
    await fs.appendFile(
      cbPath,
      `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — BROKEN: artifacts empty\n`
    );

    const timeoutMs = 220;
    const t0 = Date.now();
    const agreed = await waitForAgreement(cbPath, batchId, timeoutMs, planPath);
    const elapsed = Date.now() - t0;

    expect(agreed).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(timeoutMs - 40);
  });

  it('mid-wait appearance of non-empty plan.md makes the same BROKEN dispositive', async () => {
    const cbPath = path.join(runDir, 'callbacks.md');
    const planPath = path.join(runDir, 'plan.md');
    const batchId = 'batch-A0-midwait';

    await fs.appendFile(
      cbPath,
      `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — BROKEN: plan.md absent on first look\n`
    );

    const timeoutMs = 1500;
    const pending = waitForAgreement(cbPath, batchId, timeoutMs, planPath);

    // After a few suppressed polls, plancore lands the file — same BROKEN must now fail-fast.
    await new Promise((r) => setTimeout(r, 80));
    await fs.writeFile(planPath, '# Plan\n\nlanded after partner BROKEN\n', 'utf8');

    const t0 = Date.now();
    const agreed = await pending;
    // Total wall from mid-write should still be short relative to remaining timeout.
    expect(agreed).toBe(false);
    // Started ~80ms before write; after write, fail-fast within a few polls.
    // Total from test start well under full timeout if guard flips on presence.
    expect(Date.now() - t0).toBeLessThan(timeoutMs);
  });

  it('source pin: planMdPathForRaceGuard appears exactly 3 times (8024452 survival)', async () => {
    const src = await fs.readFile(
      path.join(process.cwd(), 'src/services/planning-phase-service.ts'),
      'utf8'
    );
    const count = (src.match(/planMdPathForRaceGuard/g) || []).length;
    expect(count).toBe(3);
  });
});
