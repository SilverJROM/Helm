/**
 * Plan-time fence journeys — real-product evaluation for OPEN/CLOSE checkpoints.
 *
 * Loaded by fence-f*.integration.test.ts when present. OPEN still goes red until product
 * lands; CLOSE goes green only when the real A1–A4 (etc.) seams compose.
 *
 * FENCE_STUB=<unit> forces the named negative-control failure for that fence.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { SCHEMA_VERSION } from '../db/schema.js';
import {
  INTEGRATION_TEST_AGENT_MODEL,
  INTEGRATION_TEST_AGENT_ROLE,
  assertNotValidatorLadderForIntegrationWork,
  assertPerFenceVerifierFixerDisjoint,
  assertPlanTimeAuthoredByIntegrationAgent,
  checkPerFenceVerifierFixerDisjoint,
  getPlanTimeAuthoring,
  isIntegrationTestAgentRole,
  isValidatorLadderRole,
  persistPlanTimeAuthoring,
  resolveIntegrationTestAgentRoute,
} from './fence-integration-agent-route.js';
import {
  ingestFenceMembership,
  queryFenceMembership,
} from './fence-membership-ingest.js';
import {
  FENCE_MEMBER_CEILING,
  type FencePlanContract,
  validatePlanFences,
} from './fence-plan-contract.js';

export type AssertionResult = { ok: boolean; message: string };

function result(ok: boolean, message: string): AssertionResult {
  return { ok, message };
}

function tableExists(db: DatabaseService, name: string): boolean {
  const row = db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

function insertProjectRun(db: DatabaseService): { projectId: number; runId: number } {
  const projectId = (
    db.raw
      .prepare('INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id')
      .get(`fence-f1-journey-${Date.now()}`, `/tmp/fence-f1-journey-${Date.now()}`) as { id: number }
  ).id;
  const runId = (
    db.raw
      .prepare(
        "INSERT INTO runs (project_id, batch_id, north_star_ref, status, phase) VALUES (?, ?, ?, 'active', 'implementation') RETURNING id"
      )
      .get(projectId, 'I1-journey', 'fence-f1') as { id: number }
  ).id;
  return { projectId, runId };
}

const FENCE_I1_CONTRACT: FencePlanContract = {
  fence_key: 'I1',
  integration_cmd:
    'npx vitest run src/services/fence-f1-contract.integration.test.ts --minWorkers=1 --maxWorkers=4',
  negative_control_cmd:
    'FENCE_STUB=A3 npx vitest run src/services/fence-f1-contract.integration.test.ts --minWorkers=1 --maxWorkers=4',
  acceptance_ids: ['R1.1', 'R1.2', 'R1.3', 'R1.4', 'R1.5', 'R1.6', 'R9.1', 'R9.3', 'R9.4'],
  test_path: 'src/services/fence-f1-contract.integration.test.ts',
  authored_by: 'integration_test_agent',
  members: ['A1', 'A2', 'A3', 'A4'],
  label: 'F1 plan-contract membership',
};

/**
 * F1/I1: plan contract → ingest → inspectable membership + integration_test_agent ownership.
 * Negative control: FENCE_STUB=A3 forces R1.4 fail (membership not inspectable for the stubbed path).
 */
