process.env.USE_FAKE_TMUX = '1'; // FakeTransport enforces this at construction time.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';
import { planRevision } from './plan-revision.js';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for B6 fixture condition');
    await sleep(10);
  }
}

function canonicalPlanMd(tasks: unknown[]): string {
  return `# Plan\n\n\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\`\n`;
}

/**
 * B6 (AC9): non-convergence must return a typed blocked reason instead of throwing or reading a
 * plan that was not agreed.
 *
 * Bug this proves fixed: `runPlanningPhase` computed `agreed = await waitForAgreement(...)` but did
 * not check it until much later — in between it unconditionally ran the real-path canonical-plan poll
 * loop and a read-or-throw block. So a genuine `agreed:false` (round-cap exhaustion, or B5's
 * current-plan-SHA mismatch) could be masked by a thrown `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN`
 * error (when plan.md/og-requirements.md are absent/invalid), or — worse — silently succeed at
 * reading whatever plan.md happens to be on disk and return it as `plan`, even though no seat ever
 * agreed to it. The fix checks `!agreed` immediately after `waitForAgreement` resolves and returns the
 * typed blocked result before any canonical-plan polling/read/ingest is attempted.
 *
 * Both scenarios below force the REAL (!USE_FAKE_TMUX) branch, because the pre-existing `if (!isFake)`
 * guard around the poll loop already prevented this bug from manifesting under the fixture path (the
 * isFake catch branch silently synthesizes a fixture plan instead of throwing) — the bug is real-path
 * only, so the reproduction must be too.
 */
