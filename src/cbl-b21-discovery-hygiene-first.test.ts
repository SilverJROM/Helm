/**
 * cycle-branch-lifecycle B21 — R7.2 / R7.3
 * Hygiene survey is the FIRST discovery exchange via the discovery sidecar
 * (formatActiveCycleBlock + discovery-contract) and the interview brief.
 * Facts-only; keep/delete/ignore is the operator's. No discovery-side judgement verbs.
 */
import { describe, it, expect } from 'vitest';
import {
  DISCOVERY_HYGIENE_HEADING,
  DISCOVERY_READY_ASK,
  discoveryHygieneContainsJudgementVerb,
  formatDiscoveryHygieneExchange,
  type DiscoveryHygieneSurvey,
} from './services/discovery-contract.js';
import {
  composeAgentSidecar,
  formatActiveCycleBlock,
} from './services/chat-session-service.js';
import { BriefWriterService } from './services/brief-writer-service.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sampleSurvey: DiscoveryHygieneSurvey = {
  degraded: false,
  branches: [
    {
      cycleId: 7,
      cycleName: 'prior work',
      branch: 'cycle/prior-work',
      report: {
        facts: {
          exists: true,
          mergedInto: [],
          tiedToActiveCycleId: 7,
          lastCommitAt: '2026-07-01T00:00:00Z',
          ageDays: 35,
          aheadBehind: { ahead: 2, behind: 0 },
          uncommittedInWorktree: false,
          worktreePath: '/tmp/proj/cycle/.worktrees/7',
        },
        narrative: null,
      },
    },
    {
      cycleId: 3,
      cycleName: 'merged done',
      branch: 'cycle/merged-done',
      report: {
        facts: {
          exists: true,
          mergedInto: ['main'],
          tiedToActiveCycleId: null,
          lastCommitAt: '2026-06-01T00:00:00Z',
          ageDays: 65,
          aheadBehind: null,
          uncommittedInWorktree: false,
          worktreePath: null,
        },
        narrative: null,
      },
    },
  ],
};

const discoveryCycle = {
  id: 21,
  name: 'B21 hygiene first',
  folder_name: 'b21-hygiene_0805',
  folder_path: '/tmp/example/cycle/b21-hygiene_0805',
  phase: 'discovery',
  autonomy: 'pause_after_planning',
  branchSurvey: sampleSurvey,
  defaultBase: 'main',
};

