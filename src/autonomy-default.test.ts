import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import Database from 'better-sqlite3';
import { ProjectService, DEFAULT_AUTONOMY_DEFAULT } from './services/project-service.js';
import { MasterModelService } from './services/master-model-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { createRequireLocalLaunch } from './guardrails.js';
import { CycleService } from './services/cycle-service.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b1t02-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

async function buildConfigApiApp(dbs: DatabaseService) {
  const projectService = new ProjectService(dbs);
  const masterService = new MasterModelService(dbs);
  const assignmentService = new AgentAssignmentService(dbs);
  const db = dbs;
  const app = Fastify({ logger: false });
  const requireOwnerPre = createRequireOwner();
  const requireLocalLaunchPre = createRequireLocalLaunch();

  app.get('/api/projects/:id/config', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    const master_chain = masterService.getChain(projectId);
    const bindings = assignmentService.listProjectBindings(projectId);
    const team_bindings = assignmentService.listProjectTeamBindings(projectId);
    const role_defaults = assignmentService.listRoleDefaults();
    const is_set_up = masterService.isSetUp(projectId);
    const autonomy_default = projectService.getAutonomyDefault(projectId);
    return { master_chain, bindings, team_bindings, role_defaults, is_set_up, autonomy_default };
  });

  app.put('/api/projects/:id/config', { preHandler: [ownerAuth, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
    const projectId = Number(request.params.id);
    const exists = db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!exists) return reply.code(400).send({ error: 'unknown project' });
    const body = request.body || {};
    const { master_chain = [], bindings = [], team_bindings = [] } = body;
    if (!Array.isArray(master_chain) || master_chain.length > 10) return reply.code(400).send({ error: 'invalid master_chain (array, max 10)' });
    if (!Array.isArray(bindings)) return reply.code(400).send({ error: 'invalid bindings' });
    const raw = (db as any).raw;
    raw.exec('BEGIN IMMEDIATE;');
    try {
      masterService.setChain(projectId, master_chain);
      const byRole: Record<string, number[]> = {};
      for (const b of bindings) {
        if (b && b.role && b.agent_id != null) {
          (byRole[b.role] ||= []).push(Number(b.agent_id));
        }
      }
      for (const [r, aids] of Object.entries(byRole)) {
        assignmentService.setRoleBindings(projectId, r, aids);
      }
      for (const tb of team_bindings) {
        if (tb && tb.role && tb.team_id != null) {
          assignmentService.setProjectTeamBinding(projectId, tb.role, Number(tb.team_id));
        }
      }
      if (body.autonomy_default !== undefined) {
        projectService.setAutonomyDefault(projectId, body.autonomy_default);
      }
      raw.exec('COMMIT;');
    } catch (e: any) {
      try { raw.exec('ROLLBACK;'); } catch {}
      return reply.code(400).send({ error: e.message });
    }
    const is_set_up = masterService.isSetUp(projectId);
    const autonomy_default = projectService.getAutonomyDefault(projectId);
    return { ok: true, is_set_up, autonomy_default };
  });

  await app.ready();
  return app;
}

async function buildProjectsListApp(dbs: DatabaseService) {
  const projectService = new ProjectService(dbs);
  const app = Fastify({ logger: false });
  const requireOwnerPre = createRequireOwner();

  app.get('/api/projects', { preHandler: [ownerAuth, requireOwnerPre] }, () => {
    const projects = projectService.listProjects();
    return { projects };
  });

  await app.ready();
  return { app, projectService };
}

