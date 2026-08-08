/**
 * Negative control mapping: FENCE_STUB=C2 forces R4.3 to fail through the negative-control CLOSE path.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createFenceReportRecorder } from './fence-report-emit.js';

const ACCEPTANCE_IDS = ['R4.1', 'R4.2', 'R4.3', 'R4.4', 'R6.4', 'R7.1', 'R7.2', 'R7.3', 'R9.2'] as const;
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
    return typeof mod.runF3CloseJourney === 'function'
      ? (mod.runF3CloseJourney as (input: Record<string, unknown>) => Promise<Partial<Record<string, boolean | AssertionResult>>>)
      : null;
  } catch {
    return null;
  }
}

function result(ok: boolean, message: string): AssertionResult {
  return { ok, message };
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
        fence: 'I3',
        stub,
        dbPath: process.env.HELM_DB_PATH,
        contractPath: path.join(process.cwd(), 'plan/fence-workflow-upgrade/fence-contract.json'),
      })
    );
  }

  const haveProductSurface = [
    'src/services/fence-close-locked-test.ts',
    'src/services/fence-close-mechanical.ts',
    'src/services/fence-verdict.ts',
    'src/services/fence-close-seats.ts',
  ].every((p) => fs.existsSync(path.join(process.cwd(), p)));

  const base: AssertionMap = {
    'R4.1': result(false, 'same locked test, OPEN-id pass, and NC red CLOSE checks are absent'),
    'R4.2': result(false, 'clean CLOSE zero-seat behavior is not observable yet'),
    'R4.3': result(false, 'negative control does not yet prove a different named assertion at CLOSE'),
    'R4.4': result(false, 'non-clean CLOSE is not routed to integration_test_agent yet'),
    'R6.4': result(haveProductSurface, 'fence verdict does not interoperate with NormalizedValidatorVerdict yet'),
    'R7.1': result(false, 'strict fence verdict fields are not emitted yet'),
    'R7.2': result(false, 'missing verdict field fail-closed behavior is absent'),
    'R7.3': result(false, 'composition verdict ownership is not integration_test_agent-owned yet'),
    'R9.2': result(false, 'clean/non-clean close seat routing is not proven yet'),
  };

  if (stub === 'C2') {
    base['R4.3'] = result(false, 'negative control C2 stubs CLOSE NC behavior, so R4.3 must fail');
  }
  return base;
}

describe('F3/I3 plan-time fence journey: CLOSE and verdict', async () => {
  const assertions = await evaluate();

  for (const id of ACCEPTANCE_IDS) {
    it(`${id} is satisfied by the real F3 product journey`, () => {
      const assertion = assertions[id];
      if (assertion.ok) recorder.pass(id);
      else recorder.fail(id, 'assert');
      expect(assertion.ok, assertion.message).toBe(true);
    });
  }
});