describe('B21 discovery hygiene first (R7.2 / R7.3)', () => {
  it('formatDiscoveryHygieneExchange is facts-only and names keep/delete/ignore as operator-owned', () => {
    const block = formatDiscoveryHygieneExchange(sampleSurvey, { defaultBase: 'main' });
    expect(block.startsWith(DISCOVERY_HYGIENE_HEADING)).toBe(true);
    expect(block).toContain('cycle/prior-work');
    expect(block).toContain('exists=true');
    expect(block).toContain('mergedInto=[main]');
    expect(block).toContain('tiedToActiveCycleId=7');
    expect(block).toContain('ageDays=35');
    expect(block).toMatch(/keep.*delete.*ignore/i);
    expect(block).toMatch(/operator alone chooses/i);
    expect(block).toMatch(/SAME session/i);
    expect(block).toContain('Offered default base: `main`');
    // No discovery-side judgement verbs (R7.2 / D5)
    expect(discoveryHygieneContainsJudgementVerb(block)).toBe(false);
  });

  it('degraded / empty survey still yields a presentable non-blocking first-topic block (R7.3)', () => {
    const degraded = formatDiscoveryHygieneExchange({ branches: [], degraded: true });
    expect(degraded).toContain(DISCOVERY_HYGIENE_HEADING);
    expect(degraded).toMatch(/degraded/i);
    expect(discoveryHygieneContainsJudgementVerb(degraded)).toBe(false);

    const empty = formatDiscoveryHygieneExchange({ branches: [], degraded: false });
    expect(empty).toContain('No other Helm cycle branches');
    expect(discoveryHygieneContainsJudgementVerb(empty)).toBe(false);
  });

  it('sidecar (formatActiveCycleBlock + composeAgentSidecar): hygiene block precedes interview brief and has no judgement verb', () => {
    const cycleBlock = formatActiveCycleBlock(discoveryCycle);
    expect(cycleBlock).toContain(DISCOVERY_HYGIENE_HEADING);
    expect(cycleBlock).toContain('cycle/prior-work');
    // Cycle identity still present
    expect(cycleBlock).toContain('Cycle id: 21');
    expect(cycleBlock).toContain('Current phase: discovery');

    const sidecar = composeAgentSidecar(
      '## Persona\nYou are discovery.\nrole: discovery\n',
      [],
      undefined,
      { name: 'example', directory: '/tmp/example', dev_url: null },
      null,
      discoveryCycle
    );

    const hygieneIdx = sidecar.indexOf(DISCOVERY_HYGIENE_HEADING);
    expect(hygieneIdx).toBeGreaterThanOrEqual(0);

    // Interview brief (generateInterviewBrief) also embeds hygiene first, then the interview mandate.
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b21-brief-'));
    try {
      const interviewBrief = new BriefWriterService().generateInterviewBrief({
        batchId: 'batch-B21',
        prompt: 'Ship branch hygiene first exchange',
        projectDir: '/tmp/example',
        callbacksFile: path.join(runDir, 'callbacks.md'),
        runDir,
        canonicalArtifactRoot: path.join(runDir, 'cycle', 'c1'),
        branchSurvey: sampleSurvey,
        defaultBase: 'main',
      });

      const briefHygieneIdx = interviewBrief.indexOf(DISCOVERY_HYGIENE_HEADING);
      const interviewMandateIdx = interviewBrief.indexOf(
        'conducting the Command Center **Discovery INTERVIEW**'
      );
      expect(briefHygieneIdx).toBeGreaterThanOrEqual(0);
      expect(interviewMandateIdx).toBeGreaterThan(briefHygieneIdx);

      // Combined discovery surface: sidecar hygiene precedes interview mandate content.
      const combined = `${sidecar}\n\n${interviewBrief}`;
      const combinedHygiene = combined.indexOf(DISCOVERY_HYGIENE_HEADING);
      const combinedInterview = combined.indexOf(
        'conducting the Command Center **Discovery INTERVIEW**'
      );
      expect(combinedHygiene).toBeGreaterThanOrEqual(0);
      expect(combinedInterview).toBeGreaterThan(combinedHygiene);

      // Hygiene portion of the interview brief (before the interview mandate) has no judgement verbs.
      const hygieneSlice = interviewBrief.slice(0, interviewMandateIdx);
      expect(discoveryHygieneContainsJudgementVerb(hygieneSlice)).toBe(false);

      // Sidecar hygiene block itself (from heading through phase contract) has no judgement verbs.
      const phaseIdx = sidecar.indexOf('## Discovery phase contract');
      const sidecarHygieneSlice =
        phaseIdx > hygieneIdx ? sidecar.slice(hygieneIdx, phaseIdx) : sidecar.slice(hygieneIdx);
      expect(discoveryHygieneContainsJudgementVerb(sidecarHygieneSlice)).toBe(false);

      // Hygiene still coexists with Discovery ready ASK / phase contract (no regression).
      expect(sidecar).toContain(DISCOVERY_READY_ASK);
      expect(sidecar).toContain('## Discovery phase contract');
      // Hygiene is inside the cycle block, which precedes the last-authority phase contract.
      expect(hygieneIdx).toBeLessThan(sidecar.indexOf('## Discovery phase contract'));
    } finally {
      fs.rmSync(runDir, { recursive: true, force: true });
    }
  });

  it('non-discovery phases do not inject the hygiene first-exchange block', () => {
    const planning = formatActiveCycleBlock({
      id: 1,
      name: 'p',
      folder_name: 'p',
      folder_path: '/tmp/p',
      phase: 'planning',
      branchSurvey: sampleSurvey,
    });
    expect(planning).not.toContain(DISCOVERY_HYGIENE_HEADING);
  });
});
