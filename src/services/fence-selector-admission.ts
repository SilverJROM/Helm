/**
 * fence-workflow-upgrade B3 — typed next-work selector + admission (R2.3, R3.1, R3.2).
 *
 * Next-work decision ∈ OPEN_FENCE | DISPATCH_TASK | CLOSE_FENCE | NONE.
 *
 * Structural invariant (plan-preamble §8.1 / D8):
 *   claimNextReady / admission MUST NEVER return a member task token unless the fence is
 *   already `draining` with a complete OPEN baseline. No baseline ⇒ no task token ⇒ no
 *   performRolePhase reachable. Do not claim/in-flight a member before OPEN completes.
 *
 * Outer loop runs OPEN_FENCE / CLOSE_FENCE, then asks again. Ordinary non-member tasks keep
 * Helm's unit gate unchanged (R3.2).
 */
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import {
  getOpenBaseline,
  parseOpenFailedIds,
  type FenceLifecycleState,
} from './fence-open-service.js';
import type { TaskQueueService } from './task-queue-service.js';
import type { TaskTerminalToken } from './lifecycle-cas.js';

export type SqliteDb = Database.Database;

export type NextWorkKind = 'OPEN_FENCE' | 'DISPATCH_TASK' | 'CLOSE_FENCE' | 'NONE';

export type NextWorkDecision =
  | {
      kind: 'OPEN_FENCE';
      runId: number;
      fenceId: number;
      fenceKey: string;
      /** Task that would be first to dispatch after OPEN — not claimed. */
      blockedTaskId: number;
      blockedTaskKey: string | null;
    }
  | {
      kind: 'DISPATCH_TASK';
      runId: number;
      taskId: number;
      taskKey: string | null;
      /** Null when the task is not a fence member (ordinary unit gate). */
      fenceId: number | null;
      fenceKey: string | null;
    }
  | {
      kind: 'CLOSE_FENCE';
      runId: number;
      fenceId: number;
      fenceKey: string;
    }
  | {
      kind: 'NONE';
      runId: number;
      reason: string;
    };

