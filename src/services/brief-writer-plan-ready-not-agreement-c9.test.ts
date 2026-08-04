import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BriefWriterService } from './brief-writer-service.js';

// C9 (AC12) / B4 (R1.1): generatePlanningBrief used to tell plancore that PLAN-READY itself meant
// partner agreement was reached. That method is deleted — co-planner purposes (plan-draft /
// plan-reconcile / plan-signature) must not reintroduce PLAN-READY-as-agreement, and must not
// self-grant ingest permission. Only the engine may declare agreement.
describe('B4/C9 — PLAN-READY ≠ agreement; plancore authoring brief deleted', () => {
  const writer = new BriefWriterService();

  function planDraft() {
    return writer.generatePanelBrief({
      purpose: 'plan-draft',
      batchId: 'batch-C9',
      seat: 'c9-a',
      lens: 'whole-plan',
      projectDir: '/tmp/c9-proj',
      runDir: '/tmp/c9-run',
      callbacksFile: path.join('/tmp/c9-run', 'callbacks.md'),
    });
  }

  function planSignature() {
    return writer.generatePanelBrief({
      purpose: 'plan-signature',
      batchId: 'batch-C9',
      seat: 'c9-b',
      lens: 'whole-plan',
      projectDir: '/tmp/c9-proj',
      runDir: '/tmp/c9-run',
      callbacksFile: path.join('/tmp/c9-run', 'callbacks.md'),
      candidatePlanPath: '/tmp/c9-run/candidate-plan.md',
      candidateReqPath: '/tmp/c9-run/candidate-req.md',
    });
  }

  it('generatePlanningBrief is absent (deleted, not repurposed)', () => {
    expect(typeof (writer as { generatePlanningBrief?: unknown }).generatePlanningBrief).toBe(
      'undefined',
    );
  });

  it('plan-draft does not contain the misleading "plan agreed with" literal', () => {
    expect(planDraft().toLowerCase()).not.toContain('plan agreed with');
  });

  it('plan-draft / plan-signature do not gate on whole-plan agreement as PLAN-READY', () => {
    for (const brief of [planDraft(), planSignature()]) {
      expect(brief).not.toContain('agreement holds');
      expect(brief).not.toContain('only after **whole-plan** co-planner agreement');
      expect(brief).not.toContain('force PLAN-READY past it');
      // PLAN-READY must not be presented as agreement achieved
      expect(brief).not.toMatch(/PLAN-READY[\s\S]{0,80}agreement (holds|reached|achieved)/i);
    }
  });

  it('plan-draft terminal is DRAFT-SUBMITTED, not PLAN-READY agreement', () => {
    const brief = planDraft();
    expect(brief).toContain('DRAFT-SUBMITTED plan=<sha12>');
    expect(brief).not.toMatch(/STATUS:\s*PLAN-READY/);
  });

  it('plan-signature uses SIGNED / objection, not PLAN-READY as agreement', () => {
    const brief = planSignature();
    expect(brief).toMatch(/SIGNED plan=<sha12>|objection/i);
    expect(brief.toLowerCase()).not.toContain('plan agreed with');
  });
});
