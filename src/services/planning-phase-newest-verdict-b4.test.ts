/**
 * B4 gate — waitForAgreement's newest-verdict fail-closed tracking (AC8).
 * Scope: planning-phase-service.ts's private waitForAgreement only.
 *
 * Bug this proves fixed: the reversed (newest-first) scan only marked a partner seat
 * "resolved" when its VERDICT-READY note actually parsed to CLEAN|BROKEN. If the seat's
 * NEWEST line was malformed, the scan kept walking backward and could latch an OLDER,
 * stale CLEAN/BROKEN for that same seat — a stale-side fail-open. The fix locks each seat
 * to its newest VERDICT-READY line (parseable or not) via a separate seen-set, so a
 * malformed newest line can never be walked past to older evidence.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PlanningPhaseService } from './planning-phase-service.js';

function svc(): any {
  return new PlanningPhaseService({} as any, {} as any, {} as any);
}

describe('waitForAgreement — newest-verdict fail-closed tracking (AC8)', () => {
  let runDir: string;
  let cbPath: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b4-newest-verdict-'));
    cbPath = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cbPath, '', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('older CLEAN then newer malformed VERDICT-READY for the same seat does not pass', async () => {
    const batchId = 'B4T1';
    const partnerBatchIds = [`${batchId}-partner`];
    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: looked fine\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — gibberish, not a verdict\n`,
      'utf8'
    );

    const agreed = await svc().waitForAgreement(cbPath, batchId, 'planner', 'plancore', 120, 0, partnerBatchIds);

    expect(agreed).toBe(false);
  });

  it('older BROKEN then newer CLEAN for the same seat can pass when PLAN-READY is present', async () => {
    const batchId = 'B4T2';
    const partnerBatchIds = [`${batchId}-partner`];
    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — BROKEN: missing validation criteria\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: re-reviewed, looks good now\n`,
      'utf8'
    );

    const agreed = await svc().waitForAgreement(cbPath, batchId, 'planner', 'plancore', 500, 0, partnerBatchIds);

    expect(agreed).toBe(true);
  });

  it('malformed newest line (no older verdict at all) remains non-agreement on a bounded short timeout', async () => {
    const batchId = 'B4T3';
    const partnerBatchIds = [`${batchId}-partner`];
    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — not a real verdict\n`,
      'utf8'
    );

    const start = Date.now();
    const agreed = await svc().waitForAgreement(cbPath, batchId, 'planner', 'plancore', 120, 0, partnerBatchIds);
    const elapsed = Date.now() - start;

    expect(agreed).toBe(false);
    // Bounded by the timeout passed in — proves this returns deterministically, not by hanging.
    expect(elapsed).toBeLessThan(1000);
  });

  it('regression: unanimous newest CLEAN across multiple partner seats still passes (seen-set break condition)', async () => {
    const batchId = 'B4T4';
    const partnerBatchIds = [`${batchId}-partner`, `${batchId}-partner-2`];
    await fs.appendFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: seat one agrees\n` +
        `[helm callback] planner ${batchId}-partner-2 STATUS: VERDICT-READY — CLEAN: seat two agrees\n`,
      'utf8'
    );

    const agreed = await svc().waitForAgreement(cbPath, batchId, 'planner', 'plancore', 500, 0, partnerBatchIds);

    expect(agreed).toBe(true);
  });
});
