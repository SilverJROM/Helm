/**
 * fence-workflow-upgrade A4 — native integration_test_agent role identity/route (R1.6, R9.1, R9.3, R9.4).
 *
 * A DISTINCT seat, deliberately not a tier under validator.L1–L4:
 *   - resolves model codex55 (topology / D7)
 *   - authors the fence functional test at plan time and persists authoring session identity
 *   - enforces per-fence verifier≠fixer (agent session ⟂ implementer sessions of members)
 *   - exposes the typed composition-judgment contract consumed by C4 on non-clean CLOSE
 *
 * Ordinary unit validator ladder (validator L1–L4) keeps owning unit gates including REPAIR.
 */

import type Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';

export type SqliteDb = Database.Database;

/** Topology role name — top-level key, NOT nested under validator. */
export const INTEGRATION_TEST_AGENT_ROLE = 'integration_test_agent' as const;
export type IntegrationTestAgentRole = typeof INTEGRATION_TEST_AGENT_ROLE;

/** Seat model per topology.yaml / decisions/D7 (R9.4). */
export const INTEGRATION_TEST_AGENT_MODEL = 'codex55' as const;
export type IntegrationTestAgentModel = typeof INTEGRATION_TEST_AGENT_MODEL;

/** Ordinary unit-validator ladder roles — distinct from integration_test_agent (R9.1). */
export const VALIDATOR_LADDER_ROLES = ['validator'] as const;

/** Remit of this seat only (R9.2) — nothing from the ordinary validator's remit. */
export const INTEGRATION_TEST_AGENT_REMIT = [
  'plan_time_author',
  'composition_judgment',
] as const;
export type IntegrationTestAgentRemit = (typeof INTEGRATION_TEST_AGENT_REMIT)[number];

export const INTEGRATION_TEST_AGENT_LAUNCH =
  'codex -m gpt-5.5 --dangerously-bypass-approvals-and-sandbox' as const;

/** Composition fault classes used at CLOSE judgment (R4.4 / R7.1) — contract for C4. */
export const COMPOSITION_FAULT_CLASSES = [
  'implementation',
  'plan',
  'environment',
  'unknown',
] as const;
export type CompositionFaultClass = (typeof COMPOSITION_FAULT_CLASSES)[number];

export type CompositionJudgmentVerdict = 'PASS' | 'FAIL' | 'PLAN_DEFECT';

/**
 * Resolved native route for the integration_test_agent seat (R9.1, R9.4).
 * `is_validator_ladder: false` is structural — this is not validator.L1–L4.
 */
export interface IntegrationTestAgentRoute {
  role: IntegrationTestAgentRole;
  model: IntegrationTestAgentModel;
  launch: typeof INTEGRATION_TEST_AGENT_LAUNCH;
  is_validator_ladder: false;
  remit: readonly IntegrationTestAgentRemit[];
}

/**
 * Input C4 feeds when non-clean CLOSE needs composition classification (R4.4).
 * The ordinary unit validator must never be the judge for this input.
 */
export interface CompositionJudgmentRequest {
  schema: 'fence-composition-judgment-request-v1';
  fence_key: string;
  run_id: number;
  open_failed_ids: string[];
  close_failed_ids: string[];
  close_passed_ids: string[];
  /** Driver-measured seam fingerprint when available (R5.4). */
  seam_fingerprint?: string;
  report_path?: string;
  /** Optional unit candidates the CLOSE report already names. */
  candidate_failing_units?: string[];
}

/**
 * Typed composition judgment owned by integration_test_agent (R7.1 / R7.3 / R9.2).
 * C4 consumes this shape; missing required fields fail closed at C3/C4, not here.
 */
export interface CompositionJudgment {
  schema: 'fence-composition-judgment-v1';
  fence: string;
  verdict: CompositionJudgmentVerdict;
  fault_class: CompositionFaultClass | null;
  failing_units: string[];
  seam_fingerprint: string;
  plan_defect: boolean;
  judged_by: {
    role: IntegrationTestAgentRole;
    model: IntegrationTestAgentModel;
    session_id: string;
  };
  note?: string;
}

export interface FenceImplementerSession {
  task_key: string;
  session_id: string;
  /** When present, must be an implementer-family role for the collision check. */
  role?: string;
}

