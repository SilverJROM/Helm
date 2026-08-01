process.env.USE_FAKE_TMUX = '1';

/**
 * R4.16 — C3 re-scope proof: the publication gate never requires pre-promotion canonical
 * plan.md / og-requirements.md; round-1 is runDir/context only; round-2+ keys off seat-scoped
 * draft or candidate descriptors only.
 *
 * Complements planning-review-round-c3.test.ts (which exercises the positive/negative paths of the
 * re-pointed gate once publicationArtifacts are supplied).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { runReviewRound, RunReviewRoundOptions } from './planning-review-round.js';
import {
  draftPlanPath,
  draftReqPath,
  candidatePlanPath,
} from './seat-draft-store.js';

const VALID_PLAN_TASKS = [
  {
    id: 'R416-T01',
    batch: 'R4',
    title: 'Prove C3 never keys off pre-promotion canonical paths',
    req_refs: ['R4.16'],
    assignee: 'grok-4.5',
    validator_lane: 'L1',
    effort: 'high',
    type: 'feature',
    deps: [],
  },
];
const VALID_PLAN_MD =
  '# plan — R4.16 gate re-scope\n```json\n' + JSON.stringify(VALID_PLAN_TASKS, null, 2) + '\n```\n';
const VALID_REQUIREMENTS_MD = '# Requirements\n\n- **R4.16** — C3 re-scoped to seat-scoped artifacts\n';

describe('C3 publication gate re-scoped away from canonical paths (R4.16)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-c3-gate-rescoped-'));
    transport = new FakeTransport();
    briefWriter = new BriefWriterService();
    partnerHandles = [];
    partnerRuntimeIds = [];
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  function baseOptions(overrides: Partial<RunReviewRoundOptions> = {}): RunReviewRoundOptions {
    return {
      transport,
      briefWriter,
      writeBrief: async () => {},
      registerWorkerRuntime: () => 1,
      waitForAgreement: async () => true,
      runDir,
      batchId: 'batch-R416',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath: path.join(runDir, 'callbacks.md'),
      planMdPath: path.join(runDir, 'plan.md'),
      effectiveTimeoutMs: 4000,
      agreementFenceOffset: 0,
      isFake: false,
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  it('round-1 (no publicationArtifacts): missing canonical plan.md/og-requirements.md does NOT block spawn', async () => {
    // Canonical paths deliberately absent — under the old C3 this blocked 100% of redesign runs.
    await expect(fs.access(path.join(runDir, 'plan.md'))).rejects.toThrow();
    await expect(fs.access(path.join(runDir, 'og-requirements.md'))).rejects.toThrow();

    const result = await runReviewRound(baseOptions({
      coPlannerSeats: [{ slot: 0, provider: 'grok', model: 'grok-4.5' }],
    }));

    expect(result.agreed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(result.blockedReasonKind).toBeUndefined();
    expect(transport.spawnCalls).toHaveLength(1);
  });

  it('round-1: optional contextInputPaths are checked; missing context blocks without requiring canonical plan', async () => {
    const northStar = path.join(runDir, 'north-star.md');
    // north-star deliberately not written

    const result = await runReviewRound(baseOptions({
      contextInputPaths: [northStar],
    }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('artifact-not-published');
    expect(result.blockedReason).toMatch(/ARTIFACT-NOT-PUBLISHED/);
    expect(result.blockedReason).toMatch(/round-1/);
    expect(result.blockedReason).toMatch(/context input not yet available/);
    expect(result.blockedReason).not.toMatch(/plan\.md not yet published/);
    expect(result.blockedReason).not.toMatch(/og-requirements\.md not yet published/);
    expect(transport.spawnCalls).toHaveLength(0);
  });

  it('round-1: present context inputs allow spawn while canonical plan/req stay absent', async () => {
    const northStar = path.join(runDir, 'north-star.md');
    await fs.writeFile(northStar, '# North star\n', 'utf8');

    const result = await runReviewRound(baseOptions({
      contextInputPaths: [northStar],
      coPlannerSeats: [{ slot: 0, provider: 'grok', model: 'grok-4.5' }],
    }));

    expect(result.agreed).toBe(true);
    expect(transport.spawnCalls).toHaveLength(1);
    await expect(fs.access(path.join(runDir, 'plan.md'))).rejects.toThrow();
    await expect(fs.access(path.join(runDir, 'og-requirements.md'))).rejects.toThrow();
  });

  it('canonical plan.md/og-requirements.md present alone do NOT satisfy a seat-draft publicationArtifacts gate', async () => {
    // Old C3 would have passed on these; re-scoped gate ignores them when descriptors point at drafts.
    await fs.writeFile(path.join(runDir, 'plan.md'), VALID_PLAN_MD, 'utf8');
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), VALID_REQUIREMENTS_MD, 'utf8');

    const seatId = 'co-a';
    const result = await runReviewRound(baseOptions({
      publicationArtifacts: [
        { path: draftPlanPath(runDir, seatId), label: 'co-a draft plan', validateAsPlan: true },
        { path: draftReqPath(runDir, seatId), label: 'co-a draft requirements' },
      ],
    }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('artifact-not-published');
    expect(result.blockedReason).toMatch(/co-a draft plan not yet published/);
    expect(result.blockedReason).toMatch(/co-a draft requirements not yet published/);
    // Must not claim the gate is about canonical paths.
    expect(result.blockedReason).not.toMatch(/plan\.md not yet published/);
    expect(result.blockedReason).not.toMatch(/og-requirements\.md not yet published/);
    expect(transport.spawnCalls).toHaveLength(0);
  });

  it('missing candidate plan blocks when publicationArtifacts lists the candidate (round-2+)', async () => {
    const result = await runReviewRound(baseOptions({
      publicationArtifacts: [
        { path: candidatePlanPath(runDir), label: 'candidate plan', validateAsPlan: true },
      ],
    }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('artifact-not-published');
    expect(result.blockedReason).toMatch(/candidate plan not yet published/);
    expect(transport.spawnCalls).toHaveLength(0);
  });

  it('empty candidate plan blocks; unparseable candidate plan blocks; valid candidate allows spawn', async () => {
    const cand = candidatePlanPath(runDir);

    await fs.writeFile(cand, '', 'utf8');
    let result = await runReviewRound(baseOptions({
      publicationArtifacts: [{ path: cand, label: 'candidate plan', validateAsPlan: true }],
    }));
    expect(result.agreed).toBe(false);
    expect(result.blockedReason).toMatch(/candidate plan is empty/);
    expect(transport.spawnCalls).toHaveLength(0);

    await fs.writeFile(cand, '# cut off\n```json\n[{"id":', 'utf8');
    result = await runReviewRound(baseOptions({
      publicationArtifacts: [{ path: cand, label: 'candidate plan', validateAsPlan: true }],
    }));
    expect(result.agreed).toBe(false);
    expect(result.blockedReason).toMatch(/does not yet parse as a complete plan/);
    expect(transport.spawnCalls).toHaveLength(0);

    await fs.writeFile(cand, VALID_PLAN_MD, 'utf8');
    result = await runReviewRound(baseOptions({
      publicationArtifacts: [{ path: cand, label: 'candidate plan', validateAsPlan: true }],
      coPlannerSeats: [{ slot: 0, provider: 'grok', model: 'grok-4.5' }],
    }));
    expect(result.agreed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(transport.spawnCalls).toHaveLength(1);
  });

  it('isFake: true still exempts the gate entirely (even with missing publicationArtifacts targets)', async () => {
    const result = await runReviewRound(baseOptions({
      isFake: true,
      publicationArtifacts: [
        { path: draftPlanPath(runDir, 'ghost'), label: 'ghost draft plan', validateAsPlan: true },
      ],
    }));

    expect(result.agreed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(transport.spawnCalls).toHaveLength(1);
  });
});
