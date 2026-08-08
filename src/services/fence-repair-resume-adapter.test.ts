/**
 * fence-workflow-upgrade R5/R6 — repair resume adapter (R5.5, R8.1).
 *
 * Focused contract:
 *   - reconstruct queue from durable task/fence/repair rows
 *   - resume from 1–2 active fence_repair_units (generation join)
 *   - never deferred-only
 *   - historical completes outside active generation stay complete
 *
 * R6 (D17): fresh-process path uses the repair-generation join and calls real
 * resumeExistingRun after closing the first DatabaseService and building a
 * genuinely fresh DB/service/queue/orchestrator graph.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { beginFenceRepairRound } from './fence-repair-schema.js';
import {
  areAllRepairRoundUnitsLocked,
  lockFenceRepairUnitTest,
} from './fence-repair-hashlock.js';
import { FakeTransport } from './fake-transport.js';
import { PlanParserService } from './plan-parser-service.js';
import { ProjectService } from './project-service.js';
import { reopenAndEnqueueRepairRound } from './fence-repair-requeue.js';
import {
  FenceRepairResumeError,
  hasActiveRepairResumeUnits,
  loadActiveRepairUnits,
  loadActiveRepairUnitsForFreshProcess,
  prepareFreshProcessRepairResume,
  reconstructRepairResumeQueue,
} from './fence-repair-resume-adapter.js';
import {
  buildFenceReport,
  emitFenceReport,
  type FenceReportV1,
  type RunFenceReportCommandResult,
} from './fence-report-v1.js';
import { RunArtifactService } from './run-artifact-service.js';
import { RunOrchestratorService } from './run-orchestrator-service.js';
import { TaskQueueService } from './task-queue-service.js';

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function insertProjectRun(
  db: DatabaseService,
  opts?: { projectDir?: string; northStarRef?: string; batchId?: string }
): { projectId: number; runId: number } {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectDir = opts?.projectDir ?? `/tmp/fence-r5-${suffix}`;
  const projectId = (
    db.raw
      .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get(`fence-r5-${suffix}`, projectDir) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, opts?.batchId ?? 'R5', opts?.northStarRef ?? 'fence-repair-resume') as {
      id: number;
    }
  ).id;
  return { projectId, runId };
}

function insertRepairFixture(
  db: DatabaseService,
  opts?: { projectDir?: string; northStarRef?: string; batchId?: string }
): {
  runId: number;
  fenceId: number;
  taskIds: Record<string, number>;
  projectId: number;
} {
  const { projectId, runId } = insertProjectRun(db, opts);
  const taskIds: Record<string, number> = {};
  for (const taskKey of ['A1', 'A2', 'A3']) {
    taskIds[taskKey] = Number(
      (
        db.raw
          .prepare(
            `INSERT INTO run_tasks (run_id, task_key, label, batch, status)
             VALUES (?, ?, ?, 'B1', 'complete') RETURNING id`
          )
          .get(runId, taskKey, `Task ${taskKey}`) as { id: number }
      ).id
    );
  }
  const fenceId = Number(
    (
      db.raw
        .prepare(
          `INSERT INTO fences (
             fence_key, run_id, lifecycle_state,
             integration_cmd, negative_control_cmd, acceptance_ids, test_path
           )
           VALUES ('I4', ?, 'closing', 'npm test', 'FENCE_STUB=R2 npm test', ?, ?)
           RETURNING id`
        )
        .get(
          runId,
          JSON.stringify(['R5.5', 'R8.1']),
          'src/services/fence-f4-repair.integration.test.ts'
        ) as { id: number }
    ).id
  );
  for (const [position, taskKey] of ['A1', 'A2', 'A3'].entries()) {
    db.raw
      .prepare('INSERT INTO fence_members (fence_id, task_key, position) VALUES (?, ?, ?)')
      .run(fenceId, taskKey, position);
  }
  return { runId, fenceId, taskIds, projectId };
}

function writeRepairTest(repoRoot: string, body: string, rel: string): string {
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return rel;
}

function injectReport(report: FenceReportV1): NonNullable<
  Parameters<typeof lockFenceRepairUnitTest>[1]['runCommand']
> {
  return () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fence-r5-rep-'));
    const reportPath = path.join(t, 'fence-report-v1.json');
    emitFenceReport(report, reportPath);
    return {
      report,
      reportPath,
      exitCode: report.failed.length > 0 ? 1 : 0,
      timedOut: false,
    } satisfies RunFenceReportCommandResult;
  };
}

function lockUnit(
  db: DatabaseService,
  opts: {
    repairRoundId: number;
    taskKey: string;
    repoRoot: string;
    rel: string;
    assertId: string;
  }
): { repair_unit_id: number; repair_test_hash: string; repair_test_path: string } {
  const testPath = writeRepairTest(
    opts.repoRoot,
    `// validator-authored repair test for ${opts.taskKey}\nexport const ids = ['${opts.assertId}'];\n`,
    opts.rel
  );
  const result = lockFenceRepairUnitTest(db, {
    repairRoundId: opts.repairRoundId,
    taskKey: opts.taskKey,
    repairTestPath: testPath,
    authoredBy: 'validator.L2',
    repoRoot: opts.repoRoot,
    cwd: opts.repoRoot,
    expectedAssertIds: [opts.assertId],
    runCommand: injectReport(
      buildFenceReport({
        collected: [opts.assertId],
        failed: [{ id: opts.assertId, kind: 'assert' }],
      })
    ),
  });
  return {
    repair_unit_id: result.repair_unit_id,
    repair_test_hash: result.repair_test_hash,
    repair_test_path: result.repair_test_path,
  };
}

/** Seed queue with all complete so reopen can flip + enqueue. */
function makeQueue(runId: number, taskIds: number[]): TaskQueueService {
  const queue = new TaskQueueService();
  for (const tid of taskIds) {
    queue.enqueue(runId, tid, [], false, 'B1');
    queue.rehydrateTaskStatus(tid, 'complete');
  }
  return queue;
}

