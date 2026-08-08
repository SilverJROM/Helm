/**
 * fence-workflow-upgrade R1 -- staged repair round admission (R5.1, R5.5).
 *
 * R1 owns durable history and current admission markers only. It localizes an
 * implementation-class fence failure to one or two named fence member units,
 * appends immutable repair history, and marks run_tasks with repair metadata.
 * It does not reopen tasks; later repair slices own the complete->pending move.
 */
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';

export type SqliteDb = Database.Database;

export const FENCE_REPAIR_UNIT_CEILING = 2;

export class FenceRepairSchemaError extends Error {
  readonly code: FenceRepairSchemaErrorCode;

  constructor(code: FenceRepairSchemaErrorCode, message: string) {
    super(message);
    this.name = 'FenceRepairSchemaError';
    this.code = code;
  }
}

export type FenceRepairSchemaErrorCode =
  | 'missing_fence'
  | 'bad_fault_class'
  | 'bad_units'
  | 'unknown_unit'
  | 'bad_task_status'
  | 'bad_state';

export interface BeginFenceRepairRoundParams {
  fenceId?: number;
  runId?: number;
  fenceKey?: string;
  faultClass: string;
  failingUnits: readonly string[];
  verdictFingerprint?: string | null;
}

export interface FenceRepairUnitAdmission {
  run_task_id: number;
  task_key: string;
  prior_status: string;
  repair_generation: number;
}

