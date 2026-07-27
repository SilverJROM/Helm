import { describe, it, expect } from 'vitest';
import { BriefWriterService } from './services/brief-writer-service.js';

/**
 * A12 / R1.7 — brief/engine split-brain closed.
 * (a) every behavioural instruction maps to an engine capability (allowlist)
 * (b) brief states whole-plan scope + config-sourced planning_round_cap; no TEMP/pending markers
 */

/** Imperatives the post-A8–A11 engine can perform or that plancore may do without inventing a parallel orchestrator. */
const ENGINE_CAPABILITY_MARKERS = [
  // Artifact authoring (plancore)
  'author',
  'og-requirements.md',
  'plan.md',
  'write',
  // Engine-owned spawn + whole-plan gate + round cap
  'helm-algo spawns',
  'whole-plan',
  'PLAN-READY',
  'planning_round_cap',
  'BLOCKED',
  // Stop after gate
  'STOP COMPLETELY',
  // Per-task tags (free; reconvene path engine-owned)
  'ACCEPT',
  'AMEND',
  'ESCALATE',
];

/** Phrases that would re-open split-brain (plancore-driven convene / unbounded iterate). */
const FORBIDDEN_SPLIT_BRAIN = [
  'Convene partner',
  'convene co-planner',
  'Iterate until agreement',
  'iterate until agreement',
  'Pick co-planner per mode',
  'test harness spawns',
  'TEMP',
  'pending-policy',
  'default-pending',
  'pending-JROM',
];

describe('A12 R1.7 brief/engine split-brain', () => {
  const writer = new BriefWriterService();

  function gen(cap = 3) {
    return writer.generatePlanningBrief({
      batchId: 'a12-test-batch',
      northStar: 'A12 split-brain proof north-star',
      mode: 'deliberation',
      projectDir: '/tmp/a12-proj',
      runDir: '/tmp/a12-run',
      callbacksFile: '/tmp/a12-run/callbacks.md',
      planningRoundCap: cap,
    });
  }

  it('(a) behavioural instructions map to engine capabilities; no convene/iterate open loop', () => {
    const brief = gen(3);
    // Must not instruct plancore to run a parallel convene/iterate loop
    for (const bad of FORBIDDEN_SPLIT_BRAIN) {
      expect(brief.includes(bad), `forbidden split-brain phrase present: ${bad}`).toBe(false);
    }
    // Engine-aligned capabilities must appear
    for (const ok of [
      'helm-algo spawns',
      'whole-plan',
      'planning_round_cap',
      'BLOCKED',
      'PLAN-READY',
      'ACCEPT',
      'AMEND',
      'ESCALATE',
      'og-requirements.md',
      'plan.md',
    ]) {
      expect(brief.includes(ok), `missing engine capability marker: ${ok}`).toBe(true);
    }
    // Capability inventory: every ENGINE_CAPABILITY_MARKERS entry is present (maps to real path)
    for (const m of ENGINE_CAPABILITY_MARKERS) {
      expect(brief.toLowerCase().includes(m.toLowerCase()) || brief.includes(m), `capability missing: ${m}`).toBe(
        true
      );
    }
  });

  it('(b) states whole-plan scope + config-sourced cap; no TEMP/pending markers', () => {
    const brief5 = gen(5);
    expect(brief5).toMatch(/whole-plan/i);
    expect(brief5).toContain('planning_round_cap: 5');
    expect(brief5).toContain('planning_round_cap=5');
    expect(brief5).toMatch(/projects\.planning_round_cap|config-sourced|project config/i);
    expect(brief5).not.toMatch(/\bTEMP\b/);
    expect(brief5.toLowerCase()).not.toContain('pending-policy');
    expect(brief5.toLowerCase()).not.toContain('default-pending');
    // Default when omitted is 3
    const briefDefault = writer.generatePlanningBrief({
      batchId: 'a12-def',
      northStar: 'ns',
      runDir: '/tmp/x',
    });
    expect(briefDefault).toContain('planning_round_cap: 3');
  });
});
