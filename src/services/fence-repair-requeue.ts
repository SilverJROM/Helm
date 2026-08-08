/**
 * fence-workflow-upgrade R3 — post-hash atomic reopen + guarded requeue (R5.1–R5.3).
 *
 * After every named repair unit in a staged round has a fill-once hash lock (R2):
 *   1. Atomically flip ≤2 complete units complete→pending while keeping
 *      reopen_reason='repair' + repair_generation (R1 markers, R5.1/R5.2).
 *   2. Enqueue the reopened task ids into the live TaskQueueService.
 *   3. Require the locked hash intact before implementer dispatch; a weakened
 *      on-disk test is refused (R5.3).
 *
 * Does not author tests, does not route plan defects (R4), and does not own
 * fresh-process resume (R5).
 */
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import { DEFAULT_BATCH } from './execution-plan-parser.js';
import {
  areAllRepairRoundUnitsLocked,
  assertRepairTestHashIntact,
  FenceRepairHashlockError,
  getFenceRepairUnitLock,
  type FenceRepairUnitRow,
} from './fence-repair-hashlock.js';
import { FENCE_REPAIR_UNIT_CEILING } from './fence-repair-schema.js';
import type { TaskQueueService } from './task-queue-service.js';

export type SqliteDb = Database.Database;

export class FenceRepairRequeueError extends Error {
  readonly code: FenceRepairRequeueErrorCode;

  constructor(code: FenceRepairRequeueErrorCode, message: string) {
    super(message);
    this.name = 'FenceRepairRequeueError';
    this.code = code;
  }
}

export type FenceRepairRequeueErrorCode =
  | 'missing_round'
  | 'not_locked'
  | 'bad_units'
  | 'bad_task_status'
  | 'already_reopened'
  | 'reopen_refused'
  | 'hash_mismatch'
  | 'dispatch_refused'
  | 'missing_unit'
  | 'missing_queue';

export interface ReopenedRepairUnit {
  repair_unit_id: number;
  run_task_id: number;
  task_key: string;
  repair_generation: number;
  prior_status: string;
  status: 'pending';
  reopen_reason: 'repair';
  repair_test_path: string;
  repair_test_hash: string;
}

export interface ReopenAndEnqueueRepairRoundParams {
  repairRoundId: number;
  /** Live queue that will redispatch the reopened units. Required. */
  queue: TaskQueueService;
  /** Repo root for hash re-check at reopen time (defaults to cwd). */
  repoRoot?: string | null;
  /**
   * When true (default), re-hash every locked file before the status flip.
   * Weakening the validator-authored test between lock and reopen is refused.
   */
  requireIntactHash?: boolean;
}

export interface ReopenAndEnqueueRepairRoundResult {
  ok: true;
  repair_round_id: number;
  fence_id: number;
  run_id: number;
  fence_key: string;
  units: ReopenedRepairUnit[];
}

export interface AssertRepairImplementerDispatchParams {
  /** Prefer direct repair unit id. */
  repairUnitId?: number;
  /** Or (repairRoundId + taskKey). */
  repairRoundId?: number;
  taskKey?: string;
  /** Or bare run_task id (looks up active repair unit by repair_round_id join). */
  runTaskId?: number;
  repoRoot?: string | null;
}