describe.sequential('B1-T02 autonomy_default config API (R-E1)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let app: Awaited<ReturnType<typeof buildConfigApiApp>>;
  let pid: number;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    const projectService = new ProjectService(dbs);
    const p = projectService.createProject({ name: 'b1t02-proj', directory: '/tmp/b1t02' });
    pid = p.id;
    app = await buildConfigApiApp(dbs);
  });

  afterEach(async () => {
    await app.close();
    dbs.close();
    cleanup();
  });

  it('fresh project GET config returns safe default pause_after_planning', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/projects/${pid}/config` });
    expect(res.statusCode).toBe(200);
    expect(res.json().autonomy_default).toBe(DEFAULT_AUTONOMY_DEFAULT);
  });

  it('PUT autonomy_default autonomous_after_discovery then GET returns saved value', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/api/projects/${pid}/config`,
      remoteAddress: '127.0.0.1',
      payload: { master_chain: [], bindings: [], team_bindings: [], autonomy_default: 'autonomous_after_discovery' }
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().autonomy_default).toBe('autonomous_after_discovery');

    const get = await app.inject({ method: 'GET', url: `/api/projects/${pid}/config` });
    expect(get.statusCode).toBe(200);
    expect(get.json().autonomy_default).toBe('autonomous_after_discovery');
  });

  it('v51→SCHEMA_VERSION migration adds autonomy_default with safe default on existing rows', () => {
    const testCopy = path.join(os.tmpdir(), `helm-b1t02-mig-${Date.now()}.db`);
    try {
      const old = new Database(testCopy);
      old.exec(`
        CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
        INSERT INTO schema_version (version) VALUES (51);
        CREATE TABLE projects (
          id INTEGER PRIMARY KEY,
          name TEXT UNIQUE NOT NULL,
          directory TEXT NOT NULL,
          description TEXT,
          dev_url TEXT,
          qa_url TEXT,
          tags TEXT,
          tmux_session TEXT,
          projcore_session TEXT,
          primary_driver_agent_id INTEGER,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO projects (id, name, directory) VALUES (3, 'legacy-proj', '/tmp/legacy');
      `);
      old.close();

      const migrated = new DatabaseService(testCopy);
      const ver = (migrated.raw.prepare('SELECT version FROM schema_version').get() as any).version;
      const cols = migrated.raw.prepare('PRAGMA table_info(projects)').all().map((c: any) => c.name);
      const project = new ProjectService(migrated).getProject(3);
      expect(ver).toBe(SCHEMA_VERSION);
      expect(cols).toContain('autonomy_default');
      expect(project?.autonomy_default).toBe(DEFAULT_AUTONOMY_DEFAULT);
      migrated.close();
    } finally {
      try { fs.unlinkSync(testCopy); } catch {}
    }
  });
});

describe.sequential('B1-T03 GET /api/projects surfaces autonomy_default for CC (R-E1/E2/H4)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let app: Awaited<ReturnType<typeof buildProjectsListApp>>['app'];
  let projectService: ProjectService;
  let defaultPid: number;
  let autonomousPid: number;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    const built = await buildProjectsListApp(dbs);
    app = built.app;
    projectService = built.projectService;

    const defaultProj = projectService.createProject({ name: 'b1t03-default', directory: '/tmp/b1t03-default' });
    const autonomousProj = projectService.createProject({ name: 'b1t03-autonomous', directory: '/tmp/b1t03-autonomous' });
    defaultPid = defaultProj.id;
    autonomousPid = autonomousProj.id;
    projectService.setAutonomyDefault(autonomousPid, 'autonomous_after_discovery');
  });

  afterEach(async () => {
    await app.close();
    dbs.close();
    cleanup();
  });

  it('GET /api/projects returns autonomy_default on every row with correct set vs default values', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/projects' });
    expect(res.statusCode).toBe(200);

    const projects = res.json().projects as Array<{ id: number; autonomy_default: string }>;
    expect(projects).toHaveLength(2);

    const byId = Object.fromEntries(projects.map(p => [p.id, p]));
    expect(byId[defaultPid].autonomy_default).toBe(DEFAULT_AUTONOMY_DEFAULT);
    expect(byId[autonomousPid].autonomy_default).toBe('autonomous_after_discovery');

    for (const row of projects) {
      expect(row.autonomy_default).toBeDefined();
      expect(row.autonomy_default).not.toBeNull();
      expect(['autonomous_after_discovery', 'pause_after_planning']).toContain(row.autonomy_default);
    }
  });
});

