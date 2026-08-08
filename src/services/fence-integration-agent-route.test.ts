/**
 * fence-workflow-upgrade A4 — integration_test_agent role identity/route (R1.6, R9.1, R9.3, R9.4).
 *
 * Covers:
 *  - distinct role route resolving codex55, not validator ladder
 *  - plan-time authoring ownership + persisted session identity
 *  - per-fence verifier≠fixer by session (not role label alone)
 *  - typed composition-judgment contract for C4
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import { ingestFenceMembership } from './fence-membership-ingest.js';
import type { FencePlanContract } from './fence-plan-contract.js';
import {
  INTEGRATION_TEST_AGENT_MODEL,
  INTEGRATION_TEST_AGENT_ROLE,
  FenceIntegrationAgentError,
  assertIntegrationAgentModel,
  assertNotValidatorLadderForIntegrationWork,
  assertPerFenceVerifierFixerDisjoint,
  assertPlanTimeAuthoredByIntegrationAgent,
  buildCompositionJudgmentRequest,
  checkPerFenceVerifierFixerDisjoint,
  getPlanTimeAuthoring,
  isIntegrationTestAgentRole,
  isValidatorLadderRole,
  persistCompositionJudgmentSession,
  persistPlanTimeAuthoring,
  resolveIntegrationTestAgentRoute,
  routeCompositionJudgment,
  stampCompositionJudgment,
} from './fence-integration-agent-route.js';

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    dbPath: path.join(dir, 'helm.db'),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

function insertProjectRun(db: DatabaseService): { projectId: number; runId: number } {
  const projectId = (
    db.raw
      .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get(`fence-a4-${Date.now()}`, `/tmp/fence-a4-${Date.now()}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'A4', 'fence-int-agent') as { id: number }
  ).id;
  return { projectId, runId };
}

const FENCE_I1: FencePlanContract = {
  fence_key: 'I1',
  integration_cmd:
    'npx vitest run src/services/fence-f1-contract.integration.test.ts --minWorkers=1 --maxWorkers=4',
  negative_control_cmd:
    'FENCE_STUB=A3 npx vitest run src/services/fence-f1-contract.integration.test.ts --minWorkers=1 --maxWorkers=4',
  acceptance_ids: ['R1.1', 'R1.6', 'R9.1', 'R9.3', 'R9.4'],
  test_path: 'src/services/fence-f1-contract.integration.test.ts',
  authored_by: 'integration_test_agent',
  members: ['A1', 'A2', 'A3', 'A4'],
  label: 'F1 plan-contract',
};

describe('A4 integration_test_agent route (R1.6, R9.1, R9.3, R9.4)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('R9.1/R9.4: resolves a native route to codex55, distinct from validator ladder', () => {
    const route = resolveIntegrationTestAgentRoute();
    expect(route.role).toBe(INTEGRATION_TEST_AGENT_ROLE);
    expect(route.model).toBe(INTEGRATION_TEST_AGENT_MODEL);
    expect(route.model).toBe('codex55');
    expect(route.is_validator_ladder).toBe(false);
    expect(route.remit).toEqual(['plan_time_author', 'composition_judgment']);
    expect(route.launch).toContain('gpt-5.5');

    expect(isIntegrationTestAgentRole(route.role)).toBe(true);
    expect(isIntegrationTestAgentRole('validator')).toBe(false);
    expect(isValidatorLadderRole('validator')).toBe(true);
    expect(isValidatorLadderRole('validator/L3')).toBe(true);
    expect(isValidatorLadderRole(route.role)).toBe(false);

    expect(() => assertNotValidatorLadderForIntegrationWork('validator')).toThrow(
      FenceIntegrationAgentError
    );
    expect(() => assertNotValidatorLadderForIntegrationWork('validator/L2')).toThrow(
      /validator ladder/i
    );
    expect(() => assertNotValidatorLadderForIntegrationWork(INTEGRATION_TEST_AGENT_ROLE)).not.toThrow();

    expect(() => assertIntegrationAgentModel('codex55')).not.toThrow();
    expect(() => assertIntegrationAgentModel('sonnet5')).toThrow(/R9\.4|codex55/i);
    expect(() => assertIntegrationAgentModel('grok45')).toThrow(FenceIntegrationAgentError);
  });

  it('R1.6: plan-time authoring persists session identity and stamps authored_by', () => {
    const t = tempDbPath('helm-fence-a4-author-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(117);
    expect(
      (db.raw.prepare('SELECT version FROM schema_version').get() as { version: number }).version
    ).toBe(SCHEMA_VERSION);

    const tables = (
      db.raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain('fence_authoring_sessions');

    const { runId } = insertProjectRun(db);
    const ingested = ingestFenceMembership(db, { runId, fences: [FENCE_I1] });
    const fenceId = ingested.fenceIdsByKey.I1;

    const sessionId = 'x-intagent-codex55-plan-time-I1';
    const row = persistPlanTimeAuthoring(db, {
      run_id: runId,
      fence_key: 'I1',
      session_id: sessionId,
      test_path: FENCE_I1.test_path,
      implementer_sessions: [
        { task_key: 'A1', session_id: 'x-impl-a1-grok45' },
        { task_key: 'A2', session_id: 'x-impl-a2-grok45' },
      ],
    });

    expect(row.role).toBe(INTEGRATION_TEST_AGENT_ROLE);
    expect(row.model).toBe('codex55');
    expect(row.session_id).toBe(sessionId);
    expect(row.purpose).toBe('plan_time_author');
    expect(row.fence_id).toBe(fenceId);
    expect(row.test_path).toBe(FENCE_I1.test_path);

    const fence = db.raw.prepare('SELECT authored_by, test_path FROM fences WHERE id = ?').get(fenceId) as {
      authored_by: string;
      test_path: string;
    };
    expect(fence.authored_by).toBe('integration_test_agent');
    expect(fence.test_path).toBe(FENCE_I1.test_path);
    assertPlanTimeAuthoredByIntegrationAgent(fence.authored_by);

    // SQL-inspectable (not code-only reconstruction)
    const sql = db.raw
      .prepare(
        `SELECT role, model, session_id, purpose
         FROM fence_authoring_sessions
         WHERE fence_id = ? AND purpose = 'plan_time_author'`
      )
      .get(fenceId) as { role: string; model: string; session_id: string; purpose: string };
    expect(sql).toEqual({
      role: 'integration_test_agent',
      model: 'codex55',
      session_id: sessionId,
      purpose: 'plan_time_author',
    });

    expect(getPlanTimeAuthoring(db, { fence_id: fenceId })?.session_id).toBe(sessionId);
    expect(getPlanTimeAuthoring(db, { run_id: runId, fence_key: 'I1' })?.session_id).toBe(sessionId);

    expect(() => assertPlanTimeAuthoredByIntegrationAgent('implementer')).toThrow(/R1\.6/);
    expect(() => assertPlanTimeAuthoredByIntegrationAgent('validator')).toThrow(FenceIntegrationAgentError);

    db.close();
  });

  it('R9.3: per-fence verifier≠fixer refuses same session as any member implementer', () => {
    const shared = 'x-same-session-collides';
    const ok = checkPerFenceVerifierFixerDisjoint({
      fence_key: 'I1',
      integration_agent_session_id: 'x-intagent-ok',
      implementer_sessions: [
        { task_key: 'A1', session_id: 'x-impl-a1' },
        { task_key: 'A2', session_id: 'x-impl-a2' },
      ],
    });
    expect(ok).toEqual({ ok: true });

    const collide = checkPerFenceVerifierFixerDisjoint({
      fence_key: 'I1',
      integration_agent_session_id: shared,
      implementer_sessions: [
        { task_key: 'A1', session_id: 'x-impl-a1' },
        // Same session as agent even if role label says implementer — session identity wins
        { task_key: 'A3', session_id: shared, role: 'implementer' },
      ],
    });
    expect(collide.ok).toBe(false);
    if (!collide.ok) {
      expect(collide.collisions).toEqual([{ task_key: 'A3', session_id: shared }]);
      expect(collide.message).toMatch(/R9\.3|collides/i);
    }

    expect(() =>
      assertPerFenceVerifierFixerDisjoint({
        fence_key: 'I1',
        integration_agent_session_id: shared,
        implementer_sessions: [{ task_key: 'A4', session_id: shared }],
      })
    ).toThrow(FenceIntegrationAgentError);

    // Role labels alone cannot launder a collision
    expect(() =>
      assertPerFenceVerifierFixerDisjoint({
        fence_key: 'I1',
        integration_agent_session_id: shared,
        implementer_sessions: [
          { task_key: 'A1', session_id: shared, role: 'integration_test_agent' },
        ],
      })
    ).toThrow(/session/i);

    // Persistence path also enforces disjointness when implementer sessions are supplied
    const t = tempDbPath('helm-fence-a4-disjoint-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const { runId } = insertProjectRun(db);
    ingestFenceMembership(db, { runId, fences: [FENCE_I1] });

    expect(() =>
      persistPlanTimeAuthoring(db, {
        run_id: runId,
        fence_key: 'I1',
        session_id: shared,
        implementer_sessions: [{ task_key: 'A2', session_id: shared }],
      })
    ).toThrow(/R9\.3|collides/i);

    // No partial authoring row on collision
    expect(getPlanTimeAuthoring(db, { run_id: runId, fence_key: 'I1' })).toBeNull();

    db.close();
  });

  it('C4 contract: composition judgment routes to integration_test_agent, not unit validator', () => {
    const route = routeCompositionJudgment();
    expect(route.role).toBe('integration_test_agent');
    expect(route.model).toBe('codex55');
    expect(route.purpose).toBe('composition_judgment');
    expect(route.is_validator_ladder).toBe(false);

    const req = buildCompositionJudgmentRequest({
      fence_key: 'I3',
      run_id: 42,
      open_failed_ids: ['R4.1'],
      close_failed_ids: ['R4.1', 'R4.4'],
      close_passed_ids: ['R4.2'],
      seam_fingerprint: 'fp:abc',
      candidate_failing_units: ['C2'],
    });
    expect(req.schema).toBe('fence-composition-judgment-request-v1');
    expect(req.fence_key).toBe('I3');
    expect(req.close_failed_ids).toEqual(['R4.1', 'R4.4']);
    expect(req.candidate_failing_units).toEqual(['C2']);

    const judgment = stampCompositionJudgment(
      {
        fence: 'I3',
        verdict: 'FAIL',
        fault_class: 'implementation',
        failing_units: ['C2'],
        seam_fingerprint: 'fp:abc',
        plan_defect: false,
        note: 'composition still red after unit gates',
      },
      'x-intagent-close-judge'
    );
    expect(judgment.schema).toBe('fence-composition-judgment-v1');
    expect(judgment.judged_by).toEqual({
      role: 'integration_test_agent',
      model: 'codex55',
      session_id: 'x-intagent-close-judge',
    });
    expect(judgment.fault_class).toBe('implementation');
    expect(judgment.failing_units).toEqual(['C2']);

    // Cannot stamp with validator ladder identity
    expect(() =>
      stampCompositionJudgment(
        {
          fence: 'I3',
          verdict: 'FAIL',
          fault_class: 'plan',
          failing_units: [],
          seam_fingerprint: 'fp:x',
          plan_defect: true,
          judged_by: { role: 'validator' as any, model: 'codex55' },
        },
        'x-val-should-not-judge'
      )
    ).toThrow(/validator ladder|R9\.1/i);

    // Persist CLOSE judgment session identity with disjointness
    const t = tempDbPath('helm-fence-a4-judge-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);
    const { runId } = insertProjectRun(db);
    ingestFenceMembership(db, { runId, fences: [FENCE_I1] });

    const judgeRow = persistCompositionJudgmentSession(db, {
      run_id: runId,
      fence_key: 'I1',
      session_id: 'x-intagent-close-I1',
      implementer_sessions: [
        { task_key: 'A1', session_id: 'x-impl-a1' },
        { task_key: 'A4', session_id: 'x-impl-a4' },
      ],
    });
    expect(judgeRow.purpose).toBe('composition_judgment');
    expect(judgeRow.model).toBe('codex55');
    expect(judgeRow.session_id).toBe('x-intagent-close-I1');

    expect(() =>
      persistCompositionJudgmentSession(db, {
        run_id: runId,
        fence_key: 'I1',
        session_id: 'x-impl-a1',
        implementer_sessions: [{ task_key: 'A1', session_id: 'x-impl-a1' }],
      })
    ).toThrow(/R9\.3|collides/i);

    db.close();
  });
});
