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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b2t03-'));
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
  status: 'pending' | 'active' | 'completed' = 'active',
  phase = 'discovery'
) {
  const row = dbs.prepare(
    `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(projectId, name, folderName, phase, DEFAULT_AUTONOMY_DEFAULT, status) as any;
  return Number(row.id);
}

describe.sequential('B2-T03 one implementation cycle per project (R-B3)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let projectId: number;
  let cycleAId: number;
  let cycleBId: number;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);

    const proj = projectService.createProject({
      name: 'b2t03-guard',
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b2t03-proj-'))
    });
    projectId = proj.id;
    cycleAId = insertCycle(dbs, projectId, 'Cycle A', 'cycle-a_0703');
    cycleBId = insertCycle(dbs, projectId, 'Cycle B', 'cycle-b_0703');
  });

  afterEach(() => {
    dbs.close();
    cleanup();
  });

  it('A→implementation succeeds; B→implementation fails; B→planning succeeds; after A completes B→implementation succeeds', () => {
    const aImpl = cycleService.setCyclePhase(cycleAId, 'implementation');
    expect(aImpl.phase).toBe('implementation');

    let conflict: any;
    try {
      cycleService.setCyclePhase(cycleBId, 'implementation');
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeTruthy();
    expect(conflict.code).toBe('CONFLICT');

    const bPlanning = cycleService.setCyclePhase(cycleBId, 'planning');
    expect(bPlanning.phase).toBe('planning');

    dbs.prepare("UPDATE cycles SET status = 'completed' WHERE id = ?").run(cycleAId);

    const bImpl = cycleService.setCyclePhase(cycleBId, 'implementation');
    expect(bImpl.phase).toBe('implementation');
  });

  it('PATCH /api/cycles/:id/phase returns 409 when second implementation blocked (outcome)', async () => {
    cycleService.setCyclePhase(cycleAId, 'implementation');

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();

    app.patch('/api/cycles/:id/phase', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      try {
        const body = request.body || {};
        const c = cycleService.setCyclePhase(Number(request.params.id), body.phase);
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
        url: `/api/cycles/${cycleBId}/phase`,
        remoteAddress: '127.0.0.1',
        payload: { phase: 'implementation' }
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toMatch(/implementation/i);
    } finally {
      await app.close();
    }
  });
});