process.env.USE_FAKE_TMUX = '1';

/**
 * R7 gate — non-convergence = visible BLOCKED + operator-legible final-positions diff (R3.15).
 *
 * Scope: on cap exhaustion / monotone fail of the proposer/signer exchange, `blockedReason`
 * carries a textual/hunk summary of final candidate vs signer's last draft (+ remaining
 * objections) — never bare hash pairs alone. A durable report is written under
 * `planning-drafts/non-convergence-diff.txt`. Pure helpers (`unifiedLineDiff`,
 * `buildAndPersistNonConvergenceDiff`) are unit-tested too.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import {
  runReviewRound,
  unifiedLineDiff,
  buildAndPersistNonConvergenceDiff,
  nonConvergenceDiffPath,
  type RunReviewRoundOptions,
} from './planning-review-round.js';
import {
  draftPlanPath,
  candidatePlanPath,
  atomicWriteFile,
} from './seat-draft-store.js';
import { planRevision } from './plan-revision.js';

describe('unifiedLineDiff (R7 / R3.15 pure helper)', () => {
  it('renders a textual hunk summary with removed/added lines — never a bare hash pair', () => {
    const a = '# Plan A\nline one\nline shared\nline only A\n';
    const b = '# Plan B\nline one\nline shared\nline only B\n';
    const diff = unifiedLineDiff('final-candidate', a, 'signer-last-draft', b);

    expect(diff).toMatch(/^--- final-candidate/m);
    expect(diff).toMatch(/^\+\+\+ signer-last-draft/m);
    expect(diff).toMatch(/^-# Plan A/m);
    expect(diff).toMatch(/^\+# Plan B/m);
    expect(diff).toMatch(/^-line only A/m);
    expect(diff).toMatch(/^\+line only B/m);
    // Must not be "just two hex strings".
    expect(diff).not.toMatch(/^[0-9a-f]{12}\s+[0-9a-f]{12}$/);
    expect(diff).toMatch(/removed \d+, added \d+/);
  });

  it('reports identical positions without inventing a false delta', () => {
    const text = '# Same\nbody\n';
    const diff = unifiedLineDiff('left', text, 'right', text);
    expect(diff).toMatch(/identical/);
    expect(diff).not.toMatch(/^-# Same/m);
  });
});

describe('buildAndPersistNonConvergenceDiff (R7 / R3.15)', () => {
  let runDir: string;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r7-diff-'));
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('writes a durable report and a blockedReason-ready summary that includes content, not just sha12', () => {
    const candidate = path.join(runDir, 'candidate-plan.md');
    const draft = path.join(runDir, 'draft-partner.md');
    fsSync.writeFileSync(candidate, '# Candidate\nshared\ncandidate-only\n');
    fsSync.writeFileSync(draft, '# Signer draft\nshared\ndraft-only\n');
    const candRev = planRevision(fsSync.readFileSync(candidate));
    const draftRev = planRevision(fsSync.readFileSync(draft));

    const built = buildAndPersistNonConvergenceDiff({
      runDir,
      cause: 'signer-objections',
      candidatePath: candidate,
      candidateShort12: candRev.short12,
      otherLabel: 'signer-last-draft seat=partner',
      otherPath: draft,
      otherShort12: draftRev.short12,
      objectionsNote: 'n=2; 1. Missing req_refs. 2. Bad effort.',
    });

    expect(built.path).toBe(nonConvergenceDiffPath(runDir));
    expect(fsSync.existsSync(built.path)).toBe(true);
    const onDisk = fsSync.readFileSync(built.path, 'utf8');
    expect(onDisk).toMatch(/Non-convergence final-positions report \(R3\.15/);
    expect(onDisk).toMatch(/candidate-only/);
    expect(onDisk).toMatch(/draft-only/);
    expect(onDisk).toMatch(/Missing req_refs/);
    expect(onDisk).toContain(candRev.short12);
    expect(onDisk).toContain(draftRev.short12);

    expect(built.summaryForBlockedReason).toMatch(/NON-CONVERGENCE-DIFF \(R3\.15\)/);
    expect(built.summaryForBlockedReason).toMatch(/candidate-only|draft-only|Missing req_refs/);
    // Must not collapse to "shaA shaB" only.
    const stripped = built.summaryForBlockedReason.replace(/[0-9a-f]{12}/g, 'HASH');
    expect(stripped.length).toBeGreaterThan(80);
  });
});

describe('runReviewRound — non-convergence BLOCKED + final-positions diff (R7, R3.15)', () => {
  let runDir: string;
  let cbPath: string;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  /** Scripted transport: each seat responds only once genuinely spawned. */
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

  // Materially different drafts so reconcile actually spawns (hash mismatch).
  const DRAFT_A = [
    '# Draft A — seat partner',
    '```json',
    '[{"id":"T1","batch":"A","title":"From A","req_refs":["R1"],"assignee":"x","validator_lane":"L1","effort":"low","type":"feature"}]',
    '```',
    '',
  ].join('\n');
  const DRAFT_B = [
    '# Draft B — seat partner-2',
    '```json',
    '[{"id":"T9","batch":"B","title":"From B — different shape","req_refs":["R9"],"assignee":"y","validator_lane":"L2","effort":"high","type":"bug"}]',
    '```',
    '',
  ].join('\n');
  const CANDIDATE_R2 = [
    '# Reconciled candidate — round 2',
    '```json',
    '[{"id":"T1","batch":"R2","title":"Reconciled r2","req_refs":["R1"],"assignee":"x","validator_lane":"L1","effort":"low","type":"feature"}]',
    '```',
    '',
  ].join('\n');
  const CANDIDATE_R3 = [
    '# Reconciled candidate — round 3 (still incomplete)',
    '```json',
    '[{"id":"T1","batch":"R3","title":"Reconciled r3","req_refs":["R1"],"assignee":"x","validator_lane":"L1","effort":"low","type":"feature"}]',
    '```',
    '',
  ].join('\n');

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r7-block-'));
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
      batchId: 'batch-R7',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath,
      planMdPath: path.join(runDir, 'plan.md'),
      perRoundTimeoutMs: 1500,
      roundCap: 3,
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

  async function publishRound1Drafts(batchId: string): Promise<boolean> {
    if (batchId === 'batch-R7-partner') {
      atomicWriteFile(draftPlanPath(runDir, 'partner'), DRAFT_A);
      await post(`[helm callback] planner ${batchId} STATUS: DRAFT-SUBMITTED plan=ffffffffffff`);
      return true;
    }
    if (batchId === 'batch-R7-partner-2') {
      atomicWriteFile(draftPlanPath(runDir, 'partner-2'), DRAFT_B);
      await post(`[helm callback] planner ${batchId} STATUS: DRAFT-SUBMITTED plan=ffffffffffff`);
      return true;
    }
    return false;
  }

  it('cap exhaustion with open objections: blockedReason carries textual diff + durable file (not bare hashes)', async () => {
    // roundCap=2 → round 1 drafts + one proposer/signer exchange that objects → terminal.
    const transport = new ScriptedSeatTransport(async (batchId: string) => {
      if (await publishRound1Drafts(batchId)) return;
      if (batchId === 'batch-R7-r2-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R2);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R7-r2-signer') {
        await post(
          `[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=2; 1. Missing req_refs on T2. 2. Effort enum invalid.`,
        );
        return;
      }
      throw new Error(`unexpected spawn ${batchId}`);
    });

    const result = await runReviewRound(baseOptions(transport, { roundCap: 2 }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('signer-objections');
    expect(result.blockedReason).toMatch(/SIGNER-OBJECTIONS/);
    expect(result.blockedReason).toMatch(/NON-CONVERGENCE-DIFF \(R3\.15\)/);
    // Operator-legible content from the candidate and/or the signer's draft — not hash-only.
    expect(result.blockedReason).toMatch(/Reconciled candidate|Draft [AB]|Missing req_refs|final-candidate|signer-last-draft/);
    // Must not be reducible to two bare short12s alone.
    const hashOnly = /^[0-9a-f]{12}\s+[0-9a-f]{12}$/;
    expect(hashOnly.test((result.blockedReason ?? '').trim())).toBe(false);
    expect((result.blockedReason ?? '').length).toBeGreaterThan(120);

    expect(result.nonConvergenceDiffPath).toBe(nonConvergenceDiffPath(runDir));
    expect(fsSync.existsSync(result.nonConvergenceDiffPath!)).toBe(true);
    const report = fsSync.readFileSync(result.nonConvergenceDiffPath!, 'utf8');
    expect(report).toMatch(/R3\.15/);
    expect(report).toMatch(/Missing req_refs on T2/);
    // Diff body should reference real document content from at least one side.
    expect(report).toMatch(/Reconciled candidate|Draft [AB]|From [AB]/);
  });

  it('monotone fail: blockedReason includes final-positions diff and does not burn remaining cap', async () => {
    const transport = new ScriptedSeatTransport(async (batchId: string) => {
      if (await publishRound1Drafts(batchId)) return;
      if (batchId === 'batch-R7-r2-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R2);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R7-r2-signer') {
        await post(
          `[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=2; 1. Defect alpha. 2. Defect beta.`,
        );
        return;
      }
      if (batchId === 'batch-R7-r3-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R3);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R7-r3-signer') {
        // Same count as r2 — NOT strictly smaller → early block.
        await post(
          `[helm callback] planner ${batchId} STATUS: OBJECTIONS — n=2; 1. Defect alpha still. 2. Defect beta still.`,
        );
        return;
      }
      if (batchId.startsWith('batch-R7-r4-') || batchId.startsWith('batch-R7-r5-')) {
        throw new Error(`must not burn cap after monotone fail: ${batchId}`);
      }
      throw new Error(`unexpected spawn ${batchId}`);
    });

    const result = await runReviewRound(baseOptions(transport, { roundCap: 5 }));

    expect(result.agreed).toBe(false);
    expect(result.blockedReasonKind).toBe('objection-not-monotone');
    expect(result.roundsAttempted).toBe(3);
    expect(result.blockedReason).toMatch(/OBJECTION-NOT-MONOTONE/);
    expect(result.blockedReason).toMatch(/NON-CONVERGENCE-DIFF \(R3\.15\)/);
    expect(result.blockedReason).toMatch(/Defect alpha|Reconciled candidate|signer-last-draft|final-candidate/);
    expect(result.nonConvergenceDiffPath).toBeTruthy();
    const report = fsSync.readFileSync(result.nonConvergenceDiffPath!, 'utf8');
    expect(report).toMatch(/round 3|objection-not-monotone|Defect alpha still/i);
    // Cap not burned: no r4/r5 spawns.
    expect(transport.spawnCalls.map((c) => c.batchId).some((id) => /r[45]-/.test(id ?? ''))).toBe(false);
  });

  it('agreed path does not write a non-convergence report', async () => {
    const transport = new ScriptedSeatTransport(async (batchId: string) => {
      if (await publishRound1Drafts(batchId)) return;
      if (batchId === 'batch-R7-r2-proposer') {
        atomicWriteFile(candidatePlanPath(runDir), CANDIDATE_R2);
        await post(`[helm callback] planner ${batchId} STATUS: CANDIDATE-SUBMITTED plan=ffffffffffff`);
        return;
      }
      if (batchId === 'batch-R7-r2-signer') {
        const onDisk = await fs.readFile(candidatePlanPath(runDir), 'utf8');
        await post(
          `[helm callback] planner ${batchId} STATUS: SIGNED plan=${planRevision(onDisk).short12}`,
        );
        return;
      }
      throw new Error(`unexpected spawn ${batchId}`);
    });

    const result = await runReviewRound(baseOptions(transport, { roundCap: 2 }));

    expect(result.agreed).toBe(true);
    expect(result.blockedReason).toBeUndefined();
    expect(result.nonConvergenceDiffPath).toBeUndefined();
    expect(fsSync.existsSync(nonConvergenceDiffPath(runDir))).toBe(false);
  });
});
