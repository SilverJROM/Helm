/**
 * fence-workflow-upgrade R3 — post-hash atomic reopen + guarded requeue (R5.1–R5.3).
 *
 * Covers: refuse reopen until every named unit is locked; atomic complete→pending
 * with reopen_reason=repair + repair_generation (≤2); enqueue into live queue;
 * implementer dispatch requires intact locked hash; weakening refuses.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { TaskQueueService } from './task-queue-service.js';
import { beginFenceRepairRound } from './fence-repair-schema.js';
import {
  areAllRepairRoundUnitsLocked,
  hashTestFile,
  lockFenceRepairUnitTest,
} from './fence-repair-hashlock.js';
import {
  assertRepairImplementerDispatchAllowed,
  FenceRepairRequeueError,
  getRepairReopenView,
  isRepairImplementerDispatchBlocked,
  reopenAndEnqueueRepairRound,
} from './fence-repair-requeue.js';
import {
  buildFenceReport,
  emitFenceReport,
  type FenceReportV1,
  type RunFenceReportCommandResult,
} from './fence-report-v1.js';

function tempDir(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function insertProjectRun(db: DatabaseService): { projectId: number; runId: number } {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = (
    db.raw
      .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get(`fence-r3-${suffix}`, `/tmp/fence-r3-${suffix}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'R3', 'fence-repair-requeue') as { id: number }
  ).id;
  return { projectId, runId };
}

function insertRepairFixture(db: DatabaseService): {
  runId: number;
  fenceId: number;
  taskIds: Record<string, number>;
} {
  const { runId } = insertProjectRun(db);
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
          JSON.stringify(['R5.1', 'R5.2', 'R5.3']),
          'src/services/fence-f4-repair.integration.test.ts'
        ) as { id: number }
    ).id
  );
  for (const [position, taskKey] of ['A1', 'A2', 'A3'].entries()) {
    db.raw
      .prepare('INSERT INTO fence_members (fence_id, task_key, position) VALUES (?, ?, ?)')
      .run(fenceId, taskKey, position);
  }
  return { runId, fenceId, taskIds };
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
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fence-r3-rep-'));
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

/** Pure in-mem queue so claimNextReady is not blocked by fence OPEN baseline (B3). */
function makeQueue(runId: number, taskIds: number[]): TaskQueueService {
  const queue = new TaskQueueService();
  for (const tid of taskIds) {
    queue.enqueue(runId, tid, [], false, 'B1');
    queue.rehydrateTaskStatus(tid, 'complete');
  }
  return queue;
}

