// Leg D (batch barrier) — TaskQueueService unit tests: numeric-aware batch comparator, earliest-open-
// batch admission barrier, failed/deferred-batch semantics, structured drain-state classifier, and
// dynamic-task batch resolution (inject inherit / redirect preserve / new batch after last).
import { describe, it, expect } from 'vitest';
import { TaskQueueService } from './task-queue-service.js';
import { compareBatchLabels, resolveTaskBatches, DEFAULT_BATCH } from './execution-plan-parser.js';

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
    let n = q.getNextReady(runId);
    // First: only B1 may dispatch; within B1, 10 (dep-free) before 11 (dep 10). 20 (B2) is barred.
    expect(n).toBe(10);
    // While 10 is in-flight, nothing else is ready (one-in-flight)
    expect(q.getNextReady(runId)).toBeNull();
    order.push(n!); q.markComplete(n!, runId);

    n = q.getNextReady(runId);
    expect(n).toBe(11); // B1 sibling now dep-satisfied — still no B2
    order.push(n!); q.markComplete(n!, runId);

    n = q.getNextReady(runId);
    expect(n).toBe(20); // B1 fully complete → B2 opens
    order.push(n!); q.markComplete(n!, runId);

    expect(order).toEqual([10, 11, 20]);
    expect(q.getNextReady(runId)).toBeNull();
  });

  it('B2 vs B10 numeric ordering (B2 dispatches before B10)', () => {
    const q = new TaskQueueService();
    const runId = 2;
    q.enqueue(runId, 100, [], false, 'B10'); // enqueued first but sorts LAST
    q.enqueue(runId, 2, [], false, 'B2');
    const first = q.getNextReady(runId);
    expect(first).toBe(2); // B2 < B10
    q.markComplete(2, runId);
    expect(q.getNextReady(runId)).toBe(100);
  });

  it('single-batch (all default) plan behaves exactly as before — no barrier beyond deps', () => {
    const q = new TaskQueueService();
    const runId = 3;
    q.enqueue(runId, 1, []);
    q.enqueue(runId, 2, [1]);
    q.enqueue(runId, 3, []);
    const first = q.getNextReady(runId);
    expect([1, 3]).toContain(first); // both dep-free, insertion order → 1
    expect(first).toBe(1);
    q.markComplete(1, runId);
    // 2 and 3 both ready; insertion order → 2
    expect(q.getNextReady(runId)).toBe(2);
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

    const first = q.getNextReady(runId);
    expect([10, 11]).toContain(first); // B1 only
    q.markFailed(first!, runId);        // 10 fails
    const second = q.getNextReady(runId);
    expect(second).toBe(11);            // independent B1 sibling still drains
    q.markComplete(11, runId);

    // B1 now has a failed task → B2 must NOT open. getNextReady == null.
    expect(q.getNextReady(runId)).toBeNull();

    const cls = q.classifyDrainState(runId);
    expect(cls.kind).toBe('failed-block');
    expect(cls.pendingTaskIds).toContain(20);   // B2 task is the pending, never-dispatched work
    expect(cls.blockerTaskIds).toContain(first); // the failed B1 task is the blocker
  });

  it('a deferred earlier-batch task blocks later batches; classifier = deferred-block (precedence over failed)', () => {
    const q = new TaskQueueService();
    const runId = 5;
    q.enqueue(runId, 10, [], false, 'B1');
    q.enqueue(runId, 20, [], false, 'B2');
    const first = q.getNextReady(runId);
    expect(first).toBe(10);
    q.markDeferred(10, runId);
    expect(q.getNextReady(runId)).toBeNull(); // B2 barred by deferred B1
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
    q.markFailed(1, runId);
    const r = q.getNextReady(runId);
    expect(r).toBe(3);             // independent drains
    q.markComplete(3, runId);
    expect(q.getNextReady(runId)).toBeNull();
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
    q.markDeferred(1, runId);
    expect(q.getNextReady(runId)).toBeNull();
    const cls = q.classifyDrainState(runId);
    expect(cls.kind).toBe('deferred-block');
    expect(cls.blockerTaskIds).toContain(1);
  });

  it('dependency cycle surfaces cycle (highest precedence)', () => {
    const q = new TaskQueueService();
    const runId = 8;
    q.enqueue(runId, 1, [2]);
    q.enqueue(runId, 2, [1]);
    expect(q.getNextReady(runId)).toBeNull();
    expect(q.classifyDrainState(runId).kind).toBe('cycle');
  });

  it('all complete → classifier all-complete (no block)', () => {
    const q = new TaskQueueService();
    const runId = 9;
    q.enqueue(runId, 1, [], false, 'B1');
    q.enqueue(runId, 2, [], false, 'B2');
    q.markComplete(1, runId);
    q.markComplete(2, runId);
    expect(q.classifyDrainState(runId).kind).toBe('all-complete');
  });
});

describe('Leg D: dynamic-task batch resolution', () => {
  it('injection inherits the active (in-flight) batch when none supplied', () => {
    const q = new TaskQueueService();
    const runId = 10;
    q.enqueue(runId, 1, [], false, 'B1');
    q.enqueue(runId, 2, [], false, 'B2');
    q.getNextReady(runId); // 1 in-flight (B1)
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
  it('a mark* call for a taskId enqueued under a PRIOR generation of runId is ignored, not applied to the current occupant', () => {
    // SQLite reuses a freed runs.id/run_tasks.id after CASCADE delete. A run's own background dispatch
    // (still awaiting a real callback) can settle AFTER that run was stopped+deleted and call
    // mark*(taskId, runId) against a runId/taskId pair a brand-new run has since reused — this must not
    // silently mark the NEW occupant's live task terminal.
    const q = new TaskQueueService();
    const runId = 30;
    const taskId = 475; // same numeric id reused across "occupants" of runId 30, exactly as SQLite does

    q.enqueue(runId, taskId, [], false, 'A6b'); // occupant #1 (e.g. a prior, now-deleted run)
    q.clearRun(runId); // simulates stop()+cascade-delete: occupant #1's slot is torn down

    q.enqueue(runId, taskId, [], false, 'A6b'); // occupant #2 (the new run, id recycled)
    expect(q.getNextReady(runId)).toBe(taskId); // occupant #2's task is legitimately in flight

    // Occupant #1's orphaned background chain finally settles and calls markFailed with its OWN
    // (now-stale) taskId/runId — this must be rejected, not corrupt occupant #2's in-flight task.
    q.markFailed(taskId, runId);

    expect(q.isBlockedByFailure(taskId)).toBe(false);
    expect(q.classifyDrainState(runId).kind).not.toBe('unknown-pending-stall');
    // occupant #2's task is still genuinely in flight and can still be completed normally.
    q.markComplete(taskId, runId);
    expect(q.classifyDrainState(runId).kind).toBe('all-complete');
  });

  it('a mark* call for the CURRENT generation still applies normally (guard does not over-reject)', () => {
    const q = new TaskQueueService();
    const runId = 31;
    // Belt-and-braces pre-ingest clear (the normal startRunDetached/seedFromCyclePlan pattern) before the
    // real enqueue — same generation throughout, so the guard must NOT reject this run's own writes.
    q.clearRun(runId);
    q.enqueue(runId, 1, [], false, 'A6b');
    q.enqueue(runId, 2, [1], false, 'A6b'); // depends on 1
    q.markFailed(1, runId);
    expect(q.isBlockedByFailure(2)).toBe(true); // the mark applied — 2 is blocked by failed prereq 1
    expect(q.classifyDrainState(runId).kind).toBe('failed-block');
  });
});