describe('B6: runPlanningPhase returns a typed blocked reason on non-convergence, never a plan-read failure', () => {
  let runDir: string;
  let transport: FakeTransport;
  let tmpDb: string;
  let dbs: DatabaseService;
  let art: RunArtifactService;
  let queue: TaskQueueService;
  let phase: PlanningPhaseService;
  let prevTimeoutMs: string | undefined;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-b6-nonconv-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# B6 non-convergence callbacks\n', 'utf8');
    transport = new FakeTransport();
    tmpDb = path.join(os.tmpdir(), `helm-b6-nonconv-${process.pid}-${Math.trunc(performance.now() * 1000)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    phase = new PlanningPhaseService(transport, art, queue);
    prevTimeoutMs = process.env.HELM_PLANNING_TIMEOUT_MS;
  });

  afterEach(async () => {
    process.env.USE_FAKE_TMUX = '1';
    if (prevTimeoutMs === undefined) delete process.env.HELM_PLANNING_TIMEOUT_MS;
    else process.env.HELM_PLANNING_TIMEOUT_MS = prevTimeoutMs;
    if (dbs) dbs.close();
    if (tmpDb) await fs.rm(tmpDb, { force: true }).catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  it('no partner agreement ever arrives: resolves (never throws) with the typed blocked reason, no canonical-plan polling', async () => {
    process.env.USE_FAKE_TMUX = '0';
    process.env.HELM_PLANNING_TIMEOUT_MS = '200'; // short, deterministic per-round window

    // Publish canonical artifacts first so C3 allows the reviewer seat to spawn. Then deliberately never
    // post PLAN-READY/VERDICT-READY — this isolates B6's non-agreement path from C3's artifact gate.
    const planMarkdown = canonicalPlanMd([{
      id: 'B6-NOAGREE-1', batch: 'B6', title: 'Task no reviewer ever agrees to',
      req_refs: ['B6-R0'], assignee: 'L1', validator_lane: 'L1', effort: 'low', type: 'feature', deps: [],
      validation_criteria: 'must never be ingested because agreement never arrives',
    }]);
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), '- **B6-R0** — no agreement.\n', 'utf8');
    await fs.writeFile(path.join(runDir, 'plan.md'), planMarkdown, 'utf8');

    // The old code's poll loop (bounded by the SAME env var) plus its read-or-throw block would add at
    // least another ~1000ms (its first retry sleep alone) on top of the ~200ms agreement wait. The fix
    // returns right after the agreement wait and never ingests the otherwise-readable plan.
    const start = Date.now();
    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-B6-no-agreement',
      northStar: 'Simple single-module feature: add a plan parser that reads json and creates run_tasks.',
      conversationLog: 'Interview notes: clear scope, no cross module risk.',
      mode: 'auto',
      roundCap: 1,
    });
    await sleep(5);
    await fs.appendFile(
      path.join(runDir, 'callbacks.md'),
      '[helm callback] plancore batch-B6-no-agreement STATUS: PLANNING\n',
      'utf8'
    );
    await waitFor(() => transport.spawnCalls.some((call) => call.role === 'planner' && call.batchId === 'batch-B6-no-agreement-partner'));
    await fs.appendFile(
      path.join(runDir, 'callbacks.md'),
      '[helm callback] planner batch-B6-no-agreement-partner STATUS: PLANNING\n',
      'utf8'
    );
    const res = await p;
    const elapsed = Date.now() - start;

    expect(res.agreed).toBe(false);
    expect(res.blockedReason).toBeTruthy();
    expect(res.blockedReason).toMatch(/ROUND-CAP-EXHAUSTED/);
    expect(res.blockedReason).toContain('batch-B6-no-agreement-partner');
    expect(res.plan).toEqual({ tasks: [] });
    expect(res.createdTaskIds).toEqual([]);
    expect(res.keyToId).toEqual({});
    expect(res.runId).toBe(0);
    // Bounded by one real-path first-callback poll (~1000ms) plus the ~200ms agreement window — proves
    // no canonical-plan poll loop ran (the pre-fix path adds another >=1000ms poll/read window).
    expect(elapsed).toBeLessThan(1800);

    // The otherwise-readable plan was not ingested on the blocked path.
    expect(res.plan).toEqual({ tasks: [] });
  });

  it('current-plan-SHA mismatch (B5 non-agreement): returns the same typed blocked result, not the plan it never agreed to', async () => {
    process.env.USE_FAKE_TMUX = '0';
    process.env.HELM_PLANNING_TIMEOUT_MS = '200';

    const batchId = 'batch-B6-sha-mismatch';
    const cbp = path.join(runDir, 'callbacks.md');

    // A genuinely valid, readable canonical plan IS present on disk (unlike the first test) — proving
    // this is not merely "the read would have failed anyway". The partner's CLEAN cites a stale SHA
    // that does not match these exact bytes, so B5's binding still refuses agreement.
    const planMarkdown = canonicalPlanMd([{
      id: 'B6-SHA-1', batch: 'B1', title: 'Task the partner never actually reviewed',
      req_refs: ['B6-R1'], assignee: 'L1', validator_lane: 'L1', effort: 'low', type: 'feature', deps: [],
      validation_criteria: 'must never be ingested — the partner CLEAN does not bind to this revision',
    }]);
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), '- **B6-R1** — never agreed.\n', 'utf8');
    await fs.writeFile(path.join(runDir, 'plan.md'), planMarkdown, 'utf8');
    const staleSha = planRevision('# Some other superseded revision\n').short12;
    expect(staleSha).not.toBe(planRevision(planMarkdown).short12);

    const p = phase.runPlanningPhase({
      runDir,
      batchId,
      northStar: 'Simple single-module feature: add a plan parser that reads json and creates run_tasks.',
      conversationLog: 'Interview notes: clear scope, no cross module risk.',
      mode: 'auto',
      roundCap: 1,
    });
    await sleep(5);
    await fs.appendFile(
      cbp,
      `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed with planner; see plan.md\n` +
        `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN plan=${staleSha} reviewed a superseded revision\n`,
      'utf8'
    );

    const res = await p;

    expect(res.agreed).toBe(false);
    expect(res.blockedReason).toMatch(/ROUND-CAP-EXHAUSTED/);
    // The dispositive proof: the real, valid, on-disk plan.md is NEVER surfaced as `plan` — a
    // pre-fix run would have happily read and returned its one real task (B6-SHA-1) here.
    expect(res.plan).toEqual({ tasks: [] });
    expect(res.createdTaskIds).toEqual([]);
    expect(res.keyToId).toEqual({});
  });

  it('agreed path is not regressed: still reads/ingests the canonical plan.md exactly as before', async () => {
    const batchId = 'batch-B6-agreed-path';
    const cbp = path.join(runDir, 'callbacks.md');

    const p = phase.runPlanningPhase({
      runDir,
      batchId,
      northStar: 'Add Lucky 9 card game feature (real build POC).',
      conversationLog: 'Clear single-module feature.',
      mode: 'auto',
    });

    // Existing-compatible fixture pattern (matches the established POCFIX3-realpath test): under the
    // fixture harness, a directly-written valid plan.md/og-requirements.md still wins over the
    // synthesized default fixture, so this proves the SUCCESS branch's read/ingest is unchanged by the
    // B6 reorder — only the blocked branch moved.
    await fs.writeFile(path.join(runDir, 'og-requirements.md'), '- **B6-OK-1** — Lucky 9 works.\n', 'utf8');
    await fs.writeFile(path.join(runDir, 'plan.md'), canonicalPlanMd([{
      id: 'B6-OK-1', batch: 'B1', title: 'Implement core Lucky 9 logic + tests',
      req_refs: ['B6-OK-1'], assignee: 'L1', validator_lane: 'L1', effort: 'med', type: 'feature', deps: [],
      validation_criteria: 'game class present, unit tests pass',
    }]), 'utf8');

    await fs.appendFile(cbp, `[helm callback] plancore ${batchId} STATUS: PLANNING\n`);
    await fs.appendFile(cbp, `[helm callback] planner ${batchId}-partner STATUS: VERDICT-READY — CLEAN: atomic + fields good\n`);
    await fs.appendFile(cbp, `[helm callback] plancore ${batchId} STATUS: PLAN-READY — plan agreed with planner; see plan.md\n`);

    const res = await p;

    expect(res.agreed).toBe(true);
    expect(res.plan.tasks[0].task_key).toBe('B6-OK-1');
    expect(res.createdTaskIds.length).toBeGreaterThan(0);
    expect(res.keyToId['B6-OK-1']).toBeTypeOf('number');
    expect(JSON.parse(await fs.readFile(path.join(runDir, 'plan.json'), 'utf8')).tasks[0].task_key).toBe('B6-OK-1');
  });
});
