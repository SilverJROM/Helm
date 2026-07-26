import { describe, expect, it } from 'vitest';
import { parseBrainVerdict, validateMachinePlan, validateRevisedTaskContent } from './plan-schema.js';
describe('B00.s7 plan schema', () => { it('validates the canonical machine plan and closed brain verdict enums', () => { expect(validateMachinePlan({ tasks: [{ task_key: 'T1', atomic_work: 'x', complexity: 'low', task_type: 'feature', validation_criteria: 'x' }] }).tasks).toHaveLength(1); expect(() => validateMachinePlan({ tasks: [{ task_key: 7, atomic_work: [], complexity: 'low', task_type: 'feature', validation_criteria: [] }] })).toThrow(/canonical/); expect(parseBrainVerdict({ edge_class: 'rung-attempt-limit', route_to: 'bump-rung', blocker_owner: 'brain', reason: 'rung exhausted' })).not.toBeNull(); expect(parseBrainVerdict({ edge_class: 'bad', route_to: 'bump-rung', blocker_owner: 'brain', reason: 'x' })).toBeNull(); }); });

describe('validateRevisedTaskContent (re-plan content-only schema)', () => {
  it('accepts non-empty atomic_work + criteria string/string[]', () => {
    expect(validateRevisedTaskContent({
      atomic_work: 'do X',
      validation_criteria: 'X works',
    })).toMatchObject({ atomic_work: 'do X', validation_criteria: 'X works' });
    expect(validateRevisedTaskContent({
      atomic_work: 'do Y',
      validation_criteria: ['a', 'b'],
      req_refs: ['R1'],
    }).req_refs).toEqual(['R1']);
  });

  it('rejects empty/whitespace criteria, object-coerced criteria, empty atomic_work', () => {
    expect(() => validateRevisedTaskContent({ atomic_work: 'x', validation_criteria: '  ' })).toThrow(/validation_criteria/);
    expect(() => validateRevisedTaskContent({ atomic_work: 'x', validation_criteria: {} })).toThrow(/validation_criteria/);
    expect(() => validateRevisedTaskContent({ atomic_work: 'x', validation_criteria: [] })).toThrow(/validation_criteria/);
    expect(() => validateRevisedTaskContent({ atomic_work: '   ', validation_criteria: 'ok' })).toThrow(/atomic_work/);
  });

  it('omits req_refs when not provided (merge-dont-clobber signal)', () => {
    const v = validateRevisedTaskContent({ atomic_work: 'x', validation_criteria: 'y' });
    expect(v).not.toHaveProperty('req_refs');
  });
});
