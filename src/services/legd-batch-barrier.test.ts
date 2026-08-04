// Leg D (batch barrier) — production-path integration tests.
// Covers: shared-validator batch checks → ingest → durable run_tasks.batch rows → queue admission order;
// mixed / earlier→later-batch rejection; the deploy gate keyed off run_tasks.batch; the pending-after-drain
// blocked-run classifier + artifact; and schema fresh + guarded-upgrade persistence of run_tasks.batch.
process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { RunArtifactService } from './run-artifact-service.js';
import { PlanParserService, type Plan } from './plan-parser-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { RunOrchestratorService } from './run-orchestrator-service.js';
import { ProjectService } from './project-service.js';
import { FakeTransport } from './fake-transport.js';
import { parseExecutionPlan } from './execution-plan-parser.js';

// The findings §6 adversarial plan-array order: [ A2(B1, dep A1), "B1"(B2), A1(B1) ].
const ADVERSARIAL_MD = `# execution_plan.md — Leg D adversarial
\`\`\`json
[
  { "id": "A2", "batch": "B1", "title": "A2 work", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": ["A1"] },
  { "id": "B1", "batch": "B2", "title": "B1-named task in batch B2", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": [] },
  { "id": "A1", "batch": "B1", "title": "A1 work", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": [] }
]
\`\`\`
`;

