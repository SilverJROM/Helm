/**
 * fence-workflow-upgrade C2 — mechanical CLOSE path (R4.1, R4.3).
 *
 * Owns draining -> closing -> closed state movement, verifies the real CLOSE run
 * passes every OPEN-failed assertion id, then proves the negative control still
 * turns the journey red for a different named assertion.
 */
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import {
  closeFenceLockedTest,
  FenceCloseLockedTestError,
  type CloseFenceLockedTestParams,
  type CloseFenceLockedTestResult,
} from './fence-close-locked-test.js';
import {
  failedIds,
  fingerprint,
  isProvingKind,
  runFenceReportCommand,
  type FenceReportV1,
  type RunFenceReportCommandResult,
} from './fence-report-v1.js';

export type SqliteDb = Database.Database;

export class FenceCloseMechanicalError extends Error {
  readonly code: FenceCloseMechanicalErrorCode;

  constructor(code: FenceCloseMechanicalErrorCode, message: string) {
    super(message);
    this.name = 'FenceCloseMechanicalError';
    this.code = code;
  }
}

export type FenceCloseMechanicalErrorCode =
  | 'missing_fence'
  | 'bad_state'
  | 'open_assertions_not_passing'
  | 'missing_negative_control'
  | 'negative_control_not_red'
  | 'negative_control_wrong_assertion'
  | 'negative_control_report_error'
  | 'artifact_record_refused';

