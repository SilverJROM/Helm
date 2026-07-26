import { describe, expect, it } from 'vitest';
import { EscalationService } from './escalation-service.js';
describe('B00.s7 brain verdict gate', () => {
  it('rejects payloads that are not EXECUTABLE (missing required fields)', () => {
    const s = new EscalationService({} as any);
    // empty decisionId — cannot be audited or de-duplicated
    expect(s.parseDecision('{"edge_class":"rung-attempt-limit","route_to":"bump-rung","blocker_owner":"brain","reason":"x","action":"bump-rung","decisionId":"","targetRung":1}')).toBeNull();
    // validator-handholding with nothing to hand-hold with
    expect(s.parseDecision('{"edge_class":"validator-failure","route_to":"validator-handholding","blocker_owner":"validator","reason":"x","action":"validator-handholding","decisionId":"x"}')).toBeNull();
  });

  it('#54: external-blocker + bump-rung is now ALLOWED (advisory-warned, not rejected)', () => {
    // Previously rejected. A higher rung probably cannot fix an external fault, so we log the likely
    // wasted attempt — but the brain may see something the table does not, and a wasted rung is
    // cheap and reversible. Blocking it discarded judgement for no safety gain.
    const s = new EscalationService({} as any);
    expect(s.parseDecision('{"edge_class":"external-blocker","route_to":"bump-rung","blocker_owner":"brain","reason":"x","action":"bump-rung","decisionId":"x","targetRung":1}')).not.toBeNull();
  });
});

describe('escalation rung resolution', () => {
  it('allows a top-rung start but still rejects an invalid rung', () => {
    const service = new EscalationService();
    expect(service.resolveRungAndModel({ role: 'implementer', explicitRung: 2 })).toMatchObject({
      rung: 2,
      source: 'explicit-rung-2',
    });
    // B6a: rung 3 is in domain but has no hardcoded fallback model → unresolvable without position-3 row
    expect(() => service.resolveRungAndModel({ role: 'implementer', explicitRung: 3 })).toThrow(
      /NO_RUNG_3_FOR_ROLE implementer/,
    );
    // rung 4 remains out of domain
    expect(() => service.resolveRungAndModel({ role: 'implementer', explicitRung: 4 })).toThrow(
      /INVALID_RUNG_FOR_ROLE: 4 for implementer/,
    );
    // absent L4 → max resolvable is 2
    expect(service.getMaxResolvableRung('implementer')).toBe(2);
  });

  it('B6a: parseDecision accepts targetRung 3, rejects 4', () => {
    const s = new EscalationService({} as any);
    expect(s.parseDecision(JSON.stringify({
      edge_class: 'rung-attempt-limit',
      route_to: 'bump-rung',
      blocker_owner: 'brain',
      reason: 'climb to L4',
      action: 'bump-rung',
      decisionId: 'dec-l4',
      targetRung: 3,
    }))).toMatchObject({ action: 'bump-rung', targetRung: 3 });
    expect(s.parseDecision(JSON.stringify({
      edge_class: 'rung-attempt-limit',
      route_to: 'bump-rung',
      blocker_owner: 'brain',
      reason: 'too high',
      action: 'bump-rung',
      decisionId: 'dec-l5',
      targetRung: 4,
    }))).toBeNull();
  });
});

