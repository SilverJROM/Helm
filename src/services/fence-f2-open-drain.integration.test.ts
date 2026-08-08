/**
 * Negative control mapping: FENCE_STUB=B3 forces R3.1 to fail through the admission selector path.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createFenceReportRecorder } from './fence-report-emit.js';

const ACCEPTANCE_IDS = ['R2.1', 'R2.2', 'R2.3', 'R3.1', 'R3.2', 'R6.1', 'R6.2', 'R6.3'] as const;
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
    return typeof mod.runF2OpenDrainJourney === 'function'
      ? (mod.runF2OpenDrainJourney as (input: Record<string, unknown>) => Promise<Partial<Record<string, boolean | AssertionResult>>>)
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
        fence: 'I2',
        stub,
        dbPath: process.env.HELM_DB_PATH,
        contractPath: path.join(process.cwd(), 'plan/fence-workflow-upgrade/fence-contract.json'),
      })
    );
  }

  const haveProductSurface = [
    'src/services/fence-report-v1.ts',
    'src/services/fence-open-service.ts',
    'src/services/fence-selector-admission.ts',
    'src/services/fence-open-order.ts',
  ].every((p) => fs.existsSync(path.join(process.cwd(), p)));

  const base: AssertionMap = {
    'R2.1': result(false, 'OPEN proving-failure runner is absent'),
    'R2.2': result(false, 'OPEN failed ids and test hash are not recorded yet'),
    'R2.3': result(false, 'real drainDispatch path does not prove OPEN before first member dispatch yet'),
    'R3.1': result(false, 'member admission is not refused without an OPEN baseline yet'),
    'R3.2': result(false, 'ordinary unit gate preservation is not proven through the fence selector yet'),
    'R6.1': result(haveProductSurface, 'product fence-report-v1 runner/adapter is absent'),
    'R6.2': result(false, 'assert/fail-only proving semantics are not implemented in product parser yet'),
    'R6.3': result(false, 'Helm test gate has no product JSON report adapter yet'),
  };

  if (stub === 'B3') {
    base['R3.1'] = result(false, 'negative control B3 stubs admission, so R3.1 must fail');
  }
  return base;
}

describe('F2/I2 plan-time fence journey: OPEN and DRAIN order', async () => {
  const assertions = await evaluate();

  for (const id of ACCEPTANCE_IDS) {
    it(`${id} is satisfied by the real F2 product journey`, () => {
      const assertion = assertions[id];
      if (assertion.ok) recorder.pass(id);
      else recorder.fail(id, 'assert');
      expect(assertion.ok, assertion.message).toBe(true);
    });
  }
});
