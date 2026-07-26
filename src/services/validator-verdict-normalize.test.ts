import { describe, it, expect } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeValidatorVerdict,
  deriveDefectClass,
  isSubstantiveValidatorDiagnosis,
  PREFERRED_DEFECT_CLASSES,
} from './run-artifact-service.js';
import { parseCallbackLine } from './agent-event-ingest.js';
import { OrchestratorLoop } from './orchestrator-loop.js';
import type { ITransport } from './fake-transport.js';

// The exact leg-9 / Gate C fixture (sol-legC-defectclass-findings.md §5). The callbacks parser strips the
// "FAIL —" prefix; `LEG_NOTE` is the note the role boundary actually normalizes.
const LEG_CALLBACK = '[helm callback] validator batch-C STATUS: FAIL — LEG9T1 requirements NOT met: retry-gate.txt missing; node test.js exits 1; test reports "missing"';
const LEG_NOTE = 'LEG9T1 requirements NOT met: retry-gate.txt missing; node test.js exits 1; test reports "missing"';

describe('normalizeValidatorVerdict — A: diagnosis preservation (Gate C leg-9)', () => {
  it('the leg-9 FAIL fixture becomes a classified missing-artifact FAIL with the diagnosis preserved byte-for-byte', () => {
    const parsed = parseCallbackLine(LEG_CALLBACK);
    expect(parsed).toBeTruthy();
    expect(parsed!.state).toBe('FAIL');
    expect(parsed!.note).toBe(LEG_NOTE);

    const norm = normalizeValidatorVerdict(parsed!.state, parsed!.note);
    expect(norm.state).toBe('FAIL');
    expect(norm.defectClass).toBe('missing-artifact');
    expect(norm.classificationSource).toBe('derived');
    // Original diagnosis preserved byte-for-byte; ONLY appended Helm metadata.
    expect(norm.note).toBe(`${LEG_NOTE} [HELM classification: derived defect_class=missing-artifact; validator omitted defect_class]`);
    expect(norm.note!.startsWith(LEG_NOTE)).toBe(true);
    expect(norm.note).toContain('retry-gate.txt missing');
    expect(norm.note).toContain('node test.js exits 1');
    // The pre-fix protocol-only replacement string is NEVER produced.
    expect(norm.note).not.toBe('PROTOCOL-DEFECT: validator FAIL requires defect_class');
  });
});

describe('normalizeValidatorVerdict — table tests (findings §2/§5)', () => {
  it('exact PASS stays PASS (no prose-sentiment classifier)', () => {
    const n = normalizeValidatorVerdict('PASS', 'matrix: REQ-1 VERIFIED, REQ-2 VERIFIED');
    expect(n).toMatchObject({ state: 'PASS', defectClass: null, classificationSource: 'none' });
    expect(n.note).toBe('matrix: REQ-1 VERIFIED, REQ-2 VERIFIED');
  });

  it('an explicit FAIL whose note says PASS still remains FAIL (structured state wins)', () => {
    const n = normalizeValidatorVerdict('FAIL', 'defect_class=test-failure; note mentions PASS but tests fail');
    expect(n.state).toBe('FAIL');
    expect(n.defectClass).toBe('test-failure');
    expect(n.escalateFlag).toBe(false);
  });

  it('only defect_class=implementer-incapable raises the explicit escalation modifier', () => {
    const flagged = normalizeValidatorVerdict(
      'FAIL',
      'defect_class=implementer-incapable; the same state-transition defect recurred after three corrections',
    );
    expect(flagged).toMatchObject({
      state: 'FAIL',
      defectClass: 'implementer-incapable',
      escalateFlag: true,
      planDefectFlag: false,
      classificationSource: 'declared',
    });
    expect(flagged.note).toContain('same state-transition defect recurred');
  });

  it('defect_class=plan-defect sets planDefectFlag (ordinary FAIL does not)', () => {
    const planDef = normalizeValidatorVerdict(
      'FAIL',
      'defect_class=plan-defect; validation_criteria contradict atomic_work (impossible as written)',
    );
    expect(planDef).toMatchObject({
      state: 'FAIL',
      defectClass: 'plan-defect',
      escalateFlag: false,
      planDefectFlag: true,
      classificationSource: 'declared',
    });
    const ordinary = normalizeValidatorVerdict(
      'FAIL',
      'defect_class=behavior-mismatch; missing null guard on save()',
    );
    expect(ordinary).toMatchObject({
      state: 'FAIL',
      defectClass: 'behavior-mismatch',
      escalateFlag: false,
      planDefectFlag: false,
    });
  });

  it('explicit declared class is preserved verbatim (even outside the preferred enum)', () => {
    const n = normalizeValidatorVerdict('FAIL', 'defect_class=weird-custom-token; something off');
    expect(n).toMatchObject({ state: 'FAIL', defectClass: 'weird-custom-token', classificationSource: 'declared' });
    expect(n.note).toBe('defect_class=weird-custom-token; something off'); // verbatim, no annotation
  });

  it('test-only note derives test-failure', () => {
    const n = normalizeValidatorVerdict('FAIL', 'unit tests fail: assertion error, node test.js exits 1');
    expect(n).toMatchObject({ state: 'FAIL', defectClass: 'test-failure', classificationSource: 'derived' });
  });

  it('requirement-only note derives requirements-gap', () => {
    const n = normalizeValidatorVerdict('FAIL', 'requirement LEG9T1 is not met by the current behavior');
    expect(n).toMatchObject({ state: 'FAIL', defectClass: 'requirements-gap' });
  });

  it('build/compile note derives build-failure', () => {
    const n = normalizeValidatorVerdict('FAIL', 'the project does not compile: typecheck errors in module');
    expect(n).toMatchObject({ state: 'FAIL', defectClass: 'build-failure' });
  });

  it('substantive but unmatched note falls back to validator-reported-defect', () => {
    const n = normalizeValidatorVerdict('FAIL', 'the sidebar still uses stale placeholder copy');
    expect(n).toMatchObject({ state: 'FAIL', defectClass: 'validator-reported-defect', classificationSource: 'derived' });
    expect(n.note).toContain('the sidebar still uses stale placeholder copy');
  });

  it.each([
    ['null', null],
    ['empty', ''],
    ['single-token', 'missing'],
    ['boilerplate token', 'error'],
    ['n/a template', 'n/a'],
    ['reason template', '<reason>'],
    ['gaps template', '<gaps listed by req>'],
  ])('non-substantive note (%s) becomes BLOCKED / protocol-defect and keeps the original text', (_label, note) => {
    const n = normalizeValidatorVerdict('FAIL', note as any);
    expect(n.state).toBe('BLOCKED');
    expect(n.defectClass).toBe('protocol-defect');
    expect(n.classificationSource).toBe('protocol-defect');
    expect(n.note).toContain('PROTOCOL-DEFECT:');
    const expectedMarker = (note ?? '').trim() === '' ? '<empty>' : String(note).trim();
    expect(n.note).toContain(`original: ${expectedMarker}`);
  });

  it.each([
    'aborted: could not reach the repo checkout',
    'validation aborted — no runtime available',
    'unable to validate: authentication required for the deploy host',
    'could not inspect the project files (no access)',
  ])('inability/aborted note becomes BLOCKED (not a requirement failure): %s', (note) => {
    const n = normalizeValidatorVerdict('FAIL', note);
    expect(n.state).toBe('BLOCKED');
    expect(n.defectClass).toBe('protocol-defect');
    expect(n.note).toContain('inability-to-validate');
    expect(isSubstantiveValidatorDiagnosis(note)).toBe(false);
  });

  it('missing-artifact precedes its secondary test-failure/requirements evidence (first-match-wins order)', () => {
    // Same shape as the live note: missing + exit-code + requirement language all present → missing-artifact.
    expect(deriveDefectClass(LEG_NOTE)).toBe('missing-artifact');
  });

  it('a non-FAIL/non-PASS terminal (BLOCKED) passes through untouched', () => {
    const n = normalizeValidatorVerdict('BLOCKED', 'cannot proceed: dependency X unavailable');
    expect(n).toMatchObject({ state: 'BLOCKED', defectClass: null, classificationSource: 'none' });
    expect(n.note).toBe('cannot proceed: dependency X unavailable');
  });
});