describe('Leg D: production barrier/ordering (shared validation → ingest → durable rows → queue)', () => {
  let dbs: DatabaseService, art: RunArtifactService, parser: PlanParserService, queue: TaskQueueService;
  let tmpDb: string, runDir: string;

  beforeEach(async () => {
    tmpDb = path.join(os.tmpdir(), `helm-legd-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    parser = new PlanParserService(art);
    queue = new TaskQueueService(art);
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-legd-run-'));
  });
  afterEach(async () => {
    if (dbs) dbs.close();
    await fs.rm(tmpDb, { force: true }).catch(() => {});
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('adversarial plan: rows persist B1/B2/B1; dispatch order is [A1,A2,B1]; B2 waits for both B1 tasks; one-in-flight holds', async () => {
    const rid = art.createRun(null, 'batch-legd');
    const { keyToId } = await parser.ingestExecutionPlan(rid, ADVERSARIAL_MD, queue, runDir);

    // Durable run_tasks.batch persisted (in plan-array order A2/B1/A1).
    const rows = dbs.raw.prepare('SELECT task_key, batch FROM run_tasks WHERE run_id = ? ORDER BY id').all(rid) as any[];
    const batchByKey = Object.fromEntries(rows.map((r) => [r.task_key, r.batch]));
    expect(batchByKey['A1']).toBe('B1');
    expect(batchByKey['A2']).toBe('B1');
    expect(batchByKey['B1']).toBe('B2'); // the task literally named "B1" lives in batch B2

    // Dispatch order via the queue admission barrier == [A1, A2, B1] (NOT the pre-fix [B1, A1, A2]).
    const idToKey: Record<number, string> = {};
    for (const [k, v] of Object.entries(keyToId)) idToKey[v] = k;
    const dispatched: string[] = [];
    let claim = queue.claimNextReady(rid);
    while (claim != null) {
      dispatched.push(idToKey[claim.taskId]);
      expect(queue.claimNextReady(rid), 'strict one-in-flight while a task is dispatched').toBeNull();
      queue.markComplete(claim);
      claim = queue.claimNextReady(rid);
    }
    expect(dispatched).toEqual(['A1', 'A2', 'B1']);
    // B2 (task key "B1") was not dispatched before BOTH B1-batch tasks completed.
    expect(dispatched.indexOf('B1')).toBeGreaterThan(dispatched.indexOf('A1'));
    expect(dispatched.indexOf('B1')).toBeGreaterThan(dispatched.indexOf('A2'));
  });

  it('canonical ingests never persist a null/empty batch', async () => {
    const rid = art.createRun(null, 'batch-legd-nn');
    await parser.ingestExecutionPlan(rid, ADVERSARIAL_MD, queue, runDir);
    const bad = dbs.raw
      .prepare("SELECT COUNT(*) AS c FROM run_tasks WHERE run_id = ? AND (batch IS NULL OR TRIM(batch) = '')")
      .get(rid) as any;
    expect(Number(bad.c)).toBe(0);
  });

  it('single-batch plan (all B1) needs no barrier — drains all tasks', async () => {
    const md = `\`\`\`json
[
  { "id": "S1", "batch": "B1", "title": "s1", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": [] },
  { "id": "S2", "batch": "B1", "title": "s2", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": [] }
]
\`\`\`
`;
    const rid = art.createRun(null, 'batch-legd-single');
    await parser.ingestExecutionPlan(rid, md, queue, runDir);
    let count = 0, r = queue.claimNextReady(rid);
    while (r != null) { count++; queue.markComplete(r); r = queue.claimNextReady(rid); }
    expect(count).toBe(2);
  });

  it('MIXED legacy machine plan (some labeled, some not) is REJECTED at ingest (barrier bypass)', async () => {
    const plan: Plan = {
      tasks: [
        { task_key: 'M1', atomic_work: 'labeled', complexity: 'low', task_type: 'feature', validation_criteria: 'ok', deps: [], batch: 'B1' } as any,
        { task_key: 'M2', atomic_work: 'unlabeled', complexity: 'low', task_type: 'feature', validation_criteria: 'ok', deps: [] } as any,
      ],
    };
    const rid = art.createRun(null, 'batch-legd-mixed');
    await expect(parser.ingestPlan(rid, plan, queue, runDir)).rejects.toThrow(/mixed batch labeling/);
  });

  it('an all-unlabeled legacy machine plan resolves every task to the synthetic default batch (single queue)', async () => {
    const plan: Plan = {
      tasks: [
        { task_key: 'U1', atomic_work: 'u1', complexity: 'low', task_type: 'feature', validation_criteria: 'ok', deps: [] } as any,
        { task_key: 'U2', atomic_work: 'u2', complexity: 'low', task_type: 'feature', validation_criteria: 'ok', deps: ['U1'] } as any,
      ],
    };
    const rid = art.createRun(null, 'batch-legd-def');
    await parser.ingestPlan(rid, plan, queue, runDir);
    const rows = dbs.raw.prepare('SELECT batch FROM run_tasks WHERE run_id = ?').all(rid) as any[];
    expect(rows.every((r) => r.batch === 'default')).toBe(true);
  });

  it('rejects an earlier-batch task depending on a later-batch task (validator + ingest)', async () => {
    const md = `\`\`\`json
[
  { "id": "E1", "batch": "B1", "title": "earlier depends on later", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": ["L2"] },
  { "id": "L2", "batch": "B2", "title": "later", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": [] }
]
\`\`\`
`;
    // UI gate rejects it (button disabled)…
    const parsed = parseExecutionPlan(md);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.errors.join(' ')).toMatch(/earlier-batch task cannot depend on a later-batch/);
    // …and ingest throws (valid ⟺ ingestible).
    const rid = art.createRun(null, 'batch-legd-dir');
    await expect(parser.ingestExecutionPlan(rid, md, queue, runDir)).rejects.toThrow();
  });

  it('allows same-batch and later→earlier dependencies', async () => {
    const md = `\`\`\`json
[
  { "id": "P1", "batch": "B1", "title": "p1", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": [] },
  { "id": "P2", "batch": "B1", "title": "same-batch dep", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": ["P1"] },
  { "id": "P3", "batch": "B2", "title": "later depends on earlier", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": ["P1"] }
]
\`\`\`
`;
    expect(parseExecutionPlan(md).ok).toBe(true);
    const rid = art.createRun(null, 'batch-legd-ok');
    await expect(parser.ingestExecutionPlan(rid, md, queue, runDir)).resolves.toBeDefined();
  });

  it('canonical execution_plan with a missing/empty batch is a validation ERROR', () => {
    const md = `\`\`\`json
[
  { "id": "N1", "batch": "", "title": "empty batch", "req_refs": ["R-1"], "assignee": "L1", "validator_lane": "L1", "effort": "low", "type": "feature", "deps": [] }
]
\`\`\`
`;
    expect(parseExecutionPlan(md).ok).toBe(false);
  });
});

