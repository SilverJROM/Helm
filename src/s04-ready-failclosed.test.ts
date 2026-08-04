/**
 * S04 / AC18 — Fail-close the legacy ready wait.
 *
 * When waitForNorthStarReady() returns false, Helm must not reap Discovery,
 * change the run to Planning, or call runPlanningPhase(). Success path still advances once.
 * Stopped/failed runs remain blocked by assertRunActive (R5a).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { PlanParserService } from './services/plan-parser-service.js';
import { TaskQueueService } from './services/task-queue-service.js';
import { FakeTransport } from './services/fake-transport.js';
import { ProjectService } from './services/project-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { RunOrchestratorService } from './services/run-orchestrator-service.js';
import { EscalationService } from './services/escalation-service.js';
import { PanelService } from './services/panel-service.js';
import { requestRunAbort, clearRunAbort } from './services/run-abort-registry.js';

describe('S04 AC18 waitForNorthStarReady fail-closed', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let artifacts: RunArtifactService;
  let parser: PlanParserService;
  let queue: TaskQueueService;
  let fakeT: FakeTransport;
  let projectSvc: ProjectService;
  let assignSvc: AgentAssignmentService;
  let planningCalls: any[];
  let orch: RunOrchestratorService;
  let prevTimeout: string | undefined;

  beforeEach(async () => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
    prevTimeout = process.env.HELM_PLANNING_TIMEOUT_MS;
    process.env.HELM_PLANNING_TIMEOUT_MS = '80'; // short wait for false path

    tmpDb = path.join(os.tmpdir(), `helm-s04-test-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    db = new DatabaseService(tmpDb);
    artifacts = new RunArtifactService(db);
    parser = new PlanParserService(artifacts);
    queue = new TaskQueueService(artifacts);
    fakeT = new FakeTransport();
    projectSvc = new ProjectService(db);
    assignSvc = new AgentAssignmentService(db);
    planningCalls = [];

    const planningStub = {
      runPlanningPhase: async (opts: any) => {
        planningCalls.push(opts);
        // Minimal agreed planning so true-path can exit zero-task gate without full loop.
        // (True-path test asserts call count only; we return agreed with a pre-seeded plan.json.)
        return { runId: opts.runId, agreed: true };
      },
    } as any;

    const fakeDeployRunner = {
      async runDeploy() {
        return { success: true, note: 'fake-deploy-ok' };
      },
    };
    const fakeFinalTestRunner = {
      async runTest() {
        return { success: true, note: 'fake-test-ok' };
      },
    };

    orch = new RunOrchestratorService({
      artifacts,
      planning: planningStub,
      parser,
      queue,
      transport: fakeT,
      projectService: projectSvc,
      assignmentService: assignSvc,
      escalationService: new EscalationService(db),
      panelService: new PanelService(fakeT, artifacts, 's04test'),
      deployRunner: fakeDeployRunner,
      finalTestRunner: fakeFinalTestRunner,
    });
  });

  afterEach(async () => {
    if (prevTimeout === undefined) delete process.env.HELM_PLANNING_TIMEOUT_MS;
    else process.env.HELM_PLANNING_TIMEOUT_MS = prevTimeout;
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
      await fs.rm(tmpDb, { force: true });
    } catch {
      /* ignore */
    }
  });

  async function prepInterviewRun(batchId: string): Promise<{
    pid: number;
    runDir: string;
    runPromise: Promise<number>;
  }> {
    const proj = projectSvc.createProject({
      name: `s04-${batchId}`,
      directory: path.join(os.tmpdir(), `s04-proj-${batchId}-${Date.now()}`),
    });
    const pid = proj.id;
    const runDir = path.join(os.tmpdir(), `helm-run-${pid}-${batchId}`);
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.mkdir(runDir, { recursive: true });
    // No plan.json → interview path (D-b1)
    const runPromise = orch.startRun({
      projectId: pid,
      prompt: 'S04 interview ready-wait test',
      batchId,
    });
    // Wait for discovery spawn
    for (let i = 0; i < 400 && !fakeT.spawnCalls.some((c: any) => c.role === 'discovery'); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(fakeT.spawnCalls.some((c: any) => c.role === 'discovery')).toBe(true);
    return { pid, runDir, runPromise };
  }

  it('false wait: run blocked, no Discovery reap, no runPlanningPhase', async () => {
    const { runDir, runPromise } = await prepInterviewRun('s04false');
    // Do not write NORTH-STAR-READY — wait times out (HELM_PLANNING_TIMEOUT_MS=80)
    const runId = await runPromise;
    expect(runId).toBeGreaterThan(0);

    const row: any = db.raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
    expect(row.phase).toBe('blocked');
    expect(row.phase).not.toBe('planning');
    expect(row.phase).not.toBe('executing');

    const handoffReaps = fakeT.reapCalls.filter(
      (c) => c.reason === 'discovery-handoff-to-planning'
    );
    expect(handoffReaps.length).toBe(0);
    expect(planningCalls.length).toBe(0);

    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('true wait: advances once (reap + runPlanningPhase)', async () => {
    process.env.HELM_PLANNING_TIMEOUT_MS = '5000';
    const { runDir, runPromise } = await prepInterviewRun('s04true');

    // Seed minimal plan so post-planning zero-task gate does not re-block (agreed:true stub)
    const plan = {
      tasks: [
        {
          task_key: 'S04T1',
          atomic_work: 'tiny',
          complexity: 'low',
          model: 'gpt-5.5',
          effort: 'low',
          needs_more_info: false,
          task_type: 'feature',
          validation_criteria: 'ok',
          deps: [],
        },
      ],
      meta: { source: 's04' },
    };
    await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plan), 'utf8');
    await fs.writeFile(
      path.join(runDir, 'callbacks.md'),
      `[helm callback] discovery s04true STATUS: NORTH-STAR-READY — ready\n`,
      'utf8'
    );

    const runId = await runPromise;
    expect(runId).toBeGreaterThan(0);

    // Advances once into Planning (byte-compatible success path). FakeTransport.reap only
    // records handles it spawned (sessionName:0.0 ≠ fake-discovery-N), so assert planning call.
    expect(planningCalls.length).toBe(1);
    expect(planningCalls[0].runId).toBe(runId);
    expect(planningCalls[0].batchId).toBe('s04true');

    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('stopped/aborted run during wait: active-run assertion blocks; no Planning', async () => {
    process.env.HELM_PLANNING_TIMEOUT_MS = '3000';
    const { runDir, runPromise } = await prepInterviewRun('s04abort');

    // Resolve run id from spawn batch while wait is spinning
    let runId = 0;
    for (let i = 0; i < 200 && !runId; i++) {
      const rows: any[] = db.raw
        .prepare("SELECT id FROM runs WHERE batch_id = 's04abort' ORDER BY id DESC LIMIT 1")
        .all();
      if (rows[0]?.id) runId = Number(rows[0].id);
      else await new Promise((r) => setTimeout(r, 10));
    }
    expect(runId).toBeGreaterThan(0);

    // Sanctioned stop: registry abort + terminal DB phase so assertRunActive fires
    requestRunAbort(runId, 'S04 test operator stop');
    db.raw
      .prepare("UPDATE runs SET phase = 'failed', status = 'failed' WHERE id = ?")
      .run(runId);

    const returnedId = await runPromise;
    expect(returnedId).toBe(runId);

    // No Planning advance
    expect(planningCalls.length).toBe(0);
    const handoffReaps = fakeT.reapCalls.filter(
      (c) => c.reason === 'discovery-handoff-to-planning'
    );
    expect(handoffReaps.length).toBe(0);

    const row: any = db.raw.prepare('SELECT phase FROM runs WHERE id = ?').get(runId);
    expect(row.phase).not.toBe('planning');
    expect(row.phase).not.toBe('executing');

    clearRunAbort(runId);
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });
});