export interface FenceAuthoringSessionRow {
  id: number;
  fence_id: number;
  run_id: number;
  fence_key: string;
  role: IntegrationTestAgentRole;
  model: IntegrationTestAgentModel;
  session_id: string;
  purpose: IntegrationTestAgentRemit;
  test_path: string | null;
  created_at: string;
}

export class FenceIntegrationAgentError extends Error {
  code:
    | 'not_integration_role'
    | 'validator_ladder_forbidden'
    | 'model_mismatch'
    | 'session_collision'
    | 'missing_session'
    | 'missing_fence'
    | 'invalid_purpose';
  constructor(
    code: FenceIntegrationAgentError['code'],
    message: string
  ) {
    super(message);
    this.code = code;
    this.name = 'FenceIntegrationAgentError';
  }
}

function resolveRaw(db: DatabaseService | SqliteDb): SqliteDb {
  if (db instanceof DatabaseService) return db.raw;
  return db as SqliteDb;
}

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/**
 * R9.1 + R9.4 — resolve the native integration_test_agent route.
 * Always codex55; never folded into validator ladder tiers.
 */
export function resolveIntegrationTestAgentRoute(): IntegrationTestAgentRoute {
  return {
    role: INTEGRATION_TEST_AGENT_ROLE,
    model: INTEGRATION_TEST_AGENT_MODEL,
    launch: INTEGRATION_TEST_AGENT_LAUNCH,
    is_validator_ladder: false,
    remit: INTEGRATION_TEST_AGENT_REMIT,
  };
}

/** True only for the native fence role, not for validator / implementer / etc. */
export function isIntegrationTestAgentRole(role: string | null | undefined): boolean {
  return role === INTEGRATION_TEST_AGENT_ROLE;
}

/**
 * Ordinary unit-validator ladder (role `validator` with any L1–L4 tier).
 * integration_test_agent is intentionally NOT this.
 */
export function isValidatorLadderRole(role: string | null | undefined): boolean {
  if (!role) return false;
  const base = role.split(/[/:]/)[0];
  return (VALIDATOR_LADDER_ROLES as readonly string[]).includes(base);
}

/**
 * R9.1 — refuse any attempt to treat a validator-ladder seat as the integration agent.
 */
export function assertNotValidatorLadderForIntegrationWork(role: string): void {
  if (isValidatorLadderRole(role)) {
    throw new FenceIntegrationAgentError(
      'validator_ladder_forbidden',
      `R9.1: role '${role}' is on the ordinary validator ladder — ` +
        `integration_test_agent is a distinct seat, not a validator duty`
    );
  }
  if (!isIntegrationTestAgentRole(role)) {
    throw new FenceIntegrationAgentError(
      'not_integration_role',
      `R9.1: role '${role}' is not '${INTEGRATION_TEST_AGENT_ROLE}'`
    );
  }
}

/**
 * R9.4 — resolved model for this seat must be codex55.
 */
export function assertIntegrationAgentModel(model: string): void {
  if (model !== INTEGRATION_TEST_AGENT_MODEL) {
    throw new FenceIntegrationAgentError(
      'model_mismatch',
      `R9.4: integration_test_agent seat must resolve to '${INTEGRATION_TEST_AGENT_MODEL}', got '${model}'`
    );
  }
}

/**
 * R1.6 — fence functional test ownership is the integration_test_agent seat (plan-time).
 */
export function assertPlanTimeAuthoredByIntegrationAgent(authoredBy: string | null | undefined): void {
  if (!isIntegrationTestAgentRole(authoredBy ?? null)) {
    throw new FenceIntegrationAgentError(
      'not_integration_role',
      `R1.6: fence functional test must be authored by '${INTEGRATION_TEST_AGENT_ROLE}' at plan time, ` +
        `got '${authoredBy ?? ''}'`
    );
  }
}

/**
 * R9.3 — per-fence verifier≠fixer by session identity (not merely role label).
 * integration_test_agent session must be disjoint from every implementer session of fence members.
 */
