/**
 * fence-workflow-upgrade R4 — REPAIR routing rules (R5.4, R7.2).
 *
 * Pure decision surface for a red CLOSE composition result:
 *   - fault_class=plan / plan_defect=true → planner RAISE, skip implementer ladder
 *   - identical driver-measured fingerprint twice → planner RAISE (same_seam)
 *   - missing/invalid verdict fields fail closed (never "no defect")
 *   - implementation with 1–2 in-fence units → REQUEUE for validator-authored repair
 *   - max 3 rounds including accepted PLAN_SOUND → exhausted RAISE
 *
 * PLAN_SOUND (planner overrules validator) is a DIRECTION action with teeth:
 *   requires what_validator_missed + (named units with validator-authored tests
 *   OR an explicit plan_level / plan_level_fingerprint). Bare PLAN_SOUND refused.
 *
 * Fingerprint history is loaded only from append-only verdict/repair rows —
 * never from telemetry.jsonl (control input must not come from a best-effort sink).
 */
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import {
  FENCE_VERDICT_EVENT_TYPE,
  normalizeFenceVerdict,
  type StrictFenceVerdict,
} from './fence-verdict.js';
import { FENCE_REPAIR_UNIT_CEILING } from './fence-repair-schema.js';

export type SqliteDb = Database.Database;

/** Max repair rounds including accepted PLAN_SOUND (R5.4 / TILLER-USAGE §5.3). */
export const FENCE_REPAIR_MAX_ROUNDS = 3;

/** Append-only event that records an accepted PLAN_SOUND as a consumed round. */
export const FENCE_PLAN_SOUND_EVENT_TYPE = 'FENCE_PLAN_SOUND' as const;

export type FenceRepairRouteAction = 'REQUEUE' | 'RAISE';

export type FenceRepairRouteFaultClass = 'plan' | 'implementation' | 'environment' | 'unknown';

export interface FenceRepairRouteResult {
  action: FenceRepairRouteAction;
  why: string;
  fault_class: FenceRepairRouteFaultClass;
  /** When true, conductor must not walk implementer L1→L2→L3. */
  skip_ladder: boolean;
  plan_defect: boolean;
  same_seam: boolean;
  exhausted: boolean;
  /** Named units when action=REQUEUE. */
  units: string[];
  /** Latest driver-measured fingerprint (history tail), if any. */
  fingerprint: string | null;
  /** Normalized/fail-closed verdict used for the decision (null when no input). */
  verdict: StrictFenceVerdict | null;
  /** Round count considered for the cap (completed + in-flight measurement). */
  rounds: number;
}

export interface RouteFenceRepairParams {
  /**
   * Composition verdict (StrictFenceVerdict, CompositionJudgment, or raw).
   * null/undefined → fail-closed RAISE (R7.2). Partial/invalid fields normalize
   * via C3 fail-closed and route as plan_defect.
   */
  verdict?: unknown | null;
  /**
   * Driver-measured seam fingerprints, oldest first, including the current CLOSE.
   * MUST come from append-only verdict/repair rows (see loadFenceFingerprintHistory),
   * never telemetry.
   */
  fingerprintHistory?: readonly string[] | null;
  /**
   * Completed repair attempts for this fence (implementation requeues + accepted
   * PLAN_SOUNDs). Cap is FENCE_REPAIR_MAX_ROUNDS inclusive of PLAN_SOUND.
   */
  rounds?: number | null;
  /** Fence member task keys — units outside this set fail closed. */
  fenceDeps?: readonly string[] | null;
}

export interface PlanSoundDirection {
  action?: string;
  what_validator_missed?: unknown;
  /** Units to return to repair: array, CSV, or `[U1,U2]` string. */
  units?: unknown;
  /** Explicit plan-level finding (boolean or non-empty string). */
  plan_level?: unknown;
  /** Tiller-compatible alias: non-empty fingerprint declares plan-level. */
  plan_level_fingerprint?: unknown;
}

