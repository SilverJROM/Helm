/**
 * Q-11: brief-writer must not point workers at builder scaffolding (~/.claude/JROM).
 * Deferral policy lives in the Helm product tree.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BriefWriterService,
  DEFERRAL_POLICY_RELPATH,
} from './brief-writer-service.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SCAFFOLD_JROM = '~/.claude/JROM';

const baseParams = {
  batchId: 'batch-Q11-test',
  planPath: '/tmp/plan.md',
  runDir: '/tmp/run',
  branch: 'feat/q11',
  requirementsAssigned: 'Q-11',
  northStarAnchors: 'builder-vs-built',
  projectDir: '/tmp/q11-project',
  callbacksFile: '/tmp/run/callbacks.md',
};

describe('Q-11 brief-writer: deferral policy lives in Helm (not ~/.claude/JROM)', () => {
  const writer = new BriefWriterService();

  it('ships Helm-owned policy file at policy/deferral-policy.md', () => {
    const abs = path.join(REPO_ROOT, DEFERRAL_POLICY_RELPATH);
    expect(fs.existsSync(abs), `expected ${DEFERRAL_POLICY_RELPATH} in repo`).toBe(true);
    const body = fs.readFileSync(abs, 'utf8');
    expect(body).toMatch(/Deferral Policy/i);
    expect(body).toMatch(/pre-live/i);
    // Product copy must not instruct workers back to builder scaffolding.
    expect(body).not.toMatch(/Read `~\/\.claude\/JROM/);
  });

  it('default generateBrief has zero ~/.claude/JROM and points at in-Helm policy', () => {
    const brief = writer.generateBrief({
      ...baseParams,
      role: 'implementer',
      taskType: 'feature',
    });
    expect(brief).not.toContain(SCAFFOLD_JROM);
    expect(brief).toContain(DEFERRAL_POLICY_RELPATH);
    expect(brief).toMatch(/Deferral policy:\s*OFF/i);
  });

  it('all brief generators omit ~/.claude/JROM (prefer zero scaffold path)', () => {
    const samples = [
      writer.generateBrief({ ...baseParams, role: 'implementer' }),
      writer.generateBrief({ ...baseParams, role: 'validator' }),
      writer.generateCorrectionBrief({
        ...baseParams,
        role: 'implementer',
        previousNote: 'gap',
      }),
      writer.generatePlanningBrief({
        batchId: 'Q11-plan',
        northStar: 'ns',
        projectDir: baseParams.projectDir,
        callbacksFile: baseParams.callbacksFile,
      }),
      writer.generateInterviewBrief({
        batchId: 'Q11-interview',
        prompt: 'build X',
        projectDir: baseParams.projectDir,
        callbacksFile: baseParams.callbacksFile,
      }),
      writer.generatePanelBrief({
        batchId: 'Q11-panel',
        seat: 'A',
        lens: 'correctness',
        projectDir: baseParams.projectDir,
        callbacksFile: baseParams.callbacksFile,
      }),
      writer.generateBrainBrief({
        batchId: 'Q11-brain',
        ledger: { attempts: [] },
        projectDir: baseParams.projectDir,
        callbacksFile: baseParams.callbacksFile,
      }),
    ];

    for (const text of samples) {
      expect(text, 'generated brief must not contain scaffold JROM path').not.toContain(
        SCAFFOLD_JROM,
      );
    }
  });
});