describe('root-cause classifier decision validation', () => {
  const s = new EscalationService({} as any);

  it('accepts re-plan with planRevisionDirective + decisionId', () => {
    const d = s.parseDecision(JSON.stringify({
      edge_class: 'validator-failure',
      route_to: 're-plan',
      blocker_owner: 'brain',
      reason: 'spec impossible',
      action: 're-plan',
      decisionId: 'dec-replan-1',
      planRevisionDirective: 'validation_criteria contradict atomic_work; drop impossible criterion X',
    }));
    expect(d).toMatchObject({
      action: 're-plan',
      decisionId: 'dec-replan-1',
      planRevisionDirective: expect.stringContaining('contradict'),
    });
  });

  it('rejects re-plan without planRevisionDirective', () => {
    expect(s.parseDecision(JSON.stringify({
      edge_class: 'validator-failure',
      route_to: 're-plan',
      blocker_owner: 'brain',
      reason: 'spec impossible',
      action: 're-plan',
      decisionId: 'dec-replan-bad',
    }))).toBeNull();
  });

  it('accepts escalate-validator revalidate and override (with justification)', () => {
    const reval = s.parseDecision(JSON.stringify({
      edge_class: 'validator-failure',
      route_to: 'escalate-validator',
      blocker_owner: 'brain',
      reason: 'validator stuck',
      action: 'escalate-validator',
      decisionId: 'dec-ev-1',
      validatorAction: 'revalidate',
    }));
    expect(reval).toMatchObject({ action: 'escalate-validator', validatorAction: 'revalidate' });

    const over = s.parseDecision(JSON.stringify({
      edge_class: 'validator-failure',
      route_to: 'escalate-validator',
      blocker_owner: 'brain',
      reason: 'false fail',
      action: 'escalate-validator',
      decisionId: 'dec-ev-2',
      validatorAction: 'override',
      overrideJustification: 'impl matches north-star; validator diagnoses are vacuous',
    }));
    expect(over).toMatchObject({
      action: 'escalate-validator',
      validatorAction: 'override',
      overrideJustification: expect.stringContaining('north-star'),
    });
  });

  it('rejects escalate-validator override without overrideJustification', () => {
    expect(s.parseDecision(JSON.stringify({
      edge_class: 'validator-failure',
      route_to: 'escalate-validator',
      blocker_owner: 'brain',
      reason: 'false fail',
      action: 'escalate-validator',
      decisionId: 'dec-ev-bad',
      validatorAction: 'override',
    }))).toBeNull();
  });

  it('finding 9: rejects external-blocker + escalate-validator:override (never launder external to PASS)', () => {
    expect(s.parseDecision(JSON.stringify({
      edge_class: 'external-blocker',
      route_to: 'escalate-validator',
      blocker_owner: 'JROM',
      reason: 'waiting on vendor',
      action: 'escalate-validator',
      decisionId: 'dec-ext-ov',
      validatorAction: 'override',
      overrideJustification: 'force pass external',
    }))).toBeNull();
  });

  // SUPERSEDED by #54 (JROM-LOCKED 2026-07-20). "finding 9" used to reject re-plan/escalate-validator
  // whose edge_class was not 'validator-failure'. Retest run 24 proved that rule harmful: ibrain
  // correctly routed a missing requirement to re-plan, the edge_class did not match the table, and the
  // CORRECT decision was silently discarded and the task deferred. Helm now validates EXECUTABILITY,
  // not vocabulary — the brain owns the routing call. The assertions below are inverted deliberately;
  // they are not a regression. See escalation-decision-edgeclass.test.ts for the full new contract.
  it('#54: re-plan is accepted regardless of edge_class (brain owns the route)', () => {
    expect(s.parseDecision(JSON.stringify({
      edge_class: 'rung-attempt-limit',
      route_to: 're-plan',
      blocker_owner: 'brain',
      reason: 'brain judged the slice unbuildable as written',
      action: 're-plan',
      decisionId: 'dec-rp-bad-edge',
      planRevisionDirective: 'fix the plan',
    }))).not.toBeNull();
    expect(s.parseDecision(JSON.stringify({
      edge_class: 'external-blocker',
      route_to: 're-plan',
      blocker_owner: 'brain',
      reason: 'external',
      action: 're-plan',
      decisionId: 'dec-rp-ext',
      planRevisionDirective: 'revise the slice around the external gap',
    }))).not.toBeNull();
    // revalidate cannot fabricate a PASS, so it is safe under any edge.
    expect(s.parseDecision(JSON.stringify({
      edge_class: 'rung-attempt-limit',
      route_to: 'escalate-validator',
      blocker_owner: 'brain',
      reason: 'validator looks unreliable here',
      action: 'escalate-validator',
      decisionId: 'dec-ev-bad-edge',
      validatorAction: 'revalidate',
    }))).not.toBeNull();
  });

  it('#54: the surviving hard block — override may not launder a non-validator fault into PASS', () => {
    expect(s.parseDecision(JSON.stringify({
      edge_class: 'external-blocker',
      route_to: 'escalate-validator',
      blocker_owner: 'brain',
      reason: 'env broken',
      action: 'escalate-validator',
      decisionId: 'dec-ev-launder',
      validatorAction: 'override',
      overrideJustification: 'just accept it',
    }))).toBeNull();
  });
});
