/**
 * fence-workflow-upgrade B2 — OPEN FSM service (R2.1, R2.2).
 *
 * Crash-legible lifecycle (plan-preamble §8.1 / D8):
 *   declared → opening (external integration_cmd) → draining
 * on a proving assert/fail failure. OPEN baseline columns + the opening→draining
 * transition commit together after success. Infrastructure-only red
 * (env / import / not_found / …) is refused — same as TILLER-USAGE §5.3.
 *
 * External command runs outside any DB transaction; only the mark to `opening`
 * and the success commit (baseline + draining) touch durable state.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import {
  failedIds,
  fingerprint,
  provingFailure,
  runFenceReportCommand,
  type FenceReportV1,
  type RunFenceReportCommandResult,
} from './fence-report-v1.js';

export type SqliteDb = Database.Database;

export type FenceLifecycleState =
  | 'declared'
  | 'opening'
  | 'draining'
  | 'closing'
  | 'repairing'
  | 'closed'
  | 'plan_blocked';

export class FenceOpenError extends Error {
  readonly code: FenceOpenErrorCode;

  constructor(code: FenceOpenErrorCode, message: string) {
    super(message);
    this.name = 'FenceOpenError';
    this.code = code;
  }
}

export type FenceOpenErrorCode =
  | 'missing_fence'
  | 'bad_state'
  | 'missing_negative_control'
  | 'missing_integration_cmd'
  | 'report_error'
  | 'proving_refused'
  | 'missing_test_path';

export interface FenceOpenRow {
  id: number;
  fence_key: string;
  run_id: number;
  lifecycle_state: FenceLifecycleState;
  integration_cmd: string;
  negative_control_cmd: string;
  acceptance_ids: string;
  test_path: string | null;
  authored_by: string | null;
  open_failed_ids: string | null;
  open_test_hash: string | null;
  open_at: string | null;
}

export interface OpenFenceParams {
  /** Prefer fence_id when known; otherwise (runId, fenceKey). */
  fenceId?: number;
  runId?: number;
  fenceKey?: string;
  /** Working directory for integration_cmd (defaults to process.cwd()). */
  cwd?: string;
  /** Optional run-dir for fence-report-v1.json placement. */
  runDir?: string | null;
  /** Explicit report path override. */
  reportPath?: string | null;
  /** Extra env for the external command. */
  env?: NodeJS.ProcessEnv;
  /** Command timeout (ms). Default from runFenceReportCommand. */
  timeoutMs?: number;
  /**
   * Optional repo root used to resolve test_path for hashing.
   * Defaults to cwd.
   */
  repoRoot?: string | null;
  /**
   * Injected runner (tests). Production uses runFenceReportCommand.
   * MUST still produce a FenceReportV1; OPEN never trusts exit code alone.
   */
  runCommand?: (opts: {
    cmd: string;
    cwd: string;
    runDir?: string | null;
    reportPath?: string | null;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
  }) => RunFenceReportCommandResult;
}

export interface OpenFenceResult {
  ok: true;
  fenceId: number;
  fenceKey: string;
  runId: number;
  lifecycle_state: 'draining';
  open_failed_ids: string[];
  open_test_hash: string;
  open_at: string;
  fingerprint: string;
  proving_reason: string;
  report: FenceReportV1;
  reportPath: string;
  exitCode: number;
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

function loadFence(
  raw: SqliteDb,
  params: { fenceId?: number; runId?: number; fenceKey?: string }
): FenceOpenRow {
  let row: FenceOpenRow | undefined;
  if (params.fenceId !== undefined) {
    row = raw
      .prepare(
        `SELECT id, fence_key, run_id, lifecycle_state,
                integration_cmd, negative_control_cmd, acceptance_ids,
                test_path, authored_by,
                open_failed_ids, open_test_hash, open_at
         FROM fences WHERE id = ?`
      )
      .get(params.fenceId) as FenceOpenRow | undefined;
  } else if (
    params.runId !== undefined &&
    typeof params.fenceKey === 'string' &&
    params.fenceKey.trim()
  ) {
    row = raw
      .prepare(
        `SELECT id, fence_key, run_id, lifecycle_state,
                integration_cmd, negative_control_cmd, acceptance_ids,
                test_path, authored_by,
                open_failed_ids, open_test_hash, open_at
         FROM fences WHERE run_id = ? AND fence_key = ?`
      )
      .get(params.runId, params.fenceKey.trim()) as FenceOpenRow | undefined;
  } else {
    throw new FenceOpenError(
      'missing_fence',
      'openFence requires fenceId or (runId + fenceKey)'
    );
  }

  if (!row) {
    throw new FenceOpenError(
      'missing_fence',
      params.fenceId !== undefined
        ? `fence id ${params.fenceId} not found`
        : `fence '${params.fenceKey}' not found for run ${params.runId}`
    );
  }
  return row;
}

/** SHA-256 of the journey test file — the lock that stops greening by editing the test. */
export function hashTestFile(absPath: string): string {
  const buf = fs.readFileSync(absPath);
  return `sha256:${createHash('sha256').update(buf).digest('hex')}`;
}

/**
 * Resolve absolute path for a fence's test_path and hash it.
 * Throws FenceOpenError when test_path is missing or unreadable.
 */
export function resolveOpenTestHash(opts: {
  testPath: string | null | undefined;
  repoRoot: string;
}): string {
  const tp = opts.testPath?.trim();
  if (!tp) {
    throw new FenceOpenError(
      'missing_test_path',
      'OPEN requires fences.test_path so the journey hash can be locked (R2.2)'
    );
  }
  const abs = path.isAbsolute(tp) ? tp : path.join(opts.repoRoot, tp);
  try {
    return hashTestFile(abs);
  } catch (e) {
    throw new FenceOpenError(
      'missing_test_path',
      `OPEN could not hash test_path '${tp}': ${e}`
    );
  }
}

/**
 * Parse open_failed_ids JSON from a fence row into a string array.
 * Returns [] when null/empty/invalid (inspect helper; not a gate).
 */
export function parseOpenFailedIds(raw: string | null | undefined): string[] {
  if (raw == null || raw === '') return [];
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v.map((x) => String(x));
  } catch {
    return [];
  }
}

