// @ts-nocheck — browser ESM helper is intentionally plain JS.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  phaseBrainAgentId,
  preferredPhaseAgentId,
} from './web/public/phase-agent-selection.js';

const resolution = (role, id, misleadingName) => ({
  phase: role === 'discovery' ? 'discovery' : 'planning',
  brain: { role, source: 'project-binding', agent: { id, name: misleadingName } },
  workers: [],
  unavailableRoles: [],
});

describe('browser phase-agent selection', () => {
  it('uses backend-returned IDs for discovery and planning/main defaults, never names', () => {
    const discovery = resolution('discovery', 22, 'plancore');
    const planning = resolution('plancore', 11, 'discovery');
    expect(preferredPhaseAgentId(discovery, null, false)).toBe(22);
    expect(preferredPhaseAgentId(planning, null, false)).toBe(11);
  });

  it('preserves a deliberate operator selection and otherwise refreshes to the phase owner', () => {
    const planning = resolution('plancore', 11, 'anything');
    expect(preferredPhaseAgentId(planning, 99, true)).toBe(99);
    expect(preferredPhaseAgentId(planning, 99, false)).toBe(11);
    expect(phaseBrainAgentId({ brain: null })).toBeNull();
  });

  it('app.js contains no legacy name-matching resolver and labels the discovery composer directly', () => {
    const appJs = fs.readFileSync(path.join(process.cwd(), 'src/web/public/app.js'), 'utf8');
    expect(appJs).not.toContain('CC_COORD_NAMES');
    expect(appJs).not.toContain('ccPreferredCoordRow');
    expect(appJs).not.toContain('coordName');
    expect(appJs).toContain("resolvePhaseAgents(pid, 'discovery')");
    expect(appJs).toContain('talk to discovery…');
  });
});
