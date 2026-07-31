import { describe, expect, it } from 'vitest';
import { BriefWriterService } from './brief-writer-service.js';

// C9 (AC12): generatePlanningBrief used to tell plancore that PLAN-READY itself meant
// partner agreement was reached ("emit PLAN-READY ... whole-plan agreement holds", literal
// callback note "plan agreed with <mode>"). That let plancore self-declare agreement and,
// downstream, implicitly self-grant ingest permission. Only the engine (helm-algo) may
// declare agreement and grant ingest permission — PLAN-READY must mean only "artifacts are
// ready for engine review." This proves the generated brief text no longer conflates the two.
describe('BriefWriterService.generatePlanningBrief — PLAN-READY != agreement (C9)', () => {
  function generate(mode?: string) {
    const writer = new BriefWriterService();
    return writer.generatePlanningBrief({
      batchId: 'batch-C9',
      northStar: 'C9 proof north-star',
      mode,
      projectDir: '/tmp/c9-proj',
      runDir: '/tmp/c9-run',
      callbacksFile: '/tmp/c9-run/callbacks.md',
      planningRoundCap: 3,
    });
  }

  it('does not contain the misleading "plan agreed with" literal for any mode', () => {
    for (const mode of [undefined, 'planner', 'deliberation']) {
      const brief = generate(mode);
      expect(brief.toLowerCase()).not.toContain('plan agreed with');
    }
  });

  it('does not instruct plancore to gate its own PLAN-READY on whole-plan agreement', () => {
    const brief = generate('deliberation');
    expect(brief).not.toContain('agreement holds');
    expect(brief).not.toContain('only after **whole-plan** co-planner agreement');
    expect(brief).not.toContain('force PLAN-READY past it');
  });

  it('states PLAN-READY means artifacts are ready for engine review, not agreement achieved', () => {
    const brief = generate('deliberation');
    expect(brief).toMatch(/PLAN-READY[\s\S]{0,120}ready for engine review/);
    expect(brief).toMatch(/ready for engine review[\s\S]{0,80}not that agreement has been reached/);
  });

  it('states only the engine declares agreement and grants ingest permission', () => {
    const brief = generate('deliberation');
    expect(brief).toContain('only the engine declares agreement and grants ingest permission');
    expect(brief).toContain('Only the engine judges agreement and grants ingest permission');
    expect(brief).toContain('only the engine grants ingest permission');
  });

  it('the literal emitted callback note carries no agreement claim', () => {
    const brief = generate('deliberation');
    expect(brief).toContain(
      '[helm callback] helm_pm batch-C9 STATUS: PLAN-READY — artifacts ready for engine review: og-requirements.md + plan.md written'
    );
  });

  it('still preserves the og-requirements.md + plan.md write contract and does not tell plancore to author plan.json', () => {
    const brief = generate('deliberation');
    expect(brief).toContain('og-requirements.md');
    expect(brief).toContain('plan.md');
    expect(brief).toContain('plan.json — DO NOT author');
    expect(brief).toContain('You write **og-requirements.md + plan.md ONLY**');
  });
});
