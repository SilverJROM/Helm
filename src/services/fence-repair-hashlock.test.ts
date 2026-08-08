/**
 * fence-workflow-upgrade R2 — validator-authored repair test hash-lock (R5.1–R5.3).
 *
 * Covers: ordinary-validator author gate, red-verify collection + named assert
 * failure on HEAD, fill-once lock on fence_repair_units, SQL-inspectable hash
 * artifact, no reopen, refuse green/infra, refuse re-lock / weakened test.
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { beginFenceRepairRound } from './fence-repair-schema.js';
import {
  areAllRepairRoundUnitsLocked,
  assertRepairTestHashIntact,
  FenceRepairHashlockError,
  getFenceRepairUnitLock,
  hashTestFile,
  isOrdinaryValidatorAuthor,
  lockFenceRepairUnitTest,
} from './fence-repair-hashlock.js';
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
      .get(`fence-r2-${suffix}`, `/tmp/fence-r2-${suffix}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'R2', 'fence-repair-hashlock') as { id: number }
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

function writeRepairTest(repoRoot: string, body: string, rel = 'repairs/A1.repair.test.ts'): string {
  const abs = path.join(repoRoot, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body, 'utf8');
  return rel;
}

function injectReport(report: FenceReportV1): NonNullable<
  Parameters<typeof lockFenceRepairUnitTest>[1]['runCommand']
> {
  return () => {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-fence-r2-rep-'));
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

describe('R2 fence-repair-hashlock (R5.1, R5.2, R5.3)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB exposes fill-once lock columns on fence_repair_units at SCHEMA_VERSION ≥119', () => {
    const t = tempDir('helm-fence-r2-schema-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(119);
    expect((db.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(
      SCHEMA_VERSION
    );
    const cols = new Set(
      (db.raw.prepare('PRAGMA table_info(fence_repair_units)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    for (const c of [
      'repair_test_path',
      'repair_test_hash',
      'repair_assert_ids',
      'authored_by',
      'locked_at',
    ]) {
      expect(cols.has(c)).toBe(true);
    }
    db.close();
  });

  it('ordinary validator author gate accepts validator ladder and refuses implementer (R5.1)', () => {
    expect(isOrdinaryValidatorAuthor('validator')).toBe(true);
    expect(isOrdinaryValidatorAuthor('validator.L2')).toBe(true);
    expect(isOrdinaryValidatorAuthor('validator_L3')).toBe(true);
    expect(isOrdinaryValidatorAuthor('implementer')).toBe(false);
    expect(isOrdinaryValidatorAuthor('integration_test_agent')).toBe(false);
    expect(isOrdinaryValidatorAuthor('')).toBe(false);
  });

  it('red-verifies collection + named assert failure, hash-locks fence_repair_units, does not reopen (R5.1–R5.3)', () => {
    const t = tempDir('helm-fence-r2-lock-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { runId, fenceId, taskIds } = insertRepairFixture(db);
    const staged = beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1', 'A2'],
      verdictFingerprint: 'fp1:r2',
    });

    const testPath = writeRepairTest(
      t.dir,
      `// validator-authored repair test for A1\nexport const ids = ['unit-A1-regression'];\n`
    );
    const expectedHash = hashTestFile(path.join(t.dir, testPath));

    const report = buildFenceReport({
      collected: ['unit-A1-regression', 'unit-A1-setup'],
      passed: ['unit-A1-setup'],
      failed: [{ id: 'unit-A1-regression', kind: 'assert' }],
    });

    const result = lockFenceRepairUnitTest(db, {
      repairRoundId: staged.repair_round_id,
      taskKey: 'A1',
      repairTestPath: testPath,
      authoredBy: 'validator.L2',
      repoRoot: t.dir,
      cwd: t.dir,
      expectedAssertIds: ['unit-A1-regression'],
      runCommand: injectReport(report),
    });

    expect(result.ok).toBe(true);
    expect(result.task_key).toBe('A1');
    expect(result.authored_by).toBe('validator.L2');
    expect(result.repair_test_hash).toBe(expectedHash);
    expect(result.repair_test_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(result.repair_assert_ids).toEqual(['unit-A1-regression']);
    expect(result.locked_at).toBeTruthy();

    // Durable SQL-inspectable lock on fence_repair_units (R5.2).
    const row = db.raw
      .prepare(
        `SELECT task_key, repair_test_path, repair_test_hash, repair_assert_ids,
                authored_by, locked_at
         FROM fence_repair_units WHERE id = ?`
      )
      .get(result.repair_unit_id) as {
      task_key: string;
      repair_test_path: string;
      repair_test_hash: string;
      repair_assert_ids: string;
      authored_by: string;
      locked_at: string;
    };
    expect(row.task_key).toBe('A1');
    expect(row.repair_test_path).toBe(testPath);
    expect(row.repair_test_hash).toBe(expectedHash);
    expect(JSON.parse(row.repair_assert_ids)).toEqual(['unit-A1-regression']);
    expect(row.authored_by).toBe('validator.L2');
    expect(row.locked_at).toBeTruthy();

    const view = getFenceRepairUnitLock(db, { repairUnitId: result.repair_unit_id });
    expect(view.locked).toBe(true);
    expect(view.repair_assert_ids).toEqual(['unit-A1-regression']);

    // Artifact on disk path + matching hash record (R5.2).
    const artifact = db.raw
      .prepare('SELECT run_id, type, path, sha FROM artifacts WHERE id = ?')
      .get(result.artifactId) as { run_id: number; type: string; path: string; sha: string };
    expect(artifact.run_id).toBe(runId);
    expect(artifact.type).toBe('fence-repair-hashlock');
    expect(artifact.path).toBe(testPath);
    expect(artifact.sha).toBe(expectedHash);

    // R2 does not reopen — status stays complete (R3 owns complete→pending).
    const task = db.raw
      .prepare('SELECT status, reopen_reason, repair_generation FROM run_tasks WHERE id = ?')
      .get(taskIds.A1) as { status: string; reopen_reason: string; repair_generation: number };
    expect(task.status).toBe('complete');
    expect(task.reopen_reason).toBe('repair');
    expect(task.repair_generation).toBe(1);

    // Round not fully locked until every named unit is locked.
    expect(areAllRepairRoundUnitsLocked(db, staged.repair_round_id)).toBe(false);

    const testPath2 = writeRepairTest(
      t.dir,
      `// validator-authored repair test for A2\nexport const ids = ['unit-A2-regression'];\n`,
      'repairs/A2.repair.test.ts'
    );
    lockFenceRepairUnitTest(db, {
      repairRoundId: staged.repair_round_id,
      taskKey: 'A2',
      repairTestPath: testPath2,
      authoredBy: 'validator',
      repoRoot: t.dir,
      cwd: t.dir,
      runCommand: injectReport(
        buildFenceReport({
          collected: ['unit-A2-regression'],
          failed: [{ id: 'unit-A2-regression', kind: 'fail' }],
        })
      ),
    });
    expect(areAllRepairRoundUnitsLocked(db, staged.repair_round_id)).toBe(true);

    // R5.3: intact hash passes.
    expect(
      assertRepairTestHashIntact(db, {
        repairUnitId: result.repair_unit_id,
        repoRoot: t.dir,
      }).ok
    ).toBe(true);

    db.close();
  });

  it('refuses green HEAD and infrastructure-only red (R5.2 collect + named assert)', () => {
    const t = tempDir('helm-fence-r2-refuse-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { fenceId } = insertRepairFixture(db);
    const staged = beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1'],
    });
    const testPath = writeRepairTest(t.dir, `// green fixture\n`);

    expect(() =>
      lockFenceRepairUnitTest(db, {
        repairRoundId: staged.repair_round_id,
        taskKey: 'A1',
        repairTestPath: testPath,
        repoRoot: t.dir,
        runCommand: injectReport(
          buildFenceReport({
            collected: ['unit-A1-regression'],
            passed: ['unit-A1-regression'],
          })
        ),
      })
    ).toThrow(/proving|nothing failed|already exists/i);

    expect(() =>
      lockFenceRepairUnitTest(db, {
        repairRoundId: staged.repair_round_id,
        taskKey: 'A1',
        repairTestPath: testPath,
        repoRoot: t.dir,
        runCommand: injectReport(
          buildFenceReport({
            collected: [],
            failed: [{ id: 'unit-A1-regression', kind: 'assert' }],
          })
        ),
      })
    ).toThrow(/collect/i);

    expect(() =>
      lockFenceRepairUnitTest(db, {
        repairRoundId: staged.repair_round_id,
        taskKey: 'A1',
        repairTestPath: testPath,
        repoRoot: t.dir,
        runCommand: injectReport(
          buildFenceReport({
            collected: ['unit-A1-regression'],
            failed: [{ id: 'unit-A1-regression', kind: 'import' }],
          })
        ),
      })
    ).toThrow(/infrastructure|proving/i);

    // No partial lock written.
    const unit = db.raw
      .prepare(
        'SELECT repair_test_hash, repair_test_path, locked_at FROM fence_repair_units WHERE repair_round_id = ?'
      )
      .get(staged.repair_round_id) as {
      repair_test_hash: string | null;
      repair_test_path: string | null;
      locked_at: string | null;
    };
    expect(unit.repair_test_hash).toBeNull();
    expect(unit.repair_test_path).toBeNull();
    expect(unit.locked_at).toBeNull();
    expect(
      (
        db.raw
          .prepare("SELECT COUNT(*) AS c FROM artifacts WHERE type = 'fence-repair-hashlock'")
          .get() as { c: number }
      ).c
    ).toBe(0);
    db.close();
  });

  it('refuses implementer author and refuses re-lock / weakened test hash (R5.1, R5.3)', () => {
    const t = tempDir('helm-fence-r2-r53-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { fenceId } = insertRepairFixture(db);
    const staged = beginFenceRepairRound(db, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1'],
    });
    const testPath = writeRepairTest(t.dir, `// original locked body\nexport const a = 1;\n`);

    expect(() =>
      lockFenceRepairUnitTest(db, {
        repairRoundId: staged.repair_round_id,
        taskKey: 'A1',
        repairTestPath: testPath,
        authoredBy: 'implementer',
        repoRoot: t.dir,
        runCommand: injectReport(
          buildFenceReport({
            collected: ['x'],
            failed: [{ id: 'x', kind: 'assert' }],
          })
        ),
      })
    ).toThrow(FenceRepairHashlockError);
    expect(() =>
      lockFenceRepairUnitTest(db, {
        repairRoundId: staged.repair_round_id,
        taskKey: 'A1',
        repairTestPath: testPath,
        authoredBy: 'implementer',
        repoRoot: t.dir,
        runCommand: injectReport(
          buildFenceReport({
            collected: ['x'],
            failed: [{ id: 'x', kind: 'assert' }],
          })
        ),
      })
    ).toThrow(/validator/i);

    const locked = lockFenceRepairUnitTest(db, {
      repairRoundId: staged.repair_round_id,
      taskKey: 'A1',
      repairTestPath: testPath,
      authoredBy: 'validator',
      repoRoot: t.dir,
      runCommand: injectReport(
        buildFenceReport({
          collected: ['unit-A1-regression'],
          failed: [{ id: 'unit-A1-regression', kind: 'assert' }],
        })
      ),
    });
    const originalHash = locked.repair_test_hash;

    // Re-lock refused (fill-once).
    expect(() =>
      lockFenceRepairUnitTest(db, {
        repairUnitId: locked.repair_unit_id,
        repairTestPath: testPath,
        repoRoot: t.dir,
        runCommand: injectReport(
          buildFenceReport({
            collected: ['unit-A1-regression'],
            failed: [{ id: 'unit-A1-regression', kind: 'assert' }],
          })
        ),
      })
    ).toThrow(/already hash-locked|R5\.3/i);

    // Direct UPDATE of lock hash refused by fill-once trigger.
    expect(() =>
      db.raw
        .prepare("UPDATE fence_repair_units SET repair_test_hash = 'sha256:deadbeef' WHERE id = ?")
        .run(locked.repair_unit_id)
    ).toThrow(/append-only|fill-once/i);

    // Weakening the file on disk is caught by assertRepairTestHashIntact (R5.3).
    fs.appendFileSync(path.join(t.dir, testPath), `// weakened assertion\n`, 'utf8');
    expect(() =>
      assertRepairTestHashIntact(db, {
        repairUnitId: locked.repair_unit_id,
        repoRoot: t.dir,
      })
    ).toThrow(/hash|weakening|R5\.3/i);

    // Durable lock still holds the original hash.
    const row = db.raw
      .prepare('SELECT repair_test_hash FROM fence_repair_units WHERE id = ?')
      .get(locked.repair_unit_id) as { repair_test_hash: string };
    expect(row.repair_test_hash).toBe(originalHash);
    db.close();
  });

  it('upgrades a v118 DB with lock columns and fill-once trigger without clobbering staged units', () => {
    const t = tempDir('helm-fence-r2-mig-');
    cleanups.push(t.cleanup);

    const seeded = new DatabaseService(path.join(t.dir, 'helm.db'));
    const { fenceId } = insertRepairFixture(seeded);
    const staged = beginFenceRepairRound(seeded, {
      fenceId,
      faultClass: 'implementation',
      failingUnits: ['A1'],
    });
    // Simulate a pure v118 surface: drop lock columns + hard no-update, pin version.
    seeded.raw.exec(`
      DROP TRIGGER IF EXISTS fence_repair_units_no_update;
      CREATE TRIGGER fence_repair_units_no_update
      BEFORE UPDATE ON fence_repair_units
      BEGIN
        SELECT RAISE(ABORT, 'fence repair units are append-only');
      END;
    `);
    // SQLite cannot DROP COLUMN reliably across all ages; emulate pre-v119 by
    // nulling lock fields and pinning version so migration re-applies trigger.
    seeded.raw.prepare('UPDATE schema_version SET version = 118').run();
    seeded.close();

    const migrated = new DatabaseService(path.join(t.dir, 'helm.db'));
    expect((migrated.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(
      SCHEMA_VERSION
    );
    const cols = new Set(
      (migrated.raw.prepare('PRAGMA table_info(fence_repair_units)').all() as Array<{ name: string }>).map(
        (c) => c.name
      )
    );
    expect(cols.has('repair_test_hash')).toBe(true);
    expect(
      (
        migrated.raw
          .prepare('SELECT COUNT(*) AS c FROM fence_repair_units WHERE repair_round_id = ?')
          .get(staged.repair_round_id) as { c: number }
      ).c
    ).toBe(1);

    const testPath = writeRepairTest(t.dir, `// post-migration lock\n`);
    const result = lockFenceRepairUnitTest(migrated, {
      repairRoundId: staged.repair_round_id,
      taskKey: 'A1',
      repairTestPath: testPath,
      repoRoot: t.dir,
      runCommand: injectReport(
        buildFenceReport({
          collected: ['post-mig'],
          failed: [{ id: 'post-mig', kind: 'assert' }],
        })
      ),
    });
    expect(result.repair_test_hash).toMatch(/^sha256:/);

    // History still immutable for non-lock columns.
    expect(() =>
      migrated.raw
        .prepare("UPDATE fence_repair_units SET prior_status = 'failed' WHERE id = ?")
        .run(result.repair_unit_id)
    ).toThrow(/append-only|fill-once/i);
    migrated.close();
  });
});
