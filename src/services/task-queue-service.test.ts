// Leg D (batch barrier) — TaskQueueService unit tests: numeric-aware batch comparator, earliest-open-
// batch admission barrier, failed/deferred-batch semantics, structured drain-state classifier, and
// dynamic-task batch resolution (inject inherit / redirect preserve / new batch after last).
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { TaskQueueService } from './task-queue-service.js';
import { compareBatchLabels, resolveTaskBatches, DEFAULT_BATCH } from './execution-plan-parser.js';
import { DatabaseService } from '../db/database.js';
import { RunArtifactService } from './run-artifact-service.js';
import { allocateLifecycleGeneration, advanceLifecycleSeqAtLeast } from './lifecycle-cas.js';
import {
  RunIngestService,
  RUN_REGISTER_ENVELOPE,
  computeRunRegisterPayloadHash,
} from './run-ingest-service.js';

describe('Leg D: numeric-aware batch comparator (compareBatchLabels)', () => {
  const lt = (a: string, b: string) => expect(compareBatchLabels(a, b)).toBeLessThan(0);
  const eq = (a: string, b: string) => expect(compareBatchLabels(a, b)).toBe(0);

  it('orders digit runs by integer magnitude (B2 < B10, never lexical B10 < B2)', () => {
    lt('B2', 'B10');
    lt('B1', 'B2');
    lt('B9', 'B10');
    lt('B10', 'B100');
    expect(compareBatchLabels('B10', 'B2')).toBeGreaterThan(0);
  });

  it('is stable when sorted (natural order across a mixed set)', () => {
    const arr = ['B10', 'B1', 'B2', 'B21', 'B3'];
    arr.sort(compareBatchLabels);
    expect(arr).toEqual(['B1', 'B2', 'B3', 'B10', 'B21']);
  });

  it('case-folds non-digit runs (natural-run comparison) and tolerates whitespace', () => {
    eq('B1', ' B1 ');                 // identical after trim
    lt('batch2', 'BATCH10');          // casefold batch==BATCH, then 2 < 10 by magnitude
    lt('A1', 'B1');                   // 'a' < 'b'
  });

  it('handles leading zeros by integer magnitude (B09 < B10); magnitude ties break on the full string', () => {
    lt('B09', 'B10');
    // 01 and 1 are magnitude-equal → deterministic tie-break on the case-preserved full string (B01 < B1).
    expect(compareBatchLabels('B01', 'B1')).toBeLessThan(0);
  });

  it("'default' is a normal label (used only when ALL tasks are unlabeled)", () => {
    expect(compareBatchLabels('default', 'default')).toBe(0);
  });
});