export function checkPerFenceVerifierFixerDisjoint(params: {
  fence_key: string;
  integration_agent_session_id: string;
  implementer_sessions: readonly FenceImplementerSession[];
}):
  | { ok: true }
  | {
      ok: false;
      collisions: Array<{ task_key: string; session_id: string }>;
      message: string;
    } {
  const agentSession = params.integration_agent_session_id?.trim();
  if (!nonEmpty(agentSession)) {
    return {
      ok: false,
      collisions: [],
      message: `R9.3: fence '${params.fence_key}' integration_test_agent session_id is required for disjointness check`,
    };
  }

  const collisions: Array<{ task_key: string; session_id: string }> = [];
  for (const impl of params.implementer_sessions ?? []) {
    if (!impl || !nonEmpty(impl.session_id)) continue;
    // Role label alone is not enough to pass — same session collides even if labels differ.
    if (impl.session_id.trim() === agentSession) {
      collisions.push({ task_key: impl.task_key, session_id: impl.session_id.trim() });
    }
  }

  if (collisions.length > 0) {
    const detail = collisions.map((c) => `${c.task_key}@${c.session_id}`).join(', ');
    return {
      ok: false,
      collisions,
      message:
        `R9.3: fence '${params.fence_key}' integration_test_agent session '${agentSession}' ` +
        `collides with implementer session(s) of contributing units: ${detail}`,
    };
  }
  return { ok: true };
}

/** Throw form of checkPerFenceVerifierFixerDisjoint (gate at author / judgment dispatch). */
export function assertPerFenceVerifierFixerDisjoint(params: {
  fence_key: string;
  integration_agent_session_id: string;
  implementer_sessions: readonly FenceImplementerSession[];
}): void {
  const r = checkPerFenceVerifierFixerDisjoint(params);
  if (!r.ok) {
    throw new FenceIntegrationAgentError('session_collision', r.message);
  }
}

/**
 * C4 entry: route non-clean CLOSE composition judgment to integration_test_agent (not unit validator).
 */
export function routeCompositionJudgment(): {
  role: IntegrationTestAgentRole;
  model: IntegrationTestAgentModel;
  purpose: 'composition_judgment';
  is_validator_ladder: false;
} {
  const route = resolveIntegrationTestAgentRoute();
  return {
    role: route.role,
    model: route.model,
    purpose: 'composition_judgment',
    is_validator_ladder: false,
  };
}

/**
 * Build a typed composition-judgment request for C4 (R4.4). Does not judge — only shapes the contract.
 */
export function buildCompositionJudgmentRequest(input: {
  fence_key: string;
  run_id: number;
  open_failed_ids?: string[];
  close_failed_ids?: string[];
  close_passed_ids?: string[];
  seam_fingerprint?: string;
  report_path?: string;
  candidate_failing_units?: string[];
}): CompositionJudgmentRequest {
  if (!nonEmpty(input.fence_key)) {
    throw new FenceIntegrationAgentError('missing_fence', 'composition judgment requires fence_key');
  }
  if (!Number.isFinite(input.run_id) || input.run_id <= 0) {
    throw new FenceIntegrationAgentError('missing_fence', `composition judgment requires positive run_id, got ${input.run_id}`);
  }
  return {
    schema: 'fence-composition-judgment-request-v1',
    fence_key: input.fence_key.trim(),
    run_id: input.run_id,
    open_failed_ids: [...(input.open_failed_ids ?? [])],
    close_failed_ids: [...(input.close_failed_ids ?? [])],
    close_passed_ids: [...(input.close_passed_ids ?? [])],
    seam_fingerprint: input.seam_fingerprint,
    report_path: input.report_path,
    candidate_failing_units: input.candidate_failing_units
      ? [...input.candidate_failing_units]
      : undefined,
  };
}

/**
 * Stamp a composition judgment as owned by the integration_test_agent seat (R7.3 / R9.2).
 * C4 fills fault_class / failing_units; this enforces judged_by identity + model.
 */
