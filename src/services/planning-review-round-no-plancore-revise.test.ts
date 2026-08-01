process.env.USE_FAKE_TMUX = '1';

/**
 * R8 (R1.2/R3.10/R3.14/R6.20) — plancore whole-plan revise actuator retired.
 * Scope: planning-review-round.ts only.
 *
 * C6 used to engine-spawn a fresh plancore seat mid-round to rewrite the WHOLE plan.md whenever a
 * reviewer returned a same-current-plan BROKEN verdict. R8 deletes that actuator outright: reconcile
 * rounds — the proposer/signer exchange R3 built — are now the ONLY revise path, and plancore never
 * receives a model call again from this module (R1.2/R3.14). This file pins that retirement:
 *
 * - `generatePlanRoundReviseBrief` (the actuator's brief) has zero definitions or call sites left in
 *   production src — token-free, byte-identical check, mirrors B4's generatePlanningBrief pin;
 * - same-current-plan BROKEN evidence, with round-cap budget remaining, spawns NO plancore/-revise
 *   seat at all — the round loop falls straight through to a fresh reviewer respawn on the SAME,
 *   unrevised plan.md, exactly like C5/C4's existing no-evidence bounded behaviour;
 * - across a full multi-round run soaked in same-current-plan BROKEN evidence, `brainRole` (plancore)
 *   is never the `role` of any spawned seat — role integrity: only the two co-planner seats reconcile;
 * - the C8 same-plan-broken classification survives unchanged as pure diagnosis (R8 does not touch
 *   it): an exhausted round with same-current-plan BROKEN evidence still reports the typed
 *   `blockedReasonKind: 'same-plan-broken'`, never collapsing into round-cap-exhausted.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FakeTransport } from './fake-transport.js';
import { BriefWriterService } from './brief-writer-service.js';
import { planRevision } from './plan-revision.js';
import { runReviewRound, RunReviewRoundOptions } from './planning-review-round.js';

const REPO_ROOT = process.cwd();
const MODULE_REL = 'src/services/planning-review-round.ts';

function listProductionTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, item.name);
    if (item.isDirectory()) {
      if (item.name === 'node_modules' || item.name === 'dist') continue;
      out.push(...listProductionTsFiles(full));
      continue;
    }
    if (!item.isFile() || !item.name.endsWith('.ts') || item.name.endsWith('.test.ts')) continue;
    out.push(full);
  }
  return out;
}

describe('R8 — plancore whole-plan revise actuator retired (R1.2/R3.10/R3.14/R6.20)', () => {
  it('planning-review-round.ts source has no generatePlanRoundReviseBrief method definition', () => {
    const src = fs.readFileSync(path.join(REPO_ROOT, MODULE_REL), 'utf8');
    expect(src).not.toMatch(/\bgeneratePlanRoundReviseBrief\s*\(/);
    expect(src).not.toMatch(/\bgeneratePlanRoundReviseBrief\s*[:=]/);
  });

  it('production src has zero generatePlanRoundReviseBrief call sites or method defs (comments/prose only OK)', () => {
    // Call/def shape only — `foo(`, `foo:`, or `foo=` immediately after the identifier. A bare mention
    // in a doc comment, string literal, or prose (e.g. this very spec's own title, or a registry note
    // describing the retirement) is not a residue.
    const CALL_OR_DEF_RE = /\bgeneratePlanRoundReviseBrief\s*[(:=]/;
    const files = listProductionTsFiles(path.join(REPO_ROOT, 'src'));
    const offenders: string[] = [];
    for (const abs of files) {
      const body = fs.readFileSync(abs, 'utf8');
      const lines = body.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (CALL_OR_DEF_RE.test(line)) {
          offenders.push(`${path.relative(REPO_ROOT, abs)}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders, `production generatePlanRoundReviseBrief residues:\n${offenders.join('\n')}`).toEqual([]);
  });

  describe('round-loop behavior', () => {
    let runDir: string;
    let planMdPath: string;
    let cbPath: string;
    let transport: FakeTransport;
    let briefWriter: BriefWriterService;
    let briefs: Map<string, string>;
    let partnerHandles: string[];
    let partnerRuntimeIds: (number | null)[];

    beforeEach(async () => {
      runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-r8-no-revise-'));
      planMdPath = path.join(runDir, 'plan.md');
      cbPath = path.join(runDir, 'callbacks.md');
      transport = new FakeTransport();
      briefWriter = new BriefWriterService();
      briefs = new Map();
      partnerHandles = [];
      partnerRuntimeIds = [];
    });

    afterEach(async () => {
      if (runDir) await fsp.rm(runDir, { recursive: true, force: true }).catch(() => {});
    });

    async function writePlan(content: string): Promise<string> {
      await fsp.writeFile(planMdPath, content, 'utf8');
      return planRevision(content).short12;
    }

    async function seedBrokenVerdict(partnerBatchId: string, planSha: string, defect: string): Promise<void> {
      const line = `[helm callback] planner ${partnerBatchId} STATUS: VERDICT-READY — BROKEN: ${defect} plan=${planSha}\n`;
      await fsp.appendFile(cbPath, line, 'utf8');
    }

    function baseOptions(overrides: Partial<RunReviewRoundOptions> = {}): RunReviewRoundOptions {
      return {
        transport,
        briefWriter,
        writeBrief: async (role, content) => { briefs.set(role, content); },
        registerWorkerRuntime: () => partnerRuntimeIds.length + 1,
        waitForAgreement: async () => false,
        runDir,
        batchId: 'batch-R8',
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

    it('same-SHA BROKEN evidence with round budget remaining spawns no plancore/-revise seat', async () => {
      const sha = await writePlan('# plan A\n');
      await seedBrokenVerdict('batch-R8-partner', sha, 'task T01 missing deps');

      const result = await runReviewRound(baseOptions({ roundCap: 2 }));

      expect(result.agreed).toBe(false);
      expect(result.roundsAttempted).toBe(2);
      const reviseCalls = transport.spawnCalls.filter((c) => (c.batchId || '').endsWith('-revise'));
      expect(reviseCalls).toHaveLength(0);
      // C5/C4 bounded behaviour preserved: exactly the two round-scoped reviewer spawns, on the SAME
      // (unrevised) plan.md — no engine-driven rewrite exists anymore.
      expect(transport.spawnCalls.map((c) => c.batchId)).toEqual(['batch-R8-partner', 'batch-R8-r2-partner']);
      const finalContent = await fsp.readFile(planMdPath, 'utf8');
      expect(finalContent).toBe('# plan A\n');
    });

    it('role-integrity: brainRole (plancore) is never the role of any seat spawned across a same-plan-broken run', async () => {
      const sha = await writePlan('# plan A\n');
      await seedBrokenVerdict('batch-R8-partner', sha, 'task T01 missing deps');
      await seedBrokenVerdict('batch-R8-r2-partner', sha, 'task T01 still missing deps');

      await runReviewRound(baseOptions({ roundCap: 3 }));

      const plancoreSpawns = transport.spawnCalls.filter((c) => c.role === 'plancore');
      expect(plancoreSpawns).toHaveLength(0);
      expect(briefs.has('plancore-r1-revise')).toBe(false);
      expect(briefs.has('plancore-r2-revise')).toBe(false);
    });

    it('a same-plan-broken exhausted round still returns the typed same-plan-broken classification (C8 preserved)', async () => {
      const sha = await writePlan('# plan A\n');
      await seedBrokenVerdict('batch-R8-r2-partner', sha, 'task T02 missing validation_criteria');

      const result = await runReviewRound(baseOptions({ roundCap: 2 }));

      expect(result.agreed).toBe(false);
      expect(result.roundsAttempted).toBe(2);
      expect(result.blockedReasonKind).toBe('same-plan-broken');
      expect(result.blockedReason).toMatch(/SAME-PLAN-BROKEN/);
      expect(result.blockedReason).not.toMatch(/revise turn/);
    });
  });
});
