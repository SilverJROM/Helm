import { describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';

const readSource = (relativePath: string) => fs.readFile(new URL(relativePath, import.meta.url), 'utf8');

describe('B00.s4 R7 red anchors (failing by intent)', () => {
  // B00.s4a FLIPPED by A8 (R1.2): the POCFIX9 no-co-planner fast path (isPlanner/!isPlanner gating the
  // partner spawn) is deleted from planning-phase-service.ts — a planning run always convenes a partner
  // in every mode. Regression guard kept as a plain (non-`it.fails`) assertion; see
  // b00-parity.test.ts / parity-matrix.md for the corresponding registry retirement.
  it('B00.s4a (flipped by A8): planner mode can no longer bypass a co-planner', async () => {
    const source = await readSource('./services/planning-phase-service.ts');
    const partnerSelection = source.slice(
      source.indexOf('// Determine partner'),
      source.indexOf('// Fixture drive:'),
    );
    const plannerBypassesPartner =
      /const isPlanner\s*=\s*partner\s*===\s*'planner';/.test(partnerSelection) &&
      /if\s*\(\s*!isPlanner\s*\)[\s\S]*this\.transport\.spawn\(\{\s*role:\s*partner,/.test(partnerSelection);

    expect(plannerBypassesPartner).toBe(false);
  });

  it.fails('B00.s4b: the planning brief cannot forbid the runtime plan artifact it requires', async () => {
    // §2 evidence: brief-writer-service.ts:250 forbids plan.json authorship while the planning
    // runtime reads and parses runDir/plan.json at planning-phase-service.ts:198-223. Flip: B08.s2
    // must edit BOTH this brief mandate and the planning-phase plan.json poll/parse/BLOCK path (or
    // split that runtime work into an explicit dependent slice); changing only one seam is not a flip.
    const [briefSource, planningSource] = await Promise.all([
      readSource('./services/brief-writer-service.ts'),
      readSource('./services/planning-phase-service.ts'),
    ]);
    const briefMandate = briefSource.slice(
      briefSource.indexOf('**4. plan.json — DO NOT author**'),
      briefSource.indexOf('**5. Co-planner deliberation**'),
    );
    const runtimePlanPath = planningSource.slice(
      planningSource.indexOf("const planJsonPath = path.join(runDir, 'plan.json');"),
      planningSource.indexOf('// If test pre-wrote'),
    );
    const briefForbidsPlanJson = briefMandate.includes('Do NOT also hand-author plan.json');
    const runtimeRequiresPlanJson =
      runtimePlanPath.includes("await fs.readFile(planJsonPath, 'utf8')") &&
      runtimePlanPath.includes('this.parser.parsePlanFromJson(raw)');

    // Both seams must change: a partial brief-only or runtime-only change remains red by intent.
    expect(briefForbidsPlanJson).toBe(false);
    expect(runtimeRequiresPlanJson).toBe(false);
  });
});