/** R2.2 — load inspectable OPEN baseline from durable fence row. */
export function getOpenBaseline(
  db: DatabaseService | SqliteDb,
  key: { fenceId: number } | { runId: number; fenceKey: string }
): {
  fence_id: number;
  fence_key: string;
  run_id: number;
  lifecycle_state: string;
  open_failed_ids: string[];
  open_test_hash: string | null;
  open_at: string | null;
  has_baseline: boolean;
} | null {
  const raw = resolveRaw(db);
  const row =
    'fenceId' in key
      ? (raw
          .prepare(
            `SELECT id, fence_key, run_id, lifecycle_state,
                    open_failed_ids, open_test_hash, open_at
             FROM fences WHERE id = ?`
          )
          .get(key.fenceId) as
          | {
              id: number;
              fence_key: string;
              run_id: number;
              lifecycle_state: string;
              open_failed_ids: string | null;
              open_test_hash: string | null;
              open_at: string | null;
            }
          | undefined)
      : (raw
          .prepare(
            `SELECT id, fence_key, run_id, lifecycle_state,
                    open_failed_ids, open_test_hash, open_at
             FROM fences WHERE run_id = ? AND fence_key = ?`
          )
          .get(key.runId, key.fenceKey) as
          | {
              id: number;
              fence_key: string;
              run_id: number;
              lifecycle_state: string;
              open_failed_ids: string | null;
              open_test_hash: string | null;
              open_at: string | null;
            }
          | undefined);

  if (!row) return null;
  const ids = parseOpenFailedIds(row.open_failed_ids);
  const has =
    ['draining', 'closing', 'repairing', 'closed'].includes(row.lifecycle_state) &&
    ids.length > 0 &&
    typeof row.open_test_hash === 'string' &&
    row.open_test_hash.length > 0 &&
    row.open_at != null;
  return {
    fence_id: row.id,
    fence_key: row.fence_key,
    run_id: row.run_id,
    lifecycle_state: row.lifecycle_state,
    open_failed_ids: ids,
    open_test_hash: row.open_test_hash,
    open_at: row.open_at,
    has_baseline: has,
  };
}

function markOpening(raw: SqliteDb, fenceId: number, fromState: string): void {
  const r = raw
    .prepare(
      `UPDATE fences
       SET lifecycle_state = 'opening', updated_at = datetime('now')
       WHERE id = ? AND lifecycle_state = ?`
    )
    .run(fenceId, fromState);
  if (r.changes !== 1) {
    throw new FenceOpenError(
      'bad_state',
      `failed to CAS fence ${fenceId} ${fromState}→opening (world moved)`
    );
  }
}

function revertToDeclared(raw: SqliteDb, fenceId: number): void {
  raw
    .prepare(
      `UPDATE fences
       SET lifecycle_state = 'declared', updated_at = datetime('now')
       WHERE id = ? AND lifecycle_state = 'opening'`
    )
    .run(fenceId);
}

/**
 * Commit OPEN baseline + opening→draining in ONE transaction (R2.2 + crash-legible FSM).
 * Either both land or neither does.
 */
