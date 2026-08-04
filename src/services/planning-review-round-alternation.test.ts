process.env.USE_FAKE_TMUX = '1';

/**
 * R4 gate — round 3+ alternates the proposer/signer pen (R3.12).
 *
 * Scope: the round loop inside `runReviewRound` (planning-review-round.ts) now wires
 * `rolesForRound` (D3, proposer-role.ts) into its own iteration instead of returning right after
 * R3's single round-2 `runProposerSignerRound` call. Drives the real production entry point end to
 * end — nothing about the resolver mocked or short-circuited — through THREE proposer/signer
 * rounds off the SAME pair of round-1 blind drafts:
 *
 * - round 2: D3 designates naturally (lower full sha256 of the two round-1 drafts);
 * - round 3: the signer is forced to OBJECT (never signs) — the pen must swap to the OTHER seat;
 * - round 4: the signer objects again in round 3, so round 4 must swap BACK to round 2's proposer.
 *
 * Proves the mandatory R4 contract: round-2 proposer == designate(round1); round-3 proposer == the
 * other seat; round-4 proposer == round-2's proposer again — never one seat holding the pen every
 * round. Also proves `runProposerSignerRound`'s own `rolesOverride` parameter (unit-level, no round
 * loop) alternates the fresh-spawned seat identity directly.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { runReviewRound, runProposerSignerRound, RunReviewRoundOptions } from './planning-review-round.js';
import {
  draftPlanPath,
  candidatePlanPath,
  atomicWriteFile,
  publishDraft,
  type PublishedDraft,
} from './seat-draft-store.js';
import { planRevision } from './plan-revision.js';
import { designateRound2Proposer, rolesForRound } from './proposer-role.js';

/** 'partner' must not match inside 'partner-2' — this suite only ever uses these two seat ids. */
function seatMarker(seatId: string): RegExp {
  return seatId === 'partner' ? /seat partner(?!-)/ : new RegExp(`seat ${seatId}\\b`);
}

