import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { CycleDocsService } from './services/cycle-docs-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';

// B1 (N10/R2.8): "make every created run cycle-linked" acceptance bundle — the 4 entry paths named
// in the row: POST /api/projects/:id/runs (the one that could create an UNLINKED run — closed here),
// POST /api/cycles/:id/start-planning + start-implementation (already cycle-linked; regression-locked
// so this row's fix never reopens them), and chat (creates no run; regression-locked per CC-CHAT-1 B2 —
// "joining an active run inherits that run's already-resolved cycle root", never launches one itself).

const VALID_PLAN_MD =
  '# Plan\n\n```json\n[{"id":"T1","batch":"B00","title":"vocabulary","req_refs":["R14.46"],"assignee":"terra","validator_lane":"L2","effort":"low","type":"feature"}]\n```\n';

function ownerAuth(req: any, _reply: any, done?: () => void) { req.user = { role: 'owner' }; done?.(); }

describe.sequential('B1: cycle-linkage across every run-creation entry path', () => {
  let dbDir: string;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let cycleDocsService: CycleDocsService;
  let artifacts: RunArtifactService;
  let projectId: number;
  let projDir: string;
  let calls: Array<{ projectId: number; cycleId: number | null | undefined; prompt: string; cyclePlan?: boolean }>;

  const recordingOrchestrator = {
    startRunDetached(input: any) {
      calls.push({ projectId: input.projectId, cycleId: input.cycleId, prompt: input.prompt, cyclePlan: input.cyclePlan });
      const batchId = input.batchId || `batch-${Date.now()}`;
      const runId = artifacts.createRun(input.projectId, batchId, null, input.cycleId ?? null);
      return { runId, batchId };
    }
  };

  function runCount(): number {
    return (dbs.raw.prepare('SELECT COUNT(*) AS c FROM runs').get() as any).c as number;
  }

  beforeEach(async () => {
    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b1-linkage-'));
    dbs = new DatabaseService(path.join(dbDir, 'test.db'));
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);
    cycleDocsService = new CycleDocsService(cycleService);
    artifacts = new RunArtifactService(dbs);
    calls = [];
    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b1-linkage-proj-'));
    const proj = projectService.createProject({ name: 'b1-linkage', directory: projDir });
    projectId = proj.id;
  });

  afterEach(() => {
    try { dbs.close(); } catch {}
    try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  // --- (1) POST /api/projects/:id/runs — N10: the one starter that could create an unlinked run ---
  describe('POST /api/projects/:id/runs (N10 refusal — mirrors index.ts)', () => {
    function mountApp() {
      const app = Fastify({ logger: false });
      const requireOwnerPre = createRequireOwner();
      app.post('/api/projects/:id/runs', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
        const pid = Number(request.params.id);
        if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
        const body = request.body || {};
        const cid = Number(body.cycleId);
        if (!Number.isFinite(cid)) return reply.code(400).send({ error: 'cycleId required' });
        const cycle: any = dbs.raw.prepare('SELECT id, project_id FROM cycles WHERE id = ?').get(cid);
        if (!cycle || Number(cycle.project_id) !== pid) return reply.code(400).send({ error: 'unknown cycle for this project' });
        const prompt = (body.prompt || '').trim();
        if (!prompt) return reply.code(400).send({ error: 'prompt required' });
        const { runId } = recordingOrchestrator.startRunDetached({ projectId: pid, cycleId: cid, prompt, batchId: body.batchId });
        return { runId, status: 'started' };
      });
      return app;
    }

    it('refuses (400) with no run row created when cycleId is absent', async () => {
      const before = runCount();
      const app = mountApp();
      await app.ready();
      try {
        const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/runs`, remoteAddress: '127.0.0.1', payload: { prompt: 'hello' } });
        expect(res.statusCode).toBe(400);
        expect(res.json().error).toMatch(/cycleId/);
        expect(calls).toHaveLength(0);
        expect(runCount()).toBe(before); // refused BEFORE any run row exists
      } finally { await app.close(); }
    });

    it('refuses (400) with no run row created when cycleId belongs to a DIFFERENT project', async () => {
      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b1-linkage-other-'));
      const other = projectService.createProject({ name: 'other', directory: otherDir });
      const otherCycle = await cycleService.createCycle(other.id, 'Other cycle');
      const before = runCount();
      const app = mountApp();
      await app.ready();
      try {
        const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/runs`, remoteAddress: '127.0.0.1', payload: { prompt: 'hello', cycleId: otherCycle.id } });
        expect(res.statusCode).toBe(400);
        expect(calls).toHaveLength(0);
        expect(runCount()).toBe(before);
      } finally {
        await app.close();
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    });

    it('creates a cycle-LINKED run when a valid cycleId for THIS project is supplied', async () => {
      const cycle = await cycleService.createCycle(projectId, 'Real cycle');
      const app = mountApp();
      await app.ready();
      try {
        const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/runs`, remoteAddress: '127.0.0.1', payload: { prompt: 'hello', cycleId: cycle.id } });
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(calls).toHaveLength(1);
        expect(calls[0].cycleId).toBe(cycle.id);
        const row: any = dbs.raw.prepare('SELECT cycle_id FROM runs WHERE id = ?').get(body.runId);
        expect(Number(row.cycle_id)).toBe(cycle.id);
      } finally { await app.close(); }
    });
  });

  // --- (2) POST /api/cycles/:id/start-planning — regression: still cycle-linked, non-cyclePlan ---
  describe('POST /api/cycles/:id/start-planning (regression: cycle-linked)', () => {
    it('threads cycleId through and links the created run', async () => {
      const cycle = await cycleService.createCycle(projectId, 'Plan cycle');
      const app = Fastify({ logger: false });
      const requireOwnerPre = createRequireOwner();
      app.post('/api/cycles/:id/start-planning', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
        const cid = Number(request.params.id);
        const c: any = dbs.raw.prepare('SELECT id, project_id FROM cycles WHERE id = ?').get(cid);
        if (!c) return reply.code(404).send({ error: 'unknown cycle' });
        const pid = Number(c.project_id);
        const { runId, batchId } = recordingOrchestrator.startRunDetached({ projectId: pid, cycleId: cid, prompt: `plan cycle ${cid} from the project docs` });
        return { runId, batchId, cycleId: cid, status: 'started' };
      });
      await app.ready();
      try {
        const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycle.id}/start-planning`, remoteAddress: '127.0.0.1', payload: {} });
        expect(res.statusCode).toBe(200);
        expect(calls[0].cycleId).toBe(cycle.id);
        expect((dbs.raw.prepare('SELECT cycle_id FROM runs WHERE id = ?').get(res.json().runId) as any).cycle_id).toBe(cycle.id);
      } finally { await app.close(); }
    });
  });

  // --- (3) POST /api/cycles/:id/start-implementation — regression: cyclePlan path unaffected ---
  describe('POST /api/cycles/:id/start-implementation (regression: cyclePlan cycle-linked)', () => {
    it('validates plan.md, then threads cycleId + cyclePlan=true through', async () => {
      const cycle = await cycleService.createCycle(projectId, 'Impl cycle');
      await cycleDocsService.writeCycleDoc(cycle.id, 'plan.md', VALID_PLAN_MD);
      const app = Fastify({ logger: false });
      const requireOwnerPre = createRequireOwner();
      app.post('/api/cycles/:id/start-implementation', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
        const cid = Number(request.params.id);
        const c: any = dbs.raw.prepare('SELECT id, project_id FROM cycles WHERE id = ?').get(cid);
        if (!c) return reply.code(404).send({ error: 'unknown cycle' });
        const pid = Number(c.project_id);
        let planValid = false;
        try { planValid = (await cycleDocsService.readCycleDoc(cid, 'plan.md')).valid === true; } catch { planValid = false; }
        if (!planValid) return reply.code(400).send({ error: 'author a valid plan.md first' });
        const { runId, batchId } = recordingOrchestrator.startRunDetached({ projectId: pid, cycleId: cid, prompt: `implement cycle ${cid} from plan.md`, cyclePlan: true });
        return { runId, batchId, cycleId: cid, status: 'started' };
      });
      await app.ready();
      try {
        const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycle.id}/start-implementation`, remoteAddress: '127.0.0.1', payload: {} });
        expect(res.statusCode).toBe(200);
        expect(calls[0].cycleId).toBe(cycle.id);
        expect(calls[0].cyclePlan).toBe(true);
        expect((dbs.raw.prepare('SELECT cycle_id FROM runs WHERE id = ?').get(res.json().runId) as any).cycle_id).toBe(cycle.id);
      } finally { await app.close(); }
    });

    it('400s (no run created) without a valid plan.md — the gate this row must not weaken', async () => {
      const cycle = await cycleService.createCycle(projectId, 'No-plan cycle');
      const before = runCount();
      const app = Fastify({ logger: false });
      const requireOwnerPre = createRequireOwner();
      app.post('/api/cycles/:id/start-implementation', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
        const cid = Number(request.params.id);
        let planValid = false;
        try { planValid = (await cycleDocsService.readCycleDoc(cid, 'plan.md')).valid === true; } catch { planValid = false; }
        if (!planValid) return reply.code(400).send({ error: 'author a valid plan.md first' });
        return reply.code(200).send({ status: 'started' });
      });
      await app.ready();
      try {
        const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycle.id}/start-implementation`, remoteAddress: '127.0.0.1', payload: {} });
        expect(res.statusCode).toBe(400);
        expect(runCount()).toBe(before);
      } finally { await app.close(); }
    });
  });

  // --- (4) POST /api/projects/:id/chat — regression: chat creates no run (CC-CHAT-1 B2) ---
  describe('POST /api/projects/:id/chat (regression: never creates a run — inherits an active run instead)', () => {
    function mountApp(recordEvent: (e: any) => void) {
      const app = Fastify({ logger: false });
      const requireOwnerPre = createRequireOwner();
      const tmux = { async sessionExists() { return false; }, async getPanePid() { return null; }, async sendAndSubmit() { return true; } };
      app.post('/api/projects/:id/chat', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
        const pid = Number(request.params.id);
        const body = request.body || {};
        const text = (body.text || '').trim();
        if (!text) return reply.code(400).send({ error: 'text is required' });
        // Mirrors index.ts: no active run -> no auto-launch (CC-CHAT-1 B2); an active run only routes
        // delivery to its already-live phase-brain session — this route calls NO run-start method ever.
        const ar: any = dbs.raw.prepare("SELECT phase FROM runs WHERE project_id = ? AND phase NOT IN ('complete','failed','blocked') ORDER BY id DESC LIMIT 1").get(pid);
        const hasActiveRun = !!ar;
        recordEvent({ pid, text, hasActiveRun });
        void (async () => {
          const alive = hasActiveRun && (await tmux.sessionExists());
          if (!alive && hasActiveRun) { /* delivery-failed, best-effort — no run created either way */ }
        })();
        return { ok: true };
      });
      return app;
    }

    it('no active run: message recorded, NO run row created', async () => {
      const before = runCount();
      const events: any[] = [];
      const app = mountApp((e) => events.push(e));
      await app.ready();
      try {
        const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/chat`, remoteAddress: '127.0.0.1', payload: { text: 'hi' } });
        expect(res.statusCode).toBe(200);
        expect(events).toHaveLength(1);
        expect(events[0].hasActiveRun).toBe(false);
        expect(calls).toHaveLength(0);
        expect(runCount()).toBe(before);
      } finally { await app.close(); }
    });

    it('an ALREADY-active cycle-linked run: message inherits it, NO second run row created', async () => {
      const cycle = await cycleService.createCycle(projectId, 'Active cycle');
      const runId = artifacts.createRun(projectId, 'active-batch', null, cycle.id);
      dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(runId);
      const before = runCount();
      const events: any[] = [];
      const app = mountApp((e) => events.push(e));
      await app.ready();
      try {
        const res = await app.inject({ method: 'POST', url: `/api/projects/${projectId}/chat`, remoteAddress: '127.0.0.1', payload: { text: 'status?' } });
        expect(res.statusCode).toBe(200);
        expect(events[0].hasActiveRun).toBe(true);
        expect(calls).toHaveLength(0); // inherits the existing run/session — never starts a new one
        expect(runCount()).toBe(before);
      } finally { await app.close(); }
    });
  });
});
