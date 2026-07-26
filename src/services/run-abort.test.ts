// R5 (CC-CHAT-4): zombie run loop — DB-terminal runs must stop their in-process loop.
//
// Live evidence (run 74): UPDATE runs SET phase='failed' did NOT stop the already-running
// orchestrator loop; it kept spawning implementer sessions for 30+ minutes. These tests pin:
//  A. loop-abort-on-terminal: a run marked terminal in the DB aborts at the next phase
//     boundary / BEFORE the next dispatch (zero further spawns).
//  B. sanctioned stop mid-wait: the in-memory abort registry (flipped by POST /api/runs/:id/stop)
//     is consulted every waitForCallback poll cycle — stop lands within one cycle even mid-wait,
//     the in-flight session is reaped and its worker_runtimes row transitioned.
//  C. RunOrchestratorService.stopRun (the endpoint's engine): marks the run terminal (status
//     CHECK only allows complete/failed → 'failed'), records the stop_reason as an agent_events
//     row, flips the registry flag, reaps live worker sessions + rows; idempotent on terminal.
//  D. HTTP contract mirror for POST /api/runs/:id/stop (200 / alreadyTerminal / 404), same
//     mirror style as routing-rules-api.test.ts.
process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { RunArtifactService } from './run-artifact-service.js';
import { AgentEventsService } from './agent-events-service.js';
import { FakeTransport } from './fake-transport.js';
import { OrchestratorLoop, RunAbortedError } from './orchestrator-loop.js';
import { RunOrchestratorService } from './run-orchestrator-service.js';
import { requestRunAbort, getRunAbort, clearRunAbort } from './run-abort-registry.js';
import { createRequireOwner } from '../auth/auth-middleware.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('R5 run abort — loop stops when the run is terminal in the DB (CC-CHAT-4)', () => {
  let dbPath: string;
  let dbs: DatabaseService;
  let artifacts: RunArtifactService;
  let runDir: string;
  let transport: FakeTransport;
  let runId: number;
  const PID = 1;

  beforeEach(async () => {
    dbPath = path.join(fss.mkdtempSync(path.join(os.tmpdir(), 'helm-r5-abort-')), 'test.db');
    dbs = new DatabaseService(dbPath);
    artifacts = new RunArtifactService(dbs);
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-r5-run-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# R5 callbacks\n', 'utf8');
    transport = new FakeTransport();
    dbs.raw.prepare('INSERT INTO projects (id, name, directory) VALUES (?,?,?)').run(PID, 'r5-proj', runDir);
    runId = artifacts.createRun(PID, 'batch-R5');
    dbs.raw.prepare("UPDATE runs SET phase = 'executing' WHERE id = ?").run(runId);
  });

  afterEach(async () => {
    clearRunAbort(runId);
    dbs.close();
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(path.dirname(dbPath), { recursive: true, force: true }).catch(() => {});
  });

  function makeLoop(): OrchestratorLoop {
    return new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-R5',
      artifactService: artifacts,
      runId,
      projectId: PID,
    });
  }

  it('A. run already terminal in DB → runTask aborts at the boundary with ZERO dispatches (run-74 zombie fix)', async () => {
    dbs.raw.prepare("UPDATE runs SET phase = 'failed', status = 'failed' WHERE id = ?").run(runId);
    const loop = makeLoop();
    await expect(loop.runTask({ brief: 'do a thing', taskType: 'feature' })).rejects.toThrow(RunAbortedError);
    expect(transport.spawnCalls.length).toBe(0); // never spawned against a terminal run
  });

  it('A2. run marked terminal MID-RUN (direct DB UPDATE) → no further dispatch after the current phase', async () => {
    const loop = makeLoop();
    const p = loop.runTask({ brief: 'feature work', taskType: 'feature' });
    // let the implementer dispatch go out, then mark the run failed in the DB (the run-74 scenario)
    await sleep(60);
    expect(transport.spawnCalls.length).toBe(1);
    dbs.raw.prepare("UPDATE runs SET phase = 'failed', status = 'failed' WHERE id = ?").run(runId);
    // complete the implementer phase; the NEXT boundary (pre-dispatch validator) must abort
    await fs.appendFile(path.join(runDir, 'callbacks.md'), `[helm callback] implementer batch-R5 STATUS: DONE — done\n`);
    await expect(p).rejects.toThrow(RunAbortedError);
    expect(transport.spawnCalls.length).toBe(1); // validator was never spawned
    expect(transport.spawnCalls.filter(s => s.role === 'validator').length).toBe(0);
  });

  it('B. sanctioned stop mid-wait: abort registry lands within one poll cycle; session reaped + worker_runtimes row transitioned', async () => {
    const loop = makeLoop();
    const p = loop.runTask({ brief: 'long-running work', taskType: 'feature' });
    await sleep(60); // implementer dispatched, loop is inside waitForCallback
    expect(transport.spawnCalls.length).toBe(1);
    const wrBefore: any = dbs.raw.prepare('SELECT id, state FROM worker_runtimes WHERE run_id = ?').get(runId);
    expect(wrBefore).toBeTruthy();
    expect(wrBefore.state).toBe('running');

    requestRunAbort(runId, 'test sanctioned stop');
    const t0 = Date.now();
    await expect(p).rejects.toThrow(RunAbortedError);
    // fake-mode poll cycle is 12ms; generous bound proves "within one poll cycle", not a timeout
    expect(Date.now() - t0).toBeLessThan(1500);

    // in-flight session reaped via transport with the abort reason
    expect(transport.reapCalls.some(r => /run-aborted/.test(r.reason))).toBe(true);
    // worker_runtimes row marked (not left 'running' forever)
    const wrAfter: any = dbs.raw.prepare('SELECT state, exit_reason FROM worker_runtimes WHERE id = ?').get(wrBefore.id);
    expect(wrAfter.state).toBe('reaped');
    expect(wrAfter.exit_reason).toBe('run-aborted');
    // no further spawns after the abort
    expect(transport.spawnCalls.length).toBe(1);
  });

  // stopRun's session-reap targets rows it did NOT spawn (orphan coverage), so use a plain
  // recording stub (FakeTransport.reap only records handles from its own spawn map).
  const svcReaps: Array<{ handle: string; reason: string }> = [];
  function makeService(): RunOrchestratorService {
    const events = new AgentEventsService(dbs);
    svcReaps.length = 0;
    const stubTransport: any = {
      spawn: async () => ({ handle: 'stub:0.0', role: 'stub' }),
      reap: async (handle: string, reason = 'complete') => { svcReaps.push({ handle, reason }); },
    };
    return new RunOrchestratorService({
      artifacts,
      transport: stubTransport,
      events,
      // stopRun only touches artifacts.db / transport / events — the rest are not exercised
      planning: { setIngestValidator() {} } as any,
      parser: { setIngestValidator() {} } as any,
      queue: null as any,
      projectService: null as any,
      assignmentService: null as any,
      // B11-T02: every ctor site MUST supply fake finalTestRunner (test safety guard)
      finalTestRunner: { async runTest() { return { success: true, note: 'abort-test-fake' }; } } as any,
    });
  }

  it('C. stopRun: marks the run terminal, flips the abort flag, records stop_reason event, reaps live workers; idempotent', async () => {
    const svc = makeService();
    dbs.raw.prepare(
      `INSERT INTO worker_runtimes (project_id, role, provider, model, session, state, spawned_by, run_id, started_at)
       VALUES (?,?,?,?,?,'running','orchestrator',?, datetime('now'))`
    ).run(PID, 'implementer', 'grok', 'grok-4.5', 'r5-live-sess', runId);

    const res = await svc.stopRun(runId, 'operator clicked Stop');
    expect(res.ok).toBe(true);
    expect(res.alreadyTerminal).toBeUndefined();
    expect(res.reapedWorkers).toBe(1);

    // run terminal in DB ('stopped' is not legal under the runs.status CHECK → 'failed')
    const run: any = dbs.raw.prepare('SELECT phase, status, ended_at FROM runs WHERE id = ?').get(runId);
    expect(run.phase).toBe('failed');
    expect(run.status).toBe('failed');
    expect(run.ended_at).toBeTruthy();

    // abort flag set for the in-process loop
    expect(getRunAbort(runId)?.reason).toContain('operator clicked Stop');

    // stop_reason recorded as an agent_events row (runs table has no stop_reason column)
    const ev: any = dbs.raw.prepare(
      `SELECT body FROM agent_events WHERE run_id = ? AND type = 'status' AND correlation_id LIKE 'run-stop:%'`
    ).get(String(runId));
    expect(ev).toBeTruthy();
    expect(JSON.parse(ev.body).stop_reason).toBe('operator clicked Stop');

    // live worker session reaped via transport + row transitioned
    expect(svcReaps.some(r => r.handle === 'r5-live-sess:0.0' && r.reason === 'run-stopped')).toBe(true);
    const wr: any = dbs.raw.prepare('SELECT state, exit_reason FROM worker_runtimes WHERE run_id = ?').get(runId);
    expect(wr.state).toBe('reaped');
    expect(wr.exit_reason).toBe('run-stopped');

    // idempotent: second stop reports alreadyTerminal, no double work
    const again = await svc.stopRun(runId);
    expect(again.alreadyTerminal).toBe(true);
    expect(again.reapedWorkers).toBe(0);
  });

  it('C3. stopRun during interview phase also reaps the discovery session', async () => {
    dbs.raw.prepare("UPDATE runs SET phase = 'interview' WHERE id = ?").run(runId);
    const svc = makeService();
    const res = await svc.stopRun(runId, 'stop mid-interview');
    expect(res.ok).toBe(true);
    expect(svcReaps.some(r => r.handle === 'helm-discovery-r5_proj:0.0' && r.reason === 'run-stopped-preexec')).toBe(true);
    const run: any = dbs.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
    expect(run.phase).toBe('failed');
  });

  it('C2. stopRun on unknown run throws run not found', async () => {
    const svc = makeService();
    await expect(svc.stopRun(999999)).rejects.toThrow(/run not found/);
  });

  it('D. HTTP contract: POST /api/runs/:id/stop → 200 stopped / 200 alreadyTerminal / 404 unknown (handler mirror)', async () => {
    const svc = makeService();
    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    const ownerAuth = (req: any, _reply: any, done?: () => void) => { req.user = { role: 'owner' }; done?.(); };
    // 1:1 mirror of the src/index.ts route body (pins the HTTP status/shape contract)
    app.post('/api/runs/:id/stop', { preHandler: [ownerAuth as any, requireOwnerPre] }, async (request: any, reply: any) => {
      const rid = Number(request.params.id);
      const body = request.body || {};
      try {
        const res = await svc.stopRun(rid, body.reason);
        return { runId: rid, ...res };
      } catch (e: any) {
        if (/run not found/i.test(String(e?.message))) return reply.code(404).send({ error: 'run not found' });
        return reply.code(400).send({ error: e.message || 'stop failed' });
      }
    });

    const r1 = await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop`, payload: { reason: 'http stop' } });
    expect(r1.statusCode).toBe(200);
    const b1 = r1.json();
    expect(b1.ok).toBe(true);
    expect(b1.runId).toBe(runId);
    expect(b1.status).toBe('failed');

    const r2 = await app.inject({ method: 'POST', url: `/api/runs/${runId}/stop`, payload: {} });
    expect(r2.statusCode).toBe(200);
    expect(r2.json().alreadyTerminal).toBe(true);

    const r3 = await app.inject({ method: 'POST', url: '/api/runs/424242/stop', payload: {} });
    expect(r3.statusCode).toBe(404);
    await app.close();
  });
});
