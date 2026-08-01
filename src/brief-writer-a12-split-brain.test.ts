import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { BriefWriterService } from './services/brief-writer-service.js';

/**
 * A12 / R1.7 / B4 — brief/engine split-brain closed.
 * generatePlanningBrief deleted (R1.1): plancore is not an authoring seat. Co-planner
 * plan-draft is seat-scoped DRAFT-SUBMITTED only — no plancore convene/iterate open loop.
 */

describe('A12 R1.7 brief/engine split-brain (B4: authoring brief deleted)', () => {
  const writer = new BriefWriterService();

  function planDraft() {
    return writer.generatePanelBrief({
      purpose: 'plan-draft',
      batchId: 'a12-test-batch',
      seat: 'a12-a',
      lens: 'whole-plan',
      requirement: 'A12 split-brain proof north-star',
      projectDir: '/tmp/a12-proj',
      runDir: '/tmp/a12-run',
      callbacksFile: path.join('/tmp/a12-run', 'callbacks.md'),
    });
  }

  it('generatePlanningBrief is deleted (structural signal: plancore not authoring)', () => {
    expect(typeof (writer as { generatePlanningBrief?: unknown }).generatePlanningBrief).toBe(
      'undefined',
    );
  });

  it('(a) plan-draft is seat-scoped draft only — no PLAN-READY self-declared agreement loop', () => {
    const brief = planDraft();
    // Forbidden open-loop phrases that re-open plancore-as-orchestrator split-brain
    for (const bad of [
      'Iterate until agreement',
      'iterate until agreement',
      'Pick co-planner per mode',
      'test harness spawns',
      'pending-policy',
      'default-pending',
      'pending-JROM',
    ]) {
      expect(brief.includes(bad), `forbidden split-brain phrase present: ${bad}`).toBe(false);
    }
    expect(brief).not.toMatch(/STATUS:\s*PLAN-READY/);
    expect(brief.toLowerCase()).not.toContain('plan agreed with');
  });

  it('(b) plan-draft emits DRAFT-SUBMITTED; never writes canonical; no TEMP markers', () => {
    const brief = planDraft();
    expect(brief).not.toMatch(/\bTEMP\b/);
    expect(brief.toLowerCase()).not.toContain('pending-policy');
    expect(brief).toContain('DRAFT-SUBMITTED plan=<sha12>');
    expect(brief).toMatch(/NEVER.*canonical `plan\.md`|never write canonical/i);
  });
});
