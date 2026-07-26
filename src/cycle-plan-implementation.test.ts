import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { CycleDocsService } from './services/cycle-docs-service.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { PlanParserService } from './services/plan-parser-service.js';
import { PlanningPhaseService } from './services/planning-phase-service.js';
import { TaskQueueService } from './services/task-queue-service.js';
import { FakeTransport } from './services/fake-transport.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { EscalationService } from './services/escalation-service.js';
import { PanelService } from './services/panel-service.js';
import { RunOrchestratorService } from './services/run-orchestrator-service.js';
import { maybeAutoStartCycleImplementation } from './services/cycle-auto-start.js';
import { createRequireOwner } from './auth/auth-middleware.js';

// IS-R1..IS-R5 (impl-start): a cycle with an authored plan.md starts an IMPLEMENTATION-ONLY
// run that INGESTS the cycle's own plan (no re-interview/re-plan), linked via runs.cycle_id. Plus the
// manual endpoint guards (400 no plan / 409 dup) and the autonomous server-side auto-start (IS-R3).

function validPlanMd(id = 'T1'): string {
  const tasks = [{ id, batch: 'one', title: `implement ${id}`, req_refs: ['IS-R1'], assignee: 'grok-4.5', validator_lane: 'L1', effort: 'low', type: 'feature' }];
  return '# Execution Plan\n\n```json\n' + JSON.stringify(tasks) + '\n```\n';
}
function seedCompletingCallbacks(runDir: string, batch: string): void {
  fs.mkdirSync(runDir, { recursive: true });
  fs.writeFileSync(path.join(runDir, 'callbacks.md'),
    `[helm callback] implementer ${batch} STATUS: DONE — wired\n` +
    `[helm callback] validator ${batch} STATUS: PASS — verified\n` +
    `[helm callback] panelist ${batch} STATUS: VERDICT-READY — CLEAN: all gates pass (seat cp:0)\n` +
    `[helm callback] panelist ${batch} STATUS: VERDICT-READY — CLEAN: regressions hold (seat cp:1)\n`, 'utf8');
}

function ownerAuth(req: any, _reply: any, done?: () => void) { req.user = { role: 'owner' }; done?.(); }