export type RepairContractMap = Record<
  string,
  | {
      test_path?: string | null;
      repair_test_path?: string | null;
      repair_test_hash?: string | null;
    }
  | null
  | undefined
>;

export interface ValidatePlanSoundResult {
  ok: boolean;
  error: string;
  /** True when direction.action is PLAN_SOUND and validation passed. */
  accepted: boolean;
  /** Accepted PLAN_SOUND always consumes one repair round (R5.4). */
  consumes_round: boolean;
  units: string[];
  plan_level: boolean;
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Parse failing_units / PLAN_SOUND units from array or Tiller-style string. */
export function parseRepairUnits(field: unknown): string[] {
  if (field == null) return [];
  if (Array.isArray(field)) {
    return field.map((u) => String(u ?? '').trim()).filter(Boolean);
  }
  const raw = String(field).trim();
  if (!raw) return [];
  return raw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(/[,\s]+/)
    .map((u) => u.trim())
    .filter(Boolean);
}

function isPlanLevel(direction: PlanSoundDirection): boolean {
  if (nonEmptyString(direction.plan_level_fingerprint)) return true;
  if (direction.plan_level === true) return true;
  if (typeof direction.plan_level === 'string' && direction.plan_level.trim().length > 0) {
    const v = direction.plan_level.trim().toLowerCase();
    return v !== 'false' && v !== '0' && v !== 'no';
  }
  return false;
}

function unitHasValidatorAuthoredTest(
  contracts: RepairContractMap | null | undefined,
  unit: string
): boolean {
  const c = contracts?.[unit];
  if (!c || typeof c !== 'object') return false;
  const path = nonEmptyString(c.repair_test_path)
    ? c.repair_test_path.trim()
    : nonEmptyString(c.test_path)
      ? c.test_path.trim()
      : '';
  return path.length > 0;
}

/**
 * PLAN_SOUND gate (R5.4). A bare overrule that hands work back with no new test
 * is refused. Non-PLAN_SOUND directions are left untouched (ok).
 */
export function validatePlanSound(
  direction: PlanSoundDirection | null | undefined,
  repairContracts?: RepairContractMap | null
): ValidatePlanSoundResult {
  const empty: ValidatePlanSoundResult = {
    ok: true,
    error: '',
    accepted: false,
    consumes_round: false,
    units: [],
    plan_level: false,
  };
  if (!direction || typeof direction !== 'object') return empty;
  if (direction.action !== 'PLAN_SOUND') return empty;

  if (!nonEmptyString(direction.what_validator_missed)) {
    return {
      ok: false,
      error:
        'PLAN_SOUND requires `what_validator_missed` — the planner is more authoritative ' +
        'than the validator, so overruling it must say what it failed to see',
      accepted: false,
      consumes_round: true, // bare attempt still burns a round per R5.4 ("refused and consumes a round")
      units: [],
      plan_level: false,
    };
  }

  if (isPlanLevel(direction)) {
    return {
      ok: true,
      error: '',
      accepted: true,
      consumes_round: true,
      units: [],
      plan_level: true,
    };
  }

  const units = parseRepairUnits(direction.units);
  if (units.length === 0) {
    return {
      ok: false,
      error: 'PLAN_SOUND must name units to repair, or set plan_level / plan_level_fingerprint',
      accepted: false,
      consumes_round: true,
      units: [],
      plan_level: false,
    };
  }

  const missing = units.filter((u) => !unitHasValidatorAuthoredTest(repairContracts, u));
  if (missing.length > 0) {
    return {
      ok: false,
      error:
        `PLAN_SOUND returns ${missing.join(', ')} to the implementer with no ` +
        'validator-authored test — that is the cheap implementer defining its own ' +
        'success criterion again. Author the test or set plan_level / plan_level_fingerprint.',
      accepted: false,
      consumes_round: true,
      units,
      plan_level: false,
    };
  }

  return {
    ok: true,
    error: '',
    accepted: true,
    consumes_round: true,
    units,
    plan_level: false,
  };
}

function validateFailingUnits(
  units: string[],
  fenceDeps: readonly string[],
  planDefect: boolean
): { ok: boolean; error: string } {
  if (units.length === 0) {
    return { ok: false, error: 'no failing_units named' };
  }
  if (fenceDeps.length > 0) {
    const outside = units.filter((u) => !fenceDeps.includes(u));
    if (outside.length > 0) {
      return {
        ok: false,
        error:
          `failing_units names ${outside.join(', ')} which are not contributors to this ` +
          `fence (deps: ${fenceDeps.join(', ')})`,
      };
    }
  }
  if (units.length > FENCE_REPAIR_UNIT_CEILING && !planDefect) {
    return {
      ok: false,
      error:
        `${units.length} units named without plan_defect — naming more than ${FENCE_REPAIR_UNIT_CEILING} ` +
        'is a structural failure, not a localization',
    };
  }
  return { ok: true, error: '' };
}

function raise(
  partial: Omit<FenceRepairRouteResult, 'action' | 'units' | 'verdict'> & {
    units?: string[];
    verdict?: StrictFenceVerdict | null;
  }
): FenceRepairRouteResult {
  return {
    action: 'RAISE',
    units: partial.units ?? [],
    verdict: partial.verdict ?? null,
    why: partial.why,
    fault_class: partial.fault_class,
    skip_ladder: partial.skip_ladder,
    plan_defect: partial.plan_defect,
    same_seam: partial.same_seam,
    exhausted: partial.exhausted,
    fingerprint: partial.fingerprint,
    rounds: partial.rounds,
  };
}

/**
 * Route a red CLOSE composition failure (R5.4, R7.2).
 * Pure: no DB writes. Fingerprint history and round counts are caller-supplied
 * (prefer loadFenceFingerprintHistory / countFenceRepairRounds).
 */
export function routeFenceRepair(params: RouteFenceRepairParams): FenceRepairRouteResult {
  const hist = (params.fingerprintHistory ?? [])
    .map((f) => String(f ?? '').trim())
    .filter(Boolean);
  const fingerprint = hist.length > 0 ? hist[hist.length - 1]! : null;
  const rounds = Math.max(0, Number(params.rounds ?? 0) || 0);
  const fenceDeps = (params.fenceDeps ?? []).map((u) => String(u).trim()).filter(Boolean);
  const base = {
    fingerprint,
    rounds,
    same_seam: false,
    exhausted: false,
  };

  // ---- missing verdict fails closed (R7.2) — never "no defect" ---------------------------------
  if (params.verdict == null) {
    return raise({
      ...base,
      why: 'integration failed and no fence composition verdict was produced',
      fault_class: 'plan',
      skip_ladder: true,
      plan_defect: true,
      verdict: null,
    });
  }

  // C3 normalize: missing/invalid required fields → FAIL + plan_defect (fail-closed).
  const verdict = normalizeFenceVerdict(params.verdict);

  // Protocol / missing-field fail-closed, or explicit plan classification.
  const isPlan =
    verdict.plan_defect === true ||
    verdict.fault_class === 'plan' ||
    verdict.verdict === 'PLAN_DEFECT' ||
    (verdict.validation_errors?.length ?? 0) > 0;

  if (isPlan) {
    const why =
      verdict.validation_errors?.length > 0
        ? `fence verdict failed closed; missing/invalid field(s): ${verdict.validation_errors.join(', ')}`
        : nonEmptyString(verdict.note)
          ? verdict.note
          : 'validator classified this as a plan defect';
    return raise({
      ...base,
      why,
      fault_class: 'plan',
      skip_ladder: true,
      plan_defect: true,
      verdict,
      fingerprint: fingerprint ?? verdict.seam_fingerprint ?? null,
    });
  }

  // ---- identical DRIVER-measured fingerprint twice → composition defect, no triage -------------
  if (hist.length >= 2 && hist[hist.length - 1] && hist[hist.length - 1] === hist[hist.length - 2]) {
    return raise({
      ...base,
      why:
        `the same seam failed twice running (fingerprint ${hist[hist.length - 1]}) — this is a ` +
        'composition defect, not an implementation gap',
      fault_class: 'plan',
      skip_ladder: true,
      plan_defect: true,
      same_seam: true,
      verdict,
      fingerprint: hist[hist.length - 1]!,
    });
  }

  // ---- round exhaustion (implementation + PLAN_SOUND) ------------------------------------------
  if (rounds >= FENCE_REPAIR_MAX_ROUNDS) {
    return raise({
      ...base,
      why: `${rounds} repair rounds exhausted without convergence`,
      fault_class: 'plan',
      skip_ladder: true,
      plan_defect: true,
      exhausted: true,
      verdict,
    });
  }

  // Non-implementation fault classes are not implementer-ladder work.
  if (verdict.fault_class !== 'implementation') {
    return raise({
      ...base,
      why: `fault_class=${verdict.fault_class ?? 'unknown'} is not implementation — skip implementer ladder`,
      fault_class: (verdict.fault_class as FenceRepairRouteFaultClass) || 'unknown',
      skip_ladder: true,
      plan_defect: false,
      verdict,
    });
  }

  const units = parseRepairUnits(verdict.failing_units);
  const unitCheck = validateFailingUnits(units, fenceDeps, false);
  if (!unitCheck.ok) {
    return raise({
      ...base,
      why: `cannot route repair: ${unitCheck.error}`,
      fault_class: 'plan',
      skip_ladder: true,
      plan_defect: true,
      verdict,
      units,
    });
  }

  return {
    action: 'REQUEUE',
    why: `repair round ${rounds + 1}: ${units.join(', ')}`,
    fault_class: 'implementation',
    skip_ladder: false,
    plan_defect: false,
    same_seam: false,
    exhausted: false,
    units,
    fingerprint: fingerprint ?? verdict.seam_fingerprint ?? null,
    verdict,
    rounds,
  };
}

/**
 * Load driver-measured fingerprint history for a fence from append-only sources only:
 *   1. fence_repair_rounds.verdict_fingerprint (ordered by round_number)
 *   2. run_events FENCE_COMPOSITION_VERDICT payload.seam_fingerprint for this fence
 *
 * NEVER reads telemetry.jsonl / dispatch telemetry.
 */
export function loadFenceFingerprintHistory(
  db: DatabaseService | SqliteDb,
  params: { fenceId?: number; runId?: number; fenceKey?: string }
): string[] {
  const raw = resolveRaw(db);
  let fenceId = params.fenceId;
  let runId = params.runId;
  let fenceKey = params.fenceKey?.trim();

  if (fenceId !== undefined) {
    const row = raw
      .prepare('SELECT id, run_id, fence_key FROM fences WHERE id = ?')
      .get(fenceId) as { id: number; run_id: number; fence_key: string } | undefined;
    if (!row) return [];
    fenceId = row.id;
    runId = row.run_id;
    fenceKey = row.fence_key;
  } else if (runId !== undefined && fenceKey) {
    const row = raw
      .prepare('SELECT id, run_id, fence_key FROM fences WHERE run_id = ? AND fence_key = ?')
      .get(runId, fenceKey) as { id: number; run_id: number; fence_key: string } | undefined;
    if (!row) return [];
    fenceId = row.id;
    runId = row.run_id;
    fenceKey = row.fence_key;
  } else {
    return [];
  }

  // Append-only repair rounds (implementation admissions) — primary repair history.
  const fromRounds = raw
    .prepare(
      `SELECT verdict_fingerprint AS fp
       FROM fence_repair_rounds
       WHERE fence_id = ?
         AND verdict_fingerprint IS NOT NULL
         AND TRIM(verdict_fingerprint) != ''
       ORDER BY round_number ASC, id ASC`
    )
    .all(fenceId) as Array<{ fp: string }>;

  // Append-only composition verdict events (each CLOSE judgment measurement).
  const fromVerdicts = raw
    .prepare(
      `SELECT payload_json
       FROM run_events
       WHERE run_id = ?
         AND event_type = ?
       ORDER BY id ASC`
    )
    .all(String(runId), FENCE_VERDICT_EVENT_TYPE) as Array<{ payload_json: string }>;

  const out: string[] = [];
  for (const r of fromRounds) {
    const fp = String(r.fp).trim();
    if (fp) out.push(fp);
  }
  for (const ev of fromVerdicts) {
    try {
      const payload = JSON.parse(ev.payload_json) as Record<string, unknown>;
      const fence = nonEmptyString(payload.fence) ? payload.fence.trim() : '';
      if (fence && fence !== fenceKey) continue;
      const fp = nonEmptyString(payload.seam_fingerprint) ? payload.seam_fingerprint.trim() : '';
      if (fp) out.push(fp);
    } catch {
      // corrupt payload is not control state
    }
  }
  return out;
}

/**
 * Count completed repair attempts for the max-3 cap: staged implementation rounds
 * plus accepted PLAN_SOUND events. Does not read telemetry.
 */
export function countFenceRepairRounds(
  db: DatabaseService | SqliteDb,
  params: { fenceId?: number; runId?: number; fenceKey?: string }
): number {
  const raw = resolveRaw(db);
  let fenceId = params.fenceId;
  let runId = params.runId;
  let fenceKey = params.fenceKey?.trim();

  if (fenceId !== undefined) {
    const row = raw
      .prepare('SELECT id, run_id, fence_key FROM fences WHERE id = ?')
      .get(fenceId) as { id: number; run_id: number; fence_key: string } | undefined;
    if (!row) return 0;
    fenceId = row.id;
    runId = row.run_id;
    fenceKey = row.fence_key;
  } else if (runId !== undefined && fenceKey) {
    const row = raw
      .prepare('SELECT id, run_id, fence_key FROM fences WHERE run_id = ? AND fence_key = ?')
      .get(runId, fenceKey) as { id: number; run_id: number; fence_key: string } | undefined;
    if (!row) return 0;
    fenceId = row.id;
    runId = row.run_id;
    fenceKey = row.fence_key;
  } else {
    return 0;
  }

  const implRounds = Number(
    (
      raw
        .prepare('SELECT COUNT(*) AS c FROM fence_repair_rounds WHERE fence_id = ?')
        .get(fenceId) as { c: number }
    ).c
  );

  const planSoundRows = raw
    .prepare(
      `SELECT payload_json
       FROM run_events
       WHERE run_id = ?
         AND event_type = ?
       ORDER BY id ASC`
    )
    .all(String(runId), FENCE_PLAN_SOUND_EVENT_TYPE) as Array<{ payload_json: string }>;

  let planSoundCount = 0;
  for (const row of planSoundRows) {
    try {
      const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
      const fence = nonEmptyString(payload.fence) ? payload.fence.trim() : '';
      if (fence && fence !== fenceKey) continue;
      // Count accepted and refused bare attempts that consume a round.
      if (payload.consumes_round === true || payload.accepted === true || payload.refused === true) {
        planSoundCount += 1;
      }
    } catch {
      // ignore
    }
  }

  return implRounds + planSoundCount;
}

/**
 * Append an accepted or refused PLAN_SOUND attempt as a durable round-consuming event.
 * Bare/refused PLAN_SOUND still consumes a round (R5.4).
 */
export function recordPlanSoundAttempt(
  db: DatabaseService | SqliteDb,
  params: {
    runId: number | string;
    fence: string;
    direction: PlanSoundDirection;
    validation: ValidatePlanSoundResult;
    batchId?: string | null;
  }
): { eventId: number; rounds: number } {
  const raw = resolveRaw(db);
  const payload = {
    schema: 'fence-plan-sound-v1',
    fence: params.fence,
    action: 'PLAN_SOUND',
    accepted: params.validation.accepted,
    refused: !params.validation.ok,
    consumes_round: params.validation.consumes_round,
    what_validator_missed: nonEmptyString(params.direction.what_validator_missed)
      ? String(params.direction.what_validator_missed).trim()
      : null,
    units: params.validation.units,
    plan_level: params.validation.plan_level,
    error: params.validation.error || null,
  };
  const result = raw
    .prepare(
      `INSERT INTO run_events (run_id, batch_id, event_type, payload_json)
       VALUES (?, ?, ?, ?)`
    )
    .run(
      String(params.runId),
      params.batchId ?? null,
      FENCE_PLAN_SOUND_EVENT_TYPE,
      JSON.stringify(payload)
    );
  const eventId = Number(result.lastInsertRowid);
  const rounds = countFenceRepairRounds(raw, {
    runId: Number(params.runId),
    fenceKey: params.fence,
  });
  return { eventId, rounds };
}

/**
 * Convenience: load history + rounds from append-only rows, then route.
 * Refuses to consult telemetry paths even if a runDir is passed (ignored).
 */
export function routeFenceRepairFromDb(
  db: DatabaseService | SqliteDb,
  params: {
    fenceId?: number;
    runId?: number;
    fenceKey?: string;
    verdict?: unknown | null;
    /** Optional extra current fingerprint to append (driver measurement of this CLOSE). */
    currentFingerprint?: string | null;
    /** Override deps; default = fence_members task_keys. */
    fenceDeps?: readonly string[] | null;
    /**
     * Deliberately unused. Present so callers cannot "helpfully" pass a telemetry
     * path — history always comes from repair/verdict rows.
     */
    telemetryPath?: string | null;
  }
): FenceRepairRouteResult {
  void params.telemetryPath; // never read — control state is not a metrics sink
  const raw = resolveRaw(db);

  let fenceId = params.fenceId;
  let runId = params.runId;
  let fenceKey = params.fenceKey?.trim();

  if (fenceId !== undefined) {
    const row = raw
      .prepare('SELECT id, run_id, fence_key FROM fences WHERE id = ?')
      .get(fenceId) as { id: number; run_id: number; fence_key: string } | undefined;
    if (row) {
      fenceId = row.id;
      runId = row.run_id;
      fenceKey = row.fence_key;
    }
  } else if (runId !== undefined && fenceKey) {
    const row = raw
      .prepare('SELECT id, run_id, fence_key FROM fences WHERE run_id = ? AND fence_key = ?')
      .get(runId, fenceKey) as { id: number; run_id: number; fence_key: string } | undefined;
    if (row) {
      fenceId = row.id;
      runId = row.run_id;
      fenceKey = row.fence_key;
    }
  }

  const history = loadFenceFingerprintHistory(raw, {
    fenceId,
    runId,
    fenceKey,
  });
  if (nonEmptyString(params.currentFingerprint)) {
    history.push(params.currentFingerprint.trim());
  }

  let fenceDeps = params.fenceDeps ? [...params.fenceDeps] : null;
  if (!fenceDeps && fenceId !== undefined) {
    fenceDeps = (
      raw
        .prepare('SELECT task_key FROM fence_members WHERE fence_id = ? ORDER BY position, id')
        .all(fenceId) as Array<{ task_key: string }>
    ).map((r) => r.task_key);
  }

  const rounds = countFenceRepairRounds(raw, { fenceId, runId, fenceKey });

  return routeFenceRepair({
    verdict: params.verdict,
    fingerprintHistory: history,
    rounds,
    fenceDeps: fenceDeps ?? [],
  });
}
