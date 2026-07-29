/**
 * S01 — Shared Discovery contract proofs.
 * Disposable; no live DB. Asserts observable contract surface for sidecar + interview brief.
 */
import { describe, it, expect } from 'vitest';
import {
  DISCOVERY_ALLOWED_STATES,
  DISCOVERY_ARTIFACTS,
  DISCOVERY_READY_ASK,
  DISCOVERY_ROLE,
  DISCOVERY_TERMINAL_STATES,
  PLANNING_FORBIDDEN_FOR_DISCOVERY,
  discoveryStatesEnumLine,
  formatDiscoveryPhaseContract,
  formatPlanningPhaseContract,
  isDiscoveryPhase,
  isPlanningPhase,
} from './discovery-contract.js';
import {
  composeAgentSidecar,
  formatActiveCycleBlock,
} from './chat-session-service.js';
import { BriefWriterService } from './brief-writer-service.js';
import { DispatchService } from './dispatch-service.js';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';

const fakePersona = '## Persona\nYou are a helpful Discovery agent.\nrole: discovery\n';

function discoveryCycle(overrides: Partial<{ phase: string; autonomy: string }> = {}) {
  return {
    id: 13,
    name: 'Live Discovery Cycle',
    folder_name: 'live-discovery_0729',
    folder_path: '/tmp/example-project/cycle/live-discovery_0729',
    phase: 'discovery',
    autonomy: 'pause_after_planning',
    ...overrides,
  };
}

