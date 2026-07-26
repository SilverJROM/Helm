import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';

function makeV48ProjectAgentsDb(dbPath: string) {
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (48);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, directory TEXT NOT NULL);
    CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT, model_id TEXT);
    CREATE TABLE toolkits (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, body_md TEXT NOT NULL);
    CREATE TABLE project_agents (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      model_id INTEGER REFERENCES models(id),
      use_dynamic INTEGER NOT NULL DEFAULT 0,
      backup_model_id INTEGER REFERENCES models(id),
      effort_override TEXT,
      spawn_pref_override TEXT,
      disabled_override INTEGER CHECK(disabled_override IN (0,1)),
      definition_md_override TEXT,
      toolkits_overridden INTEGER NOT NULL DEFAULT 0 CHECK(toolkits_overridden IN (0,1)),
      escalations_overridden INTEGER NOT NULL DEFAULT 0 CHECK(escalations_overridden IN (0,1)),
      is_primary_driver INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, agent_id)
    );
    CREATE TABLE project_agent_toolkits (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      toolkit_id INTEGER NOT NULL REFERENCES toolkits(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY(project_id, agent_id) REFERENCES project_agents(project_id, agent_id) ON DELETE CASCADE,
      UNIQUE(project_id, agent_id, toolkit_id)
    );
    CREATE INDEX idx_project_agent_toolkits_agent ON project_agent_toolkits(project_id, agent_id);
    CREATE TABLE project_agent_escalations (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      model_id INTEGER NOT NULL REFERENCES models(id),
      trigger TEXT NOT NULL DEFAULT 'on-fail', effort TEXT,
      FOREIGN KEY(project_id, agent_id) REFERENCES project_agents(project_id, agent_id) ON DELETE CASCADE,
      UNIQUE(project_id, agent_id, position)
    );
    CREATE INDEX idx_project_agent_escalations_agent ON project_agent_escalations(project_id, agent_id);
    INSERT INTO agents (id, name) VALUES (10, 'implementer');  -- canonical so B09b does not prune
    INSERT INTO projects (id, name, directory) VALUES (20, 'b9fix5-project', '/tmp/b9fix5');
    INSERT INTO models (id, name, model_id) VALUES (30, 'primary', 'primary-model'), (31, 'backup', 'backup-model');
    INSERT INTO toolkits (id, name, body_md) VALUES (40, 'toolkit', 'toolkit body');
    INSERT INTO project_agents (
      id, project_id, agent_id, model_id, use_dynamic, backup_model_id, effort_override,
      spawn_pref_override, disabled_override, definition_md_override, toolkits_overridden,
      escalations_overridden, is_primary_driver
    ) VALUES (
      50, 20, 10, 30, 0, 31, 'high', 'in-process', 1, '# Project persona', 1, 1, 1
    );
    INSERT INTO project_agent_toolkits (id, project_id, agent_id, toolkit_id, position) VALUES (60, 20, 10, 40, 2);
    INSERT INTO project_agent_escalations (id, project_id, agent_id, position, model_id, trigger) VALUES (70, 20, 10, 1, 31, 'projcore');
  `);
  old.close();
}

function agentFkCascades(db: Database.Database): boolean {
  const fks = db.prepare('PRAGMA foreign_key_list(project_agents)').all() as any[];
  return fks.some((fk: any) =>
    fk.table === 'agents'
    && fk.from === 'agent_id'
    && String(fk.on_delete || '').toUpperCase() === 'CASCADE'
  );
}

describe('B9fix5 v49 migration crash-safety (F8)', () => {
  const cleanups: Array<() => void> = [];
  let origExec: typeof Database.prototype.exec;
  let failOnProjectAgentsDrop = false;

  afterEach(() => {
    if (origExec) Database.prototype.exec = origExec;
    failOnProjectAgentsDrop = false;
    for (const c of cleanups.splice(0)) c();
  });

  it('v48→v49 preserves all project_agents rows, override cols, child rows, and adds agent CASCADE', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b9fix5-mig-${Date.now()}.db`);
    cleanups.push(() => { try { fs.unlinkSync(testCopy); } catch {} });
    makeV48ProjectAgentsDb(testCopy);

    const migrated = new DatabaseService(testCopy);
    const ver = (migrated.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    const row = migrated.raw.prepare('SELECT * FROM project_agents WHERE id = 50').get() as any;
    const tkCount = (migrated.raw.prepare('SELECT COUNT(*) as c FROM project_agent_toolkits').get() as any).c;
    const escCount = (migrated.raw.prepare('SELECT COUNT(*) as c FROM project_agent_escalations').get() as any).c;

    expect(ver).toBe(SCHEMA_VERSION);
    expect(row.definition_md_override).toBe('# Project persona');
    expect(row.toolkits_overridden).toBe(1);
    expect(row.escalations_overridden).toBe(1);
    expect(tkCount).toBe(1);
    expect(escCount).toBe(1);
    expect(agentFkCascades(migrated.raw)).toBe(true);
    expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    migrated.close();
  });

  it('v49 migration is idempotent on re-open', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b9fix5-idem-${Date.now()}.db`);
    cleanups.push(() => { try { fs.unlinkSync(testCopy); } catch {} });
    makeV48ProjectAgentsDb(testCopy);

    const first = new DatabaseService(testCopy);
    first.close();
    const second = new DatabaseService(testCopy);
    const ver = (second.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    const paCount = (second.raw.prepare('SELECT COUNT(*) as c FROM project_agents').get() as any).c;
    // Track the live SCHEMA_VERSION (was a stale hardcoded 49; its sibling test above already uses the
    // constant). A v48 fixture migrates fully on first open, so a re-open must sit at SCHEMA_VERSION.
    expect(ver).toBe(SCHEMA_VERSION);
    expect(paCount).toBe(1);
    expect(agentFkCascades(second.raw)).toBe(true);
    second.close();
  });

  it('forced mid-rebuild failure leaves version<49 and pre-cascade table intact', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b9fix5-fail-${Date.now()}.db`);
    cleanups.push(() => { try { fs.unlinkSync(testCopy); } catch {} });
    makeV48ProjectAgentsDb(testCopy);

    origExec = Database.prototype.exec;
    Database.prototype.exec = function (this: Database.Database, sql: string) {
      if (failOnProjectAgentsDrop && sql.includes('DROP TABLE project_agents;')) {
        throw new Error('simulated v49 mid-rebuild failure');
      }
      return origExec.call(this, sql);
    };
    failOnProjectAgentsDrop = true;

    expect(() => new DatabaseService(testCopy)).toThrow(/simulated v49 mid-rebuild failure/);

    const raw = new Database(testCopy);
    const ver = (raw.prepare('SELECT version FROM schema_version').get() as any).version;
    const paCount = (raw.prepare('SELECT COUNT(*) as c FROM project_agents').get() as any).c;
    const row = raw.prepare('SELECT definition_md_override FROM project_agents WHERE id = 50').get() as any;
    expect(ver).toBe(48);
    expect(paCount).toBe(1);
    expect(row.definition_md_override).toBe('# Project persona');
    expect(agentFkCascades(raw)).toBe(false);
    raw.close();
  });

  it('database.ts encodes FK-OFF → txn → rebuild → version-49 → FK-ON + foreign_key_check sequencing', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/db/database.ts'), 'utf8');
    expect(src).toContain('applyV49ProjectAgentsRebuild');
    expect(src).toContain("this.db.pragma('foreign_keys = OFF')");
    expect(src).toContain("this.db.pragma('foreign_keys = ON')");
    expect(src).toContain("UPDATE schema_version SET version = 49");
    expect(src).toContain('PRAGMA foreign_key_check');
    expect(src).not.toMatch(
      /Finalize version[\s\S]*INSERT INTO schema_version \(version\) VALUES \(\?\)\s*\)\.run\(SCHEMA_VERSION\)/
    );
    expect(src).toContain('B9fix5 (F8): end first-pass txn here');
  });
});