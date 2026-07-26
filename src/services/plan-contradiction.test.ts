import { describe, it, expect } from 'vitest';
import { parsePlanContradiction } from './plan-contradiction.js';

describe('parsePlanContradiction', () => {
  it('parses the resolved-in-favour-of-requirement case (the PC06 shape)', () => {
    const note =
      'DONE — PC06 compareFiveCard PD-6 order; tests pass; commit 4223212\n' +
      'PLAN-CONTRADICTION: task instruction says full house < flush < straight vs PD-6 says straight < flush < full house — resolved-as: implemented PD-6 order';
    const c = parsePlanContradiction(note);
    expect(c).toBeTruthy();
    expect(c!.blocked).toBe(false);
    expect(c!.instruction).toMatch(/full house < flush < straight/);
    expect(c!.requirement).toMatch(/PD-6 says straight < flush < full house/);
    expect(c!.resolvedAs).toMatch(/implemented PD-6 order/);
  });

  it('treats "none: blocked" as blocked with no resolution', () => {
    const note =
      'BLOCKED — cannot satisfy both halves\n' +
      'PLAN-CONTRADICTION: task says return 0 for same category vs task also says never return 0 — resolved-as: none: blocked';
    const c = parsePlanContradiction(note)!;
    expect(c.blocked).toBe(true);
    expect(c.resolvedAs).toBeNull();
  });

  it('treats a missing resolved-as clause as blocked (fail-safe, never invents a resolution)', () => {
    const c = parsePlanContradiction('PLAN-CONTRADICTION: task references PD-19 vs PD-19 does not exist')!;
    expect(c.blocked).toBe(true);
    expect(c.resolvedAs).toBeNull();
  });

  it('returns null when no marker is present', () => {
    expect(parsePlanContradiction('DONE — PC02 deal 13 cards; tests pass; commit 4bbfe97')).toBeNull();
    expect(parsePlanContradiction('')).toBeNull();
  });

  it('takes the LAST marker so a later attempt supersedes an earlier one', () => {
    const note = [
      'PLAN-CONTRADICTION: old claim vs old source — resolved-as: first take',
      'PLAN-CONTRADICTION: new claim vs new source — resolved-as: second take',
    ].join('\n');
    expect(parsePlanContradiction(note)!.resolvedAs).toBe('second take');
  });

  it('tolerates a plain hyphen instead of an em-dash, and odd casing', () => {
    const c = parsePlanContradiction('plan-contradiction: A says x vs B says y - RESOLVED-AS: took B')!;
    expect(c.blocked).toBe(false);
    expect(c.resolvedAs).toBe('took B');
  });

  it('splits on the LAST " vs " so either side may contain the word', () => {
    const c = parsePlanContradiction(
      'PLAN-CONTRADICTION: order is straight vs flush per task vs PD-6 says otherwise — resolved-as: PD-6'
    )!;
    expect(c.instruction).toBe('order is straight vs flush per task');
    expect(c.requirement).toBe('PD-6 says otherwise');
  });

  it('degrades gracefully when the claim pair has no " vs "', () => {
    const c = parsePlanContradiction('PLAN-CONTRADICTION: the brief disagrees with itself — resolved-as: took the requirement')!;
    expect(c.instruction).toMatch(/disagrees with itself/);
    expect(c.requirement).toBe('');
    expect(c.blocked).toBe(false);
  });
});
