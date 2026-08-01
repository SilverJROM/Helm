process.env.USE_FAKE_TMUX = '1';

/**
 * R3 gate — divergence resolves via asymmetric proposer/signer, not dual reconciliation
 * (R3.9, R3.10, R3.11).
 *
 * Scope: `runProposerSignerRound` (planning-review-round.ts), the round-2 continuation of R2's
 * blind round-1 drafts. Consumes two `PublishedDraft`s (as R2's resolveRoundOneDraftPhase produces)
 * and resolves exactly one round-2 outcome.
 *
 * Proves:
 * - on hash mismatch, the round-2 proposer is D3's designateRound2Proposer output (full sha256, not
 *   short12) and the rule + both full shas are logged via formatProposerLog — R3.9;
 * - the proposer (fresh spawn) receives BOTH round-1 draft paths and authors the candidate; the
 *   signer (a separate fresh spawn) receives ONLY the candidate path — never a second competing
 *   draft, never both seats asked to each author a new full draft — R3.10;
 * - agreement is the signer's claimed `plan=<sha12>` matching the candidate's CURRENT on-disk
 *   short12, engine-recomputed at check time; a mismatched, missing, or malformed claim is never
 *   agreement (fail-closed) — R3.11;
 * - a signer's bounded OBJECTIONS list is captured, never treated as agreement;
 * - on hash match, no proposer is spawned and no model reconcile call is made — the engine copies
 *   the already-identical bytes straight to the candidate path — but a real signature round still
 *   runs (the preferred uniform promotion path over an auto-agree shortcut);
 * - a proposer that never commits a candidate is a bounded, typed block and the signer is never
 *   spawned; a signer that never responds is a bounded, typed block.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import {
  runProposerSignerRound,
  RunProposerSignerRoundOptions,
} from './planning-review-round.js';
import {
  draftPlanPath,
  draftReqPath,
  candidatePlanPath,
  candidateReqPath,
  atomicWriteFile,
  publishDraft,
  type PublishedDraft,
} from './seat-draft-store.js';
import { planRevision } from './plan-revision.js';
import { designateRound2Proposer, formatProposerLog, PROPOSER_DESIGNATE_RULE } from './proposer-role.js';

describe('runProposerSignerRound — asymmetric proposer/signer divergence (R3, R3.9-R3.11)', () => {
  let runDir: string;
  let cbPath: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r3-proposer-signer-'));
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

  function seedDraft(seatId: string, bytes: string, reqBytes?: string): PublishedDraft {
    atomicWriteFile(draftPlanPath(runDir, seatId), bytes);
    if (reqBytes !== undefined) atomicWriteFile(draftReqPath(runDir, seatId), reqBytes);
    return publishDraft(runDir, seatId);
  }

  function baseOptions(overrides: Partial<RunProposerSignerRoundOptions> = {}): RunProposerSignerRoundOptions {
    const draftA = overrides.draftA ?? seedDraft('partner', '# Draft A\n```json\n[]\n```\n');
    const draftB = overrides.draftB ?? seedDraft('partner-2', '# Draft B\n```json\n[]\n```\n');
    return {
      transport,
      briefWriter,
      writeBrief: async (role, content) => { briefs.set(role, content); },
      registerWorkerRuntime: () => partnerRuntimeIds.length + 1,
      runDir,
      batchId: 'batch-R3',
      round: 2,
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath,
      draftA,
      draftB,
      perRoundTimeoutMs: 500,
      agreementFenceOffset: 0,
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  describe('hash mismatch — proposer reconciles, signer signs (R3.9/R3.10)', () => {
    it('designates the proposer via D3 (full sha256), logs the rule, and agrees on a matching SIGNED claim', async () => {
      const draftA = seedDraft('partner', '# Draft A — plan one\n```json\n[]\n```\n');
      const draftB = seedDraft('partner-2', '# Draft B — a very different plan\n```json\n[]\n```\n');
      expect(draftA.plan!.sha256).not.toBe(draftB.plan!.sha256);

      const expectedProposer = designateRound2Proposer({
        seatA: draftA.seatId, shaA: draftA.plan!.sha256,
        seatB: draftB.seatId, shaB: draftB.plan!.sha256,
      });
      const expectedLog = formatProposerLog({
        seatA: draftA.seatId, shaA: draftA.plan!.sha256,
        seatB: draftB.seatId, shaB: draftB.plan!.sha256,
        proposer: expectedProposer,
      });

      const candidateBytes = '# Reconciled candidate\n```json\n[]\n```\n';
      const candidateRevision = planRevision(candidateBytes);
      atomicWriteFile(candidatePlanPath(runDir), candidateBytes);
      await fs.appendFile(
        cbPath,
        `[helm callback] planner batch-R3-r2-proposer STATUS: CANDIDATE-SUBMITTED plan=${candidateRevision.short12}\n` +
        `[helm callback] planner batch-R3-r2-signer STATUS: SIGNED plan=${candidateRevision.short12}\n`,
        'utf8'
      );

      const result = await runProposerSignerRound(baseOptions({ draftA, draftB }));

      // R3.9: deterministic designation + auditable rule log, reproducible from artifacts alone.
      expect(result.designatedSeatId).toBe(expectedProposer);
      expect(result.designationLog).toBe(expectedLog);
      expect(result.designationLog).toContain(`rule=${PROPOSER_DESIGNATE_RULE}`);
      expect(result.designationLog).toContain(draftA.plan!.sha256); // full 64-char sha, not short12
      expect(result.hashMatch).toBe(false);
      expect(result.reconcileSpawned).toBe(true);

      // R3.11: signer's claim matched the candidate's current on-disk bytes -> agreed.
      expect(result.agreed).toBe(true);
      expect(result.signerDecision).toBe('signed-agreed');
      expect(result.candidatePlan?.short12).toBe(candidateRevision.short12);

      // Exactly two fresh spawns: proposer then signer, never a third/dual-author path.
      expect(transport.spawnCalls).toHaveLength(2);
      expect(transport.spawnCalls.map((c) => c.batchId)).toEqual([
        'batch-R3-r2-proposer',
        'batch-R3-r2-signer',
      ]);
      expect(new Set(partnerHandles).size).toBe(2);
    });

    it('R3.10: the proposer brief carries BOTH round-1 draft paths; the signer brief carries ONLY the candidate', async () => {
      const draftA = seedDraft('partner', '# Draft A\n```json\n[]\n```\n');
      const draftB = seedDraft('partner-2', '# Draft B — different\n```json\n[]\n```\n');
      const candidateBytes = '# candidate\n```json\n[]\n```\n';
      const candidateRevision = planRevision(candidateBytes);
      atomicWriteFile(candidatePlanPath(runDir), candidateBytes);
      const expectedProposer = designateRound2Proposer({
        seatA: draftA.seatId, shaA: draftA.plan!.sha256, seatB: draftB.seatId, shaB: draftB.plan!.sha256,
      });
      await fs.appendFile(
        cbPath,
        `[helm callback] planner batch-R3-r2-proposer STATUS: CANDIDATE-SUBMITTED plan=${candidateRevision.short12}\n` +
        `[helm callback] planner batch-R3-r2-signer STATUS: SIGNED plan=${candidateRevision.short12}\n`,
        'utf8'
      );

      await runProposerSignerRound(baseOptions({ draftA, draftB }));

      const proposerBrief = briefs.get('planner-r2-proposer')!;
      const signerBrief = briefs.get('planner-r2-signer')!;

      expect(proposerBrief).toMatch(/Panel purpose: plan-reconcile/);
      expect(proposerBrief).toContain(draftA.planPath);
      expect(proposerBrief).toContain(draftB.planPath);
      expect(proposerBrief).toMatch(/exactly ONE/i);

      expect(signerBrief).toMatch(/Panel purpose: plan-signature/);
      expect(signerBrief).not.toContain(draftA.planPath);
      expect(signerBrief).not.toContain(draftB.planPath);
      expect(signerBrief).not.toMatch(/round-1 draft/i);
      expect(signerBrief).toContain(candidatePlanPath(runDir));

      // The proposer that was actually spawned is the designated seat; the signer is the other one.
      const proposerSpawnBrief = transport.spawnCalls.find((c) => c.batchId === 'batch-R3-r2-proposer')!.brief;
      expect(proposerSpawnBrief).toContain(`seat ${expectedProposer}`);
    });

    it('R3.11: a mismatched (stale) SIGNED claim is never treated as agreement', async () => {
      const draftA = seedDraft('partner', '# Draft A\n```json\n[]\n```\n');
      const draftB = seedDraft('partner-2', '# Draft B — different\n```json\n[]\n```\n');
      const candidateBytes = '# candidate\n```json\n[]\n```\n';
      atomicWriteFile(candidatePlanPath(runDir), candidateBytes);
      const wrongShort12 = '0'.repeat(12);
      await fs.appendFile(
        cbPath,
        `[helm callback] planner batch-R3-r2-proposer STATUS: CANDIDATE-SUBMITTED plan=whatever\n` +
        `[helm callback] planner batch-R3-r2-signer STATUS: SIGNED plan=${wrongShort12}\n`,
        'utf8'
      );

      const result = await runProposerSignerRound(baseOptions({ draftA, draftB }));

      expect(result.agreed).toBe(false);
      expect(result.signerDecision).toBe('signed-mismatched');
    });

    it('captures a bounded OBJECTIONS list, never treating it as agreement', async () => {
      const draftA = seedDraft('partner', '# Draft A\n```json\n[]\n```\n');
      const draftB = seedDraft('partner-2', '# Draft B — different\n```json\n[]\n```\n');
      const candidateBytes = '# candidate\n```json\n[]\n```\n';
      atomicWriteFile(candidatePlanPath(runDir), candidateBytes);
      const objectionsNote = 'n=2; 1. Task B12-T02 has no req_refs. 2. Effort "L" is not a valid enum value.';
      await fs.appendFile(
        cbPath,
        `[helm callback] planner batch-R3-r2-proposer STATUS: CANDIDATE-SUBMITTED plan=whatever\n` +
        `[helm callback] planner batch-R3-r2-signer STATUS: OBJECTIONS — ${objectionsNote}\n`,
        'utf8'
      );

      const result = await runProposerSignerRound(baseOptions({ draftA, draftB }));

      expect(result.agreed).toBe(false);
      expect(result.signerDecision).toBe('objections');
      expect(result.objections).toContain('n=2');
      expect(result.objections).toContain('req_refs');
    });

    it('typed-blocks when the proposer never commits a candidate — the signer is never spawned', async () => {
      const draftA = seedDraft('partner', '# Draft A\n```json\n[]\n```\n');
      const draftB = seedDraft('partner-2', '# Draft B — different\n```json\n[]\n```\n');
      // No CANDIDATE-SUBMITTED line, no candidate file — proposer stays silent.

      const result = await runProposerSignerRound(baseOptions({ draftA, draftB, perRoundTimeoutMs: 400 }));

      expect(result.agreed).toBe(false);
      expect(result.blockedReasonKind).toBe('candidate-not-committed');
      expect(result.blockedReason).toMatch(/CANDIDATE-NOT-COMMITTED/);
      expect(result.reconcileSpawned).toBe(true);
      expect(result.signerBatchId).toBeNull();
      // Only the proposer was ever spawned.
      expect(transport.spawnCalls).toHaveLength(1);
      expect(transport.spawnCalls[0].batchId).toBe('batch-R3-r2-proposer');
    });

    it('typed-blocks when the signer never responds after a genuine candidate commit', async () => {
      const draftA = seedDraft('partner', '# Draft A\n```json\n[]\n```\n');
      const draftB = seedDraft('partner-2', '# Draft B — different\n```json\n[]\n```\n');
      const candidateBytes = '# candidate\n```json\n[]\n```\n';
      const candidateRevision = planRevision(candidateBytes);
      atomicWriteFile(candidatePlanPath(runDir), candidateBytes);
      await fs.appendFile(
        cbPath,
        `[helm callback] planner batch-R3-r2-proposer STATUS: CANDIDATE-SUBMITTED plan=${candidateRevision.short12}\n`,
        'utf8'
      );
      // No SIGNED / OBJECTIONS line for the signer — it stays silent.

      const result = await runProposerSignerRound(baseOptions({ draftA, draftB, perRoundTimeoutMs: 400 }));

      expect(result.agreed).toBe(false);
      expect(result.blockedReasonKind).toBe('signer-no-response');
      expect(result.blockedReason).toMatch(/SIGNER-NO-RESPONSE/);
      // Both proposer and signer were spawned; only the signer's decision timed out.
      expect(transport.spawnCalls).toHaveLength(2);
    });
  });

  describe('hash match — no model reconcile call, signature round still required (R3.11)', () => {
    it('copies the already-identical bytes straight to the candidate path without spawning a proposer', async () => {
      const identicalBytes = '# Identical plan\n```json\n[]\n```\n';
      const draftA = seedDraft('partner', identicalBytes);
      const draftB = seedDraft('partner-2', identicalBytes);
      expect(draftA.plan!.sha256).toBe(draftB.plan!.sha256);

      const expectedProposer = designateRound2Proposer({
        seatA: draftA.seatId, shaA: draftA.plan!.sha256, seatB: draftB.seatId, shaB: draftB.plan!.sha256,
      });
      const candidateRevision = planRevision(identicalBytes);
      await fs.appendFile(
        cbPath,
        `[helm callback] planner batch-R3-r2-signer STATUS: SIGNED plan=${candidateRevision.short12}\n`,
        'utf8'
      );

      const result = await runProposerSignerRound(baseOptions({ draftA, draftB }));

      expect(result.hashMatch).toBe(true);
      expect(result.reconcileSpawned).toBe(false);
      expect(result.proposerBatchId).toBeNull();
      expect(result.designatedSeatId).toBe(expectedProposer);

      // No model reconcile call — exactly ONE spawn: the signer.
      expect(transport.spawnCalls).toHaveLength(1);
      expect(transport.spawnCalls[0].batchId).toBe('batch-R3-r2-signer');

      // The candidate on disk is byte-identical to the (already matching) round-1 drafts.
      const candidateOnDisk = await fs.readFile(candidatePlanPath(runDir), 'utf8');
      expect(candidateOnDisk).toBe(identicalBytes);
      expect(result.candidatePlan?.short12).toBe(candidateRevision.short12);

      // A real signature round still ran and produced genuine agreement.
      expect(result.agreed).toBe(true);
      expect(result.signerDecision).toBe('signed-agreed');
    });

    it('also copies the requirements draft when present', async () => {
      const identicalBytes = '# Identical plan\n```json\n[]\n```\n';
      const identicalReq = '# Identical requirements\n';
      const draftA = seedDraft('partner', identicalBytes, identicalReq);
      const draftB = seedDraft('partner-2', identicalBytes, identicalReq);

      await fs.appendFile(
        cbPath,
        `[helm callback] planner batch-R3-r2-signer STATUS: SIGNED plan=${planRevision(identicalBytes).short12}\n`,
        'utf8'
      );

      await runProposerSignerRound(baseOptions({ draftA, draftB }));

      const candidateReqOnDisk = await fs.readFile(candidateReqPath(runDir), 'utf8');
      expect(candidateReqOnDisk).toBe(identicalReq);
    });
  });

  it('throws if called before both round-1 drafts actually committed a plan revision', async () => {
    const draftA: PublishedDraft = {
      seatId: 'partner', planPath: draftPlanPath(runDir, 'partner'), reqPath: draftReqPath(runDir, 'partner'),
      plan: null, req: null,
    };
    const draftB = seedDraft('partner-2', '# Draft B\n```json\n[]\n```\n');

    await expect(runProposerSignerRound(baseOptions({ draftA, draftB }))).rejects.toThrow(/committed plan revision/);
    expect(transport.spawnCalls).toHaveLength(0);
  });
});
