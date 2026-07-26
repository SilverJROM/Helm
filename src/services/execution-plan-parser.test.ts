import { describe, it, expect } from 'vitest';
import { parseExecutionPlan, classifyAssignee, EXECUTION_PLAN_ROLE_LABELS } from './execution-plan-parser.js';

const VALID_TASK = {
  id: 'B3-T04',
  batch: 'B3',
  title: 'Validate execution_plan.md parses into helm-algo task rows on save',
  req_refs: ['R-D2', 'R-D3'],
  assignee: 'grok-composer',
  validator_lane: 'L1',
  effort: 'med',
  type: 'feature'
};

function wrapJson(tasks: unknown[]): string {
  return `# Execution Plan\n\n\`\`\`json\n${JSON.stringify(tasks, null, 2)}\n\`\`\`\n`;
}

describe('B3-T04: parseExecutionPlan', () => {
  it('parses a fenced json task array with required fields', () => {
    const result = parseExecutionPlan(wrapJson([VALID_TASK]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].id).toBe('B3-T04');
      expect(result.tasks[0].req_refs).toEqual(['R-D2', 'R-D3']);
    }
  });

  it('rejects markdown with no fenced json block', () => {
    const result = parseExecutionPlan('# Plan\n\nNo json here.\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/no fenced/i);
  });

  it('rejects invalid JSON inside the fence', () => {
    const result = parseExecutionPlan('# Plan\n\n```json\n[{bad json}\n```\n');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors[0]).toMatch(/invalid JSON/i);
  });

  it('rejects a task missing assignee with a per-task error', () => {
    const { assignee: _omit, ...missingAssignee } = VALID_TASK;
    const result = parseExecutionPlan(wrapJson([missingAssignee]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /missing required field 'assignee'/i.test(e))).toBe(true);
      expect(result.errors.some((e) => /B3-T04/.test(e))).toBe(true);
    }
  });

  it('rejects a task missing validator_lane with a per-task error', () => {
    const { validator_lane: _omit, ...missingValidatorLane } = VALID_TASK;
    const result = parseExecutionPlan(wrapJson([missingValidatorLane]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((e) => /missing required field 'validator_lane'/i.test(e))).toBe(true);
      expect(result.errors.some((e) => /B3-T04/.test(e))).toBe(true);
    }
  });

  it('rejects req_refs that is not an array (and not a coercible bare string)', () => {
    // A number (or object / non-string-array) is still a hard reject — only an unambiguous bare STRING coerces.
    const bad = { ...VALID_TASK, req_refs: 42 as unknown as string[] };
    const result = parseExecutionPlan(wrapJson([bad]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => /req_refs.*array/i.test(e))).toBe(true);

    // an array containing a non-string is still rejected
    const badArr = { ...VALID_TASK, req_refs: ['R-1', 7] as unknown as string[] };
    const r2 = parseExecutionPlan(wrapJson([badArr]));
    expect(r2.ok).toBe(false);
  });

  // cards2 plan-schema fault (2026-07-17): light models emit type-variant field values. The parser now
  // coerces the UNAMBIGUOUS variants in place so the plan validates (doc.valid → Start Implementation enabled)
  // and ingest carries the coerced shape, while genuinely-invalid values still throw.
  it('coerces a single bare-string req_ref to a 1-element string array', () => {
    const one = { ...VALID_TASK, req_refs: 'R-D2' as unknown as string[] };
    const result = parseExecutionPlan(wrapJson([one]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.tasks[0].req_refs).toEqual(['R-D2']);
  });

  it('coerces a NUMERIC batch to a non-empty string (the live cards2 reject → button-enable path)', () => {
    // The live plan wrote `"batch": 1..5` (numbers) → previously `field 'batch' must be a non-empty string`.
    const numeric = { ...VALID_TASK, batch: 1 as unknown as string };
    const result = parseExecutionPlan(wrapJson([numeric]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.tasks[0].batch).toBe('1');
      expect(typeof result.tasks[0].batch).toBe('string');
    }
    // a whole mixed-numeric-batch plan (1..5) validates
    const many = [1, 1, 2, 3, 5].map((b, i) => ({ ...VALID_TASK, id: `T0${i + 1}`, batch: b as unknown as string }));
    const rMany = parseExecutionPlan(wrapJson(many));
    expect(rMany.ok).toBe(true);
    if (rMany.ok) expect(rMany.tasks.map((t) => t.batch)).toEqual(['1', '1', '2', '3', '5']);
  });

  it('a STRING batch still validates unchanged; empty-string and null batch still reject', () => {
    // string batch (the previously-passing shape) unchanged
    expect(parseExecutionPlan(wrapJson([{ ...VALID_TASK, batch: 'B1' }])).ok).toBe(true);
    // empty string → still a hard reject (non-empty required)
    const empty = parseExecutionPlan(wrapJson([{ ...VALID_TASK, batch: '' }]));
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.errors.some((e) => /field 'batch' must be a non-empty string/.test(e))).toBe(true);
    // null → treated as missing required field
    const nul = parseExecutionPlan(wrapJson([{ ...VALID_TASK, batch: null as unknown as string }]));
    expect(nul.ok).toBe(false);
    if (!nul.ok) expect(nul.errors.some((e) => /missing required field 'batch'/.test(e))).toBe(true);
    // non-finite number (NaN serializes to JSON null → missing) and boolean batch still reject
    expect(parseExecutionPlan(wrapJson([{ ...VALID_TASK, batch: true as unknown as string }])).ok).toBe(false);
  });

  // sol send-back #2 (2026-07-17): numeric→string coercion is an ALLOWLIST of ONLY `batch`. Every OTHER scalar
  // field emitted as a number is REJECTED at validation (not coerced), because coercing them created UI↔ingest
  // divergence (numeric effort passed validation then threw at ingest; numeric assignee/type were silently
  // reinterpreted). doc.valid must never be true for a plan ingestion would reject or reinterpret.
  it('does NOT coerce numeric effort/type/assignee/validator_lane/id — each is rejected at validation', () => {
    for (const field of ['effort', 'type', 'assignee', 'validator_lane', 'id'] as const) {
      const bad = { ...VALID_TASK, [field]: 2 as unknown as string };
      const r = parseExecutionPlan(wrapJson([bad]));
      expect(r.ok, `numeric ${field} must reject`).toBe(false);
    }
    // only batch coerces from a number
    expect(parseExecutionPlan(wrapJson([{ ...VALID_TASK, batch: 2 as unknown as string }])).ok).toBe(true);
  });

  it('rejects an out-of-enum effort STRING (unified with ingest — no valid-but-ingest-throws)', () => {
    for (const bad of ['banana', 'm', 'sizeXXL']) {
      const r = parseExecutionPlan(wrapJson([{ ...VALID_TASK, effort: bad }]));
      expect(r.ok, `effort '${bad}' must reject at validation`).toBe(false);
      if (!r.ok) expect(r.errors.some((e) => /invalid effort/.test(e))).toBe(true);
    }
    // valid enum + aliases (incl. case-aware T-shirt) still validate
    for (const good of ['low', 'med', 'high', 'xhigh', 'S', 'M', 'L', 'XL', 'medium', 'L1-routine']) {
      expect(parseExecutionPlan(wrapJson([{ ...VALID_TASK, effort: good }])).ok, `effort '${good}' must validate`).toBe(true);
    }
  });

  // shakedown-4 (2026-07-17) + B6a (2026-07-22): L4 is now in-domain (→ rung 3). Out-of-range = L0/L5+.
  it('shakedown-4: rejects out-of-range lanes (L0/L5/Ln) for assignee AND validator_lane; L4 accepted', () => {
    for (const bad of ['L0', 'L5', 'L12']) {
      expect(parseExecutionPlan(wrapJson([{ ...VALID_TASK, assignee: bad }])).ok, `assignee ${bad}`).toBe(false);
      expect(parseExecutionPlan(wrapJson([{ ...VALID_TASK, validator_lane: bad }])).ok, `validator_lane ${bad}`).toBe(false);
    }
    // L1/L2/L3/L4 valid on both fields (B6a)
    for (const good of ['L1', 'L2', 'L3', 'L4', 'l4']) {
      expect(parseExecutionPlan(wrapJson([{ ...VALID_TASK, assignee: good, validator_lane: good }])).ok, `lane ${good}`).toBe(true);
    }
  });

  // shakedown-5 (2026-07-17): TERMINAL. The classifier has only TWO accept kinds — 'rung' and 'model' — both
  // fully persisted. There is NO 'binding' accept-branch, so no accepted execution-plan assignee/validator_lane
  // can be dropped. Every label in EXECUTION_PLAN_ROLE_LABELS is REJECTED (previously accepted-as-binding
  // then persisted with no rung/model — the same accept-yet-drop class as L4, one branch over).
  it('shakedown-5: all final role labels are rejected as assignee AND validator_lane', () => {
    expect(EXECUTION_PLAN_ROLE_LABELS.length).toBe(22);
    for (const label of EXECUTION_PLAN_ROLE_LABELS) {
      expect(classifyAssignee(label).ok, `classify ${label}`).toBe(false);
      expect(parseExecutionPlan(wrapJson([{ ...VALID_TASK, assignee: label }])).ok, `assignee ${label}`).toBe(false);
      expect(parseExecutionPlan(wrapJson([{ ...VALID_TASK, validator_lane: label }])).ok, `validator_lane ${label}`).toBe(false);
    }
  });

  it('shakedown-5: EXHAUSTIVE — every ACCEPTED assignee/validator_lane kind is rung or model, each carrying a concrete value', () => {
    // L1/L2/L3/L4 → a concrete rung (B6a: L4→3)
    const expectRung: Record<string, 0 | 1 | 2 | 3> = { L1: 0, L2: 1, L3: 2, L4: 3, 'L1-routine': 0, 'l3': 2, 'l4': 3 };
    for (const [v, rung] of Object.entries(expectRung)) {
      const c = classifyAssignee(v);
      expect(c.ok && c.kind === 'rung' && c.rung === rung, `${v} → rung ${rung}`).toBe(true);
    }
    // model families + a general letter-initial slug → a concrete model
    for (const m of ['sonnet', 'opus', 'claude-sonnet-5', 'grok', 'grok-4.5', 'grok-composer', 'terra', 'gpt-5.5-codex-spark']) {
      const c = classifyAssignee(m);
      expect(c.ok && c.kind === 'model' && typeof c.model === 'string' && c.model.length > 0, `${m} → model`).toBe(true);
    }
    // TERMINAL INVARIANT: every ok result is rung|model AND carries its value — no accepted value is empty/unpersistable
    for (const v of ['L1', 'L2', 'L3', 'L4', 'sonnet', 'terra', 'grok-4.5', 'claude-sonnet-5', 'grok-composer']) {
      const c = classifyAssignee(v);
      expect(c.ok, `${v} accepted`).toBe(true);
      if (c.ok) {
        const fullyRepresentable = (c.kind === 'rung' && c.rung != null) || (c.kind === 'model' && !!c.model);
        expect(fullyRepresentable, `${v}: accepted ⟹ carries a concrete rung or model`).toBe(true);
      }
    }
    // out-of-range lanes + role labels + bare-numeric + empty → rejected (L4 is now valid)
    for (const bad of ['L0', 'L5', 'L12', 'validator', 'implementer', '2', '']) {
      expect(classifyAssignee(bad).ok, `${bad} rejected`).toBe(false);
    }
  });

  it('validates deps as string refs to KNOWN ids — dangling/numeric/non-array deps are rejected (never silently dropped)', () => {
    const two = (deps: unknown) => wrapJson([
      { ...VALID_TASK, id: 'T01' },
      { ...VALID_TASK, id: 'T02', deps },
    ]);
    // known id → valid
    expect(parseExecutionPlan(two(['T01'])).ok).toBe(true);
    // dangling → reject
    const dangling = parseExecutionPlan(two(['MISSING']));
    expect(dangling.ok).toBe(false);
    if (!dangling.ok) expect(dangling.errors.some((e) => /unknown task id|dangling/i.test(e))).toBe(true);
    // numeric dep → reject
    expect(parseExecutionPlan(two([1])).ok).toBe(false);
    // empty-string dep → reject
    expect(parseExecutionPlan(two([''])).ok).toBe(false);
    // deps not an array → reject
    const notArr = parseExecutionPlan(two('T01'));
    expect(notArr.ok).toBe(false);
    if (!notArr.ok) expect(notArr.errors.some((e) => /deps.*array/i.test(e))).toBe(true);
    // absent deps → fine (optional)
    expect(parseExecutionPlan(wrapJson([{ ...VALID_TASK, id: 'T01' }])).ok).toBe(true);
  });
});
