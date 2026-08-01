/**
 * P1 (R1.2/R1.3): no model call for plancore during initial whole-plan authoring.
 *
 * B4 already deleted generatePlanningBrief (plancore's brief content). P1 finishes the job: the
 * plancore spawn-retry loop and its writeBrief authoring-seat calls are retired from
 * runPlanningPhase entirely — ROUND (runReviewRound) is the only spawner now, and the engine hands
 * it the context paths (north-star.md / conversation-log.md) it already resolved, rather than
 * relying on a plancore seat to have authored/read them first.
 *
 * R1.3: the `brainRole` / 'plancore' LABEL is untouched — logs, staffing (S05/S06), topology, and the
 * waitForAgreement callback grammar (which still keys off `brainRole` for its PLAN-READY check) all
 * keep referring to 'plancore'. Only the spawn/writeBrief call itself is gone, so every test here
 * still hand-feeds a `[helm callback] plancore ... STATUS: PLAN-READY` line the same way the sibling
 * planning-phase-service.test.ts suite does — that mechanism is untouched by this slice.
 */
process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';
import { planRevision } from './plan-revision.js';
import type { RunReviewRoundOptions } from './planning-review-round.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function canonicalPlanMd(tasks: unknown[]): string {
  return `# Plan\n\n\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\`\n`;
}

// Captures the options runPlanningPhase hands to runReviewRound, while still delegating to the real
// implementation — proves the engine actually WIRES contextInputPaths through, not just that the
// phase happens to still function (which it would even if this slice forgot to pass them, since
// contextInputPaths is optional on RunReviewRoundOptions).
let capturedRoundOptions: RunReviewRoundOptions | null = null;
vi.mock('./planning-review-round.js', async (importActual) => {
  const actual = await importActual<typeof import('./planning-review-round.js')>();
  return {
    ...actual,
    runReviewRound: async (opts: RunReviewRoundOptions) => {
      capturedRoundOptions = opts;
      return actual.runReviewRound(opts);
    },
  };
});

