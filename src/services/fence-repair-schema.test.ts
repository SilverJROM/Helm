/**
 * fence-workflow-upgrade R1 -- repair rounds/units schema + staged state (R5.1, R5.5).
 *
 * This slice creates the durable repair history and current run_tasks admission
 * fields. It deliberately does not reopen selected units; later repair slices own
 * complete->pending and queue reentry. Repair is never represented as deferred.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import {
  beginFenceRepairRound,
  FenceRepairSchemaError,
} from './fence-repair-schema.js';

const REPAIR_ROUND_COLUMNS = [
  'id',
  'fence_id',
  'run_id',
  'fence_key',
  'round_number',
  'fault_class',
  'status',
  'failing_units',
  'verdict_fingerprint',
  'created_at',
] as const;

const REPAIR_UNIT_COLUMNS = [
  'id',
  'repair_round_id',
  'fence_id',
  'run_id',
  'run_task_id',
  'task_key',
  'repair_generation',
  'prior_status',
  // v119 / R2 fill-once hash lock (NULL until lockFenceRepairUnitTest)
  'repair_test_path',
  'repair_test_hash',
  'repair_assert_ids',
  'authored_by',
  'locked_at',
  'created_at',
] as const;

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dbPath: path.join(dir, 'helm.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function tableNames(db: DatabaseService): Set<string> {
  const rows = db.raw
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all() as Array<{ name: string }>;
  return new Set(rows.map((r) => r.name));
}

function columnNames(db: DatabaseService, table: string): string[] {
  return (db.raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (c) => c.name
  );
}

function insertProjectRun(db: DatabaseService): { projectId: number; runId: number } {
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const projectId = (
    db.raw
      .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get(`fence-r1-${suffix}`, `/tmp/fence-r1-${suffix}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'R1', 'fence-repair-schema') as { id: number }
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
        .get(runId, JSON.stringify(['R5.1', 'R5.5']), 'src/services/fence-f4-repair.integration.test.ts') as {
        id: number;
      }
    ).id
  );
  for (const [position, taskKey] of ['A1', 'A2', 'A3'].entries()) {
    db.raw
      .prepare('INSERT INTO fence_members (fence_id, task_key, position) VALUES (?, ?, ?)')
      .run(fenceId, taskKey, position);
  }
  return { runId, fenceId, taskIds };
}

describe('R1 repair schema + staged round admission (R5.1, R5.5)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB exposes repair history tables and run_tasks admission fields at SCHEMA_VERSION', () => {
    const t = tempDbPath('helm-fence-r1-fresh-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(119);
    expect((db.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(
      SCHEMA_VERSION
    );
    expect(tableNames(db).has('fence_repair_rounds')).toBe(true);
    expect(tableNames(db).has('fence_repair_units')).toBe(true);
    expect(columnNames(db, 'fence_repair_rounds')).toEqual([...REPAIR_ROUND_COLUMNS]);
    expect(columnNames(db, 'fence_repair_units')).toEqual([...REPAIR_UNIT_COLUMNS]);
    expect(columnNames(db, 'run_tasks')).toEqual(
      expect.arrayContaining(['reopen_reason', 'repair_generation', 'repair_round_id'])
    );

    const { runId, fenceId } = insertRepairFixture(db);
    const result = beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1', 'A2'],
      verdictFingerprint: 'fp1:r1',
    });

    expect(result).toMatchObject({
      fence_id: fenceId,
      run_id: runId,
      fence_key: 'I4',
      round_number: 1,
      status: 'staged',
      failing_units: ['A1', 'A2'],
    });
    expect(result.units.map((u) => [u.task_key, u.prior_status, u.repair_generation])).toEqual([
      ['A1', 'complete', 1],
      ['A2', 'complete', 1],
    ]);

    const round = db.raw
      .prepare('SELECT fault_class, status, failing_units, verdict_fingerprint FROM fence_repair_rounds WHERE id = ?')
      .get(result.repair_round_id) as any;
    expect(round).toEqual({
      fault_class: 'implementation',
      status: 'staged',
      failing_units: JSON.stringify(['A1', 'A2']),
      verdict_fingerprint: 'fp1:r1',
    });

    const tasks = db.raw
      .prepare(
        `SELECT task_key, status, reopen_reason, repair_generation, repair_round_id
         FROM run_tasks WHERE run_id = ? ORDER BY task_key`
      )
      .all(runId) as any[];
    expect(tasks).toEqual([
      {
        task_key: 'A1',
        status: 'complete',
        reopen_reason: 'repair',
        repair_generation: 1,
        repair_round_id: result.repair_round_id,
      },
      {
        task_key: 'A2',
        status: 'complete',
        reopen_reason: 'repair',
        repair_generation: 1,
        repair_round_id: result.repair_round_id,
      },
      {
        task_key: 'A3',
        status: 'complete',
        reopen_reason: null,
        repair_generation: 0,
        repair_round_id: null,
      },
    ]);
    expect((db.raw.prepare("SELECT COUNT(*) AS c FROM run_tasks WHERE status = 'deferred'").get() as any).c).toBe(0);
    expect((db.raw.prepare('SELECT lifecycle_state FROM fences WHERE id = ?').get(fenceId) as any).lifecycle_state).toBe(
      'repairing'
    );
    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('enforces the two-unit localization ceiling and member-only repair admission atomically', () => {
    const t = tempDbPath('helm-fence-r1-guards-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const { runId, fenceId } = insertRepairFixture(db);

    expect(() =>
      beginFenceRepairRound(db, {
        fenceId,
        faultClass: 'implementation',
        failingUnits: ['A1', 'A2', 'A3'],
      })
    ).toThrow(FenceRepairSchemaError);
    expect(() =>
      beginFenceRepairRound(db, {
        fenceId,
        faultClass: 'implementation',
        failingUnits: ['A1', 'NOT-A-MEMBER'],
      })
    ).toThrow(FenceRepairSchemaError);
    expect(() =>
      beginFenceRepairRound(db, {
        fenceId,
        faultClass: 'plan',
        failingUnits: ['A1'],
      })
    ).toThrow(FenceRepairSchemaError);

    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM fence_repair_rounds').get() as any).c).toBe(0);
    expect(
      (
        db.raw
          .prepare(
            `SELECT COUNT(*) AS c FROM run_tasks
             WHERE run_id = ? AND (reopen_reason IS NOT NULL OR repair_generation != 0 OR repair_round_id IS NOT NULL)`
          )
          .get(runId) as any
      ).c
    ).toBe(0);
    db.close();
  });

  it('rejects deferred units instead of encoding repair by overloading deferred', () => {
    const t = tempDbPath('helm-fence-r1-deferred-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const { runId, fenceId, taskIds } = insertRepairFixture(db);
    db.raw.prepare("UPDATE run_tasks SET status = 'deferred' WHERE id = ?").run(taskIds.A1);

    expect(() =>
      beginFenceRepairRound(db, {
        fenceId,
        faultClass: 'implementation',
        failingUnits: ['A1'],
      })
    ).toThrow(/deferred/i);

    expect((db.raw.prepare('SELECT COUNT(*) AS c FROM fence_repair_rounds').get() as any).c).toBe(0);
    expect(
      db.raw
        .prepare('SELECT status, reopen_reason, repair_generation, repair_round_id FROM run_tasks WHERE run_id = ? AND task_key = ?')
        .get(runId, 'A1')
    ).toEqual({
      status: 'deferred',
      reopen_reason: null,
      repair_generation: 0,
      repair_round_id: null,
    });
    db.close();
  });

  it('keeps repair history append-only after a round is staged', () => {
    const t = tempDbPath('helm-fence-r1-append-only-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const { fenceId } = insertRepairFixture(db);
    const result = beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1'],
    });
    const unitId = (db.raw.prepare('SELECT id FROM fence_repair_units WHERE repair_round_id = ?').get(result.repair_round_id) as any).id;

    expect(() =>
      db.raw.prepare("UPDATE fence_repair_rounds SET status = 'active' WHERE id = ?").run(result.repair_round_id)
    ).toThrow(/append-only/i);
    expect(() =>
      db.raw.prepare('DELETE FROM fence_repair_units WHERE id = ?').run(unitId)
    ).toThrow(/append-only/i);
    db.close();
  });

  it('upgrades a v117 DB idempotently without clobbering rows', () => {
    const t = tempDbPath('helm-fence-r1-upgrade-');
    cleanups.push(t.cleanup);

    const seeded = new DatabaseService(t.dbPath);
    insertRepairFixture(seeded);
    seeded.raw.exec(`
      DROP TRIGGER IF EXISTS fence_repair_units_no_delete;
      DROP TRIGGER IF EXISTS fence_repair_units_no_update;
      DROP TRIGGER IF EXISTS fence_repair_rounds_no_delete;
      DROP TRIGGER IF EXISTS fence_repair_rounds_no_update;
      DROP TABLE IF EXISTS fence_repair_units;
      DROP TABLE IF EXISTS fence_repair_rounds;
      ALTER TABLE run_tasks DROP COLUMN repair_round_id;
      ALTER TABLE run_tasks DROP COLUMN repair_generation;
      ALTER TABLE run_tasks DROP COLUMN reopen_reason;
      UPDATE schema_version SET version = 117;
    `);
    seeded.close();

    const migrated = new DatabaseService(t.dbPath);
    expect((migrated.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(
      SCHEMA_VERSION
    );
    expect(tableNames(migrated).has('fence_repair_rounds')).toBe(true);
    expect(tableNames(migrated).has('fence_repair_units')).toBe(true);
    expect(columnNames(migrated, 'run_tasks')).toEqual(
      expect.arrayContaining(['reopen_reason', 'repair_generation', 'repair_round_id'])
    );
    expect((migrated.raw.prepare('SELECT COUNT(*) AS c FROM run_tasks').get() as any).c).toBe(3);
    expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    migrated.close();

    const reopened = new DatabaseService(t.dbPath);
    expect((reopened.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(
      SCHEMA_VERSION
    );
    expect((reopened.raw.prepare('SELECT COUNT(*) AS c FROM run_tasks').get() as any).c).toBe(3);
    expect(reopened.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    reopened.close();
  });
});

