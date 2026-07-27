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
 * A7 / R3.15 — terminal cycle phase on true run completion.
 * (a) completed run → cycles.phase = complete (not planning)
 * (b) failed/blocked-failure → cycles.phase = complete
 * (c) operator-pause (A6 park) → cycle stays non-complete
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

describe.sequential('A7 R3.15 terminal cycle phase on run completion', () => {
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
  let prevSkipRedteam: string | undefined;

  beforeEach(async () => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
    prevSkipRedteam = process.env.HELM_SKIP_REDTEAM;
    process.env.HELM_SKIP_REDTEAM = '1';
    tmpDb = path.join(os.tmpdir(), `helm-a7-term-${Date.now()}.db`);
    db = new DatabaseService(tmpDb);
    artifacts = new RunArtifactService(db);
    parser = new PlanParserService(artifacts);
    queue = new TaskQueueService(artifacts);
    fakeT = new FakeTransport();
    projectSvc = new ProjectService(db);
    assignSvc = new AgentAssignmentService(db);
    planning = new PlanningPhaseService(fakeT, artifacts, queue);
    cycleSvc = new CycleService(db, projectSvc);
    projDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'helm-a7-proj-'));

    orch = new RunOrchestratorService({
      artifacts,
      planning,
      parser,
      queue,
      transport: fakeT,
      projectService: projectSvc,
      assignmentService: assignSvc,
      escalationService: new EscalationService(db),
      panelService: new PanelService(fakeT, artifacts, 'a7test'),
      deployRunner: makeDeployRunner(),
      finalTestRunner: makeFinalTestRunner(),
      cycleService: cycleSvc,
    });
  });

  afterEach(async () => {
    if (prevSkipRedteam === undefined) delete process.env.HELM_SKIP_REDTEAM;
    else process.env.HELM_SKIP_REDTEAM = prevSkipRedteam;
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
          atomic_work: 'A7 terminal phase proof task',
          complexity: 'low',
          model: 'grok-4.5',
          effort: 'low',
          needs_more_info: false,
          task_type: 'feature',
          validation_criteria: 'run completes',
          deps: [],
        },
      ],
      meta: { source: 'a7-test' },
    };
    await fs.writeFile(path.join(expectedRunDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

    const cbPath = path.join(expectedRunDir, 'callbacks.md');
    await fs.writeFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed with planner; see plan.json\n` +
        `[helm callback] planner ${batchId}-partner STATUS: REVIEW-READY\n` +
        `[helm callback] implementer ${batchId} STATUS: DONE — wired\n` +
        `[helm callback] validator ${batchId} STATUS: PASS — verified\n` +
        `[helm callback] panelist ${batchId} STATUS: VERDICT-READY — CLEAN: all gates pass (seat red-a7:0)\n` +
        `[helm callback] panelist ${batchId} STATUS: VERDICT-READY — CLEAN: regressions hold (seat red-a7:1)\n`,
      'utf8'
    );
    return expectedRunDir;
  }

  it('(a) completed run advances cycle to terminal complete, not planning', async () => {
    const proj = projectSvc.createProject({ name: 'a7-complete', directory: projDir });
    // final_tests off so engine does not park on missing e2e config
    const cycle = await cycleSvc.createCycle(proj.id, 'A7 complete', 'autonomous_after_discovery', false);
    cycleSvc.setCyclePhase(cycle.id, 'planning');

    const batchId = `a7-ok-${Date.now().toString(36)}`;
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
      prompt: 'A7: plan then complete one task',
      batchId,
      precreatedRunId,
    });
    expect(runId).toBe(precreatedRunId);

    const runRow = db.raw.prepare('SELECT cycle_id, phase, status FROM runs WHERE id = ?').get(runId) as any;
    expect(Number(runRow.cycle_id)).toBe(cycle.id);
    // Success path: run should reach complete (fake transport + pre-seeded DONE/PASS).
    expect(String(runRow.phase)).toBe('complete');
    expect(String(runRow.status)).toBe('complete');

    const after = db.raw.prepare('SELECT phase, status FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(after.phase).toBe('complete');
    // Not archive: status stays active (completeCycle not called)
    expect(String(after.status)).not.toBe('completed');
  });

  it('(b) blocked-failure advances cycle to terminal complete', async () => {
    const proj = projectSvc.createProject({ name: 'a7-fail', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'A7 fail', 'autonomous_after_discovery', false);
    cycleSvc.setCyclePhase(cycle.id, 'planning');

    const batchId = `a7-fail-${Date.now().toString(36)}`;
    const runDir = path.join(os.tmpdir(), `helm-run-${proj.id}-${batchId}`);
    await fs.mkdir(runDir, { recursive: true });
    const runId = artifacts.createRun(proj.id, batchId, path.join(runDir, 'north-star.md'), cycle.id);
    db.raw.prepare("UPDATE runs SET phase = 'executing', status = 'active' WHERE id = ?").run(runId);

    // True blocked-failure (not operator-pause)
    (orch as any).transitionRunToBlocked(runId, 'A7 unit forced blocked-failure', undefined, 'failure');

    const runRow = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId) as any;
    expect(runRow.phase).toBe('blocked');
    expect(runRow.status).toBe('failed');

    const after = db.raw.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(after.phase).toBe('complete');
  });

  it('(c) operator-pause does NOT terminalize cycle (A6 park regression)', async () => {
    const proj = projectSvc.createProject({ name: 'a7-pause', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'A7 pause', 'pause_after_planning', false);
    cycleSvc.setCyclePhase(cycle.id, 'planning');

    const batchId = `a7-pause-${Date.now().toString(36)}`;
    const runDir = path.join(os.tmpdir(), `helm-run-${proj.id}-${batchId}`);
    await fs.mkdir(runDir, { recursive: true });
    const runId = artifacts.createRun(proj.id, batchId, path.join(runDir, 'north-star.md'), cycle.id);
    db.raw.prepare("UPDATE runs SET phase = 'planning', status = 'active' WHERE id = ?").run(runId);

    (orch as any).transitionRunToBlocked(runId, 'A7 unit operator-pause park', undefined, 'operator-pause');

    const runRow = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId) as any;
    expect(runRow.phase).toBe('blocked');
    expect(runRow.status).toBe('paused');

    const after = db.raw.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(after.phase).toBe('planning');
    expect(after.phase).not.toBe('complete');
  });
});
