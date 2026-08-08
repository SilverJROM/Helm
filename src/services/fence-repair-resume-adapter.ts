/**
 * fence-workflow-upgrade R5 — repair resume adapter (R5.5, R8.1).
 *
 * Reconstruct queue membership from durable task/fence/repair rows and resume
 * from one or two active fence_repair_units. Never overload deferred for repair.
 *
 * FIRST PASS intentional gap (deliberate F4 seam / R8.1):
 *   - In-process reconstruct uses the repair-generation JOIN and stays green.
 *   - Fresh-process selection intentionally omits that join (see
 *     loadActiveRepairUnitsForFreshProcess) so F4's real reopen→restart→resume
 *     journey fails first CLOSE and localizes REPAIR to this adapter.
 *   - resumeExistingRun is not yet generation-joined through this module; REPAIR
 *     wires the join into the fresh-process path.
 */
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import { DEFAULT_BATCH } from './execution-plan-parser.js';
import { FENCE_REPAIR_UNIT_CEILING } from './fence-repair-schema.js';
import type { TaskQueueService } from './task-queue-service.js';

export type SqliteDb = Database.Database;

export class FenceRepairResumeError extends Error {
  readonly code: FenceRepairResumeErrorCode;

  constructor(code: FenceRepairResumeErrorCode, message: string) {
    super(message);
    this.name = 'FenceRepairResumeError';
    this.code = code;
  }
}

export type FenceRepairResumeErrorCode =
  | 'no_active_units'
  | 'bad_units'
  | 'deferred_only'
  | 'missing_queue'
  | 'missing_task'
  | 'force_complete_refused';

export interface ActiveRepairUnit {
  repair_unit_id: number;
  repair_round_id: number;
  run_task_id: number;
  task_key: string;
  repair_generation: number;
  status: string;
  reopen_reason: 'repair';
  batch: string | null;
  fence_id: number;
  fence_key: string;
}

