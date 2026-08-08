/**
 * Negative control mapping: FENCE_STUB=R2 forces R5.2 to fail through the repair hash-lock path.
 */
import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createFenceReportRecorder } from './fence-report-emit.js';

const ACCEPTANCE_IDS = ['R5.1', 'R5.2', 'R5.3', 'R5.4', 'R5.5', 'R8.1'] as const;
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
    return typeof mod.runF4RepairJourney === 'function'
      ? (mod.runF4RepairJourney as (input: Record<string, unknown>) => Promise<Partial<Record<string, boolean | AssertionResult>>>)
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
        fence: 'I4',
        stub,
        dbPath: process.env.HELM_DB_PATH,
        contractPath: path.join(process.cwd(), 'plan/fence-workflow-upgrade/fence-contract.json'),
      })
    );
  }

  const haveProductSurface = [
    'src/services/fence-repair-schema.ts',
    'src/services/fence-repair-hashlock.ts',
    'src/services/fence-repair-requeue.ts',
    'src/services/fence-repair-routing.ts',
    'src/services/fence-repair-resume-adapter.ts',
  ].every((p) => fs.existsSync(path.join(process.cwd(), p)));

  const base: AssertionMap = {
    'R5.1': result(false, 'repair round localization and validator-authored unit tests are absent'),
    'R5.2': result(false, 'repair test collection, named red assertion, and hash lock are absent'),
    'R5.3': result(false, 'implementer iteration against validator-owned locked test is absent'),
    'R5.4': result(false, 'plan_defect/fingerprint/PLAN_SOUND repair routing is absent'),
    'R5.5': result(false, 'fresh-process repair resume path is absent'),
    'R8.1': result(haveProductSurface, 'dogfooded F4 repair fence cannot run through real product seams yet'),
  };

  if (stub === 'R2') {
    base['R5.2'] = result(false, 'negative control R2 stubs repair hash-lock, so R5.2 must fail');
  }
  return base;
}

describe('F4/I4 plan-time fence journey: REPAIR and fresh-process resume', async () => {
  const assertions = await evaluate();

  for (const id of ACCEPTANCE_IDS) {
    it(`${id} is satisfied by the real F4 product journey`, () => {
      const assertion = assertions[id];
      if (assertion.ok) recorder.pass(id);
      else recorder.fail(id, 'assert');
      expect(assertion.ok, assertion.message).toBe(true);
    });
  }
});