describe('R3 fence-repair-requeue (R5.1, R5.2, R5.3)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('schema surface still exposes repair admission fields at SCHEMA_VERSION ≥119', () => {
    const t = tempDir('helm-fence-r3-schema-');
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
    db.close();
  });

  it('refuses reopen when any named unit is not yet hash-locked (R5.2)', () => {
    const t = tempDir('helm-fence-r3-notlocked-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, fenceId, taskIds } = insertRepairFixture(db);
    const staged = beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1', 'A2'],
    });
    // Lock only A1 — A2 still unlocked.
    lockUnit(db, {
      repairRoundId: staged.repair_round_id,
      taskKey: 'A1',
      repoRoot: t.dir,
      rel: 'repairs/A1.repair.test.ts',
      assertId: 'unit-A1-regression',
    });
    expect(areAllRepairRoundUnitsLocked(db, staged.repair_round_id)).toBe(false);

    const queue = makeQueue(runId, [taskIds.A1, taskIds.A2, taskIds.A3]);
    expect(() =>
      reopenAndEnqueueRepairRound(db, {
        repairRoundId: staged.repair_round_id,
        queue,
        repoRoot: t.dir,
      })
    ).toThrow(/hash-locked|not_locked|R5\.2/i);

    // Status still complete for both.
    for (const key of ['A1', 'A2'] as const) {
      const row = db.raw
        .prepare('SELECT status, reopen_reason, repair_generation FROM run_tasks WHERE id = ?')
        .get(taskIds[key]) as { status: string; reopen_reason: string; repair_generation: number };
      expect(row.status).toBe('complete');
      expect(row.reopen_reason).toBe('repair');
      expect(row.repair_generation).toBe(1);
    }
    expect(queue.claimNextReady(runId)).toBeNull();
    db.close();
  });

  it('atomically reopens ≤2 complete units to pending with repair markers, enqueues, and gates dispatch on intact hash (R5.1–R5.3)', () => {
    const t = tempDir('helm-fence-r3-reopen-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, fenceId, taskIds } = insertRepairFixture(db);
    const staged = beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1', 'A2'],
      verdictFingerprint: 'fp1:r3',
    });

    const lockedA1 = lockUnit(db, {
      repairRoundId: staged.repair_round_id,
      taskKey: 'A1',
      repoRoot: t.dir,
      rel: 'repairs/A1.repair.test.ts',
      assertId: 'unit-A1-regression',
    });
    const lockedA2 = lockUnit(db, {
      repairRoundId: staged.repair_round_id,
      taskKey: 'A2',
      repoRoot: t.dir,
      rel: 'repairs/A2.repair.test.ts',
      assertId: 'unit-A2-regression',
    });
    expect(areAllRepairRoundUnitsLocked(db, staged.repair_round_id)).toBe(true);

    // Non-member A3 stays complete and is not a repair unit.
    const queue = makeQueue(runId, [taskIds.A1, taskIds.A2, taskIds.A3]);
    expect(queue.claimNextReady(runId)).toBeNull(); // all complete

    const result = reopenAndEnqueueRepairRound(db, {
      repairRoundId: staged.repair_round_id,
      queue,
      repoRoot: t.dir,
    });

    expect(result.ok).toBe(true);
    expect(result.run_id).toBe(runId);
    expect(result.units.map((u) => u.task_key).sort()).toEqual(['A1', 'A2']);
    for (const u of result.units) {
      expect(u.status).toBe('pending');
      expect(u.reopen_reason).toBe('repair');
      expect(u.repair_generation).toBe(1);
      expect(u.repair_test_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }

    const tasks = db.raw
      .prepare(
        `SELECT task_key, status, reopen_reason, repair_generation, repair_round_id
         FROM run_tasks WHERE run_id = ? ORDER BY task_key`
      )
      .all(runId) as Array<{
      task_key: string;
      status: string;
      reopen_reason: string | null;
      repair_generation: number;
      repair_round_id: number | null;
    }>;
    expect(tasks).toEqual([
      {
        task_key: 'A1',
        status: 'pending',
        reopen_reason: 'repair',
        repair_generation: 1,
        repair_round_id: staged.repair_round_id,
      },
      {
        task_key: 'A2',
        status: 'pending',
        reopen_reason: 'repair',
        repair_generation: 1,
        repair_round_id: staged.repair_round_id,
      },
      {
        task_key: 'A3',
        status: 'complete',
        reopen_reason: null,
        repair_generation: 0,
        repair_round_id: null,
      },
    ]);
    expect((db.raw.prepare("SELECT COUNT(*) AS c FROM run_tasks WHERE status = 'deferred'").get() as { c: number }).c).toBe(
      0
    );

    const view = getRepairReopenView(db, staged.repair_round_id);
    expect(view.all_locked).toBe(true);
    expect(view.units.every((u) => u.status === 'pending' && u.locked)).toBe(true);

    // Enqueued: claim can land an implementer token for a reopened unit.
    const token = queue.claimNextReady(runId);
    expect(token).not.toBeNull();
    expect([taskIds.A1, taskIds.A2]).toContain(token!.taskId);

    // Dispatch gate: intact hash allows implementer dispatch (R5.2 / R5.3).
    const allowed = assertRepairImplementerDispatchAllowed(db, {
      runTaskId: token!.taskId,
      repoRoot: t.dir,
    });
    expect(allowed.ok).toBe(true);
    expect(allowed.repair_test_hash === lockedA1.repair_test_hash || allowed.repair_test_hash === lockedA2.repair_test_hash).toBe(
      true
    );
    expect(isRepairImplementerDispatchBlocked(db, runId, token!.taskId, t.dir)).toBe(false);

    // Second reopen refused (already pending).
    expect(() =>
      reopenAndEnqueueRepairRound(db, {
        repairRoundId: staged.repair_round_id,
        queue,
        repoRoot: t.dir,
      })
    ).toThrow(/already|pending/i);

    db.close();
  });

  it('refuses implementer dispatch when the locked repair test is weakened (R5.3)', () => {
    const t = tempDir('helm-fence-r3-weaken-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, fenceId, taskIds } = insertRepairFixture(db);
    const staged = beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1'],
    });
    const locked = lockUnit(db, {
      repairRoundId: staged.repair_round_id,
      taskKey: 'A1',
      repoRoot: t.dir,
      rel: 'repairs/A1.repair.test.ts',
      assertId: 'unit-A1-regression',
    });
    const originalHash = locked.repair_test_hash;
    expect(originalHash).toBe(hashTestFile(path.join(t.dir, locked.repair_test_path)));

    const queue = makeQueue(runId, [taskIds.A1]);
    reopenAndEnqueueRepairRound(db, {
      repairRoundId: staged.repair_round_id,
      queue,
      repoRoot: t.dir,
    });

    // Implementer weakens the assertion on disk.
    fs.appendFileSync(path.join(t.dir, locked.repair_test_path), `// weakened assertion\n`, 'utf8');
    expect(hashTestFile(path.join(t.dir, locked.repair_test_path))).not.toBe(originalHash);

    expect(() =>
      assertRepairImplementerDispatchAllowed(db, {
        repairRoundId: staged.repair_round_id,
        taskKey: 'A1',
        repoRoot: t.dir,
      })
    ).toThrow(FenceRepairRequeueError);
    expect(() =>
      assertRepairImplementerDispatchAllowed(db, {
        repairRoundId: staged.repair_round_id,
        taskKey: 'A1',
        repoRoot: t.dir,
      })
    ).toThrow(/hash|weakening|R5\.3/i);

    expect(isRepairImplementerDispatchBlocked(db, runId, taskIds.A1, t.dir)).toBe(true);

    // Durable lock still holds the original hash (fill-once; R2).
    const row = db.raw
      .prepare('SELECT repair_test_hash FROM fence_repair_units WHERE repair_round_id = ? AND task_key = ?')
      .get(staged.repair_round_id, 'A1') as { repair_test_hash: string };
    expect(row.repair_test_hash).toBe(originalHash);

    // Task remains pending with repair markers (weakening does not erase reopen).
    const task = db.raw
      .prepare('SELECT status, reopen_reason, repair_generation FROM run_tasks WHERE id = ?')
      .get(taskIds.A1) as { status: string; reopen_reason: string; repair_generation: number };
    expect(task).toEqual({
      status: 'pending',
      reopen_reason: 'repair',
      repair_generation: 1,
    });

    db.close();
  });

  it('refuses reopen itself when the test is weakened after lock but before reopen (R5.3)', () => {
    const t = tempDir('helm-fence-r3-pre-reopen-weaken-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, fenceId, taskIds } = insertRepairFixture(db);
    const staged = beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1'],
    });
    const locked = lockUnit(db, {
      repairRoundId: staged.repair_round_id,
      taskKey: 'A1',
      repoRoot: t.dir,
      rel: 'repairs/A1.repair.test.ts',
      assertId: 'unit-A1-regression',
    });

    fs.appendFileSync(path.join(t.dir, locked.repair_test_path), `// pre-reopen weaken\n`, 'utf8');

    const queue = makeQueue(runId, [taskIds.A1]);
    expect(() =>
      reopenAndEnqueueRepairRound(db, {
        repairRoundId: staged.repair_round_id,
        queue,
        repoRoot: t.dir,
      })
    ).toThrow(/hash|weakening|R5\.3/i);

    const task = db.raw
      .prepare('SELECT status, reopen_reason FROM run_tasks WHERE id = ?')
      .get(taskIds.A1) as { status: string; reopen_reason: string };
    expect(task.status).toBe('complete');
    expect(task.reopen_reason).toBe('repair');
    expect(queue.claimNextReady(runId)).toBeNull();
    db.close();
  });

  it('does not gate ordinary non-repair tasks (R3 boundary / ordinary unit gate)', () => {
    const t = tempDir('helm-fence-r3-ordinary-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, taskIds } = insertRepairFixture(db);
    // Flip A3 to pending without repair markers — ordinary unit.
    db.raw.prepare("UPDATE run_tasks SET status = 'pending' WHERE id = ?").run(taskIds.A3);
    expect(isRepairImplementerDispatchBlocked(db, runId, taskIds.A3, t.dir)).toBe(false);
    expect(() =>
      assertRepairImplementerDispatchAllowed(db, { runTaskId: taskIds.A3, repoRoot: t.dir })
    ).toThrow(/repair|dispatch/i);
    db.close();
  });
});