describe.sequential('cycle-plan implementation-only run (IS-R1..IS-R5)', () => {
  let db: DatabaseService;
  let tmpDir: string;
  let projectDir: string;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let cycleDocsService: CycleDocsService;
  let artifacts: RunArtifactService;
  let parser: PlanParserService;
  let queue: TaskQueueService;
  let fakeT: FakeTransport;
  let orch: RunOrchestratorService;
  let projectId: number;
  let cycleId: number;

  beforeEach(async () => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-cycleplan-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-cycleplan-proj-'));
    db = new DatabaseService(path.join(tmpDir, 'test.db'));
    projectService = new ProjectService(db);
    cycleService = new CycleService(db, projectService);
    cycleDocsService = new CycleDocsService(cycleService);
    artifacts = new RunArtifactService(db);
    parser = new PlanParserService(artifacts);
    queue = new TaskQueueService(artifacts);
    fakeT = new FakeTransport();
    const assignSvc = new AgentAssignmentService(db);
    const planning = new PlanningPhaseService(fakeT, artifacts, queue);
    const esc = new EscalationService(db);
    const panelSvc = new PanelService(fakeT, artifacts, 'cptest');
    orch = new RunOrchestratorService({
      artifacts, planning, parser, queue, transport: fakeT,
      projectService, assignmentService: assignSvc,
      escalationService: esc, panelService: panelSvc,
      deployRunner: { async runDeploy() { return { success: true, note: 'fake' }; } },
      finalTestRunner: { async runTest() { return { success: true, note: 'fake' }; } },
      cycleService,
    });
    const proj = projectService.createProject({ name: 'cards', directory: projectDir });
    projectId = proj.id;
    const c = await cycleService.createCycle(projectId, 'Impl Cycle');
    cycleId = c.id;
    // Focus on ingest+loop, not the final-tests gate: disable so no runner/config discovery is needed.
    db.raw.prepare('UPDATE cycles SET final_tests_enabled = 0 WHERE id = ?').run(cycleId);
  });
  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  it('IS-R1: ingests cycle plan.md and runs implementation-only without discovery/plancore spawns, linked via runs.cycle_id', async () => {
    await fsp.writeFile(path.join(cycleService.getCycleDocDir(cycleId), 'plan.md'), validPlanMd('T1'), 'utf8');
    const batch = 'cycleplan1';
    seedCompletingCallbacks(path.join(os.tmpdir(), `helm-run-${projectId}-${batch}`), batch);

    const runId = await orch.startRun({ projectId, cycleId, cyclePlan: true, prompt: `implement cycle ${cycleId} from plan.md`, batchId: batch });
    expect(runId).toBeGreaterThan(0);

    // cycle_id linkage held (Impl tab reviewability).
    const runRow: any = db.raw.prepare('SELECT cycle_id, phase FROM runs WHERE id = ?').get(runId);
    expect(Number(runRow.cycle_id)).toBe(cycleId);

    // Plan ingested → run_tasks populated from the CYCLE's plan.md.
    const tasks = db.raw.prepare('SELECT task_key FROM run_tasks WHERE run_id = ?').all(runId) as any[];
    expect(tasks.length).toBe(1);
    expect(tasks[0].task_key).toBe('T1');

    const phasePlanningSpawns = fakeT.spawnCalls.filter((c: any) => ['discovery', 'plancore'].includes(c.role));
    expect(phasePlanningSpawns.length).toBe(0);
    // But the implementation loop DID run (implementer spawned).
    const implSpawns = fakeT.spawnCalls.filter((c: any) => c.role === 'implementer');
    expect(implSpawns.length).toBeGreaterThanOrEqual(1);
  }, 20000);

  it('IS-R1: a cycle with NO plan.md throws "author a valid plan.md first"', async () => {
    await expect(orch.startRun({ projectId, cycleId, cyclePlan: true, prompt: 'x', batchId: 'noplan1' }))
      .rejects.toThrow(/author a valid plan.md first/);
  });

  it('IS-R1: a cycle with an INVALID plan.md throws (implementation refuses to start)', async () => {
    await fsp.writeFile(path.join(cycleService.getCycleDocDir(cycleId), 'plan.md'), '# not a real plan, no json fence\n', 'utf8');
    await expect(orch.startRun({ projectId, cycleId, cyclePlan: true, prompt: 'x', batchId: 'badplan1' }))
      .rejects.toThrow(/author a valid plan.md first/);
  });

  // ---- Endpoint (faithful mirror of the real POST /api/cycles/:id/start-implementation over the
  // ---- REAL services: dup-guard 409, no-plan 400, and a real cycle-plan ingest on 200). ----
  function mountEndpoint() {
    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    app.post('/api/cycles/:id/start-implementation', { preHandler: [ownerAuth, requireOwnerPre] }, async (request: any, reply: any) => {
      const cid = Number(request.params.id);
      const cycle: any = db.prepare('SELECT id, project_id, phase FROM cycles WHERE id = ?').get(cid);
      if (!cycle) return reply.code(404).send({ error: 'unknown cycle' });
      const pid = Number(cycle.project_id);
      if (!projectService.getProject(pid)) return reply.code(404).send({ error: 'unknown project' });
      const body = request.body || {};
      const seedPlan = typeof body.seedPlan === 'string' && body.seedPlan.trim() ? body.seedPlan.trim() : undefined;
      try {
        const rs = artifacts.getCycleRunState(cid);
        if (rs.hasRun && rs.runActive) return reply.code(409).send({ error: 'implementation already running for this cycle' });
      } catch { /* fall through */ }
      let cyclePlan = false;
      let prompt: string;
      if (seedPlan) {
        prompt = (body.prompt || `[plan-cache replay: ${seedPlan}]`).trim();
      } else {
        let planValid = false;
        try { const doc = await cycleDocsService.readCycleDoc(cid, 'plan.md'); planValid = doc.valid === true; } catch { planValid = false; }
        if (!planValid) return reply.code(400).send({ error: 'author a valid plan.md first' });
        cyclePlan = true;
        prompt = (body.prompt || `implement cycle ${cid} from plan.md`).trim();
      }
      if (!prompt) return reply.code(400).send({ error: 'prompt required' });
      const { runId, batchId } = orch.startRunDetached({ projectId: pid, cycleId: cid, prompt, roleBindings: body.roleBindings, batchId: body.batchId, seedPlan, cyclePlan });
      try { cycleService.setCyclePhase(cid, 'implementation'); } catch { /* cosmetic */ }
      return { runId, batchId, cycleId: cid, status: 'started' };
    });
    return app;
  }

  it('IS-R2/R5 endpoint: with a valid plan → 200, cycle-linked run created (runs.cycle_id) + run_tasks ingested', async () => {
    await fsp.writeFile(path.join(cycleService.getCycleDocDir(cycleId), 'plan.md'), validPlanMd('T1'), 'utf8');
    const batch = 'endpoint200';
    seedCompletingCallbacks(path.join(os.tmpdir(), `helm-run-${projectId}-${batch}`), batch);
    const app = mountEndpoint();
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-implementation`, remoteAddress: '127.0.0.1', payload: { batchId: batch } });
      expect(res.statusCode).toBe(200);
      const bodyJson = res.json();
      expect(bodyJson.status).toBe('started');
      expect(bodyJson.cycleId).toBe(cycleId);
      const linked: any = db.raw.prepare('SELECT cycle_id FROM runs WHERE id = ?').get(bodyJson.runId);
      expect(Number(linked.cycle_id)).toBe(cycleId);
      // Background detached run ingests the plan → poll for run_tasks.
      let taskCount = 0;
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        taskCount = (db.raw.prepare('SELECT COUNT(*) AS c FROM run_tasks WHERE run_id = ?').get(bodyJson.runId) as any).c;
        if (taskCount > 0) break;
        await new Promise(r => setTimeout(r, 50));
      }
      expect(taskCount).toBe(1);
    } finally { await app.close(); }
  }, 20000);

  it('IS-R2/R5 endpoint: no plan.md → 400 "author a valid plan.md first" (no run started)', async () => {
    const app = mountEndpoint();
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-implementation`, remoteAddress: '127.0.0.1', payload: {} });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/plan\.md first/);
      const runs = db.raw.prepare('SELECT COUNT(*) AS c FROM runs WHERE cycle_id = ?').get(cycleId) as any;
      expect(runs.c).toBe(0);
    } finally { await app.close(); }
  });

  it('IS-R4/R5 endpoint: duplicate call while a non-terminal run exists → 409 (no second run)', async () => {
    await fsp.writeFile(path.join(cycleService.getCycleDocDir(cycleId), 'plan.md'), validPlanMd('T1'), 'utf8');
    // Pre-existing non-terminal run linked to the cycle (phase 'executing').
    const existingRun = artifacts.createRun(projectId, 'preexisting', null, cycleId);
    db.raw.prepare("UPDATE runs SET phase = 'executing', status = 'active' WHERE id = ?").run(existingRun);
    const app = mountEndpoint();
    await app.ready();
    try {
      const res = await app.inject({ method: 'POST', url: `/api/cycles/${cycleId}/start-implementation`, remoteAddress: '127.0.0.1', payload: {} });
      expect(res.statusCode).toBe(409);
      const runs = db.raw.prepare('SELECT COUNT(*) AS c FROM runs WHERE cycle_id = ?').get(cycleId) as any;
      expect(runs.c).toBe(1); // still just the pre-existing one
    } finally { await app.close(); }
  });
});