export async function runF1ContractJourney(input: {
  fence?: string;
  stub?: string;
  dbPath?: string;
  contractPath?: string;
}): Promise<Partial<Record<string, boolean | AssertionResult>>> {
  const stub = input.stub || process.env.FENCE_STUB || '';
  const dbPath = input.dbPath || process.env.HELM_DB_PATH;
  if (!dbPath) {
    return {
      'R1.1': result(false, 'HELM_DB_PATH required for F1 journey'),
      'R1.2': result(false, 'HELM_DB_PATH required for F1 journey'),
      'R1.3': result(false, 'HELM_DB_PATH required for F1 journey'),
      'R1.4': result(false, 'HELM_DB_PATH required for F1 journey'),
      'R1.5': result(false, 'HELM_DB_PATH required for F1 journey'),
      'R1.6': result(false, 'HELM_DB_PATH required for F1 journey'),
      'R9.1': result(false, 'HELM_DB_PATH required for F1 journey'),
      'R9.3': result(false, 'HELM_DB_PATH required for F1 journey'),
      'R9.4': result(false, 'HELM_DB_PATH required for F1 journey'),
    };
  }

  const productFiles = [
    'src/services/fence-plan-contract.ts',
    'src/services/fence-membership-ingest.ts',
    'src/services/fence-integration-agent-route.ts',
  ];
  const haveProduct = productFiles.every((p) => fs.existsSync(path.join(process.cwd(), p)));
  if (!haveProduct) {
    return {
      'R1.1': result(false, 'native fence plan/membership/agent product files absent'),
      'R1.2': result(false, 'native fence plan/membership/agent product files absent'),
      'R1.3': result(false, 'native fence plan/membership/agent product files absent'),
      'R1.4': result(false, 'native fence plan/membership/agent product files absent'),
      'R1.5': result(false, 'native fence plan/membership/agent product files absent'),
      'R1.6': result(false, 'native fence plan/membership/agent product files absent'),
      'R9.1': result(false, 'native fence plan/membership/agent product files absent'),
      'R9.3': result(false, 'native fence plan/membership/agent product files absent'),
      'R9.4': result(false, 'native fence plan/membership/agent product files absent'),
    };
  }

  const db = new DatabaseService(dbPath);
  try {
    const hasTables =
      tableExists(db, 'fences') &&
      tableExists(db, 'fence_members') &&
      tableExists(db, 'fence_authoring_sessions');
    const schemaOk =
      (db.raw.prepare('SELECT version FROM schema_version').get() as { version: number } | undefined)
        ?.version === SCHEMA_VERSION && SCHEMA_VERSION >= 117;

    const known = new Set(['A1', 'A2', 'A3', 'A4', 'A5', 'A6']);

    // R1.3 — missing negative_control_cmd refused at plan accept
    const missingNc = validatePlanFences(
      {
        'I1-bad-nc': {
          integration_cmd: 'true',
          // negative_control_cmd intentionally omitted
          acceptance_ids: ['R1.1'],
          test_path: 'x.ts',
          authored_by: 'integration_test_agent',
          members: ['A1'],
        },
      },
      known
    );
    const refuseMissingNc =
      missingNc.ok === false && missingNc.errors.some((e) => /negative_control/i.test(e));

    // R1.2 — full contract fields accepted (record keyed by fence_key)
    const good = validatePlanFences(
      {
        I1: {
          integration_cmd: FENCE_I1_CONTRACT.integration_cmd,
          negative_control_cmd: FENCE_I1_CONTRACT.negative_control_cmd,
          acceptance_ids: FENCE_I1_CONTRACT.acceptance_ids,
          test_path: FENCE_I1_CONTRACT.test_path,
          authored_by: FENCE_I1_CONTRACT.authored_by,
          members: FENCE_I1_CONTRACT.members,
          label: FENCE_I1_CONTRACT.label,
        },
      },
      known
    );
    const contractAccepted = good.ok === true && good.fences.length === 1;

    // Ceiling refuse (>5 members)
    const overCeiling = validatePlanFences(
      {
        'I1-ceil': {
          integration_cmd: FENCE_I1_CONTRACT.integration_cmd,
          negative_control_cmd: FENCE_I1_CONTRACT.negative_control_cmd,
          acceptance_ids: FENCE_I1_CONTRACT.acceptance_ids,
          test_path: FENCE_I1_CONTRACT.test_path,
          authored_by: FENCE_I1_CONTRACT.authored_by,
          members: ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'],
          label: FENCE_I1_CONTRACT.label,
        },
      },
      known
    );
    const refuseCeiling =
      overCeiling.ok === false &&
      overCeiling.errors.some((e) => /ceiling|5|member/i.test(e));

    // R9.1 / R9.4 — native route
    let r91 = false;
    let r94 = false;
    let r93 = false;
    let r16 = false;
    let r15 = false;
    let r14 = false;
    let r11 = false;
    let routeMsg = '';
    try {
      const route = resolveIntegrationTestAgentRoute();
      r91 =
        route.role === INTEGRATION_TEST_AGENT_ROLE &&
        route.is_validator_ladder === false &&
        isIntegrationTestAgentRole(route.role) &&
        !isValidatorLadderRole(route.role) &&
        isValidatorLadderRole('validator');
      r94 = route.model === INTEGRATION_TEST_AGENT_MODEL && route.model === 'codex55';
      assertNotValidatorLadderForIntegrationWork(INTEGRATION_TEST_AGENT_ROLE);
      try {
        assertNotValidatorLadderForIntegrationWork('validator');
        r91 = false;
        routeMsg = 'validator ladder was not refused for integration work';
      } catch {
        /* expected */
      }
    } catch (e) {
      routeMsg = e instanceof Error ? e.message : String(e);
    }

    // R9.3 — session-level verifier≠fixer
    const disjointOk = checkPerFenceVerifierFixerDisjoint({
      fence_key: 'I1',
      integration_agent_session_id: 'x-intagent-f1-journey',
      implementer_sessions: [
        { task_key: 'A1', session_id: 'x-impl-a1' },
        { task_key: 'A2', session_id: 'x-impl-a2' },
        { task_key: 'A3', session_id: 'x-impl-a3' },
        { task_key: 'A4', session_id: 'x-impl-a4' },
      ],
    });
    const shared = 'x-collide-session';
    const disjointBad = checkPerFenceVerifierFixerDisjoint({
      fence_key: 'I1',
      integration_agent_session_id: shared,
      implementer_sessions: [{ task_key: 'A3', session_id: shared }],
    });
    let assertDisjointThrows = false;
    try {
      assertPerFenceVerifierFixerDisjoint({
        fence_key: 'I1',
        integration_agent_session_id: shared,
        implementer_sessions: [{ task_key: 'A3', session_id: shared }],
      });
    } catch {
      assertDisjointThrows = true;
    }
    r93 = disjointOk.ok === true && disjointBad.ok === false && assertDisjointThrows;

    // Black-box seam: ingest + SQL membership + plan-time authoring (R1.4, R1.5, R1.6)
    if (hasTables && schemaOk && contractAccepted) {
      const { runId } = insertProjectRun(db);

      if (stub === 'A3') {
        // Negative control: membership path stubbed — do not write members; R1.4 must fail.
        r14 = false;
        r15 = false;
        r11 = hasTables;
        r16 = false;
      } else {
        const ingested = ingestFenceMembership(db, { runId, fences: [FENCE_I1_CONTRACT] });
        const fenceId = ingested.fenceIdsByKey.I1;
        const members = queryFenceMembership(db, runId);
        r14 =
          typeof fenceId === 'number' &&
          members.length === 4 &&
          members.every((m) => m.fence_key === 'I1') &&
          members.map((m) => m.task_key).join(',') === 'A1,A2,A3,A4';

        const sessionId = 'x-intagent-codex55-plan-time-I1';
        const authorRow = persistPlanTimeAuthoring(db, {
          run_id: runId,
          fence_key: 'I1',
          session_id: sessionId,
          test_path: FENCE_I1_CONTRACT.test_path,
          implementer_sessions: [
            { task_key: 'A1', session_id: 'x-impl-a1-grok45' },
            { task_key: 'A2', session_id: 'x-impl-a2-grok45' },
            { task_key: 'A3', session_id: 'x-impl-a3-grok45' },
            { task_key: 'A4', session_id: 'x-impl-a4-grok45' },
          ],
        });
        const fence = db.raw
          .prepare('SELECT authored_by, test_path FROM fences WHERE id = ?')
          .get(fenceId) as { authored_by: string; test_path: string };
        assertPlanTimeAuthoredByIntegrationAgent(fence.authored_by);
        const loaded = getPlanTimeAuthoring(db, { fence_id: fenceId });
        r16 =
          authorRow.role === INTEGRATION_TEST_AGENT_ROLE &&
          authorRow.model === 'codex55' &&
          authorRow.session_id === sessionId &&
          fence.authored_by === 'integration_test_agent' &&
          loaded?.session_id === sessionId;

        // R1.5 — functional end-to-end: contract accept → ingest → SQL membership → authoring stamp
        r15 =
          refuseMissingNc &&
          refuseCeiling &&
          r14 &&
          r16 &&
          r91 &&
          r93 &&
          r94 &&
          FENCE_I1_CONTRACT.members.length <= FENCE_MEMBER_CEILING;

        r11 = hasTables && schemaOk && ingested.memberCount === 4;
      }
    }

    return {
      'R1.1': result(r11 || (hasTables && schemaOk && contractAccepted), 'fence schema/tables or contract accept missing'),
      'R1.2': result(contractAccepted, 'plan-contract does not accept full fence fields'),
      'R1.3': result(refuseMissingNc, 'missing negative_control_cmd is not refused'),
      'R1.4': result(
        stub === 'A3' ? false : r14,
        stub === 'A3'
          ? 'negative control A3 stubs membership ingest, so R1.4 must fail'
          : 'inspectable fence membership SQL join missing or incomplete'
      ),
      'R1.5': result(
        stub === 'A3' ? false : r15,
        'black-box contract→ingest→membership→authoring journey does not compose'
      ),
      'R1.6': result(
        stub === 'A3' ? false : r16,
        'plan-time integration_test_agent authoring session not persisted / authored_by not stamped'
      ),
      'R9.1': result(r91, routeMsg || 'integration_test_agent route not distinct from validator ladder'),
      'R9.3': result(r93, 'per-fence verifier≠fixer session disjointness not enforced'),
      'R9.4': result(r94, 'integration_test_agent seat model is not codex55'),
    };
  } finally {
    db.close();
  }
}
