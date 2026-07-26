// Adaptive planner stages 2–4 — pure gates + batch convening + deadlock/settle + OFF isolation.
process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';
import {
  ADAPTIVE_PLAN_EVENTS,
  AdaptivePlanningBlockedError,
  applyHeuristicAutoPromote,
  applySkeletonPatch,
  evaluateSkeletonGate,
  escalateTaskDepths,
  nextPlanDepth,
  parseCritique,
  partitionByPlanDepth,
  renderPlanMarkdown,
  renderRequirementsMarkdown,
  resolvePanelDeadlock,
  runAdaptivePlanningPhase,
  runStructuralGates,
  shouldEscalateTier,
  skeletonToAuthoredTasks,
  type AuthoredTask,
  type Critique,
  type PlanSkeleton,
  type SkeletonTask,
} from './adaptive-planning-phase.js';

function sk(
  task_key: string,
  intent: string,
  plan_depth: 'solo' | 'pair' | 'panel',
  extra: Partial<SkeletonTask> = {},
): SkeletonTask {
  return {
    task_key,
    intent,
    plan_depth,
    depth_vector: {
      cross_cutting: false,
      ambiguity: false,
      blast_radius: 'low',
      novelty: false,
      ...(extra.depth_vector || {}),
    },
    complexity: extra.complexity || 'med',
    deps: extra.deps || [],
    req_refs: extra.req_refs || [],
    affinity: extra.affinity,
    shared_contract: extra.shared_contract,
  };
}