// ---- IS-R3: autonomous server-side auto-start on a valid plan.md save. ----
describe.sequential('autonomous auto-start on plan save (IS-R3)', () => {
  let db: DatabaseService;
  let tmpDir: string;
  let projectDir: string;
  let projectService: ProjectService;
  let cycleService: CycleService;
  let artifacts: RunArtifactService;
  let projectId: number;
  let calls: Array<{ cycleId: number | null | undefined; cyclePlan: boolean | undefined; prompt: string }>;

  // Spy orchestrator that performs the real synchronous side effect (createRun with cycle_id) so
  // getCycleRunState reflects an active run — exactly what guards the idempotent re-save.
  const spyOrchestrator = {
    startRunDetached(input: any) {
      calls.push({ cycleId: input.cycleId, cyclePlan: input.cyclePlan, prompt: input.prompt });
      const runId = artifacts.createRun(input.projectId, `auto-${calls.length}`, null, input.cycleId ?? null);
      db.raw.prepare("UPDATE runs SET phase = 'executing', status = 'active' WHERE id = ?").run(runId);
      return { runId, batchId: `auto-${calls.length}` };
    }
  };

  async function makeCycle(autonomy: string): Promise<number> {
    const c = await cycleService.createCycle(projectId, `Cycle ${autonomy} ${Math.random().toString(36).slice(2, 7)}`, autonomy);
    const cid = c.id;
    await fsp.writeFile(path.join(cycleService.getCycleDocDir(cid), 'plan.md'),
      '# Execution Plan\n\n```json\n' + JSON.stringify([{ id: 'T1', batch: 'one', title: 'auto task', req_refs: ['IS-R3'], assignee: 'grok-4.5', validator_lane: 'L1', effort: 'low', type: 'feature' }]) + '\n```\n', 'utf8');
    return cid;
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-autostart-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-autostart-proj-'));
    db = new DatabaseService(path.join(tmpDir, 'test.db'));
    projectService = new ProjectService(db);
    cycleService = new CycleService(db, projectService);
    artifacts = new RunArtifactService(db);
    calls = [];
    const proj = projectService.createProject({ name: 'cards', directory: projectDir });
    projectId = proj.id;
  });
  afterEach(() => {
    try { db.close(); } catch {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  it('autonomous_after_discovery cycle with a valid plan → auto-starts a cycle-plan run exactly once', async () => {
    const cid = await makeCycle('autonomous_after_discovery');
    const r = await maybeAutoStartCycleImplementation({ db, cycleService, runArtifacts: artifacts, orchestrator: spyOrchestrator }, cid);
    expect(r.started).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].cycleId).toBe(cid);
    expect(calls[0].cyclePlan).toBe(true);
  });

  it('re-save does NOT double-fire: second call while the run is active is a no-op', async () => {
    const cid = await makeCycle('autonomous_after_discovery');
    const r1 = await maybeAutoStartCycleImplementation({ db, cycleService, runArtifacts: artifacts, orchestrator: spyOrchestrator }, cid);
    expect(r1.started).toBe(true);
    const r2 = await maybeAutoStartCycleImplementation({ db, cycleService, runArtifacts: artifacts, orchestrator: spyOrchestrator }, cid);
    expect(r2.started).toBe(false);
    expect(r2.reason).toMatch(/already active/);
    expect(calls).toHaveLength(1); // exactly one run started total
  });

  it('pause_after_planning cycle does NOT auto-start (manual button + Approve gate only)', async () => {
    const cid = await makeCycle('pause_after_planning');
    const r = await maybeAutoStartCycleImplementation({ db, cycleService, runArtifacts: artifacts, orchestrator: spyOrchestrator }, cid);
    expect(r.started).toBe(false);
    expect(r.reason).toMatch(/not autonomous/);
    expect(calls).toHaveLength(0);
  });
});