export interface AssertRepairImplementerDispatchResult {
  ok: true;
  repair_unit_id: number;
  run_task_id: number;
  task_key: string;
  repair_generation: number;
  repair_test_path: string;
  repair_test_hash: string;
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

function loadRound(
  raw: SqliteDb,
  repairRoundId: number
): {
  id: number;
  fence_id: number;
  run_id: number;
  fence_key: string;
  status: string;
  failing_units: string;
} {
  const row = raw
    .prepare(
      `SELECT id, fence_id, run_id, fence_key, status, failing_units
       FROM fence_repair_rounds WHERE id = ?`
    )
    .get(repairRoundId) as
    | {
        id: number;
        fence_id: number;
        run_id: number;
        fence_key: string;
        status: string;
        failing_units: string;
      }
    | undefined;
  if (!row) {
    throw new FenceRepairRequeueError(
      'missing_round',
      `fence_repair_rounds id ${repairRoundId} not found`
    );
  }
  return row;
}

function loadRoundUnits(raw: SqliteDb, repairRoundId: number): FenceRepairUnitRow[] {
  return raw
    .prepare(
      `SELECT id, repair_round_id, fence_id, run_id, run_task_id, task_key,
              repair_generation, prior_status,
              repair_test_path, repair_test_hash, repair_assert_ids,
              authored_by, locked_at
       FROM fence_repair_units
       WHERE repair_round_id = ?
       ORDER BY id`
    )
    .all(repairRoundId) as FenceRepairUnitRow[];
}

function isUnitLocked(unit: FenceRepairUnitRow): boolean {
  return !!(
    unit.repair_test_hash &&
    unit.repair_test_hash.length > 0 &&
    unit.repair_test_path &&
    unit.repair_test_path.length > 0 &&
    unit.locked_at &&
    unit.locked_at.length > 0
  );
}

function loadTaskRow(
  raw: SqliteDb,
  runTaskId: number
): {
  id: number;
  run_id: number;
  task_key: string;
  status: string;
  batch: string | null;
  reopen_reason: string | null;
  repair_generation: number;
  repair_round_id: number | null;
} {
  const row = raw
    .prepare(
      `SELECT id, run_id, task_key, status, batch,
              reopen_reason, repair_generation, repair_round_id
       FROM run_tasks WHERE id = ?`
    )
    .get(runTaskId) as
    | {
        id: number;
        run_id: number;
        task_key: string;
        status: string;
        batch: string | null;
        reopen_reason: string | null;
        repair_generation: number;
        repair_round_id: number | null;
      }
    | undefined;
  if (!row) {
    throw new FenceRepairRequeueError('missing_unit', `run_tasks id ${runTaskId} not found`);
  }
  return row;
}

/**
 * After every named repair test is locked, atomically set ≤2 complete units to
 * pending (keeping reopen_reason=repair + repair_generation) and enqueue them.
 */
export function reopenAndEnqueueRepairRound(
  db: DatabaseService | SqliteDb,
  params: ReopenAndEnqueueRepairRoundParams
): ReopenAndEnqueueRepairRoundResult {
  if (!params.queue) {
    throw new FenceRepairRequeueError(
      'missing_queue',
      'reopenAndEnqueueRepairRound requires a live TaskQueueService'
    );
  }

  const raw = resolveRaw(db);
  const round = loadRound(raw, params.repairRoundId);
  const units = loadRoundUnits(raw, params.repairRoundId);

  if (units.length === 0 || units.length > FENCE_REPAIR_UNIT_CEILING) {
    throw new FenceRepairRequeueError(
      'bad_units',
      `repair reopen requires 1-${FENCE_REPAIR_UNIT_CEILING} named unit(s), got ${units.length}`
    );
  }

  if (!areAllRepairRoundUnitsLocked(raw, params.repairRoundId) || !units.every(isUnitLocked)) {
    throw new FenceRepairRequeueError(
      'not_locked',
      `repair round ${params.repairRoundId}: every named unit must be hash-locked before reopen/dispatch (R5.2)`
    );
  }

  const requireIntact = params.requireIntactHash !== false;
  if (requireIntact) {
    for (const unit of units) {
      try {
        assertRepairTestHashIntact(raw, {
          repairUnitId: unit.id,
          repoRoot: params.repoRoot,
        });
      } catch (e) {
        if (e instanceof FenceRepairHashlockError && e.code === 'hash_mismatch') {
          throw new FenceRepairRequeueError(
            'hash_mismatch',
            e.message
          );
        }
        const msg = e instanceof Error ? e.message : String(e);
        throw new FenceRepairRequeueError('hash_mismatch', msg);
      }
    }
  }

  // Pre-check durable task state so we fail closed before partial mutation.
  for (const unit of units) {
    const task = loadTaskRow(raw, unit.run_task_id);
    if (task.reopen_reason !== 'repair') {
      throw new FenceRepairRequeueError(
        'reopen_refused',
        `task ${task.task_key} lacks reopen_reason=repair admission marker`
      );
    }
    if (Number(task.repair_generation) !== Number(unit.repair_generation)) {
      throw new FenceRepairRequeueError(
        'reopen_refused',
        `task ${task.task_key} repair_generation ${task.repair_generation} != unit generation ${unit.repair_generation}`
      );
    }
    if (task.status === 'pending' || task.status === 'working') {
      throw new FenceRepairRequeueError(
        'already_reopened',
        `task ${task.task_key} is already ${task.status}; repair reopen is complete→pending only once per lock`
      );
    }
    if (task.status !== 'complete') {
      throw new FenceRepairRequeueError(
        'bad_task_status',
        `task ${task.task_key} status '${task.status}' cannot reopen for repair (need complete)`
      );
    }
  }

  const reopened: ReopenedRepairUnit[] = [];

  const txn = raw.transaction(() => {
    for (const unit of units) {
      const change = raw
        .prepare(
          `UPDATE run_tasks
           SET status = 'pending',
               reopen_reason = 'repair',
               repair_generation = ?,
               repair_round_id = ?,
               updated_at = datetime('now')
           WHERE id = ?
             AND run_id = ?
             AND status = 'complete'
             AND reopen_reason = 'repair'
             AND repair_generation = ?
             AND repair_round_id = ?`
        )
        .run(
          unit.repair_generation,
          unit.repair_round_id,
          unit.run_task_id,
          unit.run_id,
          unit.repair_generation,
          unit.repair_round_id
        ) as { changes: number };

      if (change.changes !== 1) {
        throw new FenceRepairRequeueError(
          'reopen_refused',
          `atomic complete→pending refused for task ${unit.task_key} (CAS miss)`
        );
      }

      reopened.push({
        repair_unit_id: unit.id,
        run_task_id: unit.run_task_id,
        task_key: unit.task_key,
        repair_generation: unit.repair_generation,
        prior_status: unit.prior_status,
        status: 'pending',
        reopen_reason: 'repair',
        repair_test_path: unit.repair_test_path!,
        repair_test_hash: unit.repair_test_hash!,
      });
    }
  });

  txn();

  // Enqueue after durable commit so a queue failure does not leave half-reopened SQL
  // (status already pending — caller may re-enqueue; second reopen is refused).
  for (const unit of reopened) {
    const task = loadTaskRow(raw, unit.run_task_id);
    const batch =
      task.batch && String(task.batch).trim() ? String(task.batch).trim() : DEFAULT_BATCH;
    // Clear in-mem complete marker so claimNextReady can see the unit again.
    params.queue.rehydrateTaskStatus(unit.run_task_id, 'pending');
    // Seed durable batch into the queue graph (idempotent if already known), then
    // requeueForRedirect filters any prior slot and re-adds as URGENT once.
    params.queue.enqueueTask(unit.run_id, unit.run_task_id, false, batch);
    params.queue.requeueForRedirect(unit.run_id, unit.run_task_id);
  }

  return {
    ok: true,
    repair_round_id: round.id,
    fence_id: round.fence_id,
    run_id: round.run_id,
    fence_key: round.fence_key,
    units: reopened,
  };
}

function resolveUnitForDispatch(
  raw: SqliteDb,
  params: AssertRepairImplementerDispatchParams
): FenceRepairUnitRow {
  if (params.repairUnitId !== undefined) {
    const row = raw
      .prepare(
        `SELECT id, repair_round_id, fence_id, run_id, run_task_id, task_key,
                repair_generation, prior_status,
                repair_test_path, repair_test_hash, repair_assert_ids,
                authored_by, locked_at
         FROM fence_repair_units WHERE id = ?`
      )
      .get(params.repairUnitId) as FenceRepairUnitRow | undefined;
    if (!row) {
      throw new FenceRepairRequeueError(
        'missing_unit',
        `fence_repair_units id ${params.repairUnitId} not found`
      );
    }
    return row;
  }

  if (
    params.repairRoundId !== undefined &&
    typeof params.taskKey === 'string' &&
    params.taskKey.trim()
  ) {
    const row = raw
      .prepare(
        `SELECT id, repair_round_id, fence_id, run_id, run_task_id, task_key,
                repair_generation, prior_status,
                repair_test_path, repair_test_hash, repair_assert_ids,
                authored_by, locked_at
         FROM fence_repair_units
         WHERE repair_round_id = ? AND task_key = ?`
      )
      .get(params.repairRoundId, params.taskKey.trim()) as FenceRepairUnitRow | undefined;
    if (!row) {
      throw new FenceRepairRequeueError(
        'missing_unit',
        `fence_repair_units task '${params.taskKey}' not found for round ${params.repairRoundId}`
      );
    }
    return row;
  }

  if (params.runTaskId !== undefined) {
    const task = loadTaskRow(raw, params.runTaskId);
    if (task.repair_round_id == null) {
      throw new FenceRepairRequeueError(
        'dispatch_refused',
        `run_task ${params.runTaskId} has no repair_round_id — not a repair-admitted unit`
      );
    }
    const row = raw
      .prepare(
        `SELECT id, repair_round_id, fence_id, run_id, run_task_id, task_key,
                repair_generation, prior_status,
                repair_test_path, repair_test_hash, repair_assert_ids,
                authored_by, locked_at
         FROM fence_repair_units
         WHERE repair_round_id = ? AND run_task_id = ?`
      )
      .get(task.repair_round_id, params.runTaskId) as FenceRepairUnitRow | undefined;
    if (!row) {
      throw new FenceRepairRequeueError(
        'missing_unit',
        `no fence_repair_units row for run_task ${params.runTaskId} in round ${task.repair_round_id}`
      );
    }
    return row;
  }

  throw new FenceRepairRequeueError(
    'missing_unit',
    'assertRepairImplementerDispatchAllowed requires repairUnitId, (repairRoundId + taskKey), or runTaskId'
  );
}

/**
 * R5.2 / R5.3 gate: implementer dispatch is allowed only when the unit is
 * reopened for repair and its validator-owned hash lock is still intact.
 * Weakening the on-disk test refuses.
 */
export function assertRepairImplementerDispatchAllowed(
  db: DatabaseService | SqliteDb,
  params: AssertRepairImplementerDispatchParams
): AssertRepairImplementerDispatchResult {
  const raw = resolveRaw(db);
  const unit = resolveUnitForDispatch(raw, params);
  const task = loadTaskRow(raw, unit.run_task_id);

  if (task.reopen_reason !== 'repair') {
    throw new FenceRepairRequeueError(
      'dispatch_refused',
      `task ${task.task_key} is not repair-admitted (reopen_reason != 'repair')`
    );
  }

  if (task.status !== 'pending' && task.status !== 'working') {
    throw new FenceRepairRequeueError(
      'dispatch_refused',
      `task ${task.task_key} status '${task.status}' is not dispatchable for repair implementer (need pending|working after reopen)`
    );
  }

  if (!isUnitLocked(unit)) {
    throw new FenceRepairRequeueError(
      'not_locked',
      `task ${task.task_key} has no fill-once repair hash lock — implementer dispatch refused (R5.2)`
    );
  }

  try {
    const intact = assertRepairTestHashIntact(raw, {
      repairUnitId: unit.id,
      repoRoot: params.repoRoot,
    });
    return {
      ok: true,
      repair_unit_id: unit.id,
      run_task_id: unit.run_task_id,
      task_key: unit.task_key,
      repair_generation: unit.repair_generation,
      repair_test_path: intact.repair_test_path,
      repair_test_hash: intact.repair_test_hash,
    };
  } catch (e) {
    if (e instanceof FenceRepairHashlockError && e.code === 'hash_mismatch') {
      throw new FenceRepairRequeueError('hash_mismatch', e.message);
    }
    if (e instanceof FenceRepairHashlockError) {
      throw new FenceRepairRequeueError('dispatch_refused', e.message);
    }
    throw e;
  }
}

/**
 * True when a task is under active repair admission and must not be claimed for
 * implementer work until the locked hash is verified intact. Non-repair tasks
 * return false (ordinary unit gate unchanged).
 */
export function isRepairImplementerDispatchBlocked(
  db: DatabaseService | SqliteDb,
  runId: number,
  taskId: number,
  repoRoot?: string | null
): boolean {
  const raw = resolveRaw(db);
  let task: ReturnType<typeof loadTaskRow>;
  try {
    task = loadTaskRow(raw, taskId);
  } catch {
    return false;
  }
  if (task.run_id !== runId) return false;
  if (task.reopen_reason !== 'repair' || task.repair_round_id == null) {
    return false; // ordinary unit — R3 does not gate
  }
  try {
    assertRepairImplementerDispatchAllowed(raw, {
      runTaskId: taskId,
      repoRoot,
    });
    return false;
  } catch {
    return true;
  }
}

/** Inspect helper for tests / callers. */
export function getRepairReopenView(
  db: DatabaseService | SqliteDb,
  repairRoundId: number
): {
  repair_round_id: number;
  all_locked: boolean;
  units: Array<{
    task_key: string;
    run_task_id: number;
    status: string;
    reopen_reason: string | null;
    repair_generation: number;
    locked: boolean;
    repair_test_hash: string | null;
  }>;
} {
  const raw = resolveRaw(db);
  loadRound(raw, repairRoundId);
  const units = loadRoundUnits(raw, repairRoundId);
  return {
    repair_round_id: repairRoundId,
    all_locked: areAllRepairRoundUnitsLocked(raw, repairRoundId),
    units: units.map((u) => {
      const task = loadTaskRow(raw, u.run_task_id);
      const lock = getFenceRepairUnitLock(raw, { repairUnitId: u.id });
      return {
        task_key: u.task_key,
        run_task_id: u.run_task_id,
        status: task.status,
        reopen_reason: task.reopen_reason,
        repair_generation: task.repair_generation,
        locked: lock.locked,
        repair_test_hash: lock.repair_test_hash,
      };
    }),
  };
}

export { FENCE_REPAIR_UNIT_CEILING, areAllRepairRoundUnitsLocked, assertRepairTestHashIntact };