export interface CloseFenceMechanicalParams extends Omit<CloseFenceLockedTestParams, 'runCommand'> {
  runCommand?: (opts: {
    cmd: string;
    cwd: string;
    runDir?: string | null;
    reportPath?: string | null;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) => RunFenceReportCommandResult;
}

export interface CloseFenceMechanicalResult {
  ok: true;
  fenceId: number;
  fenceKey: string;
  runId: number;
  close: CloseFenceLockedTestResult;
  negative_control: {
    failed_ids: string[];
    proving_failed_ids: string[];
    different_failed_ids: string[];
    fingerprint: string;
    report: FenceReportV1;
    reportPath: string;
    exitCode: number;
    artifactId: number;
  };
}

interface FenceCloseMechanicalRow {
  id: number;
  fence_key: string;
  run_id: number;
  lifecycle_state: string;
  negative_control_cmd: string;
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
): FenceCloseMechanicalRow {
  let row: FenceCloseMechanicalRow | undefined;
  if (params.fenceId !== undefined) {
    row = raw
      .prepare('SELECT id, fence_key, run_id, lifecycle_state, negative_control_cmd FROM fences WHERE id = ?')
      .get(params.fenceId) as FenceCloseMechanicalRow | undefined;
  } else if (
    params.runId !== undefined &&
    typeof params.fenceKey === 'string' &&
    params.fenceKey.trim()
  ) {
    row = raw
      .prepare(
        'SELECT id, fence_key, run_id, lifecycle_state, negative_control_cmd FROM fences WHERE run_id = ? AND fence_key = ?'
      )
      .get(params.runId, params.fenceKey.trim()) as FenceCloseMechanicalRow | undefined;
  } else {
    throw new FenceCloseMechanicalError(
      'missing_fence',
      'closeFenceMechanical requires fenceId or (runId + fenceKey)'
    );
  }

  if (!row) {
    throw new FenceCloseMechanicalError(
      'missing_fence',
      params.fenceId !== undefined
        ? `fence id ${params.fenceId} not found`
        : `fence '${params.fenceKey}' not found for run ${params.runId}`
    );
  }
  return row;
}

function setFenceState(raw: SqliteDb, fenceId: number, state: 'closing' | 'closed'): void {
  raw
    .prepare("UPDATE fences SET lifecycle_state = ?, updated_at = datetime('now') WHERE id = ?")
    .run(state, fenceId);
}

function requireOpenIdsPassed(close: CloseFenceLockedTestResult): void {
  const passed = new Set(close.close_passed_ids);
  const missing = sortedUnique(close.open_failed_ids.filter((id) => !passed.has(id)));
  if (missing.length === 0) return;
  throw new FenceCloseMechanicalError(
    'open_assertions_not_passing',
    `fence '${close.fenceKey}' CLOSE refused: OPEN assertion id(s) did not pass at CLOSE: ${missing.join(', ')}`
  );
}

function provingFailedIds(report: FenceReportV1): string[] {
  return sortedUnique(
    report.failed
      .filter((failure) => isProvingKind(failure.kind))
      .map((failure) => failure.id)
  );
}

function requireNegativeControlDifferentAssertion(opts: {
  fenceKey: string;
  openFailedIds: readonly string[];
  report: FenceReportV1;
}): { proving: string[]; different: string[] } {
  const proving = provingFailedIds(opts.report);
  if (proving.length === 0) {
    throw new FenceCloseMechanicalError(
      'negative_control_not_red',
      `fence '${opts.fenceKey}' negative_control_cmd did not produce a proving assertion failure`
    );
  }

  const open = new Set(opts.openFailedIds);
  const different = sortedUnique(proving.filter((id) => !open.has(id)));
  if (different.length === 0) {
    throw new FenceCloseMechanicalError(
      'negative_control_wrong_assertion',
      `fence '${opts.fenceKey}' negative_control_cmd failed only OPEN assertion id(s): ${proving.join(', ')}`
    );
  }
  return { proving, different };
}

function recordArtifact(
  raw: SqliteDb,
  opts: { runId: number; type: string; reportPath: string; sha: string }
): number {
  const info = raw
    .prepare(
      `INSERT INTO artifacts (run_id, type, path, sha, created_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    )
    .run(opts.runId, opts.type, opts.reportPath, opts.sha);
  const id = Number(info.lastInsertRowid);
  if (!Number.isFinite(id) || id <= 0) {
    throw new FenceCloseMechanicalError(
      'artifact_record_refused',
      `CLOSE mechanical check did not record ${opts.type} artifact for run ${opts.runId}`
    );
  }
  return id;
}

export function closeFenceMechanical(
  db: DatabaseService | SqliteDb,
  params: CloseFenceMechanicalParams
): CloseFenceMechanicalResult {
  const raw = resolveRaw(db);
  const fence = loadFence(raw, params);
  if (fence.lifecycle_state !== 'draining') {
    throw new FenceCloseMechanicalError(
      'bad_state',
      `fence '${fence.fence_key}' lifecycle_state is '${fence.lifecycle_state}' — mechanical CLOSE starts from draining`
    );
  }

  const negativeControlCmd = fence.negative_control_cmd?.trim();
  if (!negativeControlCmd) {
    throw new FenceCloseMechanicalError(
      'missing_negative_control',
      `fence '${fence.fence_key}' declares no negative_control_cmd`
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
  const cwd = params.cwd ?? process.cwd();

  setFenceState(raw, fence.id, 'closing');

  let close: CloseFenceLockedTestResult;
  try {
    close = closeFenceLockedTest(db, {
      ...params,
      fenceId: fence.id,
      cwd,
      runCommand: run,
    });
  } catch (e) {
    if (e instanceof FenceCloseLockedTestError) throw e;
    throw e;
  }
  requireOpenIdsPassed(close);

  let negativeRun: RunFenceReportCommandResult;
  try {
    negativeRun = run({
      cmd: negativeControlCmd,
      cwd,
      runDir: params.runDir,
      reportPath: params.reportPath,
      env: params.env,
      timeoutMs: params.timeoutMs,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new FenceCloseMechanicalError(
      'negative_control_report_error',
      `negative_control_cmd could not read a report: ${msg}`
    );
  }

  const nc = requireNegativeControlDifferentAssertion({
    fenceKey: fence.fence_key,
    openFailedIds: close.open_failed_ids,
    report: negativeRun.report,
  });
  const ncFingerprint = fingerprint(negativeRun.report);
  const ncArtifactId = recordArtifact(raw, {
    runId: fence.run_id,
    type: 'fence-close-negative-control',
    reportPath: negativeRun.reportPath,
    sha: ncFingerprint,
  });

  setFenceState(raw, fence.id, 'closed');

  return {
    ok: true,
    fenceId: fence.id,
    fenceKey: fence.fence_key,
    runId: fence.run_id,
    close,
    negative_control: {
      failed_ids: failedIds(negativeRun.report),
      proving_failed_ids: nc.proving,
      different_failed_ids: nc.different,
      fingerprint: ncFingerprint,
      report: negativeRun.report,
      reportPath: negativeRun.reportPath,
      exitCode: negativeRun.exitCode,
      artifactId: ncArtifactId,
    },
  };
}