export interface ReconstructRepairResumeQueueResult {
  ok: true;
  run_id: number;
  /** Generation-matched active fence_repair_units that drive resume (1–2). */
  units: ActiveRepairUnit[];
  /** Durable deferred rows seen and left alone (repair never unparks them). */
  deferred_left_intact: number;
  /** Historical complete tasks outside the active repair generation. */
  historical_complete_count: number;
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

/**
 * Active repair units with the repair-generation JOIN (correct in-process path).
 *
 * A unit is active when durable run_tasks admission markers match the unit row:
 * reopen_reason='repair', status pending|working, and
 * run_tasks.repair_generation = fence_repair_units.repair_generation.
 */
export function loadActiveRepairUnits(
  db: DatabaseService | SqliteDb,
  runId: number
): ActiveRepairUnit[] {
  const raw = resolveRaw(db);
  return raw
    .prepare(
      `SELECT u.id AS repair_unit_id,
              u.repair_round_id AS repair_round_id,
              u.run_task_id AS run_task_id,
              u.task_key AS task_key,
              u.repair_generation AS repair_generation,
              t.status AS status,
              t.reopen_reason AS reopen_reason,
              t.batch AS batch,
              u.fence_id AS fence_id,
              f.fence_key AS fence_key
       FROM fence_repair_units u
       JOIN run_tasks t
         ON t.id = u.run_task_id
        AND t.run_id = u.run_id
        AND t.reopen_reason = 'repair'
        AND t.repair_generation = u.repair_generation
        AND t.repair_round_id = u.repair_round_id
       JOIN fences f ON f.id = u.fence_id
       WHERE u.run_id = ?
         AND t.status IN ('pending', 'working')
       ORDER BY u.id
       LIMIT ?`
    )
    .all(runId, FENCE_REPAIR_UNIT_CEILING) as ActiveRepairUnit[];
}

/**
 * FIRST PASS gap (R8.1 deliberate seam): select repair-admitted pending/working
 * tasks WITHOUT joining fence_repair_units.repair_generation.
 *
 * Diverges from durable unit history when generations drift — F4's fresh-process
 * journey must fail here until REPAIR wires the join into the real resume path.
 * Do not treat this as R5.5 acceptance.
 */
export function loadActiveRepairUnitsForFreshProcess(
  db: DatabaseService | SqliteDb,
  runId: number
): ActiveRepairUnit[] {
  const raw = resolveRaw(db);
  // Intentionally no generation join: task-side admission markers only.
  return raw
    .prepare(
      `SELECT COALESCE(u.id, 0) AS repair_unit_id,
              COALESCE(u.repair_round_id, t.repair_round_id, 0) AS repair_round_id,
              t.id AS run_task_id,
              t.task_key AS task_key,
              t.repair_generation AS repair_generation,
              t.status AS status,
              t.reopen_reason AS reopen_reason,
              t.batch AS batch,
              COALESCE(u.fence_id, f.id, 0) AS fence_id,
              COALESCE(f.fence_key, '') AS fence_key
       FROM run_tasks t
       LEFT JOIN fence_repair_units u
         ON u.run_task_id = t.id
        AND u.run_id = t.run_id
        /* FIRST PASS: deliberately omit
             AND u.repair_generation = t.repair_generation
             AND u.repair_round_id = t.repair_round_id
        */
       LEFT JOIN fences f
         ON f.id = u.fence_id
         OR (f.run_id = t.run_id AND f.lifecycle_state = 'repairing')
       WHERE t.run_id = ?
         AND t.reopen_reason = 'repair'
         AND t.status IN ('pending', 'working')
       GROUP BY t.id
       ORDER BY t.id
       LIMIT ?`
    )
    .all(runId, FENCE_REPAIR_UNIT_CEILING) as ActiveRepairUnit[];
}

/** True when generation-matched active repair units exist (1–2). */
export function hasActiveRepairResumeUnits(
  db: DatabaseService | SqliteDb,
  runId: number
): boolean {
  const units = loadActiveRepairUnits(db, runId);
  return units.length >= 1 && units.length <= FENCE_REPAIR_UNIT_CEILING;
}

/**
 * In-process resume reconstruct (focused R5 contract — green path).
 *
 * 1. Requires 1–2 generation-matched active fence_repair_units (never deferred-only).
 * 2. clearRun + enqueue every durable run_tasks row with its batch.
 * 3. Rehydrate durable statuses (completes stay complete; reopened stay pending).
 * 4. Leaves deferred rows intact — repair does not unpark them.
 * 5. Never force-completes a deliberate reopen.
 */
export function reconstructRepairResumeQueue(
  db: DatabaseService | SqliteDb,
  queue: TaskQueueService,
  runId: number
): ReconstructRepairResumeQueueResult {
  if (!queue) {
    throw new FenceRepairResumeError(
      'missing_queue',
      'reconstructRepairResumeQueue requires a live TaskQueueService'
    );
  }

  const raw = resolveRaw(db);
  const units = loadActiveRepairUnits(raw, runId);

  if (units.length === 0) {
    const deferredCount = Number(
      (
        raw
          .prepare(
            "SELECT COUNT(*) AS c FROM run_tasks WHERE run_id = ? AND status = 'deferred'"
          )
          .get(runId) as { c: number }
      ).c
    );
    if (deferredCount > 0) {
      throw new FenceRepairResumeError(
        'deferred_only',
        `run ${runId} has deferred task(s) but no active fence_repair_units; repair resume never uses deferred-only`
      );
    }
    throw new FenceRepairResumeError(
      'no_active_units',
      `run ${runId} has no active fence_repair_units to resume (need 1-${FENCE_REPAIR_UNIT_CEILING} generation-matched pending|working)`
    );
  }

  if (units.length > FENCE_REPAIR_UNIT_CEILING) {
    throw new FenceRepairResumeError(
      'bad_units',
      `repair resume supports at most ${FENCE_REPAIR_UNIT_CEILING} active units, got ${units.length}`
    );
  }

  const taskRows = raw
    .prepare(
      `SELECT id, task_key, batch, status, reopen_reason, repair_generation, repair_round_id
       FROM run_tasks WHERE run_id = ? ORDER BY id`
    )
    .all(runId) as Array<{
    id: number;
    task_key: string;
    batch: string | null;
    status: string;
    reopen_reason: string | null;
    repair_generation: number;
    repair_round_id: number | null;
  }>;

  if (taskRows.length === 0) {
    throw new FenceRepairResumeError(
      'missing_task',
      `run ${runId} has no durable run_tasks to reconstruct`
    );
  }

  const activeIds = new Set(units.map((u) => u.run_task_id));
  for (const unit of units) {
    const row = taskRows.find((t) => t.id === unit.run_task_id);
    if (!row) {
      throw new FenceRepairResumeError(
        'missing_task',
        `active repair unit ${unit.task_key} has no durable run_tasks row`
      );
    }
    // Never force-complete a deliberate reopen.
    if (row.status === 'complete' && row.reopen_reason === 'repair') {
      throw new FenceRepairResumeError(
        'force_complete_refused',
        `task ${row.task_key} is repair-admitted but complete; resume must not force-complete or erase reopen`
      );
    }
  }

  queue.clearRun(runId);

  let deferredLeft = 0;
  let historicalComplete = 0;

  for (const row of taskRows) {
    const batch =
      row.batch && String(row.batch).trim() ? String(row.batch).trim() : DEFAULT_BATCH;
    queue.enqueue(runId, row.id, [], false, batch);

    const status = row.status as 'pending' | 'complete' | 'failed' | 'deferred' | 'working';
    if (status === 'working') {
      // Working is not a rehydrate terminal set; treat as pending for claim readiness.
      queue.rehydrateTaskStatus(row.id, 'pending');
    } else if (
      status === 'pending' ||
      status === 'complete' ||
      status === 'failed' ||
      status === 'deferred'
    ) {
      queue.rehydrateTaskStatus(row.id, status);
    } else {
      queue.rehydrateTaskStatus(row.id, 'pending');
    }

    if (status === 'deferred') deferredLeft += 1;
    if (status === 'complete' && !activeIds.has(row.id)) historicalComplete += 1;
  }

  // Re-assert active repair units are pending in-mem (durable already pending).
  for (const unit of units) {
    queue.rehydrateTaskStatus(unit.run_task_id, 'pending');
    // Ensure they sit on the live queue for claim (idempotent if already present).
    queue.enqueueTask(runId, unit.run_task_id, false);
    queue.requeueForRedirect(runId, unit.run_task_id);
  }

  return {
    ok: true,
    run_id: runId,
    units,
    deferred_left_intact: deferredLeft,
    historical_complete_count: historicalComplete,
  };
}

/**
 * Fresh-process preparation entry (FIRST PASS — incomplete).
 *
 * Reconstructs from durable run_tasks using the non-generation-joined loader.
 * Intentionally does NOT call loadActiveRepairUnits (generation join). Callers
 * that need R5.5 acceptance must use reconstructRepairResumeQueue until REPAIR
 * replaces this body with the generation-matched path and wires resumeExistingRun.
 */
export function prepareFreshProcessRepairResume(
  db: DatabaseService | SqliteDb,
  queue: TaskQueueService,
  runId: number
): {
  ok: true;
  run_id: number;
  units: ActiveRepairUnit[];
  generation_join: false;
  note: string;
} {
  if (!queue) {
    throw new FenceRepairResumeError(
      'missing_queue',
      'prepareFreshProcessRepairResume requires a live TaskQueueService'
    );
  }

  const raw = resolveRaw(db);
  // FIRST PASS gap: no generation join.
  const units = loadActiveRepairUnitsForFreshProcess(raw, runId);
  if (units.length === 0) {
    throw new FenceRepairResumeError(
      'no_active_units',
      `fresh-process first-pass loader found no repair-admitted pending tasks for run ${runId} (generation join omitted)`
    );
  }

  const taskRows = raw
    .prepare(
      `SELECT id, batch, status FROM run_tasks WHERE run_id = ? ORDER BY id`
    )
    .all(runId) as Array<{ id: number; batch: string | null; status: string }>;

  queue.clearRun(runId);
  for (const row of taskRows) {
    const batch =
      row.batch && String(row.batch).trim() ? String(row.batch).trim() : DEFAULT_BATCH;
    queue.enqueue(runId, row.id, [], false, batch);
    const st = row.status as 'pending' | 'complete' | 'failed' | 'deferred';
    if (st === 'pending' || st === 'complete' || st === 'failed' || st === 'deferred') {
      queue.rehydrateTaskStatus(row.id, st);
    }
  }

  return {
    ok: true,
    run_id: runId,
    units,
    generation_join: false,
    note: 'FIRST PASS omits fence_repair_units.repair_generation join; REPAIR wires it for R5.5 fresh-process acceptance',
  };
}

export { FENCE_REPAIR_UNIT_CEILING };
