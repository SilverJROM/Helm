/**
 * cycle-branch-lifecycle B1 — schema v113: cycles.status CHECK gains 'archived' (R1.1), plus
 * nullable server-owned git identity (git_base_branch, git_branch, git_worktree_path,
 * git_worktree_id, git_merged_at) and awaiting_merge/git_cleanup_pending flags (R4.2, R6.1).
 * Table rebuild — SQLite cannot ALTER a CHECK. cycles is an FK target (runs.cycle_id among
 * others), so this proves the rebuild preserves that relationship (precedent: v91 runs / v108
 * helm_sessions rebuilds in database.ts).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';

const NEW_CYCLE_COLUMNS = [
  'git_base_branch',
  'git_branch',
  'git_worktree_path',
  'git_worktree_id',
  'git_merged_at',
  'awaiting_merge',
  'git_cleanup_pending',
];

function withTempDb<T>(fn: (dbPath: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-cbl-b1-'));
  const dbPath = path.join(dir, 't.db');
  try {
    return fn(dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function withTempDbAsync<T>(fn: (dbPath: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-cbl-b1-'));
  const dbPath = path.join(dir, 't.db');
  try {
    return await fn(dbPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('cycle-branch-lifecycle B1: cycles schema v113 (fresh DB)', () => {
  it('SCHEMA_VERSION is >=113 and cycles carries all 7 new columns', () => {
    withTempDb((dbPath) => {
      const dbs = new DatabaseService(dbPath);
      // SCHEMA_VERSION tracks the live tip (v114+); do not pin a stale integer (see
      // phase-role-migration.test.ts). This test proves the v113 cycles rebuild, not the tip.
      expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(113);
      const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
      expect(ver).toBe(SCHEMA_VERSION);

      const cols = (dbs.raw.prepare('PRAGMA table_info(cycles)').all() as any[]).map((c) => c.name);
      for (const col of NEW_CYCLE_COLUMNS) {
        expect(cols).toContain(col);
      }
      dbs.close();
    });
  });

  it("status='archived' accepted, status='bogus' rejected, foreign_key_check empty", () => {
    withTempDb((dbPath) => {
      const dbs = new DatabaseService(dbPath);
      dbs.raw.prepare(
        `INSERT INTO projects (name, directory) VALUES ('cbl-b1-proj', '/tmp/cbl-b1-proj')`
      ).run();
      const projectId = (dbs.raw.prepare(`SELECT id FROM projects WHERE name = 'cbl-b1-proj'`).get() as any).id;

      const row = dbs.raw.prepare(
        `INSERT INTO cycles (project_id, name, folder_name, autonomy, status)
         VALUES (?, 'c1', 'c1_0101', 'pause_after_planning', 'active') RETURNING id`
      ).get(projectId) as any;

      expect(() =>
        dbs.raw.prepare(`UPDATE cycles SET status = 'archived' WHERE id = ?`).run(row.id)
      ).not.toThrow();
      expect((dbs.raw.prepare('SELECT status FROM cycles WHERE id = ?').get(row.id) as any).status).toBe('archived');

      expect(() =>
        dbs.raw.prepare(`UPDATE cycles SET status = 'bogus' WHERE id = ?`).run(row.id)
      ).toThrow();

      expect(dbs.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      dbs.close();
    });
  });

  it('CycleService.createCycle: new cycle has NULL git identity and false awaiting_merge/git_cleanup_pending', async () => {
    await withTempDbAsync(async (dbPath) => {
      const dbs = new DatabaseService(dbPath);
      const projects = new ProjectService(dbs);
      const cycles = new CycleService(dbs, projects);
      const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-cbl-b1-proj-'));
      const project = projects.createProject({ name: `cbl-b1-${Date.now()}`, directory: projDir });
      const cycle = await cycles.createCycle(project.id, 'CBL B1 Cycle');

      expect(cycle.git_base_branch).toBeNull();
      expect(cycle.git_branch).toBeNull();
      expect(cycle.git_worktree_path).toBeNull();
      expect(cycle.git_worktree_id).toBeNull();
      expect(cycle.git_merged_at).toBeNull();
      expect(cycle.awaiting_merge).toBe(false);
      expect(cycle.git_cleanup_pending).toBe(false);
      // awaiting_merge is a distinct field — never overloads awaiting_approval.
      expect(cycle.awaiting_approval).toBe(false);

      dbs.close();
      fs.rmSync(projDir, { recursive: true, force: true });
    });
  });
});

describe('cycle-branch-lifecycle B1: cycles schema v113 (v112 upgrade fixture)', () => {
  function makeV112CyclesDb(dbPath: string): { projectId: number; cycleId: number; runId: number } {
    const raw = new Database(dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (112);
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        directory TEXT NOT NULL
      );
      CREATE TABLE cycles (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        folder_name TEXT NOT NULL,
        phase TEXT NOT NULL DEFAULT 'discovery' CHECK(phase IN ('discovery', 'planning', 'implementation', 'final_tests', 'complete')),
        autonomy TEXT NOT NULL CHECK(autonomy IN ('autonomous_after_discovery', 'pause_after_planning')),
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('pending', 'active', 'completed')),
        awaiting_approval INTEGER NOT NULL DEFAULT 0,
        final_tests_enabled INTEGER NOT NULL DEFAULT 1 CHECK(final_tests_enabled IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, folder_name)
      );
      CREATE TABLE runs (
        id INTEGER PRIMARY KEY,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        cycle_id INTEGER REFERENCES cycles(id),
        status TEXT NOT NULL DEFAULT 'active'
      );
    `);
    const projectId = (raw.prepare(
      `INSERT INTO projects (name, directory) VALUES ('cbl-b1-v112-proj', '/tmp/cbl-b1-v112-proj') RETURNING id`
    ).get() as any).id;
    const cycleId = (raw.prepare(
      `INSERT INTO cycles (id, project_id, name, folder_name, autonomy, status, awaiting_approval, final_tests_enabled)
       VALUES (7, ?, 'legacy cycle', 'legacy-cycle_0101', 'pause_after_planning', 'completed', 0, 1) RETURNING id`
    ).get(projectId) as any).id;
    const runId = (raw.prepare(
      `INSERT INTO runs (project_id, cycle_id, status) VALUES (?, ?, 'complete') RETURNING id`
    ).get(projectId, cycleId) as any).id;
    raw.close();
    return { projectId, cycleId, runId };
  }

  it('v112→v113: archived accepted, bogus rejected, row counts identical, FK check empty, existing rows keep NULL git identity', () => {
    withTempDb((dbPath) => {
      const { cycleId, runId } = makeV112CyclesDb(dbPath);

      const preCheck = new Database(dbPath);
      const countBefore = (preCheck.prepare('SELECT COUNT(*) AS c FROM cycles').get() as any).c;
      preCheck.close();

      const migrated = new DatabaseService(dbPath);
      const ver = (migrated.raw.prepare('SELECT version FROM schema_version').get() as any).version;
      expect(ver).toBe(SCHEMA_VERSION);
      expect(ver).toBeGreaterThanOrEqual(113);

      const countAfter = (migrated.raw.prepare('SELECT COUNT(*) AS c FROM cycles').get() as any).c;
      expect(countAfter).toBe(countBefore);

      // Existing (pre-migration) row: id preserved, status untouched, all new git-identity
      // columns NULL, both new flags default 0 — never silently backfilled (R4.4).
      const existing = migrated.raw.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
      expect(existing.id).toBe(cycleId);
      expect(existing.status).toBe('completed');
      expect(existing.git_base_branch).toBeNull();
      expect(existing.git_branch).toBeNull();
      expect(existing.git_worktree_path).toBeNull();
      expect(existing.git_worktree_id).toBeNull();
      expect(existing.git_merged_at).toBeNull();
      expect(existing.awaiting_merge).toBe(0);
      expect(existing.git_cleanup_pending).toBe(0);

      // status CHECK: 'archived' now accepted, 'bogus' still rejected.
      expect(() =>
        migrated.raw.prepare(`UPDATE cycles SET status = 'archived' WHERE id = ?`).run(cycleId)
      ).not.toThrow();
      expect((migrated.raw.prepare('SELECT status FROM cycles WHERE id = ?').get(cycleId) as any).status).toBe('archived');
      expect(() =>
        migrated.raw.prepare(`UPDATE cycles SET status = 'bogus' WHERE id = ?`).run(cycleId)
      ).toThrow();

      // The pre-existing runs.cycle_id FK still resolves to the same row through the rebuild.
      const joined = migrated.raw.prepare(
        `SELECT r.id AS run_id, c.id AS cycle_id FROM runs r JOIN cycles c ON c.id = r.cycle_id WHERE r.id = ?`
      ).get(runId) as any;
      expect(joined).toEqual({ run_id: runId, cycle_id: cycleId });
      expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);

      const cols = (migrated.raw.prepare('PRAGMA table_info(cycles)').all() as any[]).map((c) => c.name);
      for (const col of NEW_CYCLE_COLUMNS) {
        expect(cols).toContain(col);
      }

      migrated.close();

      // Idempotent re-open: version and row identity stay put.
      const again = new DatabaseService(dbPath);
      expect((again.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
      expect((again.raw.prepare('SELECT COUNT(*) AS c FROM cycles').get() as any).c).toBe(countBefore);
      again.close();
    });
  });
});
