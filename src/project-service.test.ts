import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ProjectDocsService } from './services/project-docs-service.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from './db/schema.js';
import { loadConfig } from './config/config.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-c1-project-'));
  const dbPath = path.join(dir, 'test.db');
  return {
    dbPath,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

// Builds a synthetic v8 SQLite DB at dbPath using the real DDL that existed at schema version 8.
// Tables present: schema_version(8), agent_events(+seq), agents(+definition_md), role_bindings,
// role_defaults, project_master_models, master_runtimes(+toolkits_sha), master_switches,
// worker_runtimes, toolkits, agent_toolkits. Seeds 1 agent row (agentsC > 0 after migration).
// No models/memories/projects/project_agents — all created by the v9-v13+ migration chain.
function makeV8FixtureDb(dbPath: string): void {
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE schema_version (version INTEGER NOT NULL);
    INSERT INTO schema_version VALUES (8);

    CREATE TABLE agent_events (
      id INTEGER PRIMARY KEY,
      run_id TEXT NOT NULL,
      role TEXT NOT NULL,
      batch_id TEXT NOT NULL,
      session TEXT,
      type TEXT NOT NULL CHECK(type IN ('message', 'status', 'tool', 'gate')),
      state TEXT,
      source TEXT NOT NULL CHECK(source IN ('callback', 'git', 'pane', 'post', 'chat')),
      correlation_id TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '{}',
      seq INTEGER DEFAULT 0,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_ae_run_ts ON agent_events(run_id, ts);
    CREATE INDEX idx_ae_batch_type ON agent_events(run_id, batch_id, type);
    CREATE UNIQUE INDEX idx_ae_terminal_dedupe
      ON agent_events(run_id, batch_id, state, correlation_id)
      WHERE type = 'status' AND state IN ('DONE', 'BLOCKED');

    CREATE TABLE agents (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok')),
      model TEXT NOT NULL,
      default_effort TEXT NOT NULL DEFAULT 'medium',
      definition_md TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE role_bindings (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('projcore', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(project_id, role)
    );

    CREATE TABLE role_defaults (
      role TEXT PRIMARY KEY CHECK(role IN ('projcore', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')),
      agent_id INTEGER NOT NULL REFERENCES agents(id),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE project_master_models (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      position INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      UNIQUE(project_id, position)
    );
    CREATE INDEX idx_pmm_project ON project_master_models(project_id);

    CREATE TABLE master_runtimes (
      project_id INTEGER PRIMARY KEY,
      master_run_id TEXT NOT NULL,
      tmux_session TEXT NOT NULL,
      tmux_pane TEXT,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('launching','running','parked','failed')),
      core_sha TEXT,
      overlay_sha TEXT,
      toolkits_sha TEXT,
      intentional_park_until TEXT,
      last_launched_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE master_switches (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      from_provider TEXT NOT NULL,
      from_model TEXT NOT NULL,
      to_provider TEXT NOT NULL,
      to_model TEXT NOT NULL,
      correlation TEXT NOT NULL,
      phase TEXT NOT NULL CHECK(phase IN ('requested','parking','ingesting','launching','resuming','switched','failed')),
      reason TEXT NOT NULL DEFAULT 'manual',
      digest_hash TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      switched_at TEXT
    );
    CREATE UNIQUE INDEX idx_ms_corr ON master_switches(correlation);
    CREATE INDEX idx_ms_proj ON master_switches(project_id);

    CREATE TABLE worker_runtimes (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL,
      role TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      session TEXT,
      task_brief TEXT,
      correlation_id TEXT,
      state TEXT NOT NULL CHECK(state IN ('launching','running','done','failed','reaped')),
      pane_pid INTEGER,
      spawned_by TEXT,
      master_run_id TEXT,
      exit_reason TEXT,
      started_at TEXT,
      ended_at TEXT,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX idx_wr_proj_state ON worker_runtimes(project_id, state);

    CREATE TABLE toolkits (
      id INTEGER PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      body_md TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE agent_toolkits (
      id INTEGER PRIMARY KEY,
      agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      toolkit_id INTEGER NOT NULL REFERENCES toolkits(id) ON DELETE RESTRICT,
      position INTEGER NOT NULL DEFAULT 0,
      UNIQUE(agent_id, toolkit_id)
    );
    CREATE INDEX idx_at_agent ON agent_toolkits(agent_id);

    INSERT INTO agents (name, provider, model, default_effort)
      VALUES ('v8-seed-agent', 'claude', 'claude-opus-4-8', 'high');
  `);
  db.close();
}

describe('C1 ProjectService (A0/P1): CRUD + v12 mig on live copy', () => {
  let dbPath: string;
  let cleanup: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;

  beforeEach(() => {
    const t = makeTempDb();
    dbPath = t.dbPath;
    cleanup = t.cleanup;
    dbs = new DatabaseService(dbPath); // fresh v12
    ps = new ProjectService(dbs);
  });

  afterEach(() => {
    cleanup();
  });

  it('fresh DB yields current SCHEMA_VERSION + projects.description/dev_url/qa_url/tags + project_agents tables exist (no rows)', () => {
    const ver = (dbs.raw.prepare("SELECT version FROM schema_version").get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    const has = !!dbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
    const hasPa = !!dbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_agents'").get();
    const projectCols = dbs.raw.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
    const projectAgentCols = dbs.raw.prepare("PRAGMA table_info(project_agents)").all().map((c: any) => c.name);
    expect(has).toBe(true);
    expect(hasPa).toBe(true);
    expect(projectCols).toContain('description');
    expect(projectCols).toContain('dev_url');
    expect(projectCols).toContain('qa_url');
    expect(projectCols).toContain('tags');
    expect(projectAgentCols).toContain('backup_model_id');
    expect(projectAgentCols).toContain('effort_override');
    expect(projectAgentCols).toContain('spawn_pref_override');
    expect(projectAgentCols).toContain('disabled_override');
    expect(projectAgentCols).toContain('definition_md_override');
    expect(projectAgentCols).toContain('toolkits_overridden');
    expect(projectAgentCols).toContain('escalations_overridden');
    const projectAgentFks = dbs.raw.prepare('PRAGMA foreign_key_list(project_agents)').all() as any[];
    expect(projectAgentFks.some((fk: any) => fk.table === 'agents' && fk.from === 'agent_id' && String(fk.on_delete).toUpperCase() === 'CASCADE')).toBe(true);
    expect(!!dbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_agent_toolkits'").get()).toBe(true);
    expect(!!dbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_agent_escalations'").get()).toBe(true);
    expect(ps.listProjects().length).toBe(0);
  });

  it('createProject requires name+directory; UNIQUE name → 409-mappable error; stores primary_driver + plancore_session + null metadata fields', () => {
    // seed a driver agent
    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort) VALUES (?,?,?,?)")
      .run('claude-test', 'claude', 'claude-sonnet-4-6', 'medium');
    const agent = dbs.raw.prepare("SELECT id FROM agents WHERE name='claude-test'").get() as any;

    expect(() => ps.createProject({ name: '', directory: '/tmp' })).toThrow(/name is required/);
    expect(() => ps.createProject({ name: 'p1', directory: '' })).toThrow(/directory is required/);

    const p1 = ps.createProject({ name: 'C1-test-proj', directory: '/tmp/c1', primary_driver_agent_id: agent.id });
    expect(p1.name).toBe('C1-test-proj');
    expect(p1.description).toBeNull();
    expect(p1.dev_url).toBeNull();
    expect(p1.qa_url).toBeNull();
    expect(p1.tags).toEqual([]);
    expect(p1.primary_driver_agent_id).toBe(agent.id);
    expect(p1.plancore_session).toBe('helm-plancore-c1-test-proj');

    expect(() => ps.createProject({ name: 'C1-test-proj', directory: '/tmp/other' })).toThrow(/project name must be unique/);
  });

  // A project seeded with ibrain alone came up unusable: chat/terminal 400 on the missing master
  // chain, and every agent's `role` null (which hides the Planner Panel editor behind a stub note).
  it('createProject seeds the full project-agent roster — every project-classified agent, no house agents', () => {
    const p = ps.createProject({ name: 'seed-roster', directory: '/tmp/seed-roster' });

    const seeded = dbs.raw.prepare(`
      SELECT a.name, a.agent_type FROM project_agents pa JOIN agents a ON a.id = pa.agent_id
      WHERE pa.project_id = ? ORDER BY a.name
    `).all(p.id) as Array<{ name: string; agent_type: string }>;
    // Same candidate rule as addAllAgents: no in_development agents, no house/helm kinds.
    const expectedProjectAgents = (dbs.raw.prepare(`
      SELECT name FROM agents
      WHERE (in_development = 0 OR in_development IS NULL)
        AND lower(coalesce(agent_type, 'project')) NOT IN ('house', 'helm')
      ORDER BY name
    `).all() as Array<{ name: string }>).map(r => r.name);

    expect(expectedProjectAgents.length).toBeGreaterThan(1); // guard: not a vacuous pass on an empty registry
    expect(seeded.map(r => r.name)).toEqual(expectedProjectAgents);
    expect(seeded.some(r => r.agent_type === 'house')).toBe(false);

    // The retired panelist (in_development) must not be seeded — B11 AC-3.
    const panelist = dbs.raw.prepare("SELECT id, in_development FROM agents WHERE name = 'panelist'").get() as any;
    if (panelist && Number(panelist.in_development) === 1) {
      expect(seeded.some(r => r.name === 'panelist')).toBe(false);
    }
  });

  it('createProject seeds role_bindings from role_defaults so project agents resolve a role (planner drawer depends on it)', () => {
    const p = ps.createProject({ name: 'seed-bindings', directory: '/tmp/seed-bindings' });

    const defaults = dbs.raw.prepare('SELECT role, agent_id FROM role_defaults ORDER BY role').all() as Array<{ role: string; agent_id: number }>;
    const bound = dbs.raw.prepare('SELECT role, agent_id FROM role_bindings WHERE project_id = ? ORDER BY role').all(p.id) as Array<{ role: string; agent_id: number }>;

    expect(defaults.length).toBeGreaterThan(0);
    expect(bound).toEqual(defaults);

    // The exact condition the Project Setup drawer branches on to render the Planner Panel editor.
    const plannerRole = dbs.raw.prepare(`
      SELECT rb.role, a.classification FROM role_bindings rb JOIN agents a ON a.id = rb.agent_id
      WHERE rb.project_id = ? AND rb.role = 'planner'
    `).get(p.id) as { role: string; classification: string } | undefined;
    expect(plannerRole).toEqual({ role: 'planner', classification: 'team' });
  });

  it('createProject seeds a default master chain so Command Center chat is not gated out', () => {
    const p = ps.createProject({ name: 'seed-chain', directory: '/tmp/seed-chain' });
    const chain = dbs.raw.prepare('SELECT position, provider, model FROM project_master_models WHERE project_id = ? ORDER BY position').all(p.id);
    expect(chain).toEqual([{ position: 0, provider: 'grok', model: 'grok-4.5' }]);
  });

  it('deleteProject sweeps the seeded rows that have no FK cascade (else an orphan binding blocks agent deletion forever)', () => {
    const p = ps.createProject({ name: 'del-sweep', directory: '/tmp/del-sweep' });
    expect((dbs.raw.prepare('SELECT COUNT(*) c FROM role_bindings WHERE project_id = ?').get(p.id) as any).c).toBeGreaterThan(0);
    expect((dbs.raw.prepare('SELECT COUNT(*) c FROM project_master_models WHERE project_id = ?').get(p.id) as any).c).toBe(1);

    ps.deleteProject(p.id);

    expect((dbs.raw.prepare('SELECT COUNT(*) c FROM role_bindings WHERE project_id = ?').get(p.id) as any).c).toBe(0);
    expect((dbs.raw.prepare('SELECT COUNT(*) c FROM project_master_models WHERE project_id = ?').get(p.id) as any).c).toBe(0);
    expect((dbs.raw.prepare('SELECT COUNT(*) c FROM project_agents WHERE project_id = ?').get(p.id) as any).c).toBe(0);
    // No project-scoped row may outlive its project.
    expect((dbs.raw.prepare('SELECT COUNT(*) c FROM role_bindings WHERE project_id NOT IN (SELECT id FROM projects)').get() as any).c).toBe(0);
    expect((dbs.raw.prepare('SELECT COUNT(*) c FROM project_master_models WHERE project_id NOT IN (SELECT id FROM projects)').get() as any).c).toBe(0);
  });

  it('createProject seeding is atomic — a failed create leaves no roster, bindings, or chain behind', () => {
    ps.createProject({ name: 'dup-name', directory: '/tmp/dup-1' });
    const before = {
      agents: dbs.raw.prepare('SELECT COUNT(*) c FROM project_agents').get() as any,
      bindings: dbs.raw.prepare('SELECT COUNT(*) c FROM role_bindings').get() as any,
      chains: dbs.raw.prepare('SELECT COUNT(*) c FROM project_master_models').get() as any
    };

    expect(() => ps.createProject({ name: 'dup-name', directory: '/tmp/dup-2' })).toThrow(/project name must be unique/);

    expect((dbs.raw.prepare('SELECT COUNT(*) c FROM project_agents').get() as any).c).toBe(before.agents.c);
    expect((dbs.raw.prepare('SELECT COUNT(*) c FROM role_bindings').get() as any).c).toBe(before.bindings.c);
    expect((dbs.raw.prepare('SELECT COUNT(*) c FROM project_master_models').get() as any).c).toBe(before.chains.c);
  });

  it('maps persisted project description, deploy URLs, and normalized tags from projects rows', () => {
    dbs.raw.prepare("INSERT INTO projects (name, directory, description, dev_url, qa_url, tags) VALUES (?,?,?,?,?,?)")
      .run('desc-proj', '/tmp/desc', 'first line\nsecond line', 'https://dev.example.test/app', 'https://qa.example.test/app', JSON.stringify([' client ', 'urgent', '', 'Client']));
    const row = dbs.raw.prepare("SELECT id FROM projects WHERE name = ?").get('desc-proj') as any;
    const project = ps.getProject(row.id);
    expect(project?.description).toBe('first line\nsecond line');
    expect(project?.dev_url).toBe('https://dev.example.test/app');
    expect(project?.qa_url).toBe('https://qa.example.test/app');
    expect(project?.tags).toEqual(['client', 'urgent']);
  });

  it('maps null or invalid legacy project tags to an empty list', () => {
    dbs.raw.prepare("INSERT INTO projects (name, directory, tags) VALUES (?,?,?)")
      .run('invalid-tags-proj', '/tmp/invalid-tags', 'not-json');
    const row = dbs.raw.prepare("SELECT id FROM projects WHERE name = ?").get('invalid-tags-proj') as any;
    expect(ps.getProject(row.id)?.tags).toEqual([]);
  });

  it('get/delete: 404-mappable on unknown; delete removes', () => {
    expect(ps.getProject(999)).toBeNull();
    expect(() => ps.deleteProject(999)).toThrow(/unknown project/);

    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort) VALUES (?,?,?,?)").run('drv', 'claude', 'x', 'medium');
    const aid = (dbs.raw.prepare("SELECT id FROM agents WHERE name='drv'").get() as any).id;
    const p = ps.createProject({ name: 'to-del', directory: '/d', primary_driver_agent_id: aid });
    expect(ps.getProject(p.id)).toBeTruthy();
    ps.deleteProject(p.id);
    expect(ps.getProject(p.id)).toBeNull();
  });

  it('v8→SCHEMA_VERSION on a synthetic v8 fixture: migration chain reaches current version, adds projects + project_agents, data counts survive', () => {
    const testCopy = path.join(os.tmpdir(), `helm-c1-mig-${Date.now()}.db`);
    try {
      makeV8FixtureDb(testCopy); // real v8 DDL (agents+toolkits+no models/projects)
      const migDbs = new DatabaseService(testCopy); // triggers full mig chain v8→SCHEMA_VERSION
      const ver = (migDbs.raw.prepare("SELECT version FROM schema_version").get() as any).version;
      expect(ver).toBe(SCHEMA_VERSION);

      const hasProjects = !!migDbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'").get();
      expect(hasProjects).toBe(true);
      const projectCols = migDbs.raw.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
      expect(projectCols).toContain('description');
      expect(projectCols).toContain('dev_url');
      expect(projectCols).toContain('qa_url');
      expect(projectCols).toContain('tags');

      // v9 migration seeds models; v8 fixture seeded 1 agent
      const agentsC = (migDbs.raw.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
      const modelsC = (migDbs.raw.prepare("SELECT COUNT(*) as c FROM models").get() as any).c;
      const hasPa = !!migDbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_agents'").get();
      expect(agentsC).toBeGreaterThan(0);
      expect(modelsC).toBeGreaterThan(0);
      expect(hasPa).toBe(true);

      // projects table usable; synthetic fixture had no project rows
      const pcount = (migDbs.raw.prepare("SELECT COUNT(*) as c FROM projects").get() as any).c;
      expect(pcount).toBe(0);
    } finally {
      try { fs.unlinkSync(testCopy); } catch {}
    }
  });

  it('v42→SCHEMA_VERSION adds nullable projects.description without losing existing rows', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b2-desc-mig-${Date.now()}.db`);
    try {
      const old = new Database(testCopy);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (42);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          directory TEXT NOT NULL,
          tmux_session TEXT,
          projcore_session TEXT,
          primary_driver_agent_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO projects (id, name, directory) VALUES (7, 'old-desc-project', '/tmp/old-desc');
      `);
      old.close();

      const migrated = new DatabaseService(testCopy);
      const ver = (migrated.raw.prepare("SELECT version FROM schema_version").get() as any).version;
      const projectCols = migrated.raw.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
      const project = new ProjectService(migrated).getProject(7);
      expect(ver).toBe(SCHEMA_VERSION);
      expect(projectCols).toContain('description');
      expect(projectCols).toContain('dev_url');
      expect(projectCols).toContain('qa_url');
      expect(projectCols).toContain('tags');
      expect(project?.name).toBe('old-desc-project');
      expect(project?.description).toBeNull();
      expect(project?.dev_url).toBeNull();
      expect(project?.qa_url).toBeNull();
      expect(project?.tags).toEqual([]);
      migrated.raw.prepare("UPDATE projects SET description = ? WHERE id = ?").run('migrated desc', 7);
      expect(new ProjectService(migrated).getProject(7)?.description).toBe('migrated desc');
    } finally {
      try { fs.unlinkSync(testCopy); } catch {}
    }
  });

  it('v43→SCHEMA_VERSION adds nullable projects.dev_url and projects.qa_url without losing existing rows', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b4b-url-mig-${Date.now()}.db`);
    try {
      const old = new Database(testCopy);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (43);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          directory TEXT NOT NULL,
          description TEXT,
          tmux_session TEXT,
          projcore_session TEXT,
          primary_driver_agent_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO projects (id, name, directory, description) VALUES (8, 'old-url-project', '/tmp/old-url', 'has desc');
      `);
      old.close();

      const migrated = new DatabaseService(testCopy);
      const ver = (migrated.raw.prepare("SELECT version FROM schema_version").get() as any).version;
      const projectCols = migrated.raw.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
      const project = new ProjectService(migrated).getProject(8);
      expect(ver).toBe(SCHEMA_VERSION);
      expect(projectCols).toContain('dev_url');
      expect(projectCols).toContain('qa_url');
      expect(projectCols).toContain('tags');
      expect(project?.name).toBe('old-url-project');
      expect(project?.description).toBe('has desc');
      expect(project?.dev_url).toBeNull();
      expect(project?.qa_url).toBeNull();
      expect(project?.tags).toEqual([]);
      migrated.raw.prepare("UPDATE projects SET dev_url = ?, qa_url = ? WHERE id = ?").run('https://dev.example.test', 'https://qa.example.test', 8);
      const updated = new ProjectService(migrated).getProject(8);
      expect(updated?.dev_url).toBe('https://dev.example.test');
      expect(updated?.qa_url).toBe('https://qa.example.test');
    } finally {
      try { fs.unlinkSync(testCopy); } catch {}
    }
  });

  it('v44→SCHEMA_VERSION adds nullable projects.tags without losing existing rows and maps persisted tags', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b5-tags-mig-${Date.now()}.db`);
    try {
      const old = new Database(testCopy);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (44);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          directory TEXT NOT NULL,
          description TEXT,
          dev_url TEXT,
          qa_url TEXT,
          tmux_session TEXT,
          projcore_session TEXT,
          primary_driver_agent_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO projects (id, name, directory, description, dev_url, qa_url) VALUES (9, 'old-tags-project', '/tmp/old-tags', 'has desc', 'https://dev.example.test', 'https://qa.example.test');
      `);
      old.close();

      const migrated = new DatabaseService(testCopy);
      const ver = (migrated.raw.prepare("SELECT version FROM schema_version").get() as any).version;
      const projectCols = migrated.raw.prepare("PRAGMA table_info(projects)").all().map((c: any) => c.name);
      const project = new ProjectService(migrated).getProject(9);
      expect(ver).toBe(SCHEMA_VERSION);
      expect(projectCols).toContain('tags');
      expect(project?.name).toBe('old-tags-project');
      expect(project?.tags).toEqual([]);
      migrated.raw.prepare("UPDATE projects SET tags = ? WHERE id = ?").run(JSON.stringify(['alpha', 'Beta', 'alpha', ' ']), 9);
      const updated = new ProjectService(migrated).getProject(9);
      expect(updated?.tags).toEqual(['alpha', 'Beta']);
    } finally {
      try { fs.unlinkSync(testCopy); } catch {}
    }
  });

  it('v47→SCHEMA_VERSION adds nullable project_agents.definition_md_override without losing rows', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b8-def-mig-${Date.now()}.db`);
    try {
      const old = new Database(testCopy);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (47);
        CREATE TABLE agents (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
        CREATE TABLE projects (id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, directory TEXT NOT NULL);
        CREATE TABLE models (id INTEGER PRIMARY KEY, name TEXT, model_id TEXT);
        CREATE TABLE project_agents (
          id INTEGER PRIMARY KEY,
          project_id INTEGER NOT NULL,
          agent_id INTEGER NOT NULL,
          model_id INTEGER,
          use_dynamic INTEGER NOT NULL DEFAULT 0,
          backup_model_id INTEGER,
          effort_override TEXT,
          spawn_pref_override TEXT,
          disabled_override INTEGER CHECK(disabled_override IN (0,1)),
          toolkits_overridden INTEGER NOT NULL DEFAULT 0 CHECK(toolkits_overridden IN (0,1)),
          escalations_overridden INTEGER NOT NULL DEFAULT 0 CHECK(escalations_overridden IN (0,1)),
          is_primary_driver INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          UNIQUE(project_id, agent_id)
        );
        INSERT INTO agents (id, name) VALUES (20, 'implementer');
        INSERT INTO projects (id, name, directory) VALUES (10, 'old-def-project', '/tmp/old-def');
        INSERT INTO project_agents (id, project_id, agent_id, use_dynamic) VALUES (3, 10, 20, 0);
      `);
      old.close();

      const migrated = new DatabaseService(testCopy);
      const ver = (migrated.raw.prepare("SELECT version FROM schema_version").get() as any).version;
      const cols = migrated.raw.prepare("PRAGMA table_info(project_agents)").all().map((c: any) => c.name);
      const row = migrated.raw.prepare("SELECT id, definition_md_override FROM project_agents WHERE id = 3").get() as any;
      expect(ver).toBe(SCHEMA_VERSION);
      expect(cols).toContain('definition_md_override');
      expect(row.id).toBe(3);
      expect(row.definition_md_override).toBeNull();
    } finally {
      try { fs.unlinkSync(testCopy); } catch {}
    }
  });

  it('B9a v48→SCHEMA_VERSION rebuild preserves project_agents and child override row counts while adding agent cascade', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b9a-cascade-mig-${Date.now()}.db`);
    try {
      const old = new Database(testCopy);
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
        INSERT INTO agents (id, name) VALUES (10, 'implementer');
        INSERT INTO projects (id, name, directory) VALUES (20, 'b9a-project', '/tmp/b9a');
        INSERT INTO models (id, name, model_id) VALUES (30, 'primary', 'primary-model'), (31, 'backup', 'backup-model');
        INSERT INTO toolkits (id, name, body_md) VALUES (40, 'toolkit', 'toolkit body');
        INSERT INTO project_agents (
          id, project_id, agent_id, model_id, use_dynamic, backup_model_id, effort_override,
          spawn_pref_override, disabled_override, definition_md_override, toolkits_overridden,
          escalations_overridden, is_primary_driver, created_at, updated_at
        ) VALUES (
          50, 20, 10, 30, 0, 31, 'high', 'in-process', 1, '# Project persona',
          1, 1, 1, '2026-06-24 00:00:00', '2026-06-24 00:01:00'
        );
        INSERT INTO project_agent_toolkits (id, project_id, agent_id, toolkit_id, position) VALUES (60, 20, 10, 40, 2);
        INSERT INTO project_agent_escalations (id, project_id, agent_id, position, model_id, trigger) VALUES (70, 20, 10, 1, 31, 'projcore');
      `);
      old.close();

      const migrated = new DatabaseService(testCopy);
      const ver = (migrated.raw.prepare('SELECT version FROM schema_version').get() as any).version;
      const row = migrated.raw.prepare('SELECT * FROM project_agents WHERE id = 50').get() as any;
      const tkCount = (migrated.raw.prepare('SELECT COUNT(*) as c FROM project_agent_toolkits').get() as any).c;
      const escCount = (migrated.raw.prepare('SELECT COUNT(*) as c FROM project_agent_escalations').get() as any).c;
      const fks = migrated.raw.prepare('PRAGMA foreign_key_list(project_agents)').all() as any[];
      const fkCheck = migrated.raw.prepare('PRAGMA foreign_key_check').all() as any[];
      expect(ver).toBe(SCHEMA_VERSION);
      expect(row.agent_id).toBe(10);
      expect(row.model_id).toBe(30);
      expect(row.backup_model_id).toBe(31);
      expect(row.effort_override).toBe('high');
      expect(row.spawn_pref_override).toBe('in-process');
      expect(row.disabled_override).toBe(1);
      expect(row.definition_md_override).toBe('# Project persona');
      expect(row.toolkits_overridden).toBe(1);
      expect(row.escalations_overridden).toBe(1);
      expect(row.is_primary_driver).toBe(1);
      expect(tkCount).toBe(1);
      expect(escCount).toBe(1);
      expect(fks.some((fk: any) => fk.table === 'agents' && fk.from === 'agent_id' && String(fk.on_delete).toUpperCase() === 'CASCADE')).toBe(true);
      expect(fkCheck).toEqual([]);
      migrated.close();
    } finally {
      try { fs.unlinkSync(testCopy); } catch {}
    }
  });
});

describe('C2 ProjectAgentService (P2): CRUD + one-primary invariant + dynamic GLOBAL pool + add-all idempotent + set-to-default + v8->v13 on live copy', () => {
  let dbPath: string;
  let cleanup: () => void;
  let dbs: DatabaseService;
  let pas: ProjectAgentService;
  let assignment: AgentAssignmentService;
  let pid: number;
  let aid1: number, aid2: number, mid: number;

  beforeEach(() => {
    const t = makeTempDb();
    dbPath = t.dbPath;
    cleanup = t.cleanup;
    dbs = new DatabaseService(dbPath);
    assignment = new AgentAssignmentService(dbs);
    pas = new ProjectAgentService(dbs, assignment);
    // seed minimal project + 2 agents + 1 model (for resolution/override)
    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort) VALUES (?,?,?,?)").run('c2-plancore', 'claude', 'claude-opus-4-8', 'high');
    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort) VALUES (?,?,?,?)").run('c2-codex', 'codex', 'gpt-5.5', 'medium');
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)").run('c2-model', 'claude', 'claude-sonnet-4-6', 'claude', 'c2-model', 'c2-model', 'medium');
    const a1 = dbs.raw.prepare("SELECT id FROM agents WHERE name='c2-plancore'").get() as any;
    const a2 = dbs.raw.prepare("SELECT id FROM agents WHERE name='c2-codex'").get() as any;
    const m = dbs.raw.prepare("SELECT id FROM models WHERE name='c2-model'").get() as any;
    aid1 = a1.id; aid2 = a2.id; mid = m.id;
    // direct insert project (bypass create for agent focus)
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('C2-test-proj', '/tmp/c2');
    const p = dbs.raw.prepare("SELECT id FROM projects WHERE name='C2-test-proj'").get() as any;
    pid = p.id;
  });

  afterEach(() => { cleanup(); });

  it('add/list/remove + 404/409 on unknown/dup', () => {
    expect(() => pas.addAgent(999, aid1)).toThrow(/unknown project/);
    expect(() => pas.addAgent(pid, 999)).toThrow(/unknown agent/);
    pas.addAgent(pid, aid1);
    const list = pas.listProjectAgents(pid);
    expect(list.length).toBe(1);
    expect(list[0].agent.name).toBe('c2-plancore');
    expect(() => pas.addAgent(pid, aid1)).toThrow(/already added/);
    pas.removeAgent(pid, aid1);
    expect(pas.listProjectAgents(pid).length).toBe(0);
  });

  it('one-primary-driver invariant: setting new primary clears the old → exactly one flag=1', () => {
    pas.addAgent(pid, aid1);
    pas.addAgent(pid, aid2);
    pas.setPrimaryDriver(pid, aid1);
    let rows = pas.listProjectAgents(pid);
    expect(rows.filter((r: any) => r.is_primary_driver === 1).length).toBe(1);
    expect(rows.find((r: any) => r.agent_id === aid1)!.is_primary_driver).toBe(1);
    pas.setPrimaryDriver(pid, aid2);
    rows = pas.listProjectAgents(pid);
    expect(rows.filter((r: any) => r.is_primary_driver === 1).length).toBe(1);
    expect(rows.find((r: any) => r.agent_id === aid2)!.is_primary_driver).toBe(1);
    expect(rows.find((r: any) => r.agent_id === aid1)!.is_primary_driver).toBe(0);
  });

  it('model resolution: dynamic picks from GLOBAL pool; override; default (agent default_model_id)', () => {
    pas.addAgent(pid, aid1);
    // no default_model_id → AC-13 falls through to agents.model TEXT (seed sets model='claude-opus-4-8')
    let rows = pas.listProjectAgents(pid);
    expect(rows[0].resolved.type).toBe('inherited');
    expect(rows[0].resolved.source).toBe('inherited');
    expect(rows[0].resolved.name).toBe('claude-opus-4-8');
    // set override
    pas.setModelOverride(pid, aid1, { model_id: mid });
    rows = pas.listProjectAgents(pid);
    expect(rows[0].resolved.type).toBe('override');
    expect(rows[0].resolved.source).toBe('override');
    expect(rows[0].resolved.name).toBe('c2-model');
    // set dynamic (GLOBAL)
    pas.setModelOverride(pid, aid1, 'dynamic');
    rows = pas.listProjectAgents(pid);
    expect(rows[0].resolved.type).toBe('dynamic');
    expect(rows[0].resolved.source).toBe('dynamic');
    expect(rows[0].resolved.name).toContain('global pool');
    // back to default (inherit Studio → agents.model TEXT)
    pas.setModelOverride(pid, aid1, 'default');
    rows = pas.listProjectAgents(pid);
    expect(rows[0].resolved.type).toBe('inherited');
    expect(rows[0].resolved.source).toBe('inherited');
    expect(rows[0].resolved.name).toBe('claude-opus-4-8');
  });

  it('B6 scalar overrides persist null-safely and listProjectAgents exposes effective resolution', () => {
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)").run('c2-backup-model', 'claude', 'claude-opus-4-8', 'claude', 'c2-backup-model', 'c2-backup-model', 'high');
    const backup = dbs.raw.prepare("SELECT id FROM models WHERE name='c2-backup-model'").get() as any;
    dbs.raw.prepare("UPDATE agents SET backup_model_id = ?, default_effort = ?, spawn_pref = ? WHERE id = ?").run(mid, 'medium', 'tmux', aid1);

    pas.addAgent(pid, aid1);
    pas.setScalarOverrides(pid, aid1, {
      backup_model_id: backup.id,
      effort_override: 'HIGH',
      spawn_pref_override: 'in-process',
      disabled_override: 1
    });

    let row = pas.listProjectAgents(pid)[0];
    expect(row.backup_model_id).toBe(backup.id);
    expect(row.effort_override).toBe('high');
    expect(row.spawn_pref_override).toBe('in-process');
    expect(row.disabled_override).toBe(1);
    expect(row.effective?.backup_model_id).toBe(backup.id);
    expect(row.effective?.effort).toBe('high');
    expect(row.effective?.spawn_pref).toBe('in-process');
    expect(row.effective?.in_development).toBe(true);

    pas.setScalarOverrides(pid, aid1, {
      backup_model_id: null,
      effort_override: null,
      spawn_pref_override: '',
      disabled_override: null
    });
    row = pas.listProjectAgents(pid)[0];
    expect(row.backup_model_id).toBeNull();
    expect(row.effort_override).toBeNull();
    expect(row.spawn_pref_override).toBeNull();
    expect(row.disabled_override).toBeNull();
    expect(row.effective?.backup_model_id).toBe(mid);
    expect(row.effective?.effort).toBe('medium');
    expect(row.effective?.spawn_pref).toBe('tmux');
    expect(row.effective?.in_development).toBe(false);
  });

  it('B6 resolver scalar branch keeps model chain use_dynamic > model_id > base.default_model_id', () => {
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)").run('c2-default-model', 'claude', 'claude-haiku-4-6', 'claude', 'c2-default-model', 'c2-default-model', 'low');
    const def = dbs.raw.prepare("SELECT id FROM models WHERE name='c2-default-model'").get() as any;
    dbs.raw.prepare("UPDATE agents SET default_model_id = ?, backup_model_id = ?, default_effort = ?, spawn_pref = ? WHERE id = ?").run(def.id, mid, 'medium', 'tmux', aid1);

    pas.addAgent(pid, aid1);
    let effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.model.type).toBe('default');
    expect(effective?.model.id).toBe(def.id);
    expect(effective?.backup_model_id).toBe(mid);
    expect(effective?.effort).toBe('medium');
    expect(effective?.spawn_pref).toBe('tmux');

    pas.setModelOverride(pid, aid1, { model_id: mid });
    effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.model.type).toBe('override');
    expect(effective?.model.id).toBe(mid);

    pas.setModelOverride(pid, aid1, 'dynamic');
    effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.model.type).toBe('dynamic');
    expect(effective?.model.id).toBeNull();
  });

  it('B6 disabled_override cannot un-disable Studio in-development agents; resolver treats Studio gate as authoritative', () => {
    pas.addAgent(pid, aid1);
    dbs.raw.prepare("UPDATE agents SET in_development = 1 WHERE id = ?").run(aid1);
    dbs.raw.prepare("UPDATE project_agents SET disabled_override = 0 WHERE project_id = ? AND agent_id = ?").run(pid, aid1);

    let effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.overrides.disabled_override).toBe(0);
    expect(effective?.in_development).toBe(true);
    expect(() => pas.setScalarOverrides(pid, aid1, { disabled_override: 0 })).toThrow(/cannot set disabled_override=0/);

    dbs.raw.prepare("UPDATE agents SET in_development = 0 WHERE id = ?").run(aid1);
    pas.setScalarOverrides(pid, aid1, { disabled_override: 0 });
    effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.in_development).toBe(false);

    pas.setScalarOverrides(pid, aid1, { disabled_override: 1 });
    effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.in_development).toBe(true);
  });

  it('B8 definition_md_override inherits, overrides exactly, clears on blank, and never mutates Studio definition_md', () => {
    const studioDefinition = '# Studio persona\nSTUDIO-B8-PERSONA';
    const projectDefinition = '  # Project persona\nPROJECT-B8-PERSONA\n';
    dbs.raw.prepare("UPDATE agents SET definition_md = ? WHERE id = ?").run(studioDefinition, aid1);

    pas.addAgent(pid, aid1);
    let effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.definition_md).toBe(studioDefinition);
    expect(effective?.overrides.definition_md_override).toBeNull();

    pas.setScalarOverrides(pid, aid1, { definition_md_override: projectDefinition });
    let row = pas.listProjectAgents(pid)[0];
    effective = assignment.resolveProjectAgent(pid, aid1);
    expect(row.has_persona_override).toBe(true);
    expect('definition_md_override' in row).toBe(false);
    expect(effective?.definition_md).toBe(projectDefinition);
    expect(effective?.overrides.definition_md_override).toBe(projectDefinition);
    expect((dbs.raw.prepare('SELECT definition_md FROM agents WHERE id = ?').get(aid1) as any).definition_md).toBe(studioDefinition);

    pas.setScalarOverrides(pid, aid1, { definition_md_override: '   \n\t  ' });
    row = pas.listProjectAgents(pid)[0];
    effective = assignment.resolveProjectAgent(pid, aid1);
    expect(row.has_persona_override).toBe(false);
    expect(effective?.definition_md).toBe(studioDefinition);
    expect(effective?.overrides.definition_md_override).toBeNull();
  });

  it('B8 definition_md_override enforces the Studio definition size cap', () => {
    pas.addAgent(pid, aid1);
    const max = (loadConfig() as any).AGENT_DEFINITION_MAX || 50000;
    expect(() => pas.setScalarOverrides(pid, aid1, { definition_md_override: 'x'.repeat(max + 1) })).toThrow(/definition_md_override too long/);
  });

  it('B7 collection resolver inherits Studio toolkits/escalations when override flags are false', () => {
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-toolkit-a', null, 'Toolkit A');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-toolkit-b', null, 'Toolkit B');
    const tkA = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-toolkit-a'").get() as any;
    const tkB = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-toolkit-b'").get() as any;
    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid1, tkB.id, 2);
    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid1, tkA.id, 1);
    dbs.raw.prepare("INSERT INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?,?)").run(aid1, 2, mid, 'ibrain');
    dbs.raw.prepare("INSERT INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?,?)").run(aid1, 1, mid, 'on-fail');

    pas.addAgent(pid, aid1);
    const effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.overrides.toolkits_overridden).toBe(false);
    expect(effective?.toolkits.map(t => t.name)).toEqual(['c2-toolkit-a', 'c2-toolkit-b']);
    expect(effective?.toolkits.map(t => t.position)).toEqual([1, 2]);
    expect(effective?.overrides.escalations_overridden).toBe(false);
    expect(effective?.escalations.map(e => e.position)).toEqual([1, 2]);
    expect(effective?.escalations.map(e => e.trigger)).toEqual(['on-fail', 'ibrain']);
  });

  it('B7 collection resolver uses ordered project override rows without mutating Studio rows', () => {
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-studio-toolkit', null, 'Studio toolkit');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-project-toolkit-a', null, 'Project toolkit A');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-project-toolkit-b', null, 'Project toolkit B');
    const studioTk = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-studio-toolkit'").get() as any;
    const projectTkA = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-project-toolkit-a'").get() as any;
    const projectTkB = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-project-toolkit-b'").get() as any;
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)").run('c2-escalation-alt', 'claude', 'claude-escalation-alt', 'claude', 'c2-escalation-alt', 'c2-escalation-alt', 'high');
    const altModel = dbs.raw.prepare("SELECT id FROM models WHERE name='c2-escalation-alt'").get() as any;
    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid1, studioTk.id, 0);
    dbs.raw.prepare("INSERT INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?,?)").run(aid1, 1, mid, 'on-fail');

    pas.addAgent(pid, aid1);
    const toolkits = pas.setProjectAgentToolkits(pid, aid1, {
      overridden: true,
      toolkits: [
        { toolkit_id: projectTkB.id, position: 20 },
        { toolkit_id: projectTkA.id, position: 10 }
      ]
    });
    const escalations = pas.setProjectAgentEscalations(pid, aid1, {
      overridden: true,
      escalations: [
        { position: 2, model_id: mid, trigger: 'ibrain' },
        { position: 1, model_id: altModel.id, trigger: 'plan-summon' }
      ]
    });

    expect(toolkits.overridden).toBe(true);
    expect(toolkits.toolkits.map(t => t.name)).toEqual(['c2-project-toolkit-a', 'c2-project-toolkit-b']);
    expect(escalations.overridden).toBe(true);
    expect(escalations.escalations.map(e => e.position)).toEqual([1, 2]);

    const effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.overrides.toolkits_overridden).toBe(true);
    expect(effective?.toolkits.map(t => t.name)).toEqual(['c2-project-toolkit-a', 'c2-project-toolkit-b']);
    expect(effective?.overrides.escalations_overridden).toBe(true);
    expect(effective?.escalations.map(e => e.model_id)).toEqual([altModel.id, mid]);
    expect(effective?.escalations.map(e => e.trigger)).toEqual(['plan-summon', 'ibrain']);

    const studioToolkitCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM agent_toolkits WHERE agent_id = ?').get(aid1) as any).c;
    const studioEscalationCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM agent_escalations WHERE agent_id = ?').get(aid1) as any).c;
    expect(studioToolkitCount).toBe(1);
    expect(studioEscalationCount).toBe(1);
  });

  it('B7 collection resolver treats overridden empty rows as explicit empty and can revert to inherit', () => {
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-inherited-toolkit', null, 'Inherited toolkit');
    const inheritedTk = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-inherited-toolkit'").get() as any;
    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid1, inheritedTk.id, 0);
    dbs.raw.prepare("INSERT INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?,?)").run(aid1, 1, mid, 'on-fail');

    pas.addAgent(pid, aid1);
    pas.setProjectAgentToolkits(pid, aid1, { overridden: true, toolkits: [] });
    pas.setProjectAgentEscalations(pid, aid1, { overridden: true, escalations: [] });
    let effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.overrides.toolkits_overridden).toBe(true);
    expect(effective?.toolkits).toEqual([]);
    expect(effective?.overrides.escalations_overridden).toBe(true);
    expect(effective?.escalations).toEqual([]);

    pas.setProjectAgentToolkits(pid, aid1, { overridden: false });
    pas.setProjectAgentEscalations(pid, aid1, { overridden: false });
    effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.overrides.toolkits_overridden).toBe(false);
    expect(effective?.toolkits.map(t => t.name)).toEqual(['c2-inherited-toolkit']);
    expect(effective?.overrides.escalations_overridden).toBe(false);
    expect(effective?.escalations.map(e => e.trigger)).toEqual(['on-fail']);
  });

  it('B9fix1 F1: attach on inheriting agent seeds Studio toolkits then adds new (A,B,C + D → effective A,B,C,D)', () => {
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-studio-a', null, 'Studio A');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-studio-b', null, 'Studio B');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-studio-c', null, 'Studio C');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-project-d', null, 'Project D');
    const tkA = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-studio-a'").get() as any;
    const tkB = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-studio-b'").get() as any;
    const tkC = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-studio-c'").get() as any;
    const tkD = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-project-d'").get() as any;
    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid1, tkA.id, 1);
    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid1, tkB.id, 2);
    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid1, tkC.id, 3);

    pas.addAgent(pid, aid1);
    pas.attachProjectAgentToolkit(pid, aid1, tkD.id);

    const effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.overrides.toolkits_overridden).toBe(true);
    expect(effective?.toolkits.map(t => t.name)).toEqual(['c2-studio-a', 'c2-studio-b', 'c2-studio-c', 'c2-project-d']);
    expect(effective?.toolkits.map(t => t.position)).toEqual([1, 2, 3, 4]);
    const studioCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM agent_toolkits WHERE agent_id = ?').get(aid1) as any).c;
    expect(studioCount).toBe(3);
  });

  it('B9fix1 F1: attach on already-overridden agent appends without re-seeding Studio rows', () => {
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-studio-only', null, 'Studio only');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-project-x', null, 'Project X');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-project-y', null, 'Project Y');
    const studioTk = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-studio-only'").get() as any;
    const projectX = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-project-x'").get() as any;
    const projectY = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-project-y'").get() as any;
    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid1, studioTk.id, 0);

    pas.addAgent(pid, aid1);
    pas.setProjectAgentToolkits(pid, aid1, { overridden: true, toolkits: [{ toolkit_id: projectX.id, position: 5 }] });
    pas.attachProjectAgentToolkit(pid, aid1, projectY.id);

    const effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.toolkits.map(t => t.name)).toEqual(['c2-project-x', 'c2-project-y']);
    expect(effective?.toolkits.map(t => t.position)).toEqual([5, 6]);
  });

  it('B9fix1 F1: upsert escalation on inheriting agent seeds Studio rungs then applies new', () => {
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)").run('c2-esc-studio', 'claude', 'claude-studio-esc', 'claude', 'c2-esc-studio', 'c2-esc-studio', 'medium');
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)").run('c2-esc-project', 'claude', 'claude-project-esc', 'claude', 'c2-esc-project', 'c2-esc-project', 'high');
    const studioModel = dbs.raw.prepare("SELECT id FROM models WHERE name='c2-esc-studio'").get() as any;
    const projectModel = dbs.raw.prepare("SELECT id FROM models WHERE name='c2-esc-project'").get() as any;
    dbs.raw.prepare("INSERT INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?,?)")
      .run(aid1, 1, studioModel.id, 'on-fail');

    pas.addAgent(pid, aid1);
    pas.upsertProjectAgentEscalation(pid, aid1, { position: 2, model_id: projectModel.id, trigger: 'ibrain' });

    const effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.overrides.escalations_overridden).toBe(true);
    expect(effective?.escalations.map(e => e.position)).toEqual([1, 2]);
    expect(effective?.escalations.map(e => e.trigger)).toEqual(['on-fail', 'ibrain']);
    expect(effective?.escalations.map(e => e.model_id)).toEqual([studioModel.id, projectModel.id]);
    const studioCount = (dbs.raw.prepare('SELECT COUNT(*) as c FROM agent_escalations WHERE agent_id = ?').get(aid1) as any).c;
    expect(studioCount).toBe(1);
  });

  it('B9fix1 F1: upsert escalation on already-overridden agent updates project set only', () => {
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)").run('c2-esc-studio2', 'claude', 'claude-studio2', 'claude', 'c2-esc-studio2', 'c2-esc-studio2', 'low');
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)").run('c2-esc-proj2', 'claude', 'claude-proj2', 'claude', 'c2-esc-proj2', 'c2-esc-proj2', 'high');
    const studioModel = dbs.raw.prepare("SELECT id FROM models WHERE name='c2-esc-studio2'").get() as any;
    const projectModel = dbs.raw.prepare("SELECT id FROM models WHERE name='c2-esc-proj2'").get() as any;
    dbs.raw.prepare("INSERT INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?,?)")
      .run(aid1, 1, studioModel.id, 'on-fail');

    pas.addAgent(pid, aid1);
    pas.setProjectAgentEscalations(pid, aid1, {
      overridden: true,
      escalations: [{ position: 1, model_id: mid, trigger: 'plan-summon' }]
    });
    pas.upsertProjectAgentEscalation(pid, aid1, { position: 2, model_id: projectModel.id, trigger: 'ibrain' });

    const effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.escalations.map(e => e.position)).toEqual([1, 2]);
    expect(effective?.escalations.map(e => e.trigger)).toEqual(['plan-summon', 'ibrain']);
    expect(effective?.escalations.map(e => e.model_id)).toEqual([mid, projectModel.id]);
  });

  it('B7 attach/detach and escalation upsert/delete set override flags and preserve explicit empty after delete', () => {
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-attach-toolkit', null, 'Attach toolkit');
    const toolkit = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-attach-toolkit'").get() as any;

    pas.addAgent(pid, aid1);
    pas.attachProjectAgentToolkit(pid, aid1, toolkit.id);
    pas.upsertProjectAgentEscalation(pid, aid1, { position: 1, model_id: mid, trigger: 'on-fail' });
    let effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.overrides.toolkits_overridden).toBe(true);
    expect(effective?.toolkits.map(t => t.name)).toEqual(['c2-attach-toolkit']);
    expect(effective?.overrides.escalations_overridden).toBe(true);
    expect(effective?.escalations.map(e => e.model_id)).toEqual([mid]);

    pas.detachProjectAgentToolkit(pid, aid1, toolkit.id);
    pas.deleteProjectAgentEscalation(pid, aid1, 1);
    effective = assignment.resolveProjectAgent(pid, aid1);
    expect(effective?.overrides.toolkits_overridden).toBe(true);
    expect(effective?.toolkits).toEqual([]);
    expect(effective?.overrides.escalations_overridden).toBe(true);
    expect(effective?.escalations).toEqual([]);
  });

  it('B9a deleting an agent cascades project_agents plus project toolkit/escalation override children', () => {
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-cascade-toolkit', null, 'Cascade toolkit');
    const toolkit = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-cascade-toolkit'").get() as any;

    pas.addAgent(pid, aid1);
    pas.attachProjectAgentToolkit(pid, aid1, toolkit.id);
    pas.upsertProjectAgentEscalation(pid, aid1, { position: 1, model_id: mid, trigger: 'on-fail' });

    dbs.raw.prepare('DELETE FROM agents WHERE id = ?').run(aid1);

    expect((dbs.raw.prepare('SELECT COUNT(*) as c FROM project_agents WHERE project_id = ? AND agent_id = ?').get(pid, aid1) as any).c).toBe(0);
    expect((dbs.raw.prepare('SELECT COUNT(*) as c FROM project_agent_toolkits WHERE project_id = ? AND agent_id = ?').get(pid, aid1) as any).c).toBe(0);
    expect((dbs.raw.prepare('SELECT COUNT(*) as c FROM project_agent_escalations WHERE project_id = ? AND agent_id = ?').get(pid, aid1) as any).c).toBe(0);
  });

  it('B9fix3 F5: setAllToDefault clears every override and resolves full Studio inherit', () => {
    dbs.raw.prepare("INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort) VALUES (?,?,?,?,?,?,?)").run('c2-backup-model', 'claude', 'claude-opus-4-8', 'claude', 'c2-backup-model', 'c2-backup-model', 'high');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-studio-tk', null, 'Studio toolkit');
    dbs.raw.prepare("INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?)").run('c2-project-tk', null, 'Project toolkit');
    const backup = dbs.raw.prepare("SELECT id FROM models WHERE name='c2-backup-model'").get() as any;
    const studioTk = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-studio-tk'").get() as any;
    const projectTk = dbs.raw.prepare("SELECT id FROM toolkits WHERE name='c2-project-tk'").get() as any;
    const studioDefinition = '# Studio persona\nSTUDIO-F5';
    const projectDefinition = '# Project persona\nPROJECT-F5';
    dbs.raw.prepare("UPDATE agents SET default_model_id = ?, backup_model_id = ?, default_effort = ?, spawn_pref = ?, definition_md = ? WHERE id = ?")
      .run(mid, backup.id, 'medium', 'tmux', studioDefinition, aid1);
    dbs.raw.prepare("INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)").run(aid1, studioTk.id, 1);
    dbs.raw.prepare("INSERT INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (?,?,?,?)")
      .run(aid1, 1, mid, 'on-fail');

    pas.addAgent(pid, aid1);
    const baseline = assignment.resolveProjectAgent(pid, aid1)!;

    pas.setModelOverride(pid, aid1, { model_id: mid });
    pas.setScalarOverrides(pid, aid1, {
      backup_model_id: backup.id,
      effort_override: 'high',
      spawn_pref_override: 'in-process',
      disabled_override: 1,
      definition_md_override: projectDefinition
    });
    pas.setProjectAgentToolkits(pid, aid1, { overridden: true, toolkits: [{ toolkit_id: projectTk.id, position: 1 }] });
    pas.setProjectAgentEscalations(pid, aid1, { overridden: true, escalations: [{ position: 2, model_id: backup.id, trigger: 'ibrain' }] });

    pas.setAllToDefault(pid);

    const row = pas.listProjectAgents(pid)[0];
    const effective = assignment.resolveProjectAgent(pid, aid1)!;
    expect(row.model_id).toBeNull();
    expect(row.use_dynamic).toBe(0);
    expect(row.backup_model_id).toBeNull();
    expect(row.effort_override).toBeNull();
    expect(row.spawn_pref_override).toBeNull();
    expect(row.disabled_override).toBeNull();
    expect(row.has_persona_override).toBe(false);
    expect(row.toolkits_overridden).toBe(0);
    expect(row.escalations_overridden).toBe(0);
    expect((dbs.raw.prepare('SELECT COUNT(*) as c FROM project_agent_toolkits WHERE project_id = ?').get(pid) as any).c).toBe(0);
    expect((dbs.raw.prepare('SELECT COUNT(*) as c FROM project_agent_escalations WHERE project_id = ?').get(pid) as any).c).toBe(0);
    expect(effective.model.type).toBe(baseline.model.type);
    expect(effective.model.id).toBe(baseline.model.id);
    expect(effective.backup_model_id).toBe(baseline.backup_model_id);
    expect(effective.effort).toBe(baseline.effort);
    expect(effective.spawn_pref).toBe(baseline.spawn_pref);
    expect(effective.in_development).toBe(baseline.in_development);
    expect(effective.definition_md).toBe(baseline.definition_md);
    expect(effective.toolkits.map(t => t.name)).toEqual(baseline.toolkits.map(t => t.name));
    expect(effective.escalations.map(e => e.position)).toEqual(baseline.escalations.map(e => e.position));
    expect((dbs.raw.prepare('SELECT COUNT(*) as c FROM agent_toolkits WHERE agent_id = ?').get(aid1) as any).c).toBe(1);
    expect((dbs.raw.prepare('SELECT COUNT(*) as c FROM agent_escalations WHERE agent_id = ?').get(aid1) as any).c).toBe(1);
    expect((dbs.raw.prepare('SELECT definition_md FROM agents WHERE id = ?').get(aid1) as any).definition_md).toBe(studioDefinition);

    pas.setAllToDefault(pid);
    expect(assignment.resolveProjectAgent(pid, aid1)!.definition_md).toBe(baseline.definition_md);
  });

  it('add-all is idempotent (adds missing only; re-call no dups)', () => {
    // no agents added yet
    pas.addAllAgents(pid);
    let rows = pas.listProjectAgents(pid);
    expect(rows.length).toBeGreaterThanOrEqual(2); // at least the 2 seeded
    const before = rows.length;
    pas.addAllAgents(pid);
    rows = pas.listProjectAgents(pid);
    expect(rows.length).toBe(before); // idempotent
  });

  it('v8→SCHEMA_VERSION on a synthetic v8 fixture: migration chain reaches current version, adds project_agents, data counts survive', () => {
    const testCopy = path.join(os.tmpdir(), `helm-c2-mig-${Date.now()}.db`);
    try {
      makeV8FixtureDb(testCopy); // real v8 DDL (agents+toolkits+no models/projects/project_agents)
      const migDbs = new DatabaseService(testCopy); // full chain v8→SCHEMA_VERSION
      const ver = (migDbs.raw.prepare("SELECT version FROM schema_version").get() as any).version;
      expect(ver).toBe(SCHEMA_VERSION);

      const hasPa = !!migDbs.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='project_agents'").get();
      expect(hasPa).toBe(true);

      // v9 migration seeds models; v8 fixture seeded 1 agent
      const agentsC = (migDbs.raw.prepare("SELECT COUNT(*) as c FROM agents").get() as any).c;
      const modelsC = (migDbs.raw.prepare("SELECT COUNT(*) as c FROM models").get() as any).c;
      expect(agentsC).toBeGreaterThan(0);
      expect(modelsC).toBeGreaterThan(0);

      // project_agents usable; no project rows in synthetic fixture
      const paCount = (migDbs.raw.prepare("SELECT COUNT(*) as c FROM project_agents").get() as any).c;
      expect(paCount).toBeGreaterThanOrEqual(0);
    } finally {
      try { fs.unlinkSync(testCopy); } catch {}
    }
  });

  it('D5: addAgent rejects agent with in_development=1', () => {
    // seed an in_development agent
    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort, in_development) VALUES (?,?,?,?,?)").run('c2-dev-agent', 'claude', 'claude-sonnet-4-6', 'medium', 1);
    const devAgent = dbs.raw.prepare("SELECT id FROM agents WHERE name='c2-dev-agent'").get() as any;
    expect(() => pas.addAgent(pid, devAgent.id)).toThrow(/in.development/);
    // must not be in the project_agents table
    const rows = pas.listProjectAgents(pid);
    expect(rows.find((r: any) => r.agent_id === devAgent.id)).toBeUndefined();
  });

  it('D5: addAllAgents skips in_development agents', () => {
    // seed 1 in_development (aid1 + aid2 from beforeEach are both in_development=0 by default)
    dbs.raw.prepare("INSERT INTO agents (name, provider, model, default_effort, in_development) VALUES (?,?,?,?,?)").run('c2-dev-only', 'claude', 'claude-sonnet-4-6', 'medium', 1);
    const devOnly = dbs.raw.prepare("SELECT id FROM agents WHERE name='c2-dev-only'").get() as any;
    pas.addAllAgents(pid);
    const rows = pas.listProjectAgents(pid);
    // in_development agent must NOT be in project
    expect(rows.find((r: any) => r.agent_id === devOnly.id)).toBeUndefined();
    // aid1 + aid2 (ready) must be present
    expect(rows.find((r: any) => r.agent_id === aid1)).toBeTruthy();
    expect(rows.find((r: any) => r.agent_id === aid2)).toBeTruthy();
  });
});

describe('C4 ProjectDocsService (P4): listProjectDocs + readProjectDoc + path-traversal guard (MUST prove ../ + abs + symlink-out + non-.md rejected; read never escapes project dir)', () => {
  let dbPath: string;
  let cleanup: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;
  let docsSvc: ProjectDocsService;
  let projDir: string;
  let projId: number;

  beforeEach(() => {
    const t = makeTempDb();
    dbPath = t.dbPath;
    cleanup = t.cleanup;
    dbs = new DatabaseService(dbPath);
    ps = new ProjectService(dbs);
    docsSvc = new ProjectDocsService(ps);

    // real temp project dir + seeded top-level *.md (convention: direct children only)
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-c4-proj-'));
    fs.writeFileSync(path.join(projDir, 'north-star.md'), '# North Star\nProject mission, constraints, and non-negotiables — anchors every batch decision\n');
    fs.writeFileSync(path.join(projDir, 'coding-standards.md'), 'Language conventions, lint rules, naming patterns\n');
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('C4-test-prefs', projDir);
    const p = dbs.raw.prepare("SELECT id FROM projects WHERE name='C4-test-prefs'").get() as any;
    projId = p.id;
  });

  afterEach(() => {
    cleanup();
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  it('listProjectDocs finds seeded top-level .md, extracts description (first heading or first line), includes size', async () => {
    const list = await docsSvc.listProjectDocs(projId);
    expect(list.length).toBe(2);
    expect(list[0].filename).toBe('coding-standards.md');
    expect(list[0].description).toContain('Language conventions');
    expect(list[1].filename).toBe('north-star.md');
    expect(list[1].description).toContain('North Star');
    expect(typeof list[0].size).toBe('number');
    expect(list[0].size).toBeGreaterThan(0);
  });

  it('readProjectDoc returns full content for valid .md', async () => {
    const d = await docsSvc.readProjectDoc(projId, 'north-star.md');
    expect(d.filename).toBe('north-star.md');
    expect(d.content).toContain('anchors every batch decision');
    expect(d.size).toBeGreaterThan(0);
  });

  it('rejects non-.md (even if file exists in dir)', async () => {
    fs.writeFileSync(path.join(projDir, 'evil.txt'), 'bad');
    await expect(docsSvc.readProjectDoc(projId, 'evil.txt')).rejects.toThrow(/only .md/);
  });

  it('traversal guard: ../ , absolute path, AND symlink pointing outside are ALL rejected (read never escapes the project dir)', async () => {
    // ../ (md suffix to pass basename check and reach realpath guard)
    await expect(docsSvc.readProjectDoc(projId, '../north-star.md')).rejects.toThrow(/traversal|blocked/);

    // absolute (md suffix to pass basename check and reach realpath guard)
    await expect(docsSvc.readProjectDoc(projId, '/tmp/evil.md')).rejects.toThrow(/traversal|blocked/);

    // symlink-out (already .md named)
    const outside = path.join(os.tmpdir(), `helm-c4-outside-${Date.now()}.md`);
    fs.writeFileSync(outside, 'SECRET-OUTSIDE');
    const linkInside = path.join(projDir, 'escape.md');
    fs.symlinkSync(outside, linkInside);
    await expect(docsSvc.readProjectDoc(projId, 'escape.md')).rejects.toThrow(/traversal|blocked|symlink/);
    try { fs.unlinkSync(linkInside); fs.unlinkSync(outside); } catch {}
  });

  it('empty dir yields [] (no docs)', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-c4-empty-'));
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('C4-empty', emptyDir);
    const p2 = dbs.raw.prepare("SELECT id FROM projects WHERE name='C4-empty'").get() as any;
    const list = await docsSvc.listProjectDocs(p2.id);
    expect(list).toEqual([]);
    fs.rmSync(emptyDir, { recursive: true, force: true });
  });

  it('B4a: getTechStackSummary extracts Language / Framework / Key Dependencies via guarded readProjectDoc path', async () => {
    const stackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b4a-stack-'));
    fs.mkdirSync(path.join(stackDir, 'helm_docs'), { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'helm_docs', 'tech-stack.md'), [
      '# Tech Stack',
      '',
      '## Language',
      'TypeScript',
      '',
      '## Framework',
      'Fastify + vanilla Preact/HTM',
      '',
      '## Key Dependencies',
      '- better-sqlite3',
      '- @fastify/static',
      '- vitest'
    ].join('\n'));
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('B4a-stack', stackDir);
    const p = dbs.raw.prepare("SELECT id FROM projects WHERE name='B4a-stack'").get() as any;

    const summary = await docsSvc.getTechStackSummary(p.id);

    expect(summary).toEqual({
      language: 'TypeScript',
      framework: 'Fastify + vanilla Preact/HTM',
      key_dependencies: 'better-sqlite3, @fastify/static, vitest'
    });
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('B4a: empty tech-stack headings return null field values, not blanks or crashes', async () => {
    const stackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b4a-empty-stack-'));
    fs.mkdirSync(path.join(stackDir, 'helm_docs'), { recursive: true });
    fs.writeFileSync(path.join(stackDir, 'helm_docs', 'tech-stack.md'), '# Tech Stack\n\n## Language\n\n## Framework\n\n## Key Dependencies\n');
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('B4a-empty-stack', stackDir);
    const p = dbs.raw.prepare("SELECT id FROM projects WHERE name='B4a-empty-stack'").get() as any;

    const summary = await docsSvc.getTechStackSummary(p.id);

    expect(summary).toEqual({
      language: null,
      framework: null,
      key_dependencies: null
    });
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  it('B4a: missing helm_docs/tech-stack.md returns null summary for graceful UI state', async () => {
    const stackDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b4a-missing-stack-'));
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('B4a-missing-stack', stackDir);
    const p = dbs.raw.prepare("SELECT id FROM projects WHERE name='B4a-missing-stack'").get() as any;

    await expect(docsSvc.getTechStackSummary(p.id)).resolves.toBeNull();
    fs.rmSync(stackDir, { recursive: true, force: true });
  });

  // E-b1 G12: scoped helm_tasks tree via new method; groups under tasklist/task; node_modules/vendor excluded
  it('E-b1: listProjectHelmTasksMdTree returns only under helm_tasks/ with relPath prefixed, excludes node_modules/vendor', async () => {
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-eb1-docs-'));
    const helmDir = path.join(projDir, 'helm_tasks');
    const list1 = 'tasklist-run1';
    const taskA = 'task-abc';
    const taskB = 'task-def';
    fs.mkdirSync(path.join(helmDir, list1, taskA, 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(helmDir, list1, taskB, 'validation'), { recursive: true });
    fs.mkdirSync(path.join(helmDir, list1, taskA, 'node_modules', 'junk'), { recursive: true });
    fs.mkdirSync(path.join(helmDir, list1, taskB, 'vendor'), { recursive: true });
    fs.writeFileSync(path.join(helmDir, list1, taskA, 'changes.md'), '# Changes for taskA\nbody');
    fs.writeFileSync(path.join(helmDir, list1, taskA, 'prompts/impl.brief.md'), '# brief');
    fs.writeFileSync(path.join(helmDir, list1, taskB, 'validation/report.md'), '# report');
    // a .md that must be excluded because in node_modules
    fs.writeFileSync(path.join(helmDir, list1, taskA, 'node_modules', 'junk', 'bad.md'), '# bad');
    // top level project .md must NOT appear in helm scoped tree
    fs.writeFileSync(path.join(projDir, 'north-star.md'), '# north');

    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('eb1-helm', projDir);
    const p = dbs.raw.prepare("SELECT id FROM projects WHERE name='eb1-helm'").get() as any;
    const tree = await docsSvc.listProjectHelmTasksMdTree(p.id);
    const rels = tree.map((x: any) => x.relPath).sort();
    expect(rels).toEqual([
      'helm_tasks/tasklist-run1/task-abc/changes.md',
      'helm_tasks/tasklist-run1/task-abc/prompts/impl.brief.md',
      'helm_tasks/tasklist-run1/task-def/validation/report.md'
    ]);
    // no node_modules entries
    expect(rels.some((r: string) => r.includes('node_modules'))).toBe(false);
    expect(rels.some((r: string) => r.includes('vendor'))).toBe(false);
    // grouped visibly: all start helm_tasks/ + tasklist + task
    expect(tree.every((d: any) => d.relPath.startsWith('helm_tasks/') && d.relPath.split('/').length >= 4)).toBe(true);

    // also test via route? (direct service sufficient; route delegates)
    fs.rmSync(projDir, { recursive: true, force: true });
  });
});

describe('I1: scaffoldProjectFolders (R-05D/G)', () => {
  let tmpDir: string;
  let docsSvc: ProjectDocsService;

  beforeEach(async () => {
    tmpDir = await import('node:os').then(os => os.tmpdir()) + '/helm-i1-' + Math.random().toString(36).slice(2);
    await import('node:fs/promises').then(fs => fs.mkdir(tmpDir, { recursive: true }));
    // ProjectDocsService needs a ProjectService; we only need getProject for dir resolution
    // but scaffoldProjectFolders takes a raw directory string — call directly.
    docsSvc = new ProjectDocsService({} as any);
  });

  afterEach(async () => {
    try { await import('node:fs/promises').then(fs => fs.rm(tmpDir, { recursive: true, force: true })); } catch {}
  });

  it('I1-1: creates helm_docs/ and helm_tasks/ directories', async () => {
    await docsSvc.scaffoldProjectFolders(tmpDir);
    const fsp = await import('node:fs/promises');
    const helmDocs = await fsp.stat(tmpDir + '/helm_docs');
    const helmTasks = await fsp.stat(tmpDir + '/helm_tasks');
    expect(helmDocs.isDirectory()).toBe(true);
    expect(helmTasks.isDirectory()).toBe(true);
  });

  it('I1-2: writes 4 starter stubs in helm_docs with correct filenames and non-empty content', async () => {
    await docsSvc.scaffoldProjectFolders(tmpDir);
    const fsp = await import('node:fs/promises');
    const files = await fsp.readdir(tmpDir + '/helm_docs');
    expect(files.sort()).toEqual(['overview.md', 'preferences.md', 'specs.md', 'tech-stack.md']);
    const techStack = await fsp.readFile(tmpDir + '/helm_docs/tech-stack.md', 'utf8');
    expect(techStack).toContain('# Tech Stack');
    const overview = await fsp.readFile(tmpDir + '/helm_docs/overview.md', 'utf8');
    expect(overview).toContain('# Project Overview');
  });

  it('I1-3: is idempotent — does not overwrite existing stubs', async () => {
    await docsSvc.scaffoldProjectFolders(tmpDir);
    const fsp = await import('node:fs/promises');
    await fsp.writeFile(tmpDir + '/helm_docs/tech-stack.md', '# Custom Content\n', 'utf8');
    await docsSvc.scaffoldProjectFolders(tmpDir); // second call
    const content = await fsp.readFile(tmpDir + '/helm_docs/tech-stack.md', 'utf8');
    expect(content).toBe('# Custom Content\n'); // not overwritten
  });

  // B7 (R6.27): .gitignore must carry tmp/ (the cycle chat-file writer's scratch root) —
  // idempotently: create if absent, append-only (preserving all existing content) if present.
  it('B7-1: no existing .gitignore — scaffold creates one containing tmp/', async () => {
    await docsSvc.scaffoldProjectFolders(tmpDir);
    const fsp = await import('node:fs/promises');
    const content = await fsp.readFile(tmpDir + '/.gitignore', 'utf8');
    expect(content.split(/\r?\n/).map((l: string) => l.trim())).toContain('tmp/');
  });

  it('B7-2: existing .gitignore with custom content — tmp/ is appended, custom content preserved untouched', async () => {
    const fsp = await import('node:fs/promises');
    await fsp.writeFile(tmpDir + '/.gitignore', 'node_modules/\ndist/\n', 'utf8');
    await docsSvc.scaffoldProjectFolders(tmpDir);
    const content = await fsp.readFile(tmpDir + '/.gitignore', 'utf8');
    expect(content).toContain('node_modules/');
    expect(content).toContain('dist/');
    expect(content.split(/\r?\n/).map((l: string) => l.trim())).toContain('tmp/');
  });

  it('B7-3: a second scaffold call is a no-op for .gitignore — no duplicate tmp/ line, custom content still intact', async () => {
    const fsp = await import('node:fs/promises');
    await fsp.writeFile(tmpDir + '/.gitignore', 'node_modules/\n', 'utf8');
    await docsSvc.scaffoldProjectFolders(tmpDir);
    const afterFirst = await fsp.readFile(tmpDir + '/.gitignore', 'utf8');
    await docsSvc.scaffoldProjectFolders(tmpDir); // second call
    const afterSecond = await fsp.readFile(tmpDir + '/.gitignore', 'utf8');
    expect(afterSecond).toBe(afterFirst); // byte-identical — no duplicate tmp/ appended
    expect(afterSecond.split(/\r?\n/).filter((l: string) => l.trim() === 'tmp/').length).toBe(1);
  });
});

describe('I3: project_maintainer seed superseded by B09a/B09b roster (R-05F → R2.8–R2.11)', () => {
  it('I3-1: fresh DB — project_maintainer is NOT seeded (B09b prune; non-canonical)', async () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    try {
      const row = dbs.raw.prepare("SELECT name FROM agents WHERE name='project_maintainer'").get() as any;
      expect(row).toBeFalsy();
    } finally { dbs.close(); t.cleanup(); }
  });

  it('I3-2: fresh DB — canonical house agent-master is team-eligible (default_model_id set)', async () => {
    const t = makeTempDb();
    const dbs = new DatabaseService(t.dbPath);
    try {
      const row = dbs.raw.prepare("SELECT default_model_id FROM agents WHERE name='agent-master'").get() as any;
      expect(row).toBeTruthy();
      expect(row.default_model_id).not.toBeNull();
    } finally { dbs.close(); t.cleanup(); }
  });
});
