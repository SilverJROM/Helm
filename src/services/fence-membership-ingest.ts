/**
 * fence-workflow-upgrade A3 — transactional plan-fence membership ingest (R1.1, R1.4).
 *
 * Writes validated plan fences into `fences` + `fence_members` so unit↔fence membership is
 * inspectable via SQL (not reconstructable only from application code). Ceiling of
 * FENCE_MEMBER_CEILING (5) is enforced here as defense-in-depth (A2 already refuses at accept).
 *
 * Transactional: all fence + member rows for a call land together, or none do.
 */
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import {
  FENCE_MEMBER_CEILING,
  type FencePlanContract,
} from './fence-plan-contract.js';

export type SqliteDb = Database.Database;

export interface IngestFenceMembershipParams {
  runId: number;
  /** Optional; when omitted, resolved from runs.cycle_id for this run. */
  cycleId?: number | null;
  fences: readonly FencePlanContract[];
}

export interface IngestFenceMembershipResult {
  /** fence_key → fences.id */
  fenceIdsByKey: Record<string, number>;
  /** Total fence_members rows written. */
  memberCount: number;
}

export interface FenceMembershipRow {
  fence_key: string;
  fence_id: number;
  run_id: number;
  lifecycle_state: string;
  task_key: string;
  position: number;
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

/**
 * Insert plan fences + membership for a run. Empty `fences` is a no-op success.
 * Throws on ceiling violation, empty members, or DB constraint failure — and rolls back.
 */
export function ingestFenceMembership(
  db: DatabaseService | SqliteDb,
  params: IngestFenceMembershipParams
): IngestFenceMembershipResult {
  const raw = resolveRaw(db);
  const { runId, fences } = params;

  if (!Number.isFinite(runId) || runId <= 0) {
    throw new Error(`ingestFenceMembership: invalid runId ${runId}`);
  }
  if (!Array.isArray(fences)) {
    throw new Error('ingestFenceMembership: fences must be an array');
  }

  // Pre-flight ceiling + members (before any write) so the error is clear and no partial rows.
  for (const fence of fences) {
    if (!fence || typeof fence.fence_key !== 'string' || !fence.fence_key.trim()) {
      throw new Error('ingestFenceMembership: each fence requires a non-empty fence_key');
    }
    const members = fence.members ?? [];
    if (!Array.isArray(members) || members.length === 0) {
      throw new Error(
        `ingestFenceMembership: fence '${fence.fence_key}' must list at least one contributing unit`
      );
    }
    if (members.length > FENCE_MEMBER_CEILING) {
      throw new Error(
        `ingestFenceMembership: fence '${fence.fence_key}' has ${members.length} members — ` +
          `ceiling is ${FENCE_MEMBER_CEILING} contributing units per fence`
      );
    }
  }

  const work = (): IngestFenceMembershipResult => {
    let cycleId: number | null =
      params.cycleId === undefined ? null : params.cycleId ?? null;
    if (params.cycleId === undefined) {
      const runRow = raw
        .prepare('SELECT cycle_id FROM runs WHERE id = ?')
        .get(runId) as { cycle_id: number | null } | undefined;
      if (!runRow) {
        throw new Error(`ingestFenceMembership: run ${runId} not found`);
      }
      cycleId = runRow.cycle_id ?? null;
    }

    const insertFence = raw.prepare(`
      INSERT INTO fences (
        fence_key, run_id, cycle_id, lifecycle_state,
        integration_cmd, negative_control_cmd, acceptance_ids,
        test_path, authored_by, label
      ) VALUES (?, ?, ?, 'declared', ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const insertMember = raw.prepare(`
      INSERT INTO fence_members (fence_id, task_key, position)
      VALUES (?, ?, ?)
    `);

    const fenceIdsByKey: Record<string, number> = {};
    let memberCount = 0;

    for (const fence of fences) {
      const acceptanceJson = JSON.stringify(fence.acceptance_ids ?? []);
      const row = insertFence.get(
        fence.fence_key,
        runId,
        cycleId,
        fence.integration_cmd,
        fence.negative_control_cmd,
        acceptanceJson,
        fence.test_path ?? null,
        fence.authored_by ?? null,
        fence.label ?? null
      ) as { id: number };
      const fenceId = row.id;
      fenceIdsByKey[fence.fence_key] = fenceId;

      fence.members.forEach((taskKey, position) => {
        insertMember.run(fenceId, taskKey, position);
        memberCount += 1;
      });
    }

    return { fenceIdsByKey, memberCount };
  };

  // Nested-safe: better-sqlite3 uses SAVEPOINT when already inside a transaction (e.g. plan ingest).
  return raw.transaction(work)();
}

/**
 * R1.4 — inspectable unit↔fence membership for a run (SQL join, not code reconstruction).
 * Ordered by fence_key then position so tests and operators see a stable listing.
 */
export function queryFenceMembership(
  db: DatabaseService | SqliteDb,
  runId: number
): FenceMembershipRow[] {
  const raw = resolveRaw(db);
  return raw
    .prepare(
      `SELECT
         f.fence_key AS fence_key,
         f.id AS fence_id,
         f.run_id AS run_id,
         f.lifecycle_state AS lifecycle_state,
         m.task_key AS task_key,
         m.position AS position
       FROM fence_members m
       INNER JOIN fences f ON f.id = m.fence_id
       WHERE f.run_id = ?
       ORDER BY f.fence_key ASC, m.position ASC, m.task_key ASC`
    )
    .all(runId) as FenceMembershipRow[];
}

/**
 * List declared fence rows for a run (contract fields + lifecycle), inspectable via SQL.
 */
export function queryFencesForRun(
  db: DatabaseService | SqliteDb,
  runId: number
): Array<{
  id: number;
  fence_key: string;
  run_id: number;
  cycle_id: number | null;
  lifecycle_state: string;
  integration_cmd: string;
  negative_control_cmd: string;
  acceptance_ids: string;
  test_path: string | null;
  authored_by: string | null;
  label: string | null;
}> {
  const raw = resolveRaw(db);
  return raw
    .prepare(
      `SELECT id, fence_key, run_id, cycle_id, lifecycle_state,
              integration_cmd, negative_control_cmd, acceptance_ids,
              test_path, authored_by, label
       FROM fences
       WHERE run_id = ?
       ORDER BY fence_key ASC`
    )
    .all(runId) as Array<{
    id: number;
    fence_key: string;
    run_id: number;
    cycle_id: number | null;
    lifecycle_state: string;
    integration_cmd: string;
    negative_control_cmd: string;
    acceptance_ids: string;
    test_path: string | null;
    authored_by: string | null;
    label: string | null;
  }>;
}
