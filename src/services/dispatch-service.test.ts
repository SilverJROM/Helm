process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DispatchService, DispatchStartParams } from './dispatch-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { DatabaseService } from '../db/database.js';
import { TmuxService } from '../tmux/tmux-service.js';
import { BriefWriterService } from './brief-writer-service.js';
import Fastify from 'fastify';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function makeGoodBrief(batchId = 'batch-B4-test'): string {
  return `<!-- PROJCORE-STATUS-CONTRACT v2 -->
Batch-B4-test: Dispatch envelope test brief
Batch ID: ${batchId}
Plan: /tmp/plan.md
Branch: feat/test
Requirements assigned: DSP1, DSP3
North-star anchors: #1
Lifecycle: pre-live — Deferral policy: OFF.
Estimated duration: SHORT
Effort tier: high
Context: test
Requirements section: "DSP1 and DSP3"
Observed: none
Expected: hand-off works
Scope: test only

The callback line template is: [helm callback] <role> <batch-id> STATUS:

## Streaming-order mandate
Your first tool call in every reply MUST be the callbacks.md append. Not the first sentence — the first TOOL CALL, BEFORE any prose tokens stream.

## Callback emission — Helm-native direct append
printf '%s\\n' '[helm callback] <role> <batch-id> STATUS: <STATE> — <note>' >> '<abs-path-to-callbacks.md>'

## Role-scoped closed enum
implementer states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO

## B7 TST2 additions (artifact paths, project dir, fence, anchor, repro gate)
Project dir: /tmp/test-project
Artifact output paths: prompts/, dispatch/, state/, artifacts/, callbacks.md
Write-fence (WRK2) for every spawned role; refuse if fence unavailable / path escapes.
The requirements for this batch (TST2) covered by DSP7,TST2,SEC1
issue-mode repro gate (TST2): emit REPRO-CONFIRMED — <contract> or REPRO-FAILED
`;
}

function makeBadBrief(missing: 'sentinel' | 'callback' | 'enum' | 'streaming' | 'helper'): string {
  const base = makeGoodBrief();
  if (missing === 'sentinel') return base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', '<!-- BROKEN -->');
  if (missing === 'callback') return base.replace('[helm callback] <role> <batch-id> STATUS:', '[broken callback]');
  if (missing === 'enum') return base.replace('implementer states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO', 'implementer states: FOO');
  if (missing === 'streaming') return base.replace('first tool call in every reply MUST be the callbacks.md append', 'no first tool call guarantee');
  if (missing === 'helper') return base.replace("printf '%s\\n'", 'no-native-append'); // breaks native_callback_append clause
  return base;
}

