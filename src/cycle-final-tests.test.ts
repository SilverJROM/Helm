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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b11t01-'));
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
  phase = 'discovery',
  finalTestsEnabled = 1
) {
  const row = dbs.prepare(
    `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status, final_tests_enabled)
     VALUES (?, ?, ?, ?, ?, 'active', ?) RETURNING id`
  ).get(projectId, name, folderName, phase, DEFAULT_AUTONOMY_DEFAULT, finalTestsEnabled) as any;
  return Number(row.id);
}

describe.sequential('B11-T01 cycle final_tests policy (R-G1)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let projectId: number;
  let planningCycleId: number;
  let implCycleId: number;
  let finalTestsCycleId: number;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);

    const proj = projectService.createProject({
      name: 'b11t01-final-tests',
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b11t01-proj-'))
    });
    projectId = proj.id;
    expect(proj.final_tests_default).toBe(true);

    planningCycleId = insertCycle(dbs, projectId, 'Planning Cycle', 'planning-cycle_0704', 'planning');
    implCycleId = insertCycle(dbs, projectId, 'Impl Cycle', 'impl-cycle_0704', 'implementation');
    finalTestsCycleId = insertCycle(dbs, projectId, 'Final Tests Cycle', 'final-tests-cycle_0704', 'final_tests');
  });

  afterEach(() => {
    dbs.close();
    cleanup();
  });

  it('createCycle inherits project final_tests_default (on)', async () => {
    const fixed = new Date('2026-07-04T10:00:00Z');
    const c = await cycleService.createCycle(projectId, 'Inherited On', undefined, undefined, () => fixed);

    expect(c.final_tests_enabled).toBe(true);

    const row = dbs.prepare('SELECT final_tests_enabled FROM cycles WHERE id = ?').get(c.id) as any;
    expect(Number(row.final_tests_enabled)).toBe(1);
  });

  it('Discovery-phase cycle accepts final_tests override off', () => {
    const updated = cycleService.setCycleFinalTests(planningCycleId, false);
    expect(updated.final_tests_enabled).toBe(false);

    const row = dbs.prepare('SELECT final_tests_enabled FROM cycles WHERE id = ?').get(planningCycleId) as any;
    expect(Number(row.final_tests_enabled)).toBe(0);
  });

  it('implementation-phase cycle rejects final_tests change (409 CONFLICT)', () => {
    let conflict: any;
    try {
      cycleService.setCycleFinalTests(implCycleId, false);
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeTruthy();
    expect(conflict.code).toBe('CONFLICT');

    const row = dbs.prepare('SELECT final_tests_enabled FROM cycles WHERE id = ?').get(implCycleId) as any;
    expect(Number(row.final_tests_enabled)).toBe(1);
  });

  it('final_tests-phase cycle rejects final_tests change (409 CONFLICT)', () => {
    let conflict: any;
    try {
      cycleService.setCycleFinalTests(finalTestsCycleId, false);
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeTruthy();
    expect(conflict.code).toBe('CONFLICT');
  });

  it('PATCH /api/cycles/:id/final-tests returns 409 on a locked (implementation-phase) cycle', async () => {
    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();

    app.patch('/api/cycles/:id/final-tests', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      try {
        const body = request.body || {};
        const c = cycleService.setCycleFinalTests(Number(request.params.id), body.enabled);
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
        url: `/api/cycles/${implCycleId}/final-tests`,
        remoteAddress: '127.0.0.1',
        payload: { enabled: false }
      });
      expect(res.statusCode).toBe(409);
      const body = res.json();
      expect(body.error).toMatch(/locked/i);
    } finally {
      await app.close();
    }
  });
});