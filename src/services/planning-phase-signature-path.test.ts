/**
 * P3 (R3.11/R3.14/R6.21): fail-closed signature path on the PPS (PlanningPhaseService) boundary.
 *
 * Bug this proves fixed: after P1 retired plancore as a spawned/authoring seat, nothing in a real
 * (non-adaptive) planning run ever posts brain `PLAN-READY` any more — yet `waitForAgreement`'s
 * whole-plan gate still required `sawPlanReady` (planning-phase-service.ts's brain half) before
 * agreeing, alongside unanimous partner CLEAN. That is an unconditional deadlock: no seat left to
 * satisfy it. The fix adds an additive `signatureOnly` mode to `waitForAgreement` (default false,
 * byte-identical to every existing B3/B4/B5 direct call) and the production non-adaptive round loop
 * (planning-review-round.ts's `runReviewRound`) now always passes `signatureOnly:true` for its one
 * `waitForAgreement` call — dropping the PLAN-READY precondition while leaving B5's current-plan SHA
 * binding and the BROKEN raceguard completely untouched (R6.21 fail-closed).
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';
import { planRevision } from './plan-revision.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function svc(): any {
  return new PlanningPhaseService({} as any, {} as any, {} as any);
}

function canonicalPlanMd(tasks: unknown[]): string {
  return `# Plan\n\n\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\`\n`;
}

describe('waitForAgreement — signatureOnly mode (P3/R3.11/R3.14/R6.21)', () => {
  let runDir: string;
  let cbPath: string;
  let planPath: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-p3-sig-'));
    cbPath = path.join(runDir, 'callbacks.md');
    planPath = path.join(runDir, 'plan.md');
    await fs.writeFile(cbPath, '', 'utf8');
  });

  afterEach(async () => {
    await fs.rm(runDir, { recursive: true, force: true });
  });

  it('signatureOnly:true agrees on unanimous current-plan CLEAN with NO brain PLAN-READY ever posted (R3.14)', async () => {
    const batchId = 'P3T1';
    const partnerBatchIds = [`${batchId}-partner`];
    const r1 = planRevision('# Plan R1\n');
    await fs.writeFile(planPath, '# Plan R1\n', 'utf8');
    // No PLAN-READY line anywhere in callbacks.md — only the partner's own CLEAN verdict.
    await fs.appendFile(
      cbPath,
      `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN plan=${r1.short12} reviewed R1\n`,
      'utf8'
    );

    const agreed = await svc().waitForAgreement(
      cbPath, batchId, 'planner', 'plancore', 500, 0, partnerBatchIds, planPath, planPath, true
    );

    expect(agreed).toBe(true);
  });

  it('signatureOnly:true still fails closed on a missing/stale plan= claim (R6.21 — does not loosen B5)', async () => {
    const batchId = 'P3T2';
    const r1 = planRevision('# Plan R1\n');
    await fs.writeFile(planPath, '# Plan R1\n', 'utf8');

    // Case 1: CLEAN with no plan= field at all.
    const partnerBatchIdsMissing = [`${batchId}m-partner`];
    await fs.appendFile(
      cbPath,
      `[helm callback] planner ${batchId}m-partner STATUS: VERDICT-READY — CLEAN no sha here\n`,
      'utf8'
    );
    const agreedMissing = await svc().waitForAgreement(
      cbPath, `${batchId}m`, 'planner', 'plancore', 120, 0, partnerBatchIdsMissing, planPath, planPath, true
    );
    expect(agreedMissing).toBe(false);

    // Case 2: CLEAN with a well-formed but superseded (stale) sha.
    const staleSha = planRevision('# Plan STALE\n').short12;
    const partnerBatchIdsStale = [`${batchId}s-partner`];
    await fs.appendFile(
      cbPath,
      `[helm callback] planner ${batchId}s-partner STATUS: VERDICT-READY — CLEAN plan=${staleSha} reviewed a superseded revision\n`,
      'utf8'
    );
    const agreedStale = await svc().waitForAgreement(
      cbPath, `${batchId}s`, 'planner', 'plancore', 120, 0, partnerBatchIdsStale, planPath, planPath, true
    );
    expect(agreedStale).toBe(false);
    expect(staleSha).not.toBe(r1.short12);
  });

  it('signatureOnly:true still lets a BROKEN verdict fail closed/dispositively (raceguard untouched)', async () => {
    const batchId = 'P3T3';
    const partnerBatchIds = [`${batchId}-partner`];
    const r1 = planRevision('# Plan R1\n');
    await fs.writeFile(planPath, '# Plan R1\n', 'utf8');
    await fs.appendFile(
      cbPath,
      `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — BROKEN plan=${r1.short12} missing validation criteria\n`,
      'utf8'
    );

    const start = Date.now();
    const agreed = await svc().waitForAgreement(
      cbPath, batchId, 'planner', 'plancore', 5000, 0, partnerBatchIds, planPath, planPath, true
    );
    const elapsed = Date.now() - start;

    expect(agreed).toBe(false);
    expect(elapsed).toBeLessThan(500);
  });

  it('default (signatureOnly omitted): unchanged pre-P3 behaviour — unanimous CLEAN with no PLAN-READY still refuses', async () => {
    const batchId = 'P3T4';
    const partnerBatchIds = [`${batchId}-partner`];
    const r1 = planRevision('# Plan R1\n');
    await fs.writeFile(planPath, '# Plan R1\n', 'utf8');
    await fs.appendFile(
      cbPath,
      `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN plan=${r1.short12} reviewed R1\n`,
      'utf8'
    );

    const agreed = await svc().waitForAgreement(
      cbPath, batchId, 'planner', 'plancore', 200, 0, partnerBatchIds, planPath, planPath
    );

    expect(agreed).toBe(false);
  });
});

describe('runPlanningPhase — production non-adaptive path never requires brain PLAN-READY (P3)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let tmpDb: string;
  let dbs: DatabaseService;
  let art: RunArtifactService;
  let queue: TaskQueueService;
  let phase: PlanningPhaseService;
  let origFake: string | undefined;
  let origPlanTo: string | undefined;

  beforeEach(async () => {
    process.env.USE_FAKE_TMUX = '1'; // FakeTransport enforces this at construction time.
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-p3-real-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# P3 signature-path callbacks\n', 'utf8');
    transport = new FakeTransport();
    tmpDb = path.join(os.tmpdir(), `helm-p3-real-${Date.now()}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    phase = new PlanningPhaseService(transport, art, queue);
    origFake = process.env.USE_FAKE_TMUX;
    origPlanTo = process.env.HELM_PLANNING_TIMEOUT_MS;
  });

  afterEach(async () => {
    process.env.USE_FAKE_TMUX = origFake ?? '1';
    if (origPlanTo === undefined) delete (process.env as any).HELM_PLANNING_TIMEOUT_MS;
    else process.env.HELM_PLANNING_TIMEOUT_MS = origPlanTo;
    if (dbs) dbs.close();
    if (tmpDb) await fs.rm(tmpDb, { force: true }).catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('real (!USE_FAKE_TMUX) planning run agrees from partner CLEAN plan=<sha12> alone — brain PLAN-READY is never posted', async () => {
    process.env.USE_FAKE_TMUX = '0';
    process.env.HELM_PLANNING_TIMEOUT_MS = '8000';

    const batchId = 'batch-P3-signature-only';
    const planMarkdown = canonicalPlanMd([{
      id: 'P3SIG-1', batch: 'B1', title: 'Production planning agrees without brain PLAN-READY',
      req_refs: ['P3SIG-R1'], assignee: 'L1', validator_lane: 'L1', effort: 'low', type: 'feature', deps: [],
      validation_criteria: 'agreement reached purely from signature-shaped partner evidence',
    }]);
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), '- **P3SIG-R1** — no brain PLAN-READY needed.\n', 'utf8');
    await fs.writeFile(path.join(runDir, 'plan.md'), planMarkdown, 'utf8');
    const short12 = planRevision(planMarkdown).short12;

    const p = phase.runPlanningPhase({
      runDir,
      batchId,
      northStar: 'Production signature-path proof: no brain PLAN-READY line is ever posted.',
      conversationLog: 'Single atomic real-mode check.',
      mode: 'planner',
    });
    const cbp = path.join(runDir, 'callbacks.md');
    // Only the partner ever posts anything — no `[helm callback] plancore ... STATUS: PLAN-READY`
    // line is appended anywhere in this test, proving the gate no longer needs it.
    await fs.appendFile(cbp, `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN plan=${short12} agree\n`);

    const res = await p;

    expect(res.agreed).toBe(true);
    expect(res.blockedReasonKind).toBeUndefined();
    expect(res.plan.tasks[0].task_key).toBe('P3SIG-1');
    // Dispositive: no line matching plancore/brainRole STATUS PLAN-READY ever appears in callbacks.md.
    const cbContents = await fs.readFile(cbp, 'utf8');
    expect(cbContents).not.toMatch(/plancore\s+\S+\s+STATUS:\s+PLAN-READY/);
  }, 15000);
});
