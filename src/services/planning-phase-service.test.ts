process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { PlanningPhaseService, selectCoPlannerMode, parseConsensusRule } from './planning-phase-service.js';
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

  // A10 (R1.3): the old regex's bare `arch` alternative was unanchored — it matched "se-ARCH" as a
  // substring, false-positiving any north-star that merely mentions a search feature into 'deliberation'.
  // Replaced with `architect` (architecture/architect), which "search" does not contain, while a
  // genuine architecture-scoped north-star (with no other trigger word) still resolves to 'deliberation'.
  it('A10: "search" no longer false-positives into deliberation; "architecture" alone still does', () => {
    expect(selectCoPlannerMode('Add a search endpoint that queries the users table by name')).toBe('planner');
    expect(selectCoPlannerMode('Redesign the service architecture end to end')).toBe('deliberation');
  });

  it('gate BLOCKS handoff until agreement; planner mode always convenes + waits for the partner (A8/R1.2)', async () => {
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

    // Because auto + simple, partner resolves to 'planner' — A8: this mode still convenes ONE partner
    // and still requires its agreement signal (D1: "planner mode means one co-reviewer, never no
    // partner"). PLAN-READY alone must not be sufficient.
    await fs.appendFile(cbp, `[helm callback] plancore batch-B9-gate STATUS: PLAN-READY — plan.json written with all fields + deps\n`);
    await sleep(30);
    expect(await Promise.race([p.then(() => 'resolved'), sleep(50).then(() => 'pending')])).toBe('pending');

    await fs.appendFile(cbp, `[helm callback] planner batch-B9-gate-partner STATUS: VERDICT-READY — CLEAN: plan is atomic, deps clean\n`);
    await sleep(30);

    const res = await p;

    expect(res.agreed).toBe(true);
    expect(res.coPlannerUsed).toBe('planner');
    expect(res.plan.tasks.length).toBeGreaterThan(0);
    expect(res.createdTaskIds.length).toBeGreaterThan(0);
    expect(res.keyToId['P1']).toBeTypeOf('number');

    // A8: default-config planning always spawns exactly 2 seats (plancore + partner), even in 'planner' mode.
    const plannerSpawns = transport.spawnCalls.filter((s) => s.role === 'planner' || s.role === 'deliberation');
    expect(plannerSpawns.length).toBe(1);

    // Helm derived plan.json from the canonical plan.md fixture.
    const planRaw = await fs.readFile(path.join(runDir, 'plan.json'), 'utf8');
    const plan = JSON.parse(planRaw);
    expect(plan.tasks[0].recommended_model).toBeDefined();
    expect(plan.tasks[0].deps).toBeDefined();

    // queue has the tasks (ingest happened only after gate)
    expect(queue.getQueue(art['db'] ? 0 : 0).length || res.createdTaskIds.length > 0).toBeTruthy(); // indirect via created
  });

  // (a) Default-config planning always spawns 2 seats (plancore + partner) — no mode skips the partner.
  it('A8: default-config planning spawns exactly 2 seats (plancore + partner)', async () => {
    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-A8-two-seats',
      northStar: 'Add a small utility function to format dates.',
      conversationLog: 'clear scope, no cross module risk.',
      mode: 'auto'
    });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] plancore batch-A8-two-seats STATUS: PLAN-READY — plan.json written\n`);
    await sleep(30);
    await fs.appendFile(cbp, `[helm callback] planner batch-A8-two-seats-partner STATUS: VERDICT-READY — CLEAN: clean\n`);

    const res = await p;
    expect(res.agreed).toBe(true);
    expect(transport.spawnCalls.length).toBe(2);
    expect(transport.spawnCalls.some((s) => s.role === 'planner')).toBe(true);
  });

  // A10 (R1.3): panel size is per-project config (total seats incl. plancore), not a north-star guess.
  it('A10: panelSize=3 spawns exactly 3 seats (plancore + 2 partners), unanimous CLEAN from BOTH required', async () => {
    const batchId = 'batch-A10-three-seats';
    const cbp = path.join(runDir, 'callbacks.md');
    const p = phase.runPlanningPhase({
      runDir,
      batchId,
      northStar: 'Add a small utility function to format dates.',
      conversationLog: 'clear scope, no cross module risk.',
      mode: 'auto',
      panelSize: 3,
    });
    await fs.appendFile(cbp, `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan.json written\n`);
    await sleep(30);
    // Only the FIRST (legacy-named) partner agrees so far — the gate must not pass on a partial verdict.
    await fs.appendFile(cbp, `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: clean\n`);
    await sleep(60);
    expect(transport.spawnCalls.length).toBe(3); // plancore + 2 partners spawned up front, regardless of verdict timing
    expect(transport.spawnCalls.filter((s) => s.role === 'planner').length).toBe(2);
    expect(transport.spawnCalls.some((s) => s.batchId === `${batchId}-partner`)).toBe(true);
    expect(transport.spawnCalls.some((s) => s.batchId === `${batchId}-partner-2`)).toBe(true);
    // Second partner now agrees too — unanimous, gate passes.
    await fs.appendFile(cbp, `[helm callback] planner ${batchId}-partner-2 STATUS: VERDICT-READY — CLEAN: clean\n`);

    const res = await p;
    expect(res.agreed).toBe(true);
  });

  it('A10: panelSize=3 — a BROKEN from either partner fails the gate (unanimous, not majority)', async () => {
    const batchId = 'batch-A10-broken-one-of-two';
    const cbp = path.join(runDir, 'callbacks.md');
    process.env.HELM_PLANNING_TIMEOUT_MS = '300';
    try {
      const p = phase.runPlanningPhase({
        runDir,
        batchId,
        northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope, no cross module risk.',
        mode: 'auto',
        panelSize: 3,
      });
      await fs.appendFile(cbp, `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan.json written\n`);
      await fs.appendFile(cbp, `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: clean\n`);
      await fs.appendFile(cbp, `[helm callback] planner ${batchId}-partner-2 STATUS: VERDICT-READY — BROKEN: gap found\n`);
      const res = await p;
      expect(res.agreed).toBe(false);
      expect(res.createdTaskIds).toEqual([]);
    } finally {
      delete process.env.HELM_PLANNING_TIMEOUT_MS;
    }
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
      // A8: 'planner' mode still convenes + requires the partner's agreement signal.
      await fs.appendFile(path.join(runDir, 'callbacks.md'), '[helm callback] planner batch-S6-canonical-partner STATUS: VERDICT-READY — CLEAN: clean\n');
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
    await fs.appendFile(cbp, `[helm callback] deliberation batch-B9-delib-partner STATUS: VERDICT-READY — CLEAN: agreed after 2 rounds\n`);
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
    await fs.appendFile(cbp, `[helm callback] planner batch-POCFIX3-realpath-partner STATUS: VERDICT-READY — CLEAN: atomic + fields good\n`);
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
      await fs.appendFile(cbp, `[helm callback] planner batch-POCFIX8-timeout-partner STATUS: VERDICT-READY — CLEAN: consensus reached\n`);
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

  // A8 (R1.2): the former POCFIX9 fast path let 'planner' mode pass on PLAN-READY alone with no
  // partner spawned/required. It's deleted: 'planner' now requires the SAME partner agreement signal
  // as 'deliberation' — PLAN-READY alone does not pass, and a stall with no partner is agreed:false
  // (bounded), never a silent pass.
  it('A8: planner mode always convenes a partner and requires its agreement signal (PLAN-READY alone does not pass)', async () => {
    const origPlanTo = process.env.HELM_PLANNING_TIMEOUT_MS;
    process.env.HELM_PLANNING_TIMEOUT_MS = '5000';
    try {
      const northPlanner = 'Add Lucky 9 card game to the cards project (clear single feature).';
      const pPlanner = phase.runPlanningPhase({
        runDir,
        batchId: 'batch-A8-planner-partner',
        northStar: northPlanner,
        conversationLog: 'Simple isolated feature.',
        mode: 'planner'  // explicit single-planner
      });
      const cbp = path.join(runDir, 'callbacks.md');
      const plannerPlan = {
        tasks: [{ task_key: 'L9-1', atomic_work: 'Lucky9 core', complexity: 'med', recommended_model: 'claude-sonnet', effort: 'med', needs_more_info: false, task_type: 'feature', validation_criteria: 'core works', deps: [] }],
        meta: { source: 'a8-planner' }
      };
      await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plannerPlan, null, 2), 'utf8');
      await fs.appendFile(cbp, `[helm callback] plancore batch-A8-planner-partner STATUS: PLAN-READY — plan.json present\n`);

      // (b) PLAN-READY alone must NOT resolve the gate, even in 'planner' mode.
      await sleep(80);
      const stillPending = await Promise.race([pPlanner.then(() => 'resolved'), sleep(20).then(() => 'pending')]);
      expect(stillPending).toBe('pending');

      // exactly one partner seat was spawned (default-config planning always spawns 2 seats total).
      const plannerSpawns = transport.spawnCalls.filter((s) => s.role === 'planner');
      expect(plannerSpawns.length).toBe(1);

      // The partner's own agreement signal is what completes the gate.
      await fs.appendFile(cbp, `[helm callback] planner batch-A8-planner-partner-partner STATUS: VERDICT-READY — CLEAN: clean\n`);
      const resPlanner = await pPlanner;
      expect(resPlanner.agreed).toBe(true);
      expect(resPlanner.coPlannerUsed).toBe('planner');
      expect(resPlanner.plan.tasks[0].task_key).toBe('L9-1');
    } finally {
      if (origPlanTo === undefined) delete (process.env as any).HELM_PLANNING_TIMEOUT_MS; else process.env.HELM_PLANNING_TIMEOUT_MS = origPlanTo;
    }
  }, 15000);

  // (c) The stall this workaround existed for (no partner signal ever arrives) is now a bounded
  // agreed:false — reap both seats, no ingest — never a silent PLAN-READY-alone pass.
  it('A8: a stall with no partner signal returns agreed:false (bounded), never a silent pass', async () => {
    const origPlanTo = process.env.HELM_PLANNING_TIMEOUT_MS;
    process.env.HELM_PLANNING_TIMEOUT_MS = '150'; // short, deterministic timeout
    try {
      const p = phase.runPlanningPhase({
        runDir,
        batchId: 'batch-A8-stall',
        northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope',
        mode: 'planner'
      });
      const cbp = path.join(runDir, 'callbacks.md');
      const plan = {
        tasks: [{ task_key: 'S1', atomic_work: 'stall proof', complexity: 'low', recommended_model: 'claude-sonnet', effort: 'low', needs_more_info: false, task_type: 'feature', validation_criteria: 'n/a', deps: [] }],
        meta: { source: 'a8-stall' }
      };
      await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
      // PLAN-READY arrives, but the partner NEVER responds — the exact stall the deleted POCFIX9
      // fast path used to silently paper over.
      await fs.appendFile(cbp, `[helm callback] plancore batch-A8-stall STATUS: PLAN-READY — plan.json present\n`);

      const res = await p;
      expect(res.agreed).toBe(false);
      expect(res.createdTaskIds).toEqual([]);
      // A11 (R1.6): a mechanism-level reason naming the missing partner batch id — never a silent pass.
      expect(res.blockedReason).toBeTruthy();
      expect(res.blockedReason).toContain('batch-A8-stall-partner');
      expect(res.blockedReason).toMatch(/ROUND-CAP-EXHAUSTED/);
    } finally {
      if (origPlanTo === undefined) delete (process.env as any).HELM_PLANNING_TIMEOUT_MS; else process.env.HELM_PLANNING_TIMEOUT_MS = origPlanTo;
    }
  }, 15000);

  // A11 (D7/R1.30): the round cap is project config, not a constant — proven end to end by observing
  // that the bounded-exit wait actually SCALES with roundCap (same per-round window, more rounds
  // granted before giving up), not just that a reason string mentions "rounds".
  it('A11: round cap scales the bounded-exit wait — roundCap=3 (default) waits ~3x longer than roundCap=1 before BLOCKED', async () => {
    const origPlanTo = process.env.HELM_PLANNING_TIMEOUT_MS;
    process.env.HELM_PLANNING_TIMEOUT_MS = '120'; // small per-round window, deterministic
    try {
      const t1Start = Date.now();
      const res1 = await phase.runPlanningPhase({
        runDir,
        batchId: 'batch-A11-cap1',
        northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope',
        mode: 'auto',
        roundCap: 1,
      });
      const elapsed1 = Date.now() - t1Start;
      expect(res1.agreed).toBe(false);
      expect(res1.blockedReason).toContain('1 round(s)');

      const t3Start = Date.now();
      const res3 = await phase.runPlanningPhase({
        runDir,
        batchId: 'batch-A11-cap3',
        northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope',
        mode: 'auto',
        roundCap: 3,
      });
      const elapsed3 = Date.now() - t3Start;
      expect(res3.agreed).toBe(false);
      expect(res3.blockedReason).toContain('3 round(s)');
      expect(res3.createdTaskIds).toEqual([]);

      // roundCap=3 must wait meaningfully longer (same ~120ms per-round window, 3 rounds granted)
      // than roundCap=1 — proving the cap actually governs the bound, not just labels it. 1.5x (not
      // the full nominal 3x) keeps this robust against scheduler/poll-interval jitter on slower CI.
      expect(elapsed3).toBeGreaterThan(elapsed1 * 1.5);
    } finally {
      if (origPlanTo === undefined) delete (process.env as any).HELM_PLANNING_TIMEOUT_MS; else process.env.HELM_PLANNING_TIMEOUT_MS = origPlanTo;
    }
  }, 15000);

  // A13 (R1.29 reconvene half — D6 per-task half; A9's whole-plan scope half is untouched).
  describe('A13: per-task ACCEPT/AMEND/ESCALATE conflict-only reconvene', () => {
    const seedTwoTaskPlan = async (rd: string) => {
      const plan = {
        tasks: [
          { task_key: 'T1', atomic_work: 'first task', complexity: 'low', recommended_model: 'claude-sonnet', effort: 'low', needs_more_info: false, task_type: 'feature', validation_criteria: 'n/a', deps: [] },
          { task_key: 'T2', atomic_work: 'second task', complexity: 'low', recommended_model: 'claude-sonnet', effort: 'low', needs_more_info: false, task_type: 'feature', validation_criteria: 'n/a', deps: [] },
        ],
        meta: { source: 'a13-two-task' }
      };
      await fs.writeFile(path.join(rd, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
    };

    it('a plan whose tasks all ACCEPT (or carry no verdict at all) produces exactly one agreement gate and zero per-task convenes', async () => {
      const batchId = 'batch-A13-all-accept';
      await seedTwoTaskPlan(runDir);
      const p = phase.runPlanningPhase({
        runDir, batchId, northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope', mode: 'auto',
      });
      const cbp = path.join(runDir, 'callbacks.md');
      const spawnsBefore = transport.spawnCalls.length;
      await fs.appendFile(cbp,
        `[helm callback] plancore ${batchId} STATUS: TASK-VERDICT — T1: ACCEPT\n` +
        `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan.json written\n`
      );
      await sleep(30);
      await fs.appendFile(cbp,
        `[helm callback] planner ${batchId}-partner STATUS: TASK-VERDICT — T1: ACCEPT\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: clean\n`
      );
      const res = await p;
      expect(res.agreed).toBe(true);
      expect(res.reconvenedTaskKeys).toEqual([]);
      // exactly the 2 whole-plan seats — no reconvene seats spawned for T1 or the verdict-silent T2.
      expect(transport.spawnCalls.length - spawnsBefore).toBe(2);
    });

    it('a seeded ESCALATE on one task convenes the pair exactly once (T1 unaffected)', async () => {
      const batchId = 'batch-A13-escalate';
      await seedTwoTaskPlan(runDir);
      const p = phase.runPlanningPhase({
        runDir, batchId, northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope', mode: 'auto',
      });
      const cbp = path.join(runDir, 'callbacks.md');
      await fs.appendFile(cbp,
        `[helm callback] plancore ${batchId} STATUS: TASK-VERDICT — T2: ESCALATE: unclear validation criteria\n` +
        `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan.json written\n`
      );
      await sleep(30);
      await fs.appendFile(cbp,
        `[helm callback] planner ${batchId}-partner STATUS: TASK-VERDICT — T2: ACCEPT\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: clean\n`
      );
      const res = await p;
      expect(res.agreed).toBe(true);
      expect(res.reconvenedTaskKeys).toEqual(['T2']);
      const reconveneSpawns = transport.spawnCalls.filter((s) => s.batchId === `${batchId}-reconvene-T2`);
      expect(reconveneSpawns.length).toBe(1); // convened exactly once, not per-poll-iteration
    });

    it('a conflicting AMEND pair convenes the pair exactly once; a BYTE-IDENTICAL AMEND from both seats does not conflict', async () => {
      const batchId = 'batch-A13-amend-conflict';
      await seedTwoTaskPlan(runDir);
      const p = phase.runPlanningPhase({
        runDir, batchId, northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope', mode: 'auto',
      });
      const cbp = path.join(runDir, 'callbacks.md');
      await fs.appendFile(cbp,
        `[helm callback] plancore ${batchId} STATUS: TASK-VERDICT — T1: AMEND: shrink scope to the happy path\n` +
        `[helm callback] plancore ${batchId} STATUS: TASK-VERDICT — T2: AMEND: same wording for both\n` +
        `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan.json written\n`
      );
      await sleep(30);
      await fs.appendFile(cbp,
        `[helm callback] planner ${batchId}-partner STATUS: TASK-VERDICT — T1: AMEND: split into two smaller tasks\n` +
        `[helm callback] planner ${batchId}-partner STATUS: TASK-VERDICT — T2: AMEND: same wording for both\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: clean\n`
      );
      const res = await p;
      expect(res.agreed).toBe(true);
      // T1: differing AMEND text -> conflict. T2: byte-identical AMEND -> already agreed, no conflict.
      expect(res.reconvenedTaskKeys).toEqual(['T1']);
      expect(transport.spawnCalls.filter((s) => s.batchId === `${batchId}-reconvene-T1`).length).toBe(1);
      expect(transport.spawnCalls.some((s) => s.batchId === `${batchId}-reconvene-T2`)).toBe(false);
    });

    it('DB: a convene event is recorded against the run + cycle (auditable trigger)', async () => {
      const projRow = dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
        .get('a13-convene-proj', '/tmp/a13-convene-proj') as { id: number };
      const cycleRow = dbs.raw.prepare(
        `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
         VALUES (?, ?, ?, 'planning', 'autonomous_after_discovery', 'active') RETURNING id`
      ).get(projRow.id, 'A13 cycle', 'a13-cycle') as { id: number };
      const batchId = 'batch-A13-db-convene';
      const runRow = dbs.raw.prepare(
        `INSERT INTO runs (project_id, cycle_id, batch_id, phase) VALUES (?, ?, ?, 'planning') RETURNING id`
      ).get(projRow.id, cycleRow.id, batchId) as { id: number };
      await seedTwoTaskPlan(runDir);

      const p = phase.runPlanningPhase({
        runDir, batchId, northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope', mode: 'auto',
        projectId: projRow.id, runId: runRow.id,
      });
      const cbp = path.join(runDir, 'callbacks.md');
      await fs.appendFile(cbp,
        `[helm callback] plancore ${batchId} STATUS: TASK-VERDICT — T2: ESCALATE: needs owner decision\n` +
        `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan.json written\n`
      );
      await sleep(30);
      await fs.appendFile(cbp,
        `[helm callback] planner ${batchId}-partner STATUS: TASK-VERDICT — T2: ACCEPT\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: clean\n`
      );
      const res = await p;
      expect(res.agreed).toBe(true);
      expect(res.reconvenedTaskKeys).toEqual(['T2']);

      const eventRow = dbs.raw.prepare(
        `SELECT run_id, batch_id, event_type, payload_json FROM run_events WHERE run_id = ? AND event_type = 'A13_TASK_RECONVENE'`
      ).get(String(runRow.id)) as any;
      expect(eventRow).toBeTruthy();
      expect(eventRow.batch_id).toBe(batchId);
      const payload = JSON.parse(eventRow.payload_json);
      expect(payload.task_key).toBe('T2');
      expect(payload.cycle_id).toBe(cycleRow.id);
      expect(payload.trigger).toBe('ESCALATE');
    });
  });

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
    await fs.appendFile(cbp, `[helm callback] deliberation batch-A1-worker-runtimes-partner STATUS: VERDICT-READY — CLEAN: agreed after 2 rounds\n`);
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

  // A2 (R4.16): planning spawns forward projectId/runId so RealTransport can register helm_sessions
  // at the createSession choke point (FakeTransport records the args; product path uses them).
  it('A2: planning spawns pass projectId+runId into transport.spawn for both seats', async () => {
    const projRow = dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get('a2-helm-sessions-proj', '/tmp/a2-helm-sessions-proj') as { id: number };
    const cycleRow = dbs.raw.prepare(
      `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status)
       VALUES (?, ?, ?, 'planning', 'autonomous_after_discovery', 'active') RETURNING id`
    ).get(projRow.id, 'A2 cycle', 'a2-cycle') as { id: number };
    const runRow = dbs.raw.prepare(
      `INSERT INTO runs (project_id, cycle_id, batch_id, phase) VALUES (?, ?, ?, 'planning') RETURNING id`
    ).get(projRow.id, cycleRow.id, 'batch-A2-helm-sessions') as { id: number };

    transport.spawnCalls.length = 0;
    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-A2-helm-sessions',
      northStar: 'Cross module: overhaul the orchestrator with ambiguous deps needing a partner review.',
      conversationLog: 'High ambiguity on decomposition.',
      mode: 'auto',
      autoSignals: { isCrossCutting: true },
      projectId: projRow.id,
      runId: runRow.id,
    });

    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] plancore batch-A2-helm-sessions STATUS: PLANNING\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] deliberation batch-A2-helm-sessions-partner STATUS: VERDICT-READY — CLEAN: agreed\n`);
    await sleep(20);
    await fs.appendFile(cbp, `[helm callback] plancore batch-A2-helm-sessions STATUS: PLAN-READY — plan agreed with deliberation\n`);
    await sleep(20);
    await p;

    const withIds = transport.spawnCalls.filter((c) => c.projectId === projRow.id && c.runId === runRow.id);
    expect(withIds.length).toBeGreaterThanOrEqual(2);
    expect(withIds.some((c) => c.role === 'plancore')).toBe(true);
    expect(withIds.some((c) => c.role === 'deliberation')).toBe(true);
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

  // A9 (R1.4/R1.5/R1.29 scope half): rewrites waitForAgreement's partner matcher.
  describe('A9: waitForAgreement rewrite (payload verdict, batch-scoped partner, dual-prefix)', () => {
    it('(a) a BROKEN verdict fails the gate — no ingest, no hand-off', async () => {
      const p = phase.runPlanningPhase({
        runDir,
        batchId: 'batch-A9-broken',
        northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope',
        mode: 'planner',
      });
      const cbp = path.join(runDir, 'callbacks.md');
      const plan = {
        tasks: [{ task_key: 'BR-1', atomic_work: 'broken proof', complexity: 'low', recommended_model: 'claude-sonnet', effort: 'low', needs_more_info: false, task_type: 'feature', validation_criteria: 'n/a', deps: [] }],
        meta: { source: 'a9-broken' }
      };
      await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
      await fs.appendFile(cbp, `[helm callback] plancore batch-A9-broken STATUS: PLAN-READY — plan.json present\n`);
      // VERDICT-READY is the literal STATUS token for BOTH verdicts — the BROKEN payload must still
      // fail the gate, never pass byte-identical to a CLEAN verdict.
      await fs.appendFile(cbp, `[helm callback] planner batch-A9-broken-partner STATUS: VERDICT-READY — BROKEN: missing validation criteria for T3\n`);

      const res = await p;
      expect(res.agreed).toBe(false);
      expect(res.createdTaskIds).toEqual([]);
      expect(res.keyToId).toEqual({});
    });

    it('(b) a stale VERDICT-READY from a different run/batch does not satisfy — the deadlock/foreign-acceptance fix', async () => {
      const origPlanTo = process.env.HELM_PLANNING_TIMEOUT_MS;
      process.env.HELM_PLANNING_TIMEOUT_MS = '200'; // short + deterministic: prove the stale line never resolves it
      try {
        const p = phase.runPlanningPhase({
          runDir,
          batchId: 'batch-A9-stale',
          northStar: 'Add a small utility function to format dates.',
          conversationLog: 'clear scope',
          mode: 'planner',
        });
        const cbp = path.join(runDir, 'callbacks.md');
        const plan = {
          tasks: [{ task_key: 'ST-1', atomic_work: 'stale-line proof', complexity: 'low', recommended_model: 'claude-sonnet', effort: 'low', needs_more_info: false, task_type: 'feature', validation_criteria: 'n/a', deps: [] }],
          meta: { source: 'a9-stale' }
        };
        await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
        await fs.appendFile(cbp, `[helm callback] plancore batch-A9-stale STATUS: PLAN-READY — plan.json present\n`);
        // A partner CLEAN verdict for a DIFFERENT batch (a previous run's own `-partner` namespace, and
        // separately the bare, unscoped batchId a naive equality check would have required) — neither
        // should satisfy THIS run's gate.
        await fs.appendFile(cbp, `[helm callback] planner batch-A9-stale-OLDRUN-partner STATUS: VERDICT-READY — CLEAN: from a different run\n`);
        await fs.appendFile(cbp, `[helm callback] planner batch-A9-stale STATUS: VERDICT-READY — CLEAN: wrong batch (bare, unscoped)\n`);

        const res = await p;
        expect(res.agreed).toBe(false);
      } finally {
        if (origPlanTo === undefined) delete (process.env as any).HELM_PLANNING_TIMEOUT_MS; else process.env.HELM_PLANNING_TIMEOUT_MS = origPlanTo;
      }
    });

    it('(c) a genuine current-batch CLEAN verdict passes (anti-deadlock guard) — exactly one whole-plan gate, no per-task loop', async () => {
      transport.spawnCalls.length = 0;
      const p = phase.runPlanningPhase({
        runDir,
        batchId: 'batch-A9-clean',
        northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope',
        mode: 'planner',
      });
      const cbp = path.join(runDir, 'callbacks.md');
      const plan = {
        tasks: [
          { task_key: 'CL-1', atomic_work: 'task one', complexity: 'low', recommended_model: 'claude-sonnet', effort: 'low', needs_more_info: false, task_type: 'feature', validation_criteria: 'n/a', deps: [] },
          { task_key: 'CL-2', atomic_work: 'task two', complexity: 'low', recommended_model: 'claude-sonnet', effort: 'low', needs_more_info: false, task_type: 'feature', validation_criteria: 'n/a', deps: [] },
        ],
        meta: { source: 'a9-clean' }
      };
      await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
      await fs.appendFile(cbp, `[helm callback] plancore batch-A9-clean STATUS: PLAN-READY — plan.json present\n`);
      // R1.5/N3: scoped correctly to the partner's OWN batch (`${batchId}-partner`) — the anti-deadlock
      // positive case (a naive bare-batchId check would never match this and stall to timeout).
      await fs.appendFile(cbp, `[helm callback] planner batch-A9-clean-partner STATUS: VERDICT-READY — CLEAN: all good\n`);

      const res = await p;
      expect(res.agreed).toBe(true);
      expect(res.createdTaskIds.length).toBe(2); // whole-plan ingest, both tasks, one gate

      // Exactly one plancore spawn and one partner spawn — a single whole-plan gate, never a per-task
      // convene loop (that reconvene behaviour does not exist in the engine yet — it's A13's row).
      expect(transport.spawnCalls.filter((s) => s.role === 'plancore').length).toBe(1);
      expect(transport.spawnCalls.filter((s) => s.role === 'planner').length).toBe(1);
    });

    it('N4: accepts a [projcore callback]-prefixed partner verdict, not just [helm callback]', async () => {
      const p = phase.runPlanningPhase({
        runDir,
        batchId: 'batch-A9-projcore-prefix',
        northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope',
        mode: 'planner',
      });
      const cbp = path.join(runDir, 'callbacks.md');
      const plan = {
        tasks: [{ task_key: 'PJ-1', atomic_work: 'projcore-prefix proof', complexity: 'low', recommended_model: 'claude-sonnet', effort: 'low', needs_more_info: false, task_type: 'feature', validation_criteria: 'n/a', deps: [] }],
        meta: { source: 'a9-projcore-prefix' }
      };
      await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
      await fs.appendFile(cbp, `[projcore callback] plancore batch-A9-projcore-prefix STATUS: PLAN-READY — plan.json present\n`);
      await fs.appendFile(cbp, `[projcore callback] planner batch-A9-projcore-prefix-partner STATUS: VERDICT-READY — CLEAN: all good\n`);

      const res = await p;
      expect(res.agreed).toBe(true);
    });

    // send-back (attempt=2, redteam HIGH; hardened attempt=3, redteam residual HIGH): runDir is
    // deterministic per (projectId, batchId) and callbacks.md is never truncated between attempts, so
    // a restart/rerun reusing the SAME batchId (not a different one — R1.5 already closes the
    // foreign-batch case) can leave an OLD VERDICT-READY CLEAN for the same `${batchId}-partner`
    // sitting in the file. Without a durable generation fence, a fresh PLAN-READY on the second attempt
    // would pair with that stale CLEAN and pass the gate without the partner ever having reviewed THIS
    // attempt's plan. attempt=3 hardening: the fence must be a FILE in runDir, not a process-local Map
    // — a process/service restart wipes any in-memory state, so this test uses a BRAND NEW
    // PlanningPhaseService instance for attempt 2 (simulating exactly that restart) to prove the fence
    // survives it; an in-memory-only fence would fail this specific test.
    it('send-back: a same-batch CLEAN verdict from a PRIOR attempt does not satisfy a later attempt, even across a fresh service instance (process restart)', async () => {
      const reusedBatchId = 'batch-A9-restart-reuse';
      const cbp = path.join(runDir, 'callbacks.md');
      const plan1 = {
        tasks: [{ task_key: 'RS-1', atomic_work: 'first attempt', complexity: 'low', recommended_model: 'claude-sonnet', effort: 'low', needs_more_info: false, task_type: 'feature', validation_criteria: 'n/a', deps: [] }],
        meta: { source: 'a9-restart-1' }
      };

      // Attempt 1: genuinely agrees (proves the fixture/fence works normally, not just fails-safe).
      const p1 = phase.runPlanningPhase({
        runDir,
        batchId: reusedBatchId,
        northStar: 'Add a small utility function to format dates.',
        conversationLog: 'clear scope',
        mode: 'planner',
      });
      await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plan1, null, 2), 'utf8');
      await fs.appendFile(cbp, `[helm callback] plancore ${reusedBatchId} STATUS: PLAN-READY — attempt 1\n`);
      await fs.appendFile(cbp, `[helm callback] planner ${reusedBatchId}-partner STATUS: VERDICT-READY — CLEAN: attempt 1 agreed\n`);
      const res1 = await p1;
      expect(res1.agreed).toBe(true);

      // Attempt 2: a FRESH PlanningPhaseService instance (new transport/queue too) reusing the EXACT
      // SAME runDir/batchId — simulating a process/service restart between attempts, not just a second
      // call on the same live instance. callbacks.md itself is untouched (never truncated) and the old
      // CLEAN from attempt 1 is still sitting in the file for the identical `${reusedBatchId}-partner`
      // namespace. NO new partner line is written this time. A fresh PLAN-READY alone (from THIS
      // attempt) must not pair with that stale verdict and pass — proving the fence lives in a durable
      // file under runDir, not in the (now-discarded) prior instance's memory.
      const freshTransport = new FakeTransport();
      const freshPhase = new PlanningPhaseService(freshTransport, art, queue);
      const origPlanTo = process.env.HELM_PLANNING_TIMEOUT_MS;
      process.env.HELM_PLANNING_TIMEOUT_MS = '200'; // short + deterministic: prove it never resolves true
      try {
        const p2 = freshPhase.runPlanningPhase({
          runDir,
          batchId: reusedBatchId,
          northStar: 'Add a small utility function to format dates.',
          conversationLog: 'clear scope',
          mode: 'planner',
        });
        await fs.appendFile(cbp, `[helm callback] plancore ${reusedBatchId} STATUS: PLAN-READY — attempt 2 (fresh)\n`);
        const res2 = await p2;
        expect(res2.agreed).toBe(false);
        expect(res2.createdTaskIds).toEqual([]);
      } finally {
        if (origPlanTo === undefined) delete (process.env as any).HELM_PLANNING_TIMEOUT_MS; else process.env.HELM_PLANNING_TIMEOUT_MS = origPlanTo;
      }
    });
  });

  // A9 (N11): parseConsensusRule — pure unit coverage, direct import (no phase/transport needed).
  describe('A9: parseConsensusRule (teams.consensus_rule wiring)', () => {
    it('sources unanimous + the round cap from the seeded deliberation-team rule; does NOT expose the settle clause', () => {
      const parsed = parseConsensusRule('unanimous <=3 rounds; opus+codex-5.5 settle');
      expect(parsed.unanimous).toBe(true);
      expect(parsed.maxRounds).toBe(3);
      // The settle-role clause is undecided and contradicts topology.yaml (N11) — it must never be
      // extracted/exposed, only the two locked clauses.
      expect(Object.keys(parsed).sort()).toEqual(['maxRounds', 'unanimous']);
      expect(JSON.stringify(parsed)).not.toMatch(/settle|opus|codex/i);
    });

    it('defaults maxRounds to 3 (D7) when the clause is absent or unparseable', () => {
      expect(parseConsensusRule('unanimous').maxRounds).toBe(3);
      expect(parseConsensusRule('').maxRounds).toBe(3);
      expect(parseConsensusRule(null).maxRounds).toBe(3);
      expect(parseConsensusRule('unanimous <=7 rounds').maxRounds).toBe(7);
    });

    it('unanimous reflects only what the rule literally states', () => {
      expect(parseConsensusRule('unanimous <=3 rounds').unanimous).toBe(true);
      expect(parseConsensusRule('<=3 rounds; opus settle').unanimous).toBe(false);
      expect(parseConsensusRule(null).unanimous).toBe(false);
    });
  });
});