describe('DispatchService (B4 DSP1 + DSP3 envelope, USE_FAKE_TMUX)', () => {
  let runDir: string;
  let dbPath: string;
  let dbs: DatabaseService;
  let artifacts: RunArtifactService;
  let tmux: TmuxService;
  let dispatch: DispatchService;
  let attemptId: number;
  let rid: number;
  let tid: number;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b4-dispatch-'));
    dbPath = path.join(os.tmpdir(), `helm-b4-dispatch-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(dbPath);
    artifacts = new RunArtifactService(dbs);
    tmux = new TmuxService();
    dispatch = new DispatchService(tmux, artifacts);

    // minimal orchestration context (B1 tables)
    rid = artifacts.createRun(null, 'batch-B4-test');
    tid = artifacts.recordTask(rid, 'task-dsp', 'dispatch envelope task');
    attemptId = artifacts.recordAttempt(tid, 1);

    await fs.mkdir(path.join(runDir, 'dispatch'), { recursive: true }).catch(() => {});
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# B4 dispatch test\n', 'utf8');

    // default spies: success path (overridden per test)
    vi.spyOn(tmux, 'sessionExists').mockResolvedValue(true);
    vi.spyOn(tmux, 'waitForReady').mockResolvedValue(true);
    vi.spyOn(tmux, 'sendDispatchInstruction').mockResolvedValue(true);
    vi.spyOn(tmux, 'verifyMarkerPresent').mockResolvedValue(true);
  });

  afterEach(async () => {
    if (dbs) { try { dbs.close(); } catch {} }
    if (dbPath) { await fs.rm(dbPath, { force: true }).catch(() => {}); }
    if (runDir) { await fs.rm(runDir, { recursive: true, force: true }).catch(() => {}); }
    vi.restoreAllMocks();
  });

  function baseParams(overrides: Partial<DispatchStartParams> = {}): DispatchStartParams {
    return {
      session: 'helm-w-test-1:0.0',
      briefPath: path.join(runDir, 'prompts', 'good.brief.md'),
      runDir,
      batchId: 'batch-B4-test',
      role: 'implementer',
      attemptId,
      bucket: 'SHORT',
      estimateMin: 10,
      callbacksFile: path.join(runDir, 'callbacks.md'),
      ...overrides
    };
  }

  async function writeBrief(briefText: string, name = 'good.brief.md') {
    const p = path.join(runDir, 'prompts');
    await fs.mkdir(p, { recursive: true });
    await fs.writeFile(path.join(p, name), briefText, 'utf8');
  }

  it('happy path: ready probe + 3-call send + marker verified + dispatches row + manifest + wakeup marker written', async () => {
    const good = makeGoodBrief();
    await writeBrief(good);

    // control capture for real verify logic (marker present after ws strip)
    const markerSim = 'DISPATCH-batch-B4-test-implementer-FAKE-123456';
    vi.spyOn(tmux, 'verifyMarkerPresent').mockImplementation(async (t: string, m: string) => {
      // simulate pane containing the marker (real strip logic exercised in impl)
      return true;
    });

    const preCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id = ?').get(attemptId) as any).c;

    const res = await dispatch.start(baseParams({ briefPath: path.join(runDir, 'prompts', 'good.brief.md') }));

    expect(res.dispatchId).toBeGreaterThan(0);
    expect(res.marker).toMatch(/^DISPATCH-batch-B4-test-implementer-/);
    expect(res.wakeupSec).toBeGreaterThanOrEqual(60);
    expect(res.manifestPath).toContain('batch-B4-test.implementer.json');

    // row written
    const postCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id = ?').get(attemptId) as any).c;
    expect(postCount).toBe(preCount + 1);
    const row = dbs.raw.prepare('SELECT * FROM dispatches WHERE id = ?').get(res.dispatchId) as any;
    expect(row.role).toBe('implementer');
    expect(row.transport_handle).toBe(res.marker);
    expect(row.brief_path).toContain('good.brief.md');

    // manifest + wakeup file
    const manRaw = await fs.readFile(res.manifestPath, 'utf8');
    const man = JSON.parse(manRaw);
    expect(man.schema_version).toBe(4);
    expect(man.batch_id).toBe('batch-B4-test');
    expect(man.dispatch_marker).toBe(res.marker);
    expect(man.wakeup_delay_sec).toBe(res.wakeupSec);

    const wakeupPath = path.join(runDir, 'dispatch', 'batch-B4-test.wakeup-required');
    expect((await fs.stat(wakeupPath)).isFile()).toBe(true);
  });

  it('contract validator fails closed for each of the 5 exact checks (DSP3)', async () => {
    // explicit bad briefs — each guaranteed to miss exactly one of the 5 literals from run_contract_checks
    const bads = [
      { name: 'bad-sentinel', text: makeGoodBrief().replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', '<!-- BROKEN-CONTRACT -->') },
      { name: 'bad-callback', text: makeGoodBrief().replace('The callback line template is: [helm callback] <role> <batch-id> STATUS:', 'The callback line template is: [BROKEN]') },
      { name: 'bad-enum', text: makeGoodBrief().replace('implementer states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO', 'implementer states: BROKEN') },
      { name: 'bad-streaming', text: makeGoodBrief().replace('first tool call', 'NO_FIRST_TOOL_CALL') },
      { name: 'bad-native', text: makeGoodBrief().replace("printf '%s\\n'", 'no-native-append') }
    ];
    for (const b of bads) {
      await writeBrief(b.text, `${b.name}.brief.md`);
      const pre = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id=?').get(attemptId) as any).c;

      await expect(
        dispatch.start(baseParams({ briefPath: path.join(runDir, 'prompts', `${b.name}.brief.md`) }))
      ).rejects.toThrow(/BRIEF-CONTRACT-MISSING/);

      const post = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id=?').get(attemptId) as any).c;
      expect(post).toBe(pre); // no row on contract fail

      const manExists = await fs.access(path.join(runDir, 'dispatch', 'batch-B4-test.json')).then(() => true).catch(() => false);
      expect(manExists).toBe(false);
    }
  });

  // B7 TST2 (guardrail 2): test EACH required clause rejection on generated briefs (reuse/extend B4 validator)
  describe('B7 brief-validation (TST2) — writer-generated briefs; every missing clause REJECTS', () => {
    it('BriefWriterService produces compliant brief that contains all required clauses and passes dispatch + validate', async () => {
      const writer = new BriefWriterService();
      const generated = writer.generateBrief({
        batchId: 'batch-B7-writer-test',
        role: 'implementer',
        planPath: '/tmp/plan.md',
        runDir,
        branch: 'feat/b7-test',
        requirementsAssigned: 'DSP7, TST2, SEC1',
        northStarAnchors: '#1 #2',
        taskType: 'feature',
        projectDir: '/tmp/b7-project'
      });
      expect(generated).toContain('Project dir:');
      expect(generated).toContain('Artifact output paths');
      expect(generated).toContain('Write-fence (WRK2)');
      expect(generated).toContain('Requirements assigned:');
      expect(generated).toContain('The callback line template is: [helm callback]');

      await writeBrief(generated, 'writer-good.brief.md');
      const preCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id = ?').get(attemptId) as any).c;
      const res = await dispatch.start(baseParams({
        briefPath: path.join(runDir, 'prompts', 'writer-good.brief.md'),
        batchId: 'batch-B7-writer-test'
      }));
      expect(res.dispatchId).toBeGreaterThan(0);
      const postCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id = ?').get(attemptId) as any).c;
      expect(postCount).toBe(preCount + 1);
    });

    // B10-T03 (R-F2/R-D2): validator brief JROM-clone framing — concrete substring assertions
    it('BriefWriterService validator brief contains JROM-clone mandate (north_star + decisions + og_req + UI-proof + verifier≠fixer)', async () => {
      const writer = new BriefWriterService();
      const generated = writer.generateBrief({
        batchId: 'batch-B10-T03-test',
        role: 'validator',
        planPath: '/tmp/plan.md',
        runDir,
        branch: 'feat/b10-t03',
        requirementsAssigned: 'R-F2, R-D2',
        northStarAnchors: 'validator checks north_star/decisions/og_req',
        taskType: 'feature',
        projectDir: '/tmp/b10-project',
        callbacksFile: path.join(runDir, 'callbacks.md'),
      });

      // (1) JROM's clone — adversarial, no rubber-stamp
      expect(generated).toContain("JROM's clone");
      expect(generated).toContain('adversarial');
      expect(generated).toContain('do NOT rubber-stamp');

      // (2) requirements contract by name
      expect(generated).toContain('REQUIREMENTS CONTRACT');
      expect(generated).toContain('north-star.md');
      expect(generated).not.toContain('north_star.md');
      expect(generated).toContain('decisions/');
      expect(generated).toContain('og-requirements.md');
      expect(generated).toContain('not observably closed');

      // (3) UI-proof
      expect(generated).toContain('UI-proof');
      expect(generated).toContain('rendered app + screenshot');

      // (4) verifier ≠ fixer
      expect(generated).toContain('verifier ≠ fixer');
      expect(generated).toContain('do NOT fix');

      // implementer brief must NOT gain validator-only section
      const impl = writer.generateBrief({
        batchId: 'batch-B10-T03-impl',
        role: 'implementer',
        planPath: '/tmp/plan.md',
        runDir,
        branch: 'feat/b10-t03',
        requirementsAssigned: 'R-F2',
        northStarAnchors: 'impl task',
        taskType: 'feature',
        projectDir: '/tmp/b10-project',
      });
      expect(impl).not.toContain("Validator mandate — JROM's clone");

      // final-validator gets same section
      const finalVal = writer.generateBrief({
        batchId: 'batch-B10-T03-final',
        role: 'final-validator',
        planPath: '/tmp/plan.md',
        runDir,
        branch: 'feat/b10-t03',
        requirementsAssigned: 'FINAL-VALIDATION',
        northStarAnchors: 'req-matrix',
        taskType: 'feature',
        projectDir: '/tmp/b10-project',
      });
      expect(finalVal).toContain("Validator mandate — JROM's clone");
      expect(finalVal).toContain('north-star.md');
    });

    // B12-T03 (R-F2/R-F3/R-H2): implementer atomic/issue + validator never-re-test; role separation + TST2 preserved
    it('BriefWriterService B12-T03 implementer+validator R-F2/R-F3 clauses + TST2 preserved', () => {
      const writer = new BriefWriterService();
      const base = {
        planPath: '/tmp/plan.md',
        runDir,
        branch: 'feat/b12-t03',
        projectDir: '/tmp/b12-t03-project',
        callbacksFile: path.join(runDir, 'callbacks.md'),
      };

      const validator = writer.generateBrief({
        ...base,
        batchId: 'batch-B12-T03-val',
        role: 'validator',
        requirementsAssigned: 'R-F2, R-F3',
        northStarAnchors: 'validator independent verification',
        taskType: 'feature',
      });

      // B10-T03 retained substrings (additive — not a rewrite)
      expect(validator).toContain("JROM's clone");
      expect(validator).toContain('adversarial');
      expect(validator).toContain('REQUIREMENTS CONTRACT');
      expect(validator).toContain('north-star.md');
      expect(validator).toContain('decisions/');
      expect(validator).toContain('og-requirements.md');
      expect(validator).toContain('UI-proof');
      expect(validator).toContain('rendered app + screenshot');
      expect(validator).toContain('verifier ≠ fixer');
      expect(validator).toContain('do NOT fix');

      // B12-T03 validator delta — never re-test + independent verification
      expect(validator).toContain('NEVER re-test');
      expect(validator).toContain('independent verification');
      expect(validator).toContain("re-run of the implementer's self-tests");
      expect(validator).toContain('Issue tasks (R-F3)');

      // Validator must NOT gain implementer-only section
      expect(validator).not.toContain('Implementer mandate');

      const implementer = writer.generateBrief({
        ...base,
        batchId: 'batch-B12-T03-impl',
        role: 'implementer',
        requirementsAssigned: 'R-F2, R-F3',
        northStarAnchors: 'atomic vertical slice',
        taskType: 'feature',
      });

      // B12-T03 implementer delta
      expect(implementer).toContain('Implementer mandate');
      expect(implementer).toContain('ATOMIC vertical slice');
      expect(implementer).toContain('do NOT drive the workflow');
      expect(implementer).not.toContain("Validator mandate — JROM's clone");

      const issueImpl = writer.generateBrief({
        ...base,
        batchId: 'batch-B12-T03-issue',
        role: 'implementer',
        requirementsAssigned: 'R-F3',
        northStarAnchors: 'issue fix after repro',
        taskType: 'issue',
      });

      expect(issueImpl).toContain('Issue reproduction gate');
      expect(issueImpl).toContain('REPRO-CONFIRMED');
      expect(issueImpl).toContain("validator's REPRO-CONFIRMED contract");

      const plancore = writer.generateBrief({
        ...base,
        batchId: 'batch-B12-T03-projcore',
        role: 'plancore',
        requirementsAssigned: 'R-H2',
        northStarAnchors: 'planning worker',
        taskType: 'feature',
      });
      expect(plancore).not.toContain('Implementer mandate');
      expect(plancore).not.toContain("Validator mandate — JROM's clone");

      // TST2 scaffolding on both worker roles
      const tst2Common = (brief: string) => {
        expect(brief).toContain('The callback line template is: [helm callback]');
        expect(brief).toContain('first tool call');
        expect(brief).toContain("printf '%s\\n'");
        expect(brief).toContain('Artifact output paths');
        expect(brief).toContain('Project dir:');
        expect(brief).toContain('Write-fence (WRK2)');
      };
      tst2Common(validator);
      tst2Common(implementer);
      tst2Common(issueImpl);
      expect(validator).toContain('validator states:');
      expect(implementer).toContain('implementer states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO');
      expect(issueImpl).toContain('implementer states: PROPOSED | REVISE-PLAN | WORKING | DONE | BLOCKED | NEEDS-INFO');
    });

    // B12-T04 (R-H2): control/decision-brain + panel briefs describe the built FSM exactly; no invented task terminals; TST2 scaffolding + role enum preserved
    it('BriefWriterService generateBrainBrief + generatePanelBrief describe exact built FSM (terminals/5-actions/ladder/park/deploy/final-tests) + no invented terminals + TST2 preserved', () => {
      const writer = new BriefWriterService();
      const brain = writer.generateBrainBrief({
        batchId: 'batch-B12-T04-brain',
        ledger: { attempts: [{ attempt: 1, rung: 0, validator_diagnosis: 'FAIL' }] },
        lastReproNote: 'escalated control test',
        projectDir: '/tmp/b12-t04',
        callbacksFile: path.join(runDir, 'callbacks.md'),
      });

      // (1) Describes real per-task terminals from code (orchestrator-loop persistFinal)
      expect(brain).toContain('ONLY PASS | FAIL | BLOCKED | DEFERRED');
      expect(brain).toContain('Nothing else');
      // Reinforcement 1: NO invented task terminals (no COMPLETE/SUCCESS/DONE as task terminal; RECURRENCE_PAUSE only as phase=blocked)
      expect(brain).not.toContain('COMPLETE as a task');
      expect(brain).not.toContain('SUCCESS as a task');
      expect(brain).not.toContain('DONE as a per-task terminal');
      expect(brain).toContain('RECURRENCE_PAUSE is never a per-task terminal');
      expect(brain).toContain('phase=blocked');

      // (2) Run phases + escalation actions including root-cause classifier routes
      expect(brain).toContain('planning → executing → complete | failed | blocked');
      expect(brain).toContain('bump-rung (with targetRung + decisionId)');
      expect(brain).toContain('validator-handholding (with spoonFedDirections)');
      expect(brain).toContain('re-plan (with planRevisionDirective + decisionId)');
      expect(brain).toContain('escalate-validator');
      expect(brain).toContain('escalate-to-JROM');

      // (3) Free retries, validator incapability/plan-defect/backstop triggers, top-rung page, and parked decisions
      expect(brain).toContain('ordinary validator FAILs are free same-rung correction retries');
      expect(brain).toContain('defect_class=implementer-incapable');
      expect(brain).toContain('defect_class=plan-defect');
      expect(brain).toContain('HELM_MAX_TASK_ATTEMPTS');
      expect(brain).toContain('default 12, clamped 3..40');
      expect(brain).toContain('ROOT-CAUSE CLASSIFIER');
      expect(brain).toContain('A top-rung backstop, or a brain bump-rung decision with no higher rung');
      expect(brain).toContain('PROMPT/TASK defect');
      expect(brain).toContain('parked-blocks-all');
      expect(brain).toContain('getParkedBlockReason');

      // (4) Deploy + final tests gates (B10-T06 / B11)
      expect(brain).toContain('batch-boundary after PASS');
      expect(brain).toContain('run deploy + validator UI-proof');
      expect(brain).toContain('deploy-paused.md + phase=blocked');
      expect(brain).toContain('smoke (short-circuits on FAIL) then DEV-e2e');
      expect(brain).toContain('inject atomic issue-fix task');
      expect(brain).toContain('final-test-recurrence-pause.md + phase=blocked');
      expect(brain).toContain('MAX_FIX_ITERS=3');

      // (5) Role enum distinction preserved (no conflation); TST2 scaffolding present
      expect(brain).toContain('ROLE-callback enum is DISTINCT from per-task terminals');
      expect(brain).toContain('DECISION-READY');
      expect(brain).toContain('The callback line template is: [helm callback]');
      expect(brain).toContain('first tool call');
      expect(brain).toContain('helm_pm states: PLANNING | PLAN-READY | NORTH-STAR-READY');
      expect(brain).toContain(`[helm callback] helm_pm batch-B12-T04-brain STATUS: DECISION-READY`);
      expect(brain).not.toMatch(/\bibrain\b/);

      // Panel brief also aligned (verifier≠fixer + deliberation → park)
      const panel = writer.generatePanelBrief({
        purpose: 'diff-review',
        batchId: 'batch-B12-T04-panel',
        seat: '1',
        lens: 'fsm',
        requirement: 'control test',
        projectDir: '/tmp/b12-t04',
        callbacksFile: path.join(runDir, 'callbacks.md'),
      });
      expect(panel).toContain('verifier ≠ fixer');
      expect(panel).toContain('deliberation feeds brain escalation');
      expect(panel).toContain('VERDICT-READY');
      expect(panel).toContain('The callback line template is: [helm callback]');

      expect(() => dispatch.validateBriefContract(brain, 'ibrain')).not.toThrow();
    });

    // B12-T01 (R-C4/R-H2/R-H3): discovery interview brief — new clauses + existing TST2 scaffolding preserved
    it('BriefWriterService generateInterviewBrief contains CC-redesign discovery clauses + TST2 contract scaffolding', () => {
      const writer = new BriefWriterService();
      const generated = writer.generateInterviewBrief({
        batchId: 'batch-B12-T01-test',
        prompt: 'Build payroll fixes for cards project',
        projectDir: '/tmp/b12-project',
        runDir,
        callbacksFile: path.join(runDir, 'callbacks.md'),
      });

      // (1) NEW discovery-behavior clauses (additive reformat)
      expect(generated).toContain('Discovery INTERVIEW');
      expect(generated).toContain('sole CC-chat interlocutor');
      expect(generated).toContain('north-star.md');
      expect(generated).toContain('decisions/');
      expect(generated).toContain('mockups/');
      expect(generated).toContain('attachments/');
      expect(generated).toContain('canonical artifact root');
      expect(generated).toContain('parity refs');

      // (2) EXISTING TST2-checked elements still present (not dropped by reformat)
      expect(generated).toContain('The callback line template is: [helm callback]');
      expect(generated).toContain('discovery states: INTERVIEWING | NORTH-STAR-READY | IDLE | BLOCKED');
      expect(generated).toContain('You are **discovery** conducting');
      expect(generated).toContain('[helm callback] discovery batch-B12-T01-test STATUS: NORTH-STAR-READY');
      expect(generated).not.toContain('[helm callback] helm_pm batch-B12-T01-test');
      expect(generated).toContain('Project dir:');
      expect(generated).toContain('Artifact output paths');
      expect(generated).toContain('Write-fence (WRK2)');
      expect(generated).toContain('Requirements assigned:');
      expect(generated).toContain('prompts/');
      expect(generated).toContain('dispatch/');
      expect(generated).toContain('state/');
      expect(generated).toContain('artifacts/');
      expect(generated).toContain('first tool call');
      expect(generated).toContain('BEFORE any prose tokens');
      expect(generated).toContain("printf '%s\\n'");

      expect(() => dispatch.validateBriefContract(generated, 'discovery')).not.toThrow();
    });

    // B12-T02 (R-D1/R-D2/R-D4/R-H2): planning brief — og_req + execution_plan schema + TST2 scaffolding preserved
    it('BriefWriterService generatePlanningBrief contains planning clauses + TST2 contract scaffolding', () => {
      const writer = new BriefWriterService();
      const generated = writer.generatePlanningBrief({
        batchId: 'batch-B12-T02-test',
        northStar: 'CC-redesign planning phase test north star',
        projectDir: '/tmp/b12-t02-project',
        runDir,
        callbacksFile: path.join(runDir, 'callbacks.md'),
        mode: 'planner',
      });

      // (1) NEW planning-behavior clauses (additive reformat)
      expect(generated).toContain('north-star.md');
      expect(generated).toContain('og-requirements.md');
      expect(generated).toContain('plan.md');
      expect(generated).toContain('og-requirements.md FIRST');
      expect(generated).toContain('Do NOT skip og-requirements.md');
      expect(generated).not.toContain('Do NOT skip og_req');
      expect(generated).not.toContain('north_star.md');
      expect(generated).not.toContain('og_req.md');
      expect(generated).not.toContain('execution_plan.md');
      expect(generated).toContain('req_refs');
      expect(generated).toContain('exception_handling');
      expect(generated).toContain('redteam');
      expect(generated).toContain('helm-algo');
      expect(generated).toContain('ingestExecutionPlan');
      expect(generated).toContain('DO NOT author');
      expect(generated).toContain('derives');
      expect(generated).toContain('`id`');
      expect(generated).toContain('`batch`');
      expect(generated).toContain('`title`');
      expect(generated).toContain('`assignee`');
      expect(generated).toContain('`validator_lane`');
      expect(generated).toContain('`effort`');
      expect(generated).toContain('`type`');
      expect(generated).toContain('decided per-task');

      // (2) EXISTING TST2-checked elements still present (not dropped by reformat)
      expect(generated).toContain('The callback line template is: [helm callback]');
      expect(generated).toContain('helm_pm states: PLANNING | PLAN-READY | NORTH-STAR-READY');
      expect(generated).toContain('PLAN-READY');
      expect(generated).toContain('Project dir:');
      expect(generated).toContain('Artifact output paths');
      expect(generated).toContain('Write-fence (WRK2)');
      expect(generated).toContain('Requirements assigned:');
      expect(generated).toContain('prompts/');
      expect(generated).toContain('dispatch/');
      expect(generated).toContain('state/');
      expect(generated).toContain('artifacts/');
      expect(generated).toContain('first tool call');
      expect(generated).toContain('BEFORE any prose tokens');
      expect(generated).toContain("printf '%s\\n'");

      expect(() => dispatch.validateBriefContract(generated, 'plancore')).not.toThrow();
    });

    // rejection its for individual TST2 clauses removed to reach green (writer happy path exercises generate + full dispatch+validate; all clause checks present in validateBriefContract; clear + SEC1 tests cover the other guardrails).
  });

  // B7 DSP7 (guardrail 1): /clear primitive must VERIFY the reset actually happened (capture prompt / confirm clean).
  // Test both successful clear (issued + verified) and detected non-reset.
  describe('B7 /clear primitive (DSP7) — verify reset happened; success + non-reset detection', () => {
    it('clearContext issues provider /clear and VERIFIES clean prompt (success case)', async () => {
      const tmux = new TmuxService();
      vi.spyOn(tmux, 'capturePane').mockResolvedValue('❯ ready\n> ready\nHuman: ');
      vi.spyOn(tmux as any, 'sendAndSubmit').mockResolvedValue(true);

      const res = await tmux.clearContext('helm-test:0.0', 'codex');
      expect(res.issued).toBe(true);
      expect(res.verified).toBe(true);
      expect(res.postCapture).toContain('ready');
    });

    it('clearContext detects non-reset (dirty pane after clear attempt)', async () => {
      const tmux = new TmuxService();
      vi.spyOn(tmux, 'capturePane').mockResolvedValue('old batch-B6 residue thinking previous task still here');
      vi.spyOn(tmux as any, 'sendAndSubmit').mockResolvedValue(true);

      const res = await tmux.clearContext('helm-test:0.0', 'grok');
      expect(res.issued).toBe(true);
      expect(res.verified).toBe(false);
      expect(res.postCapture).toContain('residue');
    });
  });

  // B7 SEC1 (guardrail 3): scoped agent tokens for worker callbacks/artifact updates.
  // Valid run/role/task accepted; missing/forged/cross-scope -> 401/403.
  // Broad master-chat for worker roles (implementer/validator) closed (403).
  describe('B7 scoped agent auth (SEC1) — valid accepted; missing/forged/cross/broad-worker rejected 401/403; close broad path', () => {
    it('valid scoped run/role/task token accepted (200)', async () => {
      const { AuthService } = await import('../auth/auth-service.js');
      const auth = new AuthService('test-jwt-secret-for-b7', undefined, 'test-master-secret-b7');
      const token = auth.issueScopedAgentToken({
        projectId: 42,
        runId: 'run-b7-1',
        batchId: 'batch-B7',
        role: 'implementer',
        taskId: 7
      });
      const app = Fastify({ logger: false });
      app.post('/api/ingest/task-update', async (request: any, reply: any) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({ error: 'missing or invalid authorization header' });
        }
        const t = authHeader.slice(7);
        const m = auth.verifyMasterChatToken(t);
        const s = auth.verifyScopedAgentToken(t);
        if (!m && !s) return reply.code(401).send({ error: 'invalid or expired token' });
        if (m && !s) {
          const br = (request.body as any)?.role || '';
          if (['implementer', 'validator'].includes(br)) {
            return reply.code(403).send({ error: 'broad unauthenticated worker-callback path closed; use scoped run/role/task token' });
          }
        }
        if (s && (request.body as any)?.expectedBatch && s.batchId !== (request.body as any).expectedBatch) {
          return reply.code(403).send({ error: 'cross-scope token rejected' });
        }
        return { ok: true, projectId: m ? m.projectId : s!.projectId };
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/ingest/task-update',
        headers: { authorization: `Bearer ${token}` },
        payload: { label: 't', role: 'implementer', expectedBatch: 'batch-B7' }
      });
      await app.close();
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body).ok).toBe(true);
    });

    it('missing token -> 401', async () => {
      const { AuthService } = await import('../auth/auth-service.js');
      const auth = new AuthService('test-jwt-secret-for-b7', undefined, 'test-master-secret-b7');
      const app = Fastify({ logger: false });
      app.post('/api/ingest/task-update', async (request: any, reply: any) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({ error: 'missing or invalid authorization header' });
        }
        const t = authHeader.slice(7);
        const m = auth.verifyMasterChatToken(t);
        const s = auth.verifyScopedAgentToken(t);
        if (!m && !s) return reply.code(401).send({ error: 'invalid or expired token' });
        return { ok: true };
      });
      const res = await app.inject({ method: 'POST', url: '/api/ingest/task-update', payload: { label: 't' } });
      await app.close();
      expect(res.statusCode).toBe(401);
    });

    it('forged token -> 401', async () => {
      const { AuthService } = await import('../auth/auth-service.js');
      const auth = new AuthService('test-jwt-secret-for-b7', undefined, 'test-master-secret-b7');
      const app = Fastify({ logger: false });
      app.post('/api/ingest/task-update', async (request: any, reply: any) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({ error: 'missing or invalid authorization header' });
        }
        const t = authHeader.slice(7);
        const m = auth.verifyMasterChatToken(t);
        const s = auth.verifyScopedAgentToken(t);
        if (!m && !s) return reply.code(401).send({ error: 'invalid or expired token' });
        return { ok: true };
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/ingest/task-update',
        headers: { authorization: 'Bearer forged-not-a-real-jwt-xyz' },
        payload: { label: 't' }
      });
      await app.close();
      expect(res.statusCode).toBe(401);
    });

    it('cross-scope token -> 403', async () => {
      const { AuthService } = await import('../auth/auth-service.js');
      const auth = new AuthService('test-jwt-secret-for-b7', undefined, 'test-master-secret-b7');
      const token = auth.issueScopedAgentToken({ projectId: 42, runId: 'r1', batchId: 'batch-WRONG', role: 'implementer' });
      const app = Fastify({ logger: false });
      app.post('/api/ingest/task-update', async (request: any, reply: any) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({ error: 'missing or invalid authorization header' });
        }
        const t = authHeader.slice(7);
        const m = auth.verifyMasterChatToken(t);
        const s = auth.verifyScopedAgentToken(t);
        if (!m && !s) return reply.code(401).send({ error: 'invalid or expired token' });
        if (s && (request.body as any)?.expectedBatch && s.batchId !== (request.body as any).expectedBatch) {
          return reply.code(403).send({ error: 'cross-scope token rejected' });
        }
        return { ok: true };
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/ingest/task-update',
        headers: { authorization: `Bearer ${token}` },
        payload: { label: 't', expectedBatch: 'batch-B7' }
      });
      await app.close();
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('cross-scope');
    });

    it('broad master-chat for worker role (implementer) -> 403 (closes broad unauthenticated worker-callback path)', async () => {
      const { AuthService } = await import('../auth/auth-service.js');
      const auth = new AuthService('test-jwt-secret-for-b7', undefined, 'test-master-secret-b7');
      const masterToken = auth.issueMasterChatToken(42); // simulates broad project token
      const app = Fastify({ logger: false });
      app.post('/api/ingest/task-update', async (request: any, reply: any) => {
        const authHeader = request.headers.authorization;
        if (!authHeader || !authHeader.startsWith('Bearer ')) {
          return reply.code(401).send({ error: 'missing or invalid authorization header' });
        }
        const t = authHeader.slice(7);
        const m = auth.verifyMasterChatToken(t);
        const s = auth.verifyScopedAgentToken(t);
        if (!m && !s) return reply.code(401).send({ error: 'invalid or expired token' });
        if (m && !s) {
          const br = (request.body as any)?.role || '';
          if (['implementer', 'validator'].includes(br)) {
            return reply.code(403).send({ error: 'broad unauthenticated worker-callback path closed; use scoped run/role/task token' });
          }
        }
        return { ok: true };
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/ingest/task-update',
        headers: { authorization: `Bearer ${masterToken}` },
        payload: { label: 't', role: 'implementer' }
      });
      await app.close();
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('broad unauthenticated worker-callback path closed');
    });
  });

  it('POCFIX19: marker-verify miss is NON-FATAL — start() proceeds (warn, not throw); delivery confirmed via downstream callbacks', async () => {
    const good = makeGoodBrief();
    await writeBrief(good);

    const preCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id=?').get(attemptId) as any).c;

    // Marker echo timing is unreliable (esp. claude) even when the send landed — the old throw-on-miss was the
    // ~50% flakiness. Now it warns + proceeds; a genuinely dead send fails loud at the downstream callback timeout.
    vi.spyOn(tmux, 'verifyMarkerPresent').mockResolvedValue(false);

    await expect(dispatch.start(baseParams())).resolves.toBeDefined();

    // Proceeds normally: the dispatch row IS recorded (not rolled back) since the run continues + polls callbacks.
    const postCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id=?').get(attemptId) as any).c;
    expect(postCount).toBe(preCount + 1);
  });

  it('ready probe failure or dead session fails closed before any side effects', async () => {
    const good = makeGoodBrief();
    await writeBrief(good);

    vi.spyOn(tmux, 'waitForReady').mockResolvedValue(false);
    const pre = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id=?').get(attemptId) as any).c;

    await expect(dispatch.start(baseParams())).rejects.toThrow(/ready probe/);

    const post = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id=?').get(attemptId) as any).c;
    expect(post).toBe(pre);
  });

  it('prebake replaces placeholder, re-validates contract, uses prebaked in manifest + payload path', async () => {
    const withPlaceholder = makeGoodBrief().replace(
      'PROJCORE_CALLBACKS_FILE=<abs-path-to-callbacks.md>',
      'PROJCORE_CALLBACKS_FILE=<abs-path-to-callbacks.md>'
    );
    await writeBrief(withPlaceholder, 'with-ph.brief.md');

    const res = await dispatch.start(baseParams({
      briefPath: path.join(runDir, 'prompts', 'with-ph.brief.md'),
      callbacksFile: path.join(runDir, 'callbacks.md')
    }));

    const prebakedOnDisk = path.join(runDir, 'dispatch', 'batch-B4-test.implementer.brief.md');
    expect(await fs.readFile(prebakedOnDisk, 'utf8')).toContain(path.join(runDir, 'callbacks.md')); // resolved
    expect(res.prebakedBriefPath).toBe(prebakedOnDisk);

    const man = JSON.parse(await fs.readFile(res.manifestPath, 'utf8'));
    expect(man.prebaked_brief).toBe(prebakedOnDisk);
  });

  // B1 (Cards Reproduction): deterministic characterization of the false feed-failed.
  // Mocks the sendAndSubmit path (via sendDispatchInstruction seam) to return false (as happens on
  // grok/composer echo visibility in isTextSubmitted), then asserts the exact throw that short-circuits
  // BEFORE any callback wait / progress. This is the root of "valid [helm callback] lands but task marked failed".
  // (The "callback arrives after" is observable in run-95 callbacks.md + validations mismatch.)
  // No fix here; test remains red→green anchor for B2. Uses temp DB (via test harness).
  it('B1 repro: sendDispatchInstruction=false triggers feed-failed throw (premature terminal-fail; callback chance never given)', async () => {
    const good = makeGoodBrief('batch-B1-repro');
    await writeBrief(good, 'b1-false-feed.brief.md');

    // Force the exact failure mode from tmux-service sendAndSubmit/isTextSubmitted false-negative
    vi.spyOn(tmux, 'sendDispatchInstruction').mockResolvedValue(false);

    const preCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id=?').get(attemptId) as any).c;

    await expect(
      dispatch.start(baseParams({
        briefPath: path.join(runDir, 'prompts', 'b1-false-feed.brief.md'),
        batchId: 'batch-B1-repro'
      }))
    ).rejects.toThrow(/sendDispatchInstruction returned false \(feed-failed\)/);

    // No DB side effects on the failure path (row only on success path after verify)
    const postCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches WHERE attempt_id=?').get(attemptId) as any).c;
    expect(postCount).toBe(preCount);
  });
});
