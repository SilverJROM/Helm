// A4 (R4.18): step-level event trail from run_events — ordered type+timestamp; no plan.md dependency.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { RunArtifactService, compactRunEventSummary } from './services/run-artifact-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-a4-events-'));
  const dbPath = path.join(dir, 'test.db');
  return { dir, dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

describe.sequential('A4 cycle event trail (R4.18)', () => {
  let cleanup: () => void;
  let projDir: string;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let artifacts: RunArtifactService;
  let projectId: number;
  let cycleId: number;
  let runId: number;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);
    artifacts = new RunArtifactService(dbs);

    projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-a4-proj-'));
    // Intentionally write plan.md then tests prove trail works even when absent/renamed.
    fs.writeFileSync(path.join(projDir, 'plan.md'), '# plan that must not be required\n', 'utf8');

    const proj = projectService.createProject({ name: 'a4-events', directory: projDir });
    projectId = proj.id;
    const c = await cycleService.createCycle(projectId, 'Cycle A4 events');
    cycleId = c.id;
    runId = artifacts.createRun(projectId, 'batch-A4', null, cycleId);
    // Mark completed so acceptance "completed run" holds.
    dbs.raw.prepare(`UPDATE runs SET status='complete', phase='complete' WHERE id=?`).run(runId);

    // Ordered trail via recordRunEvent (existing write path).
    artifacts.recordRunEvent(runId, 'REGISTERED', { role: 'system', reason: 'run-created' }, 'batch-A4');
    artifacts.recordRunEvent(runId, 'CALLBACK_WAIT_RESULT', { role: 'plancore', outcome: 'callback', provider: 'grok' }, 'batch-A4');
    artifacts.recordRunEvent(runId, 'TERMINAL', { outcome: 'complete', reason: 'done' }, 'batch-A4');
  });

  afterEach(() => {
    dbs.close();
    cleanup();
    try { fs.rmSync(projDir, { recursive: true, force: true }); } catch {}
  });

  it('completed run returns ordered events with type and timestamp', () => {
    const listed = artifacts.listCycleRunEvents(cycleId);
    expect(listed.hasRun).toBe(true);
    expect(listed.runId).toBe(runId);
    expect(listed.events.length).toBe(3);
    expect(listed.events.map((e) => e.type)).toEqual([
      'REGISTERED',
      'CALLBACK_WAIT_RESULT',
      'TERMINAL',
    ]);
    for (const e of listed.events) {
      expect(typeof e.type).toBe('string');
      expect(e.type.length).toBeGreaterThan(0);
      expect(typeof e.createdAt).toBe('string');
      expect(e.createdAt.length).toBeGreaterThan(0);
      expect(e.runId).toBe(String(runId));
      // Compact summary only — never a multi-page transcript dump.
      expect(e.summary.length).toBeLessThan(200);
    }
    // Order by created_at ASC, id ASC: ids strictly increasing.
    for (let i = 1; i < listed.events.length; i++) {
      expect(listed.events[i].id).toBeGreaterThan(listed.events[i - 1].id);
    }

    // Summary is compact, not raw payload dump.
    const mid = listed.events[1];
    expect(mid.summary).toMatch(/role=plancore/);
    expect(mid.summary).not.toMatch(/\{/);
  });

  it('view/API renders with plan.md absent — no file dependency', async () => {
    // Remove plan.md entirely; event trail must still resolve from DB only.
    const planPath = path.join(projDir, 'plan.md');
    expect(fs.existsSync(planPath)).toBe(true);
    fs.renameSync(planPath, planPath + '.bak-a4-absent');
    expect(fs.existsSync(planPath)).toBe(false);

    const listed = artifacts.listCycleRunEvents(cycleId);
    expect(listed.hasRun).toBe(true);
    expect(listed.events.length).toBe(3);

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    app.get('/api/cycles/:id/events', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      const id = Number(request.params.id);
      if (!Number.isInteger(id) || id <= 0) return reply.code(400).send({ error: 'invalid cycle id' });
      const cycle: any = dbs.raw.prepare('SELECT id FROM cycles WHERE id = ?').get(id);
      if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
      return artifacts.listCycleRunEvents(id);
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: `/api/cycles/${cycleId}/events` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasRun).toBe(true);
    expect(body.events).toHaveLength(3);
    expect(body.events[0].type).toBe('REGISTERED');
    expect(body.events[2].type).toBe('TERMINAL');
    // Still no plan.md on disk.
    expect(fs.existsSync(planPath)).toBe(false);

    await app.close();
  });

  it('compactRunEventSummary never dumps long text fields', () => {
    const s = compactRunEventSummary('CALLBACK_WAIT_RESULT', {
      role: 'plancore',
      outcome: 'callback',
      text: 'x'.repeat(5000),
      transcript: 'full session dump ' + 'y'.repeat(2000),
    });
    expect(s).toMatch(/role=plancore/);
    expect(s).not.toMatch(/xxxxx/);
    expect(s.length).toBeLessThan(200);
  });
});