describe('runReviewRound — round 3+ alternates the proposer/signer pen (R4, R3.12)', () => {
  let runDir: string;
  let cbPath: string;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  /** Records engine actions in order, and lets each seat respond only once it is genuinely spawned
   *  (mirrors the R3 reachability suite's ScriptedSeatTransport — a round that never happened
   *  produces no artifact, and an out-of-order engine would deadlock rather than pass). */
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
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r4-alternation-'));
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
    overrides: Partial<RunReviewRoundOptions> = {}
  ): RunReviewRoundOptions {
    return {
      transport,
      briefWriter,
      writeBrief: async (role, content) => { briefs.set(role, content); },
      registerWorkerRuntime: () => partnerRuntimeIds.length + 1,
      waitForAgreement: async () => { throw new Error('legacy waitForAgreement must never be called'); },
      runDir,
      batchId: 'batch-R4A',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath,
      planMdPath: path.join(runDir, 'plan.md'),
      perRoundTimeoutMs: 1500,
      roundCap: 4,
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

  it('round-2 proposer = designate(round1); round-3 proposer = the other seat; round-4 = round-2s proposer again', async () => {
    const transport = new ScriptedSeatTransport(async (batchId: string) => {
      if (batchId === 'batch-R4A-partner') {
        atomicWriteFile(draftPlanPath(runDir, 'partner'), DRAFT_A);
        await post(`[helm callback] planner ${batchId} STATUS: DRAFT-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R4A-partner-2') {
        atomicWriteFile(draftPlanPath(runDir, 'partner-2'), DRAFT_B);
        await post(`[helm callback] planner ${batchId} STATUS: DRAFT-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R4A-r2-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R2);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R4A-r2-signer') {
        // Forced non-signature (round 2): the signer objects, never signs — the pen must move.
        // R6 (R3.13): defect count must strictly shrink on the next objections round, so n=2 here.
        await post(`[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=2; 1. round-2 defect A. 2. round-2 defect B.`);
        return;
      }
      if (batchId === 'batch-R4A-r3-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R3);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R4A-r3-signer') {
        // Forced non-signature (round 3) too — round 4 must swap back to round 2's proposer.
        // R6: n=1 < prior n=2 so monotonicity allows the loop to continue to round 4.
        await post(`[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=1; 1. round-3 candidate rejected for this test.`);
        return;
      }
      if (batchId === 'batch-R4A-r4-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R4);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R4A-r4-signer') {
        const onDisk = await fs.readFile(candidatePlanPath(runDir), 'utf8');
        await post(`[helm callback] planner ${batchId} STATUS: SIGNED plan=${planRevision(onDisk).short12}`);
        return;
      }
      throw new Error(`unexpected spawn ${batchId}`);
    });

    const result = await runReviewRound(baseOptions(transport));

    // Engine ran every round in order — two blind drafters, then three FULL proposer+signer rounds.
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual([
      'batch-R4A-partner',
      'batch-R4A-partner-2',
      'batch-R4A-r2-proposer',
      'batch-R4A-r2-signer',
      'batch-R4A-r3-proposer',
      'batch-R4A-r3-signer',
      'batch-R4A-r4-proposer',
      'batch-R4A-r4-signer',
    ]);
    expect(result.agreed).toBe(true);
    expect(result.roundsAttempted).toBe(4);

    const round2Proposer = designateRound2Proposer({
      seatA: 'partner', shaA: planRevision(DRAFT_A).sha256,
      seatB: 'partner-2', shaB: planRevision(DRAFT_B).sha256,
    });
    const otherSeat = round2Proposer === 'partner' ? 'partner-2' : 'partner';

    // Mandatory (R3.12): round 2 = designated; round 3 SWAPS to the other seat; round 4 swaps BACK.
    // A one-seat-holds-the-pen-every-round bug would make round-3's proposer brief equal round-2's.
    expect(briefs.get('planner-r2-proposer')).toMatch(seatMarker(round2Proposer));
    expect(briefs.get('planner-r3-proposer')).toMatch(seatMarker(otherSeat));
    expect(briefs.get('planner-r4-proposer')).toMatch(seatMarker(round2Proposer));
    // The signer is always the round's OTHER seat, alternating in lock-step with the proposer.
    expect(briefs.get('planner-r2-signer')).toMatch(seatMarker(otherSeat));
    expect(briefs.get('planner-r3-signer')).toMatch(seatMarker(round2Proposer));
    expect(briefs.get('planner-r4-signer')).toMatch(seatMarker(otherSeat));

    // The final typed result's own per-round field agrees with what was actually spawned.
    expect(result.proposerSignerRound!.roundProposerSeatId).toBe(round2Proposer);
    // The base D3 audit anchor never drifts — it always names round 2's own designation.
    expect(result.proposerSignerRound!.designatedSeatId).toBe(round2Proposer);
    expect(result.proposerSignerRound!.signerDecision).toBe('signed-agreed');
  });

  it('registers sweep mode proposer-signer-alternation (R6.24)', async () => {
    const { getRegressionMode } = await import('./planning-regression-modes.js');
    const entry = getRegressionMode('proposer-signer-alternation');
    expect(entry).toBeDefined();
    expect(entry!.slice).toBe('R4');
    expect(entry!.requirements).toContain('R3.12');
  });
});

/**
 * `runProposerSignerRound`'s own `rolesOverride` parameter, unit-level — proves the alternation
 * primitive independent of the round loop that wires it in above.
 */
describe('runProposerSignerRound — rolesOverride alternates the fresh-spawned seat identity (R4)', () => {
  let runDir: string;
  let cbPath: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r4-roles-override-'));
    cbPath = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cbPath, '', 'utf8');
    transport = new FakeTransport();
    briefWriter = new BriefWriterService();
    briefs = new Map();
    partnerHandles = [];
    partnerRuntimeIds = [];
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  function seedDraft(seatId: string, bytes: string): PublishedDraft {
    atomicWriteFile(draftPlanPath(runDir, seatId), bytes);
    return publishDraft(runDir, seatId);
  }

  it('spawns the rolesOverride.proposer as proposer even though D3 would naturally designate the other seat', async () => {
    const draftA = seedDraft('partner', '# Draft A\n```json\n[]\n```\n');
    const draftB = seedDraft('partner-2', '# Draft B — different\n```json\n[]\n```\n');
    const naturalProposer = designateRound2Proposer({
      seatA: draftA.seatId, shaA: draftA.plan!.sha256, seatB: draftB.seatId, shaB: draftB.plan!.sha256,
    });
    const roles = rolesForRound(3, naturalProposer, draftA.seatId, draftB.seatId);
    expect(roles.proposer).not.toBe(naturalProposer); // sanity: round 3 swaps by construction

    // Seed the candidate the proposer will "author" so the signer's SIGNED claim below resolves to a
    // real revision — this is a unit-level drive of runProposerSignerRound (no ScriptedSeatTransport),
    // so callbacks.md is pre-seeded with both decisions FakeTransport's real spawn/reap can settle on.
    atomicWriteFile(candidatePlanPath(runDir), '# Candidate\n```json\n[]\n```\n');
    const candidateRevision = planRevision('# Candidate\n```json\n[]\n```\n');
    await fs.writeFile(
      cbPath,
      `[helm callback] planner batch-R4U-r3-proposer STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff\n` +
        `[helm callback] planner batch-R4U-r3-signer STATUS: SIGNED plan=${candidateRevision.short12}\n`,
      'utf8'
    );

    const result = await runProposerSignerRound({
      transport,
      briefWriter,
      writeBrief: async (role, content) => { briefs.set(role, content); },
      registerWorkerRuntime: () => partnerRuntimeIds.length + 1,
      runDir,
      batchId: 'batch-R4U',
      round: 3,
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath,
      draftA,
      draftB,
      rolesOverride: roles,
      perRoundTimeoutMs: 500,
      agreementFenceOffset: 0,
      partnerHandles,
      partnerRuntimeIds,
    });

    expect(result.roundProposerSeatId).toBe(roles.proposer);
    expect(result.signerSeatId).toBe(roles.signer);
    // The base D3 audit anchor is untouched by the override — it still names the ROUND-2 designation.
    expect(result.designatedSeatId).toBe(naturalProposer);
    expect(briefs.get('planner-r3-proposer')).toMatch(seatMarker(roles.proposer));
    expect(briefs.get('planner-r3-signer')).toMatch(seatMarker(roles.signer));
  });
});
