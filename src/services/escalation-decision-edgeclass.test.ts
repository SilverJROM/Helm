// #54: the brain decides the ROUTE; Helm validates EXECUTABILITY, not vocabulary.
//
// Anchor incident (retest run 24, 2026-07-20): ibrain correctly classified a missing requirement as a
// plan defect and routed re-plan, but emitted edge_class='external-blocker' because no 'plan-defect'
// edge existed in the vocabulary. The old guard required edge_class==='validator-failure' for re-plan,
// so the decision was rejected, SILENTLY discarded, and the task deferred — the run blocked on a
// correct answer. The model's reason text even said "not implementer or validator failure", i.e. it
// refused to mislabel a working validator. The schema was wrong, not the brain.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EscalationService } from './escalation-service.js';

const svc = new EscalationService();
const decide = (o: Record<string, unknown>) => svc.parseDecision(JSON.stringify(o));

// The verbatim decision run 24 produced, modulo the now-correct edge class.
const RUN24 = {
  edge_class: 'plan-defect',
  route_to: 're-plan',
  blocker_owner: 'brain',
  reason: 'Root cause is plan defect, not implementer or validator failure. RT-2 is absent from og-requirements.',
  action: 're-plan',
  decisionId: 'dec-rt2-plan-defect-001',
  planRevisionDirective: 'Add RT-2 with an explicit normative penalty table; do not re-scope unrelated requirements.',
};

describe('#54 — re-plan is no longer gated on edge_class', () => {
  it('accepts the run-24 decision with the new plan-defect edge', () => {
    const d = decide(RUN24);
    expect(d).not.toBeNull();
    expect(d!.action).toBe('re-plan');
  });

  it('accepts re-plan under requirements-gap', () => {
    expect(decide({ ...RUN24, edge_class: 'requirements-gap' })).not.toBeNull();
  });

  it('accepts re-plan even under external-blocker — the exact pairing that was wrongly rejected', () => {
    expect(decide({ ...RUN24, edge_class: 'external-blocker' })).not.toBeNull();
  });

  it('still requires a non-empty planRevisionDirective (executability, not vocabulary)', () => {
    expect(decide({ ...RUN24, planRevisionDirective: '   ' })).toBeNull();
  });
});

describe('#54 — the one hard block that remains: no laundering a non-validator fault into PASS', () => {
  const override = {
    route_to: 'escalate-validator',
    blocker_owner: 'brain',
    reason: 'r',
    action: 'escalate-validator',
    decisionId: 'dec-x',
    validatorAction: 'override',
    overrideJustification: 'looks fine to me',
  };

  it('REJECTS override->PASS when the edge is external-blocker', () => {
    expect(decide({ ...override, edge_class: 'external-blocker' })).toBeNull();
  });

  it('REJECTS override->PASS when the edge is plan-defect', () => {
    expect(decide({ ...override, edge_class: 'plan-defect' })).toBeNull();
  });

  it('ALLOWS override->PASS when the validator genuinely is the fault', () => {
    expect(decide({ ...override, edge_class: 'validator-failure' })).not.toBeNull();
  });

  it('ALLOWS revalidate under any edge (it cannot fabricate a PASS)', () => {
    const reval = { ...override, validatorAction: 'revalidate', overrideJustification: undefined };
    expect(decide({ ...reval, edge_class: 'external-blocker' })).not.toBeNull();
    expect(decide({ ...reval, edge_class: 'plan-defect' })).not.toBeNull();
  });
});

describe('#54 — bump-rung on an external blocker is allowed but flagged', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('permits it (the brain may see something we do not) and warns about the wasted rung', () => {
    const d = decide({
      edge_class: 'external-blocker', route_to: 'bump-rung', blocker_owner: 'brain', reason: 'r',
      action: 'bump-rung', targetRung: 1, decisionId: 'dec-bump',
    });
    expect(d).not.toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/advisory: bump-rung on edge_class=external-blocker/));
  });
});

describe('#54 — a rejected decision is never silent', () => {
  let err: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { err = vi.spyOn(console, 'error').mockImplementation(() => {}); });
  afterEach(() => { err.mockRestore(); });

  it('names the specific failed check', () => {
    expect(decide({ ...RUN24, action: 'bump-rung' })).toBeNull(); // action != route_to
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/DECISION REJECTED.*action \(bump-rung\) != route_to \(re-plan\)/));
  });

  it('reports unparseable JSON rather than swallowing it', () => {
    expect(svc.parseDecision('not json at all {')).toBeNull();
    expect(err).toHaveBeenCalled();
  });

  it('reports an unknown edge_class instead of failing mutely', () => {
    expect(decide({ ...RUN24, edge_class: 'totally-made-up' })).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.stringMatching(/unparseable brain verdict/));
  });
});
