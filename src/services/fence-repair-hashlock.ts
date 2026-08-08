/**
 * fence-workflow-upgrade R2 — validator-authored repair test hash-lock (R5.1–R5.3).
 *
 * Flow (before any reopen or implementer dispatch):
 *   1. Ordinary validator authors the failing unit's regression test on disk (R5.1).
 *   2. Driver red-verifies the test collects and fails a named assertion on HEAD (R5.2).
 *   3. Test path + sha256 hash + failing assert ids are fill-once locked on
 *      fence_repair_units. Weakening the test later is a hash mismatch refuse (R5.3).
 *
 * Does not reopen units or enqueue implementers — those belong to R3.
 */
import fs from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import { hashTestFile } from './fence-open-service.js';
import {
  failedIds,
  isProvingKind,
  normalizeFailed,
  provingFailure,
  runFenceReportCommand,
  type FenceReportV1,
  type RunFenceReportCommandResult,
} from './fence-report-v1.js';

export type SqliteDb = Database.Database;

export class FenceRepairHashlockError extends Error {
  readonly code: FenceRepairHashlockErrorCode;

  constructor(code: FenceRepairHashlockErrorCode, message: string) {
    super(message);
    this.name = 'FenceRepairHashlockError';
    this.code = code;
  }
}

export type FenceRepairHashlockErrorCode =
  | 'missing_unit'
  | 'bad_author'
  | 'already_locked'
  | 'missing_test_path'
  | 'missing_test_cmd'
  | 'report_error'
  | 'collect_refused'
  | 'proving_refused'
  | 'assert_mismatch'
  | 'hash_mismatch'
  | 'lock_refused'
  | 'artifact_record_refused';

export interface FenceRepairUnitRow {
  id: number;
  repair_round_id: number;
  fence_id: number;
  run_id: number;
  run_task_id: number;
  task_key: string;
  repair_generation: number;
  prior_status: string;
  repair_test_path: string | null;
  repair_test_hash: string | null;
  repair_assert_ids: string | null;
  authored_by: string | null;
  locked_at: string | null;
}

export interface LockFenceRepairUnitTestParams {
  /** Prefer direct unit id when known. */
  repairUnitId?: number;
  /** Or (repairRoundId + taskKey). */
  repairRoundId?: number;
  taskKey?: string;
  /** Validator-authored repair test path (repo-relative or absolute). */
  repairTestPath: string;
  /**
   * Command that produces fence-report-v1 for the repair test.
   * Required unless `runCommand` is injected.
   */
  testCmd?: string;
  /**
   * Author of the repair test. Must be the ordinary validator ladder
   * (validator / validator.L1–L4). Implementer is always refused (R5.1 / R5.3).
   */
  authoredBy?: string;
  /** Optional explicit list of named assert ids that must appear in proving failures. */
  expectedAssertIds?: readonly string[];
  cwd?: string;
  repoRoot?: string | null;
  runDir?: string | null;
  reportPath?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  runCommand?: (opts: {
    cmd: string;
    cwd: string;
    runDir?: string | null;
    reportPath?: string | null;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) => RunFenceReportCommandResult;
}

export interface LockFenceRepairUnitTestResult {
  ok: true;
  repair_unit_id: number;
  repair_round_id: number;
  fence_id: number;
  run_id: number;
  task_key: string;
  repair_test_path: string;
  repair_test_hash: string;
  repair_assert_ids: string[];
  authored_by: string;
  locked_at: string;
  report: FenceReportV1;
  reportPath: string;
  exitCode: number;
  artifactId: number;
}

export interface FenceRepairUnitLockView {
  repair_unit_id: number;
  repair_round_id: number;
  run_id: number;
  task_key: string;
  locked: boolean;
  repair_test_path: string | null;
  repair_test_hash: string | null;
  repair_assert_ids: string[];
  authored_by: string | null;
  locked_at: string | null;
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))].sort();
}

/** Ordinary per-unit validator ladder only — not integration_test_agent, not implementer. */
export function isOrdinaryValidatorAuthor(author: string | null | undefined): boolean {
  const a = String(author ?? '').trim();
  if (!a) return false;
  // validator | validator.L1 | validator_L2 | validator-L3 | Validator.L4
  return /^validator([._-]L[1-4])?$/i.test(a);
}

