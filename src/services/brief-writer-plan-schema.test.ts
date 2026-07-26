/**
 * PLAN.MD SCHEMA CONTRACT (cards2 ingest fault, 2026-07-16): the planning brief's plan.md task schema must
 * state the EXACT accepted enum for every field the plan parser validates — otherwise the planner emits
 * out-of-enum values (e.g. T-shirt effort sizes S/M/L) that throw at ingest ("invalid effort S") and BLOCK
 * the run. This test pins the enum specs into the generated planning brief so the schema stays ingestible.
 *
 * Source of truth (must match): plan-schema.ts MACHINE_COMPLEXITIES=[low,med,high,xhigh] +
 * MACHINE_TASK_TYPES=[feature,issue]; plan-parser-service _normEffort / _laneRung lane tokens L1|L2|L3.
 */
import { describe, it, expect } from 'vitest';
import { BriefWriterService } from './brief-writer-service.js';

describe('PLAN.MD SCHEMA CONTRACT — planning brief specifies the parser-accepted enums', () => {
  const writer = new BriefWriterService();

  const planningBrief = writer.generatePlanningBrief({
    batchId: 'schema-plan',
    northStar: 'ns',
    projectDir: '/tmp/schema-project',
    callbacksFile: '/tmp/run/callbacks.md',
  });

  it('states the effort enum (low | med | high | xhigh)', () => {
    for (const v of ['low', 'med', 'high', 'xhigh']) {
      expect(planningBrief, `effort enum must list "${v}"`).toContain(v);
    }
    // must reference the field itself so the enum is anchored to `effort`
    expect(planningBrief).toContain('`effort`');
  });

  it('states the lane enum (L1 | L2 | L3) for assignee and validator_lane', () => {
    for (const v of ['`L1`', '`L2`', '`L3`']) {
      expect(planningBrief, `lane enum must list ${v}`).toContain(v);
    }
    expect(planningBrief).toContain('`assignee`');
    expect(planningBrief).toContain('`validator_lane`');
  });

  it('states the type enum (feature | issue)', () => {
    expect(planningBrief).toContain('`type`');
    expect(planningBrief).toContain('`feature`');
    expect(planningBrief).toContain('`issue`');
  });

  it('explicitly forbids out-of-enum T-shirt effort sizes (root-cause guard)', () => {
    expect(planningBrief).toContain('T-shirt');
  });

  it('pins batch as a non-empty STRING (not a bare number) — cards2 batch fault guard', () => {
    expect(planningBrief).toContain('`batch`');
    expect(planningBrief).toContain('STRING');
    // the batch line must warn against a bare number
    expect(planningBrief.toLowerCase()).toContain('not a bare number');
  });

  it('includes a COMPLETE example task with correct JSON types (batch string, req_refs array)', () => {
    // the copy-this example must show batch as a quoted string and req_refs as an array
    expect(planningBrief).toContain('"batch":"B1"');
    expect(planningBrief).toContain('"req_refs":["OPS-1"]');
    expect(planningBrief).toContain('"effort":"med"');
    expect(planningBrief).toContain('"type":"feature"');
    expect(planningBrief).toContain('"id":"T01"');
  });
});