export interface BeginFenceRepairRoundResult {
  repair_round_id: number;
  fence_id: number;
  run_id: number;
  fence_key: string;
  round_number: number;
  status: 'staged';
  failing_units: string[];
  units: FenceRepairUnitAdmission[];
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

function normalizeUnits(input: readonly string[]): string[] {
  if (!Array.isArray(input)) {
    throw new FenceRepairSchemaError('bad_units', 'failingUnits must be an array');
  }
  const units = input.map((u) => String(u ?? '').trim()).filter(Boolean);
  if (units.length === 0 || units.length > FENCE_REPAIR_UNIT_CEILING) {
    throw new FenceRepairSchemaError(
      'bad_units',
      `repair round requires 1-${FENCE_REPAIR_UNIT_CEILING} named failing unit(s)`
    );
  }
  if (new Set(units).size !== units.length) {
    throw new FenceRepairSchemaError('bad_units', 'repair round failingUnits must be unique');
  }
  return units;
}

function loadFence(
  raw: SqliteDb,
  params: { fenceId?: number; runId?: number; fenceKey?: string }
): { id: number; run_id: number; fence_key: string } {
  let row: { id: number; run_id: number; fence_key: string } | undefined;
  if (params.fenceId !== undefined) {
    row = raw
      .prepare('SELECT id, run_id, fence_key FROM fences WHERE id = ?')
      .get(params.fenceId) as { id: number; run_id: number; fence_key: string } | undefined;
  } else if (
    params.runId !== undefined &&
    typeof params.fenceKey === 'string' &&
    params.fenceKey.trim()
  ) {
    row = raw
      .prepare('SELECT id, run_id, fence_key FROM fences WHERE run_id = ? AND fence_key = ?')
      .get(params.runId, params.fenceKey.trim()) as
      | { id: number; run_id: number; fence_key: string }
      | undefined;
  } else {
    throw new FenceRepairSchemaError(
      'missing_fence',
      'beginFenceRepairRound requires fenceId or (runId + fenceKey)'
    );
  }
  if (!row) throw new FenceRepairSchemaError('missing_fence', 'fence not found');
  return row;
}

export function beginFenceRepairRound(
  db: DatabaseService | SqliteDb,
  params: BeginFenceRepairRoundParams
): BeginFenceRepairRoundResult {
  if (params.faultClass !== 'implementation') {
    throw new FenceRepairSchemaError(
      'bad_fault_class',
      `repair round admission only accepts fault_class=implementation, got '${params.faultClass}'`
    );
  }

  const raw = resolveRaw(db);
  const failingUnits = normalizeUnits(params.failingUnits);
  const fence = loadFence(raw, params);

  const txn = raw.transaction(() => {
    const rows = raw
      .prepare(
        `SELECT rt.id AS run_task_id,
                rt.task_key AS task_key,
                rt.status AS status,
                rt.repair_generation AS repair_generation
         FROM fence_members fm
         JOIN run_tasks rt
           ON rt.run_id = ?
          AND rt.task_key = fm.task_key
         WHERE fm.fence_id = ?
           AND fm.task_key IN (${failingUnits.map(() => '?').join(',')})
         ORDER BY fm.position, fm.id`
      )
      .all(fence.run_id, fence.id, ...failingUnits) as Array<{
      run_task_id: number;
      task_key: string;
      status: string;
      repair_generation: number | null;
    }>;

    const found = new Set(rows.map((r) => r.task_key));
    const missing = failingUnits.filter((u) => !found.has(u));
    if (missing.length > 0) {
      throw new FenceRepairSchemaError(
        'unknown_unit',
        `repair units must be existing members with run_tasks rows: ${missing.join(', ')}`
      );
    }

    for (const row of rows) {
      if (row.status === 'deferred') {
        throw new FenceRepairSchemaError(
          'bad_task_status',
          `repair unit ${row.task_key} is deferred; repair admission must not overload deferred`
        );
      }
      if (row.status === 'working') {
        throw new FenceRepairSchemaError(
          'bad_task_status',
          `repair unit ${row.task_key} is working; repair admission requires an inactive unit`
        );
      }
    }

    const roundNumber = Number(
      (
        raw
          .prepare('SELECT COALESCE(MAX(round_number), 0) + 1 AS n FROM fence_repair_rounds WHERE fence_id = ?')
          .get(fence.id) as { n: number }
      ).n
    );

    const repairRoundId = Number(
      (
        raw
          .prepare(
            `INSERT INTO fence_repair_rounds (
               fence_id, run_id, fence_key, round_number,
               fault_class, status, failing_units, verdict_fingerprint
             )
             VALUES (?, ?, ?, ?, 'implementation', 'staged', ?, ?)
             RETURNING id`
          )
          .get(
            fence.id,
            fence.run_id,
            fence.fence_key,
            roundNumber,
            JSON.stringify(failingUnits),
            params.verdictFingerprint?.trim() || null
          ) as { id: number }
      ).id
    );

    const admitted: FenceRepairUnitAdmission[] = [];
    for (const unit of failingUnits) {
      const row = rows.find((candidate) => candidate.task_key === unit)!;
      const nextGeneration = Number(row.repair_generation ?? 0) + 1;
      raw
        .prepare(
          `INSERT INTO fence_repair_units (
             repair_round_id, fence_id, run_id, run_task_id,
             task_key, repair_generation, prior_status
           )
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          repairRoundId,
          fence.id,
          fence.run_id,
          row.run_task_id,
          row.task_key,
          nextGeneration,
          row.status
        );
      raw
        .prepare(
          `UPDATE run_tasks
           SET reopen_reason = 'repair',
               repair_generation = ?,
               repair_round_id = ?,
               updated_at = datetime('now')
           WHERE id = ?`
        )
        .run(nextGeneration, repairRoundId, row.run_task_id);
      admitted.push({
        run_task_id: row.run_task_id,
        task_key: row.task_key,
        prior_status: row.status,
        repair_generation: nextGeneration,
      });
    }

    const fenceChange = raw
      .prepare(
        `UPDATE fences
         SET lifecycle_state = 'repairing', updated_at = datetime('now')
         WHERE id = ?
           AND lifecycle_state IN ('draining', 'closing', 'repairing')`
      )
      .run(fence.id);
    if (fenceChange.changes !== 1) {
      throw new FenceRepairSchemaError(
        'bad_state',
        `fence '${fence.fence_key}' is not in a repairable lifecycle state`
      );
    }

    return {
      repair_round_id: repairRoundId,
      fence_id: fence.id,
      run_id: fence.run_id,
      fence_key: fence.fence_key,
      round_number: roundNumber,
      status: 'staged' as const,
      failing_units: failingUnits,
      units: admitted,
    };
  });

  return txn();
}
