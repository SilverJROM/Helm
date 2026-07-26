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

// B13-T03d: the CC cycle -> helm-algo run-engine wire. A run started for a cycle must be linked
// (runs.cycle_id) so it is reviewable in the cycle's Implementation tab (getCycleRunState).
// This test mounts the real endpoint logic over a recording fake orchestrator that performs the
// SAME synchronous createRun(...cycleId) the real startRunDetached now does — asserting the guards,
// server-side project derivation, cycleId pass-through, and end-to-end reviewability.

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b13t03d-'));
  return { dbPath: path.join(dir, 'test.db'), cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
function ownerAuth(req: any, _reply: any, done?: () => void) { req.user = { role: 'owner' }; done?.(); }

describe.sequential('B13-T03d cycle -> run-engine start wire (R-I4/F6)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let artifacts: RunArtifactService;
  let projectId: number;
  let cycleId: number;
  let calls: Array<{ projectId: number; cycleId: number | null | undefined; prompt: string }>;

  // Mirrors index.ts POST /api/cycles/:id/start-implementation over an injected orchestrator.
  function mountApp(orchestrator: { startRunDetached: (i: any) => { runId: number; batchId: string } }) {
    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    app.post('/api/cycles/:id/start-implementation', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      const cid = Number(request.params.id);
      const cycle: any = dbs.prepare('SELECT id, project_id, phase FROM cycles WHERE id = ?').get(cid);
      if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
      const pid = Number(cycle.project_id);
      if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
      const body = request.body || {};
      const seedPlan = typeof body.seedPlan === 'string' && body.seedPlan.trim() ? body.seedPlan.trim() : undefined;
      const prompt = (body.prompt || (seedPlan ? `[plan-cache replay: ${seedPlan}]` : '')).trim();
      if (!prompt) return reply.code(400).send({ error: 'prompt required' });
      const { runId, batchId } = orchestrator.startRunDetached({ projectId: pid, cycleId: cid, prompt, roleBindings: body.roleBindings, batchId: body.batchId, seedPlan });
      try { cycleService.setCyclePhase(cid, 'implementation'); } catch { /* cosmetic */ }
      return { runId, batchId, cycleId: cid, status: 'started' };
    });
    return app;
  }

  // A fake orchestrator that performs the real startRunDetached's SYNCHRONOUS side effect:
  // createRun(projectId, batchId, northStarRef, cycleId) — the exact linkage under test.
  const recordingOrchestrator = {
    startRunDetached(input: any) {
      calls.push({ projectId: input.projectId, cycleId: input.cycleId, prompt: input.prompt });
      const batchId = input.batchId || 'b13t03d-batch';
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
    const proj = projectService.createProject({ name: 'b13t03d', directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b13t03d-proj-')) });
    projectId = proj.id;
    const c = await cycleService.createCycle(projectId, 'Dogfood Cycle');
    cycleId = c.id;
  });
  afterEach(() => { dbs.close(); cleanup(); });

  it('starts a cycle-LINKED run: derives project from the cycle, threads cycleId, and the run is reviewable', async () => {
    const app = mountApp(recordingOrchestrator);
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-implementation`, remoteAddress: '127.0.0.1', payload: { prompt: 'fix lucky9 hand9Value Ace scoring' } });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.status).toBe('started');
      expect(body.cycleId).toBe(cycleId);
      expect(typeof body.runId).toBe('number');

      // project derived server-side from the cycle (never client-supplied) + cycleId threaded through.
      expect(calls).toHaveLength(1);
      expect(calls[0].projectId).toBe(projectId);
      expect(calls[0].cycleId).toBe(cycleId);

      // The contract: the run is now linked to the cycle and reviewable in the Implementation tab.
      const linked: any = dbs.prepare('SELECT cycle_id FROM runs WHERE id = ?').get(body.runId);
      expect(Number(linked.cycle_id)).toBe(cycleId);
      const state = artifacts.getCycleRunState(cycleId);
      expect(state.hasRun).toBe(true);
    } finally { await app.close(); }
  });

  it('404s on an unknown cycle (no run started)', async () => {
    const app = mountApp(recordingOrchestrator);
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/cycles/999999/start-implementation`, remoteAddress: '127.0.0.1', payload: { prompt: 'x' } });
      expect(res.statusCode).toBe(404);
      expect(calls).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('400s when no prompt and no seedPlan (no run started)', async () => {
    const app = mountApp(recordingOrchestrator);
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-implementation`, remoteAddress: '127.0.0.1', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(calls).toHaveLength(0);
    } finally { await app.close(); }
  });

  it('seedPlan replay needs no prompt (synthesizes one) and still links the run', async () => {
    const app = mountApp(recordingOrchestrator);
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-implementation`, remoteAddress: '127.0.0.1', payload: { seedPlan: 'lucky9-fix' } });
      expect(res.statusCode).toBe(200);
      expect(calls[0].cycleId).toBe(cycleId);
      expect(calls[0].prompt).toContain('lucky9-fix');
      const state = artifacts.getCycleRunState(cycleId);
      expect(state.hasRun).toBe(true);
    } finally { await app.close(); }
  });
});
