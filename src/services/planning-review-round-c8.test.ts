process.env.USE_FAKE_TMUX = '1';

/**
 * C8 gate — typed round-loop results replace the anonymous boolean-false BROKEN short-circuit
 * (AC11/AC23). Scope: planning-review-round.ts only (the module C2 introduced, C3 hardened, C4
 * rounded, C5 made fresh-seat, C6 added the revise actuator, C7 added the reviewer watchdog, C8
 * makes the round loop's non-agreement classification typed and complete).
 *
 * Before C8, C6's same-current-plan BROKEN scan (collectSameShaBrokenEvidence) only ran when
 * `round < resolvedRoundCap` — a round with budget left to spend on a revise turn. A same-current-plan
 * BROKEN on the FINAL round therefore left no trace: the function fell straight through to the
 * generic ROUND-CAP-EXHAUSTED return, indistinguishable from a round that simply timed out with no
 * BROKEN evidence at all. C8 hoists the classification itself (not the revise SPAWN, which stays
 * correctly gated on remaining round budget) to run every non-agreeing round, and adds an additive
 * `blockedReasonKind` field so the CAUSE is typed in code, not just prose.
 *
 * Proves:
 * - BROKEN on revision R1 drives a plancore revise turn that writes R2; fresh reviewer seats spawn
 *   for R2; a CLEAN on R2 converges — end to end through runReviewRound (the C6 flow, now also
 *   exercised through to a genuine agreement rather than stopping at "does it spawn a revise?");
 * - a same-current-plan BROKEN on the FINAL round (no budget left for a revise turn) returns a typed
 *   `blockedReasonKind: 'same-plan-broken'` and a message that does NOT read as ROUND-CAP-EXHAUSTED —
 *   the exact defect C8 fixes;
 * - a stale/superseded-SHA BROKEN on the final round still does not count for the current plan and
 *   falls back to the generic `round-cap-exhausted` classification (B5's SHA-binding discipline
 *   applies to the classification path too, not just the mid-loop revise path);
 * - an older same-SHA BROKEN followed by a newer malformed verdict line for the SAME seat remains
 *   fail-closed on the final round too (B4's newest-verdict-locks-the-seat invariant): the malformed
 *   newest line must never let the older, parseable BROKEN win.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { planRevision } from './plan-revision.js';
import { runReviewRound, RunReviewRoundOptions } from './planning-review-round.js';

describe('runReviewRound typed round-loop results (C8, AC11/AC23)', () => {
  let runDir: string;
  let planMdPath: string;
  let cbPath: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-c8-typed-round-'));
    planMdPath = path.join(runDir, 'plan.md');
    cbPath = path.join(runDir, 'callbacks.md');
    transport = new FakeTransport();
    briefWriter = new BriefWriterService();
    briefs = new Map();
    partnerHandles = [];
    partnerRuntimeIds = [];
  });

  afterEach(async () => {
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  async function writePlan(content: string): Promise<string> {
    await fs.writeFile(planMdPath, content, 'utf8');
    return planRevision(content).short12;
  }

  async function seedBrokenVerdict(partnerBatchId: string, planSha: string, defect: string): Promise<void> {
    const line = `[helm callback] planner ${partnerBatchId} STATUS: VERDICT-READY — BROKEN: ${defect} plan=${planSha}\n`;
    await fs.appendFile(cbPath, line, 'utf8');
  }

  function baseOptions(overrides: Partial<RunReviewRoundOptions> = {}): RunReviewRoundOptions {
    return {
      transport,
      briefWriter,
      writeBrief: async (role, content) => { briefs.set(role, content); },
      registerWorkerRuntime: () => partnerRuntimeIds.length + 1,
      waitForAgreement: async () => false,
      runDir,
      batchId: 'batch-C8',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath,
      planMdPath,
      perRoundTimeoutMs: 1000,
      agreementFenceOffset: 0,
      isFake: true,
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  it('BROKEN on R1 revises to R2, fresh reviewer seats spawn, CLEAN on R2 converges end-to-end', async () => {
    const shaR1 = await writePlan('# plan A\n');
    await seedBrokenVerdict('batch-C8-partner', shaR1, 'task T01 missing deps');

    const originalSpawn = transport.spawn.bind(transport);
    (transport as unknown as { spawn: typeof transport.spawn }).spawn = async (params) => {
      const spawned = await originalSpawn(params);
      if ((params.batchId || '').endsWith('-revise')) {
        // Simulate plancore's revise turn: rewrite plan.md to a genuinely new revision before this
        // spawn call returns, so the caller's subsequent waitForPlanRevisionChange poll sees it.
        await fs.writeFile(planMdPath, '# plan B (revised)\n', 'utf8');
      }
      return spawned;
    };

    let waitCalls = 0;
    const result = await runReviewRound(baseOptions({
      roundCap: 2,
      waitForAgreement: async () => {
        waitCalls += 1;
        return waitCalls === 2; // round 1: BROKEN drives revise; round 2: CLEAN converges
      },
    }));

    expect(result.agreed).toBe(true);
    expect(result.roundsAttempted).toBe(2);
    expect(result.blockedReason).toBeUndefined();
    expect(result.blockedReasonKind).toBeUndefined();

    const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
    expect(reviseCalls).toHaveLength(1);
    expect(reviseCalls[0].batchId).toBe('batch-C8-r1-revise');

    const reviewerCalls = transport.spawnCalls.filter((c) => (c.batchId || '').includes('-partner'));
    expect(reviewerCalls.map((c) => c.batchId)).toEqual(['batch-C8-partner', 'batch-C8-r2-partner']);
    expect(briefs.has('planner')).toBe(true);
    expect(briefs.has('planner-r2')).toBe(true);

    const finalContent = await fs.readFile(planMdPath, 'utf8');
    expect(finalContent).toBe('# plan B (revised)\n');
  });

  it('same-current-plan BROKEN on the FINAL round returns typed same-plan-broken, not ROUND-CAP-EXHAUSTED', async () => {
    const sha = await writePlan('# plan A\n');
    // Round 1 has no BROKEN evidence of its own — it simply fails to agree and, with no evidence,
    // falls through to round 2 unchanged (C5/C4's existing bounded behaviour). Only round 2 (the
    // FINAL round, since roundCap=2) has same-SHA BROKEN evidence — and round 2 has no further round
    // left to spend on a revise turn.
    await seedBrokenVerdict('batch-C8-r2-partner', sha, 'task T02 missing validation_criteria');

    const result = await runReviewRound(baseOptions({ roundCap: 2 }));

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(2);
    expect(result.blockedReasonKind).toBe('same-plan-broken');
    expect(result.blockedReason).toMatch(/SAME-PLAN-BROKEN/);
    expect(result.blockedReason).toMatch(/batch-C8-r2-partner/);
    expect(result.blockedReason).not.toMatch(/ROUND-CAP-EXHAUSTED/);

    // No budget remained on the final round — no revise turn is spawned even though the evidence
    // was found; the caller still gets the plancore-shaped revise-worthy diagnosis, not a generic
    // timeout, and no phantom revise-turn side effects.
    const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
    expect(reviseCalls).toHaveLength(0);
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual(['batch-C8-partner', 'batch-C8-r2-partner']);
  });

  it('stale/superseded-SHA BROKEN on the final round still does not count for the current plan', async () => {
    await writePlan('# plan A\n');
    // Bound to a DIFFERENT (superseded) revision than the one currently on disk — B5's SHA-binding
    // discipline, mirrored by C6's collectSameShaBrokenEvidence, must exclude it on the classification
    // path exactly as it already does on the mid-loop revise-spawn path.
    await seedBrokenVerdict('batch-C8-r2-partner', '0123456789ab', 'stale defect from an earlier revision');

    const result = await runReviewRound(baseOptions({ roundCap: 2 }));

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(2);
    expect(result.blockedReasonKind).toBe('round-cap-exhausted');
    expect(result.blockedReason).toMatch(/ROUND-CAP-EXHAUSTED/);
    expect(result.blockedReason).not.toMatch(/SAME-PLAN-BROKEN/);

    const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
    expect(reviseCalls).toHaveLength(0);
  });

  it('older same-SHA BROKEN then a newer malformed verdict line for the same seat stays fail-closed on the final round', async () => {
    const sha = await writePlan('# plan A\n');
    await seedBrokenVerdict('batch-C8-r2-partner', sha, 'task T03 missing deps');
    // Newer raw line for the SAME seat, truncated mid-write — fails the strict grammar entirely, but
    // is still unambiguously this seat's own line (same batch id). B4's fail-closed invariant binds a
    // seat to its NEWEST verdict line even when malformed/unparseable; it must never fall back to the
    // older, parseable same-SHA BROKEN.
    await fs.appendFile(cbPath, '[helm callback] planner batch-C8-r2-partner CORRUPTED-MIDWRITE-TRUNC\n', 'utf8');

    const result = await runReviewRound(baseOptions({ roundCap: 2 }));

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(2);
    expect(result.blockedReasonKind).toBe('round-cap-exhausted');
    expect(result.blockedReason).toMatch(/ROUND-CAP-EXHAUSTED/);
    expect(result.blockedReason).not.toMatch(/SAME-PLAN-BROKEN/);

    const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
    expect(reviseCalls).toHaveLength(0);
  });
});
