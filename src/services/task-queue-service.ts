import { RunArtifactService } from './run-artifact-service.js';
import { compareBatchLabels, DEFAULT_BATCH } from './execution-plan-parser.js';
import type { TaskExpectedStatus, TaskTerminalToken } from './lifecycle-cas.js';

export type { TaskExpectedStatus, TaskTerminalToken } from './lifecycle-cas.js';

/**
 * Structured drain-state classification (Leg D §4). Produced by classifyDrainState after a drain so the
 * run-orchestrator has ONE terminal decision instead of letting downstream completion logic continue.
 * ids are queue task ids; the orchestrator enriches them with task_key/status/batch from the DB.
 */
export type DrainKind =
  | 'cycle'                  // (1) dependency cycle among unresolved pending tasks
  | 'deferred-block'         // (2) deferred/parked prereq OR deferred earlier batch
  | 'failed-block'           // (3) failed prereq OR failed earlier batch
  | 'unknown-pending-stall'  // (4) pending-after-drain with no cycle/failed/deferred blocker (fail-safe)
  | 'all-complete';          // (5) no pending/working remain in the queue (proceed to normal completion)

export interface DrainClassification {
  kind: DrainKind;
  reason: string;
  pendingTaskIds: number[];
  blockerTaskIds: number[];
}

/**
 * B6 DSP8: minimal queue service for orchestrator task ordering.
 * - Exactly one active (in-flight) at a time.
 * - Unmet deps or failed prereqs block a task from ready.
 * - Normal enqueue appends to end.
 * - URGENT enqueue places immediately after current in-flight (never mid-task).
 * - Failed task blocks dependents (they stay non-ready).
 *
 * Leg D (batch barrier): each task now carries a durable normalized `batch` label. getNextReady enforces
 * an EARLIEST-OPEN-BATCH admission barrier — only pending tasks from the earliest batch with any
 * non-complete task may be dispatched; a later batch cannot open until every task in every earlier batch
 * is complete. A failed OR deferred earlier-batch task blocks ALL later batches (independent siblings in
 * its own batch still drain). Ordering is numeric-aware natural order over the batch label — never the
 * plan-array order, never the task-key.
 *
 * Uses in-mem graph + optional RunArtifactService for run_tasks status/attempt visibility.
 */
export class TaskQueueService {
  private queues: Record<number, number[]> = {}; // runId -> ordered task ids (front is next or in-flight)
  private deps: Record<number, number[]> = {}; // taskId -> prerequisite taskIds
  private inFlight: Record<number, number | null> = {};
  private failedTasks: Set<number> = new Set();
  private deferredTasks: Set<number> = new Set();
  private completedTasks: Set<number> = new Set();
  // Leg D: durable-per-run batch state. batchOf is queryable (never re-derived from plan.json); allTasks
  // retains EVERY enqueued task id for the run (never pruned) so the barrier + classifier see failed /
  // deferred / complete tasks that markComplete/markDeferred remove from the live `queues` array.
  private batchOf: Record<number, string> = {}; // taskId -> resolved batch label
  private allTasks: Record<number, number[]> = {}; // runId -> every enqueued task id (append-only)
  // A6b-L3 / B03 C1: SQLite reuses freed runs.id/run_tasks.id after CASCADE. A run's async dispatch
  // can settle after clearRun+recycle and call mark* with STALE ids that now belong to a new occupant.
  // Process-local runEpoch is used only to *seed* a synthetic generation at enqueue when no durable
  // runs.generation is available (pure in-mem tests). Production identity is the immutable
  // TaskTerminalToken captured at claimNextReady — mark* never re-reads generation from taskId maps.
  private runEpoch: Record<number, number> = {}; // runId -> process-local epoch, bumped every clearRun
  // Enqueue-time generation seed (durable runs.generation or synthetic epoch). Read only at claim to
  // freeze into TaskTerminalToken; mark* must not consult this map.
  private taskRunGeneration: Record<number, number> = {};

