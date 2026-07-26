import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';

function makeTempDir(prefix: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function makeConsistencyDb(dbPath: string, agent: {
  default_effort: string | null;
  spawn_pref: string | null;
  effort_override?: string | null;
  spawn_pref_override?: string | null;
}) {
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION});
    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      default_effort TEXT,
      spawn_pref TEXT,
      definition_md TEXT,
      default_model_id INTEGER,
      backup_model_id INTEGER,
      in_development INTEGER NOT NULL DEFAULT 0,
      agent_type TEXT NOT NULL DEFAULT 'project',
      classification TEXT NOT NULL DEFAULT 'solo',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, directory TEXT NOT NULL);
    CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT, model_id TEXT, provider TEXT);
    CREATE TABLE toolkits (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT, body_md TEXT NOT NULL);
    CREATE TABLE agent_toolkits (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, toolkit_id INTEGER NOT NULL, position INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE agent_escalations (id INTEGER PRIMARY KEY, agent_id INTEGER NOT NULL, position INTEGER NOT NULL, model_id INTEGER NOT NULL, trigger TEXT NOT NULL DEFAULT 'on-fail', effort TEXT);
    CREATE TABLE project_agents (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      agent_id INTEGER NOT NULL,
      model_id INTEGER,
      use_dynamic INTEGER NOT NULL DEFAULT 0,
      backup_model_id INTEGER,
      effort_override TEXT,
      spawn_pref_override TEXT,
      disabled_override INTEGER,
      definition_md_override TEXT,
      toolkits_overridden INTEGER NOT NULL DEFAULT 0,
      escalations_overridden INTEGER NOT NULL DEFAULT 0,
      is_primary_driver INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, agent_id)
    );
    INSERT INTO agents (id, name, provider, model, default_effort, spawn_pref, definition_md)
      VALUES (1, 'b9fix8-agent', 'claude', 'claude-opus-4-8', ${agent.default_effort == null ? 'NULL' : `'${agent.default_effort}'`}, ${agent.spawn_pref == null ? 'NULL' : `'${agent.spawn_pref}'`}, '# Studio');
    INSERT INTO projects (id, name, directory) VALUES (10, 'B9fix8-proj', '/tmp/b9fix8');
    INSERT INTO project_agents (
      id, project_id, agent_id, effort_override, spawn_pref_override
    ) VALUES (
      100, 10, 1,
      ${agent.effort_override === undefined ? 'NULL' : (agent.effort_override == null ? 'NULL' : `'${agent.effort_override}'`)},
      ${agent.spawn_pref_override === undefined ? 'NULL' : (agent.spawn_pref_override == null ? 'NULL' : `'${agent.spawn_pref_override}'`)}
    );
  `);
  old.close();
}

function expectListDetailConsistency(
  pas: ProjectAgentService,
  assignment: AgentAssignmentService,
  pid: number,
  aid: number,
  expected: { effort: string | null; spawn_pref: string }
) {
  const lean = pas.listProjectAgents(pid)[0].effective;
  const detail = assignment.resolveProjectAgent(pid, aid);
  expect(lean.effort).toBe(expected.effort);
  expect(lean.spawn_pref).toBe(expected.spawn_pref);
  expect(detail?.effort).toBe(expected.effort);
  expect(detail?.spawn_pref).toBe(expected.spawn_pref);
  expect(lean.effort).toBe(detail?.effort ?? null);
  expect(lean.spawn_pref).toBe(detail?.spawn_pref);
  expect(lean.effort).not.toBe('null');
}

function makeV48DbWithOrphan(dbPath: string) {
  const old = new Database(dbPath);
  old.exec(`
    CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
    INSERT INTO schema_version (version) VALUES (48);
    CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
    CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, directory TEXT NOT NULL);
    CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT, model_id TEXT);
    CREATE TABLE toolkits (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, description TEXT, body_md TEXT NOT NULL);
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
    INSERT INTO agents (id, name) VALUES (10, 'implementer'), (11, 'orphan-agent');
    INSERT INTO projects (id, name, directory) VALUES (20, 'b9fix8-project', '/tmp/b9fix8');
    INSERT INTO models (id, name, model_id) VALUES (30, 'primary', 'primary-model'), (31, 'backup', 'backup-model');
    INSERT INTO toolkits (id, name, body_md) VALUES (40, 'toolkit', 'toolkit body');
    INSERT INTO project_agents (id, project_id, agent_id, model_id, use_dynamic, is_primary_driver)
      VALUES (50, 20, 10, 30, 0, 1);
    INSERT INTO project_agent_toolkits (id, project_id, agent_id, toolkit_id, position) VALUES (60, 20, 10, 40, 1);
    INSERT INTO project_agent_escalations (id, project_id, agent_id, position, model_id, trigger) VALUES (70, 20, 10, 1, 31, 'on-fail');
  `);
  old.pragma('foreign_keys = OFF');
  old.prepare('DELETE FROM project_agents WHERE id = 50').run();
  old.exec(`
    INSERT INTO project_agent_toolkits (id, project_id, agent_id, toolkit_id, position) VALUES (61, 20, 11, 40, 9);
    INSERT INTO project_agent_escalations (id, project_id, agent_id, position, model_id, trigger) VALUES (71, 20, 11, 2, 31, 'orphan');
  `);
  old.pragma('foreign_keys = ON');
  old.close();
}

describe('B9fix8 J1/J2 list↔detail effort+spawn consistency', () => {
  const cleanups: Array<() => void> = [];
  let dbs: DatabaseService;
  let pas: ProjectAgentService;
  let assignment: AgentAssignmentService;
  const pid = 10;
  const aid = 1;

  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  function boot(agent: Parameters<typeof makeConsistencyDb>[1]) {
    const t = makeTempDir('helm-b9fix8-');
    cleanups.push(t.cleanup);
    makeConsistencyDb(path.join(t.dir, 'test.db'), agent);
    dbs = new DatabaseService(path.join(t.dir, 'test.db'));
    assignment = new AgentAssignmentService(dbs);
    pas = new ProjectAgentService(dbs, assignment);
  }

  it('default_effort=NULL → list effort == detail effort (both null, not "null")', () => {
    boot({ default_effort: null, spawn_pref: 'tmux' });
    expectListDetailConsistency(pas, assignment, pid, aid, { effort: null, spawn_pref: 'tmux' });
  });

  it("spawn_pref='' → both list and detail resolve to 'tmux'", () => {
    boot({ default_effort: 'medium', spawn_pref: '' });
    expectListDetailConsistency(pas, assignment, pid, aid, { effort: 'medium', spawn_pref: 'tmux' });
  });

  it('normal effort+spawn values agree between list and detail', () => {
    boot({
      default_effort: 'high',
      spawn_pref: 'in-process',
      effort_override: 'low',
      spawn_pref_override: 'subprocess'
    });
    expectListDetailConsistency(pas, assignment, pid, aid, { effort: 'low', spawn_pref: 'subprocess' });
  });
});

describe('B9fix8 J3 v49 orphan prune + in-txn FK check', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it('v49 rebuild prunes orphan child rows and migrates cleanly', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b9fix8-v49-${Date.now()}.db`);
    cleanups.push(() => { try { fs.unlinkSync(testCopy); } catch {} });
    makeV48DbWithOrphan(testCopy);

    const rawBefore = new Database(testCopy);
    expect((rawBefore.prepare('SELECT COUNT(*) as c FROM project_agent_toolkits').get() as any).c).toBe(2);
    expect((rawBefore.prepare('SELECT COUNT(*) as c FROM project_agents').get() as any).c).toBe(0);
    rawBefore.close();

    const migrated = new DatabaseService(testCopy);
    const ver = (migrated.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    const tkCount = (migrated.raw.prepare('SELECT COUNT(*) as c FROM project_agent_toolkits').get() as any).c;
    const escCount = (migrated.raw.prepare('SELECT COUNT(*) as c FROM project_agent_escalations').get() as any).c;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(tkCount).toBe(0);
    expect(escCount).toBe(0);
    expect(migrated.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    migrated.close();
  });

  it('v49 migration is idempotent on re-open', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b9fix8-idem-${Date.now()}.db`);
    cleanups.push(() => { try { fs.unlinkSync(testCopy); } catch {} });
    makeV48DbWithOrphan(testCopy);

    const first = new DatabaseService(testCopy);
    first.close();
    const second = new DatabaseService(testCopy);
    const ver = (second.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(second.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    second.close();
  });

  it('database.ts runs foreign_key_check inside v49 txn before version bump', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/db/database.ts'), 'utf8');
    const rebuildBlock = src.slice(src.indexOf('const rebuildProjectAgentsWithAgentCascade'), src.indexOf('const applyV49ProjectAgentsRebuild'));
    const txnBlock = src.slice(src.indexOf('const applyV49ProjectAgentsRebuild'), src.indexOf('// First-pass migration txn'));
    expect(rebuildBlock).toContain('INNER JOIN project_agents pa ON pa.project_id = c.project_id AND pa.agent_id = c.agent_id');
    expect(txnBlock).toContain('PRAGMA foreign_key_check');
    expect(txnBlock).toContain("UPDATE schema_version SET version = 49");
    expect(txnBlock.indexOf('foreign_key_check')).toBeLessThan(txnBlock.indexOf("UPDATE schema_version SET version = 49"));
  });
});