export function stampCompositionJudgment(
  partial: Omit<CompositionJudgment, 'schema' | 'judged_by'> & {
    judged_by?: Partial<CompositionJudgment['judged_by']>;
  },
  sessionId: string
): CompositionJudgment {
  if (!nonEmpty(sessionId)) {
    throw new FenceIntegrationAgentError(
      'missing_session',
      'R9.3: composition judgment requires integration_test_agent session_id'
    );
  }
  const model = partial.judged_by?.model ?? INTEGRATION_TEST_AGENT_MODEL;
  assertIntegrationAgentModel(model);
  const role = partial.judged_by?.role ?? INTEGRATION_TEST_AGENT_ROLE;
  assertNotValidatorLadderForIntegrationWork(role);

  return {
    schema: 'fence-composition-judgment-v1',
    fence: partial.fence,
    verdict: partial.verdict,
    fault_class: partial.fault_class,
    failing_units: [...(partial.failing_units ?? [])],
    seam_fingerprint: partial.seam_fingerprint,
    plan_defect: partial.plan_defect,
    judged_by: {
      role: INTEGRATION_TEST_AGENT_ROLE,
      model: INTEGRATION_TEST_AGENT_MODEL,
      session_id: sessionId.trim(),
    },
    note: partial.note,
  };
}

/**
 * R1.6 — persist plan-time authoring session identity for a fence.
 * Also stamps fences.authored_by = integration_test_agent when present.
 * Enforces R9.3 when implementer_sessions are supplied.
 */
export function persistPlanTimeAuthoring(
  db: DatabaseService | SqliteDb,
  params: {
    fence_id?: number;
    run_id: number;
    fence_key: string;
    session_id: string;
    test_path?: string | null;
    implementer_sessions?: readonly FenceImplementerSession[];
  }
): FenceAuthoringSessionRow {
  const raw = resolveRaw(db);
  if (!nonEmpty(params.session_id)) {
    throw new FenceIntegrationAgentError(
      'missing_session',
      'R1.6/R9.3: plan-time authoring requires a non-empty integration_test_agent session_id'
    );
  }
  if (!nonEmpty(params.fence_key)) {
    throw new FenceIntegrationAgentError('missing_fence', 'plan-time authoring requires fence_key');
  }
  if (!Number.isFinite(params.run_id) || params.run_id <= 0) {
    throw new FenceIntegrationAgentError(
      'missing_fence',
      `plan-time authoring requires positive run_id, got ${params.run_id}`
    );
  }

  if (params.implementer_sessions) {
    assertPerFenceVerifierFixerDisjoint({
      fence_key: params.fence_key,
      integration_agent_session_id: params.session_id,
      implementer_sessions: params.implementer_sessions,
    });
  }

  const route = resolveIntegrationTestAgentRoute();
  assertIntegrationAgentModel(route.model);

  let fenceId = params.fence_id;
  if (fenceId === undefined) {
    const row = raw
      .prepare('SELECT id, authored_by FROM fences WHERE run_id = ? AND fence_key = ?')
      .get(params.run_id, params.fence_key.trim()) as
      | { id: number; authored_by: string | null }
      | undefined;
    if (!row) {
      throw new FenceIntegrationAgentError(
        'missing_fence',
        `plan-time authoring: fence '${params.fence_key}' not found for run ${params.run_id}`
      );
    }
    fenceId = row.id;
  } else {
    const row = raw
      .prepare('SELECT id FROM fences WHERE id = ?')
      .get(fenceId) as { id: number } | undefined;
    if (!row) {
      throw new FenceIntegrationAgentError(
        'missing_fence',
        `plan-time authoring: fence_id ${fenceId} not found`
      );
    }
  }

  // R1.6 ownership stamp on the fence row (inspectable via SQL).
  raw
    .prepare(
      `UPDATE fences
       SET authored_by = ?,
           test_path = COALESCE(?, test_path),
           updated_at = datetime('now')
       WHERE id = ?`
    )
    .run(INTEGRATION_TEST_AGENT_ROLE, params.test_path ?? null, fenceId);

  raw
    .prepare(
      `INSERT INTO fence_authoring_sessions (
         fence_id, run_id, fence_key, role, model, session_id, purpose, test_path
       ) VALUES (?, ?, ?, ?, ?, ?, 'plan_time_author', ?)
       ON CONFLICT(fence_id, purpose) DO UPDATE SET
         session_id = excluded.session_id,
         model = excluded.model,
         role = excluded.role,
         test_path = excluded.test_path,
         run_id = excluded.run_id,
         fence_key = excluded.fence_key`
    )
    .run(
      fenceId,
      params.run_id,
      params.fence_key.trim(),
      INTEGRATION_TEST_AGENT_ROLE,
      INTEGRATION_TEST_AGENT_MODEL,
      params.session_id.trim(),
      params.test_path ?? null
    );

  const stored = getPlanTimeAuthoring(db, { fence_id: fenceId });
  if (!stored) {
    throw new FenceIntegrationAgentError(
      'missing_session',
      'plan-time authoring write did not persist (fence_authoring_sessions missing?)'
    );
  }
  return stored;
}