  constructor(private readonly artifacts?: RunArtifactService) {}

  /**
   * Resolve generation to freeze at enqueue. Explicit arg > SELECT runs.generation > process-local
   * epoch (pure in-mem). Always returns a finite number so claim can build a complete token.
   */
  private resolveEnqueueGeneration(runId: number, explicit?: number): number {
    if (explicit != null && Number.isFinite(explicit) && explicit >= 0) return Number(explicit);
    if (this.artifacts) {
      try {
        const row = this.artifacts['db'].raw
          .prepare('SELECT generation FROM runs WHERE id = ?')
          .get(runId) as { generation: number } | undefined;
        if (row && typeof row.generation === 'number' && Number.isFinite(row.generation)) {
          return row.generation;
        }
      } catch {
        /* fall through to epoch */
      }
    }
    return this.runEpoch[runId] || 0;
  }

  private readTaskExpectedStatus(runId: number, taskId: number): TaskExpectedStatus {
    if (!this.artifacts) return 'pending';
    try {
      const row = this.artifacts['db'].raw
        .prepare('SELECT status FROM run_tasks WHERE id = ? AND run_id = ?')
        .get(taskId, runId) as { status: string } | undefined;
      if (row?.status === 'working') return 'working';
    } catch {
      /* default pending */
    }
    return 'pending';
  }

  /**
   * Freeze an immutable terminal token for a task that is already enqueued (claim/dispatch boundary).
   * Does not set inFlight — use claimNextReady for the full claim. Returns null if generation is
   * missing/non-finite (fail closed — no synthetic invent at write time).
   */
  freezeTerminalToken(
    runId: number,
    taskId: number,
    expectedStatus?: TaskExpectedStatus
  ): TaskTerminalToken | null {
    const runGeneration = this.taskRunGeneration[taskId];
    if (runGeneration == null || !Number.isFinite(runGeneration)) {
      return null;
    }
    const status = expectedStatus ?? this.readTaskExpectedStatus(runId, taskId);
    // Return a plain frozen object (no shared mutable refs).
    return Object.freeze({
      taskId,
      runId,
      runGeneration,
      expectedStatus: status,
    });
  }

  /**
   * B03 / AC7 C1: claim the next ready task and return an immutable terminal token bound to this
   * dispatch. Callers must carry the token through async work and pass it to mark* — never rebuild
   * from taskId maps after await.
   */
  claimNextReady(runId: number): TaskTerminalToken | null {
    if (this.inFlight[runId]) return null;
    const earliest = this.earliestOpenBatch(runId);
    if (earliest === null) return null;
    const q = this.queues[runId] || [];
    for (let i = 0; i < q.length; i++) {
      const tid = q[i];
      if (this.batchOf[tid] !== earliest) continue;
      if (this.failedTasks.has(tid) || this.deferredTasks.has(tid)) continue;
      if (this.completedTasks.has(tid)) continue;
      if (this.isSatisfied(tid)) {
        const token = this.freezeTerminalToken(runId, tid);
        if (!token) {
          console.warn(
            `[TaskQueueService] claimNextReady(${runId}) refused task ${tid} — no frozen run generation`
          );
          return null;
        }
        this.inFlight[runId] = tid;
        return token;
      }
    }
    return null;
  }

