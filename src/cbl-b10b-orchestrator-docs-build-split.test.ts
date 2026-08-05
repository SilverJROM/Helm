/**
 * cycle-branch-lifecycle B10b — orchestrator docs vs build split (R4.1, R4.4).
 *
 * canonicalArtifactRoot stays getCycleDocDir; effectiveProjectDir comes from the PERSISTED
 * worktree identity (revalidated: canonical under project root + in `git worktree list`).
 * R4 cycles never fall back to <docs>/repo. Stale/mismatch fails closed with a reason artifact.
 * Legacy null-identity keeps the old <docs>/repo path + visible overview marker, with zero
 * repair/infer git commands.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { PlanParserService } from './services/plan-parser-service.js';
import { PlanningPhaseService } from './services/planning-phase-service.js';
import { TaskQueueService } from './services/task-queue-service.js';
import { FakeTransport } from './services/fake-transport.js';
import { ProjectService } from './services/project-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { EscalationService } from './services/escalation-service.js';
import { PanelService } from './services/panel-service.js';
import { RunOrchestratorService } from './services/run-orchestrator-service.js';
import { CycleService } from './services/cycle-service.js';
import { GitWorktreeService } from './services/git-worktree-service.js';
import { resolveRunDir } from './services/run-paths.js';
import {
  PlanningProvenanceService,
  sha256Hex,
} from './services/planning-provenance-service.js';
import { PlanningStaffingService } from './services/planning-staffing-service.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fsSync.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b10b-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B10b Test']);
  fsSync.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

function seedProvenance(
  dbs: DatabaseService,
  projectId: number,
  cycleId: number,
  planMd: string,
  artifactsSvc: RunArtifactService,
  assignmentsSvc: AgentAssignmentService
) {
  const runId = artifactsSvc.createRun(projectId, `prov-${cycleId}-${Date.now()}`, null, cycleId);
  dbs.raw
    .prepare("UPDATE runs SET phase = 'complete', status = 'complete' WHERE id = ?")
    .run(runId);
  let digest = 'test-manifest-digest-' + cycleId;
  try {
    digest = new PlanningStaffingService(dbs, assignmentsSvc).resolveManifest(projectId, {
      throwOnEmpty: false,
      throwOnMismatch: false,
    }).digest;
  } catch {
    /* keep fallback */
  }
  new PlanningProvenanceService(dbs).recordSuccess({
    projectId,
    cycleId,
    planningRunId: runId,
    manifestDigest: digest,
    planSha256: sha256Hex(planMd),
  });
}

