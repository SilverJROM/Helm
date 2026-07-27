import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService, isAwaitingApproval } from './services/cycle-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b6t03-'));
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
  autonomy: 'pause_after_planning' | 'autonomous_after_discovery',
  phase = 'planning'
) {
  const row = dbs.prepare(
    `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
     VALUES (?, ?, ?, ?, ?, 'active') RETURNING id`
  ).get(projectId, name, folderName, phase, autonomy) as any;
  return Number(row.id);
}

describe.sequential('B6-T03 cycle approval gate (R-E3)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let projectId: number;
  let gateCycleId: number;
  let autoCycleId: number;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);

    const proj = projectService.createProject({
      name: 'b6t03-approval-gate',
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b6t03-proj-'))
    });
    projectId = proj.id;
    gateCycleId = insertCycle(dbs, projectId, 'Gate Cycle', 'gate-cycle_0703', 'pause_after_planning');
    autoCycleId = insertCycle(dbs, projectId, 'Auto Cycle', 'auto-cycle_0703', 'autonomous_after_discovery');
  });

  afterEach(() => {
    dbs.close();
    cleanup();
  });

  it('gate-mode cycle at planning-done → isAwaitingApproval true; approve → phase=implementation', () => {
    const atGate = cycleService.finishPlanning(gateCycleId);
    expect(atGate.phase).toBe('planning');
    expect(atGate.awaiting_approval).toBe(true);
    expect(isAwaitingApproval(atGate)).toBe(true);

    const approved = cycleService.approveCycle(gateCycleId);
    expect(approved.phase).toBe('implementation');
    expect(approved.awaiting_approval).toBe(false);
    expect(isAwaitingApproval(approved)).toBe(false);
  });

  it('autonomous cycle → isAwaitingApproval false; approve → 409', () => {
    const finished = cycleService.finishPlanning(autoCycleId);
    expect(finished.phase).toBe('implementation');
    expect(finished.awaiting_approval).toBe(false);
    expect(isAwaitingApproval(finished)).toBe(false);

    let conflict: any;
    try {
      cycleService.approveCycle(autoCycleId);
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeTruthy();
    expect(conflict.code).toBe('CONFLICT');
  });

  it('already-implementing cycle → approve → 409', () => {
    const implProj = projectService.createProject({
      name: 'b6t03-impl-only',
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b6t03-impl-proj-'))
    });
    const implCycleId = insertCycle(
      dbs, implProj.id, 'Impl Cycle', 'impl-cycle_0703', 'pause_after_planning', 'implementation'
    );

    let conflict: any;
    try {
      cycleService.approveCycle(implCycleId);
    } catch (e) {
      conflict = e;
    }
    expect(conflict).toBeTruthy();
    expect(conflict.code).toBe('CONFLICT');
  });

  it('POST /api/cycles/:id/approve returns 409 for non-awaiting cycles and 200 for gated cycle', async () => {
    cycleService.finishPlanning(gateCycleId);

    const implProj = projectService.createProject({
      name: 'b6t03-impl-route',
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b6t03-impl-route-'))
    });
    const implCycleId = insertCycle(
      dbs, implProj.id, 'Impl Cycle', 'impl-route_0703', 'pause_after_planning', 'implementation'
    );

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();

    app.post('/api/cycles/:id/approve', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      try {
        const c = cycleService.approveCycle(Number(request.params.id));
        return { cycle: c };
      } catch (e: any) {
        if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    });
    await app.ready();

    try {
      const autoRes = await app.inject({
        method: 'POST',
        url: `/api/cycles/${autoCycleId}/approve`,
        remoteAddress: '127.0.0.1'
      });
      expect(autoRes.statusCode).toBe(409);

      const implRes = await app.inject({
        method: 'POST',
        url: `/api/cycles/${implCycleId}/approve`,
        remoteAddress: '127.0.0.1'
      });
      expect(implRes.statusCode).toBe(409);

      const okRes = await app.inject({
        method: 'POST',
        url: `/api/cycles/${gateCycleId}/approve`,
        remoteAddress: '127.0.0.1'
      });
      expect(okRes.statusCode).toBe(200);
      expect(okRes.json().cycle.phase).toBe('implementation');
    } finally {
      await app.close();
    }
  });

  it('POST /api/cycles/:id/finish-planning parks gate-mode at awaiting_approval (A6b setup path)', async () => {
    // Mirrors production index.ts finish-planning route — same CycleService.finishPlanning as
    // orchestrator planning-done. No plancore seat required.
    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    app.post('/api/cycles/:id/finish-planning', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      try {
        const c = cycleService.finishPlanning(Number(request.params.id));
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
        url: `/api/cycles/${gateCycleId}/finish-planning`,
        remoteAddress: '127.0.0.1',
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.cycle.phase).toBe('planning');
      expect(body.cycle.awaiting_approval).toBe(true);
      expect(isAwaitingApproval(body.cycle)).toBe(true);

      // Not in planning → CONFLICT
      const badId = insertCycle(dbs, projectId, 'Bad', 'bad_0703', 'pause_after_planning', 'discovery');
      const badRes = await app.inject({
        method: 'POST',
        url: `/api/cycles/${badId}/finish-planning`,
        remoteAddress: '127.0.0.1',
      });
      expect(badRes.statusCode).toBe(409);
    } finally {
      await app.close();
    }
  });
});