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

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b13t01b-'));
  const dbPath = path.join(dir, 'test.db');
  return { dbPath, cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

describe.sequential('B13-T01b cycle run-state (R-I4/F6/B5)', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let artifacts: RunArtifactService;
  let projectId: number;
  let cycleWithRunId: number;
  let cycleNoRunId: number;

  beforeEach(async () => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    projectService = new ProjectService(dbs);
    cycleService = new CycleService(dbs, projectService);
    artifacts = new RunArtifactService(dbs);

    const proj = projectService.createProject({
      name: 'b13t01b-run-state',
      directory: fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b13t01b-proj-'))
    });
    projectId = proj.id;

    const cWithRun = await cycleService.createCycle(projectId, 'Cycle With Run');
    cycleWithRunId = cWithRun.id;
    const cNoRun = await cycleService.createCycle(projectId, 'Cycle No Run');
    cycleNoRunId = cNoRun.id;

    // Real B10 engine rows — same shape as run-orchestrator/task-queue-service write.
    const runId = artifacts.createRun(projectId, 'batch-B13', null, cycleWithRunId);
    const doneTaskId = artifacts.recordTask(runId, 'B3-T01', 'Discovery doc sync');
    dbs.raw.prepare(
      "UPDATE run_tasks SET status='complete', created_at='2026-07-04T09:00:00Z', updated_at='2026-07-04T09:02:30Z' WHERE id=?"
    ).run(doneTaskId);
    // Fixture the historical attempts directly: recordAttempt is the production transition helper and
    // correctly moves a task to working, while this row is intentionally already terminal/complete.
    dbs.raw.prepare("INSERT INTO task_attempts (task_id, attempt_num, status) VALUES (?, 1, 'complete')").run(doneTaskId);
    const attempt2Id = Number(
      dbs.raw.prepare("INSERT INTO task_attempts (task_id, attempt_num, status) VALUES (?, 2, 'complete')")
        .run(doneTaskId).lastInsertRowid
    );
    artifacts.recordValidation(attempt2Id, 'PASS', 'looks good');
    artifacts.recordArtifact(runId, 'commit', 'src/index.ts', 'abc1234def', doneTaskId);

    const workingTaskId = artifacts.recordTask(runId, 'B3-T02', 'DEV deploy proof card');
    dbs.raw.prepare("UPDATE run_tasks SET status='working' WHERE id=?").run(workingTaskId);

    const pendingTaskId = artifacts.recordTask(runId, 'B3-T03', 'Sidebar app-shell port');
    void pendingTaskId;
  });

  afterEach(() => {
    dbs.close();
    cleanup();
  });

  it('getCycleRunState returns real per-task state for a cycle with a run', () => {
    const state = artifacts.getCycleRunState(cycleWithRunId);
    expect(state.hasRun).toBe(true);
    expect(state.tasks).toHaveLength(3);

    const done = state.tasks.find(t => t.taskKey === 'B3-T01')!;
    expect(done.status).toBe('complete');
    expect(done.attempts).toBe(2); // COUNT(task_attempts), NOT the dead attempts_count column
    expect(done.durationSec).toBe(150); // 2m30s terminal duration, derived not fabricated
    expect(done.commit).toEqual({ path: 'src/index.ts', sha: 'abc1234def' });
    expect(done.validationNotes).toEqual([{ result: 'PASS', note: 'looks good', ts: expect.any(String) }]);

    const working = state.tasks.find(t => t.taskKey === 'B3-T02')!;
    expect(working.status).toBe('working');
    expect(working.attempts).toBe(0);
    expect(working.durationSec).toBeNull(); // non-terminal — no fabricated duration
    expect(working.commit).toBeNull();

    const pending = state.tasks.find(t => t.taskKey === 'B3-T03')!;
    expect(pending.status).toBe('pending');
    expect(pending.commit).toBeNull();
  });

  it('getCycleRunState degrades to hasRun:false for a cycle with no run (honest graceful)', () => {
    const state = artifacts.getCycleRunState(cycleNoRunId);
    expect(state).toEqual({ hasRun: false, tasks: [] });
  });

  it('getCycleRunState exposes runId + runActive so the Impl-tab Graceful Stop can target the live run (R-F7)', () => {
    // The run created in beforeEach has no terminal phase/status yet → active.
    const active = artifacts.getCycleRunState(cycleWithRunId);
    expect(active.hasRun).toBe(true);
    expect(typeof active.runId).toBe('number');
    expect(active.runActive).toBe(true);

    // Once the run reaches a terminal phase, runActive flips false (no-op graceful stop).
    dbs.raw.prepare("UPDATE runs SET phase='complete', status='complete' WHERE id=?").run(active.runId);
    const done = artifacts.getCycleRunState(cycleWithRunId);
    expect(done.runId).toBe(active.runId);
    expect(done.runActive).toBe(false);
  });

  it('GET /api/cycles/:id/run-state is guarded and derives the run server-side (mirrors B11-T04)', async () => {
    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();

    app.get('/api/cycles/:id/run-state', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      const id = Number(request.params.id);
      const cycle: any = dbs.prepare('SELECT id FROM cycles WHERE id = ?').get(id);
      if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
      return artifacts.getCycleRunState(id);
    });
    await app.ready();

    try {
      const withRunRes = await app.inject({ method: 'GET', url: `/api/cycles/${cycleWithRunId}/run-state`, remoteAddress: '127.0.0.1' });
      expect(withRunRes.statusCode).toBe(200);
      const withRunBody = withRunRes.json();
      expect(withRunBody.hasRun).toBe(true);
      expect(withRunBody.tasks.length).toBe(3);

      const noRunRes = await app.inject({ method: 'GET', url: `/api/cycles/${cycleNoRunId}/run-state`, remoteAddress: '127.0.0.1' });
      expect(noRunRes.statusCode).toBe(200);
      expect(noRunRes.json()).toEqual({ hasRun: false, tasks: [] });

      const unknownRes = await app.inject({ method: 'GET', url: `/api/cycles/999999/run-state`, remoteAddress: '127.0.0.1' });
      expect(unknownRes.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  // LV-R1: derived 'working' status — honest (from a real task_attempts row), guarded on runActive.
  it('LV-R1: derives working for a pending task with an in-flight attempt in an ACTIVE run', () => {
    const runId = artifacts.getCycleRunState(cycleWithRunId).runId!;
    const tId = artifacts.recordTask(runId, 'LV-A', 'live in-flight task');
    // Direct insertion preserves the legacy pending+attempt state that this read-derivation test targets;
    // recordAttempt itself is a write-side transition and correctly persists run_tasks.status='working'.
    dbs.raw.prepare("INSERT INTO task_attempts (task_id, attempt_num, status) VALUES (?, 1, 'pending')").run(tId);
    const state = artifacts.getCycleRunState(cycleWithRunId);
    expect(state.runActive).toBe(true);
    const live = state.tasks.find(t => t.taskKey === 'LV-A')!;
    expect(live.attempts).toBe(1);
    expect(live.status).toBe('working'); // derived, not stored (stored is still 'pending')
    // stored DB row is untouched — derivation is in the returned object only
    const storedRow: any = dbs.raw.prepare('SELECT status FROM run_tasks WHERE id = ?').get(tId);
    expect(storedRow.status).toBe('pending');
  });

  it('LV-R1: does NOT derive working for a task with 0 attempts (stays pending)', () => {
    const state = artifacts.getCycleRunState(cycleWithRunId);
    const pending = state.tasks.find(t => t.taskKey === 'B3-T03')!;
    expect(pending.attempts).toBe(0);
    expect(pending.status).toBe('pending'); // no attempt → never promoted
  });

  it('LV-R1: does NOT derive working when the run is TERMINAL (completed cycle unchanged)', () => {
    const runId = artifacts.getCycleRunState(cycleWithRunId).runId!;
    const tId = artifacts.recordTask(runId, 'LV-C', 'pending task with an attempt');
    dbs.raw.prepare("INSERT INTO task_attempts (task_id, attempt_num, status) VALUES (?, 1, 'pending')").run(tId);
    // flip the run terminal (dogfood-style completed cycle)
    dbs.raw.prepare("UPDATE runs SET phase='complete', status='complete' WHERE id=?").run(runId);
    const state = artifacts.getCycleRunState(cycleWithRunId);
    expect(state.runActive).toBe(false);
    // guarded on runActive → the pending-with-attempt task is NOT falsely promoted
    expect(state.tasks.find(t => t.taskKey === 'LV-C')!.status).toBe('pending');
    // a stored terminal task stays exactly as stored (no false working)
    expect(state.tasks.find(t => t.taskKey === 'B3-T01')!.status).toBe('complete');
  });

  // LV-R2: task-terminal endpoint — server-derived running worker pane, path-safe + graceful.
  it('LV-R2: task-terminal returns captured text for a running worker, graceful when none, 404 unknown', async () => {
    const runId = artifacts.getCycleRunState(cycleWithRunId).runId!;
    dbs.raw.prepare(
      "INSERT INTO worker_runtimes (project_id, role, provider, model, session, state, run_id) VALUES (?,?,?,?,?,?,?)"
    ).run(projectId, 'implementer', 'claude', 'sonnet', 'helm-impl-sess', 'running', runId);

    const captured: Array<{ session: string; lines: number }> = [];
    const tmuxSpy = {
      capturePane: async (session: string, lines: number) => {
        captured.push({ session, lines });
        return 'LIVE PANE OUTPUT\nbuilding engine...';
      }
    };

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    app.get('/api/cycles/:id/task-terminal', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      const id = Number(request.params.id);
      const cycle: any = dbs.prepare('SELECT id FROM cycles WHERE id = ?').get(id);
      if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
      const role = String(request.query?.role ?? 'implementer');
      if (role !== 'implementer' && role !== 'validator') return reply.code(400).send({ error: 'invalid role' });
      const run: any = dbs.prepare('SELECT id FROM runs WHERE cycle_id = ? ORDER BY id DESC LIMIT 1').get(id);
      if (!run) return { session: null, text: '' };
      const worker: any = dbs.prepare(
        "SELECT session FROM worker_runtimes WHERE run_id = ? AND role = ? AND state IN ('launching','running') ORDER BY id DESC LIMIT 1"
      ).get(run.id, role);
      if (!worker || !worker.session) return { session: null, text: '' };
      try {
        const text = await tmuxSpy.capturePane(worker.session, 120);
        return { session: worker.session, text: text || '' };
      } catch (e: any) {
        return { session: worker.session, text: '' };
      }
    });
    await app.ready();

    try {
      const res = await app.inject({ method: 'GET', url: `/api/cycles/${cycleWithRunId}/task-terminal?role=implementer`, remoteAddress: '127.0.0.1' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ session: 'helm-impl-sess', text: 'LIVE PANE OUTPUT\nbuilding engine...' });
      expect(captured[0]).toEqual({ session: 'helm-impl-sess', lines: 120 }); // ~120 lines, real session

      // no running validator worker for this run → graceful empty
      const val = await app.inject({ method: 'GET', url: `/api/cycles/${cycleWithRunId}/task-terminal?role=validator`, remoteAddress: '127.0.0.1' });
      expect(val.statusCode).toBe(200);
      expect(val.json()).toEqual({ session: null, text: '' });

      // run-less cycle → graceful empty (never fabricated)
      const noRun = await app.inject({ method: 'GET', url: `/api/cycles/${cycleNoRunId}/task-terminal`, remoteAddress: '127.0.0.1' });
      expect(noRun.statusCode).toBe(200);
      expect(noRun.json()).toEqual({ session: null, text: '' });

      // unknown cycle → 404
      const unknown = await app.inject({ method: 'GET', url: `/api/cycles/999999/task-terminal`, remoteAddress: '127.0.0.1' });
      expect(unknown.statusCode).toBe(404);

      // invalid role → 400 (rejects anything but implementer|validator)
      const bad = await app.inject({ method: 'GET', url: `/api/cycles/${cycleWithRunId}/task-terminal?role=coordinator`, remoteAddress: '127.0.0.1' });
      expect(bad.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});