  /**
   * B03 / AC7: durable terminal CAS using ONLY fields from the immutable token.
   * Never reads taskRunGeneration[taskId] (mutable slot). Missing/non-finite generation → fail closed.
   */
  private applyTerminalDurable(
    token: TaskTerminalToken,
    terminal: 'complete' | 'failed' | 'deferred'
  ): boolean {
    if (!this.artifacts) {
      // Pure in-mem: token.runGeneration is the process-local epoch frozen at claim; reject if the
      // run occupancy epoch has moved (clearRun) without consulting taskId maps for generation.
      if (token.runGeneration !== (this.runEpoch[token.runId] || 0)) {
        console.warn(
          `[TaskQueueService] stale in-mem mark ${terminal}(task=${token.taskId}, run=${token.runId}, gen=${token.runGeneration}) ignored — run epoch moved`
        );
        return false;
      }
      return true;
    }
    if (token.runGeneration == null || !Number.isFinite(token.runGeneration)) {
      console.warn(
        `[TaskQueueService] durable mark ${terminal}(task=${token.taskId}, run=${token.runId}) fail-closed — missing run generation on token`
      );
      return false;
    }
    try {
      // Accept exact expectedStatus, or pending→working promotion during the same dispatch
      // (recordAttempt may advance status after claim without issuing a new token).
      const result = this.artifacts['db'].raw
        .prepare(
          `UPDATE run_tasks
           SET status = ?, updated_at = datetime('now')
           WHERE id = ?
             AND run_id = ?
             AND (
               status = ?
               OR (? = 'pending' AND status = 'working')
             )
             AND EXISTS (
               SELECT 1 FROM runs r
               WHERE r.id = run_tasks.run_id AND r.generation = ?
             )`
        )
        .run(
          terminal,
          token.taskId,
          token.runId,
          token.expectedStatus,
          token.expectedStatus,
          token.runGeneration
        ) as { changes: number };
      if (!result || result.changes === 0) {
        console.warn(
          `[TaskQueueService] stale durable mark ${terminal}(task=${token.taskId}, run=${token.runId}, gen=${token.runGeneration}, expected=${token.expectedStatus}) ignored — 0 rows`
        );
        return false;
      }
      return true;
    } catch (err) {
      console.warn(
        `[TaskQueueService] durable mark ${terminal}(task=${token.taskId}, run=${token.runId}) failed:`,
        err instanceof Error ? err.message : err
      );
      return false;
    }
  }

  private applyTerminalInMem(
    token: TaskTerminalToken,
    terminal: 'complete' | 'failed' | 'deferred'
  ): void {
    if (terminal === 'complete') this.completedTasks.add(token.taskId);
    if (terminal === 'failed') this.failedTasks.add(token.taskId);
    if (terminal === 'deferred') this.deferredTasks.add(token.taskId);
    if (this.inFlight[token.runId] === token.taskId) {
      this.inFlight[token.runId] = null;
    }
    if (terminal === 'complete' || terminal === 'deferred') {
      if (this.queues[token.runId]) {
        this.queues[token.runId] = this.queues[token.runId].filter((id) => id !== token.taskId);
      }
    }
  }

  /** Rebuild one durable run on this shared service without disturbing other active runs. */
  clearRun(runId: number): void {
    const taskIds = this.allTasks[runId] || [];
    for (const taskId of taskIds) {
      delete this.deps[taskId];
      delete this.batchOf[taskId];
      delete this.taskRunGeneration[taskId];
      this.failedTasks.delete(taskId);
      this.deferredTasks.delete(taskId);
      this.completedTasks.delete(taskId);
    }
    delete this.queues[runId];
    delete this.allTasks[runId];
    delete this.inFlight[runId];
    // Bump LAST: any token still in flight for the pre-bump generation is now provably stale
    // (pure in-mem path compares token.runGeneration to this epoch).
    this.runEpoch[runId] = (this.runEpoch[runId] || 0) + 1;
  }

  private normBatch(batch: string | null | undefined): string {
    const s = batch == null ? '' : String(batch).trim();
    return s === '' ? DEFAULT_BATCH : s;
  }

