process.env.USE_FAKE_TMUX = '1';

/**
 * C6 gate — the engine-owned revise actuator (AC11).
 * Scope: planning-review-round.ts only (the module C2 introduced, C3 hardened, C4 rounded, C5 made
 * fresh-seat, C6 adds the revise turn).
 *
 * waitForAgreement (planning-phase-service.ts, untouched) only ever returns a boolean, so this
 * module has no verdict detail of its own after a round fails to agree. C6 re-scans the SAME
 * callbacks.md window, restricted to the JUST-FAILED round's own round-scoped partner batch ids, to
 * decide whether that round's non-agreement was a genuine same-plan-revision BROKEN (revise-worthy)
 * or something else (round-cap/timeout with no BROKEN evidence — C5/C4's existing bounded behaviour,
 * left untouched).
 *
 * Proves:
 * - same-SHA BROKEN in round 1 (before roundCap) spawns exactly one uniquely-named plancore revise
 *   turn, distinct from any reviewer seat's batch id;
 * - the next round's reviewer seats are not spawned until plan.md's revision hash actually changes
 *   (proven via spawn ordering against a delayed background rewrite, not merely "eventually spawns");
 * - a BROKEN whose plan= does not match the CURRENT plan.md bytes (stale/different-SHA) never
 *   triggers a revise — B5's binding discipline carries over unchanged;
 * - the revise seat's handle/runtime id are visible in the caller-owned cleanup arrays AND are
 *   explicitly reaped by this module — never leaked either way.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { planRevision } from './plan-revision.js';
import { runReviewRound, RunReviewRoundOptions } from './planning-review-round.js';

describe('runReviewRound revise actuator (C6, AC11)', () => {
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

  it('same-SHA BROKEN in round 1 before cap spawns a unique plancore revise turn', async () => {
    const sha = await writePlan('# plan A\n');
    await seedBrokenVerdict('batch-C6-partner', sha, 'task T01 missing deps');

    const result = await runReviewRound(baseOptions({ roundCap: 2 }));

    expect(result.agreed).toBe(false);
    const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
    expect(reviseCalls).toHaveLength(1);
    expect(reviseCalls[0].batchId).toBe('batch-C6-r1-revise');
    expect(reviseCalls[0].role).toBe('plancore');
    // Unique from every reviewer seat's batch id spawned this run.
    const reviewerIds = transport.spawnCalls.filter((c) => (c.batchId || '').includes('-partner')).map((c) => c.batchId);
    expect(reviewerIds).not.toContain(reviseCalls[0].batchId);
    expect(new Set(transport.spawnCalls.map((c) => c.batchId)).size).toBe(transport.spawnCalls.length);
    // The revise brief carries the aggregated defect note.
    expect(briefs.get('plancore-r1-revise')).toContain('task T01 missing deps');
  });

  it('the next reviewer round waits until plan.md hash changes before spawning', async () => {
    const sha = await writePlan('# plan A\n');
    await seedBrokenVerdict('batch-C6-partner', sha, 'bad atomicity');

    let planRewritten = false;
    const originalSpawn2 = transport.spawn.bind(transport);
    (transport as unknown as { spawn: typeof transport.spawn }).spawn = async (params) => {
      const spawned = await originalSpawn2(params);
      if ((params.batchId || '').endsWith('-revise')) {
        // Background rewrite, delayed well past one poll tick (200ms), never awaited inline —
        // proves the round-2 spawn genuinely blocks on the poll rather than racing ahead.
        setTimeout(() => { fs.writeFile(planMdPath, '# plan B (revised)\n', 'utf8').then(() => { planRewritten = true; }); }, 250);
      }
      if ((params.batchId || '').includes('-r2-partner')) {
        expect(planRewritten).toBe(true);
      }
      return spawned;
    };

    const result = await runReviewRound(baseOptions({ roundCap: 2, perRoundTimeoutMs: 2000 }));

    expect(result.roundsAttempted).toBe(2);
    expect(planRewritten).toBe(true);
    expect(spawnOrder).toEqual(['batch-C6-partner', 'batch-C6-r1-revise', 'batch-C6-r2-partner']);
    const finalContent = await fs.readFile(planMdPath, 'utf8');
    expect(finalContent).toBe('# plan B (revised)\n');
  });

  it('stale/different-SHA BROKEN does not trigger a revise for the current plan', async () => {
    await writePlan('# plan A\n');
    // Seed a BROKEN bound to a DIFFERENT (superseded) revision than the one currently on disk.
    await seedBrokenVerdict('batch-C6-partner', '0123456789ab', 'stale defect from an earlier revision');

    const result = await runReviewRound(baseOptions({ roundCap: 2 }));

    expect(result.agreed).toBe(false);
    expect(result.roundsAttempted).toBe(2);
    const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
    expect(reviseCalls).toHaveLength(0);
    // C5/C4 bounded behaviour preserved: still exactly the two round-scoped reviewer spawns.
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual(['batch-C6-partner', 'batch-C6-r2-partner']);
  });

  it('older same-SHA BROKEN then a newer malformed verdict line for the same seat spawns no revise', async () => {
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
    const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
    expect(reviseCalls).toHaveLength(0);
    // C5/C4 bounded behaviour preserved: still exactly the two round-scoped reviewer spawns.
    expect(transport.spawnCalls.map((c) => c.batchId)).toEqual(['batch-C6-partner', 'batch-C6-r2-partner']);
  });

  it('the revise seat handle/runtime id are cleanup-visible and explicitly reaped, never leaked', async () => {
    const sha = await writePlan('# plan A\n');
    await seedBrokenVerdict('batch-C6-partner', sha, 'unresolvable dep cycle');

    await runReviewRound(baseOptions({ roundCap: 2 }));

    // partnerHandles order: round1 reviewer, revise turn, round2 reviewer.
    expect(partnerHandles).toHaveLength(3);
    const reviseHandle = partnerHandles[1];
    expect(partnerRuntimeIds).toHaveLength(3);
    // Visible to the caller-owned accumulator (A5/A6 safety net)...
    expect(partnerHandles).toContain(reviseHandle);
    // ...AND explicitly reaped by this module itself (not left for the caller to discover late).
    expect(transport.reapCalls.some((r) => r.handle === reviseHandle)).toBe(true);
  });
});