function commitBaselineAndDrain(
  raw: SqliteDb,
  opts: {
    fenceId: number;
    openFailedIds: string[];
    openTestHash: string;
  }
): { open_at: string } {
  const txn = raw.transaction(() => {
    const r = raw
      .prepare(
        `UPDATE fences
         SET lifecycle_state = 'draining',
             open_failed_ids = ?,
             open_test_hash = ?,
             open_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ? AND lifecycle_state = 'opening'`
      )
      .run(JSON.stringify(opts.openFailedIds), opts.openTestHash, opts.fenceId);
    if (r.changes !== 1) {
      throw new FenceOpenError(
        'bad_state',
        `failed to CAS fence ${opts.fenceId} opening→draining with baseline (world moved)`
      );
    }
    const row = raw
      .prepare('SELECT open_at FROM fences WHERE id = ?')
      .get(opts.fenceId) as { open_at: string };
    return { open_at: row.open_at };
  });
  return txn();
}

/**
 * OPEN a declared fence: require a proving failure, record failed ids + test hash,
 * transition declared→opening→draining. R2.1 / R2.2.
 *
 * Idempotent when already draining with a complete baseline: returns the existing
 * baseline without re-running the command.
 */
export function openFence(
  db: DatabaseService | SqliteDb,
  params: OpenFenceParams
): OpenFenceResult {
  const raw = resolveRaw(db);
  const fence = loadFence(raw, params);
  const cwd = params.cwd ?? process.cwd();
  const repoRoot = params.repoRoot?.trim() || cwd;

  // Idempotent success path: already open with inspectable baseline.
  if (fence.lifecycle_state === 'draining') {
    const baseline = getOpenBaseline(db, { fenceId: fence.id });
    if (baseline?.has_baseline) {
      return {
        ok: true,
        fenceId: fence.id,
        fenceKey: fence.fence_key,
        runId: fence.run_id,
        lifecycle_state: 'draining',
        open_failed_ids: baseline.open_failed_ids,
        open_test_hash: baseline.open_test_hash!,
        open_at: baseline.open_at!,
        fingerprint: '',
        proving_reason: 'already open (idempotent)',
        report: {
          schema: 'fence-report-v1',
          collected: baseline.open_failed_ids,
          passed: [],
          failed: baseline.open_failed_ids.map((id) => ({ id, kind: 'assert' as const })),
        },
        reportPath: '',
        exitCode: 0,
      };
    }
    throw new FenceOpenError(
      'bad_state',
      `fence '${fence.fence_key}' is draining but OPEN baseline is incomplete`
    );
  }

  if (fence.lifecycle_state !== 'declared' && fence.lifecycle_state !== 'opening') {
    throw new FenceOpenError(
      'bad_state',
      `fence '${fence.fence_key}' lifecycle_state is '${fence.lifecycle_state}' — OPEN only from declared|opening`
    );
  }

  if (!fence.negative_control_cmd?.trim()) {
    throw new FenceOpenError(
      'missing_negative_control',
      `fence '${fence.fence_key}' declares no negative_control_cmd — without it a green CLOSE ` +
        `cannot be distinguished from a test that passes whether or not the behaviour is wired`
    );
  }

  const cmd = fence.integration_cmd?.trim();
  if (!cmd) {
    throw new FenceOpenError(
      'missing_integration_cmd',
      `fence '${fence.fence_key}' has no integration_cmd`
    );
  }

  // Pre-resolve test hash before external work so a missing path fails closed early.
  const openTestHash = resolveOpenTestHash({
    testPath: fence.test_path,
    repoRoot,
  });

  // Crash-legible: durable mark before the external command.
  if (fence.lifecycle_state === 'declared') {
    markOpening(raw, fence.id, 'declared');
  }
  // If already `opening` (interrupted prior attempt), leave state and re-run the probe.

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
    revertToDeclared(raw, fence.id);
    const msg = e instanceof Error ? e.message : String(e);
    throw new FenceOpenError('report_error', `OPEN could not read a report: ${msg}`);
  }

  const proof = provingFailure(runResult.report);
  if (!proof.ok) {
    revertToDeclared(raw, fence.id);
    throw new FenceOpenError('proving_refused', `OPEN refused: ${proof.reason}`);
  }

  const openFailedIds = failedIds(runResult.report);
  if (openFailedIds.length === 0) {
    // Defensive: provingFailure already requires ≥1 proving fail, but never commit empty.
    revertToDeclared(raw, fence.id);
    throw new FenceOpenError(
      'proving_refused',
      'OPEN refused: proving failure reported ok but failed id list is empty'
    );
  }

  // Baseline columns + opening→draining commit together (atomic).
  const { open_at } = commitBaselineAndDrain(raw, {
    fenceId: fence.id,
    openFailedIds,
    openTestHash,
  });

  return {
    ok: true,
    fenceId: fence.id,
    fenceKey: fence.fence_key,
    runId: fence.run_id,
    lifecycle_state: 'draining',
    open_failed_ids: openFailedIds,
    open_test_hash: openTestHash,
    open_at,
    fingerprint: fingerprint(runResult.report),
    proving_reason: proof.reason,
    report: runResult.report,
    reportPath: runResult.reportPath,
    exitCode: runResult.exitCode,
  };
}