  /**
   * @param runGeneration optional durable `runs.generation` captured by the caller (preferred when
   *   already known from createRun). When omitted and artifacts is set, SELECT generation FROM runs;
   *   pure in-mem falls back to process-local runEpoch.
   */
  enqueue(
    runId: number,
    taskId: number,
    depTaskIds: number[] = [],
    urgent = false,
    batch: string = DEFAULT_BATCH,
    runGeneration?: number
  ): void {
    if (!this.queues[runId]) this.queues[runId] = [];
    if (!this.allTasks[runId]) this.allTasks[runId] = [];
    this.taskRunGeneration[taskId] = this.resolveEnqueueGeneration(runId, runGeneration);
    this.deps[taskId] = [...(depTaskIds || [])];
    this.batchOf[taskId] = this.normBatch(batch);
    if (!this.allTasks[runId].includes(taskId)) this.allTasks[runId].push(taskId);
    const q = this.queues[runId];
    if (urgent && q.length > 0) {
      // URGENT after the in-flight (position 1); never interrupts current (getNextReady already nulls while in-flight)
      q.splice(1, 0, taskId);
    } else {
      q.push(taskId);
    }
  }

  /**
   * Rehydrate one durable task status without writing back to the DB. Resume builds a brand-new queue,
   * enqueues the full graph first, then seeds these in-memory terminal sets from run_tasks.
   */
  rehydrateTaskStatus(taskId: number, status: 'pending' | 'complete' | 'failed' | 'deferred'): void {
    this.completedTasks.delete(taskId);
    this.failedTasks.delete(taskId);
    this.deferredTasks.delete(taskId);
    if (status === 'complete') this.completedTasks.add(taskId);
    if (status === 'failed') this.failedTasks.add(taskId);
    if (status === 'deferred') this.deferredTasks.add(taskId);
  }

  /** Read-only ready check used by recovery preflight; unlike getNextReady it does not claim inFlight. */
  peekNextReady(runId: number): number | null {
    if (this.inFlight[runId]) return null;
    const earliest = this.earliestOpenBatch(runId);
    if (earliest === null) return null;
    for (const tid of this.queues[runId] || []) {
      if (this.batchOf[tid] !== earliest) continue;
      if (this.failedTasks.has(tid) || this.deferredTasks.has(tid) || this.completedTasks.has(tid)) continue;
      if (this.isSatisfied(tid)) return tid;
    }
    return null;
  }

  /**
   * Leg D admission barrier. At each one-in-flight boundary, only pending tasks from the EARLIEST batch
   * (by the natural-order comparator) that still has any non-complete task may be considered ready. Within
   * that batch, current insertion order + explicit-dep behavior is retained; failed/deferred siblings are
   * skipped (independent siblings drain). A later batch stays closed until every earlier-batch task is
   * complete. Single-batch (all-'default') plans behave exactly as before (earliest open batch == the only
   * batch, so every task is eligible).
   *
   * Prefer claimNextReady for production paths that later call mark* — it returns the immutable
   * TaskTerminalToken that must ride the async continuation (B03 C1).
   */
  getNextReady(runId: number): number | null {
    const token = this.claimNextReady(runId);
    return token ? token.taskId : null;
  }

  /**
   * Earliest batch (numeric-aware natural order) with any NON-complete task (pending/working/failed/
   * deferred all count as "open"), or null when every task is complete. Iterates allTasks (never pruned)
   * so a failed/deferred earlier-batch task keeps its barrier held even after leaving the live queue.
   */
  private earliestOpenBatch(runId: number): string | null {
    const all = this.allTasks[runId] || [];
    let earliest: string | null = null;
    for (const tid of all) {
      if (this.completedTasks.has(tid)) continue; // complete = closed
      const b = this.batchOf[tid] ?? DEFAULT_BATCH;
      if (earliest === null || compareBatchLabels(b, earliest) < 0) earliest = b;
    }
    return earliest;
  }

  private isSatisfied(taskId: number): boolean {
    const ds = this.deps[taskId] || [];
    for (const d of ds) {
      if (this.failedTasks.has(d) || this.deferredTasks.has(d)) return false;
      if (!this.completedTasks.has(d)) return false;
    }
    return true;
  }