function stageLockReopen(
  db: DatabaseService,
  repoRoot: string,
  failingUnits: readonly string[],
  opts?: { projectDir?: string; northStarRef?: string; batchId?: string }
): {
  runId: number;
  fenceId: number;
  taskIds: Record<string, number>;
  repairRoundId: number;
  queue: TaskQueueService;
  projectId: number;
} {
  const { runId, fenceId, taskIds, projectId } = insertRepairFixture(db, opts);
  const staged = beginFenceRepairRound(db, {
    fenceId,
    faultClass: 'implementation',
    failingUnits: [...failingUnits],
    verdictFingerprint: 'fp1:r5-resume',
  });
  for (const key of failingUnits) {
    lockUnit(db, {
      repairRoundId: staged.repair_round_id,
      taskKey: key,
      repoRoot,
      rel: `repairs/${key}.repair.test.ts`,
      assertId: `unit-${key}-regression`,
    });
  }
  expect(areAllRepairRoundUnitsLocked(db, staged.repair_round_id)).toBe(true);

  const queue = makeQueue(runId, [taskIds.A1, taskIds.A2, taskIds.A3]);
  reopenAndEnqueueRepairRound(db, {
    repairRoundId: staged.repair_round_id,
    queue,
    repoRoot,
  });

  return {
    runId,
    fenceId,
    taskIds,
    repairRoundId: staged.repair_round_id,
    queue,
    projectId,
  };
}