export interface FenceMemberLookup {
  fenceId: number;
  fenceKey: string;
  runId: number;
  lifecycleState: FenceLifecycleState | string;
  taskKey: string;
  openFailedIds: string | null;
  openTestHash: string | null;
  openAt: string | null;
  /** True when lifecycle is draining AND baseline columns are complete. */
  hasBaseline: boolean;
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

/**
 * Complete OPEN baseline: draining + non-empty failed ids + test hash + open_at.
 * Same rule as getOpenBaseline.has_baseline (R2.2 / R3.1).
 */
export function hasCompleteOpenBaseline(row: {
  lifecycle_state: string;
  open_failed_ids: string | null;
  open_test_hash: string | null;
  open_at: string | null;
}): boolean {
  const ids = parseOpenFailedIds(row.open_failed_ids);
  return (
    row.lifecycle_state === 'draining' &&
    ids.length > 0 &&
    typeof row.open_test_hash === 'string' &&
    row.open_test_hash.length > 0 &&
    row.open_at != null &&
    String(row.open_at).length > 0
  );
}

/**
 * Resolve fence membership for a run_tasks row. Returns null when the task is not a fence
 * member (ordinary unit — R3.2) or when fence tables/rows are absent.
 */
export function lookupFenceMemberForTask(
  db: DatabaseService | SqliteDb,
  runId: number,
  taskId: number
): FenceMemberLookup | null {
  const raw = resolveRaw(db);
  try {
    const row = raw
      .prepare(
        `SELECT
           f.id AS fence_id,
           f.fence_key AS fence_key,
           f.run_id AS run_id,
           f.lifecycle_state AS lifecycle_state,
           f.open_failed_ids AS open_failed_ids,
           f.open_test_hash AS open_test_hash,
           f.open_at AS open_at,
           m.task_key AS task_key
         FROM run_tasks rt
         INNER JOIN fence_members m ON m.task_key = rt.task_key
         INNER JOIN fences f ON f.id = m.fence_id AND f.run_id = rt.run_id
         WHERE rt.id = ? AND rt.run_id = ?`
      )
      .get(taskId, runId) as
      | {
          fence_id: number;
          fence_key: string;
          run_id: number;
          lifecycle_state: string;
          open_failed_ids: string | null;
          open_test_hash: string | null;
          open_at: string | null;
          task_key: string;
        }
      | undefined;

    if (!row) return null;
    return {
      fenceId: row.fence_id,
      fenceKey: row.fence_key,
      runId: row.run_id,
      lifecycleState: row.lifecycle_state,
      taskKey: row.task_key,
      openFailedIds: row.open_failed_ids,
      openTestHash: row.open_test_hash,
      openAt: row.open_at,
      hasBaseline: hasCompleteOpenBaseline(row),
    };
  } catch {
    // Missing tables / schema — treat as non-member so legacy pure paths stay open.
    return null;
  }
}

/**
 * R3.1 — is this task allowed to become a dispatch token?
 * Non-members: yes (ordinary unit gate). Members: only with complete OPEN baseline.
 */
export function isTaskDispatchable(
  db: DatabaseService | SqliteDb,
  runId: number,
  taskId: number
): boolean {
  const member = lookupFenceMemberForTask(db, runId, taskId);
  if (!member) return true;
  return member.hasBaseline;
}

/**
 * Used by TaskQueueService.claimNextReady (real funnel) so a bypass of the typed selector
 * still cannot put a fence member in-flight without a baseline.
 *
 * Returns true when claim must be refused (member without complete baseline).
 * Returns false when claim may proceed (non-member OR member with baseline OR no DB).
 */
export function isFenceClaimBlocked(
  db: DatabaseService | SqliteDb | null | undefined,
  runId: number,
  taskId: number
): boolean {
  if (!db) return false;
  const member = lookupFenceMemberForTask(db, runId, taskId);
  if (!member) return false;
  return !member.hasBaseline;
}

function taskKeyFor(
  db: DatabaseService | SqliteDb,
  runId: number,
  taskId: number
): string | null {
  try {
    const raw = resolveRaw(db);
    const row = raw
      .prepare('SELECT task_key FROM run_tasks WHERE id = ? AND run_id = ?')
      .get(taskId, runId) as { task_key: string | null } | undefined;
    return row?.task_key ?? null;
  } catch {
    return null;
  }
}

/**
 * Find a draining fence whose members are all complete (eligible for CLOSE).
 * Prefer lowest fence_key for stability.
 */
function findCloseEligibleFence(
  db: DatabaseService | SqliteDb,
  runId: number
): { fenceId: number; fenceKey: string } | null {
  const raw = resolveRaw(db);
  try {
    const fences = raw
      .prepare(
        `SELECT id, fence_key, lifecycle_state, open_failed_ids, open_test_hash, open_at
         FROM fences
         WHERE run_id = ? AND lifecycle_state = 'draining'
         ORDER BY fence_key ASC`
      )
      .all(runId) as Array<{
      id: number;
      fence_key: string;
      lifecycle_state: string;
      open_failed_ids: string | null;
      open_test_hash: string | null;
      open_at: string | null;
    }>;

    for (const f of fences) {
      if (!hasCompleteOpenBaseline(f)) continue;
      const members = raw
        .prepare(
          `SELECT m.task_key AS task_key
           FROM fence_members m
           WHERE m.fence_id = ?
           ORDER BY m.position ASC, m.task_key ASC`
        )
        .all(f.id) as Array<{ task_key: string }>;
      if (members.length === 0) continue;

      let allComplete = true;
      for (const m of members) {
        const rt = raw
          .prepare(
            `SELECT status FROM run_tasks WHERE run_id = ? AND task_key = ?`
          )
          .get(runId, m.task_key) as { status: string } | undefined;
        // Missing run_task row or non-complete ⇒ not ready to close.
        if (!rt || rt.status !== 'complete') {
          allComplete = false;
          break;
        }
      }
      if (allComplete) {
        return { fenceId: f.id, fenceKey: f.fence_key };
      }
    }
  } catch {
    return null;
  }
  return null;
}

export interface SelectNextWorkParams {
  db: DatabaseService | SqliteDb;
  queue: TaskQueueService;
  runId: number;
}

/**
 * Typed next-work selector. Read-only w.r.t. in-flight: never claims a task.
 *
 * Priority:
 * 1. peekNextReady is a fence member without baseline (declared|opening) → OPEN_FENCE
 * 2. peekNextReady is dispatchable (non-member or member with baseline) → DISPATCH_TASK
 * 3. peekNextReady is a member in a non-openable blocked state → NONE (fail closed)
 * 4. no ready task but a draining fence has all members complete → CLOSE_FENCE
 * 5. NONE
 */
export function selectNextWork(params: SelectNextWorkParams): NextWorkDecision {
  const { db, queue, runId } = params;

  const peekId = queue.peekNextReady(runId);
  if (peekId != null) {
    const member = lookupFenceMemberForTask(db, runId, peekId);
    const taskKey = member?.taskKey ?? taskKeyFor(db, runId, peekId);

    if (member && !member.hasBaseline) {
      const life = member.lifecycleState;
      if (life === 'declared' || life === 'opening') {
        return {
          kind: 'OPEN_FENCE',
          runId,
          fenceId: member.fenceId,
          fenceKey: member.fenceKey,
          blockedTaskId: peekId,
          blockedTaskKey: taskKey,
        };
      }
      // draining-incomplete, closing, closed, plan_blocked, repairing without baseline — fail closed.
      return {
        kind: 'NONE',
        runId,
        reason: `fence '${member.fenceKey}' member task ${peekId} not dispatchable (lifecycle=${life}, no complete OPEN baseline)`,
      };
    }

    return {
      kind: 'DISPATCH_TASK',
      runId,
      taskId: peekId,
      taskKey,
      fenceId: member?.fenceId ?? null,
      fenceKey: member?.fenceKey ?? null,
    };
  }

  const close = findCloseEligibleFence(db, runId);
  if (close) {
    return {
      kind: 'CLOSE_FENCE',
      runId,
      fenceId: close.fenceId,
      fenceKey: close.fenceKey,
    };
  }

  return {
    kind: 'NONE',
    runId,
    reason: 'no ready task and no fence eligible for CLOSE',
  };
}

export interface AdmitClaimParams {
  db: DatabaseService | SqliteDb;
  queue: TaskQueueService;
  runId: number;
}

export type AdmitClaimResult =
  | {
      ok: true;
      decision: Extract<NextWorkDecision, { kind: 'DISPATCH_TASK' }>;
      token: TaskTerminalToken;
    }
  | {
      ok: false;
      decision: Exclude<NextWorkDecision, { kind: 'DISPATCH_TASK' }>;
      token: null;
    };

/**
 * Real-funnel claim: select first, claim only when decision is DISPATCH_TASK.
 * Never sets in-flight for OPEN_FENCE / CLOSE_FENCE / NONE.
 */
export function admitClaimNextReady(params: AdmitClaimParams): AdmitClaimResult {
  const decision = selectNextWork(params);
  if (decision.kind !== 'DISPATCH_TASK') {
    return { ok: false, decision, token: null };
  }

  // Defense in depth: re-check admission immediately before claim.
  if (!isTaskDispatchable(params.db, params.runId, decision.taskId)) {
    return {
      ok: false,
      decision: {
        kind: 'NONE',
        runId: params.runId,
        reason: `admission race: task ${decision.taskId} lost dispatchability before claim`,
      },
      token: null,
    };
  }

  const token = params.queue.claimNextReady(params.runId);
  if (!token) {
    return {
      ok: false,
      decision: {
        kind: 'NONE',
        runId: params.runId,
        reason: `claimNextReady returned null after DISPATCH_TASK for task ${decision.taskId}`,
      },
      token: null,
    };
  }

  // Structural: claimed task must match selector (no silent skip to another task).
  if (token.taskId !== decision.taskId) {
    // Should not happen under one-in-flight + same peek; fail closed by not leaving foreign claim.
    // Leave token as claimed — caller must mark; still report failure so OPEN cannot be skipped.
    return {
      ok: false,
      decision: {
        kind: 'NONE',
        runId: params.runId,
        reason: `claim mismatch: expected task ${decision.taskId}, claimed ${token.taskId}`,
      },
      token: null,
    };
  }

  return { ok: true, decision, token };
}

/**
 * Inspect helper: load baseline status for a fence (delegates to open service).
 * Exposed so tests/callers do not re-implement has_baseline.
 */
export function fenceBaselineReady(
  db: DatabaseService | SqliteDb,
  key: { fenceId: number } | { runId: number; fenceKey: string }
): boolean {
  const b = getOpenBaseline(db, key);
  return !!b?.has_baseline;
}
