/**
 * cycle-branch-lifecycle B22 — R1 backend: listCyclesOverview archived bucket +
 * POST /api/cycles/:id/archive (409 unless completed) and POST /api/cycles/:id/unarchive
 * (back to completed). Status-only: no second folder move, nothing deleted.
 */
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-cbl-b22-'));
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
  status: 'pending' | 'active' | 'completed' | 'archived',
  phase = 'discovery'
) {
  return dbs.prepare(
    `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(projectId, name, folderName, phase, DEFAULT_AUTONOMY_DEFAULT, status) as { id: number };
}

/** Seed a completed cycle with its docs folder already under cycle/completed/ (as completeCycle leaves it). */
function seedCompletedOnDisk(
  projDir: string,
  folderName: string,
  markerFile = 'north-star.md',
  markerBody = '# keep me\n'
): string {
  const completedPath = path.join(projDir, 'cycle', 'completed', folderName);
  fs.mkdirSync(completedPath, { recursive: true });
  fs.writeFileSync(path.join(completedPath, markerFile), markerBody, 'utf8');
  return completedPath;
}

describe.sequential('B22 cycle archive/unarchive (R1.1–R1.3, status-only)', () => {
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

    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-cbl-b22-proj-'));
    proj = projectService.createProject({
      name: 'cbl-b22-proj',
      directory: projDir
    });
  });

  afterEach(() => {
    try { dbs.close(); } catch {}
    cleanup();
    try { fs.rmSync(proj.directory, { recursive: true, force: true }); } catch {}
  });

  it('archive from completed succeeds: leaves completed bucket, appears in archived, counts update', () => {
    const folderName = 'done-cycle_0804';
    const completedPath = seedCompletedOnDisk(proj.directory, folderName);
    const { id } = insertCycle(dbs, proj.id, 'Done Cycle', folderName, 'completed', 'complete');

    // seed one other completed + one active so counts are multi-valued
    insertCycle(dbs, proj.id, 'Other Done', 'other-done_0804', 'completed', 'complete');
    insertCycle(dbs, proj.id, 'Still Active', 'still-active_0804', 'active', 'planning');

    const before = cycleService.listCyclesOverview();
    expect(before.counts).toEqual({ pending: 0, active: 1, completed: 2, archived: 0 });
    expect(before.completed.map((c) => c.id)).toContain(id);
    expect(before.archived.map((c) => c.id)).not.toContain(id);

    const archived = cycleService.archiveCycle(id);
    expect(archived.status).toBe('archived');
    expect(archived.folder_path).toBe(completedPath);

    const after = cycleService.listCyclesOverview();
    expect(after.counts).toEqual({ pending: 0, active: 1, completed: 1, archived: 1 });
    expect(after.completed.map((c) => c.id)).not.toContain(id);
    expect(after.archived).toHaveLength(1);
    expect(after.archived[0].id).toBe(id);
    expect(after.archived[0].status).toBe('archived');
    expect(after.archived[0].name).toBe('Done Cycle');
  });

  it('archive from active and from pending both 409; folder and status unchanged', () => {
    const activeFolder = 'active-cycle_0804';
    const pendingFolder = 'pending-cycle_0804';
    fs.mkdirSync(path.join(proj.directory, 'cycle', activeFolder), { recursive: true });
    fs.mkdirSync(path.join(proj.directory, 'cycle', pendingFolder), { recursive: true });
    const active = insertCycle(dbs, proj.id, 'Active', activeFolder, 'active', 'planning');
    const pending = insertCycle(dbs, proj.id, 'Pending', pendingFolder, 'pending');

    for (const row of [active, pending]) {
      let err: any;
      try {
        cycleService.archiveCycle(row.id);
      } catch (e: any) {
        err = e;
      }
      expect(err).toBeTruthy();
      expect(err.code).toBe('CONFLICT');
    }

    const overview = cycleService.listCyclesOverview();
    expect(overview.counts.archived).toBe(0);
    expect(overview.active.map((c) => c.id)).toContain(active.id);
    expect(overview.pending.map((c) => c.id)).toContain(pending.id);
    expect(fs.existsSync(path.join(proj.directory, 'cycle', activeFolder))).toBe(true);
    expect(fs.existsSync(path.join(proj.directory, 'cycle', pendingFolder))).toBe(true);
  });

  it('unarchive restores to completed; on-disk path and DB history rows unchanged throughout', () => {
    const folderName = 'history-cycle_0804';
    const marker = 'do-not-delete.md';
    const markerBody = 'history marker body\n';
    const completedPath = seedCompletedOnDisk(proj.directory, folderName, marker, markerBody);
    const { id } = insertCycle(dbs, proj.id, 'History Cycle', folderName, 'completed', 'complete');

    // DB history: a run (+ optional task) linked to this cycle — must survive archive/unarchive.
    const runRow = dbs.prepare(
      `INSERT INTO runs (project_id, cycle_id, batch_id, status, phase)
       VALUES (?, ?, 'b22-hist', 'complete', 'complete') RETURNING id`
    ).get(proj.id, id) as { id: number };
    const runId = Number(runRow.id);
    dbs.prepare(
      `INSERT INTO run_tasks (run_id, task_key, label, status)
       VALUES (?, 'T1', 'hist task', 'complete')`
    ).run(runId);

    const historyBefore = {
      run: dbs.prepare('SELECT id, cycle_id, batch_id, status FROM runs WHERE id = ?').get(runId),
      taskCount: (dbs.prepare('SELECT COUNT(*) AS c FROM run_tasks WHERE run_id = ?').get(runId) as any).c,
      cycleRow: dbs.prepare(
        'SELECT id, folder_name, project_id FROM cycles WHERE id = ?'
      ).get(id)
    };

    // --- archive ---
    const archived = cycleService.archiveCycle(id);
    expect(archived.status).toBe('archived');
    expect(fs.existsSync(completedPath)).toBe(true);
    expect(fs.readFileSync(path.join(completedPath, marker), 'utf8')).toBe(markerBody);
    // no second folder under cycle/archived/
    expect(fs.existsSync(path.join(proj.directory, 'cycle', 'archived', folderName))).toBe(false);
    // doc dir still resolves to completed path
    expect(cycleService.getCycleDocDir(id)).toBe(completedPath);

    const midOverview = cycleService.listCyclesOverview();
    expect(midOverview.counts.completed).toBe(0);
    expect(midOverview.counts.archived).toBe(1);

    // history unchanged after archive
    expect(dbs.prepare('SELECT id, cycle_id, batch_id, status FROM runs WHERE id = ?').get(runId))
      .toEqual(historyBefore.run);
    expect((dbs.prepare('SELECT COUNT(*) AS c FROM run_tasks WHERE run_id = ?').get(runId) as any).c)
      .toBe(historyBefore.taskCount);
    expect(dbs.prepare('SELECT id, folder_name, project_id FROM cycles WHERE id = ?').get(id))
      .toEqual(historyBefore.cycleRow);

    // --- unarchive ---
    const restored = cycleService.unarchiveCycle(id);
    expect(restored.status).toBe('completed');
    expect(restored.folder_path).toBe(completedPath);
    expect(fs.existsSync(completedPath)).toBe(true);
    expect(fs.readFileSync(path.join(completedPath, marker), 'utf8')).toBe(markerBody);
    expect(cycleService.getCycleDocDir(id)).toBe(completedPath);

    const afterOverview = cycleService.listCyclesOverview();
    expect(afterOverview.counts).toEqual({ pending: 0, active: 0, completed: 1, archived: 0 });
    expect(afterOverview.completed.map((c) => c.id)).toContain(id);
    expect(afterOverview.archived).toHaveLength(0);

    // history still unchanged after unarchive
    expect(dbs.prepare('SELECT id, cycle_id, batch_id, status FROM runs WHERE id = ?').get(runId))
      .toEqual(historyBefore.run);
    expect((dbs.prepare('SELECT COUNT(*) AS c FROM run_tasks WHERE run_id = ?').get(runId) as any).c)
      .toBe(historyBefore.taskCount);
    expect(dbs.prepare('SELECT id, folder_name, project_id FROM cycles WHERE id = ?').get(id))
      .toEqual(historyBefore.cycleRow);
  });

  it('POST /api/cycles/:id/archive and /unarchive routes: 200 completed path, 409 active/pending', async () => {
    const folderName = 'route-done_0804';
    seedCompletedOnDisk(proj.directory, folderName);
    const completed = insertCycle(dbs, proj.id, 'Route Done', folderName, 'completed', 'complete');
    const active = insertCycle(dbs, proj.id, 'Route Active', 'route-active_0804', 'active');
    const pending = insertCycle(dbs, proj.id, 'Route Pending', 'route-pending_0804', 'pending');

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    app.post('/api/cycles/:id/archive', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      try {
        const c = cycleService.archiveCycle(Number(request.params.id));
        return { cycle: c };
      } catch (e: any) {
        if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    });
    app.post('/api/cycles/:id/unarchive', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      try {
        const c = cycleService.unarchiveCycle(Number(request.params.id));
        return { cycle: c };
      } catch (e: any) {
        if (e.code === 'NOT_FOUND') return reply.code(404).send({ error: e.message });
        if (e.code === 'CONFLICT') return reply.code(409).send({ error: e.message });
        return reply.code(400).send({ error: e.message });
      }
    });
    app.get('/api/cycles/overview', { preHandler: [ownerAuth, requireOwnerPre] }, async () => {
      return cycleService.listCyclesOverview();
    });
    await app.ready();

    try {
      const activeRes = await app.inject({
        method: 'POST',
        url: `/api/cycles/${active.id}/archive`,
        remoteAddress: '127.0.0.1'
      });
      expect(activeRes.statusCode).toBe(409);

      const pendingRes = await app.inject({
        method: 'POST',
        url: `/api/cycles/${pending.id}/archive`,
        remoteAddress: '127.0.0.1'
      });
      expect(pendingRes.statusCode).toBe(409);

      const archiveRes = await app.inject({
        method: 'POST',
        url: `/api/cycles/${completed.id}/archive`,
        remoteAddress: '127.0.0.1'
      });
      expect(archiveRes.statusCode).toBe(200);
      expect(archiveRes.json().cycle.status).toBe('archived');

      const overviewArchived = await app.inject({
        method: 'GET',
        url: '/api/cycles/overview',
        remoteAddress: '127.0.0.1'
      });
      expect(overviewArchived.statusCode).toBe(200);
      const body = overviewArchived.json();
      expect(body.counts.archived).toBe(1);
      expect(body.counts.completed).toBe(0);
      expect(body.archived.map((c: any) => c.id)).toContain(completed.id);

      const unarchiveRes = await app.inject({
        method: 'POST',
        url: `/api/cycles/${completed.id}/unarchive`,
        remoteAddress: '127.0.0.1'
      });
      expect(unarchiveRes.statusCode).toBe(200);
      expect(unarchiveRes.json().cycle.status).toBe('completed');

      const overviewRestored = await app.inject({
        method: 'GET',
        url: '/api/cycles/overview',
        remoteAddress: '127.0.0.1'
      });
      const body2 = overviewRestored.json();
      expect(body2.counts.archived).toBe(0);
      expect(body2.counts.completed).toBe(1);
    } finally {
      await app.close();
    }
  });
});
