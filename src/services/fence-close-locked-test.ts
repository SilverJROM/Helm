/**
 * fence-workflow-upgrade C1 — CLOSE locked-test assertion superset (R4.1).
 *
 * Per D11 retry direction: this is the product guard for the locked test file only.
 * It does not own the later CLOSE verdict/seat-routing slices.
 */
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import {
  failedIds,
  fingerprint,
  passedIds,
  runFenceReportCommand,
  type FenceReportV1,
  type RunFenceReportCommandResult,
} from './fence-report-v1.js';
import {
  getOpenBaseline,
  parseOpenFailedIds,
  resolveOpenTestHash,
  type FenceLifecycleState,
} from './fence-open-service.js';

export type SqliteDb = Database.Database;

export class FenceCloseLockedTestError extends Error {
  readonly code: FenceCloseLockedTestErrorCode;

  constructor(code: FenceCloseLockedTestErrorCode, message: string) {
    super(message);
    this.name = 'FenceCloseLockedTestError';
    this.code = code;
  }
}

export type FenceCloseLockedTestErrorCode =
  | 'missing_fence'
  | 'bad_state'
  | 'missing_open_baseline'
  | 'missing_integration_cmd'
  | 'command_identity_changed'
  | 'missing_test_path'
  | 'report_error'
  | 'assertion_superset_refused'
  | 'artifact_record_refused';

export interface FenceCloseLockedTestRow {
  id: number;
  fence_key: string;
  run_id: number;
  lifecycle_state: FenceLifecycleState;
  integration_cmd: string;
  test_path: string | null;
  open_failed_ids: string | null;
  open_test_hash: string | null;
  open_at: string | null;
}

export interface CloseFenceLockedTestParams {
  fenceId?: number;
  runId?: number;
  fenceKey?: string;
  cwd?: string;
  repoRoot?: string | null;
  runDir?: string | null;
  reportPath?: string | null;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  /**
   * Optional immutable plan-contract snapshot. When supplied, the stored row
   * must still match it exactly before CLOSE runs.
   */
  expectedIntegrationCmd?: string | null;
  runCommand?: (opts: {
    cmd: string;
    cwd: string;
    runDir?: string | null;
    reportPath?: string | null;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) => RunFenceReportCommandResult;
}

export interface CloseFenceLockedTestResult {
  ok: true;
  fenceId: number;
  fenceKey: string;
  runId: number;
  unchanged_hash: boolean;
  open_test_hash: string;
  close_test_hash: string;
  open_failed_ids: string[];
  close_collected_ids: string[];
  close_passed_ids: string[];
  close_failed_ids: string[];
  fingerprint: string;
  report: FenceReportV1;
  reportPath: string;
  exitCode: number;
  artifactId: number;
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => String(v).trim()).filter(Boolean))].sort();
}

function loadFence(
  raw: SqliteDb,
  params: { fenceId?: number; runId?: number; fenceKey?: string }
): FenceCloseLockedTestRow {
  let row: FenceCloseLockedTestRow | undefined;
  if (params.fenceId !== undefined) {
    row = raw
      .prepare(
        `SELECT id, fence_key, run_id, lifecycle_state,
                integration_cmd, test_path, open_failed_ids, open_test_hash, open_at
         FROM fences WHERE id = ?`
      )
      .get(params.fenceId) as FenceCloseLockedTestRow | undefined;
  } else if (
    params.runId !== undefined &&
    typeof params.fenceKey === 'string' &&
    params.fenceKey.trim()
  ) {
    row = raw
      .prepare(
        `SELECT id, fence_key, run_id, lifecycle_state,
                integration_cmd, test_path, open_failed_ids, open_test_hash, open_at
         FROM fences WHERE run_id = ? AND fence_key = ?`
      )
      .get(params.runId, params.fenceKey.trim()) as FenceCloseLockedTestRow | undefined;
  } else {
    throw new FenceCloseLockedTestError(
      'missing_fence',
      'closeFenceLockedTest requires fenceId or (runId + fenceKey)'
    );
  }

  if (!row) {
    throw new FenceCloseLockedTestError(
      'missing_fence',
      params.fenceId !== undefined
        ? `fence id ${params.fenceId} not found`
        : `fence '${params.fenceKey}' not found for run ${params.runId}`
    );
  }
  return row;
}

