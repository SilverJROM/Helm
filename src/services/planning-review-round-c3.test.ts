process.env.USE_FAKE_TMUX = '1';

/**
 * C3 gate re-scoped (R4.16) — artifact-publication check inside runReviewRound.
 * Scope: planning-review-round.ts only.
 *
 * Proves the structural publication gate after R4.16 re-point (seat-scoped draft / candidate,
 * never pre-promotion canonical plan.md / og-requirements.md):
 * - missing / empty / unparseable seat-scoped plan draft (or candidate) causes zero seat spawns;
 * - empty seat requirements draft causes zero seat spawns;
 * - once listed publication artifacts are present, non-empty and parseable, C2 spawn/wait is unchanged;
 * - the gate is real-mode only (isFake: false) — isFake:true pass-through with no artifacts on disk.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import {
  runReviewRound,
  RunReviewRoundOptions,
  type PublicationArtifactSpec,
} from './planning-review-round.js';
import {
  draftPlanPath,
  draftReqPath,
  candidatePlanPath,
  candidateReqPath,
} from './seat-draft-store.js';

const SEAT_A = 'seat-a';
const SEAT_B = 'seat-b';

const VALID_PLAN_TASKS = [
  {
    id: 'C3-T01',
    batch: 'C3',
    title: 'Prove the publication gate lets a present, parseable seat draft through',
    req_refs: ['R-C3'],
    assignee: 'grok-4.5',
    validator_lane: 'L1',
    effort: 'high',
    type: 'feature',
    deps: [],
  },
];
const VALID_PLAN_MD = '# draft plan — C3 gate test\n```json\n' + JSON.stringify(VALID_PLAN_TASKS, null, 2) + '\n```\n';
const VALID_REQUIREMENTS_MD = '# Requirements\n\n- **R-C3** — publication gate proof\n';
const TRUNCATED_PLAN_MD = '# draft plan — cut off mid-write\n```json\n[{"id": "C3-T01", "title": "cut off mid-w';

describe('runReviewRound artifact-publication gate (C3 re-scoped, R4.16)', () => {
  let runDir: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let registeredSeats: Array<{ role: string; correlationId: string; handle: string; provider?: string; model?: string }>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-c3-publication-gate-'));
    transport = new FakeTransport();
    briefWriter = new BriefWriterService();
    briefs = new Map();
    registeredSeats = [];
    partnerHandles = [];
    partnerRuntimeIds = [];
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  function seatDraftArtifacts(): PublicationArtifactSpec[] {
    return [
      { path: draftPlanPath(runDir, SEAT_A), label: 'seat-a draft plan', validateAsPlan: true },
      { path: draftReqPath(runDir, SEAT_A), label: 'seat-a draft requirements' },
      { path: draftPlanPath(runDir, SEAT_B), label: 'seat-b draft plan', validateAsPlan: true },
      { path: draftReqPath(runDir, SEAT_B), label: 'seat-b draft requirements' },
    ];
  }

  function baseOptions(
    overrides: Partial<RunReviewRoundOptions> = {},
    waitResult = true
  ): RunReviewRoundOptions {
    return {
      transport,
      briefWriter,
      writeBrief: async (role, content) => { briefs.set(role, content); },
      registerWorkerRuntime: (role, correlationId, handle, provider, model) => {
        registeredSeats.push({ role, correlationId, handle, provider, model });
        return registeredSeats.length;
      },
      waitForAgreement: async () => waitResult,
      runDir,
      batchId: 'batch-C3',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath: path.join(runDir, 'callbacks.md'),
      planMdPath: path.join(runDir, 'plan.md'),
      effectiveTimeoutMs: 4000,
      agreementFenceOffset: 0,
      // C3's gate is real-mode only; every test in this file except the explicit fixture-pass-through
      // one below exercises it with isFake: false, matching production (which is never isFake).
      isFake: false,
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  it('blocks with zero seat spawns when seat-scoped draft plans and requirements are both missing', async () => {
    const result = await runReviewRound(baseOptions({
      publicationArtifacts: seatDraftArtifacts(),
    }));

    expect(result.agreed).toBe(false);
    expect(result.partnerBatchIds).toEqual([]);
    expect(result.blockedReasonKind).toBe('artifact-not-published');
    expect(result.blockedReason).toMatch(/ARTIFACT-NOT-PUBLISHED/);
    expect(result.blockedReason).toMatch(/seat-a draft plan not yet published/);
    expect(result.blockedReason).toMatch(/seat-a draft requirements not yet published/);
    expect(result.roundsAttempted).toBe(0);
    expect(transport.spawnCalls).toHaveLength(0);
    expect(briefs.size).toBe(0);
    expect(partnerHandles).toHaveLength(0);
    expect(partnerRuntimeIds).toHaveLength(0);
  });

  it('blocks with zero seat spawns when seat draft plan exists but is empty (mid-write truncation)', async () => {
    await fs.mkdir(path.dirname(draftPlanPath(runDir, SEAT_A)), { recursive: true });
    await fs.writeFile(draftPlanPath(runDir, SEAT_A), '', 'utf8');
    await fs.writeFile(draftReqPath(runDir, SEAT_A), VALID_REQUIREMENTS_MD, 'utf8');
    await fs.mkdir(path.dirname(draftPlanPath(runDir, SEAT_B)), { recursive: true });
    await fs.writeFile(draftPlanPath(runDir, SEAT_B), VALID_PLAN_MD, 'utf8');
    await fs.writeFile(draftReqPath(runDir, SEAT_B), VALID_REQUIREMENTS_MD, 'utf8');

    const result = await runReviewRound(baseOptions({
      publicationArtifacts: seatDraftArtifacts(),
    }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('artifact-not-published');
    expect(result.blockedReason).toMatch(/seat-a draft plan is empty/);
    expect(transport.spawnCalls).toHaveLength(0);
  });

  it('blocks with zero seat spawns when seat draft plan exists but does not parse (truncated fenced json)', async () => {
    await fs.mkdir(path.dirname(draftPlanPath(runDir, SEAT_A)), { recursive: true });
    await fs.writeFile(draftPlanPath(runDir, SEAT_A), TRUNCATED_PLAN_MD, 'utf8');
    await fs.writeFile(draftReqPath(runDir, SEAT_A), VALID_REQUIREMENTS_MD, 'utf8');
    await fs.mkdir(path.dirname(draftPlanPath(runDir, SEAT_B)), { recursive: true });
    await fs.writeFile(draftPlanPath(runDir, SEAT_B), VALID_PLAN_MD, 'utf8');
    await fs.writeFile(draftReqPath(runDir, SEAT_B), VALID_REQUIREMENTS_MD, 'utf8');

    const result = await runReviewRound(baseOptions({
      publicationArtifacts: seatDraftArtifacts(),
    }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('artifact-not-published');
    expect(result.blockedReason).toMatch(/does not yet parse as a complete plan/);
    expect(transport.spawnCalls).toHaveLength(0);
  });

  it('blocks with zero seat spawns when seat draft requirements exist but are empty', async () => {
    await fs.mkdir(path.dirname(draftPlanPath(runDir, SEAT_A)), { recursive: true });
    await fs.writeFile(draftPlanPath(runDir, SEAT_A), VALID_PLAN_MD, 'utf8');
    await fs.writeFile(draftReqPath(runDir, SEAT_A), '   \n', 'utf8');
    await fs.mkdir(path.dirname(draftPlanPath(runDir, SEAT_B)), { recursive: true });
    await fs.writeFile(draftPlanPath(runDir, SEAT_B), VALID_PLAN_MD, 'utf8');
    await fs.writeFile(draftReqPath(runDir, SEAT_B), VALID_REQUIREMENTS_MD, 'utf8');

    const result = await runReviewRound(baseOptions({
      publicationArtifacts: seatDraftArtifacts(),
    }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('artifact-not-published');
    expect(result.blockedReason).toMatch(/seat-a draft requirements is empty/);
    expect(transport.spawnCalls).toHaveLength(0);
  });

  it('allows the existing C2 spawn/wait behavior once seat-scoped drafts are present, non-empty and parseable', async () => {
    await fs.mkdir(path.dirname(draftPlanPath(runDir, SEAT_A)), { recursive: true });
    await fs.writeFile(draftPlanPath(runDir, SEAT_A), VALID_PLAN_MD, 'utf8');
    await fs.writeFile(draftReqPath(runDir, SEAT_A), VALID_REQUIREMENTS_MD, 'utf8');
    await fs.mkdir(path.dirname(draftPlanPath(runDir, SEAT_B)), { recursive: true });
    await fs.writeFile(draftPlanPath(runDir, SEAT_B), VALID_PLAN_MD, 'utf8');
    await fs.writeFile(draftReqPath(runDir, SEAT_B), VALID_REQUIREMENTS_MD, 'utf8');

    const result = await runReviewRound(baseOptions({
      publicationArtifacts: seatDraftArtifacts(),
      coPlannerSeats: [
        { slot: 0, provider: 'grok', model: 'grok-4.5' },
        { slot: 1, provider: 'anthropic', model: 'claude-sonnet' },
      ],
    }, true));

    expect(result.agreed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(result.blockedReasonKind).toBeUndefined();
    expect(result.partnerBatchIds).toEqual(['batch-C3-partner', 'batch-C3-partner-2']);
    expect(transport.spawnCalls).toHaveLength(2);
    expect(briefs.has('planner')).toBe(true);
    expect(briefs.has('planner-2')).toBe(true);
    expect(partnerHandles).toHaveLength(2);
    expect(partnerRuntimeIds).toEqual([1, 2]);
  });

  it('gates round-2+ candidate paths the same way (exist, non-empty, plan parses)', async () => {
    const candPlan = candidatePlanPath(runDir);
    const candReq = candidateReqPath(runDir);
    await fs.writeFile(candPlan, VALID_PLAN_MD, 'utf8');
    await fs.writeFile(candReq, VALID_REQUIREMENTS_MD, 'utf8');

    const result = await runReviewRound(baseOptions({
      publicationArtifacts: [
        { path: candPlan, label: 'candidate plan', validateAsPlan: true },
        { path: candReq, label: 'candidate requirements' },
      ],
      coPlannerSeats: [{ slot: 0, provider: 'grok', model: 'grok-4.5' }],
    }, true));

    expect(result.agreed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(transport.spawnCalls).toHaveLength(1);
  });

  it('never runs the gate under the fixture harness (isFake: true), preserving C2 behavior with no artifacts on disk', async () => {
    const result = await runReviewRound(baseOptions({ isFake: true }, true));

    expect(result.agreed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(transport.spawnCalls).toHaveLength(1);
    await expect(fs.access(path.join(runDir, 'plan.md'))).rejects.toThrow();
    await expect(fs.access(path.join(runDir, 'og-requirements.md'))).rejects.toThrow();
  });
});
