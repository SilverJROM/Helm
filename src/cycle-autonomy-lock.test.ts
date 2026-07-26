import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService, DEFAULT_AUTONOMY_DEFAULT } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b6t02-'));
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
  phase = 'discovery'
) {
  const row = dbs.prepare(
    `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
     VALUES (?, ?, ?, ?, ?, 'active') RETURNING id`
  ).get(projectId, name, folderName, phase, DEFAULT_AUTONOMY_DEFAULT) as any;
  return Number(row.id);
}

describe.sequential('B6-T02 cycle autonomy phase-lock (R-E2/E3)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let projectId: number;
  let planningCycleId: number;
  let implCycleId: number;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);

    const proj = projectService.createProject({
      name: 'b6t02-autonomy-lock',
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b6t02-proj-'))
    });
    projectId = proj.id;
    planningCycleId = insertCycle(dbs, projectId, 'Planning Cycle', 'planning-cycle_0703', 'planning');
    implCycleId = insertCycle(dbs, projectId, 'Impl Cycle', 'impl-cycle_0703', 'implementation');
  });

  afterEach(() => {
    dbs.close();
    cleanup();
  });

  it('pre-implementation cycle accepts an autonomy change', () => {
    const updated = cycleService.setCycleAutonomy(planningCycleId, 'autonomous_after_discovery');
    expect(updated.autonomy).toBe('autonomous_after_discovery');
  });

  it('implementation-phase cycle rejects the change and autonomy stays unchanged', () => {
    let conflict: any;
    try {
      cycleService.setCycleAutonomy(implCycleId, 'autonomous_after_discovery');
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeTruthy();
    expect(conflict.code).toBe('CONFLICT');

    const row = dbs.prepare('SELECT autonomy FROM cycles WHERE id = ?').get(implCycleId) as any;
    expect(row.autonomy).toBe(DEFAULT_AUTONOMY_DEFAULT);
  });

  it('PATCH /api/cycles/:id/autonomy returns 409 on a locked (implementation-phase) cycle', async () => {
    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();

    app.patch('/api/cycles/:id/autonomy', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      try {
        const body = request.body || {};
        const c = cycleService.setCycleAutonomy(Number(request.params.id), body.autonomy);
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
        method: 'PATCH',
        url: `/api/cycles/${implCycleId}/autonomy`,
        remoteAddress: '127.0.0.1',
        payload: { autonomy: 'autonomous_after_discovery' }
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toMatch(/locked/i);
    } finally {
      await app.close();
    }
  });
});
