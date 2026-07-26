/**
 * AGENT FOCUS CONTRACT (client-readiness): every WORKER seat brief must pin the agent to ONE task in
 * ONE project — no loitering / reading-whatever (drift + token leakage). Genuine external-read needs
 * route through the coordinator, the bar-decider. A phase-brain/helm_pm brief itself must
 * NOT carry the clause — it is the enforcer, not the enforced.
 */
import { describe, it, expect } from 'vitest';
import { BriefWriterService } from './brief-writer-service.js';

const baseParams = {
  batchId: 'batch-focus-test',
  planPath: '/tmp/plan.md',
  runDir: '/tmp/run',
  branch: 'feat/focus',
  requirementsAssigned: 'FOCUS1',
  northStarAnchors: 'focus-contract',
  projectDir: '/tmp/focus-project',
  callbacksFile: '/tmp/run/callbacks.md',
};

// Load-bearing phrases the focus contract must state (mirror brief-writer-service.ts focusContractSection).
const FOCUS_HEADING = '## Focus contract (stay strictly on THIS task — no loitering)';
const FOCUS_PHRASES = [
  'You are assigned THIS task in THIS project. Stay strictly on it',
  'You MAY read OUTSIDE the project ONLY when the task genuinely needs it',
  'off-task reading wastes tokens',
  'request it from the coordinator',
];

describe('AGENT FOCUS CONTRACT — present in every worker seat brief', () => {
  const writer = new BriefWriterService();

  function assertHasFocusContract(brief: string, label: string) {
    expect(brief, `${label} brief must carry the focus-contract heading`).toContain(FOCUS_HEADING);
    for (const phrase of FOCUS_PHRASES) {
      expect(brief, `${label} brief must contain focus phrase: "${phrase}"`).toContain(phrase);
    }
  }

  it('implementer brief contains the focus contract', () => {
    const brief = writer.generateBrief({ ...baseParams, role: 'implementer', taskType: 'feature' });
    assertHasFocusContract(
      brief,
      'implementer',
    );
    expect(brief).not.toMatch(/\bibrain\b/);
  });

  it('validator brief contains the focus contract', () => {
    assertHasFocusContract(
      writer.generateBrief({ ...baseParams, role: 'validator', taskType: 'feature' }),
      'validator',
    );
  });

  it('issue-mode implementer brief contains the focus contract', () => {
    assertHasFocusContract(
      writer.generateBrief({ ...baseParams, role: 'implementer', taskType: 'issue' }),
      'issue-implementer',
    );
  });

  it('correction brief (implementer) preserves the focus contract', () => {
    assertHasFocusContract(
      writer.generateCorrectionBrief({ ...baseParams, role: 'implementer', previousNote: 'gap' }),
      'correction',
    );
  });

  it('panel seat brief contains the focus contract', () => {
    assertHasFocusContract(
      writer.generatePanelBrief({
        batchId: 'focus-panel',
        seat: 'A',
        lens: 'correctness',
        projectDir: baseParams.projectDir,
        callbacksFile: baseParams.callbacksFile,
      }),
      'panel',
    );
  });

  it('red-team seat brief contains the focus contract', () => {
    assertHasFocusContract(
      writer.generatePanelBrief({
        role: 'red-team',
        batchId: 'focus-redteam',
        seat: 'R1',
        lens: 'security',
        projectDir: baseParams.projectDir,
        callbacksFile: baseParams.callbacksFile,
      }),
      'red-team',
    );
  });
});

describe('AGENT FOCUS CONTRACT — absent from phase-brain briefs (enforcer, not enforced)', () => {
  const writer = new BriefWriterService();

  const coordinatorBriefs: Array<[string, string]> = [
    [
      'planning',
      writer.generatePlanningBrief({
        batchId: 'focus-plan',
        northStar: 'ns',
        projectDir: baseParams.projectDir,
        callbacksFile: baseParams.callbacksFile,
      }),
    ],
    [
      'interview',
      writer.generateInterviewBrief({
        batchId: 'focus-interview',
        prompt: 'build X',
        projectDir: baseParams.projectDir,
        callbacksFile: baseParams.callbacksFile,
      }),
    ],
    [
      'brain',
      writer.generateBrainBrief({
        batchId: 'focus-brain',
        ledger: { attempts: [] },
        projectDir: baseParams.projectDir,
        callbacksFile: baseParams.callbacksFile,
      }),
    ],
    ['plancore-generateBrief', writer.generateBrief({ ...baseParams, role: 'plancore' })],
  ];

  for (const [label, brief] of coordinatorBriefs) {
    it(`${label} brief does NOT carry the focus contract`, () => {
      expect(brief, `${label} (coordinator) brief must not carry the focus-contract heading`).not.toContain(
        FOCUS_HEADING,
      );
    });
  }
});
