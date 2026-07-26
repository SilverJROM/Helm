import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { ProjectService, DEFAULT_AUTONOMY_DEFAULT } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b2t02-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

function insertCycle(
  dbs: DatabaseService,
  projectId: number,
  name: string,
  folderName: string,
  status: 'pending' | 'active' | 'completed',
  phase = 'discovery'
) {
  dbs.prepare(
    `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(projectId, name, folderName, phase, DEFAULT_AUTONOMY_DEFAULT, status);
}

describe.sequential('B2-T02 cycle overview listing (grouped by status)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let projEmpty: { id: number };
  let projMixed: { id: number };

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);

    projEmpty = projectService.createProject({
      name: 'b2t02-empty',
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b2t02-empty-'))
    });
    projMixed = projectService.createProject({
      name: 'b2t02-mixed',
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b2t02-mixed-'))
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('fresh DB reaches SCHEMA_VERSION with awaiting_approval on cycles', () => {
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(58);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);

    const cols = dbs.raw.prepare('PRAGMA table_info(cycles)').all().map((c: any) => c.name);
    expect(cols).toContain('awaiting_approval');

    dbs.raw.prepare(
      `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
       VALUES (?, 'pending probe', 'pending-probe_0703', 'discovery', ?, 'pending')`
    ).run(projMixed.id, DEFAULT_AUTONOMY_DEFAULT);
  });

  it('listCyclesOverview returns cycles in correct buckets with correct counts', () => {
    insertCycle(dbs, projMixed.id, 'Pending Cycle', 'pending-cycle_0701', 'pending');
    insertCycle(dbs, projMixed.id, 'Active Cycle', 'active-cycle_0702', 'active', 'planning');
    insertCycle(dbs, projMixed.id, 'Done Cycle', 'done-cycle_0703', 'completed', 'complete');

    const overview = cycleService.listCyclesOverview();

    expect(overview.counts).toEqual({ pending: 1, active: 1, completed: 1 });
    expect(overview.pending).toHaveLength(1);
    expect(overview.active).toHaveLength(1);
    expect(overview.completed).toHaveLength(1);

    expect(overview.pending[0].name).toBe('Pending Cycle');
    expect(overview.pending[0].status).toBe('pending');
    expect(overview.pending[0].project_name).toBe('b2t02-mixed');

    expect(overview.active[0].name).toBe('Active Cycle');
    expect(overview.active[0].status).toBe('active');
    expect(overview.active[0].phase).toBe('planning');

    expect(overview.completed[0].name).toBe('Done Cycle');
    expect(overview.completed[0].status).toBe('completed');
  });

  it('project with zero cycles yields empty buckets (first-class empty state)', () => {
    const overview = cycleService.listCyclesOverview();

    expect(overview.counts).toEqual({ pending: 0, active: 0, completed: 0 });
    expect(overview.pending).toEqual([]);
    expect(overview.active).toEqual([]);
    expect(overview.completed).toEqual([]);
    expect(projEmpty.id).toBeTruthy();
  });

  it('GET /api/cycles/overview route returns grouped buckets and counts (outcome)', async () => {
    insertCycle(dbs, projMixed.id, 'Route Pending', 'route-pending_0701', 'pending');
    insertCycle(dbs, projMixed.id, 'Route Active', 'route-active_0702', 'active');
    insertCycle(dbs, projMixed.id, 'Route Done', 'route-done_0703', 'completed');

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    app.get('/api/cycles/overview', { preHandler: [ownerAuth, requireOwnerPre] }, async () => {
      return cycleService.listCyclesOverview();
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/cycles/overview',
      remoteAddress: '127.0.0.1'
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.counts).toEqual({ pending: 1, active: 1, completed: 1 });
    expect(body.pending.map((c: any) => c.name)).toContain('Route Pending');
    expect(body.active.map((c: any) => c.name)).toContain('Route Active');
    expect(body.completed.map((c: any) => c.name)).toContain('Route Done');

    for (const bucket of ['pending', 'active', 'completed'] as const) {
      const row = body[bucket][0];
      expect(row).toMatchObject({
        id: expect.any(Number),
        project_id: projMixed.id,
        project_name: 'b2t02-mixed',
        phase: expect.any(String),
        autonomy: DEFAULT_AUTONOMY_DEFAULT,
        folder_name: expect.any(String),
        created_at: expect.any(String)
      });
    }

    await app.close();
  });
});

describe.sequential('B2-T04 complete cycle (move folder to completed/ + status=completed, R-B2/R-G3)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let proj: { id: number; directory: string };

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b2t04-proj-'));
    proj = projectService.createProject({
      name: 'b2t04-complete',
      directory: projDir
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('completeCycle moves folder on disk, sets status=completed, old gone, new exists (stat fs)', async () => {
    const created = await cycleService.createCycle(proj.id, 'Complete Me');
    const folderName = created.folder_name;
    const activePath = path.join(proj.directory, 'cycle', folderName);
    const completedPath = path.join(proj.directory, 'cycle', 'completed', folderName);

    // pre: folder at active
    expect(fs.existsSync(activePath)).toBe(true);

    const completed = await cycleService.completeCycle(created.id);

    expect(completed.status).toBe('completed');
    expect(completed.folder_path).toBe(completedPath);

    // MUST stat the filesystem (per spec)
    expect(fs.existsSync(activePath)).toBe(false);
    expect(fs.existsSync(completedPath)).toBe(true);
    // contents preserved (at least the dir)
    expect(fs.statSync(completedPath).isDirectory()).toBe(true);
  });

  it('completeCycle returns 409 on destination collision (no overwrite)', async () => {
    const created = await cycleService.createCycle(proj.id, 'Collision Test');
    const folderName = created.folder_name;
    const completedDir = path.join(proj.directory, 'cycle', 'completed', folderName);
    fs.mkdirSync(completedDir, { recursive: true }); // pre-create dest

    let conflict: any;
    try {
      await cycleService.completeCycle(created.id);
    } catch (e: any) {
      conflict = e;
    }
    expect(conflict).toBeTruthy();
    expect(conflict.code).toBe('CONFLICT');
    // source should still exist (no partial move)
    const activePath = path.join(proj.directory, 'cycle', folderName);
    expect(fs.existsSync(activePath)).toBe(true);
  });

  it('POST /api/cycles/:id/complete succeeds and stats move (outcome)', async () => {
    const created = await cycleService.createCycle(proj.id, 'Route Complete');
    const folderName = created.folder_name;
    const activePath = path.join(proj.directory, 'cycle', folderName);
    const completedPath = path.join(proj.directory, 'cycle', 'completed', folderName);

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    app.post('/api/cycles/:id/complete', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      try {
        const c = await cycleService.completeCycle(Number(request.params.id));
        return { cycle: c };
      } catch (e: any) {
        if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    });
    await app.ready();

    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/cycles/${created.id}/complete`,
        remoteAddress: '127.0.0.1'
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.cycle.status).toBe('completed');

      // fs stat required
      expect(fs.existsSync(activePath)).toBe(false);
      expect(fs.existsSync(completedPath)).toBe(true);
    } finally {
      await app.close();
    }
  });
});