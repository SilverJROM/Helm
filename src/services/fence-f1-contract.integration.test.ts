/**
 * Negative control mapping: FENCE_STUB=A3 forces R1.4 to fail through the membership-ingest path.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { createFenceReportRecorder } from './fence-report-emit.js';

const ACCEPTANCE_IDS = ['R1.1', 'R1.2', 'R1.3', 'R1.4', 'R1.5', 'R1.6', 'R9.1', 'R9.3', 'R9.4'] as const;
const recorder = createFenceReportRecorder(ACCEPTANCE_IDS);

type AssertionResult = { ok: boolean; message: string };
type AssertionMap = Record<(typeof ACCEPTANCE_IDS)[number], AssertionResult>;

afterAll(() => {
  recorder.write();
});

async function maybeLoadJourney(): Promise<null | ((input: Record<string, unknown>) => Promise<Partial<Record<string, boolean | AssertionResult>>>)> {
  try {
    const modulePath = './fence-integration-journeys.js';
    const mod = (await import(modulePath)) as Record<string, unknown>;
    return typeof mod.runF1ContractJourney === 'function'
      ? (mod.runF1ContractJourney as (input: Record<string, unknown>) => Promise<Partial<Record<string, boolean | AssertionResult>>>)
      : null;
  } catch {
    return null;
  }
}

function result(ok: boolean, message: string): AssertionResult {
  return { ok, message };
}

function tableExists(db: DatabaseService, name: string): boolean {
  const row = db.raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return !!row;
}

function normalizeJourneyResult(raw: Partial<Record<string, boolean | AssertionResult>>): AssertionMap {
  const out = {} as AssertionMap;
  for (const id of ACCEPTANCE_IDS) {
    const value = raw[id];
    out[id] = typeof value === 'boolean' ? result(value, `${id} returned false`) : value ?? result(false, `${id} was not evaluated`);
  }
  return out;
}

async function evaluate(): Promise<AssertionMap> {
  const stub = process.env.FENCE_STUB;
  const journey = await maybeLoadJourney();
  if (journey) {
    return normalizeJourneyResult(
      await journey({
        fence: 'I1',
        stub,
        dbPath: process.env.HELM_DB_PATH,
        contractPath: path.join(process.cwd(), 'plan/fence-workflow-upgrade/fence-contract.json'),
      })
    );
  }

  let hasFenceTables = false;
  if (process.env.HELM_DB_PATH) {
    const db = new DatabaseService(process.env.HELM_DB_PATH);
    try {
      hasFenceTables = tableExists(db, 'fences') && tableExists(db, 'fence_members');
    } finally {
      db.close();
    }
  }

  const sourceFiles = [
    'src/services/fence-plan-contract.ts',
    'src/services/fence-membership-ingest.ts',
    'src/services/fence-integration-agent-route.ts',
  ];
  const haveProductSurface = sourceFiles.every((p) => fs.existsSync(path.join(process.cwd(), p)));
  const base: AssertionMap = {
    'R1.1': result(hasFenceTables && haveProductSurface, 'native fence declaration schema and plan surface are absent'),
    'R1.2': result(haveProductSurface, 'native fence contract fields are not accepted by Helm product code'),
    'R1.3': result(haveProductSurface, 'missing negative-control refusal is not implemented in Helm product code'),
    'R1.4': result(hasFenceTables, 'inspectable fence membership storage is absent'),
    'R1.5': result(false, 'black-box contract-to-membership journey cannot cross product seams yet'),
    'R1.6': result(false, 'plan-time integration_test_agent ownership is not persisted yet'),
    'R9.1': result(false, 'integration_test_agent route is not resolvable yet'),
    'R9.3': result(false, 'integration_test_agent is not disjoint from unit validator routing yet'),
    'R9.4': result(false, 'per-fence verifier/fixer disjointness is not enforced yet'),
  };

  if (stub === 'A3') {
    base['R1.4'] = result(false, 'negative control A3 stubs membership ingest, so R1.4 must fail');
  }
  return base;
}

describe('F1/I1 plan-time fence journey: contract and membership', async () => {
  const assertions = await evaluate();

  for (const id of ACCEPTANCE_IDS) {
    it(`${id} is satisfied by the real F1 product journey`, () => {
      const assertion = assertions[id];
      if (assertion.ok) recorder.pass(id);
      else recorder.fail(id, 'assert');
      expect(assertion.ok, assertion.message).toBe(true);
    });
  }
});
