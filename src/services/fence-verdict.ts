/**
 * fence-workflow-upgrade C3 -- strict fence composition verdicts.
 *
 * A fence verdict is a fence-level composition judgment, not an ordinary unit
 * validator result. This module hardens the A4 CompositionJudgment shape,
 * maps it onto NormalizedValidatorVerdict fields, and persists each verdict as
 * append-only run_events + JSON artifact rows.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import {
  normalizeValidatorVerdict,
  type NormalizedValidatorVerdict,
} from './run-artifact-service.js';
import {
  COMPOSITION_FAULT_CLASSES,
  INTEGRATION_TEST_AGENT_MODEL,
  INTEGRATION_TEST_AGENT_ROLE,
  type CompositionFaultClass,
  type CompositionJudgment,
} from './fence-integration-agent-route.js';

export type SqliteDb = Database.Database;

export const FENCE_VERDICT_SCHEMA = 'fence-verdict-v1' as const;
export const FENCE_VERDICT_EVENT_TYPE = 'FENCE_COMPOSITION_VERDICT' as const;
export const FENCE_VERDICT_ARTIFACT_TYPE = 'fence-composition-verdict' as const;

export type FenceVerdictState = 'PASS' | 'FAIL' | 'PLAN_DEFECT';

export interface StrictFenceVerdict extends NormalizedValidatorVerdict {
  schema: typeof FENCE_VERDICT_SCHEMA;
  fence: string;
  verdict: FenceVerdictState;
  fault_class: CompositionFaultClass | null;
  failing_units: string[];
  seam_fingerprint: string;
  plan_defect: boolean;
  judged_by: {
    role: typeof INTEGRATION_TEST_AGENT_ROLE;
    model: typeof INTEGRATION_TEST_AGENT_MODEL;
    session_id: string;
  };
  validation_errors: string[];
}

export interface PersistedFenceVerdict {
  verdict: StrictFenceVerdict;
  artifactId: number;
  eventId: number;
  artifactPath: string;
  sha: string;
}

export class FenceVerdictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FenceVerdictError';
  }
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function stringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out = value.map((v) => String(v).trim()).filter(Boolean);
  return out.length === value.length ? out : null;
}

function isFaultClass(value: unknown): value is CompositionFaultClass {
  return typeof value === 'string' && (COMPOSITION_FAULT_CLASSES as readonly string[]).includes(value);
}

function isVerdict(value: unknown): value is FenceVerdictState {
  return value === 'PASS' || value === 'FAIL' || value === 'PLAN_DEFECT';
}

function stableFingerprint(seed: unknown): string {
  const digest = createHash('sha256')
    .update(JSON.stringify(seed))
    .digest('hex')
    .slice(0, 20);
  return `fp1:${digest}`;
}

function sha256Json(value: unknown): string {
  return `sha256:${createHash('sha256').update(`${JSON.stringify(value, null, 2)}\n`).digest('hex')}`;
}

function normalizeNote(inputNote: unknown, fallback: string): string {
  return nonEmptyString(inputNote) ? inputNote.trim() : fallback;
}

function validatorNoteFor(input: {
  verdict: FenceVerdictState;
  faultClass: CompositionFaultClass | null;
  planDefect: boolean;
  note: unknown;
}): string | null {
  if (input.verdict === 'PASS') {
    return nonEmptyString(input.note) ? input.note.trim() : null;
  }
  const note = normalizeNote(
    input.note,
    `fence composition verdict=${input.verdict} fault_class=${input.faultClass ?? 'unknown'}`
  );
  if (/defect_class\s*[:=]/i.test(note)) return note;
  const defectClass =
    input.verdict === 'PLAN_DEFECT' || input.planDefect || input.faultClass === 'plan'
      ? 'plan-defect'
      : input.faultClass === 'environment'
        ? 'test-failure'
        : 'behavior-mismatch';
  return `defect_class=${defectClass}; ${note}`;
}

function failClosed(raw: unknown, errors: string[], opts?: { fence?: string; seamFingerprint?: string | null }): StrictFenceVerdict {
  const rec = asRecord(raw);
  const fence = nonEmptyString(opts?.fence)
    ? opts!.fence.trim()
    : nonEmptyString(rec.fence)
      ? rec.fence.trim()
      : 'unknown';
  const seamFingerprint = nonEmptyString(opts?.seamFingerprint)
    ? opts!.seamFingerprint.trim()
    : nonEmptyString(rec.seam_fingerprint)
      ? rec.seam_fingerprint.trim()
      : stableFingerprint({ fence, errors, raw });
  const note =
    `PROTOCOL-DEFECT: fence verdict failed closed; missing/invalid field(s): ${errors.join(', ')}`;
  const normalized = normalizeValidatorVerdict('FAIL', `defect_class=plan-defect; ${note}`);
  return {
    schema: FENCE_VERDICT_SCHEMA,
    fence,
    verdict: 'FAIL',
    fault_class: 'plan',
    failing_units: [],
    seam_fingerprint: seamFingerprint,
    plan_defect: true,
    judged_by: {
      role: INTEGRATION_TEST_AGENT_ROLE,
      model: INTEGRATION_TEST_AGENT_MODEL,
      session_id: 'fail-closed',
    },
    validation_errors: [...errors],
    ...normalized,
  };
}

/**
 * Normalize a composition judgment into the strict C3 fence-verdict contract.
 * Missing or invalid required fields produce a durable FAIL/plan_defect verdict.
 */
