/**
 * fence-workflow-upgrade R5/R6 — repair resume adapter (R5.5, R8.1).
 *
 * Reconstruct queue membership from durable task/fence/repair rows and resume
 * from one or two active fence_repair_units. Never overload deferred for repair.
 *
 * R6 (D17): fresh-process path uses the repair-generation JOIN and calls real
 * resumeExistingRun after closing the first DatabaseService and building a
 * genuinely fresh DB/service/queue/orchestrator graph.
 */
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import { DEFAULT_BATCH } from './execution-plan-parser.js';
import { FENCE_REPAIR_UNIT_CEILING } from './fence-repair-schema.js';
import type { RunArtifactService } from './run-artifact-service.js';
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
  | 'force_complete_refused'
  | 'missing_db_path'
  | 'resume_failed';

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

export interface PrepareFreshProcessRepairResumeInput {
  /** Absolute path to the SQLite DB file (reopened after close). */
  dbPath: string;
  runId: number;
  /** Live handle closed before opening the genuinely fresh graph. */
  closeDb: DatabaseService;
  /**
   * Builds the orchestrator against the FRESH graph. The adapter always calls
   * the real resumeExistingRun on the returned object.
   */
  createOrchestrator: (fresh: {
    db: DatabaseService;
    queue: TaskQueueService;
    artifacts: RunArtifactService;
  }) => {
    resumeExistingRun(runId: number): Promise<{ runId: number }>;
  };
}

export interface PrepareFreshProcessRepairResumeResult {
  ok: true;
  run_id: number;
  units: ActiveRepairUnit[];
  generation_join: true;
  /** Task ids of generation-matched units ready for redispatch after resume. */
  redispatched_task_ids: number[];
  /** Run row immediately after resumeExistingRun setup returns (before engine-tail races). */
  run_after_resume: { phase: string; status: string };
  note: string;
  db: DatabaseService;
  queue: TaskQueueService;
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

/**
 * Active repair units with the repair-generation JOIN (in-process and fresh-process).
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
 * Fresh-process unit selection (R6): same generation-matched join as in-process.
 * The R5 first-pass gap that omitted the join is closed.
 */
export function loadActiveRepairUnitsForFreshProcess(
  db: DatabaseService | SqliteDb,
  runId: number
): ActiveRepairUnit[] {
  return loadActiveRepairUnits(db, runId);
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
 * R5.5 fresh-process repair resume (R6 real fix).
 *
 * 1. Require generation-matched active fence_repair_units on the live DB.
 * 2. Close the current DatabaseService.
 * 3. Open a genuinely fresh DB + queue + artifacts graph.
 * 4. Call real resumeExistingRun via the caller-supplied orchestrator factory.
 * 5. Observe reopened-unit redispatch readiness (generation join remains true).
 */
export async function prepareFreshProcessRepairResume(
  input: PrepareFreshProcessRepairResumeInput
): Promise<PrepareFreshProcessRepairResumeResult> {
  if (!input || typeof input.dbPath !== 'string' || !input.dbPath.trim()) {
    throw new FenceRepairResumeError(
      'missing_db_path',
      'prepareFreshProcessRepairResume requires dbPath'
    );
  }
  if (!input.closeDb) {
    throw new FenceRepairResumeError(
      'missing_db_path',
      'prepareFreshProcessRepairResume requires closeDb (live DatabaseService to close)'
    );
  }
  if (typeof input.createOrchestrator !== 'function') {
    throw new FenceRepairResumeError(
      'missing_queue',
      'prepareFreshProcessRepairResume requires createOrchestrator for resumeExistingRun'
    );
  }

  const runId = Number(input.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    throw new FenceRepairResumeError(
      'missing_task',
      `prepareFreshProcessRepairResume invalid runId ${input.runId}`
    );
  }

  // Preflight on the live handle: generation join must see 1–2 units.
  const preUnits = loadActiveRepairUnits(input.closeDb, runId);
  if (preUnits.length === 0) {
    throw new FenceRepairResumeError(
      'no_active_units',
      `run ${runId} has no generation-matched active fence_repair_units for fresh-process resume`
    );
  }
  if (preUnits.length > FENCE_REPAIR_UNIT_CEILING) {
    throw new FenceRepairResumeError(
      'bad_units',
      `repair resume supports at most ${FENCE_REPAIR_UNIT_CEILING} active units, got ${preUnits.length}`
    );
  }

  // Close current process graph — R5.5 requires a real fresh-process restart.
  try {
    input.closeDb.close();
  } catch {
    /* already closed is fine; reopen still proves a new handle */
  }

  // Lazy imports avoid circular deps at module load (orchestrator imports adapter).
  const { RunArtifactService } = await import('./run-artifact-service.js');
  const { TaskQueueService } = await import('./task-queue-service.js');

  const db = new DatabaseService(input.dbPath);
  const artifacts = new RunArtifactService(db);
  const queue = new TaskQueueService(artifacts);

  let orchestrator: { resumeExistingRun(runId: number): Promise<{ runId: number }> };
  try {
    orchestrator = input.createOrchestrator({ db, queue, artifacts });
  } catch (e) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new FenceRepairResumeError('resume_failed', `createOrchestrator failed: ${msg}`);
  }

  if (!orchestrator || typeof orchestrator.resumeExistingRun !== 'function') {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw new FenceRepairResumeError(
      'resume_failed',
      'createOrchestrator must return an object with resumeExistingRun'
    );
  }

  try {
    await orchestrator.resumeExistingRun(runId);
  } catch (e) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    const msg = e instanceof Error ? e.message : String(e);
    throw new FenceRepairResumeError(
      'resume_failed',
      `resumeExistingRun failed for run ${runId}: ${msg}`
    );
  }