function normalizeAuthor(author: string | null | undefined): string {
  const a = String(author ?? 'validator').trim() || 'validator';
  if (!isOrdinaryValidatorAuthor(a)) {
    throw new FenceRepairHashlockError(
      'bad_author',
      `repair test must be authored by the ordinary validator ladder, got '${a}'`
    );
  }
  // Canonical lowercase form for durable record.
  const m = a.match(/^validator(?:[._-](L[1-4]))?$/i)!;
  return m[1] ? `validator.${m[1].toUpperCase()}` : 'validator';
}

function parseAssertIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return sortedUnique(parsed.map((x) => String(x)));
  } catch {
    return [];
  }
}

function loadRepairUnit(
  raw: SqliteDb,
  params: { repairUnitId?: number; repairRoundId?: number; taskKey?: string }
): FenceRepairUnitRow {
  let row: FenceRepairUnitRow | undefined;
  if (params.repairUnitId !== undefined) {
    row = raw
      .prepare(
        `SELECT id, repair_round_id, fence_id, run_id, run_task_id, task_key,
                repair_generation, prior_status,
                repair_test_path, repair_test_hash, repair_assert_ids,
                authored_by, locked_at
         FROM fence_repair_units WHERE id = ?`
      )
      .get(params.repairUnitId) as FenceRepairUnitRow | undefined;
  } else if (
    params.repairRoundId !== undefined &&
    typeof params.taskKey === 'string' &&
    params.taskKey.trim()
  ) {
    row = raw
      .prepare(
        `SELECT id, repair_round_id, fence_id, run_id, run_task_id, task_key,
                repair_generation, prior_status,
                repair_test_path, repair_test_hash, repair_assert_ids,
                authored_by, locked_at
         FROM fence_repair_units
         WHERE repair_round_id = ? AND task_key = ?`
      )
      .get(params.repairRoundId, params.taskKey.trim()) as FenceRepairUnitRow | undefined;
  } else {
    throw new FenceRepairHashlockError(
      'missing_unit',
      'lockFenceRepairUnitTest requires repairUnitId or (repairRoundId + taskKey)'
    );
  }

  if (!row) {
    throw new FenceRepairHashlockError(
      'missing_unit',
      params.repairUnitId !== undefined
        ? `fence_repair_units id ${params.repairUnitId} not found`
        : `fence_repair_units task '${params.taskKey}' not found for round ${params.repairRoundId}`
    );
  }
  return row;
}

function resolveRepairTestPath(opts: {
  repairTestPath: string;
  repoRoot: string;
}): { relOrAbs: string; abs: string } {
  const tp = opts.repairTestPath?.trim();
  if (!tp) {
    throw new FenceRepairHashlockError(
      'missing_test_path',
      'repair hash-lock requires a validator-authored repairTestPath on disk'
    );
  }
  const abs = path.isAbsolute(tp) ? tp : path.join(opts.repoRoot, tp);
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
    throw new FenceRepairHashlockError(
      'missing_test_path',
      `repair test path '${tp}' is missing or not a file`
    );
  }
  return { relOrAbs: tp, abs };
}

function commitLock(
  raw: SqliteDb,
  opts: {
    unitId: number;
    repairTestPath: string;
    repairTestHash: string;
    repairAssertIds: readonly string[];
    authoredBy: string;
  }
): string {
  try {
    const info = raw
      .prepare(
        `UPDATE fence_repair_units
         SET repair_test_path = ?,
             repair_test_hash = ?,
             repair_assert_ids = ?,
             authored_by = ?,
             locked_at = datetime('now')
         WHERE id = ?
           AND repair_test_hash IS NULL
           AND repair_test_path IS NULL
         RETURNING locked_at`
      )
      .get(
        opts.repairTestPath,
        opts.repairTestHash,
        JSON.stringify(sortedUnique(opts.repairAssertIds)),
        opts.authoredBy,
        opts.unitId
      ) as { locked_at: string } | undefined;

    if (!info?.locked_at) {
      throw new FenceRepairHashlockError(
        'lock_refused',
        `repair unit ${opts.unitId} refused fill-once hash lock (already locked or concurrent write)`
      );
    }
    return info.locked_at;
  } catch (e) {
    if (e instanceof FenceRepairHashlockError) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (/append-only|fill-once/i.test(msg)) {
      throw new FenceRepairHashlockError(
        'already_locked',
        `repair unit ${opts.unitId} hash lock is immutable after first fill: ${msg}`
      );
    }
    throw new FenceRepairHashlockError('lock_refused', `repair hash lock write failed: ${msg}`);
  }
}

