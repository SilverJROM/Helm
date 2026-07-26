import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import Fastify from 'fastify';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';
import { ProjectService } from './services/project-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { createRequireLocalLaunch } from './guardrails.js';
import { registerProjectAgentRoutes } from './api/routes/project-agent-routes.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9fix7-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

function makeLeanListDb(dbPath: string) {
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
      VALUES (1, 'b9fix7-null-effort', 'claude', 'claude-opus-4-8', NULL, NULL, '# Studio');
    INSERT INTO projects (id, name, directory) VALUES (10, 'B9fix7-proj', '/tmp/b9fix7');
    INSERT INTO project_agents (id, project_id, agent_id) VALUES (100, 10, 1);
  `);
  old.close();
}

describe('B9fix7 H1 null-safe lean effort', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let pas: ProjectAgentService;
  let pid: number;
  let aid: number;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    makeLeanListDb(t.dbPath);
    dbs = new DatabaseService(t.dbPath);
    pas = new ProjectAgentService(dbs, new AgentAssignmentService(dbs));
    pid = 10;
    aid = 1;
  });

  afterEach(() => cleanup());

  it('lean list effort is null (not the string "null") when agent default_effort is NULL', () => {
    const row = pas.listProjectAgents(pid)[0];
    expect(row.effective.effort).toBeNull();
    expect(row.effective.effort).not.toBe('null');
    expect(row.effective.spawn_pref).toBe('tmux');
    expect(JSON.stringify(row.effective)).not.toContain('"effort":"null"');
  });

  it('lean list spawn_pref falls back to tmux when both override and agent default are NULL', () => {
    const lean = pas.listProjectAgents(pid)[0].effective;
    expect(lean.spawn_pref).toBe('tmux');
    expect(lean.spawn_pref).not.toBe('null');
  });
});

describe('B9fix7 H2 applyAgentOverrides upfront existence guard', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let pas: ProjectAgentService;
  let pid: number;
  let memberAid: number;
  let absentAid: number;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    const assignment = new AgentAssignmentService(dbs);
    pas = new ProjectAgentService(dbs, assignment);

    dbs.raw.prepare(
      "INSERT INTO agents (name, provider, model, default_effort, definition_md) VALUES (?,?,?,?,?)"
    ).run('b9fix7-primary', 'claude', 'claude-opus-4-8', 'medium', '# A');
    dbs.raw.prepare(
      "INSERT INTO agents (name, provider, model, default_effort, definition_md) VALUES (?,?,?,?,?)"
    ).run('b9fix7-absent', 'claude', 'claude-opus-4-8', 'medium', '# B');
    memberAid = (dbs.raw.prepare("SELECT id FROM agents WHERE name='b9fix7-primary'").get() as any).id;
    absentAid = (dbs.raw.prepare("SELECT id FROM agents WHERE name='b9fix7-absent'").get() as any).id;
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('B9fix7-primary-proj', '/tmp/b9fix7p');
    pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name='B9fix7-primary-proj'").get() as any).id;
    pas.addAgent(pid, memberAid);
    pas.setPrimaryDriver(pid, memberAid);
  });

  afterEach(() => cleanup());

  it('is_primary-only PUT for absent pair errors before mutating primaries', () => {
    expect(() => pas.applyAgentOverrides(pid, absentAid, { is_primary_driver: true }))
      .toThrow(/project agent not found/);

    const row = dbs.raw.prepare(
      'SELECT agent_id, is_primary_driver FROM project_agents WHERE project_id = ?'
    ).all(pid) as any[];
    expect(row).toHaveLength(1);
    expect(row[0].agent_id).toBe(memberAid);
    expect(row[0].is_primary_driver).toBe(1);
  });
});

describe('B9fix7 H3 malformed toolkits/escalations → 400', () => {
  let cleanup: () => void;
  let app: Fastify.FastifyInstance;
  let pid: number;
  let aid: number;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    const dbs = new DatabaseService(t.dbPath);
    const projectService = new ProjectService(dbs);
    const assignmentService = new AgentAssignmentService(dbs);
    const projectAgentService = new ProjectAgentService(dbs, assignmentService);

    dbs.raw.prepare(
      "INSERT INTO agents (name, provider, model, default_effort, definition_md) VALUES (?,?,?,?,?)"
    ).run('b9fix7-api', 'claude', 'claude-opus-4-8', 'medium', '# API');
    aid = (dbs.raw.prepare("SELECT id FROM agents WHERE name='b9fix7-api'").get() as any).id;
    dbs.raw.prepare("INSERT INTO projects (name, directory) VALUES (?,?)").run('B9fix7-api', '/tmp/b9fix7-api');
    pid = (dbs.raw.prepare("SELECT id FROM projects WHERE name='B9fix7-api'").get() as any).id;
    projectAgentService.addAgent(pid, aid);

    app = Fastify({ logger: false });
    registerProjectAgentRoutes(app, {
      projectService,
      projectAgentService,
      assignmentService,
      authMiddleware: ownerAuth,
      requireOwnerPre: createRequireOwner(),
      requireLocalLaunchPre: createRequireLocalLaunch()
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    cleanup();
  });

  it('PUT with toolkits:null returns 400 not 500', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: { toolkits: null }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid toolkits payload/i);
  });

  it('PUT with toolkits:5 returns 400 not 500', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: { toolkits: 5 }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid toolkits payload/i);
  });

  it('PUT with escalations:null returns 400 not 500', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/agents/${aid}`,
      remoteAddress: '127.0.0.1',
      payload: { escalations: null }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/invalid escalations payload/i);
  });
});

describe('B9fix7 H4 v19 horizon ALTER idempotent re-entry', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    for (const c of cleanups.splice(0)) c();
  });

  it('re-open after simulated v18 re-entry with horizon present does not duplicate-column crash', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b9fix7-v19-${Date.now()}.db`);
    cleanups.push(() => { try { fs.unlinkSync(testCopy); } catch {} });

    const first = new DatabaseService(testCopy);
    const colsBefore = first.raw.prepare("PRAGMA table_info(memories)").all().map((c: any) => c.name);
    expect(colsBefore).toContain('horizon');
    first.close();

    const raw = new Database(testCopy);
    raw.prepare('UPDATE schema_version SET version = 18').run();
    raw.close();

    expect(() => {
      const second = new DatabaseService(testCopy);
      const ver = (second.raw.prepare('SELECT version FROM schema_version').get() as any).version;
      expect(ver).toBe(SCHEMA_VERSION);
      second.close();
    }).not.toThrow();
  });

  it('database.ts v19 block uses PRAGMA table_info guard for horizon', () => {
    const src = fs.readFileSync(path.join(process.cwd(), 'src/db/database.ts'), 'utf8');
    const v19Block = src.slice(src.indexOf('current.version < 19'), src.indexOf('current.version < 29'));
    expect(v19Block).toContain('PRAGMA table_info(memories)');
    expect(v19Block).toContain("!cols.includes('horizon')");
  });
});