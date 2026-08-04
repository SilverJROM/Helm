/**
 * R5.19 render-contract regression: purpose `diff-review` (implementation-diff / red-team review,
 * as distinct from planning drafts) must stay unaffected by B3's new plan-reconcile / plan-signature
 * bodies — no draft-authoring or candidate-reconciliation instructions leak into its rendered brief.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BriefWriterService } from './brief-writer-service.js';

const RUN_DIR = '/tmp/r519-diff-review-run';
const PROJECT_DIR = '/tmp/r519-diff-review-proj';

function generateDiffReview(overrides: Record<string, unknown> = {}) {
  const writer = new BriefWriterService();
  return writer.generatePanelBrief({
    purpose: 'diff-review',
    batchId: 'batch-R519-diff',
    seat: 'A',
    lens: 'correctness',
    requirement: 'review the implemented diff',
    implementedDiff: 'diff --git a/foo.ts b/foo.ts\n+export const x = 1;\n',
    projectDir: PROJECT_DIR,
    runDir: RUN_DIR,
    callbacksFile: path.join(RUN_DIR, 'callbacks.md'),
    ...overrides,
  } as Parameters<BriefWriterService['generatePanelBrief']>[0]);
}

describe('BriefWriterService.generatePanelBrief — diff-review unaffected by B3 (R5.19)', () => {
  it('retains the pre-B3 verdict grammar (VERDICT-READY / canonical plan contract)', () => {
    const brief = generateDiffReview();

    expect(brief).toContain('Panel purpose: diff-review');
    expect(brief).toContain('Canonical plan.md:');
    expect(brief).toContain('Canonical og-requirements.md:');
    expect(brief).toContain(
      '[helm callback] panelist batch-R519-diff STATUS: VERDICT-READY',
    );
    expect(brief).toMatch(/independent verdict only/i);
  });

  it('contains no draft-authoring instructions (plan-draft grammar)', () => {
    const brief = generateDiffReview();

    expect(brief).not.toMatch(/DRAFT-SUBMITTED/i);
    expect(brief).not.toMatch(/seat-scoped write targets/i);
    expect(brief).not.toMatch(/write \*\*only\*\* the seat-scoped paths/i);
    expect(brief).not.toMatch(/blind co-planner/i);
    expect(brief).not.toMatch(/independent whole-plan proposal/i);
  });

  it('contains no candidate-reconciliation or signature instructions (plan-reconcile / plan-signature grammar)', () => {
    const brief = generateDiffReview();

    expect(brief).not.toMatch(/CANDIDATE-SUBMITTED/i);
    expect(brief).not.toMatch(/reconciling round-1 co-planner drafts/i);
    expect(brief).not.toMatch(/round-1 draft/i);
    expect(brief).not.toMatch(/Candidate plan:/);
    expect(brief).not.toMatch(/Candidate requirements:/);
    expect(brief).not.toMatch(/reviewing a single reconciled candidate/i);
    expect(brief).not.toMatch(/STATUS: SIGNED/);
    expect(brief).not.toMatch(/STATUS: OBJECTIONS/);
    expect(brief).not.toMatch(/Expected candidate revision:/);
  });

  it('the schema / task-JSON contract shared by plan-draft and plan-reconcile does not leak into diff-review', () => {
    const brief = generateDiffReview();

    expect(brief).not.toContain('Schema / R-XX / task-JSON contract');
    expect(brief).not.toContain('"id":"T01"');
    expect(brief).not.toContain('COPY THIS EXACT EXAMPLE TASK');
  });
});