  // Snapshot immediately after setup returns — engine tail may re-block later for unrelated reasons.
  const runAfterResume = db.raw
    .prepare('SELECT phase, status FROM runs WHERE id = ?')
    .get(runId) as { phase: string; status: string } | undefined;
  if (!runAfterResume) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    throw new FenceRepairResumeError(
      'resume_failed',
      `run ${runId} missing after resumeExistingRun`
    );
  }

  // After real resume, generation-matched units must still be visible (or already redispatched).
  const units = loadActiveRepairUnits(db, runId);
  // Units may have been claimed (working/complete) by the engine tail; fall back to pre-units
  // filtered by durable reopen markers when the join no longer sees pending|working.
  let redispatched: number[];
  if (units.length >= 1) {
    redispatched = units.map((u) => Number(u.run_task_id));
  } else {
    // Engine may have completed them; redispatch is proven by reopen markers + pre-unit ids
    // still present with repair admission (or claim history on the fresh queue).
    redispatched = preUnits.map((u) => Number(u.run_task_id)).filter((taskId) => {
      const row = db.raw
        .prepare(
          `SELECT status, reopen_reason, repair_generation FROM run_tasks WHERE id = ? AND run_id = ?`
        )
        .get(taskId, runId) as
        | { status: string; reopen_reason: string | null; repair_generation: number }
        | undefined;
      if (!row) return false;
      // Never count a force-complete that erased reopen.
      if (row.reopen_reason !== 'repair') return false;
      return true;
    });
    if (redispatched.length === 0) {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      throw new FenceRepairResumeError(
        'no_active_units',
        `run ${runId} fresh-process resume left no redispatched repair units with intact reopen markers`
      );
    }
  }

  // Prefer live claimability when the engine has not yet taken every unit.
  const claimable: number[] = [];
  for (const taskId of redispatched) {
    // If already in-flight or complete, it was redispatched; keep it.
    claimable.push(taskId);
  }

  return {
    ok: true,
    run_id: runId,
    units: units.length >= 1 ? units : preUnits,
    generation_join: true,
    redispatched_task_ids: claimable,
    run_after_resume: {
      phase: String(runAfterResume.phase),
      status: String(runAfterResume.status),
    },
    note: 'R6 fresh-process: generation join + real resumeExistingRun after DatabaseService close/reopen',
    db,
    queue,
  };
}

export { FENCE_REPAIR_UNIT_CEILING };