  /**
   * Resolve mark* argument to an immutable token.
   * - Primary: pass the TaskTerminalToken from claimNextReady (production / async).
   * - Legacy sync: (taskId, runId) freezes generation NOW from enqueue maps — only safe on the
   *   same-lifecycle sync path; after clearRun/recycle this adopts the NEW occupant (C1). Production
   *   drain paths must pass the claim-time token object through await.
   */
  private resolveMarkToken(
    tokenOrTaskId: TaskTerminalToken | number,
    runId?: number
  ): TaskTerminalToken | null {
    if (
      tokenOrTaskId != null &&
      typeof tokenOrTaskId === 'object' &&
      typeof (tokenOrTaskId as TaskTerminalToken).taskId === 'number' &&
      typeof (tokenOrTaskId as TaskTerminalToken).runId === 'number' &&
      typeof (tokenOrTaskId as TaskTerminalToken).runGeneration === 'number'
    ) {
      return tokenOrTaskId as TaskTerminalToken;
    }
    if (typeof tokenOrTaskId === 'number' && runId != null) {
      return this.freezeTerminalToken(runId, tokenOrTaskId);
    }
    return null;
  }

  /**
   * B03 / AC7: terminal mark using an immutable claim/dispatch token (preferred).
   * Never re-reads generation from a mutable taskId map when a token object is supplied.
   * Returns false when the fence rejects (caller must not retry with a refreshed token).
   */
  markComplete(token: TaskTerminalToken): boolean;
  /** @deprecated sync tests only — freezes generation at call time; unsafe across async recycle. */
  markComplete(taskId: number, runId: number): boolean;
  markComplete(tokenOrTaskId: TaskTerminalToken | number, runId?: number): boolean {
    const token = this.resolveMarkToken(tokenOrTaskId, runId);
    if (!token || !Number.isFinite(token.runGeneration)) {
      console.warn(`[TaskQueueService] markComplete fail-closed — missing token/runGeneration`);
      return false;
    }
    if (!this.applyTerminalDurable(token, 'complete')) return false;
    this.applyTerminalInMem(token, 'complete');
    return true;
  }

  markFailed(token: TaskTerminalToken): boolean;
  /** @deprecated sync tests only — freezes generation at call time; unsafe across async recycle. */
  markFailed(taskId: number, runId: number): boolean;
  markFailed(tokenOrTaskId: TaskTerminalToken | number, runId?: number): boolean {
    const token = this.resolveMarkToken(tokenOrTaskId, runId);
    if (!token || !Number.isFinite(token.runGeneration)) {
      console.warn(`[TaskQueueService] markFailed fail-closed — missing token/runGeneration`);
      return false;
    }
    if (!this.applyTerminalDurable(token, 'failed')) return false;
    this.applyTerminalInMem(token, 'failed');
    return true;
  }

  markDeferred(token: TaskTerminalToken): boolean;
  /** @deprecated sync tests only — freezes generation at call time; unsafe across async recycle. */
  markDeferred(taskId: number, runId: number): boolean;
  markDeferred(tokenOrTaskId: TaskTerminalToken | number, runId?: number): boolean {
    const token = this.resolveMarkToken(tokenOrTaskId, runId);
    if (!token || !Number.isFinite(token.runGeneration)) {
      console.warn(`[TaskQueueService] markDeferred fail-closed — missing token/runGeneration`);
      return false;
    }
    if (!this.applyTerminalDurable(token, 'deferred')) return false;
    this.applyTerminalInMem(token, 'deferred');
    return true;
  }

  // Test helpers (no prod surface)
  getQueue(runId: number): number[] {
    return [...(this.queues[runId] || [])];
  }
  isInFlight(runId: number): boolean {
    return !!this.inFlight[runId];
  }
  isBlockedByFailure(taskId: number): boolean {
    const ds = this.deps[taskId] || [];
    return ds.some((d) => this.failedTasks.has(d));
  }
  isDeferred(taskId: number): boolean {
    return this.deferredTasks.has(taskId);
  }

