/**
 * B5 gate — waitForAgreement's current-plan SHA binding (AC7/AC23).
 * Scope: planning-phase-service.ts's private waitForAgreement only.
 *
 * Bug this proves fixed: after B4's newest-line fail-closed tracking, a CLEAN verdict
 * still only checked the bare CLEAN|BROKEN enum in the note — it never bound that CLEAN
 * to the plan.md bytes the seat actually reviewed. A seat that CLEAN'd an OLD plan
 * revision still counted as agreement even after plancore rewrote plan.md to a new
 * revision, because nothing checked `plan=<sha12>` against the plan.md currently on
 * disk. The fix (B5): every accepted CLEAN must carry a `plan=<sha12>` (B3 grammar)
 * that matches the LIVE plan.md short12 (B1's readPlanRevision), re-derived on every
 * poll pass so a plancore rewrite mid-wait is picked up immediately.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlanningPhaseService } from './planning-phase-service.js';
import { planRevision } from './plan-revision.js';

function svc(): any {
  return new PlanningPhaseService({} as any, {} as any, {} as any);
}

describe('waitForAgreement — current-plan SHA binding (AC7/AC23)', () => {
  let runDir: string;
  let cbPath: string;
  let planPath: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b5-plan-sha-'));
    cbPath = path.join(runDir, 'callbacks.md');
    planPath = path.join(runDir, 'plan.md');
    await fs.writeFile(cbPath, '', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('seat A CLEAN on R1, plan.md changes to R2, seat B CLEAN on R2 — gate refuses (A never reviewed R2)', async () => {
    const batchId = 'B5T1';
    const partnerBatchIds = [`${batchId}-partner`, `${batchId}-partner-2`];
    const r1 = planRevision('# Plan R1\n');
    const r2 = planRevision('# Plan R2\n');
    // Seat A reviews and CLEANs revision R1 while plan.md is still R1 bytes.
    await fs.writeFile(planPath, '# Plan R1\n', 'utf8');
    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN plan=${r1.short12} seat A reviewed R1\n`,
      'utf8'
    );
    // plancore rewrites plan.md to R2; seat B reviews and CLEANs the NEW revision. Seat A never re-emits.
    await fs.writeFile(planPath, '# Plan R2\n', 'utf8');
    await fs.appendFile(
      cbPath,
      `[helm callback] planner ${batchId}-partner-2 STATUS: VERDICT-READY — CLEAN plan=${r2.short12} seat B reviewed R2\n`,
      'utf8'
    );

    const start = Date.now();
    const agreed = await svc().waitForAgreement(cbPath, batchId, 'planner', 'plancore', 200, 0, partnerBatchIds, planPath, planPath);
    const elapsed = Date.now() - start;

    expect(agreed).toBe(false);
    // Bounded by the timeout passed in — proves a deterministic refusal, not a hang.
    expect(elapsed).toBeLessThan(1000);
  });

  it('all configured seats CLEAN for the current R2 short12 plus PLAN-READY passes', async () => {
    const batchId = 'B5T2';
    const partnerBatchIds = [`${batchId}-partner`, `${batchId}-partner-2`];
    const r2 = planRevision('# Plan R2\n');
    await fs.writeFile(planPath, '# Plan R2\n', 'utf8');
    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN plan=${r2.short12} seat A reviewed R2\n` +
        `[helm callback] planner ${batchId}-partner-2 STATUS: VERDICT-READY — CLEAN plan=${r2.short12} seat B reviewed R2\n`,
      'utf8'
    );

    const agreed = await svc().waitForAgreement(cbPath, batchId, 'planner', 'plancore', 500, 0, partnerBatchIds, planPath, planPath);

    expect(agreed).toBe(true);
  });

  it('CLEAN with missing or nonmatching plan= does not count as agreement', async () => {
    const batchId = 'B5T3';
    const r2 = planRevision('# Plan R2\n');
    await fs.writeFile(planPath, '# Plan R2\n', 'utf8');

    // Case 1: CLEAN with no plan= field at all.
    const partnerBatchIdsMissing = [`${batchId}m-partner`];
    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId}m STATUS: PLAN-READY — plan agreed\n` +
        `[helm callback] planner ${batchId}m-partner STATUS: VERDICT-READY — CLEAN no sha here\n`,
      'utf8'
    );
    const agreedMissing = await svc().waitForAgreement(cbPath, `${batchId}m`, 'planner', 'plancore', 120, 0, partnerBatchIdsMissing, planPath, planPath);
    expect(agreedMissing).toBe(false);

    // Case 2: CLEAN with a well-formed but nonmatching (superseded) sha.
    const staleSha = planRevision('# Plan STALE\n').short12;
    const partnerBatchIdsStale = [`${batchId}s-partner`];
    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId}s STATUS: PLAN-READY — plan agreed\n` +
        `[helm callback] planner ${batchId}s-partner STATUS: VERDICT-READY — CLEAN plan=${staleSha} reviewed a superseded revision\n`,
      'utf8'
    );
    const agreedStale = await svc().waitForAgreement(cbPath, `${batchId}s`, 'planner', 'plancore', 120, 0, partnerBatchIdsStale, planPath, planPath);
    expect(agreedStale).toBe(false);
    expect(staleSha).not.toBe(r2.short12);
  });

  it('a BROKEN verdict still fails closed/dispositively under the existing raceguard behavior', async () => {
    const batchId = 'B5T4';
    const partnerBatchIds = [`${batchId}-partner`];
    const r2 = planRevision('# Plan R2\n');
    await fs.writeFile(planPath, '# Plan R2\n', 'utf8');
    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — BROKEN plan=${r2.short12} missing validation criteria\n`,
      'utf8'
    );

    const start = Date.now();
    // planPath exists and is non-empty, so the raceguard does not suppress this BROKEN — dispositive fast-fail.
    const agreed = await svc().waitForAgreement(cbPath, batchId, 'planner', 'plancore', 5000, 0, partnerBatchIds, planPath, planPath);
    const elapsed = Date.now() - start;

    expect(agreed).toBe(false);
    // Dispositive: returns almost immediately, not after burning the full 5s timeout.
    expect(elapsed).toBeLessThan(500);
  });
});
