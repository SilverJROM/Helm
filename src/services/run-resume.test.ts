import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { FakeTransport } from './fake-transport.js';
import { PlanParserService } from './plan-parser-service.js';
import { ProjectService } from './project-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { RunOrchestratorService } from './run-orchestrator-service.js';
import { TaskQueueService } from './task-queue-service.js';

describe('RunOrchestratorService resumeExistingRun', () => {
  let db: DatabaseService;
  let dbPath: string;
  let tempRoot: string;
  let priorSkipDeploy: string | undefined;
  let priorSkipRedTeam: string | undefined;

  beforeEach(async () => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
    priorSkipDeploy = process.env.HELM_SKIP_BATCH_DEPLOY;
    priorSkipRedTeam = process.env.HELM_SKIP_REDTEAM;
    process.env.HELM_SKIP_BATCH_DEPLOY = '1';
    process.env.HELM_SKIP_REDTEAM = '1';
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-run-resume-'));
    dbPath = path.join(tempRoot, 'helm.db');
    db = new DatabaseService(dbPath);
  });

  afterEach(async () => {
    if (priorSkipDeploy === undefined) delete process.env.HELM_SKIP_BATCH_DEPLOY;
    else process.env.HELM_SKIP_BATCH_DEPLOY = priorSkipDeploy;
    if (priorSkipRedTeam === undefined) delete process.env.HELM_SKIP_REDTEAM;
    else process.env.HELM_SKIP_REDTEAM = priorSkipRedTeam;
    try { db.close(); } catch {}
    await fs.rm(tempRoot, { recursive: true, force: true });
  });

  it('rehydrates a blocked batch queue, resumes the parked task first, and never redispatches 8 complete tasks', async () => {
    const artifacts = new RunArtifactService(db);
    const parser = new PlanParserService(artifacts);
    const projectService = new ProjectService(db);
    const assignmentService = new AgentAssignmentService(db);
    const transport = new FakeTransport();
    const projectDir = path.join(tempRoot, 'project');
    const runDir = path.join(tempRoot, 'run');
    await fs.mkdir(projectDir, { recursive: true });
    await fs.mkdir(runDir, { recursive: true });
    const project = projectService.createProject({ name: 'resume-fixture', directory: projectDir });
    const batchId = 'resume-batch';

    const plan = {
      tasks: Array.from({ length: 11 }, (_, index) => {
        const n = index + 1;
        return {
          task_key: `T${n}`,
          atomic_work: `Implement task T${n}`,
          complexity: 'low',
          effort: 'low',
          needs_more_info: false,
          task_type: 'feature',
          validation_criteria: `T${n} passes`,
          deps: n === 9 ? ['T8'] : n === 10 ? ['T9'] : n === 11 ? ['T10'] : [],
          batch: n <= 8 ? 'B1' : n === 9 ? 'B2' : 'B3',
        };
      }),
      meta: { source: 'resume-focused-test' },
    };
    const northStarPath = path.join(runDir, 'north_star.md');
    await fs.writeFile(northStarPath, 'Resume the parked Piece A task, then finish later batches.', 'utf8');
    await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    await fs.writeFile(
      path.join(runDir, 'callbacks.md'),
      `[helm callback] implementer ${batchId} STATUS: DONE — implemented\n` +
        `[helm callback] validator ${batchId} STATUS: PASS — verified\n`,
      'utf8',
    );

    const runId = artifacts.createRun(project.id, batchId, northStarPath);
    const taskIds = plan.tasks.map((task) => artifacts.recordTask(runId, task.task_key, task.atomic_work, task.batch));
    const completeIds = taskIds.slice(0, 8);
    for (const taskId of completeIds) {
      artifacts.recordAttempt(taskId, 1);
      db.raw.prepare("UPDATE run_tasks SET status='complete' WHERE id=?").run(taskId);
    }
    const parkedId = taskIds[8];
    const parkedAttemptId = artifacts.recordAttempt(parkedId, 1);
    db.raw.prepare(
      "UPDATE run_tasks SET status='deferred', attempts_count=4, current_attempt_id=? WHERE id=?"
    ).run(parkedAttemptId, parkedId);
    db.raw.prepare(
      "UPDATE runs SET phase='blocked', status='failed', ended_at=datetime('now') WHERE id=?"
    ).run(runId);

    const completeAttemptCountBefore = Number((db.raw.prepare(
      `SELECT COUNT(*) AS n FROM task_attempts WHERE task_id IN (${completeIds.map(() => '?').join(',')})`
    ).get(...completeIds) as any).n);

    const sharedQueue = new TaskQueueService(artifacts);
    const statusDuringImplementerSpawn = new Map<string, any>();
    const realSpawn = transport.spawn.bind(transport);
    vi.spyOn(transport, 'spawn').mockImplementation(async (params) => {
      if (params.role === 'implementer') {
        const match = /task_key: (T\d+)/.exec(params.brief);
        if (match) {
          statusDuringImplementerSpawn.set(match[1], db.raw.prepare(
            'SELECT status, attempts_count, current_attempt_id FROM run_tasks WHERE task_key=? AND run_id=?'
          ).get(match[1], runId));
        }
      }
      return realSpawn(params);
    });

    const orchestrator = new RunOrchestratorService({
      artifacts,
      planning: {} as any,
      parser,
      queue: sharedQueue,
      transport,
      projectService,
      assignmentService,
    });

    await expect(orchestrator.resumeExistingRun(runId)).resolves.toEqual({ runId });

    // The setup contract is complete before the 202-style method resolves.
    const reopenedRun: any = db.raw.prepare('SELECT phase, status, ended_at FROM runs WHERE id=?').get(runId);
    expect(reopenedRun).toMatchObject({ phase: 'executing', status: 'active', ended_at: null });
    const reopenedTask: any = db.raw.prepare(
      'SELECT status, attempts_count, current_attempt_id FROM run_tasks WHERE id=?'
    ).get(parkedId);
    expect(reopenedTask).toMatchObject({ status: 'pending', attempts_count: 0, current_attempt_id: null });
    expect(Number((db.raw.prepare('SELECT COUNT(*) AS n FROM task_attempts WHERE task_id=?').get(parkedId) as any).n)).toBe(1);

    await vi.waitFor(() => {
      const terminal: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id=?').get(runId);
      expect(terminal).toMatchObject({ phase: 'complete', status: 'complete' });
    }, { timeout: 10_000, interval: 20 });

    const implementerSpawns = transport.spawnCalls.filter((call) => call.role === 'implementer');
    expect(implementerSpawns).toHaveLength(3);
    expect(implementerSpawns[0].brief).toContain('task_key: T9');
    expect(implementerSpawns[1].brief).toContain('task_key: T10');
    expect(implementerSpawns[2].brief).toContain('task_key: T11');
    for (let n = 1; n <= 8; n++) {
      expect(implementerSpawns.some((spawn) => spawn.brief.includes(`task_key: T${n}\n`))).toBe(false);
    }

    for (const taskKey of ['T9', 'T10', 'T11']) {
      expect(statusDuringImplementerSpawn.get(taskKey)).toMatchObject({
        status: 'working',
        attempts_count: 1,
      });
      expect(statusDuringImplementerSpawn.get(taskKey).current_attempt_id).toBeGreaterThan(0);
      const task: any = db.raw.prepare(
        'SELECT id, status, attempts_count, current_attempt_id FROM run_tasks WHERE run_id=? AND task_key=?'
      ).get(runId, taskKey);
      expect(task).toMatchObject({ status: 'complete', attempts_count: 1 });
      const currentAttempt: any = db.raw.prepare(
        'SELECT id, task_id FROM task_attempts WHERE id=?'
      ).get(task.current_attempt_id);
      expect(currentAttempt).toMatchObject({ id: task.current_attempt_id, task_id: task.id });
      expect((db.raw.prepare(
        'SELECT COUNT(*) AS n FROM dispatches WHERE attempt_id=?'
      ).get(task.current_attempt_id) as any).n).toBeGreaterThanOrEqual(2);
    }
    expect(sharedQueue.hasCompleted(runId)).toBe(true);

    const completeAttemptCountAfter = Number((db.raw.prepare(
      `SELECT COUNT(*) AS n FROM task_attempts WHERE task_id IN (${completeIds.map(() => '?').join(',')})`
    ).get(...completeIds) as any).n);
    expect(completeAttemptCountAfter).toBe(completeAttemptCountBefore);
    expect((db.raw.prepare("SELECT COUNT(*) AS n FROM run_tasks WHERE run_id=? AND status='complete'").get(runId) as any).n).toBe(11);
  });
});