  // Leg D: durable batch of a task (resolved 'default' when unknown). Queryable, never re-derived from plan.json.
  batchOfTask(taskId: number): string {
    return this.batchOf[taskId] ?? DEFAULT_BATCH;
  }

  /**
   * Leg D dynamic-task resolution helpers.
   * activeBatch — the batch a mid-run injection inherits when no explicit batch is supplied (the current
   *   in-flight task's batch, else the earliest open batch, else 'default').
   * newBatchAfterLast — a NEW batch ordinal that sorts strictly AFTER every existing batch (post-queue
   *   final-test fix tasks). Increments the trailing integer of the latest batch (B5→B6, B09→B10), or
   *   appends '1' to a non-numeric latest ('default'→'default1'); 'B1' when the run has no tasks yet.
   */
  activeBatch(runId: number): string {
    const inf = this.inFlight[runId];
    if (inf != null && this.batchOf[inf] != null) return this.batchOf[inf];
    return this.earliestOpenBatch(runId) ?? DEFAULT_BATCH;
  }

  newBatchAfterLast(runId: number): string {
    const all = this.allTasks[runId] || [];
    let latest: string | null = null;
    for (const tid of all) {
      const b = this.batchOf[tid] ?? DEFAULT_BATCH;
      if (latest === null || compareBatchLabels(b, latest) > 0) latest = b;
    }
    if (!latest) return 'B1';
    // Legacy single-queue guard: `default` is assigned ONLY to the all-unlabeled case (resolveTaskBatches),
    // so latest === DEFAULT_BATCH uniquely identifies a plan with no batch structure to advance. Keep the
    // final-fix in `default` (which the deploy gate correctly skips) — never mint `default1`, which would
    // deploy-gate a legacy final-fix and break the "preserve legacy single-queue behavior" contract (§5).
    if (latest === DEFAULT_BATCH) return DEFAULT_BATCH;
    const m = /^(.*?)(\d+)\s*$/.exec(latest);
    if (m) return `${m[1]}${(BigInt(m[2]) + 1n).toString()}`;
    return `${latest}1`;
  }

  // FIX-C: for gating run-final red-team on actual completion (≥1 task completed)
  completedCount(runId?: number): number {
    if (runId == null) return this.completedTasks.size;
    return (this.allTasks[runId] || []).filter((taskId) => this.completedTasks.has(taskId)).length;
  }
  hasCompleted(runId?: number): boolean {
    return this.completedCount(runId) > 0;
  }

  // E1: explicit mid-run inject/redirect support. Enqueues respect in-flight boundary
  // (urgent placed after current via existing enqueue splice(1)). Drained at next getNextReady boundary.
  // New tasks created via recordTask + enqueue here; redirect updates status/label then enqueue.
  // Leg D: batch resolves to the supplied value, else the task's already-persisted batch (re-enqueue),
  // else the active batch (injection inherits the batch it lands in).
  enqueueTask(runId: number, taskId: number, urgent = false, batch?: string, runGeneration?: number): void {
    const resolved = batch ?? this.batchOf[taskId] ?? this.activeBatch(runId);
    // Preserve a previously captured durable generation on re-enqueue when the caller omits it
    // (redirect/inject mid-run — same run occupant).
    const gen =
      runGeneration !== undefined
        ? runGeneration
        : this.taskRunGeneration[taskId] !== undefined
          ? this.taskRunGeneration[taskId]
          : undefined;
    this.enqueue(runId, taskId, [], urgent, resolved, gen);
  }

