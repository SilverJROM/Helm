// A3 SEAM-1 (R4.17): GET /api/cycles/:id/seats + path-safe capture by runtime id.
// 1) Cycle with planning seats returns both; reaped seat still returned (historical).
// 2) Runtime id belonging to another cycle is rejected; client session string never accepted.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-a3-seats-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

describe.sequential('A3 SEAM-1 cycle seats (R4.17)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let artifacts: RunArtifactService;
  let projectId: number;
  let cycleA: number;
  let cycleB: number;
  let runA: number;
  let runB: number;
  let seatLiveId: number;
  let seatReapedId: number;
  let seatOtherCycleId: number;
  let sessionExists: ReturnType<typeof vi.fn>;
  let capturePane: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);
    artifacts = new RunArtifactService(dbs);

    const proj = projectService.createProject({
      name: 'a3-seats',
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-a3-seats-proj-'))
    });
    projectId = proj.id;

    const cA = await cycleService.createCycle(projectId, 'Cycle A seats');
    cycleA = cA.id;
    const cB = await cycleService.createCycle(projectId, 'Cycle B foreign');
    cycleB = cB.id;

    runA = artifacts.createRun(projectId, 'batch-A3-A', null, cycleA);
    runB = artifacts.createRun(projectId, 'batch-A3-B', null, cycleB);

    const ins = dbs.raw.prepare(
      `INSERT INTO worker_runtimes
         (project_id, role, provider, model, session, correlation_id, state, run_id, started_at, ended_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now'),?)`
    );
    seatLiveId = Number(
      ins.run(projectId, 'plancore', 'grok', 'grok-4.5', 'helm-a3-plancore', 'batch-A3-A', 'running', runA, null)
        .lastInsertRowid
    );
    seatReapedId = Number(
      ins.run(
        projectId, 'deliberation', 'claude', 'claude-opus', 'helm-a3-partner', 'batch-A3-A-partner',
        'reaped', runA, "datetime('now')"
      ).lastInsertRowid
    );
    // Fix ended_at for reaped (last arg was literal string in VALUES? — use separate update)
    dbs.raw.prepare(`UPDATE worker_runtimes SET ended_at=datetime('now') WHERE id=?`).run(seatReapedId);

    seatOtherCycleId = Number(
      ins.run(projectId, 'plancore', 'grok', 'grok-4.5', 'helm-a3-other', 'batch-A3-B', 'running', runB, null)
        .lastInsertRowid
    );

    sessionExists = vi.fn(async (name: string) => name === 'helm-a3-plancore');
    capturePane = vi.fn(async (target: string) => `captured:${target}`);
  });

  afterEach(() => {
    dbs.close();
    cleanup();
  });

  function mountSeatsRoutes(app: any, tmux: { sessionExists: any; capturePane: any }) {
    const requireOwnerPre = createRequireOwner();
    const db = dbs.raw;

    app.get('/api/cycles/:id/seats', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid cycle id' });
      const cycle: any = db.prepare('SELECT id FROM cycles WHERE id = ?').get(id);
      if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
      const rows: any[] = db.prepare(
        `SELECT wr.id, wr.role, wr.provider, wr.model, wr.session, wr.state,
                wr.run_id AS runId, wr.correlation_id AS batchId,
                wr.started_at AS startedAt, wr.ended_at AS endedAt
         FROM worker_runtimes wr
         JOIN runs ON runs.id = wr.run_id
         WHERE runs.cycle_id = ?
         ORDER BY wr.id ASC`
      ).all(id);
      const seats = [];
      for (const r of rows) {
        const stateLive = r.state === 'launching' || r.state === 'running';
        let tmuxAlive = false;
        if (stateLive && r.session) {
          try {
            tmuxAlive = await tmux.sessionExists(r.session);
          } catch {
            tmuxAlive = false;
          }
        }
        seats.push({
          id: r.id,
          role: r.role,
          provider: r.provider,
          model: r.model,
          session: r.session || null,
          state: r.state,
          runId: r.runId,
          cycleId: id,
          batchId: r.batchId || null,
          startedAt: r.startedAt || null,
          endedAt: r.endedAt || null,
          live: !!(stateLive && tmuxAlive)
        });
      }
      return { seats };
    });

    app.get('/api/cycles/:id/seats/:runtimeId', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      const id = Number(request.params.id);
      const runtimeId = Number(request.params.runtimeId);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid cycle id' });
      if (!Number.isInteger(runtimeId) || runtimeId <= 0) return reply.code(400).send({ error: 'invalid runtime id' });
      const cycle: any = db.prepare('SELECT id FROM cycles WHERE id = ?').get(id);
      if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
      // Path safety: never use client-supplied session (query/body ignored).
      void request.query?.session;
      void request.query?.sessionName;
      void request.body?.session;
      const row: any = db.prepare(
        `SELECT wr.id, wr.session
         FROM worker_runtimes wr
         JOIN runs ON runs.id = wr.run_id
         WHERE wr.id = ? AND runs.cycle_id = ?`
      ).get(runtimeId, id);
      if (!row) return reply.code(404).send({ error: 'unknown seat for cycle' });
      if (!row.session) return { session: null, content: '(no session recorded for this seat)' };
      const target = `${row.session}:0.0`;
      try {
        const content = await tmux.capturePane(target, 200);
        return { session: row.session, content: content || '' };
      } catch {
        return { session: row.session, content: '' };
      }
    });
  }

  it('returns both seats for a cycle including a reaped historical seat; live flag correct', async () => {
    const app = Fastify({ logger: false });
    mountSeatsRoutes(app, { sessionExists, capturePane });
    await app.ready();
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/cycles/${cycleA}/seats`,
        remoteAddress: '127.0.0.1'
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.seats).toHaveLength(2);

      const live = body.seats.find((s: any) => s.id === seatLiveId);
      const reaped = body.seats.find((s: any) => s.id === seatReapedId);
      expect(live).toBeTruthy();
      expect(reaped).toBeTruthy();

      expect(live.role).toBe('plancore');
      expect(live.runId).toBe(runA);
      expect(live.cycleId).toBe(cycleA);
      expect(live.batchId).toBe('batch-A3-A');
      expect(live.state).toBe('running');
      expect(live.live).toBe(true);
      expect(sessionExists).toHaveBeenCalledWith('helm-a3-plancore');

      expect(reaped.role).toBe('deliberation');
      expect(reaped.state).toBe('reaped');
      expect(reaped.live).toBe(false);
      // Historical resolution: reaped seat still returned with persisted id as pane key
      expect(reaped.id).toBe(seatReapedId);
      expect(reaped.session).toBe('helm-a3-partner');

      // Foreign-cycle seat must not appear
      expect(body.seats.some((s: any) => s.id === seatOtherCycleId)).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('path-safety: foreign-cycle runtime rejected; client session string never accepted as target', async () => {
    const app = Fastify({ logger: false });
    mountSeatsRoutes(app, { sessionExists, capturePane });
    await app.ready();
    try {
      // Runtime belonging to cycle B must not capture under cycle A
      const foreign = await app.inject({
        method: 'GET',
        url: `/api/cycles/${cycleA}/seats/${seatOtherCycleId}`,
        remoteAddress: '127.0.0.1'
      });
      expect(foreign.statusCode).toBe(404);
      expect(capturePane).not.toHaveBeenCalled();

      // Client-supplied session query must be ignored — only DB session is used
      const evilSession = 'evil-attacker-session';
      const own = await app.inject({
        method: 'GET',
        url: `/api/cycles/${cycleA}/seats/${seatLiveId}?session=${evilSession}&sessionName=${evilSession}`,
        remoteAddress: '127.0.0.1'
      });
      expect(own.statusCode).toBe(200);
      const body = own.json();
      expect(body.session).toBe('helm-a3-plancore');
      expect(body.session).not.toBe(evilSession);
      expect(capturePane).toHaveBeenCalledTimes(1);
      const targetArg = capturePane.mock.calls[0][0] as string;
      expect(targetArg).toContain('helm-a3-plancore');
      expect(targetArg).not.toContain(evilSession);

      // Non-numeric runtime id rejected
      const bad = await app.inject({
        method: 'GET',
        url: `/api/cycles/${cycleA}/seats/helm-a3-plancore`,
        remoteAddress: '127.0.0.1'
      });
      expect(bad.statusCode).toBe(400);

      // Unknown cycle
      const unk = await app.inject({
        method: 'GET',
        url: `/api/cycles/999999/seats`,
        remoteAddress: '127.0.0.1'
      });
      expect(unk.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});
