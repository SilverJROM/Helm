process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { PlanningPhaseService, selectCoPlannerMode } from './planning-phase-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';
import { resolveRequirementsText } from './requirements-resolver-service.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function canonicalPlanMd(tasks: unknown[]): string {
  return `# Plan\n\n\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\`\n`;
}

describe('planning-phase-service (B9 PLN1) + gate + auto pick', () => {
  let runDir: string;
  let transport: FakeTransport;
  let tmpDb: string;
  let dbs: DatabaseService;
  let art: RunArtifactService;
  let queue: TaskQueueService;
  let phase: PlanningPhaseService;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b9-phase-'));
    const cb = path.join(runDir, 'callbacks.md');
    await fs.writeFile(cb, '# B9 planning callbacks\n', 'utf8');
    transport = new FakeTransport();
    tmpDb = path.join(os.tmpdir(), `helm-b9-phase-${Date.now()}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    phase = new PlanningPhaseService(transport, art, queue);
  });

  afterEach(async () => {
    if (dbs) dbs.close();
    if (tmpDb) await fs.rm(tmpDb, { force: true }).catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('auto pick: simple/clear north-star -> planner; cross-cutting/ambiguous -> deliberation', () => {
    const simple = 'Add a small utility function to format dates.';
    expect(selectCoPlannerMode(simple)).toBe('planner');
    expect(selectCoPlannerMode(simple, { isCrossCutting: false })).toBe('planner');

    const cross = 'Refactor the entire schema migration + run_tasks ingestion + co-planner gate across modules with ambiguous deps.';
    expect(selectCoPlannerMode(cross)).toBe('deliberation');
    expect(selectCoPlannerMode('architecture pivot for security model', { isAmbiguous: true })).toBe('deliberation');
  });

  it('gate BLOCKS handoff until agreement; planner fast-path derives plan.json from canonical plan.md', async () => {
    const north = 'Simple single-module feature: add a plan parser that reads json and creates run_tasks.';
    const conv = 'Interview notes: clear scope, no cross module risk.';

    // Start the phase (spawns will be recorded; we drive via callbacks)
    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-B9-gate',
      northStar: north,
      conversationLog: conv,
      mode: 'auto'
    });

    const cbp = path.join(runDir, 'callbacks.md');

    // Simulate projcore starting planning
    await fs.appendFile(cbp, `[helm callback] plancore batch-B9-gate STATUS: PLANNING — starting co-planner selection\n`);
    await sleep(30);

    // Because auto + simple, partner resolves to 'planner' (POCFIX9: single, fast path, no partner spawned or required).
    // Drive ONLY projcore PLAN-READY (no partner cb line needed; test proves fast path).
    // (We still append a legacy planner line in some flows but it is not waited for.)
    await fs.appendFile(cbp, `[helm callback] plancore batch-B9-gate STATUS: PLAN-READY — plan.json written with all fields + deps\n`);
    await sleep(30);

    const res = await p;

    expect(res.agreed).toBe(true);
    expect(res.coPlannerUsed).toBe('planner');
    expect(res.plan.tasks.length).toBeGreaterThan(0);
    expect(res.createdTaskIds.length).toBeGreaterThan(0);
    expect(res.keyToId['P1']).toBeTypeOf('number');

    // POCFIX9: for 'planner' (simple auto) NO partner role was spawned (fast path; only projcore).
    const plannerSpawns = transport.spawnCalls.filter((s) => s.role === 'planner' || s.role === 'deliberation');
    expect(plannerSpawns.length).toBe(0);

    // Helm derived plan.json from the canonical plan.md fixture.
    const planRaw = await fs.readFile(path.join(runDir, 'plan.json'), 'utf8');
    const plan = JSON.parse(planRaw);
    expect(plan.tasks[0].recommended_model).toBeDefined();
    expect(plan.tasks[0].deps).toBeDefined();

    // queue has the tasks (ingest happened only after gate)
    expect(queue.getQueue(art['db'] ? 0 : 0).length || res.createdTaskIds.length > 0).toBeTruthy(); // indirect via created
  });

  it('hands Discovery cycle artifacts through Planning into implementation as one canonical set', async () => {
    const cycleRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-s6-cycle-'));
    const discoveryNorthStar = '# Discovery truth\n\nBuild the canonical handoff.\n';
    const requirements = '- **S6-REQ** — Implementation receives this exact acceptance block.\n  Preserve the wrapped detail.\n';
    const plan = canonicalPlanMd([{
      id: 'S6-T1', batch: 'S6', title: 'Implement canonical handoff', req_refs: ['S6-REQ'],
      assignee: 'L1', validator_lane: 'L2', effort: 'med', type: 'feature', deps: [],
    }]);
    try {
      await fs.mkdir(path.join(cycleRoot, 'decisions'), { recursive: true });
      await fs.writeFile(path.join(cycleRoot, 'north-star.md'), discoveryNorthStar, 'utf8');
      await fs.writeFile(path.join(cycleRoot, 'conversation-log.md'), 'Owner chose one artifact chain.\n', 'utf8');
      await fs.writeFile(path.join(cycleRoot, 'decisions', 'one-chain.md'), '# One chain\n', 'utf8');
      await fs.writeFile(path.join(cycleRoot, 'og-requirements.md'), requirements, 'utf8');
      await fs.writeFile(path.join(cycleRoot, 'plan.md'), plan, 'utf8');
      await fs.writeFile(path.join(runDir, 'north-star.md'), '# stale runDir copy\n', 'utf8');
      await fs.writeFile(path.join(runDir, 'north_star.md'), '# legacy divergent copy\n', 'utf8');

      const pending = phase.runPlanningPhase({
        runDir,
        canonicalArtifactRoot: cycleRoot,
        batchId: 'batch-S6-canonical',
        northStar: '# stale input\n',
        conversationLog: 'stale input log',
        mode: 'planner',
      });
      await fs.appendFile(path.join(runDir, 'callbacks.md'), '[helm callback] plancore batch-S6-canonical STATUS: PLAN-READY — canonical docs ready\n');
      const result = await pending;

      expect(result.northStarPath).toBe(path.join(cycleRoot, 'north-star.md'));
      expect(result.reqPath).toBe(path.join(cycleRoot, 'og-requirements.md'));
      expect(result.planMdPath).toBe(path.join(cycleRoot, 'plan.md'));
      expect(transport.spawnCalls[0].brief).toContain('Build the canonical handoff.');
      expect(await fs.readFile(path.join(runDir, 'north-star.md'), 'utf8')).toBe(discoveryNorthStar);
      expect(await fs.readFile(path.join(runDir, 'og-requirements.md'), 'utf8')).toBe(requirements);
      expect(await fs.readFile(path.join(runDir, 'plan.md'), 'utf8')).toBe(plan);
      expect(await fs.readFile(path.join(runDir, 'decisions', 'one-chain.md'), 'utf8')).toContain('One chain');
      expect(resolveRequirementsText(runDir, ['S6-REQ'])).toBe(
        '- **S6-REQ** — Implementation receives this exact acceptance block.\n  Preserve the wrapped detail.',
      );
      expect(JSON.parse(await fs.readFile(path.join(runDir, 'plan.json'), 'utf8')).tasks[0].task_key).toBe('S6-T1');
      expect(await fs.readFile(path.join(runDir, 'north_star.md'), 'utf8')).toBe('# legacy divergent copy\n');
    } finally {
      await fs.rm(cycleRoot, { recursive: true, force: true });
    }
  });

  it('gate still works for explicit deliberation mode + ambiguous signals', async () => {
    const north = 'Cross module: overhaul the orchestrator planning + red-team panel + final validation with multiple viable seams.';
    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-B9-delib',
      northStar: north,
      conversationLog: 'High ambiguity on decomposition.',
      mode: 'auto',
      autoSignals: { isCrossCutting: true }
    });

    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] plancore batch-B9-delib STATUS: PLANNING\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] deliberation batch-B9-delib-partner STATUS: CONSENSUS — agreed after 2 rounds\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] plancore batch-B9-delib STATUS: PLAN-READY — plan agreed with deliberation\n`);
    await sleep(20);

    const res = await p;
    expect(res.agreed).toBe(true);
    expect(res.coPlannerUsed).toBe('deliberation');
    expect(res.plan.tasks.length).toBeGreaterThan(0);
  });

  it('parses plancore-authored canonical plan.md and derives plan.json instead of using the fixture', async () => {
    const north = 'Add Lucky 9 card game to the cards project (real build POC).';
    const conv = 'Clear single-module feature for external repo.';

    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-POCFIX3-realpath',
      northStar: north,
      conversationLog: conv,
      mode: 'auto'
    });

    const cbp = path.join(runDir, 'callbacks.md');

    await fs.writeFile(path.join(runDir, 'og-requirements.md'), '- **L9-R1** — Lucky 9 works.\n', 'utf8');
    await fs.writeFile(path.join(runDir, 'plan.md'), canonicalPlanMd([{
      id: 'L9-1', batch: 'B1', title: 'Implement core Lucky 9 logic + tests in the cards repo under projectDir',
      req_refs: ['L9-R1'], assignee: 'grok-4.5', validator_lane: 'L1', effort: 'med', type: 'feature', deps: [],
      validation_criteria: 'game class present, unit tests pass for deal/hit, committed in target project dir',
    }]), 'utf8');

    await fs.appendFile(cbp, `[helm callback] plancore batch-POCFIX3-realpath STATUS: PLANNING\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] planner batch-POCFIX3-realpath-partner STATUS: CONSENSUS — atomic + fields good\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] plancore batch-POCFIX3-realpath STATUS: PLAN-READY — plan agreed with planner; see plan.md\n`);
    await sleep(20);

    const res = await p;

    expect(res.agreed).toBe(true);
    expect(res.plan.tasks[0].task_key).toBe('L9-1');
    expect(res.plan.tasks[0].atomic_work).toContain('Lucky 9');
    expect(JSON.parse(await fs.readFile(path.join(runDir, 'plan.json'), 'utf8')).tasks[0].task_key).toBe('L9-1');

    // Under !fake, missing canonical requirements/plan after PLAN-READY throws a clear BLOCK.
  });

  // POCFIX8 (a): real-path (!USE_FAKE_TMUX) uses long env-overridable PLANNING_TIMEOUT_MS for waitForAgreement (not 4000),
  // + post-grace poll for BOTH PLAN-READY cb + valid plan.json; succeeds ingest when present (drive via temp cb+plan.json);
  // fixture path stays fast (4000). No real-path fixture fallback.
  it('POCFIX8 (a): real !fake path uses long waitForAgreement timeout + ingests on PLAN-READY+plan.json (fake keeps fast; no fixture on real)', async () => {
    const origFake = process.env.USE_FAKE_TMUX;
    const origPlanTo = process.env.HELM_PLANNING_TIMEOUT_MS;
    // Flip only USE_FAKE_TMUX (to falsy) so isFake=false for timeout calc + poll in phase; leave NODE_ENV so ctor in beforeEach for this/adjacent its stay valid for FakeTransport.
    process.env.USE_FAKE_TMUX = '0';
    // Short controlled timeout for the wait (instead of 600s) so test is fast + deterministic; still >>4k to prove "long" branch.
    process.env.HELM_PLANNING_TIMEOUT_MS = '8000';
    const waitSpy = vi.spyOn(phase as any, 'waitForAgreement');
    try {
      const north = 'POCFIX8 timeout check: real projcore planning wait.';
      const conv = 'Single atomic.';
      const p = phase.runPlanningPhase({
        runDir,
        batchId: 'batch-POCFIX8-timeout',
        northStar: north,
        conversationLog: conv,
        mode: 'auto'
      });
      const cbp = path.join(runDir, 'callbacks.md');
      // Drive exactly like real: canonical requirements + plan.md are written before PLAN-READY.
      await fs.writeFile(path.join(runDir, 'og-requirements.md'), '- **PX8-R1** — Planning waits for canonical artifacts.\n', 'utf8');
      await fs.writeFile(path.join(runDir, 'plan.md'), canonicalPlanMd([{
        id: 'PX8-1', batch: 'B1', title: 'Add POCFIX8 planning timeout test + sandbox rule check',
        req_refs: ['PX8-R1'], assignee: 'L1', validator_lane: 'L1', effort: 'low', type: 'feature', deps: [],
        validation_criteria: 'test asserts long timeout and successful ingest under real path',
      }]), 'utf8');
      await fs.appendFile(cbp, `[helm callback] plancore batch-POCFIX8-timeout STATUS: PLANNING\n`);
      await sleep(5);
      await fs.appendFile(cbp, `[helm callback] planner batch-POCFIX8-timeout-partner STATUS: CONSENSUS\n`);
      await sleep(5);
      await fs.appendFile(cbp, `[helm callback] plancore batch-POCFIX8-timeout STATUS: PLAN-READY — plan.json present\n`);
      const res = await p;
      expect(res.agreed).toBe(true);
      expect(res.plan.tasks[0].task_key).toBe('PX8-1');
      expect(res.plan.tasks[0].atomic_work).toContain('POCFIX8');
      // Asserted the long timeout passed to wait (not the old 4000)
      expect(waitSpy).toHaveBeenCalled();
      const calledWithTimeout = waitSpy.mock.calls[0]?.[4];
      expect(calledWithTimeout).toBeGreaterThan(4000); // 8000 from our override (or 600k default)
      expect(calledWithTimeout).not.toBe(4000);
    } finally {
      process.env.USE_FAKE_TMUX = origFake || '1';
      if (origPlanTo === undefined) { delete (process.env as any).HELM_PLANNING_TIMEOUT_MS; } else { process.env.HELM_PLANNING_TIMEOUT_MS = origPlanTo; }
      waitSpy.mockRestore();
    }
  }, 12000);

  // POCFIX8 (b): sandbox source now includes the $HOME/.claude rw add_rule (using real_home/getpwuid pattern after .npm)
  it('POCFIX8 (b): tools/helm-sandbox.c contains home-claude rw add_rule (real_home getpwuid, after home-npm)', async () => {
    const cPath = path.resolve('tools/helm-sandbox.c');
    const csrc = await fs.readFile(cPath, 'utf8');
    expect(csrc).toMatch(/home-claude/);
    // also verify the pattern: real_home + snprintf .claude + add_rule + ensure_dir
    expect(csrc).toMatch(/getpwuid|getuid.*real_home/);
    expect(csrc).toMatch(/\.claude.*add_rule|add_rule.*home-claude/);
    // POCFIX10: also assert the /dev/* char device rules (per gate; /dev/null etc now have add_rule)
    expect(csrc).toMatch(/dev-null/);
    expect(csrc).toMatch(/\/dev\/null/);
  });

  // POCFIX9 (b): 'planner' mode (single) proceeds on PLAN-READY + valid plan.json with NO partner AGREE line and without full-timeout stall;
  // 'deliberation' still requires the partner signal. Use explicit mode (bypasses auto) + pre-written plan.json.
  it('POCFIX9 (b): planner mode ingests fast on PLAN-READY + plan.json with no partner required (deliberation still needs partner)', async () => {
    const origPlanTo = process.env.HELM_PLANNING_TIMEOUT_MS;
    process.env.HELM_PLANNING_TIMEOUT_MS = '5000'; // controlled; logic returns early on PLAN-READY for planner
    try {
      // --- planner fast path: only projcore PLAN-READY, no partner cb lines at all ---
      const northPlanner = 'Add Lucky 9 card game to the cards project (clear single feature).';
      const pPlanner = phase.runPlanningPhase({
        runDir,
        batchId: 'batch-POCFIX9-planner-fast',
        northStar: northPlanner,
        conversationLog: 'Simple isolated feature.',
        mode: 'planner'  // explicit single-planner
      });
      const cbp = path.join(runDir, 'callbacks.md');
      const plannerPlan = {
        tasks: [{ task_key: 'L9-1', atomic_work: 'Lucky9 core', complexity: 'med', recommended_model: 'claude-sonnet', effort: 'med', needs_more_info: false, task_type: 'feature', validation_criteria: 'core works', deps: [] }],
        meta: { source: 'pocfix9-planner' }
      };
      await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plannerPlan, null, 2), 'utf8');
      await fs.appendFile(cbp, `[helm callback] plancore batch-POCFIX9-planner-fast STATUS: PLAN-READY — plan.json present\n`);
      const resPlanner = await pPlanner;
      expect(resPlanner.agreed).toBe(true);
      expect(resPlanner.coPlannerUsed).toBe('planner');
      expect(resPlanner.plan.tasks[0].task_key).toBe('L9-1');
      // no partner line was appended, yet succeeded quickly (fast path)

      // --- deliberation still requires partner ---
      const pDelib = phase.runPlanningPhase({
        runDir,
        batchId: 'batch-POCFIX9-delib-still',
        northStar: 'Cross module refactor with ambiguity.',
        conversationLog: 'High risk.',
        mode: 'deliberation'
      });
      const cbp2 = path.join(runDir, 'callbacks.md');  // same runDir reused in sequence; append more
      const delibPlan = {
        tasks: [{ task_key: 'X1', atomic_work: 'cross cut work', complexity: 'high', recommended_model: 'codex-5.5', effort: 'high', needs_more_info: false, task_type: 'feature', validation_criteria: 'deps ok', deps: [] }],
        meta: { source: 'pocfix9-delib' }
      };
      await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(delibPlan, null, 2), 'utf8');
      await fs.appendFile(cbp2, `[helm callback] plancore batch-POCFIX9-delib-still STATUS: PLANNING\n`);
      await sleep(10);
      // intentionally no partner line yet
      // start the wait, then provide the partner signal
      const partnerLineP = (async () => {
        await sleep(30);
        await fs.appendFile(cbp2, `[helm callback] deliberation batch-POCFIX9-delib-still-partner STATUS: CONSENSUS\n`);
        await fs.appendFile(cbp2, `[helm callback] plancore batch-POCFIX9-delib-still STATUS: PLAN-READY — agreed\n`);
      })();
      const resDelib = await pDelib;
      await partnerLineP;
      expect(resDelib.agreed).toBe(true);
      expect(resDelib.coPlannerUsed).toBe('deliberation');
    } finally {
      if (origPlanTo === undefined) delete (process.env as any).HELM_PLANNING_TIMEOUT_MS; else process.env.HELM_PLANNING_TIMEOUT_MS = origPlanTo;
    }
  }, 15000);

  // A1 (R4.16): a cycle-linked planning run records plancore + partner as worker_runtimes rows
  // with non-NULL run_id resolving to the cycle via runs.cycle_id, and dispatches is untouched (N5).
  it('A1: cycle-linked planning run inserts worker_runtimes rows with non-NULL run_id resolving via runs.cycle_id', async () => {
    const projRow = dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get('a1-worker-runtimes-proj', '/tmp/a1-worker-runtimes-proj') as { id: number };
    const cycleRow = dbs.raw.prepare(
      `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
       VALUES (?, ?, ?, 'planning', 'autonomous_after_discovery', 'active') RETURNING id`
    ).get(projRow.id, 'A1 cycle', 'a1-cycle') as { id: number };
    const runRow = dbs.raw.prepare(
      `INSERT INTO runs (project_id, cycle_id, batch_id, phase) VALUES (?, ?, ?, 'planning') RETURNING id`
    ).get(projRow.id, cycleRow.id, 'batch-A1-worker-runtimes') as { id: number };

    const dispatchesBefore = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches').get() as { c: number }).c;

    const north = 'Cross module: overhaul the orchestrator with ambiguous deps needing a partner review.';
    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-A1-worker-runtimes',
      northStar: north,
      conversationLog: 'High ambiguity on decomposition.',
      mode: 'auto',
      autoSignals: { isCrossCutting: true },
      projectId: projRow.id,
      runId: runRow.id,
    });

    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] plancore batch-A1-worker-runtimes STATUS: PLANNING\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] deliberation batch-A1-worker-runtimes-partner STATUS: CONSENSUS — agreed after 2 rounds\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] plancore batch-A1-worker-runtimes STATUS: PLAN-READY — plan agreed with deliberation\n`);
    await sleep(20);

    const res = await p;
    expect(res.agreed).toBe(true);

    const rows = dbs.raw.prepare(
      `SELECT wr.id, wr.role, wr.run_id, wr.correlation_id, wr.project_id, r.cycle_id
       FROM worker_runtimes wr JOIN runs r ON r.id = wr.run_id
       WHERE wr.run_id = ? ORDER BY wr.id`
    ).all(runRow.id) as any[];

    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.run_id).not.toBeNull();
      expect(row.cycle_id).toBe(cycleRow.id);
      expect(row.project_id).toBe(projRow.id);
    }
    expect(rows.some((r) => r.role === 'plancore' && r.correlation_id === 'batch-A1-worker-runtimes')).toBe(true);
    expect(rows.some((r) => r.role === 'deliberation' && r.correlation_id === 'batch-A1-worker-runtimes-partner')).toBe(true);

    const dispatchesAfter = (dbs.raw.prepare('SELECT COUNT(*) as c FROM dispatches').get() as { c: number }).c;
    expect(dispatchesAfter).toBe(dispatchesBefore);
  });

  // POCFIX9 (c): selectCoPlannerMode resolves clear single-feature non-cross-cutting north-star to 'planner' (Lucky-9 style).
  it('POCFIX9 (c): selectCoPlannerMode resolves clear single-feature (non-cross-cutting) to planner', () => {
    const clearSingle = 'Add Lucky 9 card game to the cards project (engine + client + tests).';
    expect(selectCoPlannerMode(clearSingle)).toBe('planner');
    expect(selectCoPlannerMode(clearSingle, { isCrossCutting: false, isHighRisk: false })).toBe('planner');

    // signals or trigger words still force deliberation
    expect(selectCoPlannerMode('Refactor entire schema + auth across modules', { isCrossCutting: true })).toBe('deliberation');
    expect(selectCoPlannerMode('Add security model with high risk')).toBe('deliberation');
  });
});