/**
 * Read persisted plan-time authoring session identity (R1.6).
 */
export function getPlanTimeAuthoring(
  db: DatabaseService | SqliteDb,
  key: { fence_id: number } | { run_id: number; fence_key: string }
): FenceAuthoringSessionRow | null {
  const raw = resolveRaw(db);
  if ('fence_id' in key) {
    return (
      (raw
        .prepare(
          `SELECT id, fence_id, run_id, fence_key, role, model, session_id, purpose, test_path, created_at
           FROM fence_authoring_sessions
           WHERE fence_id = ? AND purpose = 'plan_time_author'`
        )
        .get(key.fence_id) as FenceAuthoringSessionRow | undefined) ?? null
    );
  }
  return (
    (raw
      .prepare(
        `SELECT id, fence_id, run_id, fence_key, role, model, session_id, purpose, test_path, created_at
         FROM fence_authoring_sessions
         WHERE run_id = ? AND fence_key = ? AND purpose = 'plan_time_author'`
      )
      .get(key.run_id, key.fence_key) as FenceAuthoringSessionRow | undefined) ?? null
  );
}

/**
 * Persist the session that will judge composition at CLOSE (same seat identity rules).
 * Used when C4 dispatches non-clean CLOSE judgment.
 */
export function persistCompositionJudgmentSession(
  db: DatabaseService | SqliteDb,
  params: {
    fence_id?: number;
    run_id: number;
    fence_key: string;
    session_id: string;
    implementer_sessions?: readonly FenceImplementerSession[];
  }
): FenceAuthoringSessionRow {
  const raw = resolveRaw(db);
  if (!nonEmpty(params.session_id)) {
    throw new FenceIntegrationAgentError(
      'missing_session',
      'composition judgment requires integration_test_agent session_id'
    );
  }

  if (params.implementer_sessions) {
    assertPerFenceVerifierFixerDisjoint({
      fence_key: params.fence_key,
      integration_agent_session_id: params.session_id,
      implementer_sessions: params.implementer_sessions,
    });
  }

  let fenceId = params.fence_id;
  if (fenceId === undefined) {
    const row = raw
      .prepare('SELECT id FROM fences WHERE run_id = ? AND fence_key = ?')
      .get(params.run_id, params.fence_key.trim()) as { id: number } | undefined;
    if (!row) {
      throw new FenceIntegrationAgentError(
        'missing_fence',
        `composition judgment: fence '${params.fence_key}' not found for run ${params.run_id}`
      );
    }
    fenceId = row.id;
  }

  raw
    .prepare(
      `INSERT INTO fence_authoring_sessions (
         fence_id, run_id, fence_key, role, model, session_id, purpose, test_path
       ) VALUES (?, ?, ?, ?, ?, ?, 'composition_judgment', NULL)
       ON CONFLICT(fence_id, purpose) DO UPDATE SET
         session_id = excluded.session_id,
         model = excluded.model,
         role = excluded.role,
         run_id = excluded.run_id,
         fence_key = excluded.fence_key`
    )
    .run(
      fenceId,
      params.run_id,
      params.fence_key.trim(),
      INTEGRATION_TEST_AGENT_ROLE,
      INTEGRATION_TEST_AGENT_MODEL,
      params.session_id.trim()
    );

  const stored = raw
    .prepare(
      `SELECT id, fence_id, run_id, fence_key, role, model, session_id, purpose, test_path, created_at
       FROM fence_authoring_sessions
       WHERE fence_id = ? AND purpose = 'composition_judgment'`
    )
    .get(fenceId) as FenceAuthoringSessionRow | undefined;
  if (!stored) {
    throw new FenceIntegrationAgentError(
      'missing_session',
      'composition judgment session write did not persist'
    );
  }
  return stored;
}
