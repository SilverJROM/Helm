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
import { CycleService } from './cycle-service.js';
import { RunOrchestratorService } from './run-orchestrator-service.js';
import { CANONICAL_CYCLE_ARTIFACTS } from './cycle-artifact-paths.js';

// A4 / AC4: a run that failed in planning must not terminalize its cycle — no phase='complete',
// no topology freeze. A genuine execution failure must still terminalize normally. Both production
// call sites reuse A1's hasExecutionStarted(runId) snapshot (taken before the terminal UPDATE):
// transitionRunToBlocked and startRunDetached's background failure catch.
describe('A4: planning-only failures leave the cycle retryable; execution failures still terminalize it', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let artifacts: RunArtifactService;
  let parser: PlanParserService;
  let queue: TaskQueueService;
  let fakeT: FakeTransport;
  let projectSvc: ProjectService;
  let assignSvc: AgentAssignmentService;
  let planning: PlanningPhaseService;
  let cycleSvc: CycleService;
  let orch: RunOrchestratorService;

  beforeEach(() => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
    tmpDb = path.join(os.tmpdir(), `helm-a4-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseService(tmpDb);
    artifacts = new RunArtifactService(db);
    parser = new PlanParserService(artifacts);
    queue = new TaskQueueService(artifacts);
    fakeT = new FakeTransport();
    projectSvc = new ProjectService(db);
    assignSvc = new AgentAssignmentService(db);
    planning = new PlanningPhaseService(fakeT, artifacts, queue);
    cycleSvc = new CycleService(db, projectSvc);

    orch = new RunOrchestratorService({
      artifacts,
      planning,
      parser,
      queue,
      transport: fakeT,
      projectService: projectSvc,
      assignmentService: assignSvc,
      cycleService: cycleSvc,
    });
  });

  afterEach(async () => {
    try { db.close(); } catch {}
    try { await fs.rm(tmpDb, { force: true }); } catch {}
  });

  function cycleRow(cycleId: number): any {
    return db.raw.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycleId);
  }

  function freezeCount(cycleId: number): number {
    const r: any = db.raw.prepare('SELECT COUNT(*) AS n FROM cycle_topology_freezes WHERE cycle_id = ?').get(cycleId);
    return Number(r.n);
  }

  async function makeProjectAndCycle(name: string): Promise<{ pid: number; cycleId: number }> {
    const projDir = path.join(os.tmpdir(), `helm-a4-proj-${name}-${Date.now()}`);
    const proj = projectSvc.createProject({ name, directory: projDir });
    const cycle = await cycleSvc.createCycle(proj.id, `${name} cycle`);
    cycleSvc.setCyclePhase(cycle.id, 'planning'); // realistic pre-run state; not in FREEZE_ON_OR_AFTER
    return { pid: proj.id, cycleId: cycle.id };
  }

  describe('transitionRunToBlocked', () => {
    it('(1) planning-only failure leaves the cycle non-complete/retryable, no topology freeze', async () => {
      const { pid, cycleId } = await makeProjectAndCycle('a4-planning-block');
      const runDir = path.join(os.tmpdir(), `helm-a4-planning-block-${Date.now()}`);
      const runId = artifacts.createRun(pid, 'a4planningblock', path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar), cycleId);
      const proj = projectSvc.getProject(pid);

      const before: any = db.raw.prepare('SELECT phase FROM runs WHERE id = ?').get(runId);
      expect(before.phase).toBe('planning');
      expect(cycleRow(cycleId).phase).toBe('planning');

      (orch as any).transitionRunToBlocked(runId, 'planning-only failure — never reached execution', proj, 'failure');
      await new Promise((r) => setTimeout(r, 100));

      const after: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
      expect(after.phase).toBe('blocked'); // the run terminal transition itself still happens
      expect(after.status).toBe('failed');

      expect(cycleRow(cycleId).phase).toBe('planning'); // NOT 'complete' — cycle stays retryable
      expect(freezeCount(cycleId)).toBe(0); // no topology freeze stamped
    });

    it('(2) regression: an executing-phase failure still terminalizes the cycle (complete + freeze stays idempotent)', async () => {
      const { pid, cycleId } = await makeProjectAndCycle('a4-exec-block');
      const runDir = path.join(os.tmpdir(), `helm-a4-exec-block-${Date.now()}`);
      const runId = artifacts.createRun(pid, 'a4execblock', path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar), cycleId);
      const proj = projectSvc.getProject(pid);

      // Realistic pre-state: cycle already advanced into implementation (freezes once on entry),
      // run genuinely executing with at least one task.
      cycleSvc.setCyclePhase(cycleId, 'implementation');
      expect(freezeCount(cycleId)).toBe(1);
      db.raw.prepare("UPDATE runs SET phase = 'executing' WHERE id = ?").run(runId);
      db.raw.prepare(`INSERT INTO run_tasks (run_id, task_key, label) VALUES (?, 'T1', 'do the thing')`).run(runId);

      (orch as any).transitionRunToBlocked(runId, 'execution failure', proj, 'failure');
      await new Promise((r) => setTimeout(r, 100));

      const after: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
      expect(after.phase).toBe('blocked');
      expect(after.status).toBe('failed');

      expect(cycleRow(cycleId).phase).toBe('complete'); // genuine terminalization still fires
      expect(freezeCount(cycleId)).toBe(1); // idempotent — not re-frozen, not left un-frozen
    });

    it('(3) operator-pause never terminalizes the cycle, regardless of execution state (unweakened)', async () => {
      const { pid, cycleId } = await makeProjectAndCycle('a4-operator-pause');
      const runDir = path.join(os.tmpdir(), `helm-a4-operator-pause-${Date.now()}`);
      const runId = artifacts.createRun(pid, 'a4operatorpause', path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar), cycleId);
      const proj = projectSvc.getProject(pid);
      db.raw.prepare("UPDATE runs SET phase = 'executing' WHERE id = ?").run(runId);
      db.raw.prepare(`INSERT INTO run_tasks (run_id, task_key, label) VALUES (?, 'T1', 'do the thing')`).run(runId);

      (orch as any).transitionRunToBlocked(runId, 'missing deploy config', proj, 'operator-pause');
      await new Promise((r) => setTimeout(r, 100));

      const after: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
      expect(after.phase).toBe('blocked');
      expect(after.status).toBe('paused');
      expect(cycleRow(cycleId).phase).toBe('planning'); // untouched — A6 park stays non-terminal
      expect(freezeCount(cycleId)).toBe(0);
    });
  });

  describe('startRunDetached background failure', () => {
    it('(4) a planning-only detached failure leaves the cycle non-complete/retryable, no topology freeze', async () => {
      const { pid, cycleId } = await makeProjectAndCycle('a4-planning-detached');

      let rejectStart!: (e: unknown) => void;
      const controlled = new Promise<number>((_resolve, reject) => { rejectStart = reject; });
      const startRunSpy = vi.spyOn(orch, 'startRun').mockReturnValue(controlled);

      const { runId } = orch.startRunDetached({ projectId: pid, cycleId, prompt: 'a4 planning-only detached', batchId: 'a4planningdetached' });

      const before: any = db.raw.prepare('SELECT phase FROM runs WHERE id = ?').get(runId);
      expect(before.phase).toBe('starting');

      rejectStart(new Error('synthetic detached startRun failure — never left planning'));
      await controlled.catch(() => {});
      await new Promise((r) => setTimeout(r, 100));

      const after: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
      expect(after.phase).toBe('failed');
      expect(after.status).toBe('failed');

      expect(cycleRow(cycleId).phase).toBe('planning');
      expect(freezeCount(cycleId)).toBe(0);

      startRunSpy.mockRestore();
    });

    it('(5) regression: an executing-phase detached failure still terminalizes the cycle', async () => {
      const { pid, cycleId } = await makeProjectAndCycle('a4-exec-detached');

      let rejectStart!: (e: unknown) => void;
      const controlled = new Promise<number>((_resolve, reject) => { rejectStart = reject; });
      const startRunSpy = vi.spyOn(orch, 'startRun').mockReturnValue(controlled);

      const { runId } = orch.startRunDetached({ projectId: pid, cycleId, prompt: 'a4 executing detached', batchId: 'a4execdetached' });

      db.raw.prepare("UPDATE runs SET phase = 'executing' WHERE id = ?").run(runId);
      db.raw.prepare(`INSERT INTO run_tasks (run_id, task_key, label) VALUES (?, 'T1', 'do the thing')`).run(runId);

      rejectStart(new Error('synthetic detached startRun failure — after execution began'));
      await controlled.catch(() => {});
      await new Promise((r) => setTimeout(r, 100));

      const after: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
      expect(after.phase).toBe('failed');
      expect(after.status).toBe('failed');

      expect(cycleRow(cycleId).phase).toBe('complete');

      startRunSpy.mockRestore();
    });
  });
});