describe('Leg D: resolveTaskBatches (all-labeled | all-default | mixed-reject)', () => {
  it('all tasks labeled → trimmed labels preserved', () => {
    const r = resolveTaskBatches([{ batch: 'B1' }, { batch: ' B2 ' }]);
    expect(r).toEqual({ ok: true, batches: ['B1', 'B2'] });
  });
  it('no task labeled → every task resolves to the synthetic default batch', () => {
    const r = resolveTaskBatches([{}, { batch: null }, { batch: '   ' }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.batches).toEqual([DEFAULT_BATCH, DEFAULT_BATCH, DEFAULT_BATCH]);
  });
  it('MIXED (some labeled, some not) → REJECT (barrier bypass)', () => {
    const r = resolveTaskBatches([{ batch: 'B1' }, {}]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/mixed batch labeling/);
  });
});

describe('Leg D: TaskQueueService earliest-open-batch admission barrier', () => {
  it('dispatches strictly by batch order regardless of enqueue order; a later batch waits for ALL earlier-batch tasks to complete', () => {
    const q = new TaskQueueService();
    const runId = 1;
    // Adversarial enqueue order: the B2 task (id 20) is enqueued FIRST and has no dep; the B1 tasks come
    // after. Insertion-order dispatch would pick 20 first; the barrier must dispatch B1 first.
    q.enqueue(runId, 20, [], false, 'B2'); // B2, no dep
    q.enqueue(runId, 11, [10], false, 'B1'); // B1, dep on 10
    q.enqueue(runId, 10, [], false, 'B1'); // B1, no dep

    const order: number[] = [];
    let n = q.claimNextReady(runId);
    // First: only B1 may dispatch; within B1, 10 (dep-free) before 11 (dep 10). 20 (B2) is barred.
    expect(n!.taskId).toBe(10);
    // While 10 is in-flight, nothing else is ready (one-in-flight)
    expect(q.claimNextReady(runId)).toBeNull();
    order.push(n!.taskId); q.markComplete(n!);

    n = q.claimNextReady(runId);
    expect(n!.taskId).toBe(11); // B1 sibling now dep-satisfied — still no B2
    order.push(n!.taskId); q.markComplete(n!);

    n = q.claimNextReady(runId);
    expect(n!.taskId).toBe(20); // B1 fully complete → B2 opens
    order.push(n!.taskId); q.markComplete(n!);

    expect(order).toEqual([10, 11, 20]);
    expect(q.claimNextReady(runId)).toBeNull();
  });

  it('B2 vs B10 numeric ordering (B2 dispatches before B10)', () => {
    const q = new TaskQueueService();
    const runId = 2;
    q.enqueue(runId, 100, [], false, 'B10'); // enqueued first but sorts LAST
    q.enqueue(runId, 2, [], false, 'B2');
    const first = q.claimNextReady(runId);
    expect(first!.taskId).toBe(2); // B2 < B10
    q.markComplete(first!);
    expect(q.claimNextReady(runId)!.taskId).toBe(100);
  });

  it('single-batch (all default) plan behaves exactly as before — no barrier beyond deps', () => {
    const q = new TaskQueueService();
    const runId = 3;
    q.enqueue(runId, 1, []);
    q.enqueue(runId, 2, [1]);
    q.enqueue(runId, 3, []);
    const first = q.claimNextReady(runId);
    expect([1, 3]).toContain(first!.taskId); // both dep-free, insertion order → 1
    expect(first!.taskId).toBe(1);
    q.markComplete(first!);
    // 2 and 3 both ready; insertion order → 2
    expect(q.claimNextReady(runId)!.taskId).toBe(2);
  });
});

describe('Leg D: failed/deferred batch semantics + classifyDrainState', () => {
  it('a failed earlier-batch task blocks ALL later batches; independent same-batch siblings still drain; classifier = failed-block', () => {
    const q = new TaskQueueService();
    const runId = 4;
    // B1: task 10 fails, task 11 independent succeeds. B2: task 20 (ready, no dep).
    q.enqueue(runId, 10, [], false, 'B1');
    q.enqueue(runId, 11, [], false, 'B1');
    q.enqueue(runId, 20, [], false, 'B2');

    const first = q.claimNextReady(runId);
    expect([10, 11]).toContain(first!.taskId); // B1 only
    q.markFailed(first!);        // 10 fails
    const second = q.claimNextReady(runId);
    expect(second!.taskId).toBe(11);            // independent B1 sibling still drains
    q.markComplete(second!);

    // B1 now has a failed task → B2 must NOT open. claimNextReady == null.
    expect(q.claimNextReady(runId)).toBeNull();

    const cls = q.classifyDrainState(runId);
    expect(cls.kind).toBe('failed-block');
    expect(cls.pendingTaskIds).toContain(20);   // B2 task is the pending, never-dispatched work
    expect(cls.blockerTaskIds).toContain(first!.taskId); // the failed B1 task is the blocker
  });

  it('a deferred earlier-batch task blocks later batches; classifier = deferred-block (precedence over failed)', () => {
    const q = new TaskQueueService();
    const runId = 5;
    q.enqueue(runId, 10, [], false, 'B1');
    q.enqueue(runId, 20, [], false, 'B2');
    const first = q.claimNextReady(runId);
    expect(first!.taskId).toBe(10);
    q.markDeferred(first!);
    expect(q.claimNextReady(runId)).toBeNull(); // B2 barred by deferred B1
    const cls = q.classifyDrainState(runId);
    expect(cls.kind).toBe('deferred-block');
    expect(cls.pendingTaskIds).toContain(20);
    expect(cls.blockerTaskIds).toContain(10);
  });

  it('explicit failed-dependent (single batch) surfaces failed-block; independent siblings drain', () => {
    const q = new TaskQueueService();
    const runId = 6;
    q.enqueue(runId, 1, []);       // fails
    q.enqueue(runId, 2, [1]);      // dependent — stays pending
    q.enqueue(runId, 3, []);       // independent — completes
    q.markFailed(q.freezeTerminalToken(runId, 1)!);
    const r = q.claimNextReady(runId);
    expect(r!.taskId).toBe(3);             // independent drains
    q.markComplete(r!);
    expect(q.claimNextReady(runId)).toBeNull();
    const cls = q.classifyDrainState(runId);
    expect(cls.kind).toBe('failed-block');
    expect(cls.pendingTaskIds).toContain(2);
    expect(cls.blockerTaskIds).toContain(1);
  });

  it('explicit deferred-dependent (single batch) surfaces deferred-block (distinct reason)', () => {
    const q = new TaskQueueService();
    const runId = 7;
    q.enqueue(runId, 1, []);
    q.enqueue(runId, 2, [1]);
    q.markDeferred(q.freezeTerminalToken(runId, 1)!);
    expect(q.claimNextReady(runId)).toBeNull();
    const cls = q.classifyDrainState(runId);
    expect(cls.kind).toBe('deferred-block');
    expect(cls.blockerTaskIds).toContain(1);
  });

  it('dependency cycle surfaces cycle (highest precedence)', () => {
    const q = new TaskQueueService();
    const runId = 8;
    q.enqueue(runId, 1, [2]);
    q.enqueue(runId, 2, [1]);
    expect(q.claimNextReady(runId)).toBeNull();
    expect(q.classifyDrainState(runId).kind).toBe('cycle');
  });

  it('all complete → classifier all-complete (no block)', () => {
    const q = new TaskQueueService();
    const runId = 9;
    q.enqueue(runId, 1, [], false, 'B1');
    q.enqueue(runId, 2, [], false, 'B2');
    q.markComplete(q.freezeTerminalToken(runId, 1)!);
    q.markComplete(q.freezeTerminalToken(runId, 2)!);
    expect(q.classifyDrainState(runId).kind).toBe('all-complete');
  });
});

describe('Leg D: dynamic-task batch resolution', () => {
  it('injection inherits the active (in-flight) batch when none supplied', () => {
    const q = new TaskQueueService();
    const runId = 10;
    q.enqueue(runId, 1, [], false, 'B1');
    q.enqueue(runId, 2, [], false, 'B2');
    q.claimNextReady(runId); // 1 in-flight (B1)
    q.enqueueTask(runId, 99, true); // injected mid-B1, no explicit batch
    expect(q.batchOfTask(99)).toBe('B1');
  });

  it('redirect preserves the task’s persisted batch + explicit deps', () => {
    const q = new TaskQueueService();
    const runId = 11;
    q.enqueue(runId, 1, [], false, 'B1');
    q.enqueue(runId, 5, [1], false, 'B2');
    q.requeueForRedirect(runId, 5);
    expect(q.batchOfTask(5)).toBe('B2'); // preserved, not reset to default
  });

  it('newBatchAfterLast (labeled run) mints a label strictly after every existing batch: B1+B10→B11, B1+B2→B3', () => {
    const q = new TaskQueueService();
    const runId = 12;
    q.enqueue(runId, 1, [], false, 'B1');
    q.enqueue(runId, 2, [], false, 'B10');
    const nb = q.newBatchAfterLast(runId);
    expect(compareBatchLabels(nb, 'B10')).toBeGreaterThan(0);
    expect(nb).toBe('B11');

    // A B1+B2 run still mints B3 (labeled case unchanged by the legacy guard).
    const q2 = new TaskQueueService();
    q2.enqueue(99, 1, [], false, 'B1');
    q2.enqueue(99, 2, [], false, 'B2');
    expect(q2.newBatchAfterLast(99)).toBe('B3');
  });

  it('newBatchAfterLast on an all-default (legacy single-queue) run returns default UNCHANGED (never default1) so the injected final-fix stays un-gated', () => {
    const q = new TaskQueueService();
    const runId = 13;
    q.enqueue(runId, 1, []); // default
    q.enqueue(runId, 2, []); // default
    // Reviewer oracle: FAILS pre-fix (returned 'default1'), passes post-fix.
    expect(q.newBatchAfterLast(runId)).toBe(DEFAULT_BATCH);
  });
});

describe('A6b-L3: clearRun generation guard (recycled runId/taskId poisoning a new occupant)', () => {
  it('a mark* call with a PRIOR claim token is ignored, not applied to the current occupant', () => {
    // B03 C1: production holds the claim-time TaskTerminalToken through async. After clearRun+recycle,
    // settling with that token must not terminalize B.
    const q = new TaskQueueService();
    const runId = 30;
    const taskId = 475;

    q.enqueue(runId, taskId, [], false, 'A6b'); // occupant #1
    const tokenA = q.claimNextReady(runId);
    expect(tokenA).toBeTruthy();
    expect(tokenA!.taskId).toBe(taskId);

    q.clearRun(runId); // occupant #1 torn down (tokenA still held by "async" A)

    q.enqueue(runId, taskId, [], false, 'A6b'); // occupant #2, same numeric ids
    const tokenB = q.claimNextReady(runId);
    expect(tokenB).toBeTruthy();
    expect(tokenB!.taskId).toBe(taskId);
    expect(tokenB!.runGeneration).not.toBe(tokenA!.runGeneration);

    // Occupant #1's orphaned chain settles with its IMMUTABLE claim token — must not corrupt B.
    expect(q.markFailed(tokenA!)).toBe(false);
    expect(q.isInFlight(runId)).toBe(true);
    expect(q.classifyDrainState(runId).kind).not.toBe('all-complete');

    // Occupant #2 still completes with its own claim token.
    expect(q.markComplete(tokenB!)).toBe(true);
    expect(q.classifyDrainState(runId).kind).toBe('all-complete');
  });

  it('a mark* call for the CURRENT generation still applies normally (guard does not over-reject)', () => {
    const q = new TaskQueueService();
    const runId = 31;
    q.clearRun(runId);
    q.enqueue(runId, 1, [], false, 'A6b');
    q.enqueue(runId, 2, [1], false, 'A6b');
    const tok1 = q.freezeTerminalToken(runId, 1)!;
    expect(q.markFailed(tok1)).toBe(true);
    expect(q.isBlockedByFailure(2)).toBe(true);
    expect(q.classifyDrainState(runId).kind).toBe('failed-block');
  });
});

// ---------------------------------------------------------------------------
// B03 / AC7 — durable TaskQueue terminal CAS on run_id + expected status + runs.generation
// ---------------------------------------------------------------------------
describe('B03/AC7: durable task terminal CAS (run_id + status + generation)', () => {
  let dbPath: string;
  let db: DatabaseService;
  let artifacts: RunArtifactService;
  let cleanup: () => void;

  beforeEach(() => {
    dbPath = path.join(os.tmpdir(), `helm-b03-tq-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    db = new DatabaseService(dbPath);
    artifacts = new RunArtifactService(db);
    cleanup = () => {
      try { db.close(); } catch { /* ignore */ }
      for (const suf of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + suf); } catch { /* ignore */ }
      }
    };
  });
  afterEach(() => cleanup());

  it('createRun allocates a nonzero lifecycle generation (not default 0)', () => {
    const runId = artifacts.createRun(null, 'b03-gen');
    const row = db.raw.prepare('SELECT generation FROM runs WHERE id = ?').get(runId) as { generation: number };
    expect(row.generation).toBeGreaterThan(0);
    const runId2 = artifacts.createRun(null, 'b03-gen-2');
    const row2 = db.raw.prepare('SELECT generation FROM runs WHERE id = ?').get(runId2) as { generation: number };
    expect(row2.generation).toBeGreaterThan(row.generation);
  });

  it('current lifecycle complete/fail/defer still advance durable + in-mem', () => {
    const q = new TaskQueueService(artifacts);
    const runId = artifacts.createRun(null, 'b03-happy');
    const tComplete = artifacts.recordTask(runId, 'T-c', 'complete-me', 'B1');
    const tFail = artifacts.recordTask(runId, 'T-f', 'fail-me', 'B1');
    const tDefer = artifacts.recordTask(runId, 'T-d', 'defer-me', 'B1');
    q.enqueue(runId, tComplete, [], false, 'B1');
    q.enqueue(runId, tFail, [], false, 'B1');
    q.enqueue(runId, tDefer, [], false, 'B1');

    expect(q.markComplete(q.freezeTerminalToken(runId, tComplete)!)).toBe(true);
    expect(q.markFailed(q.freezeTerminalToken(runId, tFail)!)).toBe(true);
    expect(q.markDeferred(q.freezeTerminalToken(runId, tDefer)!)).toBe(true);

    expect(
      db.raw.prepare('SELECT status FROM run_tasks WHERE id = ?').get(tComplete)
    ).toEqual({ status: 'complete' });
    expect(
      db.raw.prepare('SELECT status FROM run_tasks WHERE id = ?').get(tFail)
    ).toEqual({ status: 'failed' });
    expect(
      db.raw.prepare('SELECT status FROM run_tasks WHERE id = ?').get(tDefer)
    ).toEqual({ status: 'deferred' });
    expect(q.classifyDrainState(runId).kind).toBe('all-complete');
  });

  it('C1-R2: numeric late-recapture (taskId, runId) is unavailable; mark* is token-only', () => {
    // Redteam R2: mark*(staleTaskId, R) after getNextReady discarded identity must not exist.
    const q = new TaskQueueService(artifacts);
    const runId = artifacts.createRun(null, 'b03-c1-r2');
    const taskId = artifacts.recordTask(runId, 'T-r2', 'no-numeric-mark', 'B1');
    q.enqueue(runId, taskId, [], false, 'B1');
    const tokenA = q.claimNextReady(runId)!;

    // Compile/runtime: mark* arity is 1 (token only). Numeric (taskId, runId) is not a valid call.
    expect(q.markFailed.length).toBe(1);
    expect(q.markComplete.length).toBe(1);
    expect(q.markDeferred.length).toBe(1);
    // getNextReady removed — claimNextReady is the only claim API.
    expect((q as any).getNextReady).toBeUndefined();
    // Calling mark* with a number must not be accepted as a taskId (token shape required).
    expect(q.markFailed(taskId as any)).toBe(false);
    expect(q.markFailed({ taskId, runId } as any)).toBe(false); // missing runGeneration
    // Held claim token still works.
    expect(q.markComplete(tokenA)).toBe(true);
    expect(
      db.raw.prepare('SELECT status FROM run_tasks WHERE id = ?').get(taskId)
    ).toEqual({ status: 'complete' });
  });

  it('C1 production-path: A claim held through clearRun+B reuses ids; A markFailed leaves B durable+mem intact', () => {
    // Exact redteam C1 sequence: same TaskQueueService instance (production shape).
    const q = new TaskQueueService(artifacts);
    const runId = artifacts.createRun(null, 'b03-c1');
    const taskId = artifacts.recordTask(runId, 'T1', 'c1-recycle', 'B1');
    const genA = (
      db.raw.prepare('SELECT generation FROM runs WHERE id = ?').get(runId) as { generation: number }
    ).generation;
    q.enqueue(runId, taskId, [], false, 'B1', genA);

    // A claims/dispatches and holds the immutable token across the "async" gap.
    const tokenA = q.claimNextReady(runId);
    expect(tokenA).toBeTruthy();
    expect(tokenA!.taskId).toBe(taskId);
    expect(tokenA!.runGeneration).toBe(genA);
    expect(tokenA!.runId).toBe(runId);

    // A deleted; B reuses exact numeric ids with a new durable generation.
    const genB = genA + 1000;
    db.raw.prepare('UPDATE runs SET generation = ? WHERE id = ?').run(genB, runId);
    // Keep the same run_tasks row (recycled id shape); reset to pending for B.
    db.raw
      .prepare("UPDATE run_tasks SET status='pending', updated_at=datetime('now') WHERE id=? AND run_id=?")
      .run(taskId, runId);
    q.clearRun(runId);
    q.enqueue(runId, taskId, [], false, 'B1', genB);
    const tokenB = q.claimNextReady(runId);
    expect(tokenB).toBeTruthy();
    expect(tokenB!.runGeneration).toBe(genB);
    expect(tokenB!.runGeneration).not.toBe(tokenA!.runGeneration);

    // A settles markFailed with its claim token — must NOT adopt B's mutable map gen.
    expect(q.markFailed(tokenA!)).toBe(false);

    const row = db.raw.prepare('SELECT status FROM run_tasks WHERE id = ?').get(taskId) as { status: string };
    expect(row.status).toBe('pending'); // B still non-terminal
    expect(q.isInFlight(runId)).toBe(true); // B still in flight
    // B can still complete with its own claim token.
    expect(q.markComplete(tokenB!)).toBe(true);
    expect(
      db.raw.prepare('SELECT status FROM run_tasks WHERE id = ?').get(taskId)
    ).toEqual({ status: 'complete' });
  });

  it('missing generation on token fail-closes (no durable write, no in-mem mutation)', () => {
    const q = new TaskQueueService(artifacts);
    const runId = artifacts.createRun(null, 'b03-failclosed');
    const taskId = artifacts.recordTask(runId, 'T-fc', 'fail-closed', 'B1');
    q.enqueue(runId, taskId, [], false, 'B1');
    q.claimNextReady(runId);

    const bogus = Object.freeze({
      taskId,
      runId,
      runGeneration: Number.NaN,
      expectedStatus: 'pending' as const,
    });
    expect(q.markFailed(bogus)).toBe(false);
    expect(q.isInFlight(runId)).toBe(true);
    expect(
      db.raw.prepare('SELECT status FROM run_tasks WHERE id = ?').get(taskId)
    ).toEqual({ status: 'pending' });
  });

  it('SQL predicates include run_id + expected status + runs.generation (not WHERE id=? only)', () => {
    const q = new TaskQueueService(artifacts);
    const runId = artifacts.createRun(null, 'b03-sql');
    const taskId = artifacts.recordTask(runId, 'T-sql', 'sql-fence', 'B1');
    const gen = (
      db.raw.prepare('SELECT generation FROM runs WHERE id = ?').get(runId) as { generation: number }
    ).generation;
    q.enqueue(runId, taskId, [], false, 'B1', gen);
    const token = q.freezeTerminalToken(runId, taskId)!;

    // Wrong run_id → 0 rows
    const wrongRun = db.raw
      .prepare(
        `UPDATE run_tasks
         SET status = 'complete', updated_at = datetime('now')
         WHERE id = ?
           AND run_id = ?
           AND (status = ? OR (? = 'pending' AND status = 'working'))
           AND EXISTS (SELECT 1 FROM runs r WHERE r.id = run_tasks.run_id AND r.generation = ?)`
      )
      .run(taskId, runId + 99999, token.expectedStatus, token.expectedStatus, gen) as { changes: number };
    expect(wrongRun.changes).toBe(0);

    // Wrong generation → 0 rows
    const wrongGen = db.raw
      .prepare(
        `UPDATE run_tasks
         SET status = 'failed', updated_at = datetime('now')
         WHERE id = ?
           AND run_id = ?
           AND (status = ? OR (? = 'pending' AND status = 'working'))
           AND EXISTS (SELECT 1 FROM runs r WHERE r.id = run_tasks.run_id AND r.generation = ?)`
      )
      .run(taskId, runId, token.expectedStatus, token.expectedStatus, gen + 1) as { changes: number };
    expect(wrongGen.changes).toBe(0);

    expect(q.markComplete(token)).toBe(true);
    // Replay same token against already-terminal row → 0 rows / fail closed
    expect(q.markComplete(token)).toBe(false);
    expect(
      db.raw.prepare('SELECT status FROM run_tasks WHERE id = ?').get(taskId)
    ).toEqual({ status: 'complete' });
  });

  it('stale durable CAS does not mutate in-memory queue state', () => {
    const q = new TaskQueueService(artifacts);
    const runId = artifacts.createRun(null, 'b03-mem');
    const taskId = artifacts.recordTask(runId, 'T-mem', 'mem-fence', 'B1');
    const gen = (
      db.raw.prepare('SELECT generation FROM runs WHERE id = ?').get(runId) as { generation: number }
    ).generation;
    q.enqueue(runId, taskId, [], false, 'B1', gen);
    const token = q.claimNextReady(runId)!;
    expect(token.runGeneration).toBe(gen);

    // Force mismatch: durable gen moved under the captured token
    db.raw.prepare('UPDATE runs SET generation = ? WHERE id = ?').run(gen + 7, runId);
    expect(q.markFailed(token)).toBe(false);

    expect(q.isInFlight(runId)).toBe(true);
    expect(
      db.raw.prepare('SELECT status FROM run_tasks WHERE id = ?').get(taskId)
    ).toEqual({ status: 'pending' });
  });

  it('B01 residual C1: ingest free-gen advances lifecycle_seq so next native alloc is above it', () => {
    db.raw
      .prepare(
        "INSERT INTO projects (id, name, directory, status, active) VALUES (1, 'Helm-B03', '/tmp/b03', 'active', 1)"
      )
      .run();
    // Drain a couple of native allocs first so seq is live.
    allocateLifecycleGeneration(db.raw);
    const before = db.raw
      .prepare(`SELECT next FROM lifecycle_seq WHERE name = 'global'`)
      .get() as { next: number };

    const freeGen = before.next + 50; // caller-supplied gen well above current counter
    const hashes = {
      ready: createHash('sha256').update('r').digest('hex'),
      plan: createHash('sha256').update('p').digest('hex'),
      queue: createHash('sha256').update('q').digest('hex'),
      topology: createHash('sha256').update('t').digest('hex'),
    };
    const fields = {
      event_id: 'b03-c1-event',
      external_run_id: 'ext-b03-c1',
      generation: freeGen,
      hashes,
    };
    const payload_hash = computeRunRegisterPayloadHash(1, fields);
    const service = new RunIngestService(db);
    const result = service.register(1, {
      envelope: RUN_REGISTER_ENVELOPE,
      ...fields,
      payload_hash,
    });
    expect(result.httpStatus).toBe(201);

    const after = db.raw
      .prepare(`SELECT next FROM lifecycle_seq WHERE name = 'global'`)
      .get() as { next: number };
    expect(after.next).toBeGreaterThanOrEqual(freeGen + 1);

    const nextNative = allocateLifecycleGeneration(db.raw);
    expect(nextNative).toBeGreaterThanOrEqual(freeGen + 1);

    // Helper is idempotent when already above
    advanceLifecycleSeqAtLeast(db.raw, freeGen + 1);
    const still = db.raw
      .prepare(`SELECT next FROM lifecycle_seq WHERE name = 'global'`)
      .get() as { next: number };
    expect(still.next).toBeGreaterThanOrEqual(freeGen + 1);
  });
});
