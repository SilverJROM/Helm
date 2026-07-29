/**
 * S06 — Core Planning consumes exact S05 co-planner seat identities.
 * ACs 19, 21, 25-26.
 */
process.env.USE_FAKE_TMUX = '1';
process.env.NODE_ENV = 'test';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './services/fake-transport.js';
import { PlanningPhaseService } from './services/planning-phase-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { TaskQueueService } from './services/task-queue-service.js';
import { DatabaseService } from './db/database.js';
import {
  toCorePlanningStaffingArgs,
  type PlanningStaffingManifest,
} from './services/planning-staffing-service.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('S06 core Planning co-planner seats', () => {
  let runDir: string;
  let transport: FakeTransport;
  let tmpDb: string;
  let dbs: DatabaseService;
  let art: RunArtifactService;
  let queue: TaskQueueService;
  let phase: PlanningPhaseService;
  let prevTimeout: string | undefined;

  beforeEach(async () => {
    prevTimeout = process.env.HELM_PLANNING_TIMEOUT_MS;
    process.env.HELM_PLANNING_TIMEOUT_MS = '400';
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-s06-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# S06\n', 'utf8');
    transport = new FakeTransport();
    tmpDb = path.join(os.tmpdir(), `helm-s06-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    phase = new PlanningPhaseService(transport, art, queue);
  });

  afterEach(async () => {
    if (prevTimeout === undefined) delete process.env.HELM_PLANNING_TIMEOUT_MS;
    else process.env.HELM_PLANNING_TIMEOUT_MS = prevTimeout;
    try {
      dbs.close();
    } catch {
      /* ignore */
    }
    await fs.rm(tmpDb, { force: true }).catch(() => {});
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  const twoSeats = [
    { slot: 0, provider: 'claude', model: 'claude-opus-4-8', effort: 'high', source: 'primary' },
    { slot: 1, provider: 'codex', model: 'gpt-5.3-codex', effort: 'med', source: 'primary' },
  ];

  it('AC19/21/25: plancore + two distinct configured co-planner identities on spawn', async () => {
    const batchId = 's06-two-seats';
    const cbp = path.join(runDir, 'callbacks.md');
    const p = phase.runPlanningPhase({
      runDir,
      batchId,
      northStar: 'Add a small utility function to format dates.',
      conversationLog: 'clear scope',
      mode: 'auto',
      planningBrainModel: 'grok-4.5',
      planningBrainProvider: 'grok',
      brainRole: 'plancore',
      coPlannerSeats: twoSeats,
      // partnerModel deliberately wrong — must not be used when coPlannerSeats present
      partnerModel: 'gpt-5.5',
      partnerProvider: 'codex',
      panelSize: 99, // ignored for count when coPlannerSeats set
    });

    await sleep(40);
    // 1 plancore + 2 partners
    const plannerSpawns = transport.spawnCalls.filter((s) => s.role === 'planner');
    const plancoreSpawns = transport.spawnCalls.filter((s) => s.role === 'plancore' || s.role === 'helm_pm');
    // brain may be plancore
    expect(transport.spawnCalls.length).toBeGreaterThanOrEqual(3);
    expect(plannerSpawns.length).toBe(2);
    expect(plannerSpawns.map((s) => s.model).sort()).toEqual(
      ['claude-opus-4-8', 'gpt-5.3-codex'].sort()
    );
    expect(plannerSpawns.map((s) => s.provider).sort()).toEqual(['claude', 'codex'].sort());
    expect(plannerSpawns.every((s) => s.model !== 'gpt-5.5')).toBe(true);

    await fs.appendFile(
      cbp,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan written\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: clean\n` +
        `[helm callback] planner ${batchId}-partner-2 STATUS: VERDICT-READY — CLEAN: clean\n`
    );

    const res = await p;
    expect(res.agreed).toBe(true);
    void plancoreSpawns;
  });

  it('AC26: PLAN-READY + only one CLEAN cannot pass a two-partner gate', async () => {
    const batchId = 's06-one-clean';
    const cbp = path.join(runDir, 'callbacks.md');
    process.env.HELM_PLANNING_TIMEOUT_MS = '250';
    const p = phase.runPlanningPhase({
      runDir,
      batchId,
      northStar: 'Add a small utility function to format dates.',
      conversationLog: 'clear scope',
      mode: 'auto',
      coPlannerSeats: twoSeats,
      planningBrainModel: 'grok-4.5',
      planningBrainProvider: 'grok',
      roundCap: 1,
    });

    await fs.appendFile(
      cbp,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan written\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: clean\n`
      // partner-2 missing
    );

    const res = await p;
    expect(res.agreed).toBe(false);
    expect(transport.spawnCalls.filter((s) => s.role === 'planner').length).toBe(2);
  });

  it('AC26: BROKEN second partner at round cap blocks without agreed ingest', async () => {
    const batchId = 's06-broken-second';
    const cbp = path.join(runDir, 'callbacks.md');
    process.env.HELM_PLANNING_TIMEOUT_MS = '250';
    const p = phase.runPlanningPhase({
      runDir,
      batchId,
      northStar: 'Add a small utility function to format dates.',
      conversationLog: 'clear scope',
      mode: 'auto',
      coPlannerSeats: twoSeats,
      planningBrainModel: 'grok-4.5',
      planningBrainProvider: 'grok',
      roundCap: 1,
    });

    await fs.appendFile(
      cbp,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan written\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: clean\n` +
        `[helm callback] planner ${batchId}-partner-2 STATUS: VERDICT-READY — BROKEN: gaps\n`
    );

    const res = await p;
    expect(res.agreed).toBe(false);
    // Fake path may still synthesize a plan object; agreed=false is the gate.
    // createdTaskIds should be empty when not agreed (no ingest handoff).
    expect(res.createdTaskIds?.length ?? 0).toBe(0);
  });

  it('toCorePlanningStaffingArgs exposes ordered coPlannerSeats for orchestrator', () => {
    const manifest = {
      projectId: 1,
      adaptivePlanning: false,
      planningPanelSize: 2,
      panelMemberCount: 2,
      plancore: {
        slot: null,
        role: 'plancore' as const,
        provider: 'grok',
        model: 'grok-4.5',
        modelRowId: null,
        effort: 'high' as const,
        source: 'phase-owner' as const,
        ready: true,
        blockReason: null,
      },
      coPlanners: [
        {
          slot: 0,
          role: 'co-planner' as const,
          provider: 'claude',
          model: 'claude-opus-4-8',
          modelRowId: 1,
          effort: 'high' as const,
          source: 'primary' as const,
          ready: true,
          blockReason: null,
        },
        {
          slot: 1,
          role: 'co-planner' as const,
          provider: 'codex',
          model: 'gpt-5.3-codex',
          modelRowId: 2,
          effort: 'med' as const,
          source: 'primary' as const,
          ready: true,
          blockReason: null,
        },
      ],
      blocked: false,
      blockReasons: [] as string[],
      digest: 'abc',
    } satisfies PlanningStaffingManifest;

    const args = toCorePlanningStaffingArgs(manifest);
    expect(args.coPlannerSeats).toHaveLength(2);
    expect(args.coPlannerSeats![0].model).toBe('claude-opus-4-8');
    expect(args.coPlannerSeats![1].model).toBe('gpt-5.3-codex');
    expect(args.panelSizeTotal).toBe(3);
  });
});