describe('B10b orchestrator docs vs build split (R4.1, R4.4)', () => {
  let db: DatabaseService;
  let tmpDb: string;
  let artifacts: RunArtifactService;
  let projectSvc: ProjectService;
  let orch: RunOrchestratorService;
  let fakeT: FakeTransport;
  let assignSvc: AgentAssignmentService;
  let getCycleDocDir: (cycleId: number) => string;
  let verifyCalls: Array<{ projectDir: string; identity: { worktreePath: string; branch: string } }>;
  let verifyImpl: (projectDir: string, identity: { worktreePath: string; branch: string }) => Promise<string>;
  const cleanups: Array<() => void | Promise<void>> = [];

  beforeEach(async () => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
    process.env.HELM_SKIP_BATCH_DEPLOY = '1';
    process.env.HELM_SKIP_REDTEAM = '1';
    tmpDb = path.join(os.tmpdir(), `helm-b10b-${Date.now()}-${Math.floor(process.hrtime()[1])}.db`);
    db = new DatabaseService(tmpDb);
    artifacts = new RunArtifactService(db);
    const parser = new PlanParserService(artifacts);
    const queue = new TaskQueueService(artifacts);
    fakeT = new FakeTransport();
    projectSvc = new ProjectService(db);
    assignSvc = new AgentAssignmentService(db);
    const planning = new PlanningPhaseService(fakeT, artifacts, queue);

    getCycleDocDir = () => path.join(os.tmpdir(), 'unset');
    verifyCalls = [];
    verifyImpl = async (projectDir, identity) => {
      verifyCalls.push({ projectDir, identity });
      return await fs.realpath(identity.worktreePath);
    };

    orch = new RunOrchestratorService({
      artifacts,
      planning,
      parser,
      queue,
      transport: fakeT,
      projectService: projectSvc,
      assignmentService: assignSvc,
      escalationService: new EscalationService(db),
      panelService: new PanelService(fakeT, artifacts, 'b10btest'),
      cycleService: { getCycleDocDir: (id: number) => getCycleDocDir(id) },
      gitWorktreeService: {
        verifyPersistedWorktree: async (projectDir, identity) => verifyImpl(projectDir, identity),
      },
    });
  });

  afterEach(async () => {
    while (cleanups.length) {
      await cleanups.pop()!();
    }
    for (const k of ['FORCE_DETERMINISTIC_VAL_PATH', 'HELM_PROJECT_TEST_CMD', 'HELM_PROJECT_TEST_ARGS', 'HELM_PROJECT_TEST_TIMEOUT_S']) {
      delete process.env[k];
    }
    try { db.close(); } catch { /* noop */ }
    try { await fs.rm(tmpDb, { force: true }); } catch { /* noop */ }
  });

  function makeCycle(
    projectId: number,
    opts: {
      status?: 'pending' | 'active' | 'completed';
      folder?: string;
      git_branch?: string | null;
      git_worktree_path?: string | null;
      git_worktree_id?: string | null;
    } = {}
  ): number {
    const folder = opts.folder ?? 'c_b10b';
    const status = opts.status ?? 'active';
    const info = (db as any).raw.prepare(
      `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status,
                           git_branch, git_worktree_path, git_worktree_id)
       VALUES (?, ?, ?, 'implementation', 'pause_after_planning', ?, ?, ?, ?)`
    ).run(
      projectId,
      `cyc-${folder}`,
      folder,
      status,
      opts.git_branch ?? null,
      opts.git_worktree_path ?? null,
      opts.git_worktree_id ?? null
    );
    return Number(info.lastInsertRowid);
  }

  async function seedCycleWorkspace(ws: string, planId = 'T1') {
    await fs.mkdir(ws, { recursive: true });
    await fs.writeFile(path.join(ws, 'north-star.md'), '# north star', 'utf8');
    await fs.writeFile(
      path.join(ws, 'og-requirements.md'),
      '- **S6-REQ** — The implementation brief receives canonical acceptance text.\n',
      'utf8'
    );
    await fs.mkdir(path.join(ws, 'decisions'), { recursive: true });
    await fs.writeFile(path.join(ws, 'decisions', 'canonical.md'), '# Canonical decision\n', 'utf8');
    const planMd =
      `# plan\n\`\`\`json\n[{"id":"${planId}","batch":"B1","title":"scaffold","req_refs":["S6-REQ"],"assignee":"grok-4.5","validator_lane":"L1","effort":"low","type":"feature","deps":[]}]\n\`\`\`\n`;
    await fs.writeFile(path.join(ws, 'plan.md'), planMd, 'utf8');
    return planMd;
  }

  async function prepRunDir(projectId: number, batchId: string) {
    const runDir = resolveRunDir(projectId, batchId);
    await fs.rm(runDir, { recursive: true, force: true });
    await fs.mkdir(runDir, { recursive: true });
    cleanups.push(() => fs.rm(runDir, { recursive: true, force: true }));
    return runDir;
  }

  it('worktree-backed cycle: docs root ≠ build root; implementer fenced to revalidated worktree', async () => {
    process.env.FORCE_DETERMINISTIC_VAL_PATH = '1';
    process.env.HELM_PROJECT_TEST_CMD = 'test';
    process.env.HELM_PROJECT_TEST_ARGS = '-f gate-marker';
    process.env.HELM_PROJECT_TEST_TIMEOUT_S = '10';

    // Real git repo + worktree so makeCycleGitAllowEnv (B9) accepts the threaded identity.
    const projRoot = await initRepo('helm-b10b-wt-root-');
    cleanups.push(() => fs.rm(projRoot, { recursive: true, force: true }));
    const gws = new GitWorktreeService(db);
    const proj = projectSvc.createProject({ name: 'b10b-wt', directory: projRoot });
    const cycleId = makeCycle(proj.id, { folder: 'wt_b10b' });
    const identity = await gws.createCycleWorktree({
      projectDir: projRoot,
      cycleId,
      slug: 'feature',
      baseRef: 'main',
    });
    // createCycleWorktree already UPDATEs the cycles row with git_* columns.

    const ws = path.join(projRoot, 'cycle', 'wt_b10b');
    const planMd = await seedCycleWorkspace(ws);
    await fs.writeFile(path.join(identity.worktreePath, 'gate-marker'), 'x', 'utf8');
    getCycleDocDir = () => ws;
    seedProvenance(db, proj.id, cycleId, planMd, artifacts, assignSvc);

    // Use the REAL verifier (membership + containment), not the fake.
    orch = new RunOrchestratorService({
      artifacts,
      planning: new PlanningPhaseService(fakeT, artifacts, new TaskQueueService(artifacts)),
      parser: new PlanParserService(artifacts),
      queue: new TaskQueueService(artifacts),
      transport: fakeT,
      projectService: projectSvc,
      assignmentService: assignSvc,
      escalationService: new EscalationService(db),
      panelService: new PanelService(fakeT, artifacts, 'b10btest'),
      cycleService: { getCycleDocDir: (id: number) => getCycleDocDir(id) },
      gitWorktreeService: gws,
    });

    const batchId = 'b10bwt';
    const runDir = await prepRunDir(proj.id, batchId);
    await fs.writeFile(
      path.join(runDir, 'callbacks.md'),
      `\n[helm callback] implementer ${batchId} STATUS: DONE — scaffolded\n[helm callback] validator ${batchId} STATUS: PASS — verified\n`,
      'utf8'
    );
    await fs.writeFile(path.join(runDir, 'north-star.md'), '# stale', 'utf8');
    const precreatedRunId = artifacts.createRun(proj.id, batchId, path.join(runDir, 'north-star.md'), cycleId);

    const runId = await orch.startRun({
      projectId: proj.id,
      batchId,
      cyclePlan: true,
      cycleId,
      precreatedRunId,
      prompt: 'cycle build',
    });

    const implSpawn = fakeT.spawnCalls.find((s) => s.role === 'implementer');
    expect(implSpawn, 'implementer must be dispatched').toBeTruthy();
    const canonWt = await fs.realpath(identity.worktreePath);
    const canonWs = await fs.realpath(ws);
    expect(implSpawn!.projectDir).toBe(canonWt);
    expect(implSpawn!.projectDir).not.toBe(canonWs);
    expect(implSpawn!.projectDir).not.toBe(path.join(canonWs, 'repo'));
    // Docs still materialize from the cycle docs root (not the worktree).
    expect(await fs.readFile(path.join(runDir, 'north-star.md'), 'utf8')).toBe('# north star');
    expect(await fs.readFile(path.join(runDir, 'plan.md'), 'utf8')).toContain('scaffold');

    const taskRow: any = (db as any).raw
      .prepare('SELECT status FROM run_tasks WHERE run_id=? ORDER BY id LIMIT 1')
      .get(runId);
    expect(taskRow?.status).toBe('complete');
  });

  it('mismatched/stale identity refuses fail-closed with reason artifact and zero spawns', async () => {
    const projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b10b-stale-root-'));
    cleanups.push(() => fs.rm(projRoot, { recursive: true, force: true }));
    const ws = path.join(projRoot, 'cycle', 'stale_b10b');
    await seedCycleWorkspace(ws);
    const ghostWt = path.join(projRoot, 'cycle', '.worktrees', 'gone');

    verifyImpl = async () => {
      throw new Error(`persisted worktree not found in 'git worktree list --porcelain': ${ghostWt}`);
    };

    const proj = projectSvc.createProject({ name: 'b10b-stale', directory: projRoot });
    const cycleId = makeCycle(proj.id, {
      folder: 'stale_b10b',
      git_branch: 'helm/cycle/1/stale',
      git_worktree_path: ghostWt,
      git_worktree_id: 'ghost',
    });
    getCycleDocDir = () => ws;

    const batchId = 'b10bstale';
    const runDir = await prepRunDir(proj.id, batchId);
    const precreatedRunId = artifacts.createRun(proj.id, batchId, path.join(runDir, 'north-star.md'), cycleId);

    await expect(
      orch.startRun({
        projectId: proj.id,
        batchId,
        cyclePlan: true,
        cycleId,
        precreatedRunId,
        prompt: 'cycle build',
      })
    ).rejects.toThrow(/git identity failed revalidation|not found in 'git worktree list/);

    expect(fakeT.spawnCalls.length).toBe(0);
    const reason = await fs.readFile(path.join(runDir, 'cycle-workspace-invalid.md'), 'utf8');
    expect(reason).toMatch(/git identity failed revalidation/i);
    expect(reason).toMatch(/not found in 'git worktree list/i);
    expect(reason).toMatch(/no fallback to the registered project root/i);
  });

  it('legacy null-identity starts on <docs>/repo with zero verify calls and overview marker', async () => {
    process.env.FORCE_DETERMINISTIC_VAL_PATH = '1';
    process.env.HELM_PROJECT_TEST_CMD = 'test';
    process.env.HELM_PROJECT_TEST_ARGS = '-f gate-marker';
    process.env.HELM_PROJECT_TEST_TIMEOUT_S = '10';

    const projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b10b-legacy-root-'));
    cleanups.push(() => fs.rm(projRoot, { recursive: true, force: true }));
    const ws = path.join(projRoot, 'cycle', 'legacy_b10b');
    const planMd = await seedCycleWorkspace(ws);
    const buildDir = path.join(ws, 'repo');
    await fs.mkdir(buildDir, { recursive: true });
    await fs.writeFile(path.join(buildDir, 'gate-marker'), 'x', 'utf8');

    const proj = projectSvc.createProject({ name: 'b10b-legacy', directory: projRoot });
    // Explicit null git_* — legacy null-identity (R4.4)
    const cycleId = makeCycle(proj.id, {
      folder: 'legacy_b10b',
      git_branch: null,
      git_worktree_path: null,
      git_worktree_id: null,
    });
    getCycleDocDir = () => ws;
    seedProvenance(db, proj.id, cycleId, planMd, artifacts, assignSvc);

    const batchId = 'b10bleg';
    const runDir = await prepRunDir(proj.id, batchId);
    await fs.writeFile(
      path.join(runDir, 'callbacks.md'),
      `\n[helm callback] implementer ${batchId} STATUS: DONE — scaffolded\n[helm callback] validator ${batchId} STATUS: PASS — verified\n`,
      'utf8'
    );
    await fs.writeFile(path.join(runDir, 'north-star.md'), '# stale', 'utf8');
    const precreatedRunId = artifacts.createRun(proj.id, batchId, path.join(runDir, 'north-star.md'), cycleId);

    await orch.startRun({
      projectId: proj.id,
      batchId,
      cyclePlan: true,
      cycleId,
      precreatedRunId,
      prompt: 'cycle build',
    });

    const implSpawn = fakeT.spawnCalls.find((s) => s.role === 'implementer');
    expect(implSpawn).toBeTruthy();
    const canonBuild = await fs.realpath(buildDir);
    const canonWs = await fs.realpath(ws);
    expect(implSpawn!.projectDir).toBe(canonBuild);
    expect(implSpawn!.projectDir).not.toBe(canonWs);
    // Zero revalidation / repair / infer against legacy
    expect(verifyCalls.length).toBe(0);

    // Overview marker: legacyWorkspace true for null-identity
    const cycles = new CycleService(db, projectSvc);
    const overview = cycles.listCyclesOverview();
    const row = [...overview.active, ...overview.pending, ...overview.completed, ...overview.archived].find(
      (r) => r.id === cycleId
    );
    expect(row).toBeTruthy();
    expect(row!.legacyWorkspace).toBe(true);
  });

  it('verifyPersistedWorktree: live git membership + containment; stale path throws', async () => {
    const repoDir = await initRepo('helm-b10b-verify-');
    cleanups.push(() => fs.rm(repoDir, { recursive: true, force: true }));

    const gws = new GitWorktreeService({
      prepare() {
        return { run: () => ({ changes: 1 }) };
      },
    });
    const identity = await gws.createCycleWorktree({
      projectDir: repoDir,
      cycleId: 77,
      slug: 'verify-me',
      baseRef: 'main',
    });

    const ok = await gws.verifyPersistedWorktree(repoDir, {
      worktreePath: identity.worktreePath,
      branch: identity.branch,
    });
    expect(ok).toBe(await fs.realpath(identity.worktreePath));

    // Stale: remove worktree from disk registration
    await git(repoDir, ['worktree', 'remove', '--force', identity.worktreePath]);
    await expect(
      gws.verifyPersistedWorktree(repoDir, {
        worktreePath: identity.worktreePath,
        branch: identity.branch,
      })
    ).rejects.toThrow(/does not resolve|not found in 'git worktree list/);
  });

  it('overview marks worktree-backed cycle as non-legacy', async () => {
    const projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b10b-ov-'));
    cleanups.push(() => fs.rm(projRoot, { recursive: true, force: true }));
    const proj = projectSvc.createProject({ name: 'b10b-ov', directory: projRoot });
    const wtPath = path.join(projRoot, 'cycle', '.worktrees', '1');
    const id = makeCycle(proj.id, {
      folder: 'ov_b10b',
      git_branch: 'helm/cycle/1/x',
      git_worktree_path: wtPath,
      git_worktree_id: 'w1',
    });
    const cycles = new CycleService(db, projectSvc);
    const overview = cycles.listCyclesOverview();
    const row = overview.active.find((r) => r.id === id);
    expect(row?.legacyWorkspace).toBe(false);
  });
});