describe('parse boundary — malformed / wrong-state callbacks never reach normalization', () => {
  it('malformed lines and unknown states do not parse (so they cannot enter the normalizer)', () => {
    expect(parseCallbackLine('this is not a callback line')).toBeNull();
    expect(parseCallbackLine('[helm callback] validator batch-C STATUS: NONSENSE — whatever')).toBeNull();
    expect(parseCallbackLine('')).toBeNull();
  });

  it('a well-formed FAIL parses with the note the normalizer will classify', () => {
    const parsed = parseCallbackLine(LEG_CALLBACK);
    expect(parsed).toMatchObject({ role: 'validator', batchId: 'batch-C', state: 'FAIL' });
  });
});

describe('B1 — requirements-aware validator instruction (vInstr) is enum + example guidance only', () => {
  // Minimal ITransport stub — the vInstr method is pure (no spawn/reap), so we avoid the FakeTransport
  // USE_FAKE_TMUX guard and any real-path coupling entirely.
  const stubTransport: ITransport = {
    spawn: async () => ({ handle: 'stub', role: 'validator' }),
    reap: async () => {},
  };
  function makeLoop(): OrchestratorLoop {
    return new OrchestratorLoop(stubTransport, {
      runDir: path.join(os.tmpdir(), `helm-b1-vinstr-${Date.now()}-${Math.random().toString(36).slice(2)}`),
      batchId: 'batch-B1',
    });
  }

  it('contains the exact preferred enum, the copyable example, PASS as the only success terminal, and no DONE verdict', () => {
    const loop = makeLoop();
    const vInstr: string = (loop as any).requirementsValidatorInstruction('NORTH-STAR TEXT', 'TASK CONTRACT TEXT');

    // Exact preferred enum (post-fix). Pre-fix only offered `defect_class=<non-empty-token>` with no enum.
    expect(vInstr).toContain('implementer-incapable | plan-defect | missing-artifact | test-failure | build-failure | regression | requirements-gap | behavior-mismatch | other');
    expect(PREFERRED_DEFECT_CLASSES.join(' | ')).toBe('implementer-incapable | plan-defect | missing-artifact | test-failure | build-failure | regression | requirements-gap | behavior-mismatch | other');

    // The exact copyable example line (findings §5 B1).
    expect(vInstr).toContain('FAIL — defect_class=missing-artifact; Requirement LEG9T1 failed: retry-gate.txt is missing; node test.js exits 1.');

    // PASS is the only success example; DONE is explicitly NOT a valid verdict for this phase.
    expect(vInstr).toContain('PASS — <matrix of VERIFIED evidence>');
    expect(vInstr).toContain('DONE is NOT a valid verdict for this phase');
    expect(vInstr).not.toContain('STATUS: DONE');
    expect(vInstr).toContain('defect_class=implementer-incapable');
    expect(vInstr).toContain('defect_class=plan-defect');
    expect(vInstr).toContain('ordinary fixable gap');
  });
});
