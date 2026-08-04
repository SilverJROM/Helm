process.env.USE_FAKE_TMUX = '1';

/**
 * C6 gate, retired by R8 (R1.2/R3.10/R3.14/R6.20) — the mid-round plancore whole-plan revise
 * actuator is DELETED, not merely disabled. Scope: planning-review-round.ts only (the module C2
 * introduced, C3 hardened, C4 rounded, C5 made fresh-seat, C6 added — and R8 removed — the revise
 * turn).
 *
 * waitForAgreement (planning-phase-service.ts, untouched) only ever returns a boolean, so this
 * module still re-scans the SAME callbacks.md window, restricted to the JUST-FAILED round's own
 * round-scoped partner batch ids, to decide whether that round's non-agreement was a genuine
 * same-plan-revision BROKEN or something else (C8's typed classification, preserved by R8). What
 * changed is what happens with that evidence: it used to gate an engine-spawned plancore rewrite of
 * the WHOLE plan.md; now it drives nothing at all. Reconcile rounds — the proposer/signer exchange R3
 * built — are the only revise path left; plancore never receives a model call from this module again.
 *
 * Proves:
 * - same-SHA BROKEN in round 1 (before roundCap) spawns NO plancore/-revise seat — round 2 simply
 *   respawns a fresh reviewer on the SAME, unrevised plan.md (C5/C4's existing bounded behaviour);
 * - the next round's reviewer seats spawn immediately — there is no plan.md hash-change wait to block
 *   on anymore, since nothing in this module ever rewrites plan.md;
 * - a BROKEN whose plan= does not match the CURRENT plan.md bytes (stale/different-SHA) still never
 *   counts as same-plan-broken evidence — B5's binding discipline carries over into the classification
 *   path unchanged, even with the actuator it used to gate gone;
 * - an older same-SHA BROKEN followed by a newer malformed verdict line for the same seat stays
 *   fail-closed on the classification path too (never mistaken for same-plan-broken evidence);
 * - no phantom actuator handle/runtime id ever appears in the caller-owned cleanup arrays — only the
 *   round-scoped reviewer seats that were actually spawned.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { planRevision } from './plan-revision.js';
import { runReviewRound, RunReviewRoundOptions } from './planning-review-round.js';

describe('runReviewRound same-plan-broken evidence — no plancore revise, reconcile rounds only (C6/R8)', () => {
  let runDir: string;
  let planMdPath: string;
  let cbPath: string;
  let transport: FakeTransport;
  let briefWriter: BriefWriterService;
  let briefs: Map<string, string>;
  let partnerHandles: string[];
  let partnerRuntimeIds: (number | null)[];
  let spawnOrder: string[];

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-c6-revise-'));
    planMdPath = path.join(runDir, 'plan.md');
    cbPath = path.join(runDir, 'callbacks.md');
    transport = new FakeTransport();
    briefWriter = new BriefWriterService();
    briefs = new Map();
    partnerHandles = [];
    partnerRuntimeIds = [];
    spawnOrder = [];

    const originalSpawn = transport.spawn.bind(transport);
    (transport as unknown as { spawn: typeof transport.spawn }).spawn = async (params) => {
      const spawned = await originalSpawn(params);
      spawnOrder.push(params.batchId || spawned.handle);
      return spawned;
    };
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
      batchId: 'batch-C6',
      brainRole: 'plancore',
      partner: 'planner',
      effectiveProjectDir: '/home/agjrom/websites/Helm',
      cbPath,
      planMdPath,
      perRoundTimeoutMs: 300,
      agreementFenceOffset: 0,
      isFake: true,
      partnerHandles,
      partnerRuntimeIds,
      ...overrides,
    };
  }

  it('same-SHA BROKEN in round 1 before cap spawns no plancore revise turn — round 2 respawns fresh reviewers on the same plan instead', async () => {
    const sha = await writePlan('# plan A\n');
    await seedBrokenVerdict('batch-C6-partner', sha, 'task T01 missing deps');

    const result = await runReviewRound(baseOptions({ roundCap: 2 }));

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(2);
    const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
    expect(reviseCalls).toHaveLength(0);
    const plancoreSpawns = transport.spawnCalls.filter((c) => c.role === 'plancore');
    expect(plancoreSpawns).toHaveLength(0);
    expect(briefs.has('plancore-r1-revise')).toBe(false);
    // C5/C4 bounded behaviour is now the ONLY thing that happens on same-plan-broken evidence: a
    // fresh reviewer respawn on the SAME plan.md.
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual(['batch-C6-partner', 'batch-C6-r2-partner']);
  });

  it('the next reviewer round spawns immediately — no plan.md hash-change wait, since there is no revise turn left to wait on', async () => {
    const sha = await writePlan('# plan A\n');
    await seedBrokenVerdict('batch-C6-partner', sha, 'bad atomicity');

    const result = await runReviewRound(baseOptions({ roundCap: 2, perRoundTimeoutMs: 2000 }));

    expect(result.roundsAttempted).toBe(2);
    expect(spawnOrder).toEqual(['batch-C6-partner', 'batch-C6-r2-partner']);
    // Nothing in this module rewrites plan.md anymore — reconciliation is entirely the proposer/signer
    // exchange's job now, out of this legacy reviewer path's scope.
    const finalContent = await fs.readFile(planMdPath, 'utf8');
    expect(finalContent).toBe('# plan A\n');
  });

  it('stale/different-SHA BROKEN does not count as same-plan-broken classification evidence', async () => {
    await writePlan('# plan A\n');
    // Seed a BROKEN bound to a DIFFERENT (superseded) revision than the one currently on disk.
    await seedBrokenVerdict('batch-C6-partner', '0123456789ab', 'stale defect from an earlier revision');

    const result = await runReviewRound(baseOptions({ roundCap: 2 }));

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(2);
    // B5's SHA-binding discipline still applies on the classification path: a stale claim never counts,
    // so this falls back to the generic round-cap-exhausted cause, never same-plan-broken.
    expect(result.blockedReasonKind).toBe('round-cap-exhausted');
    const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
    expect(reviseCalls).toHaveLength(0);
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual(['batch-C6-partner', 'batch-C6-r2-partner']);
  });

  it('older same-SHA BROKEN then a newer malformed verdict line for the same seat stays fail-closed (round-cap-exhausted, not same-plan-broken)', async () => {
    const sha = await writePlan('# plan A\n');
    await seedBrokenVerdict('batch-C6-partner', sha, 'task T02 missing validation_criteria');
    // Newer raw line for the SAME seat: truncated mid-write, missing the "STATUS:" token — fails
    // parseRoundCallbackLine's strict grammar entirely, but is still unambiguously this seat's own
    // line. The B4 fail-closed invariant binds a seat to its NEWEST verdict line even when that line
    // is malformed/unparseable; it must never fall back to the older, parseable same-SHA BROKEN.
    await fs.appendFile(cbPath, '[helm callback] planner batch-C6-partner CORRUPTED-MIDWRITE-TRUNC\n', 'utf8');

    const result = await runReviewRound(baseOptions({ roundCap: 2 }));

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(2);
    expect(result.blockedReasonKind).toBe('round-cap-exhausted');
    const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
    expect(reviseCalls).toHaveLength(0);
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual(['batch-C6-partner', 'batch-C6-r2-partner']);
  });

  it('same-SHA BROKEN evidence adds no phantom handle/runtime id beyond the round-scoped reviewer seats', async () => {
    const sha = await writePlan('# plan A\n');
    await seedBrokenVerdict('batch-C6-partner', sha, 'unresolvable dep cycle');

    await runReviewRound(baseOptions({ roundCap: 2 }));

    // partnerHandles order: round1 reviewer, round2 reviewer — never a third, actuator-spawned handle.
    expect(partnerHandles).toHaveLength(2);
    expect(partnerRuntimeIds).toHaveLength(2);
    // Round 1's reviewer handle is reaped before round 2 spawns (the loop's existing prior-round reap),
    // never an actuator-only handle that no longer exists.
    expect(transport.reapCalls.some((r) => r.handle === partnerHandles[0])).toBe(true);
  });
});
