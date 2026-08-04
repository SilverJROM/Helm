import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BriefWriterService } from './brief-writer-service.js';
import { planRevision } from './plan-revision.js';

// B2 (AC6/AC14): generatePanelBrief used to pass planPath:'plan.json' and never named
// og-requirements.md or a plan revision — partner panel seats had to guess where the
// canonical plan lived. This proves the generated brief now tells them exactly.
describe('BriefWriterService.generatePanelBrief — canonical plan contract (B2)', () => {
  it('names the absolute plan.md + og-requirements.md paths and the expected revision when plan.md is readable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-panel-readable-'));
    const planBytes = '# plan\n\n```json\n[]\n```\n';
    fs.writeFileSync(path.join(tmp, 'plan.md'), planBytes);
    const expected = planRevision(planBytes);

    const writer = new BriefWriterService();
    const brief = writer.generatePanelBrief({
      purpose: 'diff-review',
      batchId: 'batch-B2-readable',
      seat: 'A',
      lens: 'correctness',
      requirement: 'agreement must bind to the exact plan revision reviewed',
      projectDir: tmp,
      callbacksFile: path.join(tmp, 'callbacks.md'),
    });

    expect(brief).toContain(`Plan: ${path.join(tmp, 'plan.md')}`);
    expect(brief).toContain(`Canonical plan.md: ${path.join(tmp, 'plan.md')}`);
    expect(brief).toContain(`Canonical og-requirements.md: ${path.join(tmp, 'og-requirements.md')}`);
    expect(brief).toContain(`sha256=${expected.sha256}`);
    expect(brief).toContain(`short12=${expected.short12}`);
    expect(brief).not.toContain('Plan: plan.json');
  });

  it('fails closed in the generated contract text when plan.md is missing or unreadable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-panel-missing-'));
    // Deliberately do NOT write plan.md — mirrors the real spawn-time race where the
    // panelist is dispatched before plancore has finished authoring the artifacts.

    const writer = new BriefWriterService();
    const brief = writer.generatePanelBrief({
      purpose: 'diff-review',
      batchId: 'batch-B2-missing',
      seat: 'A',
      lens: 'correctness',
      requirement: 'agreement must bind to the exact plan revision reviewed',
      projectDir: tmp,
      callbacksFile: path.join(tmp, 'callbacks.md'),
    });

    expect(brief).toContain(`Canonical plan.md: ${path.join(tmp, 'plan.md')}`);
    expect(brief).toContain(`Canonical og-requirements.md: ${path.join(tmp, 'og-requirements.md')}`);
    expect(brief).toContain('Expected plan revision: UNAVAILABLE');
    expect(brief).toContain('FAIL CLOSED');
    expect(brief).toContain('do NOT emit a verdict yet');
    expect(brief).not.toContain('Plan: plan.json');
    expect(brief).not.toContain('sha256=');
  });
});