describe('S01 discovery-contract module', () => {
  it('exports canonical role, enums (no HANDOFF), artifacts, and exact ASK', () => {
    expect(DISCOVERY_ROLE).toBe('discovery');
    expect([...DISCOVERY_ALLOWED_STATES]).toEqual([
      'INTERVIEWING',
      'NORTH-STAR-READY',
      'IDLE',
      'BLOCKED',
    ]);
    expect([...DISCOVERY_TERMINAL_STATES]).toEqual(['NORTH-STAR-READY', 'BLOCKED']);
    expect(DISCOVERY_ALLOWED_STATES).not.toContain('HANDOFF');
    expect(DISCOVERY_TERMINAL_STATES).not.toContain('HANDOFF');
    expect([...DISCOVERY_ARTIFACTS]).toEqual([
      'north-star.md',
      'conversation-log.md',
      'decisions/',
      'attachments/',
      'mockups/',
    ]);
    expect([...PLANNING_FORBIDDEN_FOR_DISCOVERY]).toEqual([
      'og-requirements.md',
      'plan.md',
      'plan.json',
    ]);
    expect(DISCOVERY_READY_ASK).toBe(
      'Initial Discovery docs are ready. May I ask Helm to start the configured Planning team?'
    );
    expect(discoveryStatesEnumLine()).toBe(
      'discovery states: INTERVIEWING | NORTH-STAR-READY | IDLE | BLOCKED'
    );
  });

  it('formatDiscoveryPhaseContract has Discovery surface only (no Planning schema/write)', () => {
    const block = formatDiscoveryPhaseContract();
    expect(block).toContain('Role: `discovery`');
    expect(block).toContain(discoveryStatesEnumLine());
    expect(block).toContain('HANDOFF` is NOT a Discovery state');
    for (const a of DISCOVERY_ARTIFACTS) {
      if (a === 'attachments/' || a === 'mockups/') {
        expect(block).toMatch(/attachments\/|mockups\//);
      } else if (a === 'decisions/') {
        expect(block).toContain('decisions/');
      } else {
        expect(block).toContain(a);
      }
    }
    expect(block).toContain(DISCOVERY_READY_ASK);
    // No Planning schema / write instruction
    expect(block).not.toContain('fenced ```json task array');
    expect(block).not.toContain('"assignee":"L1"');
    expect(block).not.toContain('For active-cycle Planning artifacts');
    expect(block).toContain('og-requirements.md'); // listed as forbidden
    expect(block).toMatch(/Do NOT author|never plans/i);
  });

  it('phase helpers', () => {
    expect(isDiscoveryPhase('discovery')).toBe(true);
    expect(isDiscoveryPhase('Discovery')).toBe(true);
    expect(isDiscoveryPhase('planning')).toBe(false);
    expect(isDiscoveryPhase('')).toBe(false);
    expect(isDiscoveryPhase(null)).toBe(false);
    expect(isPlanningPhase('planning')).toBe(true);
    expect(isPlanningPhase('discovery')).toBe(false);
  });
});

describe('S01 Discovery sidecar (formatActiveCycleBlock + composeAgentSidecar)', () => {
  it('(1) Discovery sidecar snapshot: only Discovery artifacts + exact ASK; no Planning schema/write', () => {
    const cycle = discoveryCycle();
    const block = formatActiveCycleBlock(cycle);
    expect(block).toContain('Cycle id: 13');
    expect(block).toContain('Current phase: discovery');
    // cycle identity block does not embed Planning schema
    expect(block).not.toContain('fenced ```json task array');
    expect(block).not.toContain('For active-cycle Planning artifacts');

    const sidecar = composeAgentSidecar(
      fakePersona,
      [],
      undefined,
      { name: 'example-project', directory: '/tmp/example-project', dev_url: null },
      null,
      cycle
    );

    // Discovery contract last-authority
    expect(sidecar).toContain('## Discovery phase contract (AUTHORITATIVE — last authority wins)');
    expect(sidecar.indexOf('## Discovery phase contract')).toBeGreaterThan(
      sidecar.indexOf(fakePersona.trim().slice(0, 20))
    );
    expect(sidecar).toContain(DISCOVERY_READY_ASK);
    expect(sidecar).toContain(discoveryStatesEnumLine());
    expect(sidecar).toContain('north-star.md');
    expect(sidecar).toContain('conversation-log.md');
    expect(sidecar).toContain('decisions/');
    expect(sidecar).toMatch(/attachments\/|mockups\//);

    // No Planning schema / write instruction in Discovery sidecar
    expect(sidecar).not.toContain('fenced ```json task array');
    expect(sidecar).not.toContain('Copy this EXACT example task');
    expect(sidecar).not.toContain('For active-cycle Planning artifacts, write exactly these files');
    // HANDOFF only appears as explicitly excluded (not as an allowed/terminal state)
    expect(sidecar).toMatch(/HANDOFF` is NOT a Discovery state/);
    expect(sidecar).not.toMatch(/allowed states:.*HANDOFF/);
    // Forbidden planning files named only as do-not-author
    expect(sidecar).toMatch(/Do NOT author[\s\S]*og-requirements\.md/);
  });

  it('(2) Planning / non-cycle sidecars retain their own contracts (no regression)', () => {
    const planningCycle = {
      id: 42,
      name: 'Plan Cycle',
      folder_name: 'plan-cycle',
      folder_path: '/tmp/example-project/cycle/plan-cycle',
      phase: 'planning',
      autonomy: 'pause_after_planning',
    };
    const planningBlock = formatActiveCycleBlock(planningCycle);
    expect(planningBlock).toContain('og-requirements.md');
    expect(planningBlock).toContain('plan.md');
    expect(planningBlock).toContain('fenced ```json task array');
    expect(planningBlock).not.toContain(DISCOVERY_READY_ASK);
    expect(planningBlock).not.toContain('## Discovery phase contract');

    const planningSidecar = composeAgentSidecar(
      fakePersona,
      [],
      undefined,
      { name: 'example-project', directory: '/tmp/example-project', dev_url: null },
      null,
      planningCycle
    );
    expect(planningSidecar).toContain('fenced ```json task array');
    expect(planningSidecar).not.toContain('## Discovery phase contract');
    expect(planningSidecar).not.toContain(DISCOVERY_READY_ASK);

    // Non-cycle: no cycle block, no Discovery ASK, no Planning task schema forced
    const nonCycle = composeAgentSidecar(
      fakePersona,
      [],
      undefined,
      { name: 'example-project', directory: '/tmp/example-project', dev_url: null },
      null,
      null
    );
    expect(nonCycle).not.toContain('## Active Helm cycle');
    expect(nonCycle).not.toContain('## Discovery phase contract');
    expect(nonCycle).not.toContain(DISCOVERY_READY_ASK);
    expect(nonCycle).not.toContain('fenced ```json task array');

    // Unknown/empty phase: cycle facts only — no Planning schema leak into Discovery-ish contexts
    const emptyPhase = formatActiveCycleBlock(discoveryCycle({ phase: '' }));
    expect(emptyPhase).toContain('Cycle id: 13');
    expect(emptyPhase).not.toContain('fenced ```json task array');
    expect(emptyPhase).not.toContain(DISCOVERY_READY_ASK);
  });

  it('Discovery phase contract is last block in sidecar (last-authority)', () => {
    const sidecar = composeAgentSidecar(
      fakePersona,
      [{ title: 'm1', description: 'd', body: 'memory body' }],
      undefined,
      { name: 'p', directory: '/tmp/p', dev_url: null },
      null,
      discoveryCycle()
    );
    const phaseIdx = sidecar.lastIndexOf('## Discovery phase contract');
    const personaIdx = sidecar.indexOf('## Persona');
    const projectIdx = sidecar.indexOf('## Project');
    expect(phaseIdx).toBeGreaterThan(personaIdx);
    expect(phaseIdx).toBeGreaterThan(projectIdx);
    // phase contract is the last major heading content
    expect(sidecar.trim().endsWith(DISCOVERY_READY_ASK) || sidecar.includes(DISCOVERY_READY_ASK)).toBe(
      true
    );
    expect(phaseIdx).toBe(sidecar.lastIndexOf('## Discovery phase contract'));
  });
});

describe('S01 interview brief (generateInterviewBrief)', () => {
  it('(3) interview brief has canonical enum, exact ASK, and no Plan: header', () => {
    const writer = new BriefWriterService();
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-s01-brief-'));
    try {
      const generated = writer.generateInterviewBrief({
        batchId: 'batch-S01-test',
        prompt: 'Ship Discovery contract',
        projectDir: '/tmp/s01-project',
        runDir,
        callbacksFile: path.join(runDir, 'callbacks.md'),
        canonicalArtifactRoot: path.join(runDir, 'cycle', 'c1'),
      });

      expect(generated).toContain(discoveryStatesEnumLine());
      expect(generated).toContain('discovery terminal: NORTH-STAR-READY | BLOCKED');
      expect(generated).toContain(DISCOVERY_READY_ASK);
      expect(generated).toContain('You are **discovery** conducting');
      expect(generated).toContain('[helm callback] discovery batch-S01-test STATUS: NORTH-STAR-READY');
      expect(generated).toMatch(/HANDOFF.*NOT a Discovery state/i);

      // AC5: no Plan: header advertising plan.md
      expect(generated).not.toMatch(/^Plan:\s/m);
      expect(generated).not.toContain('Plan: ');
      expect(generated).not.toContain(path.join(runDir, 'cycle', 'c1', 'plan.md'));

      // Does not authorize Planning completion / schema ownership
      expect(generated).toMatch(/Do NOT author/);
      expect(generated).toContain('og-requirements.md');
      expect(generated).toContain('plan.md');
      expect(generated).toContain('plan.json');

      // Brief contract still validates for discovery role
      const dispatch = new DispatchService({} as any, {} as any);
      expect(() => dispatch.validateBriefContract(generated, 'discovery')).not.toThrow();
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });
});

describe('S01 planning phase contract helper', () => {
  it('formatPlanningPhaseContract still carries plan.md schema', () => {
    const p = formatPlanningPhaseContract();
    expect(p).toContain('og-requirements.md');
    expect(p).toContain('plan.md');
    expect(p).toContain('fenced ```json task array');
    expect(p).not.toContain(DISCOVERY_READY_ASK);
  });
});
