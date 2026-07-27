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
import { CycleService, isAwaitingApproval } from './services/cycle-service.js';
import { requestRunAbort, getRunAbort, clearRunAbort } from './services/run-abort-registry.js';

/**
 * A6 / R3.14 — pause_after_planning actually gates the implementation queue.
 * 1) gate-mode cycle at planning-done: awaiting_approval flips, the run parks, run_tasks are
 *    ingested but never dispatched (zero attempts) — the queue never starts.
 * 2) approveCycle unparks it: a fresh cyclePlan run against the same plan.md actually drains
 *    the queue (real attempts recorded) — implementation proceeds.
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

describe.sequential('A6 R3.14 pause_after_planning gate', () => {
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
    tmpDb = path.join(os.tmpdir(), `helm-a6-gate-${Date.now()}.db`);
    db = new DatabaseService(tmpDb);
    artifacts = new RunArtifactService(db);
    parser = new PlanParserService(artifacts);
    queue = new TaskQueueService(artifacts);
    fakeT = new FakeTransport();
    projectSvc = new ProjectService(db);
    assignSvc = new AgentAssignmentService(db);
    planning = new PlanningPhaseService(fakeT, artifacts, queue);
    cycleSvc = new CycleService(db, projectSvc);
    projDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'helm-a6-proj-'));

    orch = new RunOrchestratorService({
      artifacts,
      planning,
      parser,
      queue,
      transport: fakeT,
      projectService: projectSvc,
      assignmentService: assignSvc,
      escalationService: new EscalationService(db),
      panelService: new PanelService(fakeT, artifacts, 'a6test'),
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

  // Mirrors A5's finish-planning-production.test.ts recipe: pre-authored plan.json (test seam)
  // skips interview, agreement callbacks let planning reach PLAN-READY, execution callbacks let
  // the single ingested task drain to complete.
  async function seedPlanAndCallbacks(pid: number, batchId: string) {
    const expectedRunDir = path.join(os.tmpdir(), `helm-run-${pid}-${batchId}`);
    await fs.rm(expectedRunDir, { recursive: true, force: true });
    await fs.mkdir(expectedRunDir, { recursive: true });

    const plan = {
      tasks: [
        {
          task_key: 'T1',
          atomic_work: 'A6 pause_after_planning gate proof task',
          complexity: 'low',
          model: 'grok-4.5',
          effort: 'low',
          needs_more_info: false,
          task_type: 'feature',
          validation_criteria: 'run completes',
          deps: [],
        },
      ],
      meta: { source: 'a6-test' },
    };
    await fs.writeFile(path.join(expectedRunDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');

    const cbPath = path.join(expectedRunDir, 'callbacks.md');
    await fs.writeFile(
      cbPath,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed with planner; see plan.json\n` +
        `[helm callback] planner ${batchId}-partner STATUS: REVIEW-READY\n` +
        `[helm callback] implementer ${batchId} STATUS: DONE — wired\n` +
        `[helm callback] validator ${batchId} STATUS: PASS — verified\n` +
        `[helm callback] panelist ${batchId} STATUS: VERDICT-READY — CLEAN: all gates pass (seat red-a6:0)\n` +
        `[helm callback] panelist ${batchId} STATUS: VERDICT-READY — CLEAN: regressions hold (seat red-a6:1)\n`,
      'utf8'
    );
    return expectedRunDir;
  }

  // Execution-only recipe for the post-approval cyclePlan run: no interview/planning agreement
  // needed (seedFromCyclePlan reads plan.md straight off disk), only the implementer/validator/
  // panelist callbacks that let the single ingested task drain.
  async function seedImplementationCallbacks(pid: number, batchId: string) {
    const runDir = path.join(os.tmpdir(), `helm-run-${pid}-${batchId}`);
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.mkdir(runDir, { recursive: true });
    await fs.writeFile(
      path.join(runDir, 'callbacks.md'),
      `[helm callback] implementer ${batchId} STATUS: DONE — wired\n` +
        `[helm callback] validator ${batchId} STATUS: PASS — verified\n` +
        `[helm callback] panelist ${batchId} STATUS: VERDICT-READY — CLEAN: all gates pass (seat red-a6b:0)\n` +
        `[helm callback] panelist ${batchId} STATUS: VERDICT-READY — CLEAN: regressions hold (seat red-a6b:1)\n`,
      'utf8'
    );
    return runDir;
  }

  it('gate-mode cycle parks at planning-done: awaiting_approval, run parked, queue never starts', async () => {
    const proj = projectSvc.createProject({ name: 'a6-gate-park', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'A6 gate park', 'pause_after_planning');
    expect(cycle.autonomy).toBe('pause_after_planning');
    cycleSvc.setCyclePhase(cycle.id, 'planning');

    const batchId = `a6-gate-${Date.now().toString(36)}`;
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
      prompt: 'A6: plan then park at the approval gate',
      batchId,
      precreatedRunId,
    });
    expect(runId).toBe(precreatedRunId);

    // Cycle board: still in planning, but flagged awaiting_approval (finishPlanning's gate branch) —
    // never auto-advanced to implementation the way an autonomous cycle would.
    const cycleRow: any = db.raw.prepare('SELECT phase, autonomy, awaiting_approval FROM cycles WHERE id = ?').get(cycle.id);
    expect(cycleRow.phase).toBe('planning');
    expect(
      isAwaitingApproval({ autonomy: cycleRow.autonomy, awaiting_approval: Boolean(Number(cycleRow.awaiting_approval)) })
    ).toBe(true);

    // Run itself: parked via the #52 operator-pause contract (phase='blocked', status='paused') —
    // every other terminal-phase guard in run-orchestrator-service.ts already protects 'blocked'
    // from being clobbered by an unrelated later write; a bespoke phase string is not.
    const runRow: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
    expect(runRow.phase).toBe('blocked');
    expect(runRow.status).toBe('paused');

    // Planning ingested the task, but the queue never dispatched it: pending, zero attempts.
    const tasks = db.raw.prepare('SELECT id, status FROM run_tasks WHERE run_id = ?').all(runId) as any[];
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) expect(t.status).toBe('pending');
    const attemptsRow: any = db.raw
      .prepare('SELECT COUNT(*) AS c FROM task_attempts ta JOIN run_tasks rt ON ta.task_id = rt.id WHERE rt.run_id = ?')
      .get(runId);
    expect(Number(attemptsRow.c)).toBe(0);
  });

  it('approveCycle unparks the gate: a fresh cyclePlan run actually drains the queue', async () => {
    const proj = projectSvc.createProject({ name: 'a6-gate-approve', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'A6 gate approve', 'pause_after_planning');
    cycleSvc.setCyclePhase(cycle.id, 'planning');

    const planBatchId = `a6-gate2-${Date.now().toString(36)}`;
    const expectedRunDir = await seedPlanAndCallbacks(proj.id, planBatchId);
    const precreatedRunId = artifacts.createRun(
      proj.id,
      planBatchId,
      path.join(expectedRunDir, 'north-star.md'),
      cycle.id
    );

    const plannedRunId = await orch.startRun({
      projectId: proj.id,
      cycleId: cycle.id,
      prompt: 'A6: plan, then approve, then implement',
      batchId: planBatchId,
      precreatedRunId,
    });

    // Sanity: parked exactly like the first test.
    const parkedRow: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(plannedRunId);
    expect(parkedRow.phase).toBe('blocked');
    expect(parkedRow.status).toBe('paused');

    // JROM approves — flips awaiting_approval -> 0, phase -> implementation (cycle-service.ts).
    const approved = cycleSvc.approveCycle(cycle.id);
    expect(approved.phase).toBe('implementation');
    expect(approved.awaiting_approval).toBe(false);

    // A fresh cyclePlan run (the same mechanism startCycleImplementationAfterApproval triggers)
    // reads the SAME plan.md the parked run's planning phase wrote to the cycle folder, and this
    // time actually drives it to completion.
    const implBatchId = `a6-impl-${Date.now().toString(36)}`;
    await seedImplementationCallbacks(proj.id, implBatchId);

    const implRunId = await orch.startRun({
      projectId: proj.id,
      cycleId: cycle.id,
      prompt: `implement cycle ${cycle.id} from plan.md`,
      batchId: implBatchId,
      cyclePlan: true,
    });

    expect(implRunId).not.toBe(plannedRunId);
    const implRunRow: any = db.raw.prepare('SELECT phase, status, cycle_id FROM runs WHERE id = ?').get(implRunId);
    expect(Number(implRunRow.cycle_id)).toBe(cycle.id);

    // The unambiguous "implementation proceeded" signal: real attempts were recorded (unlike the
    // parked run's zero attempts above). The run's own eventual terminal status can legitimately
    // still be 'paused' for reasons that have nothing to do with the gate (e.g. B11-T02's Final
    // Tests step pausing because this fake-project harness has no smoke/e2e config) — that's a
    // different, pre-existing mechanism, not evidence the queue never started.
    const implTasks = db.raw.prepare('SELECT id, status FROM run_tasks WHERE run_id = ?').all(implRunId) as any[];
    expect(implTasks.length).toBeGreaterThan(0);
    expect(implTasks.some((t) => t.status !== 'pending')).toBe(true);
    const implAttemptsRow: any = db.raw
      .prepare('SELECT COUNT(*) AS c FROM task_attempts ta JOIN run_tasks rt ON ta.task_id = rt.id WHERE rt.run_id = ?')
      .get(implRunId);
    expect(Number(implAttemptsRow.c)).toBeGreaterThan(0);
  });

  it('A6b: recycled runs.id does not inherit a stale abort — cyclePlan still dispatches', async () => {
    // Mechanism: INTEGER PRIMARY KEY without AUTOINCREMENT reuses free rowids after DELETE.
    // A prior stop left requestRunAbort(id) in the process-local registry; createRun must clear it
    // so a fresh cyclePlan run is not aborted at pre-execution with zero attempts.
    const proj = projectSvc.createProject({ name: 'a6b-abort-recycle', directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, 'A6b abort recycle', 'pause_after_planning');
    cycleSvc.setCyclePhase(cycle.id, 'planning');

    // Author cycle plan.md (cyclePlan seed reads cycle folder, not runDir plan.json).
    const cycleDir = cycleSvc.getCycleDocDir(cycle.id);
    await fs.mkdir(cycleDir, { recursive: true });
    const planMd =
      '# Plan\n\n```json\n' +
      JSON.stringify([
        {
          id: 'T1',
          batch: 'A6b',
          title: 'A6b abort-recycle proof',
          req_refs: ['R3.14'],
          assignee: 'grok-4.5',
          validator_lane: 'L2',
          effort: 'low',
          type: 'feature',
        },
      ]) +
      '\n```\n';
    await fs.writeFile(path.join(cycleDir, 'plan.md'), planMd, 'utf8');
    await fs.writeFile(path.join(cycleDir, 'og-requirements.md'), '# R3.14\n', 'utf8');
    await fs.writeFile(path.join(cycleDir, 'north-star.md'), '# ns\n', 'utf8');

    // Poison a run id that SQLite will reuse after delete (max free rowid).
    const poisonId = artifacts.createRun(proj.id, 'a6b-poison', null, cycle.id);
    requestRunAbort(poisonId, 'A6 live evidence capture complete');
    expect(getRunAbort(poisonId)?.reason).toContain('A6 live evidence');
    db.raw.prepare('DELETE FROM runs WHERE id = ?').run(poisonId);

    // createRun must clear the recycled id's abort (product contract).
    const implBatchId = `a6b-impl-${Date.now().toString(36)}`;
    await seedImplementationCallbacks(proj.id, implBatchId);
    const freshId = artifacts.createRun(proj.id, implBatchId, null, cycle.id);
    expect(freshId).toBe(poisonId); // recycled rowid — the condition under test
    expect(getRunAbort(freshId)).toBeNull();

    // Gate-mode cycle was never planning-driven in this unit — seed awaiting_approval so
    // approveCycle is valid. Park half is A6's ownership; this row owns post-approve dispatch.
    db.raw
      .prepare("UPDATE cycles SET phase = 'planning', awaiting_approval = 1, autonomy = 'pause_after_planning' WHERE id = ?")
      .run(cycle.id);
    const approved = cycleSvc.approveCycle(cycle.id);
    expect(approved.phase).toBe('implementation');

    const implRunId = await orch.startRun({
      projectId: proj.id,
      cycleId: cycle.id,
      prompt: `implement cycle ${cycle.id} from plan.md`,
      batchId: implBatchId,
      cyclePlan: true,
      precreatedRunId: freshId,
    });
    expect(implRunId).toBe(freshId);

    const implTasks = db.raw.prepare('SELECT id, status FROM run_tasks WHERE run_id = ?').all(implRunId) as any[];
    expect(implTasks.length).toBeGreaterThan(0);
    expect(implTasks.some((t: any) => t.status !== 'pending')).toBe(true);
    const attemptsRow: any = db.raw
      .prepare('SELECT COUNT(*) AS c FROM task_attempts ta JOIN run_tasks rt ON ta.task_id = rt.id WHERE rt.run_id = ?')
      .get(implRunId);
    expect(Number(attemptsRow.c)).toBeGreaterThan(0);

    clearRunAbort(freshId);
  });
});
