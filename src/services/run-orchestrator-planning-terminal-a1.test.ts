import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import { RunArtifactService } from './run-artifact-service.js';
import { PlanParserService } from './plan-parser-service.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { FakeTransport } from './fake-transport.js';
import { ProjectService } from './project-service.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { RunOrchestratorService } from './run-orchestrator-service.js';
import { CANONICAL_CYCLE_ARTIFACTS } from './cycle-artifact-paths.js';

// A1 / AC1: a run's blocked/failed terminal transition must not call assertImplementationBrainComplete
// — and therefore must never synthesize a worker_runtimes 'ibrain' row — when execution never started
// (run still starting/interview/planning, zero run_tasks). Covers both production call sites:
// transitionRunToBlocked and startRunDetached's background failure catch. A companion regression case
// per site proves the gate does not weaken genuine execution-failure cleanup once execution began.
describe('A1: planning-only terminal transitions skip assertImplementationBrainComplete', () => {
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

  beforeEach(() => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
    tmpDb = path.join(os.tmpdir(), `helm-a1-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseService(tmpDb);
    artifacts = new RunArtifactService(db);
    parser = new PlanParserService(artifacts);
    queue = new TaskQueueService(artifacts);
    fakeT = new FakeTransport();
    projectSvc = new ProjectService(db);
    assignSvc = new AgentAssignmentService(db);
    planning = new PlanningPhaseService(fakeT, artifacts, queue);

    orch = new RunOrchestratorService({
      artifacts,
      planning,
      parser,
      queue,
      transport: fakeT,
      projectService: projectSvc,
      assignmentService: assignSvc,
    });
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    try { await fs.rm(tmpDb, { force: true }); } catch {}
  });

  function ibrainWorkerRows(runId: number): any[] {
    return db.raw
      .prepare("SELECT id, role, state FROM worker_runtimes WHERE run_id = ? AND role = 'ibrain'")
      .all(runId) as any[];
  }

  describe('transitionRunToBlocked', () => {
    it('a planning-only failure (execution never started) does not call assertImplementationBrainComplete and synthesizes no ibrain row', async () => {
      const proj = projectSvc.createProject({ name: 'a1-planning-block', directory: '/tmp/a1-planning-block' });
      const pid = proj.id;
      const runDir = path.join(os.tmpdir(), `helm-a1-planning-block-${Date.now()}`);
      const runId = artifacts.createRun(pid, 'a1planningblock', path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar), null);

      // Sanity: a freshly created run is planning-phase with zero run_tasks — exactly AC1's premise.
      const before: any = db.raw.prepare('SELECT phase FROM runs WHERE id = ?').get(runId);
      expect(before.phase).toBe('planning');
      const taskCountBefore: any = db.raw.prepare('SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = ?').get(runId);
      expect(taskCountBefore.n).toBe(0);

      const assertSpy = vi.spyOn(orch as any, 'assertImplementationBrainComplete');

      (orch as any).transitionRunToBlocked(runId, 'planning-only failure — never reached execution', proj, 'failure');
      await new Promise((r) => setTimeout(r, 100)); // let the internal finalize/brain-assert IIFE settle

      const after: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
      expect(after.phase).toBe('blocked'); // the terminal transition itself must still happen
      expect(after.status).toBe('failed');

      expect(assertSpy).not.toHaveBeenCalled();
      expect(ibrainWorkerRows(runId)).toHaveLength(0);
    });

    it('regression: an executing-phase failure still calls assertImplementationBrainComplete and finalizes a genuine ibrain row', async () => {
      const proj = projectSvc.createProject({ name: 'a1-exec-block', directory: '/tmp/a1-exec-block' });
      const pid = proj.id;
      const runDir = path.join(os.tmpdir(), `helm-a1-exec-block-${Date.now()}`);
      const runId = artifacts.createRun(pid, 'a1execblock', path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar), null);
      db.raw.prepare("UPDATE runs SET phase = 'executing' WHERE id = ?").run(runId);
      db.raw
        .prepare(`INSERT INTO run_tasks (run_id, task_key, label) VALUES (?, 'T1', 'do the thing')`)
        .run(runId);

      const assertSpy = vi.spyOn(orch as any, 'assertImplementationBrainComplete');

      (orch as any).transitionRunToBlocked(runId, 'execution failure', proj, 'failure');
      await new Promise((r) => setTimeout(r, 100));

      const after: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
      expect(after.phase).toBe('blocked');
      expect(after.status).toBe('failed');

      expect(assertSpy).toHaveBeenCalledTimes(1);
      expect(ibrainWorkerRows(runId)).toHaveLength(1);
    });
  });

  describe('startRunDetached background failure', () => {
    it('a planning-only detached failure (still starting, zero run_tasks) does not call assertImplementationBrainComplete and synthesizes no ibrain row', async () => {
      const proj = projectSvc.createProject({ name: 'a1-planning-detached', directory: '/tmp/a1-planning-detached' });
      const pid = proj.id;

      let rejectStart!: (e: unknown) => void;
      const controlled = new Promise<number>((_resolve, reject) => { rejectStart = reject; });
      const startRunSpy = vi.spyOn(orch, 'startRun').mockReturnValue(controlled);
      const assertSpy = vi.spyOn(orch as any, 'assertImplementationBrainComplete');

      const { runId } = orch.startRunDetached({ projectId: pid, prompt: 'a1 planning-only detached', batchId: 'a1planningdetached' });

      const before: any = db.raw.prepare('SELECT phase FROM runs WHERE id = ?').get(runId);
      expect(before.phase).toBe('starting'); // startRunDetached's own pre-mark; startRun is mocked out
      const taskCountBefore: any = db.raw.prepare('SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = ?').get(runId);
      expect(taskCountBefore.n).toBe(0);

      rejectStart(new Error('synthetic detached startRun failure — never left planning'));
      await controlled.catch(() => {});
      await new Promise((r) => setTimeout(r, 100));

      const after: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
      expect(after.phase).toBe('failed');
      expect(after.status).toBe('failed');

      expect(assertSpy).not.toHaveBeenCalled();
      expect(ibrainWorkerRows(runId)).toHaveLength(0);

      startRunSpy.mockRestore();
    });

    it('regression: an executing-phase detached failure still calls assertImplementationBrainComplete and finalizes a genuine ibrain row', async () => {
      const proj = projectSvc.createProject({ name: 'a1-exec-detached', directory: '/tmp/a1-exec-detached' });
      const pid = proj.id;

      let rejectStart!: (e: unknown) => void;
      const controlled = new Promise<number>((_resolve, reject) => { rejectStart = reject; });
      const startRunSpy = vi.spyOn(orch, 'startRun').mockReturnValue(controlled);
      const assertSpy = vi.spyOn(orch as any, 'assertImplementationBrainComplete');

      const { runId } = orch.startRunDetached({ projectId: pid, prompt: 'a1 executing detached', batchId: 'a1execdetached' });

      db.raw.prepare("UPDATE runs SET phase = 'executing' WHERE id = ?").run(runId);
      db.raw
        .prepare(`INSERT INTO run_tasks (run_id, task_key, label) VALUES (?, 'T1', 'do the thing')`)
        .run(runId);

      rejectStart(new Error('synthetic detached startRun failure — after execution began'));
      await controlled.catch(() => {});
      await new Promise((r) => setTimeout(r, 100));

      const after: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
      expect(after.phase).toBe('failed');
      expect(after.status).toBe('failed');

      expect(assertSpy).toHaveBeenCalledTimes(1);
      expect(ibrainWorkerRows(runId)).toHaveLength(1);

      startRunSpy.mockRestore();
    });
  });
});
