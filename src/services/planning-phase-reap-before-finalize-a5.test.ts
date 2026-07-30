process.env.USE_FAKE_TMUX = '1';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FakeTransport } from './fake-transport.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { DatabaseService } from '../db/database.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * A5 (AC5/AC23): a normal planning terminal exit must reap each seat's retained transport handle
 * BEFORE finalizing its worker_runtimes row to a terminal state — a DB row marked terminal while the
 * live transport session is still up is exactly the leaked session that can poison a retry.
 *
 * Ordering is proven without timing: transport.reap is spied, and at the instant it fires the spy reads
 * the seat's worker_runtimes.state directly from the DB. If reap ran before finalize (the fix), state is
 * still 'running' at that instant. If finalize had already run first (the bug), state would already be
 * 'done'/'reaped'. FakeTransport's handle format (`fake-<role>-<n>`, no colon) equals the `session`
 * column verbatim (registerWorkerRuntime splits on ':' and falls back to the whole handle).
 */
describe('A5: planning-phase-service reaps retained seat handles before DB finalize', () => {
  let runDir: string;
  let transport: FakeTransport;
  let tmpDb: string;
  let dbs: DatabaseService;
  let art: RunArtifactService;
  let queue: TaskQueueService;
  let phase: PlanningPhaseService;
  let projectId: number;
  let runId: number;

  beforeEach(async () => {
    runDir = await fs.mkdtemp(path.join(os.tmpdir(), 'helm-a5-reap-'));
    await fs.writeFile(path.join(runDir, 'callbacks.md'), '# A5 reap-before-finalize callbacks\n', 'utf8');
    transport = new FakeTransport();
    tmpDb = path.join(os.tmpdir(), `helm-a5-reap-${process.pid}-${Math.trunc(performance.now() * 1000)}.db`);
    dbs = new DatabaseService(tmpDb);
    art = new RunArtifactService(dbs);
    queue = new TaskQueueService(art);
    phase = new PlanningPhaseService(transport, art, queue);

    const projRow = dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get('a5-reap-proj', '/tmp/a5-reap-proj') as { id: number };
    projectId = projRow.id;
    const runRow = dbs.raw.prepare(
      `INSERT INTO runs (project_id, batch_id, phase) VALUES (?, ?, 'planning') RETURNING id`
    ).get(projectId, 'batch-A5-reap') as { id: number };
    runId = runRow.id;
  });

  afterEach(async () => {
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

  it('agreed:true — reaps plancore + partner handles while their rows are still running, before finalize marks them done', async () => {
    const observedStateAtReap: Record<string, string | null> = {};
    const reapSpy = vi.spyOn(transport, 'reap');

    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-A5-reap',
      northStar: 'Simple single-module feature: add a plan parser that reads json and creates run_tasks.',
      conversationLog: 'Interview notes: clear scope, no cross module risk.',
      mode: 'auto',
      projectId,
      runId,
    });

    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] plancore batch-A5-reap STATUS: PLAN-READY — plan.json written with all fields + deps\n`);
    await sleep(30);
    await fs.appendFile(cbp, `[helm callback] planner batch-A5-reap-partner STATUS: VERDICT-READY — CLEAN: plan is atomic, deps clean\n`);
    await sleep(30);

    // Snapshot each handle's DB state precisely when reap fires, before letting the real reap run.
    reapSpy.mockImplementation(async (handle: string, reason?: string) => {
      observedStateAtReap[handle] = stateForHandle(handle);
      return FakeTransport.prototype.reap.call(transport, handle, reason);
    });

    const res = await p;
    expect(res.agreed).toBe(true);

    expect(transport.reapCalls.length).toBe(2); // plancore + 1 partner
    for (const { handle, reason } of transport.reapCalls) {
      expect(observedStateAtReap[handle]).toBe('running');
      expect(reason).toBe('planning-phase-complete');
    }

    // Finalize ran after reap: both rows are now terminal ('done'), not the 'running' snapshot above.
    const rows = dbs.raw.prepare(
      `SELECT session, state, ended_at FROM worker_runtimes WHERE run_id = ? ORDER BY id`
    ).all(runId) as Array<{ session: string; state: string; ended_at: string | null }>;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.state).toBe('done');
      expect(row.ended_at).not.toBeNull();
      expect(transport.reapCalls.some((c) => c.handle === row.session)).toBe(true);
    }
  });

  it('agreed:false — reaps plancore + partner handles while their rows are still running, before finalize marks them reaped', async () => {
    const observedStateAtReap: Record<string, string | null> = {};
    const reapSpy = vi.spyOn(transport, 'reap');
    reapSpy.mockImplementation(async (handle: string, reason?: string) => {
      observedStateAtReap[handle] = stateForHandle(handle);
      return FakeTransport.prototype.reap.call(transport, handle, reason);
    });

    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-A5-reap-blocked',
      northStar: 'Simple single-module feature: add a plan parser that reads json and creates run_tasks.',
      conversationLog: 'Interview notes: clear scope, no cross module risk.',
      mode: 'auto',
      projectId,
      runId,
      roundCap: 1,
    });

    // Never satisfy the gate (no PLAN-READY / VERDICT-READY) — bounded timeout drives agreed:false.
    const res = await p;
    expect(res.agreed).toBe(false);

    expect(transport.reapCalls.length).toBe(2); // plancore + 1 partner
    for (const { handle, reason } of transport.reapCalls) {
      expect(observedStateAtReap[handle]).toBe('running');
      expect(reason).toBe('planning-not-agreed');
    }

    const rows = dbs.raw.prepare(
      `SELECT session, state, ended_at FROM worker_runtimes WHERE run_id = ? AND correlation_id LIKE 'batch-A5-reap-blocked%' ORDER BY id`
    ).all(runId) as Array<{ session: string; state: string; ended_at: string | null }>;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.state).toBe('reaped');
      expect(row.ended_at).not.toBeNull();
      expect(transport.reapCalls.some((c) => c.handle === row.session)).toBe(true);
    }
  });

  it('idempotent: reaping an already-reaped handle a second time does not throw and leaves it reaped', async () => {
    const p = phase.runPlanningPhase({
      runDir,
      batchId: 'batch-A5-reap-idem',
      northStar: 'Simple single-module feature: add a plan parser that reads json and creates run_tasks.',
      conversationLog: 'Interview notes: clear scope, no cross module risk.',
      mode: 'auto',
      projectId,
      runId,
    });

    const cbp = path.join(runDir, 'callbacks.md');
    await fs.appendFile(cbp, `[helm callback] plancore batch-A5-reap-idem STATUS: PLAN-READY — plan.json written with all fields + deps\n`);
    await sleep(30);
    await fs.appendFile(cbp, `[helm callback] planner batch-A5-reap-idem-partner STATUS: VERDICT-READY — CLEAN: plan is atomic, deps clean\n`);
    await sleep(30);

    const res = await p;
    expect(res.agreed).toBe(true);
    expect(transport.reapCalls.length).toBe(2);

    const [plancoreCall] = transport.reapCalls;
    await expect(transport.reap(plancoreCall.handle, 'planning-phase-complete')).resolves.toBeUndefined();
    // A second reap on the same handle is a no-op — no new entry recorded.
    expect(transport.reapCalls.length).toBe(2);
  });
});
