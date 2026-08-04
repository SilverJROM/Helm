process.env.USE_FAKE_TMUX = '1'; // FakeTransport enforces this at construction time.

/**
 * P2 (R1.4/R2.5/R3.14): promotion + failure rename.
 *
 * On `agreed:true` from ROUND with a signed candidate (`proposerSignerRound.candidatePlanPath` /
 * `candidateReqPath` — the ONE place `agreed:true` is ever decided, per R3.11/R3.14's
 * `waitForCandidateSignature` gate), the engine — and only the engine — atomically copies those
 * exact candidate bytes to the canonical `plan.md`/`og-requirements.md` paths under
 * `canonicalArtifactRoot` (R2.5), then ingests that copy. No polling, no plancore-authored
 * fallback: the signer already signed these bytes, so there is nothing left to wait for.
 *
 * `runReviewRound` is mocked here (replaced, not delegated) so the test can hand
 * `runPlanningPhase` a `ReviewRoundResult` carrying `proposerSignerRound` directly, without
 * re-driving the full blind-draft -> reconcile -> signature callback grammar already covered by
 * `planning-review-round-signature-gate.test.ts` and `planning-review-round-blind-draft.test.ts`.
 * This file's scope is strictly the ENGINE's reaction to that result, not ROUND's internals.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';
import { planRevision } from './plan-revision.js';
import type { ReviewRoundResult, ProposerSignerRoundResult } from './planning-review-round.js';

let mockedRoundResult: ReviewRoundResult | null = null;
vi.mock('./planning-review-round.js', async (importActual) => {
  const actual = await importActual<typeof import('./planning-review-round.js')>();
  return {
    ...actual,
    runReviewRound: async () => {
      if (!mockedRoundResult) throw new Error('test forgot to set mockedRoundResult before calling runPlanningPhase');
      return mockedRoundResult;
    },
  };
});

function candidatePlanMd(taskKey: string): string {
  return `# Plan\n\n\`\`\`json\n${JSON.stringify(
    [{
      id: taskKey, batch: 'B1', title: `Do ${taskKey}`, req_refs: [`${taskKey}-R1`],
      assignee: 'L1', validator_lane: 'L1', effort: 'low', type: 'feature', deps: [],
      validation_criteria: 'signed candidate promoted verbatim by the engine',
    }],
    null, 2
  )}\n\`\`\`\n`;
}

function signedCandidateResult(opts: {
  candidatePlanPath: string;
  candidateReqPath: string;
  candidatePlanBytes: string;
  signerBatchId?: string;
}): ProposerSignerRoundResult {
  return {
    agreed: true,
    hashMatch: true,
    designatedSeatId: 'partner',
    designationLog: 'lower-sha256-of-round1-drafts: partner',
    roundProposerSeatId: 'partner',
    reconcileSpawned: false,
    proposerBatchId: null,
    signerSeatId: 'partner-2',
    signerBatchId: opts.signerBatchId ?? 'batch-p2-promote-r2-signer',
    candidatePlanPath: opts.candidatePlanPath,
    candidateReqPath: opts.candidateReqPath,
    candidatePlan: planRevision(opts.candidatePlanBytes),
    signerDecision: 'signed-agreed',
  };
}

describe('P2 (R2.5/R3.14): engine promotes the signed candidate to canonical plan.md/og-requirements.md', () => {
  let runDir: string;
  let transport: FakeTransport;
  let tmpDb: string;
  let dbs: DatabaseService;
  let art: RunArtifactService;
  let queue: TaskQueueService;
  let phase: PlanningPhaseService;
  let candidateDir: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-p2-candidate-promote-'));
    candidateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-p2-candidate-src-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# P2 candidate-promote callbacks\n', 'utf8');
    transport = new FakeTransport();
    tmpDb = path.join(os.tmpdir(), `helm-p2-candidate-promote-${process.pid}-${Math.trunc(performance.now() * 1000)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    phase = new PlanningPhaseService(transport, art, queue);
    mockedRoundResult = null;
  });

  afterEach(async () => {
    mockedRoundResult = null;
    if (dbs) dbs.close();
    if (tmpDb) await fs.rm(tmpDb, { force: true }).catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    if (candidateDir) await fs.rm(candidateDir, { recursive: true, force: true }).catch(() => {});
  });

  it('copies the exact signed candidate bytes to canonical plan.md/og-requirements.md under canonicalArtifactRoot and ingests them, without polling', async () => {
    const candidatePlanPath = path.join(candidateDir, 'candidate-plan.md');
    const candidateReqPath = path.join(candidateDir, 'candidate-req.md');
    const planBytes = candidatePlanMd('P2-PROMOTE-1');
    const reqBytes = '- **P2-PROMOTE-1-R1** — signed candidate requirement.\n';
    await fs.writeFile(candidatePlanPath, planBytes, 'utf8');
    await fs.writeFile(candidateReqPath, reqBytes, 'utf8');

    const canonicalArtifactRoot = path.join(runDir, 'cycle-workspace');
    mockedRoundResult = {
      agreed: true,
      partnerBatchIds: ['batch-p2-promote-r2-signer'],
      roundsAttempted: 2,
      proposerSignerRound: signedCandidateResult({ candidatePlanPath, candidateReqPath, candidatePlanBytes: planBytes }),
    };

    const start = Date.now();
    const res = await phase.runPlanningPhase({
      runDir,
      canonicalArtifactRoot,
      batchId: 'batch-p2-promote',
      northStar: 'Simple single-module feature.',
      conversationLog: 'Clear scope, no cross module risk.',
      mode: 'planner',
    });
    const elapsed = Date.now() - start;

    // No 120ms grace sleep, no poll loop — the signer already signed these exact bytes, so the
    // legacy pre-signature wait path (only reachable when proposerSignerRound is absent) never runs.
    expect(elapsed).toBeLessThan(100);

    expect(res.agreed).toBe(true);
    expect(await fs.readFile(path.join(canonicalArtifactRoot, 'plan.md'), 'utf8')).toBe(planBytes);
    expect(await fs.readFile(path.join(canonicalArtifactRoot, 'og-requirements.md'), 'utf8')).toBe(reqBytes);
    expect(res.plan.tasks[0].task_key).toBe('P2-PROMOTE-1');
    expect(res.createdTaskIds.length).toBeGreaterThan(0);
    expect(res.keyToId['P2-PROMOTE-1']).toBeTypeOf('number');
  });

  it('overwrites a stale pre-existing canonical plan.md/og-requirements.md — the engine is the only writer of those paths (R2.5)', async () => {
    const candidatePlanPath = path.join(candidateDir, 'candidate-plan.md');
    const candidateReqPath = path.join(candidateDir, 'candidate-req.md');
    const planBytes = candidatePlanMd('P2-PROMOTE-2');
    const reqBytes = '- **P2-PROMOTE-2-R1** — fresh signed candidate requirement.\n';
    await fs.writeFile(candidatePlanPath, planBytes, 'utf8');
    await fs.writeFile(candidateReqPath, reqBytes, 'utf8');

    const canonicalArtifactRoot = path.join(runDir, 'cycle-workspace-stale');
    await fs.mkdir(canonicalArtifactRoot, { recursive: true });
    // Stale canonical bytes from a prior (or hand-tampered) state — must never survive promotion.
    await fs.writeFile(path.join(canonicalArtifactRoot, 'plan.md'), candidatePlanMd('STALE-NEVER-SIGNED'), 'utf8');
    await fs.writeFile(path.join(canonicalArtifactRoot, 'og-requirements.md'), '- **STALE-R1** — must be overwritten.\n', 'utf8');

    mockedRoundResult = {
      agreed: true,
      partnerBatchIds: ['batch-p2-overwrite-r2-signer'],
      roundsAttempted: 1,
      proposerSignerRound: signedCandidateResult({
        candidatePlanPath, candidateReqPath, candidatePlanBytes: planBytes,
        signerBatchId: 'batch-p2-overwrite-r2-signer',
      }),
    };

    const res = await phase.runPlanningPhase({
      runDir,
      canonicalArtifactRoot,
      batchId: 'batch-p2-overwrite',
      northStar: 'Simple single-module feature.',
      conversationLog: 'Clear scope, no cross module risk.',
      mode: 'planner',
    });

    expect(res.plan.tasks[0].task_key).toBe('P2-PROMOTE-2');
    const finalPlan = await fs.readFile(path.join(canonicalArtifactRoot, 'plan.md'), 'utf8');
    expect(finalPlan).toBe(planBytes);
    expect(finalPlan).not.toContain('STALE-NEVER-SIGNED');
    expect(await fs.readFile(path.join(canonicalArtifactRoot, 'og-requirements.md'), 'utf8')).toBe(reqBytes);
  });

  it('B6 discipline holds for the new promotion path too: agreed:false never writes canonicalArtifactRoot, even with a candidate ready', async () => {
    const candidatePlanPath = path.join(candidateDir, 'candidate-plan.md');
    const candidateReqPath = path.join(candidateDir, 'candidate-req.md');
    const planBytes = candidatePlanMd('P2-SHOULD-NEVER-PROMOTE');
    await fs.writeFile(candidatePlanPath, planBytes, 'utf8');
    await fs.writeFile(candidateReqPath, '- should never be promoted\n', 'utf8');

    const canonicalArtifactRoot = path.join(runDir, 'cycle-workspace-blocked');
    const blockedProposerSignerRound = signedCandidateResult({
      candidatePlanPath, candidateReqPath, candidatePlanBytes: planBytes,
      signerBatchId: 'batch-p2-blocked-r3-signer',
    });
    mockedRoundResult = {
      agreed: false,
      partnerBatchIds: ['batch-p2-blocked-partner'],
      roundsAttempted: 3,
      blockedReasonKind: 'objection-not-monotone',
      blockedReason: 'OBJECTION-NOT-MONOTONE (test fixture): defect count did not shrink.',
      // Even though a candidate exists on disk from an earlier round, ROUND itself reports
      // agreed:false here (e.g. the final round's signer objected) — the engine must never promote.
      proposerSignerRound: { ...blockedProposerSignerRound, agreed: false, signerDecision: 'objections', objections: 'n=1; 1. still diverges' },
    };

    const res = await phase.runPlanningPhase({
      runDir,
      canonicalArtifactRoot,
      batchId: 'batch-p2-blocked',
      northStar: 'Simple single-module feature.',
      conversationLog: 'Clear scope, no cross module risk.',
      mode: 'planner',
    });

    expect(res.agreed).toBe(false);
    expect(res.plan).toEqual({ tasks: [] });
    expect(res.createdTaskIds).toEqual([]);
    await expect(fs.access(path.join(canonicalArtifactRoot, 'plan.md'))).rejects.toThrow();
    await expect(fs.access(path.join(canonicalArtifactRoot, 'og-requirements.md'))).rejects.toThrow();
  });
});

describe('R1.4: the canonical-plan failure token is candidate/signature-shaped, not agent-named', () => {
  it('planning-phase-service.ts no longer contains PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN and throws NO-AGREED-PLAN-CANDIDATE instead', () => {
    const source = fssync.readFileSync(path.join(process.cwd(), 'src/services/planning-phase-service.ts'), 'utf8');
    expect(source).not.toContain('PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN');
    expect(source).toContain('NO-AGREED-PLAN-CANDIDATE');
  });
});
