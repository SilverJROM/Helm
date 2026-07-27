import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { PlanParserService } from './services/plan-parser-service.js';
import { PlanningPhaseService } from './services/planning-phase-service.js';
import { TaskQueueService } from './services/task-queue-service.js';
import { FakeTransport } from './services/fake-transport.js';
import { ProjectService } from './services/project-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { RunOrchestratorService } from './services/run-orchestrator-service.js';
import { EscalationService } from './services/escalation-service.js';
import { PanelService } from './services/panel-service.js';
import { CycleService } from './services/cycle-service.js';

/**
 * A5 / R3.13 — production finishPlanning at planning-done.
 * 1) discovery → planning → implementation with no manual row patch (via startRun)
 * 2) second finishPlanning call does not fail the run (N7 CONFLICT swallowed)
 */

function makeDeployRunner() {
  return {
    async runDeploy() {
      return { success: true, note: 'fake-deploy-ok' };
    },
  };
}

function makeFinalTestRunner() {
  return {
    async runTest() {
      return { success: true, note: 'fake-test-ok' };
    },
  };
}

describe.sequential('A5 R3.13 finishPlanning in production at planning-done', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let artifacts: RunArtifactService;
  let parser: PlanParserService;
  let queue: TaskQueueService;
  let fakeT: FakeTransport;
  let projectSvc: ProjectService;
  let assignSvc: AgentAssignmentService;
  let planning: PlanningPhaseService;
  let orch: RunOrchestratorService;
  let cycleSvc: CycleService;
  let projDir: string;

  beforeEach(async () => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
    tmpDb = path.join(os.tmpdir(), `helm-a5-fp-${Date.now()}.db`);
    db = new DatabaseService(tmpDb);
    artifacts = new RunArtifactService(db);
    parser = new PlanParserService(artifacts);
    queue = new TaskQueueService(artifacts);
    fakeT = new FakeTransport();
    projectSvc = new ProjectService(db);
    assignSvc = new AgentAssignmentService(db);
    planning = new PlanningPhaseService(fakeT, artifacts, queue);
    cycleSvc = new CycleService(db, projectSvc);
    projDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'helm-a5-proj-'));

    orch = new RunOrchestratorService({
      artifacts,
      planning,
      parser,
      queue,
      transport: fakeT,
      projectService: projectSvc,
      assignmentService: assignSvc,
      escalationService: new EscalationService(db),
      panelService: new PanelService(fakeT, artifacts, 'a5test'),
      deployRunner: makeDeployRunner(),
      finalTestRunner: makeFinalTestRunner(),
      cycleService: cycleSvc,
    });
  });

  afterEach(async () => {
    try {
      db.close();
    } catch {}
    try {
      await fs.rm(tmpDb, { force: true });
    } catch {}
    try {
      await fs.rm(projDir, { recursive: true, force: true });
    } catch {}
  });

  async function seedPlanAndCallbacks(pid: number, batchId: string) {
    const expectedRunDir = path.join(os.tmpdir(), `helm-run-${pid}-${batchId}`);
    await fs.rm(expectedRunDir, { recursive: true, force: true });
    await fs.mkdir(expectedRunDir, { recursive: true });

    const plan = {
      tasks: [
        {
          task_key: 'T1',
          atomic_work: 'A5 finishPlanning wire proof task',
          complexity: 'low',
          model: 'grok-4.5',
          effort: 'low',
          needs_more_info: false,
          task_type: 'feature',
          validation_criteria: 'run completes',
          deps: [],
        },
      ],
      meta: { source: 'a5-test' },
    };
    await fs.writeFile(path.join(expectedRunDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

    const cbPath = path.join(expectedRunDir, 'callbacks.md');
    await fs.writeFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed with planner; see plan.json\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: agreed\n` +
        `[helm callback] implementer ${batchId} STATUS: DONE — wired\n` +
        `[helm callback] validator ${batchId} STATUS: PASS — verified\n` +
        `[helm callback] panelist ${batchId} STATUS: VERDICT-READY — CLEAN: all gates pass (seat red-a5:0)\n` +
        `[helm callback] panelist ${batchId} STATUS: VERDICT-READY — CLEAN: regressions hold (seat red-a5:1)\n`,
      'utf8'
    );
    return expectedRunDir;
  }

  it('DB: discovery → planning → implementation with no manual phase patch after planning-done', async () => {
    const proj = projectSvc.createProject({ name: 'a5-fp-advance', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'A5 advance', 'autonomous_after_discovery');
    expect(cycle.phase).toBe('discovery');

    // start-planning counterpart: flips discovery → planning before the engine runs.
    // (Production index.ts does the same at POST /api/cycles/:id/start-planning.)
    cycleSvc.setCyclePhase(cycle.id, 'planning');
    expect(
      (db.raw.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycle.id) as any).phase
    ).toBe('planning');

    const batchId = `a5-adv-${Date.now().toString(36)}`;
    const expectedRunDir = await seedPlanAndCallbacks(proj.id, batchId);

    // Production recipe (startRunDetached): pre-create cycle-linked run, then startRun reuses it.
    const precreatedRunId = artifacts.createRun(
      proj.id,
      batchId,
      path.join(expectedRunDir, 'north-star.md'),
      cycle.id
    );

    const runId = await orch.startRun({
      projectId: proj.id,
      cycleId: cycle.id,
      prompt: 'A5: plan then implement one task',
      batchId,
      precreatedRunId,
    });
    expect(runId).toBe(precreatedRunId);

    // No manual UPDATE cycles SET phase=… after planning — finishPlanning did it. The task's DONE/PASS
    // callbacks were seeded upfront (fake transport), so the run may race all the way to true
    // completion before this awaited startRun returns — A7/R3.15 then flips the cycle straight to
    // 'complete' (see cycle-terminal-on-run-complete.test.ts); either outcome proves finishPlanning
    // (not a manual patch) drove the cycle out of 'planning'.
    const after = db.raw.prepare('SELECT phase, awaiting_approval FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(['implementation', 'complete']).toContain(after.phase);
    expect(Number(after.awaiting_approval || 0)).toBe(0);

    const runRow = db.raw.prepare('SELECT cycle_id, phase, status FROM runs WHERE id = ?').get(runId) as any;
    expect(Number(runRow.cycle_id)).toBe(cycle.id);
    // Run itself may complete; phase board is the A5 contract.
    expect(['complete', 'executing', 'blocked', 'failed']).toContain(String(runRow.phase));
  });

  it('N7: second finishPlanning call does not fail the run', async () => {
    const proj = projectSvc.createProject({ name: 'a5-fp-idem', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'A5 idempotent', 'autonomous_after_discovery');
    cycleSvc.setCyclePhase(cycle.id, 'planning');

    const batchId = `a5-idem-${Date.now().toString(36)}`;
    const expectedRunDir = await seedPlanAndCallbacks(proj.id, batchId);
    const precreatedRunId = artifacts.createRun(
      proj.id,
      batchId,
      path.join(expectedRunDir, 'north-star.md'),
      cycle.id
    );

    const runId = await orch.startRun({
      projectId: proj.id,
      cycleId: cycle.id,
      prompt: 'A5: second call safety',
      batchId,
      precreatedRunId,
    });
    expect(runId).toBe(precreatedRunId);

    const phaseAfterFirst = (db.raw.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycle.id) as any)
      .phase;
    // Seeded DONE/PASS callbacks (fake transport) may race the run to true completion before this
    // awaited startRun returns — A7/R3.15 then flips the cycle straight to 'complete'. Either outcome
    // is non-'planning', which is what makes the CONFLICT assertion below meaningful.
    expect(['implementation', 'complete']).toContain(phaseAfterFirst);

    // Direct second call throws CONFLICT (N7) — production helper must not propagate it.
    let directConflict: any;
    try {
      cycleSvc.finishPlanning(cycle.id);
    } catch (e: any) {
      directConflict = e;
    }
    expect(directConflict?.code).toBe('CONFLICT');

    // Orchestrator private path: second call is a no-op, never throws.
    expect(() => (orch as any).finishPlanningAtPlanningDone(cycle.id)).not.toThrow();
    expect(() => (orch as any).finishPlanningAtPlanningDone(cycle.id)).not.toThrow();

    // Run is still intact (not failed by the second call).
    const runRow = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId) as any;
    expect(runRow).toBeTruthy();
    expect(String(runRow.status)).not.toBe('failed');
    expect(['implementation', 'complete']).toContain(
      (db.raw.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycle.id) as any).phase
    );
  });
});
