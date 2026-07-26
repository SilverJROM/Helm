import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';

// POST /api/cycles/:id/start-planning — the counterpart to start-implementation.
//
// Why it exists: start-implementation 400s without a valid plan.md, and planning is what PRODUCES
// plan.md. The only other wired starter was POST /api/projects/:id/runs, which no UI control ever
// called and which does not link the run to a cycle — so a cycle sitting in `discovery` had no way
// to reach planning from the UI at all. This asserts the two properties that differ from
// start-implementation (no plan gate, phase flips to `planning`) plus the guards it must keep.

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-startplan-'));
  return { dbPath: path.join(dir, 'test.db'), cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
function ownerAuth(req: any, _reply: any, done?: () => void) { req.user = { role: 'owner' }; done?.(); }

describe.sequential('POST /api/cycles/:id/start-planning', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let artifacts: RunArtifactService;
  let projectId: number;
  let cycleId: number;
  let calls: Array<{ projectId: number; cycleId: number | null | undefined; prompt: string; seedPlan: any; cyclePlan: any }>;

  // Mirrors index.ts POST /api/cycles/:id/start-planning over an injected orchestrator.
  function mountApp(orchestrator: { startRunDetached: (i: any) => { runId: number; batchId: string } }) {
    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    app.post('/api/cycles/:id/start-planning', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      const cid = Number(request.params.id);
      const cycle: any = dbs.prepare('SELECT id, project_id, phase FROM cycles WHERE id = ?').get(cid);
      if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
      const pid = Number(cycle.project_id);
      if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
      const body = request.body || {};
      try {
        const rs = artifacts.getCycleRunState(cid);
        if (rs.hasRun && rs.runActive) {
          return reply.code(409).send({ error: 'a run is already active for this cycle' });
        }
      } catch { /* fall through */ }
      const prompt = (body.prompt || `plan cycle ${cid} from the project docs`).trim();
      if (!prompt) return reply.code(400).send({ error: 'prompt required' });
      const { runId, batchId } = orchestrator.startRunDetached({ projectId: pid, cycleId: cid, prompt, roleBindings: body.roleBindings, batchId: body.batchId });
      try { cycleService.setCyclePhase(cid, 'planning'); } catch { /* cosmetic */ }
      return { runId, batchId, cycleId: cid, status: 'started' };
    });
    return app;
  }

  const recordingOrchestrator = {
    startRunDetached(input: any) {
      calls.push({
        projectId: input.projectId,
        cycleId: input.cycleId,
        prompt: input.prompt,
        seedPlan: input.seedPlan,
        cyclePlan: input.cyclePlan
      });
      const batchId = input.batchId || 'startplan-batch';
      const runId = artifacts.createRun(input.projectId, batchId, null, input.cycleId ?? null);
      return { runId, batchId };
    }
  };

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);
    artifacts = new RunArtifactService(dbs);
    calls = [];
    const proj = projectService.createProject({ name: 'startplan', directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-startplan-proj-')) });
    projectId = proj.id;
    const c = await cycleService.createCycle(projectId, 'Greenfield');
    cycleId = c.id;
  });
  afterEach(() => { dbs.close(); cleanup(); });

  it('starts a cycle-LINKED planning run with NO plan.md present (the gate start-implementation cannot pass)', async () => {
    const app = mountApp(recordingOrchestrator);
    await app.ready();
    try {
      // Precondition: a fresh cycle has no plan.md — this is exactly where start-implementation 400s.
      const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-planning`, remoteAddress: '127.0.0.1', payload: {} });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('started');
      expect(body.cycleId).toBe(cycleId);
      expect(typeof body.runId).toBe('number');

      // Project derived server-side; cycle linkage threaded through.
      expect(calls).toHaveLength(1);
      expect(calls[0].projectId).toBe(projectId);
      expect(calls[0].cycleId).toBe(cycleId);

      // Neither replay nor implementation-only: this must be the full interview + planning path.
      expect(calls[0].seedPlan).toBeUndefined();
      expect(calls[0].cyclePlan).toBeUndefined();

      // Linked + visible on the cycle board.
      const linked: any = dbs.prepare('SELECT cycle_id FROM runs WHERE id = ?').get(body.runId);
      expect(Number(linked.cycle_id)).toBe(cycleId);
      expect(artifacts.getCycleRunState(cycleId).hasRun).toBe(true);
    } finally { await app.close(); }
  });

  it('flips the cycle phase to planning', async () => {
    const app = mountApp(recordingOrchestrator);
    await app.ready();
    try {
      expect((dbs.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycleId) as any).phase).toBe('discovery');
      const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-planning`, remoteAddress: '127.0.0.1', payload: {} });
      expect(res.statusCode).toBe(200);
      expect((dbs.prepare('SELECT phase FROM cycles WHERE id = ?').get(cycleId) as any).phase).toBe('planning');
    } finally { await app.close(); }
  });

  it('409s when a run is already active for the cycle — a double click never starts a second run', async () => {
    const app = mountApp(recordingOrchestrator);
    await app.ready();
    try {
      const first = await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-planning`, remoteAddress: '127.0.0.1', payload: {} });
      expect(first.statusCode).toBe(200);

      const second = await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-planning`, remoteAddress: '127.0.0.1', payload: {} });
      expect(second.statusCode).toBe(409);
      expect(calls).toHaveLength(1); // no second run
    } finally { await app.close(); }
  });

  it('404s on an unknown cycle (no run started)', async () => {
    const app = mountApp(recordingOrchestrator);
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/cycles/999999/start-planning`, remoteAddress: '127.0.0.1', payload: {} });
      expect(res.statusCode).toBe(404);
      expect(calls).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('accepts an operator-supplied prompt, else defaults to one naming the cycle', async () => {
    const app = mountApp(recordingOrchestrator);
    await app.ready();
    try {
      await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-planning`, remoteAddress: '127.0.0.1', payload: { prompt: 'plan the diwa greenfield build' } });
      expect(calls[0].prompt).toBe('plan the diwa greenfield build');
    } finally { await app.close(); }

    // Fresh cycle so the 409 guard doesn't fire on the default-prompt case.
    const c2 = await cycleService.createCycle(projectId, 'Second');
    const app2 = mountApp(recordingOrchestrator);
    await app2.ready();
    try {
      await app2.inject({ method: 'POST', url: `/api/cycles/${c2.id}/start-planning`, remoteAddress: '127.0.0.1', payload: {} });
      expect(calls[1].prompt).toBe(`plan cycle ${c2.id} from the project docs`);
    } finally { await app2.close(); }
  });
});