describe('P1 (R1.2/R1.3): plancore is never spawned during initial whole-plan authoring', () => {
  let runDir: string;
  let transport: FakeTransport;
  let tmpDb: string;
  let dbs: DatabaseService;
  let art: RunArtifactService;
  let queue: TaskQueueService;
  let phase: PlanningPhaseService;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-p1-no-plancore-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# P1 planning callbacks\n', 'utf8');
    transport = new FakeTransport();
    tmpDb = path.join(os.tmpdir(), `helm-p1-no-plancore-${Date.now()}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    phase = new PlanningPhaseService(transport, art, queue);
    capturedRoundOptions = null;
  });

  afterEach(async () => {
    if (dbs) dbs.close();
    if (tmpDb) await fs.rm(tmpDb, { force: true }).catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('spawns only the partner seat — no transport.spawn call is ever made for the plancore/brainRole seat', async () => {
    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-P1-no-spawn',
      northStar: 'Add a small utility function to format dates.',
      conversationLog: 'clear scope, no cross module risk.',
      mode: 'planner',
    });
    const cbp = path.join(runDir, 'callbacks.md');
    // Still hand-fed: R1.2 removes the plancore SPAWN, not waitForAgreement's own PLAN-READY check
    // (that gate is untouched by this slice — P3 is the row that revisits it).
    await fs.appendFile(cbp, `[helm callback] plancore batch-P1-no-spawn STATUS: PLAN-READY — plan.json written\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] planner batch-P1-no-spawn-partner STATUS: VERDICT-READY — CLEAN: clean\n`);

    const res = await p;
    expect(res.agreed).toBe(true);
    expect(transport.spawnCalls.length).toBe(1);
    expect(transport.spawnCalls[0].role).toBe('planner');
    expect(transport.spawnCalls[0].batchId).toBe('batch-P1-no-spawn-partner');
    expect(transport.spawnCalls.some((s) => s.role === 'plancore')).toBe(false);
  });

  it('never writes prompts/plancore.brief.md — the authoring-seat writeBrief call is retired', async () => {
    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-P1-no-brief',
      northStar: 'Add a small utility function to format dates.',
      conversationLog: 'clear scope, no cross module risk.',
      mode: 'planner',
    });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] plancore batch-P1-no-brief STATUS: PLAN-READY — plan.json written\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] planner batch-P1-no-brief-partner STATUS: VERDICT-READY — CLEAN: clean\n`);
    const res = await p;
    expect(res.agreed).toBe(true);

    await expect(fs.access(path.join(runDir, 'prompts', 'plancore.brief.md'))).rejects.toThrow();
    // The partner's own brief IS still written under its writeBrief key — proves 'prompts' itself
    // isn't just missing wholesale (e.g. never created).
    await expect(fs.access(path.join(runDir, 'prompts', 'planner.brief.md'))).resolves.toBeUndefined();
  });

  it('never registers a plancore worker_runtimes row, even with projectId/runId wired end to end', async () => {
    const projRow = dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get('p1-no-plancore-proj', '/tmp/p1-no-plancore-proj') as { id: number };
    const cycleRow = dbs.raw.prepare(
      `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
       VALUES (?, ?, ?, 'planning', 'autonomous_after_discovery', 'active') RETURNING id`
    ).get(projRow.id, 'P1 cycle', 'p1-cycle') as { id: number };
    const runRow = dbs.raw.prepare(
      `INSERT INTO runs (project_id, cycle_id, batch_id, phase) VALUES (?, ?, ?, 'planning') RETURNING id`
    ).get(projRow.id, cycleRow.id, 'batch-P1-worker-runtimes') as { id: number };

    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-P1-worker-runtimes',
      northStar: 'Add a small utility function to format dates.',
      conversationLog: 'clear scope, no cross module risk.',
      mode: 'planner',
      projectId: projRow.id,
      runId: runRow.id,
    });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] plancore batch-P1-worker-runtimes STATUS: PLAN-READY — plan.json written\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] planner batch-P1-worker-runtimes-partner STATUS: VERDICT-READY — CLEAN: clean\n`);
    const res = await p;
    expect(res.agreed).toBe(true);

    const rows = dbs.raw.prepare(
      `SELECT role, correlation_id FROM worker_runtimes WHERE run_id = ? ORDER BY id`
    ).all(runRow.id) as Array<{ role: string; correlation_id: string }>;
    expect(rows.length).toBe(1);
    expect(rows[0].role).toBe('planner');
    expect(rows.some((r) => r.role === 'plancore')).toBe(false);
  });

  it('hands ROUND the engine-resolved context paths (north-star.md, conversation-log.md) via contextInputPaths', async () => {
    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-P1-context-paths',
      northStar: 'Add a small utility function to format dates.',
      conversationLog: 'clear scope, no cross module risk.',
      mode: 'planner',
    });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] plancore batch-P1-context-paths STATUS: PLAN-READY — plan.json written\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] planner batch-P1-context-paths-partner STATUS: VERDICT-READY — CLEAN: clean\n`);
    await p;

    expect(capturedRoundOptions).not.toBeNull();
    expect(capturedRoundOptions!.contextInputPaths).toEqual([
      path.join(runDir, 'north-star.md'),
      path.join(runDir, 'conversation-log.md'),
    ]);
  });

  // Real (!isFake) mode: proves the round-1 pre-spawn gate (checkRound1PreSpawn) genuinely accepts
  // the context paths the engine wrote from inputs.northStar/conversationLog — no plancore seat ever
  // authored or even read them first. A wrong/omitted contextInputPaths wiring would surface here as
  // blockedReasonKind 'artifact-not-published', not as a hang.
  it('real mode: engine-written context paths satisfy ROUND without any plancore seat authoring them', async () => {
    const origFake = process.env.USE_FAKE_TMUX;
    const origPlanTo = process.env.HELM_PLANNING_TIMEOUT_MS;
    process.env.USE_FAKE_TMUX = '0';
    process.env.HELM_PLANNING_TIMEOUT_MS = '8000';
    try {
      const planMd = canonicalPlanMd([{
        id: 'P1RM-1', batch: 'B1', title: 'Real-mode no-plancore-author proof', req_refs: ['P1RM-R1'],
        assignee: 'L1', validator_lane: 'L1', effort: 'low', type: 'feature', deps: [],
        validation_criteria: 'engine context paths satisfy the round without a plancore seat',
      }]);
      // Written directly, as a co-planner (not plancore) would under the redesigned flow — proves the
      // round never needed a plancore-authored copy of these to proceed.
      await fs.writeFile(path.join(runDir, 'og-requirements.md'), '- **P1RM-R1** — real-mode proof.\n', 'utf8');
      await fs.writeFile(path.join(runDir, 'plan.md'), planMd, 'utf8');
      const short12 = planRevision(planMd).short12;

      const p = phase.runPlanningPhase({
        runDir,
        batchId: 'batch-P1-real-context',
        northStar: 'Real-mode context-path wiring proof.',
        conversationLog: 'Single atomic real-mode check.',
        mode: 'planner',
      });
      const cbp = path.join(runDir, 'callbacks.md');
      await fs.appendFile(cbp, `[helm callback] planner batch-P1-real-context-partner STATUS: VERDICT-READY — CLEAN plan=${short12} real-mode agree\n`);
      await sleep(5);
      await fs.appendFile(cbp, `[helm callback] plancore batch-P1-real-context STATUS: PLAN-READY — plan.json present\n`);

      const res = await p;
      expect(res.agreed).toBe(true);
      expect(res.blockedReasonKind).toBeUndefined();
      expect(res.plan.tasks[0].task_key).toBe('P1RM-1');
      expect(transport.spawnCalls.some((s) => s.role === 'plancore')).toBe(false);
      expect(transport.spawnCalls.length).toBe(1);

      // The engine wrote these itself (from inputs.northStar/conversationLog) before ROUND ever ran.
      expect(await fs.readFile(path.join(runDir, 'north-star.md'), 'utf8')).toBe('Real-mode context-path wiring proof.');
      expect(await fs.readFile(path.join(runDir, 'conversation-log.md'), 'utf8')).toBe('Single atomic real-mode check.');
    } finally {
      process.env.USE_FAKE_TMUX = origFake || '1';
      if (origPlanTo === undefined) { delete (process.env as any).HELM_PLANNING_TIMEOUT_MS; } else { process.env.HELM_PLANNING_TIMEOUT_MS = origPlanTo; }
    }
  }, 15000);
});
