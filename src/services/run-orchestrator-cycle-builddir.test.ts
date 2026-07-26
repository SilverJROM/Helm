// CYCLE-BUILDDIR regression coverage (sol review, rounds 1-3).
// A cycle-plan implementation run must build inside the cycle's OWN workspace
// (<project>/cycle/<slug>_<date>/), never the raw registered root — and it must FAIL CLOSED
// (never fall back to the root) when the workspace is unresolved, non-contained, missing, or the
// cycle is completed / unknown-status. These tests drive startRun({cyclePlan}) through startRunInner's
// resolution guard with an injected fake cycleService and assert BOTH build consumers directly:
//   - transport fence: the implementer's actual `projectDir` spawn arg == the cycle workspace;
//   - deterministic test-gate cwd: the REAL gate (FORCE_DETERMINISTIC_VAL_PATH=1) runs a cwd-sensitive
//     command that only passes in the workspace, so the task only completes when the gate ran there;
//   - fail-closed: unresolved / escaped / missing / completed / unknown-status all reject with ZERO spawns.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import { RunArtifactService } from './run-artifact-service.js';
import { PlanParserService } from './plan-parser-service.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { FakeTransport } from './fake-transport.js';
import { ProjectService } from './project-service.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { EscalationService } from './escalation-service.js';
import { PanelService } from './panel-service.js';
import { RunOrchestratorService } from './run-orchestrator-service.js';

