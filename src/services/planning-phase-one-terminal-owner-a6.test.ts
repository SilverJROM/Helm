process.env.USE_FAKE_TMUX = '1'; // FakeTransport enforces this at construction time.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';
import { planRevision } from './plan-revision.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(condition: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for A6 fixture condition');
    await sleep(10);
  }
}

/**
 * A6 (AC5/AC23): every planning terminal exit — success, blocked, AND thrown — must reap the retained
 * plancore/partner transport handles and finalize their worker_runtimes rows through the SAME one
 * terminal owner, in the SAME reap-before-finalize order A5 established. Pre-A6, only the success and
 * blocked exits did this; a thrown exit that happens AFTER partner seats are spawned (e.g. plancore
 * never producing a valid canonical plan.md) left both seats' sessions unreaped and their rows stuck
 * 'running' forever — the "single-brain-only cleanup asymmetry" this batch deletes.
 *
 * This forces exactly that thrown exit: USE_FAKE_TMUX is flipped off for the runPlanningPhase call
 * itself (real, non-fixture branch), valid canonical artifacts are published so C3 can spawn the
 * reviewer, and the reviewer emits a B5-valid CLEAN bound to the current plan.md bytes. The
 * requirements artifact is then removed before canonical ingest, so the method must throw
 * NO-AGREED-PLAN-CANDIDATE (R1.4 rename of PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN — plancore no
 * longer authors this file) AFTER the partner seat has already been spawned and agreed.
 * Ordering is proven the same way A5 proved it:
 * transport.reap is spied, and at the instant it fires the spy reads worker_runtimes.state directly from
 * the DB — 'running' at that instant proves reap ran before finalize.
 */
describe('A6: planning-phase-service routes a thrown exit through the one terminal owner', () => {
  let runDir: string;
  let transport: FakeTransport;
  let tmpDb: string;
  let dbs: DatabaseService;
  let art: RunArtifactService;
  let queue: TaskQueueService;
  let phase: PlanningPhaseService;
  let projectId: number;
  let runId: number;
  let prevTimeoutMs: string | undefined;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-a6-thrown-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# A6 thrown-exit callbacks\n', 'utf8');
    transport = new FakeTransport();
    tmpDb = path.join(os.tmpdir(), `helm-a6-thrown-${process.pid}-${Math.trunc(performance.now() * 1000)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    phase = new PlanningPhaseService(transport, art, queue);

    const projRow = dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get('a6-thrown-proj', '/tmp/a6-thrown-proj') as { id: number };
    projectId = projRow.id;
    const runRow = dbs.raw.prepare(
      `INSERT INTO runs (project_id, batch_id, phase) VALUES (?, ?, 'planning') RETURNING id`
    ).get(projectId, 'batch-A6-thrown') as { id: number };
    runId = runRow.id;

    // Bounds the real-path reqPath poll (and waitForAgreement) to a fast, deterministic single cycle
    // instead of the 10min production default.
    prevTimeoutMs = process.env.HELM_PLANNING_TIMEOUT_MS;
    process.env.HELM_PLANNING_TIMEOUT_MS = '300';
  });

  afterEach(async () => {
    process.env.USE_FAKE_TMUX = '1';
    if (prevTimeoutMs === undefined) delete process.env.HELM_PLANNING_TIMEOUT_MS;
    else process.env.HELM_PLANNING_TIMEOUT_MS = prevTimeoutMs;
    if (dbs) dbs.close();
    if (tmpDb) await fs.rm(tmpDb, { force: true }).catch(() => {});
    if (runDir) await fs.rm(runDir, { recursive: true, force: true }).catch(() => {});
  });

  /** State of the worker_runtimes row for a FakeTransport handle at the instant it is read. */
  function stateForHandle(handle: string): string | null {
    const row = dbs.raw.prepare(`SELECT state FROM worker_runtimes WHERE session = ? ORDER BY id DESC LIMIT 1`)
      .get(handle) as { state: string } | undefined;
    return row?.state ?? null;
  }

  it('thrown exit (plancore never produced a canonical plan.md) reaps + finalizes plancore AND partner before rejecting with the original error', async () => {
    const observedStateAtReap: Record<string, string | null> = {};
    const reapSpy = vi.spyOn(transport, 'reap');
    reapSpy.mockImplementation(async (handle: string, reason?: string) => {
      observedStateAtReap[handle] = stateForHandle(handle);
      return FakeTransport.prototype.reap.call(transport, handle, reason);
    });

    // Flip to the real (non-fixture) branch for this call only; this keeps B5's SHA binding and the
    // canonical artifact checks live.
    process.env.USE_FAKE_TMUX = '0';

    const planMdPath = path.join(runDir, 'plan.md');
    const reqPath = path.join(runDir, 'og-requirements.md');
    const planMarkdown = `# Plan

\`\`\`json
[
  {
    "id": "A6-THROWN-1",
    "batch": "A6",
    "title": "Task whose canonical requirements disappear after agreement",
    "req_refs": ["A6-R1"],
    "assignee": "L1",
    "validator_lane": "L1",
    "effort": "low",
    "type": "feature",
    "deps": [],
    "validation_criteria": "agreement should pass, then canonical ingest should throw"
  }
]
\`\`\`
`;
    await fs.writeFile(planMdPath, planMarkdown, 'utf8');
    await fs.writeFile(reqPath, '- **A6-R1** — requirements exist for reviewer spawn only.\n', 'utf8');
    const currentPlanSha = planRevision(planMarkdown).short12;

    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-A6-thrown',
      northStar: 'Simple single-module feature: add a plan parser that reads json and creates run_tasks.',
      conversationLog: 'Interview notes: clear scope, no cross module risk.',
      mode: 'auto',
      projectId,
      runId,
      roundCap: 1,
    });

    const cbp = path.join(runDir, 'callbacks.md');
    // Agreement is satisfied (both seats convene, with B5's required plan=<sha12> binding) — the throw
    // comes from the canonical artifact read after agreement, not from a blocked gate.
    await sleep(30);
    await fs.appendFile(cbp, `[helm callback] plancore batch-A6-thrown STATUS: PLAN-READY — plan.json written with all fields + deps\n`);
    await waitFor(() => transport.spawnCalls.some((call) => call.role === 'planner' && call.batchId === 'batch-A6-thrown-partner'));
    await fs.appendFile(cbp, `[helm callback] planner batch-A6-thrown-partner STATUS: VERDICT-READY — CLEAN plan=${currentPlanSha}: plan is atomic, deps clean\n`);
    await fs.rm(reqPath, { force: true });

    await expect(p).rejects.toThrow(/NO-AGREED-PLAN-CANDIDATE/);
    process.env.USE_FAKE_TMUX = '1';

    // Both seats' handles were reaped while their rows were still 'running' — reap ran before finalize.
    expect(transport.reapCalls.length).toBe(2); // plancore + 1 partner
    for (const { handle, reason } of transport.reapCalls) {
      expect(observedStateAtReap[handle]).toBe('running');
      expect(reason).toMatch(/^planning-thrown-exit: /);
    }

    // Both rows reached a terminal state — the thrown exit does not leave them stuck 'running' forever.
    const rows = dbs.raw.prepare(
      `SELECT session, state, ended_at FROM worker_runtimes WHERE run_id = ? ORDER BY id`
    ).all(runId) as Array<{ session: string; state: string; ended_at: string | null }>;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.state).toBe('failed');
      expect(row.ended_at).not.toBeNull();
      expect(transport.reapCalls.some((c) => c.handle === row.session)).toBe(true);
    }
  });
});