describe('Leg D: schema fresh + guarded-upgrade persistence of run_tasks.batch', () => {
  it('a FRESH DB has run_tasks.batch and schema_version == SCHEMA_VERSION', () => {
    const tmp = path.join(os.tmpdir(), `helm-legd-fresh-${Date.now()}.db`);
    const dbs = new DatabaseService(tmp);
    const cols = (dbs.raw.prepare('PRAGMA table_info(run_tasks)').all() as any[]).map((c) => c.name);
    expect(cols).toContain('batch');
    const v = dbs.raw.prepare('SELECT version FROM schema_version').get() as any;
    expect(Number(v.version)).toBe(SCHEMA_VERSION);
    dbs.close();
    require('node:fs').rmSync(tmp, { force: true });
  });

  it('a GUARDED UPGRADE from a pre-v88 DB adds run_tasks.batch and reaches current v90', () => {
    const tmp = path.join(os.tmpdir(), `helm-legd-upg-${Date.now()}.db`);
    // Build a real schema then simulate the pre-v88 shape: drop the batch column + roll version back to 87.
    const seed = new DatabaseService(tmp);
    seed.raw.prepare("INSERT INTO runs (batch_id) VALUES ('legacy')").run();
    const rid = seed.raw.prepare('SELECT id FROM runs LIMIT 1').get() as any;
    seed.raw.prepare("INSERT INTO run_tasks (run_id, task_key, label, status) VALUES (?,?,?, 'pending')").run(rid.id, 'LEG', 'legacy row');
    seed.raw.exec('ALTER TABLE run_tasks DROP COLUMN batch;');
    seed.raw.prepare('UPDATE schema_version SET version = 87').run();
    // Sanity: the pre-v88 shape truly lacks the column.
    const preCols = (seed.raw.prepare('PRAGMA table_info(run_tasks)').all() as any[]).map((c) => c.name);
    expect(preCols).not.toContain('batch');
    seed.close();

    // Reopen → the guarded v88 migration must add the column without crashing.
    const upg = new DatabaseService(tmp);
    const cols = (upg.raw.prepare('PRAGMA table_info(run_tasks)').all() as any[]).map((c) => c.name);
    expect(cols).toContain('batch');
    const v = upg.raw.prepare('SELECT version FROM schema_version').get() as any;
    expect(Number(v.version)).toBe(98);
    // The legacy row carries NULL batch (resolved to the synthetic 'default' at read time).
    const row = upg.raw.prepare("SELECT batch FROM run_tasks WHERE task_key = 'LEG'").get() as any;
    expect(row.batch).toBeNull();
    upg.close();
    require('node:fs').rmSync(tmp, { force: true });
  });
});