describe('RunOrchestratorService — CYCLE-BUILDDIR fail-closed workspace resolution', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let artifacts: RunArtifactService;
  let projectSvc: ProjectService;
  let orch: RunOrchestratorService;
  let projRoot: string;
  let getCycleDocDir: (cycleId: number) => string;
  let fakeT: FakeTransport;

  beforeEach(async () => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
    // Keep the happy-path success run fast + terminal: skip the per-batch deploy gate and red-team panel.
    // Fail-closed tests throw before dispatch, so these are no-ops for them.
    process.env.HELM_SKIP_BATCH_DEPLOY = '1';
    process.env.HELM_SKIP_REDTEAM = '1';
    tmpDb = path.join(os.tmpdir(), `helm-cbd-${Date.now()}-${Math.floor(process.hrtime()[1])}.db`);
    db = new DatabaseService(tmpDb);
    artifacts = new RunArtifactService(db);
    const parser = new PlanParserService(artifacts);
    const queue = new TaskQueueService(artifacts);
    fakeT = new FakeTransport();
    projectSvc = new ProjectService(db);
    const planning = new PlanningPhaseService(fakeT, artifacts, queue);

    // A REAL registered project root (realpath of the root must resolve).
    projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-cbd-root-'));

    // Injectable cycle-workspace resolver (each test overrides getCycleDocDir).
    getCycleDocDir = () => path.join(projRoot, 'cycle', 'unset');
    orch = new RunOrchestratorService({
      artifacts,
      planning,
      parser,
      queue,
      transport: fakeT,
      projectService: projectSvc,
      assignmentService: new AgentAssignmentService(db),
      escalationService: new EscalationService(db),
      panelService: new PanelService(fakeT, artifacts, 'cbdtest'),
      cycleService: { getCycleDocDir: (id: number) => getCycleDocDir(id) },
    });
  });

  afterEach(async () => {
    for (const k of ['FORCE_DETERMINISTIC_VAL_PATH', 'HELM_PROJECT_TEST_CMD', 'HELM_PROJECT_TEST_ARGS', 'HELM_PROJECT_TEST_TIMEOUT_S']) {
      delete process.env[k];
    }
    try { db.close(); } catch { /* noop */ }
    try { await fs.rm(tmpDb, { force: true }); } catch { /* noop */ }
    try { await fs.rm(projRoot, { recursive: true, force: true }); } catch { /* noop */ }
  });

  // Insert a cycles row and return its id.
  function makeCycle(projectId: number, status: 'pending' | 'active' | 'completed', folder = 'c_0718'): number {
    const info = (db as any).raw.prepare(
      `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
       VALUES (?, ?, ?, 'implementation', 'pause_after_planning', ?)`
    ).run(projectId, `cyc-${folder}`, folder, status);
    return Number(info.lastInsertRowid);
  }

  async function startCycleRun(projectId: number, cycleId: number, batchId: string) {
    const runDir = path.join(os.tmpdir(), `helm-run-${projectId}-${batchId}`);
    await fs.mkdir(runDir, { recursive: true });
    const precreatedRunId = artifacts.createRun(projectId, batchId, path.join(runDir, 'north-star.md'), cycleId);
    return { runDir, precreatedRunId, promise: orch.startRun({ projectId, batchId, cyclePlan: true, cycleId, precreatedRunId, prompt: 'cycle build' }) };
  }

  it('SUCCESS: implementer transport is fenced to the workspace AND the real deterministic gate runs in the workspace (cwd-sensitive; fails if the shadow is removed)', async () => {
    // Force the REAL deterministic test-gate (not the fake agent-validator) and make it CWD-SENSITIVE:
    // `test -f gate-marker` passes ONLY when it runs in the workspace (the marker lives there, not the root).
    process.env.FORCE_DETERMINISTIC_VAL_PATH = '1';
    process.env.HELM_PROJECT_TEST_CMD = 'test';
    process.env.HELM_PROJECT_TEST_ARGS = '-f gate-marker';
    process.env.HELM_PROJECT_TEST_TIMEOUT_S = '10';

    const proj = projectSvc.createProject({ name: 'cbd-dispatch', directory: projRoot });
    const cycleId = makeCycle(proj.id, 'active', 'disp_0718');
    const ws = path.join(projRoot, 'cycle', 'disp_0718');
    const buildDir = path.join(ws, 'repo'); // build subdir (escapes PROTECTED-ROOT at the workspace root)
    await fs.mkdir(buildDir, { recursive: true });
    await fs.writeFile(path.join(ws, 'north-star.md'), '# north star', 'utf8'); // present at workspace root (real cycle)
    await fs.writeFile(path.join(ws, 'og-requirements.md'), '- **S6-REQ** — The implementation brief receives canonical acceptance text.\n', 'utf8');
    await fs.mkdir(path.join(ws, 'decisions'), { recursive: true });
    await fs.writeFile(path.join(ws, 'decisions', 'canonical.md'), '# Canonical decision\n', 'utf8');
    await fs.writeFile(path.join(buildDir, 'gate-marker'), 'x', 'utf8'); // marker lives in the BUILD dir only
    // A valid execution plan lives at the WORKSPACE root (proves ingest reads from the workspace, not buildDir).
    const planMd = '# plan\n```json\n[{"id":"T1","batch":"B1","title":"scaffold","req_refs":["S6-REQ"],"assignee":"grok-4.5","validator_lane":"L1","effort":"low","type":"feature","deps":[]}]\n```\n';
    await fs.writeFile(path.join(ws, 'plan.md'), planMd, 'utf8');
    getCycleDocDir = () => ws;

    const batchId = 'cbddisp';
    const runDir = path.join(os.tmpdir(), `helm-run-${proj.id}-${batchId}`);
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.mkdir(runDir, { recursive: true });
    // implementer DONE lets the loop reach the deterministic gate; the GATE (not an agent) decides PASS.
    await fs.writeFile(path.join(runDir, 'callbacks.md'),
      `\n[helm callback] implementer ${batchId} STATUS: DONE — scaffolded\n[helm callback] validator ${batchId} STATUS: PASS — verified\n`, 'utf8');
    await fs.writeFile(path.join(runDir, 'north-star.md'), '# stale run snapshot', 'utf8');
    await fs.mkdir(path.join(runDir, 'decisions'), { recursive: true });
    await fs.writeFile(path.join(runDir, 'decisions', 'stale.md'), '# stale', 'utf8');
    const precreatedRunId = artifacts.createRun(proj.id, batchId, path.join(runDir, 'north-star.md'), cycleId);

    const runId = await orch.startRun({ projectId: proj.id, batchId, cyclePlan: true, cycleId, precreatedRunId, prompt: 'cycle build' });

    // (a) TRANSPORT FENCE: the implementer's actual projectDir spawn arg is the build subdir (ws/repo),
    // NOT the registered root and NOT the workspace root (which would be PROTECTED-ROOT / EPERM on scaffold).
    const implSpawn = fakeT.spawnCalls.find((s) => s.role === 'implementer');
    expect(implSpawn, 'implementer must be dispatched for a valid cycle-plan run').toBeTruthy();
    expect(implSpawn!.projectDir).toBe(buildDir);
    expect(implSpawn!.brief).toContain('- **S6-REQ** — The implementation brief receives canonical acceptance text.');
    expect(await fs.readFile(path.join(runDir, 'north-star.md'), 'utf8')).toBe('# north star');
    expect(await fs.readFile(path.join(runDir, 'og-requirements.md'), 'utf8')).toContain('canonical acceptance text');
    expect(await fs.readFile(path.join(runDir, 'plan.md'), 'utf8')).toBe(planMd);
    expect(await fs.readFile(path.join(runDir, 'decisions', 'canonical.md'), 'utf8')).toContain('Canonical decision');
    await expect(fs.access(path.join(runDir, 'decisions', 'stale.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.access(path.join(runDir, 'north_star.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    // (b) DETERMINISTIC GATE CWD: the task only reaches 'complete' if `test -f gate-marker` passed, which
    // requires the gate to have EXECUTED in the workspace (marker only there). Remove the shadow → the gate
    // runs in the root → fails → the task never completes. This observes the exact live-broken consumer.
    const taskRow: any = (db as any).raw.prepare("SELECT status FROM run_tasks WHERE run_id=? ORDER BY id LIMIT 1").get(runId);
    expect(taskRow?.status).toBe('complete');
  });

  it('FAIL-CLOSED: getCycleDocDir throws → refuse with zero spawns, never fall back to the registered root', async () => {
    const proj = projectSvc.createProject({ name: 'cbd-throw', directory: projRoot });
    const cycleId = makeCycle(proj.id, 'active', 'throw_0718');
    getCycleDocDir = () => { throw new Error('unknown cycle'); };

    const { runDir, precreatedRunId, promise } = await startCycleRun(proj.id, cycleId, 'cbdthrow');
    await expect(promise).rejects.toThrow(/cycle-plan run refused/);
    expect(fakeT.spawnCalls.length).toBe(0);
    const row: any = (db as any).raw.prepare('SELECT phase, status FROM runs WHERE id=?').get(precreatedRunId);
    expect(row.status).toBe('failed');
    const reason = await fs.readFile(path.join(runDir, 'cycle-workspace-invalid.md'), 'utf8');
    expect(reason).toMatch(/no fallback to the registered project root/i);
  });

  it('FAIL-CLOSED: workspace outside the registered root (symlink/traversal escape) → refuse with zero spawns', async () => {
    const proj = projectSvc.createProject({ name: 'cbd-escape', directory: projRoot });
    const cycleId = makeCycle(proj.id, 'active', 'escape_0718');
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-cbd-outside-'));
    getCycleDocDir = () => outside; // exists + is a dir, but NOT under projRoot
    try {
      const { promise } = await startCycleRun(proj.id, cycleId, 'cbdescape');
      await expect(promise).rejects.toThrow(/not a strict descendant/);
      expect(fakeT.spawnCalls.length).toBe(0);
    } finally {
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  it('FAIL-CLOSED: completed cycle → refuse with zero spawns (archive must not be reopened as a writable build)', async () => {
    const proj = projectSvc.createProject({ name: 'cbd-done', directory: projRoot });
    const cycleId = makeCycle(proj.id, 'completed', 'done_0718');
    const ws = path.join(projRoot, 'cycle', 'completed', 'done_0718');
    await fs.mkdir(ws, { recursive: true });
    getCycleDocDir = () => ws;

    const { promise } = await startCycleRun(proj.id, cycleId, 'cbddone');
    await expect(promise).rejects.toThrow(/is completed/);
    expect(fakeT.spawnCalls.length).toBe(0);
  });

  it('FAIL-CLOSED: unknown cycle status (no cycles row) → refuse with zero spawns', async () => {
    const proj = projectSvc.createProject({ name: 'cbd-norow', directory: projRoot });
    const ghostCycleId = 987654; // no cycles row exists → status cannot be established
    getCycleDocDir = () => path.join(projRoot, 'cycle', 'ghost_0718');
    const batchId = 'cbdnorow';
    const runDir = path.join(os.tmpdir(), `helm-run-${proj.id}-${batchId}`);
    await fs.mkdir(runDir, { recursive: true });
    // Create the run with a NULL cycle FK (avoids the cycles FK on the ghost id); the resolution guard
    // still queries input.cycleId's status directly → no row → fail closed.
    const precreatedRunId = artifacts.createRun(proj.id, batchId, path.join(runDir, 'north-star.md'), null);
    await expect(
      orch.startRun({ projectId: proj.id, batchId, cyclePlan: true, cycleId: ghostCycleId, precreatedRunId, prompt: 'cycle build' })
    ).rejects.toThrow(/cannot establish status/);
    expect(fakeT.spawnCalls.length).toBe(0);
  });

  it('FAIL-CLOSED: resolved workspace does not exist on disk → refuse with zero spawns', async () => {
    const proj = projectSvc.createProject({ name: 'cbd-missing', directory: projRoot });
    const cycleId = makeCycle(proj.id, 'active', 'missing_0718');
    getCycleDocDir = () => path.join(projRoot, 'cycle', 'never_created_0718');

    const { promise } = await startCycleRun(proj.id, cycleId, 'cbdmissing');
    await expect(promise).rejects.toThrow(/does not exist|does not resolve/);
    expect(fakeT.spawnCalls.length).toBe(0);
  });
});