describe('adaptive planner — stages 2–4', () => {
  // -------------------------------------------------------------------------
  // Skeleton gate (FIX 1)
  // -------------------------------------------------------------------------
  describe('skeleton dual-read gate', () => {
    it('PASS when every req has ≥1 task, deps resolve, no xhigh-cluster hole', () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01', 'R-02'],
        tasks: [
          sk('T01', 'Scaffold', 'solo', { req_refs: ['R-01'] }),
          sk('T02', 'Feature', 'pair', { req_refs: ['R-02'], deps: ['T01'] }),
        ],
      };
      const g = evaluateSkeletonGate(skeleton);
      expect(g.pass).toBe(true);
      expect(g.uncoveredReqs).toEqual([]);
      expect(g.orphanDeps).toEqual([]);
      expect(g.coverage['R-01']).toEqual(['T01']);
    });

    it('FAIL when a requirement has no task_key', () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01', 'R-MISSING'],
        tasks: [sk('T01', 'Only covers R-01', 'solo', { req_refs: ['R-01'] })],
      };
      const g = evaluateSkeletonGate(skeleton);
      expect(g.pass).toBe(false);
      expect(g.uncoveredReqs).toContain('R-MISSING');
      expect(g.errors.some((e) => /coverage/.test(e))).toBe(true);
    });

    it('FAIL on orphan deps', () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01'],
        tasks: [sk('T01', 'Depends on ghost', 'solo', { req_refs: ['R-01'], deps: ['T99'] })],
      };
      const g = evaluateSkeletonGate(skeleton);
      expect(g.pass).toBe(false);
      expect(g.orphanDeps).toContain('T01->T99');
    });

    it('FAIL xhigh cluster without shared-contract task', () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01', 'R-02'],
        tasks: [
          sk('T01', 'Xhigh A', 'panel', {
            complexity: 'xhigh', affinity: 'core', req_refs: ['R-01'],
          }),
          sk('T02', 'Xhigh B', 'panel', {
            complexity: 'xhigh', affinity: 'core', req_refs: ['R-02'],
          }),
        ],
      };
      const g = evaluateSkeletonGate(skeleton);
      expect(g.pass).toBe(false);
      expect(g.errors.some((e) => /shared-contract/.test(e))).toBe(true);
    });

    it('PASS xhigh cluster when shared_contract task present', () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01', 'R-02', 'R-03'],
        tasks: [
          sk('T00', 'Shared contract for core', 'panel', {
            complexity: 'xhigh', affinity: 'core', req_refs: ['R-03'], shared_contract: true,
          }),
          sk('T01', 'Xhigh A', 'panel', {
            complexity: 'xhigh', affinity: 'core', req_refs: ['R-01'],
          }),
          sk('T02', 'Xhigh B', 'panel', {
            complexity: 'xhigh', affinity: 'core', req_refs: ['R-02'],
          }),
        ],
      };
      expect(evaluateSkeletonGate(skeleton).pass).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Closed critique protocol (FIX 4)
  // -------------------------------------------------------------------------
  describe('closed Critique protocol', () => {
    it('parses CRITIQUE-READY block', () => {
      const c = parseCritique(`
CRITIQUE-READY
verdict: ESCALATE
severity: hard
reasons: [unsafe_solo, cross_cutting]
patch: {"set_depth":[{"task_key":"T01","plan_depth":"pair"}]}
`);
      expect(c).toMatchObject({
        verdict: 'ESCALATE',
        severity: 'hard',
        reasons: expect.arrayContaining(['unsafe_solo', 'cross_cutting']),
      });
      expect(shouldEscalateTier(c)).toBe(true);
    });

    it('soft ESCALATE does NOT burn a tier step', () => {
      const c: Critique = { verdict: 'ESCALATE', severity: 'soft', reasons: ['other'] };
      expect(shouldEscalateTier(c)).toBe(false);
    });

    it('ACCEPT is never an escalation', () => {
      expect(shouldEscalateTier({ verdict: 'ACCEPT', severity: 'hard', reasons: [] })).toBe(false);
    });

    it('cross_cutting hard ESCALATE jumps to panel', () => {
      const c: Critique = {
        verdict: 'ESCALATE', severity: 'hard', reasons: ['cross_cutting'],
      };
      expect(nextPlanDepth('solo', c)).toBe('panel');
    });

    it('applies re-cut patch (add_tasks + set_depth)', () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01'],
        tasks: [sk('T01', 'A', 'solo', { req_refs: ['R-01'] })],
      };
      const next = applySkeletonPatch(skeleton, {
        add_tasks: [sk('T02', 'B', 'pair', { req_refs: ['R-01'], deps: ['T01'] })],
        set_depth: [{ task_key: 'T01', plan_depth: 'pair' }],
        add_requirements: ['R-02'],
      });
      expect(next.tasks.map((t) => t.task_key).sort()).toEqual(['T01', 'T02']);
      expect(next.tasks.find((t) => t.task_key === 'T01')!.plan_depth).toBe('pair');
      expect(next.requirements).toContain('R-02');
    });
  });

  // -------------------------------------------------------------------------
  // Tier routing by plan_depth (FIX 2/3) — batch, not per-task
  // -------------------------------------------------------------------------
  describe('tier routing by plan_depth', () => {
    it('partitions solo / pair / panel and clusters A by affinity', () => {
      const tasks = [
        sk('S1', 'solo work', 'solo'),
        sk('S2', 'solo 2', 'solo'),
        sk('B1', 'pair work', 'pair'),
        sk('A1', 'panel a', 'panel', { affinity: 'auth' }),
        sk('A2', 'panel b', 'panel', { affinity: 'auth' }),
        sk('A3', 'panel c', 'panel', { affinity: 'ui' }),
      ];
      const p = partitionByPlanDepth(tasks);
      expect(p.solo_set.map((t) => t.task_key)).toEqual(['S1', 'S2']);
      expect(p.B_set.map((t) => t.task_key)).toEqual(['B1']);
      expect(p.A_set).toHaveLength(3);
      expect(p.A_clusters.auth).toHaveLength(2);
      expect(p.A_clusters.ui).toHaveLength(1);
    });

    it('plan_depth stays separate from complexity', () => {
      const t = sk('T01', 'easy but uncertain', 'panel', { complexity: 'low' });
      expect(t.plan_depth).toBe('panel');
      expect(t.complexity).toBe('low');
      const p = partitionByPlanDepth([t]);
      expect(p.A_set).toHaveLength(1);
      expect(p.solo_set).toHaveLength(0);
    });

    it('heuristic auto-promote moves hardened/cross-cutting solo → pair', () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01', 'R-02'],
        tasks: [
          sk('T01', 'Touch hardened module auth', 'solo', { req_refs: ['R-01'] }),
          sk('T02', 'Plain util', 'solo', {
            req_refs: ['R-02'],
            depth_vector: {
              cross_cutting: true, ambiguity: false, blast_radius: 'med', novelty: false,
            },
          }),
          sk('T03', 'Trivial copy', 'solo', { req_refs: ['R-01'] }),
        ],
      };
      const next = applyHeuristicAutoPromote(skeleton);
      expect(next.tasks.find((t) => t.task_key === 'T01')!.plan_depth).toBe('pair');
      expect(next.tasks.find((t) => t.task_key === 'T02')!.plan_depth).toBe('pair');
      expect(next.tasks.find((t) => t.task_key === 'T03')!.plan_depth).toBe('solo');
    });

    it('escalateTaskDepths is upward-only', () => {
      const tasks = [
        sk('T01', 'a', 'solo'),
        sk('T02', 'b', 'panel'),
      ];
      const next = escalateTaskDepths(tasks, ['T01', 'T02'], 'pair');
      expect(next.find((t) => t.task_key === 'T01')!.plan_depth).toBe('pair');
      expect(next.find((t) => t.task_key === 'T02')!.plan_depth).toBe('panel'); // not demoted
    });
  });

  // -------------------------------------------------------------------------
  // Deadlock → settle / block (FIX 4)
  // -------------------------------------------------------------------------
  describe('deadlock → settle / block', () => {
    const draftA: AuthoredTask[] = [{
      id: 'T01', batch: 'B1', title: 'Do the thing', req_refs: ['R-01'],
      assignee: 'L1', validator_lane: 'L1', effort: 'med', type: 'feature', deps: [],
    }];
    const draftB: AuthoredTask[] = [{
      id: 'T01', batch: 'B1', title: 'Do a different thing', req_refs: ['R-01'],
      assignee: 'L1', validator_lane: 'L1', effort: 'med', type: 'feature', deps: [],
    }];

    it('settles via named settle-pair when drafts conflict', () => {
      const settled: AuthoredTask[] = [{
        id: 'T01', batch: 'B1', title: 'Settled title', req_refs: ['R-01'],
        assignee: 'L2', validator_lane: 'L1', effort: 'med', type: 'feature', deps: [],
      }];
      const r = resolvePanelDeadlock({
        drafts: [draftA, draftB],
        settlePairTasks: settled,
        settlePairNames: ['planner_01', 'planner_02'],
      });
      expect(r.action).toBe('settle');
      expect(r.settledTasks![0].title).toBe('Settled title');
      expect(r.dissent).toMatch(/SETTLED by settle-pair/);
    });

    it('BLOCKs when needs_JROM', () => {
      const r = resolvePanelDeadlock({
        drafts: [draftA, draftB],
        needsJrom: true,
      });
      expect(r.action).toBe('block');
      expect(r.reason).toMatch(/needs_JROM/);
    });

    it('BLOCKs on conflict with no settle-pair output (plancore never authors)', () => {
      const r = resolvePanelDeadlock({
        drafts: [draftA, draftB],
        settlePairTasks: null,
      });
      expect(r.action).toBe('block');
      expect(r.reason).toMatch(/deadlock/);
    });
  });

  // -------------------------------------------------------------------------
  // Structural gates (FIX 6)
  // -------------------------------------------------------------------------
  describe('structural gates', () => {
    it('PASS on valid plan + covered requirements', () => {
      const tasks = skeletonToAuthoredTasks([
        sk('T01', 'Scaffold module types', 'solo', { req_refs: ['R-01'] }),
        sk('T02', 'Implement feature logic', 'pair', { req_refs: ['R-02'], deps: ['T01'] }),
      ]);
      const planMd = renderPlanMarkdown(tasks);
      const reqMd = renderRequirementsMarkdown(['R-01', 'R-02'], tasks);
      const g = runStructuralGates(planMd, reqMd);
      expect(g.pass).toBe(true);
    });

    it('FAIL on plan-contradiction HARD marker', () => {
      const tasks = skeletonToAuthoredTasks([
        sk('T01', 'Scaffold', 'solo', { req_refs: ['R-01'] }),
      ]);
      const planMd = renderPlanMarkdown(tasks)
        + '\n\nPLAN-CONTRADICTION: task says X vs requirement says Y — resolved-as: none: blocked\n';
      const reqMd = renderRequirementsMarkdown(['R-01'], tasks);
      const g = runStructuralGates(planMd, reqMd);
      expect(g.pass).toBe(false);
      expect(g.errors.some((e) => /plan-contradiction HARD/.test(e))).toBe(true);
    });

    it('FAIL on duplicate atomic_work', () => {
      const t1 = skeletonToAuthoredTasks([sk('T01', 'Same title', 'solo', { req_refs: ['R-01'] })])[0];
      const t2 = skeletonToAuthoredTasks([sk('T02', 'Same title', 'solo', { req_refs: ['R-02'] })])[0];
      const planMd = renderPlanMarkdown([t1, t2]);
      const reqMd = renderRequirementsMarkdown(['R-01', 'R-02'], [t1, t2]);
      const g = runStructuralGates(planMd, reqMd);
      expect(g.pass).toBe(false);
      expect(g.errors.some((e) => /duplicate atomic_work/.test(e))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // End-to-end adaptive path under fake transport (batch convening + ingest)
  // -------------------------------------------------------------------------
  describe('runAdaptivePlanningPhase (fake transport)', () => {
    let runDir: string;
    let transport: FakeTransport;
    let tmpDb: string;
    let dbs: DatabaseService;
    let art: RunArtifactService;
    let queue: TaskQueueService;

    beforeEach(async () => {
      runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-adaptive-e2e-'));
      await fs.writeFile(path.join(runDir, 'callbacks.md'), '# cbs\n', 'utf8');
      transport = new FakeTransport();
      tmpDb = path.join(os.tmpdir(), `helm-adaptive-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
      dbs = new DatabaseService(tmpDb);
      art = new RunArtifactService(dbs);
      queue = new TaskQueueService(art);
    });

    afterEach(async () => {
      try { dbs.close(); } catch { /* */ }
      await fs.rm(tmpDb, { force: true }).catch(() => {});
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    });

    it('end-to-end: skeleton gate → tier route → integrate → ingest (same PlanningResult shape)', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01', 'R-02'],
        tasks: [
          sk('T01', 'Scaffold adaptive module', 'solo', { req_refs: ['R-01'] }),
          sk('T02', 'Implement pair-reviewed feature', 'pair', {
            req_refs: ['R-02'], deps: ['T01'],
          }),
        ],
      };
      const res = await runAdaptivePlanningPhase(
        { transport, artifacts: art, taskQueue: queue },
        {
          runDir,
          northStar: 'Simple adaptive feature with clear scope.',
          batchId: 'batch-adaptive-e2e',
          fixture: {
            skeleton,
            critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            soloAudit: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            bCritique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
          },
        },
      );
      expect(res.agreed).toBe(true);
      expect(res.createdTaskIds.length).toBe(2);
      expect(res.keyToId['T01']).toBeTypeOf('number');
      expect(res.keyToId['T02']).toBeTypeOf('number');
      expect(res.planMdPath).toMatch(/plan\.md$/);
      expect(res.reqPath).toMatch(/og-requirements\.md$/);
      // canonical artifacts exist
      await expect(fs.access(res.planMdPath)).resolves.toBeUndefined();
      await expect(fs.access(res.reqPath)).resolves.toBeUndefined();
    });

    it('batch convening: solo/B use ONE lead spawn each — never per-task', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01', 'R-02', 'R-03'],
        tasks: [
          sk('S1', 'Solo one', 'solo', { req_refs: ['R-01'] }),
          sk('S2', 'Solo two', 'solo', { req_refs: ['R-01'] }),
          sk('S3', 'Solo three', 'solo', { req_refs: ['R-02'] }),
          sk('B1', 'Pair one', 'pair', { req_refs: ['R-02'], deps: ['S1'] }),
          sk('B2', 'Pair two', 'pair', { req_refs: ['R-03'], deps: ['S2'] }),
        ],
      };
      await runAdaptivePlanningPhase(
        { transport, artifacts: art, taskQueue: queue },
        {
          runDir,
          northStar: 'Multi-solo multi-pair feature.',
          batchId: 'batch-batch-convene',
          fixture: {
            skeleton,
            critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            soloAudit: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            bCritique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
          },
        },
      );
      // Lead roles for skeleton + solo set + B set + integrator = 4 lead_planner spawns
      // (NOT 3 solo + 2 B = 5 per-task author spawns)
      const leadSpawns = transport.spawnCalls.filter((s) => s.role === 'lead_planner');
      // skeleton, solo batch, B batch, integrate = 4
      expect(leadSpawns.length).toBe(4);
      // total spawns: 4 lead + skeleton critic + solo audit + B critic = 7
      // (if per-task: would be much higher for 5 tasks)
      expect(transport.spawnCalls.length).toBeLessThan(10);
      expect(transport.spawnCalls.length).toBe(7);
    });

    it('escalation on hard-ESCALATE promotes solo → pair and re-authors at B', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01'],
        tasks: [sk('T01', 'Looks solo but is not', 'solo', { req_refs: ['R-01'] })],
      };
      const res = await runAdaptivePlanningPhase(
        { transport, artifacts: art, taskQueue: queue },
        {
          runDir,
          northStar: 'Escalation path.',
          batchId: 'batch-escalate',
          fixture: {
            skeleton,
            critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            soloAudit: {
              verdict: 'ESCALATE',
              severity: 'hard',
              reasons: ['unsafe_solo'],
            },
            bCritique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
          },
        },
      );
      expect(res.agreed).toBe(true);
      expect(res.keyToId['T01']).toBeTypeOf('number');
      // After solo escalate, B authoring should have run → extra lead spawn for B
      const leadSpawns = transport.spawnCalls.filter((s) => s.role === 'lead_planner');
      // skeleton + solo + B + integrate
      expect(leadSpawns.length).toBeGreaterThanOrEqual(4);
    });

    it('A-path: parallel panel seats (Promise.all) — spawn count = seats, not tasks', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01', 'R-02'],
        tasks: [
          sk('A1', 'Panel task one', 'panel', { req_refs: ['R-01'], affinity: 'core' }),
          sk('A2', 'Panel task two', 'panel', { req_refs: ['R-02'], affinity: 'core' }),
        ],
      };
      await runAdaptivePlanningPhase(
        { transport, artifacts: art, taskQueue: queue },
        {
          runDir,
          northStar: 'Cross-cutting panel work.',
          batchId: 'batch-panel-parallel',
          panel: { size: 2 },
          fixture: {
            skeleton,
            critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
          },
        },
      );
      // A cluster: 2 parallel seats for 2 tasks (batch, not 2 sequential per-task * seats)
      // plus skeleton lead + critic + integrator
      const panelistSpawns = transport.spawnCalls.filter((s) => s.role === 'panelist');
      // skeleton critic (1) + A seat 1 (panelist) = at least 1 panelist; seat 0 is lead_planner
      expect(panelistSpawns.length).toBeGreaterThanOrEqual(1);
      // Must NOT spawn one seat per task per round sequentially as 4+ for 2 tasks
      // total spawns: skeleton lead, skeleton critic, 2 A seats, integrator = 5
      expect(transport.spawnCalls.length).toBe(5);
    });

    it('deadlock without settle-pair → PLAN_BLOCK', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01'],
        tasks: [sk('A1', 'Contested task', 'panel', { req_refs: ['R-01'], affinity: 'core' })],
      };
      await expect(
        runAdaptivePlanningPhase(
          { transport, artifacts: art, taskQueue: queue },
          {
            runDir,
            northStar: 'Deadlock case.',
            batchId: 'batch-deadlock',
            panel: { size: 2 },
            fixture: {
              skeleton,
              critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
              forceDeadlock: true,
              settleTasks: undefined,
            },
          },
        ),
      ).rejects.toBeInstanceOf(AdaptivePlanningBlockedError);
    });

    it('deadlock + settle-pair → PLAN_SETTLE and ingest succeeds', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01'],
        tasks: [sk('A1', 'Contested task', 'panel', { req_refs: ['R-01'], affinity: 'core' })],
      };
      const settled = skeletonToAuthoredTasks(skeleton.tasks);
      settled[0].title = 'Settled by pair';
      const res = await runAdaptivePlanningPhase(
        { transport, artifacts: art, taskQueue: queue },
        {
          runDir,
          northStar: 'Settle case.',
          batchId: 'batch-settle',
          panel: { size: 2 },
          fixture: {
            skeleton,
            critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            forceDeadlock: true,
            settleTasks: settled,
          },
        },
      );
      expect(res.agreed).toBe(true);
      expect(res.keyToId['A1']).toBeTypeOf('number');
    });

    it('skeleton gate failure blocks before any tier authoring', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-MISSING'],
        tasks: [sk('T01', 'Unrelated', 'solo', { req_refs: ['R-01'] })],
      };
      await expect(
        runAdaptivePlanningPhase(
          { transport, artifacts: art, taskQueue: queue },
          {
            runDir,
            northStar: 'Gate fail.',
            batchId: 'batch-gate-fail',
            fixture: {
              skeleton,
              critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            },
          },
        ),
      ).rejects.toThrow(/PLAN_SKELETON_GATE failed/);
      // Only skeleton lead + critic — no solo/B/integrate
      expect(transport.spawnCalls.length).toBe(2);
    });

    it('emits ADAPTIVE_PLAN_EVENTS telemetry names (path B)', () => {
      expect(ADAPTIVE_PLAN_EVENTS.SKELETON_GATE).toBe('PLAN_SKELETON_GATE');
      expect(ADAPTIVE_PLAN_EVENTS.TIER_ROUTED).toBe('PLAN_TIER_ROUTED');
      expect(ADAPTIVE_PLAN_EVENTS.TIER_ESCALATED).toBe('PLAN_TIER_ESCALATED');
      expect(ADAPTIVE_PLAN_EVENTS.SETTLE).toBe('PLAN_SETTLE');
      expect(ADAPTIVE_PLAN_EVENTS.BLOCK).toBe('PLAN_BLOCK');
      expect(ADAPTIVE_PLAN_EVENTS.STAGE_TOKENS).toBe('PLAN_STAGE_TOKENS');
    });

    it('F1: after backup swap, non-lead spawn provider matches resolved memberProviders (not partnerProvider)', async () => {
      // Seat 1 primary is codex; backup is claude. Availability probe fails codex → swap to claude.
      // inputs.partnerProvider stays 'codex' (the pre-panel hardcoded path) — spawns must NOT use it.
      const skeleton: PlanSkeleton = {
        requirements: ['R-01', 'R-02'],
        tasks: [
          sk('T01', 'Solo with audit panelist', 'solo', { req_refs: ['R-01'] }),
          sk('T02', 'Pair with critic panelist', 'pair', { req_refs: ['R-02'], deps: ['T01'] }),
        ],
      };
      await runAdaptivePlanningPhase(
        { transport, artifacts: art, taskQueue: queue },
        {
          runDir,
          northStar: 'Backup provider pairing.',
          batchId: 'batch-f1-provider',
          planningBrainModel: 'grok-4.5',
          planningBrainProvider: 'grok',
          partnerModel: 'gpt-5.3-codex',
          partnerProvider: 'codex', // intentional trap: must not be used after claude backup swap
          panel: {
            size: 2,
            leadModel: 'grok-4.5',
            leadProvider: 'grok',
            memberModels: ['grok-4.5', 'gpt-5.3-codex'],
            memberProviders: ['grok', 'codex'],
            backups: [{ model: 'claude-opus-4-8', provider: 'claude' }],
            defaultEffort: 'med',
          },
          isModelAvailable: (provider, model) => {
            if (provider === 'codex' && model === 'gpt-5.3-codex') return false;
            return true;
          },
          fixture: {
            skeleton,
            critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            soloAudit: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            bCritique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
          },
        },
      );
      const panelistSpawns = transport.spawnCalls.filter((s) => s.role === 'panelist');
      expect(panelistSpawns.length).toBeGreaterThanOrEqual(1);
      for (const s of panelistSpawns) {
        expect(s.model).toBe('claude-opus-4-8');
        expect(s.provider).toBe('claude'); // not inputs.partnerProvider 'codex'
      }
      // Lead still on grok
      const leadSpawns = transport.spawnCalls.filter((s) => s.role === 'lead_planner');
      for (const s of leadSpawns) {
        expect(s.model).toBe('grok-4.5');
        expect(s.provider).toBe('grok');
      }
    });

    it('F2: per-slot and default effort are passed to transport.spawn', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01', 'R-02'],
        tasks: [
          sk('T01', 'Solo with audit', 'solo', { req_refs: ['R-01'] }),
          sk('T02', 'Pair with critic', 'pair', { req_refs: ['R-02'], deps: ['T01'] }),
        ],
      };
      await runAdaptivePlanningPhase(
        { transport, artifacts: art, taskQueue: queue },
        {
          runDir,
          northStar: 'Effort threading.',
          batchId: 'batch-f2-effort',
          planningBrainModel: 'grok-4.5',
          planningBrainProvider: 'grok',
          partnerModel: 'gpt-5.3-codex',
          partnerProvider: 'codex',
          panel: {
            size: 2,
            leadModel: 'grok-4.5',
            leadProvider: 'grok',
            memberModels: ['grok-4.5', 'gpt-5.3-codex'],
            memberProviders: ['grok', 'codex'],
            // seat 0 override high; seat 1 inherits panel default xhigh via memberEfforts
            memberEfforts: ['high', 'xhigh'],
            defaultEffort: 'xhigh',
          },
          fixture: {
            skeleton,
            critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            soloAudit: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            bCritique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
          },
        },
      );
      const leadSpawns = transport.spawnCalls.filter((s) => s.role === 'lead_planner');
      expect(leadSpawns.length).toBeGreaterThanOrEqual(1);
      for (const s of leadSpawns) {
        expect(s.effort).toBe('high');
      }
      const panelistSpawns = transport.spawnCalls.filter((s) => s.role === 'panelist');
      expect(panelistSpawns.length).toBeGreaterThanOrEqual(1);
      for (const s of panelistSpawns) {
        expect(s.effort).toBe('xhigh');
      }
    });
  });

  // -------------------------------------------------------------------------
  // Real path (!USE_FAKE_TMUX): driver purity — no prose synthesis; settle-pair spawn
  // -------------------------------------------------------------------------
  describe('real path driver purity (F1/F2)', () => {
    /** Minimal transport that works outside USE_FAKE_TMUX (FakeTransport refuses). */
    class StubTransport {
      public readonly spawnCalls: Array<{ role: string; brief: string; model?: string; batchId?: string }> = [];
      private n = 1;
      private onSpawn?: (params: { role: string; brief: string; model?: string; runDir: string; batchId?: string }) => Promise<void> | void;

      constructor(onSpawn?: StubTransport['onSpawn']) {
        this.onSpawn = onSpawn;
      }

      async spawn(params: {
        role: string;
        brief: string;
        runDir: string;
        batchId?: string;
        model?: string;
        provider?: string;
        attemptId?: number;
        projectDir?: string;
        strictReadAllow?: string[];
      }): Promise<{ handle: string; role: string }> {
        this.spawnCalls.push({
          role: params.role,
          brief: params.brief,
          model: params.model,
          batchId: params.batchId,
        });
        if (this.onSpawn) await this.onSpawn(params);
        return { handle: `stub-${params.role}-${this.n++}`, role: params.role };
      }

      async reap(_handle: string, _reason?: string): Promise<void> { /* no-op */ }
    }

    let runDir: string;
    let tmpDb: string;
    let dbs: DatabaseService;
    let art: RunArtifactService;
    let queue: TaskQueueService;
    let prevFake: string | undefined;
    let prevTimeout: string | undefined;

    beforeEach(async () => {
      prevFake = process.env.USE_FAKE_TMUX;
      prevTimeout = process.env.HELM_PLANNING_TIMEOUT_MS;
      // Real path: not fake, short poll so missing-author tests finish quickly
      delete process.env.USE_FAKE_TMUX;
      process.env.HELM_PLANNING_TIMEOUT_MS = '120';

      runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-adaptive-real-'));
      await fs.writeFile(path.join(runDir, 'callbacks.md'), '# cbs\n', 'utf8');
      tmpDb = path.join(os.tmpdir(), `helm-adaptive-real-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
      dbs = new DatabaseService(tmpDb);
      art = new RunArtifactService(dbs);
      queue = new TaskQueueService(art);
    });

    afterEach(async () => {
      if (prevFake === undefined) delete process.env.USE_FAKE_TMUX;
      else process.env.USE_FAKE_TMUX = prevFake;
      if (prevTimeout === undefined) delete process.env.HELM_PLANNING_TIMEOUT_MS;
      else process.env.HELM_PLANNING_TIMEOUT_MS = prevTimeout;
      try { dbs.close(); } catch { /* */ }
      await fs.rm(tmpDb, { force: true }).catch(() => {});
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    });

    it('F1: real-path missing authored output → PLAN_BLOCK (never synthesizes task prose)', async () => {
      const transport = new StubTransport();
      const skeleton: PlanSkeleton = {
        requirements: ['R-01'],
        tasks: [sk('T01', 'Solo that agent never wrote', 'solo', { req_refs: ['R-01'] })],
      };
      // Fixture supplies skeleton/critiques only — no authored-solo.json is ever written by transport
      await expect(
        runAdaptivePlanningPhase(
          { transport: transport as any, artifacts: art, taskQueue: queue },
          {
            runDir,
            northStar: 'Missing author case.',
            batchId: 'batch-real-missing-author',
            fixture: {
              skeleton,
              critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
              // Intentionally omit soloAudit injection path for authored file:
              // real path still needs authored-solo.json from the agent.
            },
          },
        ),
      ).rejects.toSatisfy((err: unknown) => {
        expect(err).toBeInstanceOf(AdaptivePlanningBlockedError);
        expect(String((err as Error).message)).toMatch(/PLAN_BLOCK.*missing authored/i);
        expect(String((err as Error).message)).toMatch(/T01/);
        expect(String((err as Error).message)).not.toMatch(/Implements:/);
        return true;
      });
      // No authored-solo.json may be synthesized by plancore
      await expect(
        fs.access(path.join(runDir, 'adaptive', 'authored-solo.json')),
      ).rejects.toThrow();
    });

    it('F2: real-path A deadlock spawns named settle-pair then resolves from their artifact', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01'],
        tasks: [sk('A1', 'Contested task', 'panel', { req_refs: ['R-01'], affinity: 'core' })],
      };
      const draftA: AuthoredTask[] = skeletonToAuthoredTasks(skeleton.tasks, 'A-core');
      draftA[0].title = 'Seat 0 title';
      const draftB: AuthoredTask[] = skeletonToAuthoredTasks(skeleton.tasks, 'A-core');
      draftB[0].title = 'Seat 1 title';
      const settled: AuthoredTask[] = skeletonToAuthoredTasks(skeleton.tasks, 'A-core');
      settled[0].title = 'Settled by real settle-pair';

      const transport = new StubTransport(async (params) => {
        // When settle-pair is convened, write the settle artifact (models author; not plancore)
        if (/A-core-settle-\d+$/.test(params.batchId || '')) {
          const out = path.join(runDir, 'adaptive', 'authored-A-core-settle.json');
          await fs.mkdir(path.dirname(out), { recursive: true });
          await fs.writeFile(out, JSON.stringify(settled, null, 2), 'utf8');
        }
      });

      const res = await runAdaptivePlanningPhase(
        { transport: transport as any, artifacts: art, taskQueue: queue },
        {
          runDir,
          northStar: 'Real settle case.',
          batchId: 'batch-real-settle',
          panel: {
            size: 2,
            leadModel: 'planner_01',
            memberModels: ['planner_01', 'planner_02'],
          },
          fixture: {
            skeleton,
            critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
            forceDeadlock: true,
            aDrafts: [draftA, draftB],
            // NO settleTasks — real path must spawn settle-pair
          },
        },
      );

      expect(res.agreed).toBe(true);
      expect(res.keyToId['A1']).toBeTypeOf('number');

      // batchId suffix is `...-A-<affinity>-settle-<seat>` (not the parent batch name)
      const settleSpawns = transport.spawnCalls.filter(
        (s) => /A-core-settle-\d+$/.test(s.batchId || ''),
      );
      expect(settleSpawns.length).toBe(2);
      const settleModels = settleSpawns.map((s) => s.model).sort();
      expect(settleModels).toEqual(['planner_01', 'planner_02']);
      // Brief must instruct settle-pair (not plancore inventing titles)
      expect(settleSpawns[0].brief).toMatch(/settle-pair/i);
      expect(settleSpawns[0].brief).toMatch(/authored-A-core-settle\.json/);
    });

    it('F2: real-path A deadlock with no settle artifact → PLAN_BLOCK', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01'],
        tasks: [sk('A1', 'Contested task', 'panel', { req_refs: ['R-01'], affinity: 'core' })],
      };
      const draftA: AuthoredTask[] = skeletonToAuthoredTasks(skeleton.tasks, 'A-core');
      draftA[0].title = 'Seat 0 title';
      const draftB: AuthoredTask[] = skeletonToAuthoredTasks(skeleton.tasks, 'A-core');
      draftB[0].title = 'Seat 1 title';

      const transport = new StubTransport(); // never writes settle artifact

      await expect(
        runAdaptivePlanningPhase(
          { transport: transport as any, artifacts: art, taskQueue: queue },
          {
            runDir,
            northStar: 'Real settle miss.',
            batchId: 'batch-real-settle-miss',
            panel: {
              size: 2,
              leadModel: 'planner_01',
              memberModels: ['planner_01', 'planner_02'],
            },
            fixture: {
              skeleton,
              critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
              forceDeadlock: true,
              aDrafts: [draftA, draftB],
            },
          },
        ),
      ).rejects.toBeInstanceOf(AdaptivePlanningBlockedError);

      // Settle-pair was still convened (spawned) before BLOCK on missing output
      const settleSpawns = transport.spawnCalls.filter(
        (s) => /A-core-settle-\d+$/.test(s.batchId || ''),
      );
      expect(settleSpawns.length).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // Backward-compat: OFF == existing path (FIX 7)
  // -------------------------------------------------------------------------
  describe('backward-compat OFF path', () => {
    let runDir: string;
    let transport: FakeTransport;
    let tmpDb: string;
    let dbs: DatabaseService;
    let art: RunArtifactService;
    let queue: TaskQueueService;
    let phase: PlanningPhaseService;

    beforeEach(async () => {
      runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-adaptive-off-'));
      await fs.writeFile(path.join(runDir, 'callbacks.md'), '# cbs\n', 'utf8');
      transport = new FakeTransport();
      tmpDb = path.join(os.tmpdir(), `helm-adaptive-off-${Date.now()}.db`);
      dbs = new DatabaseService(tmpDb);
      art = new RunArtifactService(dbs);
      queue = new TaskQueueService(art);
      phase = new PlanningPhaseService(transport, art, queue);
    });

    afterEach(async () => {
      try { dbs.close(); } catch { /* */ }
      await fs.rm(tmpDb, { force: true }).catch(() => {});
      await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    });

    it('OFF (default) uses existing single-author path — not adaptive spawns', async () => {
      const pending = phase.runPlanningPhase({
        runDir,
        batchId: 'batch-off-compat',
        northStar: 'Simple single-module feature: add a date formatter.',
        conversationLog: 'clear scope',
        mode: 'planner',
        // adaptivePlanning intentionally omitted / false
      });
      await fs.appendFile(
        path.join(runDir, 'callbacks.md'),
        '[helm callback] plancore batch-off-compat STATUS: PLAN-READY — fixture\n',
      );
      const res = await pending;
      expect(res.agreed).toBe(true);
      // Existing path spawns plancore (brainRole), never lead_planner
      const roles = transport.spawnCalls.map((s) => s.role);
      expect(roles).toContain('plancore');
      expect(roles).not.toContain('lead_planner');
    });

    it('ON delegates to adaptive module (lead_planner spawns)', async () => {
      const skeleton: PlanSkeleton = {
        requirements: ['R-01'],
        tasks: [sk('T01', 'Adaptive only task', 'solo', { req_refs: ['R-01'] })],
      };
      const res = await phase.runPlanningPhase({
        runDir,
        batchId: 'batch-on-adaptive',
        northStar: 'Adaptive on.',
        mode: 'planner',
        adaptivePlanning: true,
        fixture: {
          skeleton,
          critique: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
          soloAudit: { verdict: 'ACCEPT', severity: 'soft', reasons: [] },
        },
      } as any);
      expect(res.agreed).toBe(true);
      const roles = transport.spawnCalls.map((s) => s.role);
      expect(roles).toContain('lead_planner');
    });
  });
});