  // Allow re-adding a task id to the active queue for redirect (defensive clear prior dupes of this id).
  // Leg D: a redirect PRESERVES the task's persisted batch + explicit deps (never re-enqueued as unbatched).
  requeueForRedirect(runId: number, taskId: number): void {
    if (this.queues[runId]) {
      this.queues[runId] = this.queues[runId].filter((id) => id !== taskId);
    }
    const existingDeps = this.deps[taskId] || [];
    const existingBatch = this.batchOf[taskId] ?? DEFAULT_BATCH;
    const existingGen = this.taskRunGeneration[taskId];
    this.enqueue(runId, taskId, existingDeps, true, existingBatch, existingGen);
  }

  /**
   * B10-T02: precise deadlock detector.
   * Returns a clear reason ONLY for true deadlock (getNextReady==null but pending non-failed/non-deferred tasks
   * have a cycle *among themselves* in the unresolved subgraph).
   * Returns null (no deadlock) for legit cases: all done, or pending only blocked by failed/deferred prereqs (tree, no internal cycle).
   */
  getDeadlockReason(runId: number): string | null {
    if (this.inFlight[runId]) return null;
    const q = this.queues[runId] || [];
    const pending = q.filter((tid) =>
      !this.completedTasks.has(tid) &&
      !this.failedTasks.has(tid) &&
      !this.deferredTasks.has(tid)
    );
    if (pending.length === 0) return null;

    const pendingSet = new Set(pending);
    // Subgraph indegrees: only count deps that are still pending (unresolved cycle would be internal)
    const subIn: Record<number, number> = {};
    pending.forEach((tid) => { subIn[tid] = 0; });
    for (const tid of pending) {
      const ds = this.deps[tid] || [];
      for (const d of ds) {
        if (pendingSet.has(d)) {
          subIn[tid] = (subIn[tid] || 0) + 1;
        }
      }
    }

    const subQ: number[] = pending.filter((tid) => (subIn[tid] || 0) === 0);
    let processed = 0;
    const temp = { ...subIn };
    while (subQ.length > 0) {
      const cur = subQ.shift()!;
      processed++;
      for (const tid of pending) {
        const ds = this.deps[tid] || [];
        if (ds.includes(cur)) {
          temp[tid] = (temp[tid] || 0) - 1;
          if (temp[tid] === 0) subQ.push(tid);
        }
      }
    }

    if (processed < pending.length) {
      return `deadlock (cycle among unresolved): ${pending.join(',')}`;
    }
    // All pending are downstream of failed/deferred only — not a cycle deadlock. Legit blocked, do not false-trigger guard.
    return null;
  }

  /**
   * B10-T05: parked-blocks-all detector (REUSE + complement of B10-T02 getDeadlockReason).
   * Returns reason ONLY when getNextReady==null but there are pending non-failed/non-deferred tasks
   * AND every one of them is blocked (directly or transitively) by at least one deferred (parked) prereq.
   * This is the "parked task is a dependency of ALL remaining" case.
   * A parked with runnable independents never hits this (getNextReady returns them).
   * Precedence note (see run-orchestrator): deadlock (cycle) checked first; if both signals, cycle wins.
   */
  getParkedBlockReason(runId: number): string | null {
    if (this.inFlight[runId]) return null;
    const q = this.queues[runId] || [];
    const pending = q.filter((tid) =>
      !this.completedTasks.has(tid) &&
      !this.failedTasks.has(tid) &&
      !this.deferredTasks.has(tid)
    );
    if (pending.length === 0 || this.deferredTasks.size === 0) return null;

    const isBlockedByParked = (tid: number): boolean => {
      const ds = this.deps[tid] || [];
      // direct
      if (ds.some((d) => this.deferredTasks.has(d))) return true;
      // transitive (acyclic because caller rules out cycles via getDeadlockReason first)
      const visited = new Set<number>();
      const stack: number[] = [...ds];
      while (stack.length > 0) {
        const d = stack.pop()!;
        if (visited.has(d)) continue;
        visited.add(d);
        if (this.deferredTasks.has(d)) return true;
        if (this.failedTasks.has(d) || this.completedTasks.has(d)) continue;
        stack.push(...(this.deps[d] || []));
      }
      return false;
    };

    const allBlockedByParked = pending.every((tid) => isBlockedByParked(tid));
    if (allBlockedByParked) {
      const parked = Array.from(this.deferredTasks).join(',');
      return `parked prereq blocks all remaining: parked=${parked} pending=${pending.join(',')}`;
    }
    return null;
  }