// B2-T01: targeted outcome test for cycle CREATE (row + folder + autonomy inheritance R-E2)
// Asserts BOTH DB row (inherited or overridden autonomy) AND real folder exists on disk under project.directory/cycle/<slug>_<MMDD>/
describe.sequential('B2-T01 cycle create (row + on-disk folder + autonomy inherit/override)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let projDefault: any;
  let projAuto: any;
  let tempProjDir: string;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);

    // temp project dir (fenced root for cycle folder)
    tempProjDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b2t01-proj-'));
    projDefault = projectService.createProject({ name: 'b2t01-default', directory: tempProjDir });
    projAuto = projectService.createProject({ name: 'b2t01-auto', directory: tempProjDir + '-auto' });
    projectService.setAutonomyDefault(projAuto.id, 'autonomous_after_discovery');
  });

  afterEach(async () => {
    dbs.close();
    cleanup();
    try { fs.rmSync(tempProjDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(tempProjDir + '-auto', { recursive: true, force: true }); } catch {}
  });

  it('POST-equivalent create inherits project autonomy_default when omitted; folder exists at <projdir>/cycle/<slug>_<MMDD>/', async () => {
    // use injected fixed clock for deterministic MMDD
    const fixed = new Date('2026-07-03T10:00:00Z');
    const c = await cycleService.createCycle(projDefault.id, 'First Cycle', undefined, undefined, () => fixed);

    expect(c.name).toBe('First Cycle');
    expect(c.autonomy).toBe(DEFAULT_AUTONOMY_DEFAULT);
    expect(c.folder_name).toBe('first-cycle_0703');
    expect(c.phase).toBe('discovery');
    expect(c.status).toBe('active');
    expect(c.folder_path).toBeTruthy();

    // assert DB row
    const row = dbs.raw.prepare('SELECT * FROM cycles WHERE id = ?').get(c.id) as any;
    expect(row).toBeTruthy();
    expect(row.project_id).toBe(projDefault.id);
    expect(row.autonomy).toBe(DEFAULT_AUTONOMY_DEFAULT);
    expect(row.folder_name).toBe('first-cycle_0703');

    // assert folder exists on disk under project.directory (fence)
    const expectedDir = path.join(projDefault.directory, 'cycle', 'first-cycle_0703');
    expect(c.folder_path).toBe(expectedDir);
    const st = await fsp.stat(expectedDir);
    expect(st.isDirectory()).toBe(true);
  });

  it('create with autonomy override uses override (not project default); folder created', async () => {
    const fixed = new Date('2026-07-03T11:00:00Z');
    const c = await cycleService.createCycle(projAuto.id, 'Override Test', 'pause_after_planning', undefined, () => fixed);

    expect(c.autonomy).toBe('pause_after_planning');
    expect(c.folder_name).toBe('override-test_0703');

    const row = dbs.raw.prepare('SELECT autonomy FROM cycles WHERE id = ?').get(c.id) as any;
    expect(row.autonomy).toBe('pause_after_planning');

    const expectedDir = path.join(projAuto.directory, 'cycle', 'override-test_0703');
    const st = await fsp.stat(expectedDir);
    expect(st.isDirectory()).toBe(true);
  });

  it('dup name+date on same project returns deterministic 409 (no folder dup)', async () => {
    const fixed = new Date('2026-07-03T12:00:00Z');
    await cycleService.createCycle(projDefault.id, 'Dup Test', undefined, undefined, () => fixed);
    await expect(
      cycleService.createCycle(projDefault.id, 'Dup Test', undefined, undefined, () => fixed)
    ).rejects.toThrow(/already exists|CONFLICT/);
  });

  it('API route POST /api/projects/:id/cycles succeeds and returns cycle with folder_path that exists (outcome)', async () => {
    // minimal app with the cycles route (reuses owner mocks)
    function ownerAuth(req: any, _reply: any, done?: () => void) {
      req.user = { role: 'owner' };
      done?.();
    }
    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    const requireLocalLaunchPre = createRequireLocalLaunch();

    app.post('/api/projects/:id/cycles', { preHandler: [ownerAuth, requireOwnerPre, requireLocalLaunchPre] }, async (request: any, reply: any) => {
      const pid = Number(request.params.id);
      if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
      try {
        const body = request.body || {};
        const c = await cycleService.createCycle(pid, body.name, body.autonomy);
        return { cycle: c };
      } catch (e: any) {
        if ((e as any).code === 'CONFLICT') return reply.code(409).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    });
    await app.ready();

    try {
      // use a project with its temp dir
      const p = projectService.createProject({ name: 'b2t01-route-proj', directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b2t01-route-')) });
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${p.id}/cycles`,
        remoteAddress: '127.0.0.1',
        payload: { name: 'Route Cycle' }
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.cycle).toBeTruthy();
      expect(body.cycle.name).toBe('Route Cycle');
      expect(body.cycle.autonomy).toBe(DEFAULT_AUTONOMY_DEFAULT);
      expect(body.cycle.folder_path).toMatch(/\/cycle\/route-cycle_\d{4}$/);

      // assert disk folder from returned path
      const st = await fsp.stat(body.cycle.folder_path);
      expect(st.isDirectory()).toBe(true);
      // cleanup route dir
      try { fs.rmSync(p.directory, { recursive: true, force: true }); } catch {}
    } finally {
      await app.close();
    }
  });
});