function writePlanForRepairRun(runDir: string, batchId: string): void {
  fs.mkdirSync(runDir, { recursive: true });
  const plan = {
    tasks: (['A1', 'A2', 'A3'] as const).map((taskKey) => ({
      task_key: taskKey,
      atomic_work: `Repair ${taskKey}`,
      complexity: 'low',
      effort: 'low',
      needs_more_info: false,
      task_type: 'feature',
      validation_criteria: `${taskKey} passes`,
      deps: [],
      batch: 'B1',
    })),
    meta: { source: 'fence-r6-fresh-process' },
  };
  fs.writeFileSync(path.join(runDir, 'north_star.md'), 'R6 fresh-process repair resume fixture\n', 'utf8');
  fs.writeFileSync(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
  fs.writeFileSync(
    path.join(runDir, 'callbacks.md'),
    `[helm callback] implementer ${batchId} STATUS: DONE — repaired\n` +
      `[helm callback] validator ${batchId} STATUS: PASS — verified\n`,
    'utf8'
  );
}

describe('R5 fence-repair-resume-adapter (R5.5, R8.1)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('schema surface still exposes repair admission fields at SCHEMA_VERSION ≥119', () => {
    const t = tempDir('helm-fence-r5-schema-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(119);
    expect((db.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(
      SCHEMA_VERSION
    );
    const cols = new Set(
      (db.raw.prepare('PRAGMA table_info(run_tasks)').all() as Array<{ name: string }>).map((c) => c.name)
    );
    for (const c of ['reopen_reason', 'repair_generation', 'repair_round_id']) {
      expect(cols.has(c)).toBe(true);
    }
    expect(
      (db.raw.prepare("SELECT 1 AS o FROM sqlite_master WHERE type='table' AND name='fence_repair_units'").get() as
        | { o: number }
        | undefined)?.o
    ).toBe(1);
    db.close();
  });

  it('reconstructs queue from durable rows and resumes two active fence_repair_units (R5.5 in-process)', () => {
    const t = tempDir('helm-fence-r5-two-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, taskIds, repairRoundId } = stageLockReopen(db, t.dir, ['A1', 'A2']);

    expect(hasActiveRepairResumeUnits(db, runId)).toBe(true);
    const active = loadActiveRepairUnits(db, runId);
    expect(active.map((u) => u.task_key).sort()).toEqual(['A1', 'A2']);
    expect(active.every((u) => u.repair_generation === 1 && u.status === 'pending')).toBe(true);

    // Simulate process-local queue loss: brand-new queue, clear durable graph into it.
    const freshQueue = new TaskQueueService();
    const result = reconstructRepairResumeQueue(db, freshQueue, runId);

    expect(result.ok).toBe(true);
    expect(result.run_id).toBe(runId);
    expect(result.units.map((u) => u.task_key).sort()).toEqual(['A1', 'A2']);
    expect(result.deferred_left_intact).toBe(0);
    expect(result.historical_complete_count).toBe(1); // A3

    // Historical complete outside active generation stays complete — not redispatched.
    const a3 = db.raw
      .prepare('SELECT status, reopen_reason, repair_generation FROM run_tasks WHERE id = ?')
      .get(taskIds.A3) as { status: string; reopen_reason: string | null; repair_generation: number };
    expect(a3).toEqual({ status: 'complete', reopen_reason: null, repair_generation: 0 });

    // Active units claimable; never deferred.
    const claimed = new Set<number>();
    for (let i = 0; i < 2; i++) {
      const token = freshQueue.claimNextReady(runId);
      expect(token).not.toBeNull();
      claimed.add(token!.taskId);
      // Mark complete so the sibling can claim next (single in-flight).
      expect(freshQueue.markComplete(token!)).toBe(true);
    }
    expect(claimed).toEqual(new Set([taskIds.A1, taskIds.A2]));
    expect(freshQueue.claimNextReady(runId)).toBeNull(); // A3 complete

    expect(
      (db.raw.prepare("SELECT COUNT(*) AS c FROM run_tasks WHERE run_id = ? AND status = 'deferred'").get(runId) as {
        c: number;
      }).c
    ).toBe(0);

    // Durable repair markers still intact after reconstruct (no force-complete / erase).
    for (const key of ['A1', 'A2'] as const) {
      const row = db.raw
        .prepare(
          'SELECT status, reopen_reason, repair_generation, repair_round_id FROM run_tasks WHERE id = ?'
        )
        .get(taskIds[key]) as {
        status: string;
        reopen_reason: string;
        repair_generation: number;
        repair_round_id: number;
      };
      expect(row.reopen_reason).toBe('repair');
      expect(row.repair_generation).toBe(1);
      expect(row.repair_round_id).toBe(repairRoundId);
      // claim/markComplete may have written complete via pure in-mem queue (no artifacts) —
      // durable status stays pending until a CAS path with artifacts; either is fine as long
      // as reopen markers remain. Pure in-mem markComplete does not touch SQLite.
      expect(row.status).toBe('pending');
    }

    db.close();
  });

  it('resumes from a single active fence_repair_unit (R5.5)', () => {
    const t = tempDir('helm-fence-r5-one-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, taskIds } = stageLockReopen(db, t.dir, ['A1']);

    const q = new TaskQueueService();
    const result = reconstructRepairResumeQueue(db, q, runId);
    expect(result.units).toHaveLength(1);
    expect(result.units[0].task_key).toBe('A1');
    expect(result.historical_complete_count).toBe(2); // A2, A3

    const token = q.claimNextReady(runId);
    expect(token).not.toBeNull();
    expect(token!.taskId).toBe(taskIds.A1);
    db.close();
  });

  it('refuses deferred-only resume and never unparks deferred for repair (R5.5)', () => {
    const t = tempDir('helm-fence-r5-deferred-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, taskIds } = insertRepairFixture(db);

    // Park A1 as deferred — ordinary operator park, not repair.
    db.raw.prepare("UPDATE run_tasks SET status = 'deferred' WHERE id = ?").run(taskIds.A1);

    expect(hasActiveRepairResumeUnits(db, runId)).toBe(false);
    const q = new TaskQueueService();
    expect(() => reconstructRepairResumeQueue(db, q, runId)).toThrow(FenceRepairResumeError);
    expect(() => reconstructRepairResumeQueue(db, q, runId)).toThrow(/deferred-only|deferred/i);

    // Durable deferred left intact.
    const row = db.raw
      .prepare('SELECT status, reopen_reason FROM run_tasks WHERE id = ?')
      .get(taskIds.A1) as { status: string; reopen_reason: string | null };
    expect(row.status).toBe('deferred');
    expect(row.reopen_reason).toBeNull();
    db.close();
  });

  it('leaves a coexisting deferred task intact while resuming active repair units', () => {
    const t = tempDir('helm-fence-r5-coexist-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, taskIds } = stageLockReopen(db, t.dir, ['A1']);

    // A3 was complete; park it deferred without repair markers.
    db.raw
      .prepare("UPDATE run_tasks SET status = 'deferred', reopen_reason = NULL, repair_generation = 0, repair_round_id = NULL WHERE id = ?")
      .run(taskIds.A3);

    const q = new TaskQueueService();
    const result = reconstructRepairResumeQueue(db, q, runId);
    expect(result.units.map((u) => u.task_key)).toEqual(['A1']);
    expect(result.deferred_left_intact).toBe(1);

    const deferred = db.raw
      .prepare('SELECT status FROM run_tasks WHERE id = ?')
      .get(taskIds.A3) as { status: string };
    expect(deferred.status).toBe('deferred');

    // Only the repair unit is claimable first (earliest open batch includes deferred as open,
    // but deferred is not claimable; A1 pending is claimable).
    const token = q.claimNextReady(runId);
    expect(token).not.toBeNull();
    expect(token!.taskId).toBe(taskIds.A1);
    db.close();
  });

  it('generation join excludes stale fence_repair_units that no longer match admission markers', () => {
    const t = tempDir('helm-fence-r5-genjoin-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, taskIds, repairRoundId } = stageLockReopen(db, t.dir, ['A1']);

    // Drift generation on the task so the correct join no longer matches.
    db.raw
      .prepare('UPDATE run_tasks SET repair_generation = repair_generation + 1 WHERE id = ?')
      .run(taskIds.A1);

    expect(loadActiveRepairUnits(db, runId)).toHaveLength(0);
    expect(hasActiveRepairResumeUnits(db, runId)).toBe(false);

    // R6: fresh-process loader uses the same generation join (gap closed).
    const freshLoader = loadActiveRepairUnitsForFreshProcess(db, runId);
    expect(freshLoader).toHaveLength(0);

    const q = new TaskQueueService();
    expect(() => reconstructRepairResumeQueue(db, q, runId)).toThrow(/no active fence_repair_units/i);

    // Unit history row still exists at generation 1; admission marker drifted.
    const unit = db.raw
      .prepare(
        'SELECT repair_generation FROM fence_repair_units WHERE repair_round_id = ? AND task_key = ?'
      )
      .get(repairRoundId, 'A1') as { repair_generation: number };
    expect(unit.repair_generation).toBe(1);
    db.close();
  });

  it('fresh-process path uses generation join and real resumeExistingRun (R5.5)', async () => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
    process.env.HELM_SKIP_BATCH_DEPLOY = '1';
    process.env.HELM_SKIP_REDTEAM = '1';

    const t = tempDir('helm-fence-r6-fresh-');
    cleanups.push(t.cleanup);
    const dbPath = path.join(t.dir, 'helm.db');
    const projectDir = path.join(t.dir, 'project');
    const runDir = path.join(t.dir, 'run');
    fs.mkdirSync(projectDir, { recursive: true });
    const batchId = 'R6-fresh';
    writePlanForRepairRun(runDir, batchId);
    const northStarRef = path.join(runDir, 'north_star.md');

    const firstDb = new DatabaseService(dbPath);
    const { runId, taskIds } = stageLockReopen(firstDb, t.dir, ['A1', 'A2'], {
      projectDir,
      northStarRef,
      batchId,
    });

    // OPEN baseline so fence members are claimable after resume (R3.1).
    firstDb.raw
      .prepare(
        `UPDATE fences
         SET lifecycle_state = 'draining',
             open_failed_ids = ?,
             open_test_hash = 'r6-open-baseline',
             open_at = datetime('now')
         WHERE run_id = ?`
      )
      .run(JSON.stringify(['unit-A1-regression']), runId);

    // Park the repair run so resumeExistingRun accepts it.
    firstDb.raw
      .prepare(
        "UPDATE runs SET phase='blocked', status='failed', ended_at=datetime('now') WHERE id=?"
      )
      .run(runId);

    // Matched path and fresh-process loader agree when generations are consistent.
    const matched = loadActiveRepairUnits(firstDb, runId);
    const freshLoader = loadActiveRepairUnitsForFreshProcess(firstDb, runId);
    expect(matched.map((u) => u.task_key).sort()).toEqual(['A1', 'A2']);
    expect(freshLoader.map((u) => u.task_key).sort()).toEqual(['A1', 'A2']);

    // After generation drift on one unit, both paths exclude it (join wired).
    firstDb.raw.prepare('UPDATE run_tasks SET repair_generation = 99 WHERE id = ?').run(taskIds.A1);
    expect(loadActiveRepairUnits(firstDb, runId).map((u) => u.task_key)).toEqual(['A2']);
    expect(loadActiveRepairUnitsForFreshProcess(firstDb, runId).map((u) => u.task_key)).toEqual([
      'A2',
    ]);
    // Restore for the real resume path (both units active).
    firstDb.raw.prepare('UPDATE run_tasks SET repair_generation = 1 WHERE id = ?').run(taskIds.A1);

    const resumeSpy = vi.spyOn(RunOrchestratorService.prototype, 'resumeExistingRun');

    const prep = await prepareFreshProcessRepairResume({
      dbPath,
      runId,
      closeDb: firstDb,
      createOrchestrator: ({ db, queue, artifacts }) => {
        return new RunOrchestratorService({
          artifacts,
          planning: {} as any,
          parser: new PlanParserService(artifacts),
          queue,
          transport: new FakeTransport(),
          projectService: new ProjectService(db),
          assignmentService: new AgentAssignmentService(db),
        });
      },
    });

    expect(prep.ok).toBe(true);
    expect(prep.generation_join).toBe(true);
    expect(prep.units.map((u) => u.task_key).sort()).toEqual(['A1', 'A2']);
    expect(prep.redispatched_task_ids.sort()).toEqual([taskIds.A1, taskIds.A2].sort());
    expect(resumeSpy).toHaveBeenCalledWith(runId);
    expect(resumeSpy).toHaveBeenCalledTimes(1);

    // Fresh graph is a different DatabaseService instance (first was closed).
    expect(prep.db).not.toBe(firstDb);
    // Snapshot taken immediately after resumeExistingRun setup (before engine-tail races).
    expect(prep.run_after_resume).toMatchObject({ phase: 'executing', status: 'active' });

    // Reopen markers survive real resumeExistingRun (never force-complete / erase).
    for (const key of ['A1', 'A2'] as const) {
      const row = prep.db.raw
        .prepare(
          'SELECT status, reopen_reason, repair_generation FROM run_tasks WHERE id = ?'
        )
        .get(taskIds[key]) as {
        status: string;
        reopen_reason: string;
        repair_generation: number;
      };
      expect(row.reopen_reason).toBe('repair');
      expect(row.repair_generation).toBe(1);
      expect(['pending', 'working', 'complete']).toContain(row.status);
    }

    // Historical complete outside active generation stays complete.
    const a3 = prep.db.raw
      .prepare('SELECT status, reopen_reason, repair_generation FROM run_tasks WHERE id = ?')
      .get(taskIds.A3) as { status: string; reopen_reason: string | null; repair_generation: number };
    expect(a3).toEqual({ status: 'complete', reopen_reason: null, repair_generation: 0 });

    resumeSpy.mockRestore();
    // Brief yield so the async engine tail notices closed handles less noisily.
    await new Promise((r) => setTimeout(r, 30));
    try {
      prep.db.close();
    } catch {
      /* ignore */
    }
  });

  it('fresh-process path refuses when no generation-matched repair units remain', async () => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';

    const t = tempDir('helm-fence-r6-fresh-refuse-');
    cleanups.push(t.cleanup);
    const dbPath = path.join(t.dir, 'helm.db');
    const firstDb = new DatabaseService(dbPath);
    const { runId, taskIds } = stageLockReopen(firstDb, t.dir, ['A1']);

    // Drift so join excludes the only unit.
    firstDb.raw
      .prepare('UPDATE run_tasks SET repair_generation = repair_generation + 1 WHERE id = ?')
      .run(taskIds.A1);

    await expect(
      prepareFreshProcessRepairResume({
        dbPath,
        runId,
        closeDb: firstDb,
        createOrchestrator: ({ db, queue, artifacts }) =>
          new RunOrchestratorService({
            artifacts,
            planning: {} as any,
            parser: new PlanParserService(artifacts),
            queue,
            transport: new FakeTransport(),
            projectService: new ProjectService(db),
            assignmentService: new AgentAssignmentService(db),
          }),
      })
    ).rejects.toThrow(/no active fence_repair_units|generation/i);
  });

  it('never force-completes a deliberate repair reopen on reconstruct', () => {
    const t = tempDir('helm-fence-r5-noforce-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, taskIds } = stageLockReopen(db, t.dir, ['A1']);

    const q = new TaskQueueService();
    reconstructRepairResumeQueue(db, q, runId);

    const before = db.raw
      .prepare('SELECT status, reopen_reason, repair_generation FROM run_tasks WHERE id = ?')
      .get(taskIds.A1) as { status: string; reopen_reason: string; repair_generation: number };
    expect(before).toMatchObject({
      status: 'pending',
      reopen_reason: 'repair',
      repair_generation: 1,
    });

    // Reconstruct again — still pending with markers; never forced complete.
    const q2 = new TaskQueueService();
    reconstructRepairResumeQueue(db, q2, runId);
    const after = db.raw
      .prepare('SELECT status, reopen_reason, repair_generation FROM run_tasks WHERE id = ?')
      .get(taskIds.A1) as { status: string; reopen_reason: string; repair_generation: number };
    expect(after).toEqual(before);
    db.close();
  });
});
