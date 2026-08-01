process.env.USE_FAKE_TMUX = '1';

/**
 * R6 gate — objection monotonicity (R3.13, R6.24).
 *
 * Scope: the round loop inside `runReviewRound` (planning-review-round.ts) parses the signer's
 * bounded numbered defect list (`OBJECTIONS — n=<k>; 1. …`), stores the count per objections round,
 * and typed-BLOCKs early with `blockedReasonKind: 'objection-not-monotone'` when round N+1's count
 * is not strictly smaller than round N's — without burning remaining round-cap budget.
 *
 * Also proves `parseBoundedObjectionList` fail-closed counting (declared n must equal parsed items;
 * mismatch is never counted as zero) and registers sweep mode `objection-monotonicity` (R6.24).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import {
  runReviewRound,
  parseBoundedObjectionList,
  MAX_BOUNDED_OBJECTIONS,
  type RunReviewRoundOptions,
} from './planning-review-round.js';
import {
  draftPlanPath,
  candidatePlanPath,
  atomicWriteFile,
} from './seat-draft-store.js';
import { planRevision } from './plan-revision.js';
import {
  getRegressionMode,
  listRegressionModes,
  resolveRegressionMode,
  registerRegressionMode,
  RegressionModeRegistrationError,
} from './planning-regression-modes.js';

describe('parseBoundedObjectionList (R6 / R3.13)', () => {
  it('parseBoundedObjectionList: declared n must equal parsed item count (never counts mismatch as zero)', () => {
    const ok = parseBoundedObjectionList(
      'n=2; 1. Task B12-T02 has no req_refs. 2. Effort "L" is not a valid enum value.',
    );
    expect(ok).toEqual({
      ok: true,
      declaredN: 2,
      count: 2,
      defects: [
        'Task B12-T02 has no req_refs.',
        'Effort "L" is not a valid enum value.',
      ],
    });

    // Declared n=3 but only two numbered items — fail-closed, never count as 0.
    const mismatch = parseBoundedObjectionList('n=3; 1. Only one. 2. Only two.');
    expect(mismatch.ok).toBe(false);
    if (!mismatch.ok) {
      expect(mismatch.reason).toMatch(/n-count-mismatch/);
    }

    // Empty / missing note — fail-closed, never zero.
    expect(parseBoundedObjectionList(null).ok).toBe(false);
    expect(parseBoundedObjectionList('').ok).toBe(false);
    expect(parseBoundedObjectionList('no n header here').ok).toBe(false);

    // n=0 is invalid (never progress-as-zero).
    expect(parseBoundedObjectionList('n=0;').ok).toBe(false);

    // Non-contiguous numbering.
    const skip = parseBoundedObjectionList('n=2; 1. First. 3. Skipped two.');
    expect(skip.ok).toBe(false);

    // Over max bound.
    const tooMany = parseBoundedObjectionList(
      `n=${MAX_BOUNDED_OBJECTIONS + 1}; 1. x.`,
    );
    expect(tooMany.ok).toBe(false);
  });
});

describe('runReviewRound — objection monotonicity (R6, R3.13)', () => {
  let runDir: string;
  let cbPath: string;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  /** Scripted transport: each seat responds only once genuinely spawned (deadlock on out-of-order). */
  class ScriptedSeatTransport extends FakeTransport {
    public readonly events: string[] = [];
    constructor(private readonly onSpawn: (batchId: string) => Promise<void>) {
      super();
    }
    async spawn(params: Parameters<FakeTransport['spawn']>[0]): Promise<{ handle: string; role: string }> {
      const spawned = await super.spawn(params);
      this.events.push(`spawn:${params.batchId}`);
      await this.onSpawn(params.batchId ?? '');
      return spawned;
    }
    async reap(handle: string, reason = 'complete'): Promise<void> {
      this.events.push(`reap:${reason}`);
      return super.reap(handle, reason);
    }
  }

  const DRAFT_A = '# Draft A — plan one\n```json\n[]\n```\n';
  const DRAFT_B = '# Draft B — a materially different plan\n```json\n[]\n```\n';
  const CANDIDATE_R2 = '# Reconciled candidate — round 2\n```json\n[]\n```\n';
  const CANDIDATE_R3 = '# Reconciled candidate — round 3\n```json\n[]\n```\n';
  const CANDIDATE_R4 = '# Reconciled candidate — round 4\n```json\n[]\n```\n';

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r6-obj-mono-'));
    cbPath = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cbPath, '', 'utf8');
    briefWriter = new BriefWriterService();
    briefs = new Map();
    partnerHandles = [];
    partnerRuntimeIds = [];
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  async function post(line: string): Promise<void> {
    await fs.appendFile(cbPath, `${line}\n`, 'utf8');
  }

  function baseOptions(
    transport: FakeTransport,
    overrides: Partial<RunReviewRoundOptions> = {},
  ): RunReviewRoundOptions {
    return {
      transport,
      briefWriter,
      writeBrief: async (role, content) => {
        briefs.set(role, content);
      },
      registerWorkerRuntime: () => partnerRuntimeIds.length + 1,
      waitForAgreement: async () => {
        throw new Error('legacy waitForAgreement must never be called');
      },
      runDir,
      batchId: 'batch-R6M',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath,
      planMdPath: path.join(runDir, 'plan.md'),
      perRoundTimeoutMs: 1500,
      roundCap: 5,
      agreementFenceOffset: 0,
      isFake: true,
      blindDraftRound1: true,
      coPlannerSeats: [
        { slot: 0, provider: 'anthropic', model: 'claude-sonnet' },
        { slot: 1, provider: 'grok', model: 'grok-4.5' },
      ],
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  /** @returns true when this batchId was a round-1 draft seat and was handled. */
  async function publishRound1Drafts(batchId: string): Promise<boolean> {
    if (batchId === 'batch-R6M-partner') {
      atomicWriteFile(draftPlanPath(runDir, 'partner'), DRAFT_A);
      await post(`[helm callback] planner ${batchId} STATUS: DRAFT-SUBMITTED plan=ffffffffffff`);
      return true;
    }
    if (batchId === 'batch-R6M-partner-2') {
      atomicWriteFile(draftPlanPath(runDir, 'partner-2'), DRAFT_B);
      await post(`[helm callback] planner ${batchId} STATUS: DRAFT-SUBMITTED plan=ffffffffffff`);
      return true;
    }
    return false;
  }

  it('blocks early with objection-not-monotone when round N+1 defect count is not strictly smaller', async () => {
    const transport = new ScriptedSeatTransport(async (batchId: string) => {
      if (await publishRound1Drafts(batchId)) return;
      if (batchId === 'batch-R6M-r2-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R2);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R6M-r2-signer') {
        await post(
          `[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=2; 1. Missing req_refs. 2. Bad effort.`,
        );
        return;
      }
      if (batchId === 'batch-R6M-r3-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R3);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R6M-r3-signer') {
        // Same count as round 2 (n=2) — NOT strictly smaller → early block.
        await post(
          `[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=2; 1. Still missing req_refs. 2. Still bad effort.`,
        );
        return;
      }
      if (batchId.startsWith('batch-R6M-r4-') || batchId.startsWith('batch-R6M-r5-')) {
        throw new Error(`must not spawn ${batchId} after non-monotone objections`);
      }
      throw new Error(`unexpected spawn ${batchId}`);
    });

    const result = await runReviewRound(baseOptions(transport));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('objection-not-monotone');
    expect(result.blockedReason).toMatch(/OBJECTION-NOT-MONOTONE/);
    expect(result.blockedReason).toMatch(/not strictly smaller/i);
    // Detected on round 3 (second objections round); remaining cap unspent.
    expect(result.roundsAttempted).toBe(3);
    expect(result.blockedReason).toMatch(/2 remaining round-cap slot/);
  });

  it('does not spawn further proposer/signer rounds after a non-monotone objections outcome', async () => {
    const transport = new ScriptedSeatTransport(async (batchId: string) => {
      if (await publishRound1Drafts(batchId)) return;
      if (batchId === 'batch-R6M-r2-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R2);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R6M-r2-signer') {
        await post(
          `[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=3; 1. A. 2. B. 3. C.`,
        );
        return;
      }
      if (batchId === 'batch-R6M-r3-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R3);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R6M-r3-signer') {
        // Count increased (worse) — block; no r4/r5.
        await post(
          `[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=4; 1. A. 2. B. 3. C. 4. D.`,
        );
        return;
      }
      if (batchId.startsWith('batch-R6M-r4-') || batchId.startsWith('batch-R6M-r5-')) {
        throw new Error(`cap-burn bug: spawned ${batchId} after monotone fail`);
      }
    });

    const result = await runReviewRound(baseOptions(transport, { roundCap: 5 }));

    expect(result.blockedReasonKind).toBe('objection-not-monotone');
    expect(result.roundsAttempted).toBe(3);
    // Two draft seats + r2 proposer/signer + r3 proposer/signer only — never r4+.
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual([
      'batch-R6M-partner',
      'batch-R6M-partner-2',
      'batch-R6M-r2-proposer',
      'batch-R6M-r2-signer',
      'batch-R6M-r3-proposer',
      'batch-R6M-r3-signer',
    ]);
  });

  it('allows a strictly shrinking defect count to continue (and eventually agree)', async () => {
    const transport = new ScriptedSeatTransport(async (batchId: string) => {
      if (await publishRound1Drafts(batchId)) return;
      if (batchId === 'batch-R6M-r2-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R2);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R6M-r2-signer') {
        await post(
          `[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=2; 1. Defect one. 2. Defect two.`,
        );
        return;
      }
      if (batchId === 'batch-R6M-r3-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R3);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R6M-r3-signer') {
        // Strictly smaller (2 → 1) — continue.
        await post(
          `[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=1; 1. Only remaining defect.`,
        );
        return;
      }
      if (batchId === 'batch-R6M-r4-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R4);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R6M-r4-signer') {
        const onDisk = await fs.readFile(candidatePlanPath(runDir), 'utf8');
        await post(
          `[helm callback] planner ${batchId} STATUS: SIGNED plan=${planRevision(onDisk).short12}`,
        );
        return;
      }
      throw new Error(`unexpected spawn ${batchId}`);
    });

    const result = await runReviewRound(baseOptions(transport, { roundCap: 4 }));

    expect(result.agreed).toBe(true);
    expect(result.blockedReasonKind).toBeUndefined();
    expect(result.roundsAttempted).toBe(4);
    expect(result.proposerSignerRound!.signerDecision).toBe('signed-agreed');
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual([
      'batch-R6M-partner',
      'batch-R6M-partner-2',
      'batch-R6M-r2-proposer',
      'batch-R6M-r2-signer',
      'batch-R6M-r3-proposer',
      'batch-R6M-r3-signer',
      'batch-R6M-r4-proposer',
      'batch-R6M-r4-signer',
    ]);
  });

  it('blocks early when a later objections note is unparseable (never treated as zero)', async () => {
    const transport = new ScriptedSeatTransport(async (batchId: string) => {
      if (await publishRound1Drafts(batchId)) return;
      if (batchId === 'batch-R6M-r2-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R2);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R6M-r2-signer') {
        await post(
          `[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=1; 1. Real defect.`,
        );
        return;
      }
      if (batchId === 'batch-R6M-r3-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R3);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R6M-r3-signer') {
        // Malformed: no n= header — must not count as 0 and must not look like shrink.
        await post(`[helm callback] planner ${batchId} STATUS: OBJECTIONS — vague freeform gripe`);
        return;
      }
      if (batchId.startsWith('batch-R6M-r4-')) {
        throw new Error(`must not burn cap after unparseable objections: ${batchId}`);
      }
    });

    const result = await runReviewRound(baseOptions(transport, { roundCap: 5 }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('objection-not-monotone');
    expect(result.roundsAttempted).toBe(3);
    expect(result.blockedReason).toMatch(/unparseable/);
  });
});

/**
 * R6.24 — register sweep mode `objection-monotonicity`, not merely prove the behavior.
 */
describe('R6.24 sweep-mode registration — objection-monotonicity (R6)', () => {
  const REPO_ROOT = process.cwd();

  it('registers objection-monotonicity as an active mode owned by R6 covering R3.13/R6.24', () => {
    const entry = getRegressionMode('objection-monotonicity');
    expect(entry).toBeDefined();
    expect(entry!.slice).toBe('R6');
    expect(entry!.state).toBe('active');
    expect(entry!.requirements).toEqual(expect.arrayContaining(['R3.13', 'R6.24']));
    expect(entry!.note.trim().length).toBeGreaterThan(0);
    expect(listRegressionModes().map((e) => e.mode)).toContain('objection-monotonicity');
  });

  it('resolves to THIS spec on disk with every proving test present and no disarming marker', () => {
    const entry = getRegressionMode('objection-monotonicity')!;
    expect(entry.spec).toBe('src/services/planning-review-round-objection-mono.test.ts');

    const resolution = resolveRegressionMode('objection-monotonicity', REPO_ROOT);
    expect(resolution.exists).toBe(true);
    expect(resolution.specPath).toBe(path.resolve(REPO_ROOT, entry.spec));
    expect(resolution.markers).toEqual([]);
    expect(resolution.missingProvingTests).toEqual([]);
    expect(entry.provingTests.length).toBeGreaterThanOrEqual(4);
  });

  it('refuses a duplicate registration of objection-monotonicity', () => {
    expect(() =>
      registerRegressionMode({
        mode: 'objection-monotonicity',
        slice: 'R6',
        requirements: ['R6.24'],
        spec: 'src/services/planning-review-round-objection-mono.test.ts',
        provingTests: ['x'],
        state: 'active',
        note: 'duplicate',
      }),
    ).toThrow(RegressionModeRegistrationError);
  });
});