  /**
   * Leg D §4 structured drain-state classification. Called after a drain to give the run-orchestrator ONE
   * terminal decision. Classifies in this exact precedence order:
   *   (1) dependency cycle;
   *   (2) deferred/parked prereq OR deferred earlier batch;
   *   (3) failed prereq OR failed earlier batch;
   *   (4) unknown pending-after-drain stall (fail-safe — pending remain with no cycle/failed/deferred blocker);
   *   (5) genuinely all complete (no pending/working remain in the queue).
   * "pending" here = tasks not complete/failed/deferred (i.e. still awaiting execution). A blocker is a
   * failed/deferred task holding a pending task back — via an explicit dep OR the earlier-batch barrier.
   */
  classifyDrainState(runId: number): DrainClassification {
    const all = this.allTasks[runId] || [];
    const pending = all.filter((tid) =>
      !this.completedTasks.has(tid) &&
      !this.failedTasks.has(tid) &&
      !this.deferredTasks.has(tid)
    );
    if (pending.length === 0) {
      return { kind: 'all-complete', reason: 'no pending/working tasks remain in the queue', pendingTaskIds: [], blockerTaskIds: [] };
    }

    // (1) dependency cycle among unresolved pending tasks.
    const cycle = this.getDeadlockReason(runId);
    if (cycle) {
      return { kind: 'cycle', reason: cycle, pendingTaskIds: pending, blockerTaskIds: pending };
    }

    // Collect the failed/deferred tasks that block ≥1 pending task — via an explicit dep OR the barrier
    // (an earlier non-complete failed/deferred task holds every later-batch pending task).
    const earliest = this.earliestOpenBatch(runId);
    const blockers = new Set<number>();
    for (const p of pending) {
      for (const d of this.deps[p] || []) {
        if (this.failedTasks.has(d) || this.deferredTasks.has(d)) blockers.add(d);
      }
      const pb = this.batchOf[p] ?? DEFAULT_BATCH;
      if (earliest !== null && compareBatchLabels(pb, earliest) > 0) {
        // p is barrier-blocked by an earlier batch — attribute the earlier failed/deferred holders.
        for (const t of all) {
          if (this.completedTasks.has(t)) continue;
          const tb = this.batchOf[t] ?? DEFAULT_BATCH;
          if (compareBatchLabels(tb, pb) < 0 && (this.failedTasks.has(t) || this.deferredTasks.has(t))) {
            blockers.add(t);
          }
        }
      }
    }

    const blockerIds = [...blockers];
    const anyDeferred = blockerIds.some((b) => this.deferredTasks.has(b));
    const anyFailed = blockerIds.some((b) => this.failedTasks.has(b));
    // (2) deferred precedence over (3) failed.
    if (anyDeferred) {
      return {
        kind: 'deferred-block',
        reason: 'pending tasks blocked by a deferred/parked prerequisite or a deferred earlier batch',
        pendingTaskIds: pending,
        blockerTaskIds: blockerIds,
      };
    }
    if (anyFailed) {
      return {
        kind: 'failed-block',
        reason: 'pending tasks blocked by a failed prerequisite or a failed earlier batch',
        pendingTaskIds: pending,
        blockerTaskIds: blockerIds,
      };
    }
    // (4) fail-safe: pending remain but no cycle/failed/deferred blocker explains it.
    return {
      kind: 'unknown-pending-stall',
      reason: `getNextReady returned null but ${pending.length} pending task(s) remain with no cycle/failed/deferred blocker`,
      pendingTaskIds: pending,
      blockerTaskIds: [],
    };
  }
}