function recordLockArtifact(
  raw: SqliteDb,
  opts: {
    runId: number;
    testPath: string;
    testHash: string;
  }
): number {
  const info = raw
    .prepare(
      `INSERT INTO artifacts (run_id, type, path, sha, created_at)
       VALUES (?, 'fence-repair-hashlock', ?, ?, datetime('now'))`
    )
    .run(opts.runId, opts.testPath, opts.testHash);
  const id = Number(info.lastInsertRowid);
  if (!Number.isFinite(id) || id <= 0) {
    throw new FenceRepairHashlockError(
      'artifact_record_refused',
      `repair hash-lock did not record a run artifact for run ${opts.runId}`
    );
  }
  return id;
}

/**
 * Red-verify a validator-authored unit repair test on HEAD, then fill-once
 * hash-lock it on fence_repair_units (R5.1, R5.2, R5.3).
 */
export function lockFenceRepairUnitTest(
  db: DatabaseService | SqliteDb,
  params: LockFenceRepairUnitTestParams
): LockFenceRepairUnitTestResult {
  const raw = resolveRaw(db);
  const unit = loadRepairUnit(raw, params);
  const authoredBy = normalizeAuthor(params.authoredBy);
  const cwd = params.cwd ?? process.cwd();
  const repoRoot = params.repoRoot?.trim() || cwd;

  if (unit.repair_test_hash || unit.repair_test_path || unit.locked_at) {
    throw new FenceRepairHashlockError(
      'already_locked',
      `repair unit ${unit.id} (${unit.task_key}) is already hash-locked; weakening or re-authoring is refused (R5.3)`
    );
  }

  const { relOrAbs, abs } = resolveRepairTestPath({
    repairTestPath: params.repairTestPath,
    repoRoot,
  });

  let repairTestHash: string;
  try {
    repairTestHash = hashTestFile(abs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FenceRepairHashlockError('missing_test_path', `could not hash repair test: ${msg}`);
  }

  const cmd = params.testCmd?.trim();
  if (!cmd && !params.runCommand) {
    throw new FenceRepairHashlockError(
      'missing_test_cmd',
      'repair red-verify requires testCmd (or an injected runCommand) that emits fence-report-v1'
    );
  }

  const run =
    params.runCommand ??
    ((opts) =>
      runFenceReportCommand({
        cmd: opts.cmd,
        cwd: opts.cwd,
        runDir: opts.runDir,
        reportPath: opts.reportPath,
        env: opts.env,
        timeoutMs: opts.timeoutMs,
      }));

  let runResult: RunFenceReportCommandResult;
  try {
    runResult = run({
      cmd: cmd || 'true',
      cwd,
      runDir: params.runDir,
      reportPath: params.reportPath,
      env: params.env,
      timeoutMs: params.timeoutMs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FenceRepairHashlockError('report_error', `repair red-verify could not read a report: ${msg}`);
  }

  if (!runResult.report.collected || runResult.report.collected.length === 0) {
    throw new FenceRepairHashlockError(
      'collect_refused',
      `repair test for unit ${unit.task_key} did not collect any assertions on HEAD — collection red is not a proving red`
    );
  }

  const proof = provingFailure(runResult.report);
  if (!proof.ok) {
    throw new FenceRepairHashlockError(
      'proving_refused',
      `repair red-verify refused for unit ${unit.task_key}: ${proof.reason}`
    );
  }

  const provingIds = sortedUnique(
    normalizeFailed(runResult.report.failed)
      .filter((f) => isProvingKind(f.kind))
      .map((f) => f.id)
  );
  if (provingIds.length === 0) {
    throw new FenceRepairHashlockError(
      'proving_refused',
      `repair red-verify for unit ${unit.task_key} produced no named proving assertion ids`
    );
  }

  if (params.expectedAssertIds && params.expectedAssertIds.length > 0) {
    const expected = sortedUnique(params.expectedAssertIds);
    const have = new Set(provingIds);
    const missing = expected.filter((id) => !have.has(id));
    if (missing.length > 0) {
      throw new FenceRepairHashlockError(
        'assert_mismatch',
        `repair red-verify for unit ${unit.task_key} missing expected named assert id(s): ${missing.join(', ')}`
      );
    }
  }

  // Fill-once durable lock + artifact in one transaction so a partial write cannot
  // look locked without a matching on-disk hash record (R5.2).
  const txn = raw.transaction(() => {
    const lockedAt = commitLock(raw, {
      unitId: unit.id,
      repairTestPath: relOrAbs,
      repairTestHash,
      repairAssertIds: provingIds,
      authoredBy,
    });
    const artifactId = recordLockArtifact(raw, {
      runId: unit.run_id,
      testPath: relOrAbs,
      testHash: repairTestHash,
    });
    return { lockedAt, artifactId };
  });

  const { lockedAt, artifactId } = txn();

  return {
    ok: true,
    repair_unit_id: unit.id,
    repair_round_id: unit.repair_round_id,
    fence_id: unit.fence_id,
    run_id: unit.run_id,
    task_key: unit.task_key,
    repair_test_path: relOrAbs,
    repair_test_hash: repairTestHash,
    repair_assert_ids: provingIds,
    authored_by: authoredBy,
    locked_at: lockedAt,
    report: runResult.report,
    reportPath: runResult.reportPath,
    exitCode: runResult.exitCode,
    artifactId,
  };
}

/** Inspect durable lock state for a repair unit (R5.2 artifact check). */
export function getFenceRepairUnitLock(
  db: DatabaseService | SqliteDb,
  params: { repairUnitId?: number; repairRoundId?: number; taskKey?: string }
): FenceRepairUnitLockView {
  const raw = resolveRaw(db);
  const unit = loadRepairUnit(raw, params);
  const hash = unit.repair_test_hash?.trim() || null;
  return {
    repair_unit_id: unit.id,
    repair_round_id: unit.repair_round_id,
    run_id: unit.run_id,
    task_key: unit.task_key,
    locked: !!(hash && unit.repair_test_path && unit.locked_at),
    repair_test_path: unit.repair_test_path,
    repair_test_hash: hash,
    repair_assert_ids: parseAssertIds(unit.repair_assert_ids),
    authored_by: unit.authored_by,
    locked_at: unit.locked_at,
  };
}

/**
 * True when every unit in the repair round has a fill-once hash lock.
 * R3 uses this before atomic reopen / implementer dispatch.
 */
export function areAllRepairRoundUnitsLocked(
  db: DatabaseService | SqliteDb,
  repairRoundId: number
): boolean {
  const raw = resolveRaw(db);
  const rows = raw
    .prepare(
      `SELECT repair_test_hash, repair_test_path, locked_at
       FROM fence_repair_units WHERE repair_round_id = ?`
    )
    .all(repairRoundId) as Array<{
    repair_test_hash: string | null;
    repair_test_path: string | null;
    locked_at: string | null;
  }>;
  if (rows.length === 0) return false;
  return rows.every(
    (r) =>
      typeof r.repair_test_hash === 'string' &&
      r.repair_test_hash.length > 0 &&
      typeof r.repair_test_path === 'string' &&
      r.repair_test_path.length > 0 &&
      typeof r.locked_at === 'string' &&
      r.locked_at.length > 0
  );
}

/**
 * R5.3 enforcement helper: re-hash the locked file and refuse when it no longer
 * matches the durable lock (implementer weakened the assertion).
 */
export function assertRepairTestHashIntact(
  db: DatabaseService | SqliteDb,
  params: {
    repairUnitId?: number;
    repairRoundId?: number;
    taskKey?: string;
    repoRoot?: string | null;
  }
): { ok: true; repair_test_hash: string; repair_test_path: string } {
  const raw = resolveRaw(db);
  const unit = loadRepairUnit(raw, params);
  if (!unit.repair_test_hash || !unit.repair_test_path) {
    throw new FenceRepairHashlockError(
      'missing_unit',
      `repair unit ${unit.id} (${unit.task_key}) has no hash lock yet`
    );
  }
  const repoRoot = params.repoRoot?.trim() || process.cwd();
  const { abs } = resolveRepairTestPath({
    repairTestPath: unit.repair_test_path,
    repoRoot,
  });
  const current = hashTestFile(abs);
  if (current !== unit.repair_test_hash) {
    throw new FenceRepairHashlockError(
      'hash_mismatch',
      `repair unit ${unit.task_key} locked hash ${unit.repair_test_hash} does not match current file ${current} — weakening the assertion is refused (R5.3)`
    );
  }
  return {
    ok: true,
    repair_test_hash: unit.repair_test_hash,
    repair_test_path: unit.repair_test_path,
  };
}

export { failedIds, hashTestFile };
