import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BriefWriterService } from './brief-writer-service.js';
import { validateExecutionPlan } from './execution-plan-parser.js';
import { resolveRequirementsText } from './requirements-resolver-service.js';

const tempDirs: string[] = [];

async function makeRunDir(requirements?: string): Promise<string> {
  const runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-fix42-'));
  tempDirs.push(runDir);
  if (requirements !== undefined) {
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), requirements, 'utf8');
  }
  return runDir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('resolveRequirementsText', () => {
  it('returns requested verbatim bullet blocks in req_refs order, including wrapped lines', async () => {
    const runDir = await makeRunDir(`# Acceptance\n\n- **PA-1** — First requirement.\n  Wrapped PA-1 detail.\n\n- **PA-29** — Every UI-visible batch ships a Playwright spec.\n  Capture at least one screenshot.\n  *(= AC-5)*\n- **PA-31** — Final requirement.\n\n## Boundary\nignored\n`);

    expect(resolveRequirementsText(runDir, ['PA-29', 'PA-1'])).toBe(
      '- **PA-29** — Every UI-visible batch ships a Playwright spec.\n  Capture at least one screenshot.\n  *(= AC-5)*\n- **PA-1** — First requirement.\n  Wrapped PA-1 detail.',
    );
  });

  it('fails closed with neutral markers for missing files and missing ids', async () => {
    const missingFileDir = await makeRunDir();
    expect(resolveRequirementsText(missingFileDir, ['PA-29'])).toBe(
      '(og-requirements.md not found in runDir; req_refs: PA-29)',
    );

    const missingIdDir = await makeRunDir('- **PA-1** — Present requirement.\n');
    expect(resolveRequirementsText(missingIdDir, ['PA-29'])).toBe(
      '(req PA-29 not found in og-requirements.md)',
    );
  });
});

describe('FIX42 worker brief construction', () => {
  it('puts cards2 PA-29 text in implementer and validator briefs without Helm self-build poison', async () => {
    const runDir = await makeRunDir('- **PA-29** — Every UI-visible batch ships a Playwright spec with at least one screenshot.\n');
    const writer = new BriefWriterService();
    const resolved = resolveRequirementsText(runDir, ['PA-29']);
    const shared = {
      batchId: 'cards2-piece-a',
      planPath: path.join(runDir, 'plan.json'),
      runDir,
      branch: 'main',
      requirementsAssigned: 'PA-29',
      requirementsSection: resolved,
      context: 'Batch B1 — Build the cards2 lobby',
      scope: 'Implement A01 (Build the cards2 lobby) as an atomic vertical slice. Surgical, minimal-correct. Assert OUTCOMES against the requirements above.',
      expected: 'Lobby renders and Playwright captures a screenshot.',
      northStarAnchors: 'Build the cards2 lobby',
      projectDir: '/tmp/cards2',
      callbacksFile: path.join(runDir, 'callbacks.md'),
      taskType: 'feature' as const,
    };

    for (const role of ['implementer', 'validator'] as const) {
      const brief = writer.generateBrief({ ...shared, role });
      expect(brief).toContain('- **PA-29** — Every UI-visible batch ships a Playwright spec with at least one screenshot.');
      for (const poison of ['DSP7', 'TST2', 'SEC1', 'B7 periphery']) {
        expect(brief).not.toContain(poison);
      }
    }
  });

  it('keeps generateBrief defaults visibly neutral when task fields were not passed', () => {
    const brief = new BriefWriterService().generateBrief({
      batchId: 'neutral-default',
      role: 'implementer',
      planPath: '/tmp/plan.json',
      runDir: '/tmp/run',
      branch: 'main',
      requirementsAssigned: 'TASK',
      northStarAnchors: 'task',
    });

    expect(brief).toContain('(no explicit requirements passed — see the ## Task section below for atomic_work + validation_criteria)');
    for (const poison of ['DSP7', 'TST2', 'SEC1', 'B7 periphery']) {
      expect(brief).not.toContain(poison);
    }
  });

  it('preserves execution-plan req_refs in the normalized plan consumed by dispatch', () => {
    const parsed = validateExecutionPlan([{
      id: 'A01',
      batch: 'B1',
      title: 'Build the cards2 lobby',
      req_refs: ['PA-29'],
      assignee: 'L1',
      validator_lane: 'L1',
      effort: 'low',
      type: 'feature',
      deps: [],
    }]);

    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.normalizedTasks[0].req_refs).toEqual(['PA-29']);
  });
});