describe('Leg D: deploy gate keyed off run_tasks.batch', () => {
  let dbs: DatabaseService, art: RunArtifactService, queue: TaskQueueService, pSvc: ProjectService;
  let tmpDb: string, projDir: string, runDir: string, orch: RunOrchestratorService, fakeDeploy: any, deployCalls: any[];

  beforeEach(async () => {
    tmpDb = path.join(os.tmpdir(), `helm-legd-dg-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    pSvc = new ProjectService(dbs);
    projDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-legd-dg-proj-'));
    await fs.writeFile(path.join(projDir, 'project_specs.md'),
      '# Test\n## Run / Deploy\n- **DEV deploy (autonomous-OK):** `npm run build && echo deployed`\n', 'utf8');
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-legd-dg-run-'));
    deployCalls = [];
    fakeDeploy = { async runDeploy(pd: string, cmd: string, url: string) { deployCalls.push({ projectDir: pd, deployCmd: cmd, devUrl: url }); return { success: true, note: 'ok' }; } };
    orch = new RunOrchestratorService({
      artifacts: art, planning: {} as any, parser: { loadPlanFromRunDir: async () => ({ tasks: [] }) } as any,
      queue, transport: new FakeTransport(), projectService: pSvc, assignmentService: {} as any,
      deployRunner: fakeDeploy, finalTestRunner: { async runTest() { return { success: true, note: '' }; } },
    });
  });
  afterEach(async () => {
    if (dbs) dbs.close();
    await fs.rm(tmpDb, { force: true }).catch(() => {});
    await fs.rm(projDir, { recursive: true, force: true }).catch(() => {});
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  async function loopWithSeededProof(rid: number, batchId: string, devUrl: string) {
    const LMod: any = await import('./orchestrator-loop.js');
    const l = new LMod.OrchestratorLoop(new FakeTransport(), { runDir, batchId, artifactService: art, projectDir: projDir, projectId: 1, runId: rid });
    await fs.appendFile(path.join(runDir, 'callbacks.md'),
      `[helm callback] validator ${batchId} STATUS: PASS — UI-proof on ${devUrl} OK (screenshot captured)\n`, 'utf8');
    return l;
  }

  it('alpha(B1)/omega(B1)/release(B2): deploy does NOT fire until BOTH B1 tasks complete (the exact B1 batch query controls closure); a no-B#-prefix key gates on its batch', async () => {
    const proj = pSvc.createProject({ name: 'legd-dg', directory: projDir });
    const devUrl = 'http://127.0.0.1:39998/dev';
    dbs.raw.prepare('UPDATE projects SET dev_url = ? WHERE id = ?').run(devUrl, proj.id);
    const rid = art.createRun(proj.id, 'batch-legd-dg', path.join(runDir, 'north_star.md'));
    dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(rid);

    // Task keys with NO B#- prefix (alpha/omega/release) — the gate must key off the batch FIELD.
    const alpha = art.recordTask(rid, 'alpha', 'a', 'B1');
    const omega = art.recordTask(rid, 'omega', 'o', 'B1');
    const release = art.recordTask(rid, 'release', 'r', 'B2');
    // B03: enqueue so freezeTerminalToken can seed run generation (token-only mark*).
    queue.enqueue(rid, alpha, [], false, 'B1');
    queue.enqueue(rid, omega, [], false, 'B1');
    queue.enqueue(rid, release, [], false, 'B2');

    const project = pSvc.getProject(proj.id);
    const loop = await loopWithSeededProof(rid, 'batch-legd-dg', devUrl);

    // After alpha completes, B1 still has omega pending → NO deploy.
    queue.markComplete(queue.freezeTerminalToken(rid, alpha)!); // sets status='complete' in DB
    await (orch as any).maybeRunBatchDeployGate({ runId: rid, runDir, batchId: 'batch-legd-dg', taskKey: 'alpha', project, loop, nextTaskId: alpha });
    expect(deployCalls.length, 'no deploy while omega (B1) is still pending').toBe(0);

    // After omega completes, B1 is closed (the exact `batch='B1' AND status!='complete'` query returns 0) → deploy.
    queue.markComplete(queue.freezeTerminalToken(rid, omega)!);
    await (orch as any).maybeRunBatchDeployGate({ runId: rid, runDir, batchId: 'batch-legd-dg', taskKey: 'omega', project, loop, nextTaskId: omega });
    expect(deployCalls.length, 'deploy fires exactly once when B1 closes').toBe(1);
    expect(deployCalls[0].devUrl).toBe(devUrl);
    expect(deployCalls[0].deployCmd).toMatch(/build/);

    // release (B2) is still pending — the deploy gate never dispatched it.
    const rel = dbs.raw.prepare('SELECT status FROM run_tasks WHERE id=?').get(release) as any;
    expect(rel.status).toBe('pending');
  });

  it('a misleading `B99-task` key stored as batch `B1` is treated as B1 (batch field wins, not the key prefix)', async () => {
    const proj = pSvc.createProject({ name: 'legd-dg-b99', directory: projDir });
    const devUrl = 'http://127.0.0.1:39997/dev';
    dbs.raw.prepare('UPDATE projects SET dev_url = ? WHERE id = ?').run(devUrl, proj.id);
    const rid = art.createRun(proj.id, 'batch-legd-b99', path.join(runDir, 'north_star.md'));
    dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(rid);

    // Key says B99, but the persisted batch is B1 — closing it must deploy-gate B1.
    const t = art.recordTask(rid, 'B99-task', 'misleading key', 'B1');
    queue.enqueue(rid, t, [], false, 'B1');
    const project = pSvc.getProject(proj.id);
    const loop = await loopWithSeededProof(rid, 'batch-legd-b99', devUrl);

    queue.markComplete(queue.freezeTerminalToken(rid, t)!);
    await (orch as any).maybeRunBatchDeployGate({ runId: rid, runDir, batchId: 'batch-legd-b99', taskKey: 'B99-task', project, loop, nextTaskId: t });
    expect(deployCalls.length).toBe(1);
    // The deploy artifact is labeled with the normalized batch B1 (not B99).
    const artExists = await fs.access(path.join(runDir, 'batch-B1-deploy.json')).then(() => true).catch(() => false);
    expect(artExists).toBe(true);
    const b99Art = await fs.access(path.join(runDir, 'batch-B99-deploy.json')).then(() => true).catch(() => false);
    expect(b99Art).toBe(false);
  });

  it('a legacy default (unlabeled) batch does NOT inter-batch deploy-gate (end-of-run gate covers it)', async () => {
    const proj = pSvc.createProject({ name: 'legd-dg-def', directory: projDir });
    dbs.raw.prepare('UPDATE projects SET dev_url = ? WHERE id = ?').run('http://127.0.0.1:39996/dev', proj.id);
    const rid = art.createRun(proj.id, 'batch-legd-def', path.join(runDir, 'north_star.md'));
    dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(rid);
    const t = art.recordTask(rid, 'T1', 'legacy', 'default');
    queue.enqueue(rid, t, [], false, 'default');
    const project = pSvc.getProject(proj.id);
    const loop = await loopWithSeededProof(rid, 'batch-legd-def', 'http://127.0.0.1:39996/dev');
    queue.markComplete(queue.freezeTerminalToken(rid, t)!);
    await (orch as any).maybeRunBatchDeployGate({ runId: rid, runDir, batchId: 'batch-legd-def', taskKey: 'T1', project, loop, nextTaskId: t });
    expect(deployCalls.length).toBe(0);
  });

  it('HELM_SKIP_BATCH_DEPLOY=1 skips the deploy gate at the drain call site; unset → the gate fires (labeled batch, no DEV config → intentional R-F8/R-G4 pause)', async () => {
    const proj = pSvc.createProject({ name: 'legd-skip', directory: projDir });
    // NO dev_url on the project → if the gate fires it hits the no-config R-F8/R-G4 pause
    // (deploy-paused.md + phase=blocked). That pause is CORRECT for real runs and must stay.
    const rid = art.createRun(proj.id, 'batch-legd-skip', path.join(runDir, 'north_star.md'));
    dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(rid);
    const project = pSvc.getProject(proj.id);
    const fakeLoop = { runTask: async () => ({ finalStatus: 'PASS' }) } as any;

    // Drive ONE labeled-batch (B1) task through the real drainDispatch, spying on the gate call.
    const runOnce = async (skip: boolean): Promise<number> => {
      const t = art.recordTask(rid, `alpha-${skip}`, 'a', 'B1');
      queue.enqueue(rid, t, [], false, 'B1');
      let gateCalls = 0;
      const orig = (orch as any).maybeRunBatchDeployGate.bind(orch);
      (orch as any).maybeRunBatchDeployGate = async (...args: any[]) => { gateCalls++; return orig(...args); };
      const prev = process.env.HELM_SKIP_BATCH_DEPLOY;
      if (skip) process.env.HELM_SKIP_BATCH_DEPLOY = '1'; else delete process.env.HELM_SKIP_BATCH_DEPLOY;
      try {
        await (orch as any).drainDispatch(rid, runDir, 'batch-legd-skip', project, fakeLoop);
      } finally {
        if (prev === undefined) delete process.env.HELM_SKIP_BATCH_DEPLOY; else process.env.HELM_SKIP_BATCH_DEPLOY = prev;
        (orch as any).maybeRunBatchDeployGate = orig;
      }
      return gateCalls;
    };

    // Guard SET → gate NOT invoked; no deploy-paused.md; run proceeds (still executing).
    expect(await runOnce(true), 'gate must not be called when HELM_SKIP_BATCH_DEPLOY=1').toBe(0);
    expect(await fs.access(path.join(runDir, 'deploy-paused.md')).then(() => true).catch(() => false)).toBe(false);
    expect((dbs.raw.prepare('SELECT phase FROM runs WHERE id=?').get(rid) as any).phase).toBe('executing');

    // Guard UNSET → gate fires; labeled B1 with no DEV config → intentional pause (existing R-F8/R-G4 behavior).
    expect(await runOnce(false), 'gate must fire when the env is unset').toBe(1);
    const run = dbs.raw.prepare('SELECT phase, status FROM runs WHERE id=?').get(rid) as any;
    expect(run.phase).toBe('blocked');
    expect(await fs.access(path.join(runDir, 'deploy-paused.md')).then(() => true).catch(() => false)).toBe(true);
  });

  it('regression guard: a legacy (all-default) run’s injected final-fix resolves to batch `default` and the deploy gate SKIPS it (no deploy, no deploy-paused/blocked)', async () => {
    const proj = pSvc.createProject({ name: 'legd-dg-finalfix', directory: projDir });
    // NOTE: no dev_url set — if the legacy final-fix were (wrongly) gated, the no-config path would write
    // deploy-paused.md + phase=blocked/status=failed. Asserting those DON'T happen proves the skip.
    const rid = art.createRun(proj.id, 'batch-legd-finalfix', path.join(runDir, 'north_star.md'));
    dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(rid);
    // Seed the legacy (all-default) plan, then compute the final-fix batch exactly as the orchestrator does.
    const t1 = art.recordTask(rid, 'T1', 'legacy work', 'default');
    queue.enqueue(rid, t1, [], false, 'default');
    queue.markComplete(queue.freezeTerminalToken(rid, t1)!);
    const fixBatch = queue.newBatchAfterLast(rid);
    expect(fixBatch).toBe('default'); // legacy plan → final-fix stays in default (not 'default1')

    const fixId = art.recordTask(rid, 'FIX-FINAL-LEGACY-abc', 'final-test fix', fixBatch);
    queue.enqueueTask(rid, fixId, true, fixBatch);
    queue.markComplete(queue.freezeTerminalToken(rid, fixId)!);
    const project = pSvc.getProject(proj.id);
    const loop = await loopWithSeededProof(rid, 'batch-legd-finalfix', 'http://127.0.0.1:39996/dev');
    await (orch as any).maybeRunBatchDeployGate({ runId: rid, runDir, batchId: 'batch-legd-finalfix', taskKey: 'FIX-FINAL-LEGACY-abc', project, loop, nextTaskId: fixId });

    expect(deployCalls.length, 'legacy final-fix must not deploy-gate').toBe(0);
    const paused = await fs.access(path.join(runDir, 'deploy-paused.md')).then(() => true).catch(() => false);
    expect(paused, 'legacy final-fix must not write deploy-paused.md').toBe(false);
    const run = dbs.raw.prepare('SELECT phase, status FROM runs WHERE id=?').get(rid) as any;
    expect(run.phase).not.toBe('blocked');
    expect(run.status).not.toBe('failed');
  });
});

describe('Leg D: pending-after-drain blocked-run classifier + artifact', () => {
  let dbs: DatabaseService, art: RunArtifactService, queue: TaskQueueService, pSvc: ProjectService;
  let tmpDb: string, runDir: string, orch: RunOrchestratorService, finalCalls: any[], deployCalls: any[];

  beforeEach(async () => {
    tmpDb = path.join(os.tmpdir(), `helm-legd-pad-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    pSvc = new ProjectService(dbs);
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-legd-pad-run-'));
    finalCalls = []; deployCalls = [];
    orch = new RunOrchestratorService({
      artifacts: art, planning: {} as any, parser: { loadPlanFromRunDir: async () => ({ tasks: [] }) } as any,
      queue, transport: new FakeTransport(), projectService: pSvc, assignmentService: {} as any,
      deployRunner: { async runDeploy() { deployCalls.push(1); return { success: true, note: '' }; } },
      finalTestRunner: { async runTest() { finalCalls.push(1); return { success: true, note: '' }; } },
    });
  });
  afterEach(async () => {
    if (dbs) dbs.close();
    await fs.rm(tmpDb, { force: true }).catch(() => {});
    await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('failed earlier-batch task blocks a ready later-batch task: phase=blocked/status=failed + pending-after-drain.md names the B2 task and the B1 blocker; run is NOT complete; no final-test/deploy runner called', async () => {
    const rid = art.createRun(null, 'batch-legd-pad');
    dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(rid);
    // B1: a (fails), b (independent, completes). B2: c (ready, never dispatched).
    const a = art.recordTask(rid, 'B1-A', 'a', 'B1');
    const b = art.recordTask(rid, 'B1-B', 'b', 'B1');
    const c = art.recordTask(rid, 'B2-C', 'c', 'B2');
    queue.enqueue(rid, a, [], false, 'B1');
    queue.enqueue(rid, b, [], false, 'B1');
    queue.enqueue(rid, c, [], false, 'B2');
    // Drain: a fails, b completes; c barred by the failed B1.
    const ca = queue.claimNextReady(rid); expect(ca!.taskId).toBe(a); queue.markFailed(ca!);
    const cb = queue.claimNextReady(rid); expect(cb!.taskId).toBe(b); queue.markComplete(cb!);
    expect(queue.claimNextReady(rid)).toBeNull();

    const blocked = await (orch as any).handlePendingAfterDrain(rid, runDir, 'batch-legd-pad');
    expect(blocked).toBe(true);

    const run = dbs.raw.prepare('SELECT phase, status FROM runs WHERE id=?').get(rid) as any;
    expect(run.phase).toBe('blocked');
    expect(run.status).toBe('failed');
    expect(run.status).not.toBe('complete');

    const note = await fs.readFile(path.join(runDir, 'pending-after-drain.md'), 'utf8');
    expect(note).toMatch(/failed-block/);
    expect(note).toContain('B2-C');            // the pending, never-dispatched task
    expect(note).toContain('B1-A');            // the exact failed blocker
    expect(note).toMatch(/no later-batch dispatch occurred/i);

    // The run short-circuits: no final-test / deploy runner is invoked by the drain handler.
    expect(finalCalls.length).toBe(0);
    expect(deployCalls.length).toBe(0);
  });

  it('deferred earlier-batch task → deferred-block (distinct reason)', async () => {
    const rid = art.createRun(null, 'batch-legd-pad2');
    dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(rid);
    const a = art.recordTask(rid, 'B1-A', 'a', 'B1');
    const c = art.recordTask(rid, 'B2-C', 'c', 'B2');
    queue.enqueue(rid, a, [], false, 'B1');
    queue.enqueue(rid, c, [], false, 'B2');
    queue.claimNextReady(rid); queue.markDeferred(queue.freezeTerminalToken(rid, a)!);
    expect(queue.claimNextReady(rid)).toBeNull();
    expect(await (orch as any).handlePendingAfterDrain(rid, runDir, 'batch-legd-pad2')).toBe(true);
    const note = await fs.readFile(path.join(runDir, 'pending-after-drain.md'), 'utf8');
    expect(note).toMatch(/deferred-block/);
  });

  it('catch-all: a pending DB row the queue never knew about surfaces unknown-pending-stall (never complete)', async () => {
    const rid = art.createRun(null, 'batch-legd-pad3');
    dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(rid);
    // A pending run_tasks row that was NEVER enqueued (queue/DB divergence).
    art.recordTask(rid, 'GHOST', 'orphan pending row', 'B1');
    // Queue is empty for this run → classifier all-complete, but DB has a pending row.
    const blocked = await (orch as any).handlePendingAfterDrain(rid, runDir, 'batch-legd-pad3');
    expect(blocked).toBe(true);
    const run = dbs.raw.prepare('SELECT phase, status FROM runs WHERE id=?').get(rid) as any;
    expect(run.phase).toBe('blocked');
    expect(run.status).not.toBe('complete');
    const note = await fs.readFile(path.join(runDir, 'pending-after-drain.md'), 'utf8');
    expect(note).toMatch(/unknown-pending-stall/);
    expect(note).toContain('GHOST');
  });

  it('genuinely complete run is NOT blocked (returns false → normal completion proceeds)', async () => {
    const rid = art.createRun(null, 'batch-legd-pad4');
    dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(rid);
    const a = art.recordTask(rid, 'B1-A', 'a', 'B1');
    queue.enqueue(rid, a, [], false, 'B1');
    queue.claimNextReady(rid); queue.markComplete(queue.freezeTerminalToken(rid, a)!);
    expect(await (orch as any).handlePendingAfterDrain(rid, runDir, 'batch-legd-pad4')).toBe(false);
  });
});

describe('Leg D: dynamic-task batch resolution (inject)', () => {
  let dbs: DatabaseService, art: RunArtifactService, queue: TaskQueueService;
  let tmpDb: string, orch: RunOrchestratorService;

  beforeEach(() => {
    tmpDb = path.join(os.tmpdir(), `helm-legd-inj-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    orch = new RunOrchestratorService({
      artifacts: art, planning: {} as any, parser: {} as any, queue,
      transport: new FakeTransport(), projectService: {} as any, assignmentService: {} as any,
    });
  });
  afterEach(async () => {
    if (dbs) dbs.close();
    await fs.rm(tmpDb, { force: true }).catch(() => {});
  });

  it('injection during an active batch inherits that batch; an explicit batch is honored', async () => {
    const rid = art.createRun(null, 'batch-legd-inj');
    dbs.raw.prepare("UPDATE runs SET phase='executing' WHERE id=?").run(rid);
    const a = art.recordTask(rid, 'B1-A', 'a', 'B1');
    queue.enqueue(rid, a, [], false, 'B1');
    queue.claimNextReady(rid); // a in-flight (active batch B1)

    const inherited = await orch.inject(rid, { label: 'mid-run injected' });
    const rowI = dbs.raw.prepare('SELECT batch FROM run_tasks WHERE id=?').get(inherited.injected) as any;
    expect(rowI.batch).toBe('B1'); // inherited the active batch
    expect(queue.batchOfTask(inherited.injected!)).toBe('B1');

    const explicit = await orch.inject(rid, { label: 'explicit batch', batch: 'B5' });
    const rowE = dbs.raw.prepare('SELECT batch FROM run_tasks WHERE id=?').get(explicit.injected) as any;
    expect(rowE.batch).toBe('B5');
  });
});