export function normalizeFenceVerdict(
  input: unknown,
  opts?: { fence?: string; seamFingerprint?: string | null }
): StrictFenceVerdict {
  const rec = asRecord(input);
  const errors: string[] = [];

  if (rec.schema !== 'fence-composition-judgment-v1' && rec.schema !== FENCE_VERDICT_SCHEMA) {
    errors.push('schema');
  }
  if (!nonEmptyString(rec.fence)) errors.push('fence');
  if (!isVerdict(rec.verdict)) errors.push('verdict');
  if (!('fault_class' in rec)) errors.push('fault_class');
  if (!('failing_units' in rec)) errors.push('failing_units');
  if (!nonEmptyString(rec.seam_fingerprint)) errors.push('seam_fingerprint');
  if (typeof rec.plan_defect !== 'boolean') errors.push('plan_defect');

  const judgedBy = asRecord(rec.judged_by);
  if (judgedBy.role !== INTEGRATION_TEST_AGENT_ROLE) errors.push('judged_by.role');
  if (judgedBy.model !== INTEGRATION_TEST_AGENT_MODEL) errors.push('judged_by.model');
  if (!nonEmptyString(judgedBy.session_id)) errors.push('judged_by.session_id');

  const verdict = rec.verdict as FenceVerdictState;
  const faultClass = rec.fault_class;
  const failingUnits = stringArray(rec.failing_units);

  if ('fault_class' in rec && faultClass !== null && !isFaultClass(faultClass)) {
    errors.push('fault_class.unknown');
  }
  if ('failing_units' in rec && !failingUnits) {
    errors.push('failing_units.invalid');
  }
  if (verdict === 'PASS' && (faultClass !== null || (failingUnits?.length ?? 0) > 0 || rec.plan_defect !== false)) {
    errors.push('pass.must_not_carry_fault');
  }
  if ((verdict === 'FAIL' || verdict === 'PLAN_DEFECT') && !isFaultClass(faultClass)) {
    errors.push('fault_class.required_for_failure');
  }
  if (faultClass === 'implementation' && (failingUnits?.length ?? 0) === 0) {
    errors.push('failing_units.required_for_implementation');
  }
  if (faultClass === 'implementation' && (failingUnits?.length ?? 0) > 2) {
    errors.push('failing_units.max_two');
  }
  if ((verdict === 'PLAN_DEFECT' || faultClass === 'plan') && rec.plan_defect !== true) {
    errors.push('plan_defect.required_for_plan');
  }

  if (errors.length > 0) return failClosed(input, errors, opts);

  const planDefect = rec.plan_defect as boolean;
  const normalized = normalizeValidatorVerdict(
    verdict === 'PASS' ? 'PASS' : 'FAIL',
    validatorNoteFor({
      verdict,
      faultClass: faultClass as CompositionFaultClass | null,
      planDefect,
      note: rec.note,
    })
  );

  return {
    schema: FENCE_VERDICT_SCHEMA,
    fence: (rec.fence as string).trim(),
    verdict,
    fault_class: faultClass as CompositionFaultClass | null,
    failing_units: failingUnits ?? [],
    seam_fingerprint: (rec.seam_fingerprint as string).trim(),
    plan_defect: planDefect,
    judged_by: {
      role: INTEGRATION_TEST_AGENT_ROLE,
      model: INTEGRATION_TEST_AGENT_MODEL,
      session_id: (judgedBy.session_id as string).trim(),
    },
    validation_errors: [],
    ...normalized,
  };
}

export function persistFenceVerdict(
  db: DatabaseService | SqliteDb,
  params: {
    runId: number | string;
    batchId?: string | null;
    verdict: CompositionJudgment | StrictFenceVerdict | unknown;
    runDir?: string | null;
    artifactPath?: string | null;
  }
): PersistedFenceVerdict {
  const raw = resolveRaw(db);
  const verdict = normalizeFenceVerdict(params.verdict);
  const json = `${JSON.stringify(verdict, null, 2)}\n`;
  const artifactPath =
    params.artifactPath?.trim() ||
    path.join(
      params.runDir?.trim() || process.cwd(),
      'artifacts',
      `fence-verdict-${verdict.fence}-${Date.now()}-${process.hrtime.bigint()}.json`
    );
  fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
  fs.writeFileSync(artifactPath, json, 'utf8');
  const sha = sha256Json(verdict);

  const record = raw.transaction(() => {
    const artifact = raw
      .prepare(
        `INSERT INTO artifacts (run_id, type, path, sha, created_at)
         VALUES (?, ?, ?, ?, datetime('now'))`
      )
      .run(Number(params.runId), FENCE_VERDICT_ARTIFACT_TYPE, artifactPath, sha);
    const artifactId = Number(artifact.lastInsertRowid);
    if (!Number.isFinite(artifactId) || artifactId <= 0) {
      throw new FenceVerdictError(`failed to record fence verdict artifact for run ${params.runId}`);
    }
    const eventPayload = {
      ...verdict,
      artifact_id: artifactId,
      artifact_path: artifactPath,
      artifact_sha: sha,
    };
    const event = raw
      .prepare(
        `INSERT INTO run_events (run_id, batch_id, event_type, payload_json)
         VALUES (?, ?, ?, ?)`
      )
      .run(String(params.runId), params.batchId ?? null, FENCE_VERDICT_EVENT_TYPE, JSON.stringify(eventPayload));
    const eventId = Number(event.lastInsertRowid);
    if (!Number.isFinite(eventId) || eventId <= 0) {
      throw new FenceVerdictError(`failed to record fence verdict event for run ${params.runId}`);
    }
    return { artifactId, eventId };
  })();

  return {
    verdict,
    artifactId: record.artifactId,
    eventId: record.eventId,
    artifactPath,
    sha,
  };
}
