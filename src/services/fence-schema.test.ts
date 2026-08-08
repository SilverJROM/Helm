/**
 * fence-workflow-upgrade A1 — two-track fence schema (R1.1, R1.2, R1.4).
 *
 * Fresh SCHEMA_SQL + guarded database.ts upgrade to v116 create:
 *   - fences: crash-legible lifecycle_state, contract fields, OPEN baseline cols
 *   - fence_members: unique (fence_id, task_key) membership
 * Migration must preserve existing rows and reopen idempotently (including on a
 * COPY of live data/helm.db when present).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';

const LIFECYCLE_STATES = [
  'declared',
  'opening',
  'draining',
  'closing',
  'repairing',
  'closed',
  'plan_blocked',
] as const;

const FENCE_COLUMNS = [
  'id',
  'fence_key',
  'run_id',
  'cycle_id',
  'lifecycle_state',
  'integration_cmd',
  'negative_control_cmd',
  'acceptance_ids',
  'test_path',
  'authored_by',
  'label',
  'open_failed_ids',
  'open_test_hash',
  'open_at',
  'created_at',
  'updated_at',
] as const;

const MEMBER_COLUMNS = ['id', 'fence_id', 'task_key', 'position', 'created_at'] as const;

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
  const projectId = (
    db.raw
      .prepare("INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id")
      .get(`fence-a1-${Date.now()}`, `/tmp/fence-a1-${Date.now()}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'A1', 'fence-schema') as { id: number }
  ).id;
  return { projectId, runId };
}

describe('A1 fence schema v116 (R1.1, R1.2, R1.4)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB exposes fences + fence_members contract at SCHEMA_VERSION', () => {
    const t = tempDbPath('helm-fence-a1-fresh-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);

    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(116);
    expect((db.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version).toBe(
      SCHEMA_VERSION
    );
    expect(tableNames(db).has('fences')).toBe(true);
    expect(tableNames(db).has('fence_members')).toBe(true);
    expect(columnNames(db, 'fences')).toEqual([...FENCE_COLUMNS]);
    expect(columnNames(db, 'fence_members')).toEqual([...MEMBER_COLUMNS]);

    const { runId } = insertProjectRun(db);
    const fenceId = (
      db.raw
        .prepare(
          `INSERT INTO fences (
             fence_key, run_id, lifecycle_state,
             integration_cmd, negative_control_cmd, acceptance_ids,
             test_path, authored_by, label
           ) VALUES (?, ?, 'declared', ?, ?, ?, ?, ?, ?)
           RETURNING id`
        )
        .get(
          'I1',
          runId,
          'echo integration',
          'echo negative',
          JSON.stringify(['R1.1', 'R1.2', 'R1.4']),
          'src/services/fence-f1-contract.integration.test.ts',
          'integration_test_agent',
          'F1 plan-contract'
        ) as { id: number }
    ).id;

    const fence = db.raw.prepare('SELECT * FROM fences WHERE id = ?').get(fenceId) as any;
    expect(fence).toMatchObject({
      fence_key: 'I1',
      run_id: runId,
      lifecycle_state: 'declared',
      integration_cmd: 'echo integration',
      negative_control_cmd: 'echo negative',
      acceptance_ids: JSON.stringify(['R1.1', 'R1.2', 'R1.4']),
      test_path: 'src/services/fence-f1-contract.integration.test.ts',
      authored_by: 'integration_test_agent',
      open_failed_ids: null,
      open_test_hash: null,
      open_at: null,
    });

    db.raw
      .prepare('INSERT INTO fence_members (fence_id, task_key, position) VALUES (?, ?, ?)')
      .run(fenceId, 'A1', 0);
    db.raw
      .prepare('INSERT INTO fence_members (fence_id, task_key, position) VALUES (?, ?, ?)')
      .run(fenceId, 'A2', 1);

    const members = db.raw
      .prepare('SELECT task_key, position FROM fence_members WHERE fence_id = ? ORDER BY position')
      .all(fenceId) as Array<{ task_key: string; position: number }>;
    expect(members).toEqual([
      { task_key: 'A1', position: 0 },
      { task_key: 'A2', position: 1 },
    ]);

    // Unique membership (R1.1/R1.4 inspectable unit↔fence)
    expect(() =>
      db.raw
        .prepare('INSERT INTO fence_members (fence_id, task_key, position) VALUES (?, ?, ?)')
        .run(fenceId, 'A1', 2)
    ).toThrow(/unique|constraint/i);

    // Unique (run_id, fence_key)
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO fences (fence_key, run_id, integration_cmd, negative_control_cmd)
           VALUES (?, ?, 'x', 'y')`
        )
        .run('I1', runId)
    ).toThrow(/unique|constraint/i);

    // lifecycle_state CHECK accepts every crash-legible value and rejects unknown
    for (const state of LIFECYCLE_STATES) {
      db.raw.prepare('UPDATE fences SET lifecycle_state = ? WHERE id = ?').run(state, fenceId);
      expect(
        (db.raw.prepare('SELECT lifecycle_state FROM fences WHERE id = ?').get(fenceId) as any)
          .lifecycle_state
      ).toBe(state);
    }
    expect(() =>
      db.raw.prepare("UPDATE fences SET lifecycle_state = 'open' WHERE id = ?").run(fenceId)
    ).toThrow(/check|constraint/i);

    // OPEN baseline columns are writable and inspectable via SQL (R1.4 / R2.2 shape)
    db.raw
      .prepare(
        `UPDATE fences
         SET open_failed_ids = ?, open_test_hash = ?, open_at = datetime('now'), lifecycle_state = 'draining'
         WHERE id = ?`
      )
      .run(JSON.stringify(['R1.1', 'R1.2']), 'sha256:deadbeef', fenceId);
    const openRow = db.raw
      .prepare('SELECT open_failed_ids, open_test_hash, open_at, lifecycle_state FROM fences WHERE id = ?')
      .get(fenceId) as any;
    expect(openRow.open_failed_ids).toBe(JSON.stringify(['R1.1', 'R1.2']));
    expect(openRow.open_test_hash).toBe('sha256:deadbeef');
    expect(openRow.open_at).toBeTruthy();
    expect(openRow.lifecycle_state).toBe('draining');

    expect(db.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    db.close();
  });

  it('upgrades a v115 DB without clobbering rows and reopens idempotently', () => {
    const t = tempDbPath('helm-fence-a1-upgrade-');
    cleanups.push(t.cleanup);

    // Seed at current schema, then roll back tables+version to simulate pre-A1 live DB.
    const seeded = new DatabaseService(t.dbPath);
    seeded.raw.prepare('INSERT INTO projects (name, directory) VALUES (?, ?)').run('a1-preserved', '/tmp/a1-preserved');
    const projectCount = (seeded.raw.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c;
    seeded.raw.exec('DROP TABLE IF EXISTS fence_members');
    seeded.raw.exec('DROP TABLE IF EXISTS fences');
    seeded.raw.prepare('UPDATE schema_version SET version = 115').run();
    seeded.close();

    const migrated = new DatabaseService(t.dbPath);
    expect(tableNames(migrated).has('fences')).toBe(true);
    expect(tableNames(migrated).has('fence_members')).toBe(true);
    expect(columnNames(migrated, 'fences')).toEqual([...FENCE_COLUMNS]);
    expect(columnNames(migrated, 'fence_members')).toEqual([...MEMBER_COLUMNS]);
    expect(
      (migrated.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version
    ).toBe(SCHEMA_VERSION);
    expect(migrated.raw.prepare('SELECT directory FROM projects WHERE name = ?').get('a1-preserved')).toMatchObject({
      directory: '/tmp/a1-preserved',
    });
    expect((migrated.raw.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c).toBe(
      projectCount
    );

    const { runId } = insertProjectRun(migrated);
    const fenceId = (
      migrated.raw
        .prepare(
          `INSERT INTO fences (fence_key, run_id, integration_cmd, negative_control_cmd, acceptance_ids)
           VALUES ('I2', ?, 'cmd', 'nc', '["R2.1"]') RETURNING id`
        )
        .get(runId) as { id: number }
    ).id;
    migrated.raw
      .prepare('INSERT INTO fence_members (fence_id, task_key) VALUES (?, ?)')
      .run(fenceId, 'B1');
    expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    migrated.close();

    // Reopen: version stable, rows intact, no second migration damage
    const reopened = new DatabaseService(t.dbPath);
    expect(
      (reopened.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version
    ).toBe(SCHEMA_VERSION);
    expect(
      reopened.raw
        .prepare(
          `SELECT f.fence_key, f.lifecycle_state, m.task_key
           FROM fences f JOIN fence_members m ON m.fence_id = f.id
           WHERE f.fence_key = 'I2'`
        )
        .get()
    ).toEqual({ fence_key: 'I2', lifecycle_state: 'declared', task_key: 'B1' });
    expect(reopened.raw.prepare('SELECT directory FROM projects WHERE name = ?').get('a1-preserved')).toMatchObject({
      directory: '/tmp/a1-preserved',
    });
    expect(reopened.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    reopened.close();
  });

  it('copy/reopen migration on live data/helm.db (when present) reaches SCHEMA_VERSION with fence tables', () => {
    const livePath = path.join(process.cwd(), 'data/helm.db');
    if (!fs.existsSync(livePath)) {
      expect(true).toBe(true); // no live copy in this env; fresh + upgrade paths cover
      return;
    }

    const t = tempDbPath('helm-fence-a1-livecopy-');
    cleanups.push(t.cleanup);
    fs.copyFileSync(livePath, t.dbPath);

    // Snapshot pre-migration row counts for a few durable tables (if present)
    const pre = new DatabaseService(t.dbPath);
    // Opening already migrates; capture counts after first open then reopen.
    const afterFirst = {
      version: (pre.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version,
      projects: (pre.raw.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c,
      agents: tableNames(pre).has('agents')
        ? (pre.raw.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c
        : 0,
      fences: (pre.raw.prepare('SELECT COUNT(*) AS c FROM fences').get() as { c: number }).c,
      fence_members: (pre.raw.prepare('SELECT COUNT(*) AS c FROM fence_members').get() as { c: number }).c,
    };
    expect(afterFirst.version).toBe(SCHEMA_VERSION);
    expect(tableNames(pre).has('fences')).toBe(true);
    expect(tableNames(pre).has('fence_members')).toBe(true);
    expect(columnNames(pre, 'fences')).toEqual([...FENCE_COLUMNS]);
    expect(pre.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    pre.close();

    const reopened = new DatabaseService(t.dbPath);
    expect(
      (reopened.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version
    ).toBe(SCHEMA_VERSION);
    expect((reopened.raw.prepare('SELECT COUNT(*) AS c FROM projects').get() as { c: number }).c).toBe(
      afterFirst.projects
    );
    if (tableNames(reopened).has('agents')) {
      expect((reopened.raw.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c).toBe(
        afterFirst.agents
      );
    }
    expect((reopened.raw.prepare('SELECT COUNT(*) AS c FROM fences').get() as { c: number }).c).toBe(
      afterFirst.fences
    );
    expect(
      (reopened.raw.prepare('SELECT COUNT(*) AS c FROM fence_members').get() as { c: number }).c
    ).toBe(afterFirst.fence_members);
    expect(reopened.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    reopened.close();
  });
});
