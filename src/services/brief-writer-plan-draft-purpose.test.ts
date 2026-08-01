/**
 * B2 (R2.8 / R2.5 / R2.7 / R1.1 prep): purpose `plan-draft` owns the schema / R-XX /
 * task-JSON contract formerly living only in generatePlanningBrief. Seat-scoped write
 * targets only; DRAFT-SUBMITTED plan=<sha12> after atomic self-hash (non-authoritative);
 * context = absolute north-star / conversation-log / decisions only. No partner-agreement
 * or panel-verdict grammar on this purpose.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BriefWriterService } from './brief-writer-service.js';
import { draftPlanPath, draftReqPath } from './seat-draft-store.js';

const RUN_DIR = '/tmp/b2-plan-draft-run';
const PROJECT_DIR = '/tmp/b2-plan-draft-proj';
const SEAT = 'co-planner-a';

function generatePlanDraft(overrides: Record<string, unknown> = {}) {
  const writer = new BriefWriterService();
  return writer.generatePanelBrief({
    purpose: 'plan-draft',
    batchId: 'batch-B2-draft',
    seat: SEAT,
    lens: 'whole-plan',
    requirement: 'author seat-scoped draft from context',
    projectDir: PROJECT_DIR,
    runDir: RUN_DIR,
    callbacksFile: path.join(RUN_DIR, 'callbacks.md'),
    ...overrides,
  } as Parameters<BriefWriterService['generatePanelBrief']>[0]);
}

describe('BriefWriterService.generatePanelBrief — purpose plan-draft (B2)', () => {
  it('R2.8: carries the schema / R-XX / task-JSON contract (effort, lanes, type, batch STRING, example)', () => {
    const brief = generatePlanDraft();

    expect(brief).toContain('Panel purpose: plan-draft');
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
    // Order: requirements draft first, then plan draft
    expect(brief).toMatch(/requirements draft FIRST[\s\S]*plan draft/i);
  });

  it('R2.5: instructs write-only seat-scoped paths from params; never canonical plan.md / og-requirements.md', () => {
    const customPlan = '/abs/seat/draft-a.md';
    const customReq = '/abs/seat/draft-a-req.md';
    const brief = generatePlanDraft({
      draftPlanPath: customPlan,
      draftReqPath: customReq,
    });

    expect(brief).toContain(`Plan draft: ${path.resolve(customPlan)}`);
    expect(brief).toContain(`Requirements draft: ${path.resolve(customReq)}`);
    expect(brief).toMatch(/write \*\*only\*\* the seat-scoped paths/i);
    expect(brief).toMatch(/NEVER.*canonical `plan\.md`/i);
    expect(brief).toMatch(/NEVER[\s\S]{0,80}og-requirements\.md/i);

    // Default composition when params omit explicit draft paths
    const defaults = generatePlanDraft();
    expect(defaults).toContain(draftPlanPath(RUN_DIR, SEAT));
    expect(defaults).toContain(draftReqPath(RUN_DIR, SEAT));
  });

  it('R2.7: requires atomic publish + DRAFT-SUBMITTED plan=<sha12> non-authoritative self-hash', () => {
    const brief = generatePlanDraft();

    expect(brief).toMatch(/atomically/i);
    expect(brief).toMatch(/temp sibling|rename/i);
    expect(brief).toContain('DRAFT-SUBMITTED plan=<sha12>');
    expect(brief).toMatch(
      new RegExp(
        `\\[helm callback\\] panelist batch-B2-draft STATUS: DRAFT-SUBMITTED plan=<sha12>`,
      ),
    );
    expect(brief).toMatch(/NON-AUTHORITATIVE/i);
    expect(brief).toMatch(/engine recomputes/i);
  });

  it('context injection is absolute north-star / conversation-log / decisions only', () => {
    const ns = '/ctx/north-star.md';
    const cl = '/ctx/conversation-log.md';
    const dec = '/ctx/decisions';
    const brief = generatePlanDraft({
      northStarPath: ns,
      conversationLogPath: cl,
      decisionsDir: dec,
    });

    expect(brief).toContain(`north-star.md: ${path.resolve(ns)}`);
    expect(brief).toContain(`conversation-log.md: ${path.resolve(cl)}`);
    expect(brief).toContain(`decisions/: ${path.resolve(dec)}`);

    const defaults = generatePlanDraft();
    expect(defaults).toContain(`north-star.md: ${path.join(RUN_DIR, 'north-star.md')}`);
    expect(defaults).toContain(`conversation-log.md: ${path.join(RUN_DIR, 'conversation-log.md')}`);
    expect(defaults).toContain(`decisions/: ${path.join(RUN_DIR, 'decisions')}`);
  });

  it('forbids partner-agreement and panel-verdict completion grammar on plan-draft', () => {
    const brief = generatePlanDraft();

    // Must not instruct "agree with partner" (positive agreement grammar).
    expect(brief.toLowerCase()).not.toMatch(/\bagree with (a )?partner\b/);
    expect(brief.toLowerCase()).toMatch(/draft alone and blind|independent whole-plan proposal/);
    // Terminal emission must be DRAFT-SUBMITTED, not a panel verdict line
    expect(brief).not.toMatch(/STATUS: VERDICT-READY/);
    expect(brief).not.toMatch(/STATUS: PLAN-READY/);
    // No expected-revision bind line (nothing to bind on a first blind draft)
    expect(brief).not.toContain('Expected plan revision:');
    expect(brief).not.toContain('Canonical plan.md:');
    expect(brief).not.toContain('Canonical og-requirements.md:');
  });

  it('R5.19 regression: diff-review body is still free of draft-authoring grammar', () => {
    const writer = new BriefWriterService();
    const brief = writer.generatePanelBrief({
      purpose: 'diff-review',
      batchId: 'batch-B2-diff',
      seat: 'A',
      lens: 'correctness',
      projectDir: PROJECT_DIR,
      callbacksFile: path.join(RUN_DIR, 'callbacks.md'),
    });

    expect(brief).toContain('Panel purpose: diff-review');
    expect(brief).toContain('STATUS: VERDICT-READY');
    expect(brief).not.toMatch(/DRAFT-SUBMITTED/i);
    expect(brief).not.toMatch(/seat-scoped write targets/i);
    expect(brief).not.toMatch(/write \*\*only\*\* the seat-scoped paths/i);
  });
});