function requireOpenBaseline(
  db: DatabaseService | SqliteDb,
  fence: FenceCloseLockedTestRow
): { openFailedIds: string[]; openTestHash: string } {
  if (fence.lifecycle_state !== 'draining') {
    throw new FenceCloseLockedTestError(
      'bad_state',
      `fence '${fence.fence_key}' lifecycle_state is '${fence.lifecycle_state}' — CLOSE lock check only runs from draining`
    );
  }

  const baseline = getOpenBaseline(db, { fenceId: fence.id });
  if (!baseline?.has_baseline || !baseline.open_test_hash) {
    throw new FenceCloseLockedTestError(
      'missing_open_baseline',
      `fence '${fence.fence_key}' has no complete OPEN baseline to compare at CLOSE`
    );
  }
  const openFailedIds = parseOpenFailedIds(fence.open_failed_ids);
  if (openFailedIds.length === 0) {
    throw new FenceCloseLockedTestError(
      'missing_open_baseline',
      `fence '${fence.fence_key}' OPEN baseline has no assertion ids`
    );
  }
  return { openFailedIds, openTestHash: baseline.open_test_hash };
}

function assertCommandIdentity(fence: FenceCloseLockedTestRow, expected?: string | null): string {
  const cmd = fence.integration_cmd?.trim();
  if (!cmd) {
    throw new FenceCloseLockedTestError(
      'missing_integration_cmd',
      `fence '${fence.fence_key}' has no integration_cmd`
    );
  }
  const expectedTrimmed = expected?.trim();
  if (expectedTrimmed && cmd !== expectedTrimmed) {
    throw new FenceCloseLockedTestError(
      'command_identity_changed',
      `fence '${fence.fence_key}' integration_cmd changed since plan/Open identity snapshot`
    );
  }
  return cmd;
}

function assertOpenIdsRetained(opts: {
  fenceKey: string;
  openFailedIds: readonly string[];
  closeCollectedIds: readonly string[];
  unchangedHash: boolean;
}): void {
  const collected = new Set(opts.closeCollectedIds);
  const missing = sortedUnique(opts.openFailedIds.filter((id) => !collected.has(id)));
  if (missing.length === 0) return;

  const mode = opts.unchangedHash ? 'unchanged locked test' : 'changed locked test';
  throw new FenceCloseLockedTestError(
    'assertion_superset_refused',
    `fence '${opts.fenceKey}' CLOSE refused ${mode}: missing OPEN assertion id(s) ${missing.join(', ')}`
  );
}

function recordCloseArtifact(
  raw: SqliteDb,
  opts: {
    runId: number;
    reportPath: string;
    closeTestHash: string;
  }
): number {
  const info = raw
    .prepare(
      `INSERT INTO artifacts (run_id, type, path, sha, created_at)
       VALUES (?, 'fence-close-locked-test', ?, ?, datetime('now'))`
    )
    .run(opts.runId, opts.reportPath, opts.closeTestHash);
  const id = Number(info.lastInsertRowid);
  if (!Number.isFinite(id) || id <= 0) {
    throw new FenceCloseLockedTestError(
      'artifact_record_refused',
      `CLOSE lock check did not record a run artifact row for run ${opts.runId}`
    );
  }
  return id;
}

export function closeFenceLockedTest(
  db: DatabaseService | SqliteDb,
  params: CloseFenceLockedTestParams
): CloseFenceLockedTestResult {
  const raw = resolveRaw(db);
  const fence = loadFence(raw, params);
  const cwd = params.cwd ?? process.cwd();
  const repoRoot = params.repoRoot?.trim() || cwd;
  const { openFailedIds, openTestHash } = requireOpenBaseline(db, fence);
  const cmd = assertCommandIdentity(fence, params.expectedIntegrationCmd);

  let closeTestHash: string;
  try {
    closeTestHash = resolveOpenTestHash({ testPath: fence.test_path, repoRoot });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FenceCloseLockedTestError('missing_test_path', msg);
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
      cmd,
      cwd,
      runDir: params.runDir,
      reportPath: params.reportPath,
      env: params.env,
      timeoutMs: params.timeoutMs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FenceCloseLockedTestError('report_error', `CLOSE could not read a report: ${msg}`);
  }

  const unchangedHash = closeTestHash === openTestHash;
  const closeCollectedIds = sortedUnique(runResult.report.collected);
  assertOpenIdsRetained({
    fenceKey: fence.fence_key,
    openFailedIds,
    closeCollectedIds,
    unchangedHash,
  });

  const artifactId = recordCloseArtifact(raw, {
    runId: fence.run_id,
    reportPath: runResult.reportPath || fence.test_path || '',
    closeTestHash,
  });

  return {
    ok: true,
    fenceId: fence.id,
    fenceKey: fence.fence_key,
    runId: fence.run_id,
    unchanged_hash: unchangedHash,
    open_test_hash: openTestHash,
    close_test_hash: closeTestHash,
    open_failed_ids: sortedUnique(openFailedIds),
    close_collected_ids: closeCollectedIds,
    close_passed_ids: passedIds(runResult.report),
    close_failed_ids: failedIds(runResult.report),
    fingerprint: fingerprint(runResult.report),
    report: runResult.report,
    reportPath: runResult.reportPath,
    exitCode: runResult.exitCode,
    artifactId,
  };
}
