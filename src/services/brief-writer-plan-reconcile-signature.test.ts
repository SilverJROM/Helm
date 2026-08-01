/**
 * B3 (R2.8 / R3.10 / R3.11 / R3.14): purposes `plan-reconcile` + `plan-signature`.
 * Reconcile: reads BOTH round-1 drafts (+ any prior objection list), authors ONE candidate,
 * emits CANDIDATE-SUBMITTED plan=<sha12>, carries the same task-JSON schema as B2 (R2.8).
 * Signature: reads ONLY the candidate + an expected-revision bind line (mirrors the existing
 * revision-bind style), may SIGNED plan=<sha12> or a numbered bounded objection list — never
 * a competing draft, never PLAN-READY as agreement.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BriefWriterService } from './brief-writer-service.js';
import { candidatePlanPath, candidateReqPath } from './seat-draft-store.js';
import { planRevision } from './plan-revision.js';

const RUN_DIR = '/tmp/b3-plan-reconcile-run';
const PROJECT_DIR = '/tmp/b3-plan-reconcile-proj';
const SEAT = 'co-planner-a';

function generateReconcile(overrides: Record<string, unknown> = {}) {
  const writer = new BriefWriterService();
  return writer.generatePanelBrief({
    purpose: 'plan-reconcile',
    batchId: 'batch-B3-reconcile',
    seat: SEAT,
    lens: 'whole-plan',
    requirement: 'reconcile round-1 drafts into one candidate',
    projectDir: PROJECT_DIR,
    runDir: RUN_DIR,
    callbacksFile: path.join(RUN_DIR, 'callbacks.md'),
    ...overrides,
  } as Parameters<BriefWriterService['generatePanelBrief']>[0]);
}

function generateSignature(overrides: Record<string, unknown> = {}) {
  const writer = new BriefWriterService();
  return writer.generatePanelBrief({
    purpose: 'plan-signature',
    batchId: 'batch-B3-signature',
    seat: 'co-planner-b',
    lens: 'whole-plan',
    requirement: 'sign or object to the reconciled candidate',
    projectDir: PROJECT_DIR,
    runDir: RUN_DIR,
    callbacksFile: path.join(RUN_DIR, 'callbacks.md'),
    ...overrides,
  } as Parameters<BriefWriterService['generatePanelBrief']>[0]);
}

describe('BriefWriterService.generatePanelBrief — purpose plan-reconcile (B3)', () => {
  it('R2.8: carries the same schema / R-XX / task-JSON contract as B2 (effort, lanes, type, batch STRING, example)', () => {
    const brief = generateReconcile();

    expect(brief).toContain('Panel purpose: plan-reconcile');
    expect(brief).toContain('`R-XX`');
    expect(brief).toContain('`effort`');
    for (const v of ['low', 'med', 'high', 'xhigh']) {
      expect(brief, `effort enum must list "${v}"`).toContain(v);
    }
    expect(brief).toContain('T-shirt');
    for (const v of ['`L1`', '`L2`', '`L3`']) {
      expect(brief, `lane enum must list ${v}`).toContain(v);
    }
    expect(brief).toContain('`assignee`');
    expect(brief).toContain('`validator_lane`');
    expect(brief).toContain('`type`');
    expect(brief).toContain('`feature`');
    expect(brief).toContain('`issue`');
    expect(brief).toContain('`batch`');
    expect(brief).toContain('STRING');
    expect(brief.toLowerCase()).toContain('not a bare number');
    expect(brief).toContain('"batch":"B1"');
    expect(brief).toContain('"req_refs":["OPS-1"]');
    expect(brief).toContain('"effort":"med"');
    expect(brief).toContain('"type":"feature"');
    expect(brief).toContain('"id":"T01"');
  });

  it('R3.10: receives both round-1 draft paths + an optional defect list as read-only inputs', () => {
    const draftA = '/abs/planning-drafts/co-planner-a/draft-co-planner-a.md';
    const draftB = '/abs/planning-drafts/co-planner-b/draft-co-planner-b.md';
    const reqA = '/abs/planning-drafts/co-planner-a/draft-co-planner-a-req.md';
    const reqB = '/abs/planning-drafts/co-planner-b/draft-co-planner-b-req.md';

    const briefNoDefects = generateReconcile({
      roundDraftPlanPaths: [draftA, draftB],
      roundDraftReqPaths: [reqA, reqB],
    });
    expect(briefNoDefects).toContain(draftA);
    expect(briefNoDefects).toContain(draftB);
    expect(briefNoDefects).toContain(reqA);
    expect(briefNoDefects).toContain(reqB);
    expect(briefNoDefects).toMatch(/READ ONLY/i);

    const defectList = '1. Task B12-T02 has no req_refs. 2. Effort "L" is not a valid enum value.';
    const briefWithDefects = generateReconcile({
      roundDraftPlanPaths: [draftA, draftB],
      roundDraftReqPaths: [reqA, reqB],
      defectList,
    });
    expect(briefWithDefects).toContain(defectList);

    // No defect list provided -> no dangling objection section.
    expect(briefNoDefects.toLowerCase()).not.toContain('objection list from the prior signature round');
  });

  it('R3.10 / R2.5-style: authors exactly ONE candidate at the candidate path; never a seat draft path, never canonical', () => {
    const customCandidatePlan = '/abs/candidate-plan.md';
    const customCandidateReq = '/abs/candidate-req.md';
    const brief = generateReconcile({
      candidatePlanPath: customCandidatePlan,
      candidateReqPath: customCandidateReq,
    });

    expect(brief).toContain(`Candidate plan: ${path.resolve(customCandidatePlan)}`);
    expect(brief).toContain(`Candidate requirements: ${path.resolve(customCandidateReq)}`);
    expect(brief).toMatch(/author \*\*one\*\* merged candidate/i);
    expect(brief).toMatch(/exactly ONE/i);
    expect(brief).toMatch(/NEVER.*canonical `plan\.md`/i);
    expect(brief).toMatch(/NEVER[\s\S]{0,80}og-requirements\.md/i);
    expect(brief).toMatch(/write back into either seat's round-1 draft path/i);

    // Default composition when params omit explicit candidate paths.
    const defaults = generateReconcile();
    expect(defaults).toContain(candidatePlanPath(RUN_DIR));
    expect(defaults).toContain(candidateReqPath(RUN_DIR));
  });

  it('R2.7-style publication: atomic publish + non-authoritative CANDIDATE-SUBMITTED plan=<sha12>', () => {
    const brief = generateReconcile();

    expect(brief).toMatch(/atomically/i);
    expect(brief).toMatch(/temp sibling|rename/i);
    expect(brief).toContain('CANDIDATE-SUBMITTED plan=<sha12>');
    expect(brief).toContain(
      '[helm callback] panelist batch-B3-reconcile STATUS: CANDIDATE-SUBMITTED plan=<sha12>',
    );
    expect(brief).toMatch(/NON-AUTHORITATIVE/i);
    expect(brief).toMatch(/engine recomputes/i);
  });

  it('forbids two competing candidates, panel-verdict grammar, and PLAN-READY-as-agreement', () => {
    const brief = generateReconcile();

    expect(brief).toMatch(/not author two competing candidates|reconcile into exactly ONE/i);
    expect(brief).not.toMatch(/STATUS: VERDICT-READY/);
    expect(brief).not.toMatch(/STATUS: PLAN-READY/);
    expect(brief.toLowerCase()).toMatch(/only the engine.*declares agreement/);
  });
});

describe('BriefWriterService.generatePanelBrief — purpose plan-signature (B3)', () => {
  it('R3.11: receives ONLY the candidate path (no round-1 draft paths, no seat-scoped write targets)', () => {
    const brief = generateSignature();

    expect(brief).toContain('Panel purpose: plan-signature');
    expect(brief).toMatch(/the only plan document you review this round/i);
    expect(brief).not.toMatch(/round-1 draft/i);
    expect(brief).not.toMatch(/seat-scoped write targets/i);
    expect(brief).not.toContain('Candidate requirements:');
  });

  it('mirrors the revision-bind style: expected sha256/short12 line, bound to exact candidate bytes', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-signature-readable-'));
    const candidateBytes = '# candidate\n\n```json\n[]\n```\n';
    fs.writeFileSync(path.join(tmp, 'candidate-plan.md'), candidateBytes);
    const expected = planRevision(candidateBytes);

    const brief = generateSignature({ runDir: tmp });

    expect(brief).toContain(`Candidate plan: ${path.join(tmp, 'candidate-plan.md')}`);
    expect(brief).toContain(`Expected candidate revision: sha256=${expected.sha256}`);
    expect(brief).toContain(`short12=${expected.short12}`);
    expect(brief).toMatch(/bound to this exact candidate/i);
    expect(brief).toMatch(/stop and report a revision mismatch instead of signing/i);
  });

  it('fails closed in the generated contract text when the candidate is missing or unreadable', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b3-signature-missing-'));
    // Deliberately do NOT write candidate-plan.md.

    const brief = generateSignature({ runDir: tmp });

    expect(brief).toContain(`Candidate plan: ${path.join(tmp, 'candidate-plan.md')}`);
    expect(brief).toContain('Expected candidate revision: UNAVAILABLE');
    expect(brief).toContain('FAIL CLOSED');
    expect(brief).toMatch(/do NOT sign yet/i);
    expect(brief).not.toContain('sha256=');
  });

  it('R3.14: may SIGNED plan=<sha12> or a numbered bounded objection list — never a competing draft, never PLAN-READY', () => {
    const brief = generateSignature();

    expect(brief).toContain(
      '[helm callback] panelist batch-B3-signature STATUS: SIGNED plan=<sha12>',
    );
    expect(brief).toMatch(/numbered,? bounded objection list/i);
    expect(brief).toMatch(/OBJECTIONS/);
    expect(brief).toMatch(/never author a competing draft|do \*\*not\*\* author a competing draft/i);
    expect(brief).not.toMatch(/STATUS: PLAN-READY/);
    expect(brief).not.toMatch(/STATUS: VERDICT-READY/);
    expect(brief.toLowerCase()).toMatch(/agreement grammar/);
    expect(brief).toMatch(/NON-AUTHORITATIVE/i);
  });
});
