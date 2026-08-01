import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  BriefWriterService,
  PANEL_BRIEF_PURPOSES,
  assertPanelBriefPurpose,
  type PanelBriefPurpose,
} from './brief-writer-service.js';

/**
 * B1 (R5.17 / R5.18 / R5.19): generatePanelBrief gains required exhaustive
 * purpose with no default. Production callers re-verified and migrated.
 * diff-review body stays free of draft/reconcile authoring instructions.
 */

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVICES = path.join(SRC_ROOT, 'services');

function readService(name: string): string {
  return fs.readFileSync(path.join(SERVICES, name), 'utf8');
}

function basePanelParams(purpose: PanelBriefPurpose) {
  return {
    purpose,
    batchId: `b1-${purpose}`,
    seat: 'A',
    lens: 'correctness',
    requirement: 'panel purpose plumbing',
    projectDir: '/tmp/b1-panel-purpose',
    callbacksFile: '/tmp/b1-panel-purpose/callbacks.md',
  } as const;
}

describe('BriefWriterService.generatePanelBrief — purpose discriminant (B1)', () => {
  const writer = new BriefWriterService();

  it('R5.18: exhaustively accepts every declared purpose and echoes it (no default path)', () => {
    expect(PANEL_BRIEF_PURPOSES).toEqual([
      'plan-draft',
      'plan-reconcile',
      'plan-signature',
      'task-conflict-reconvene',
      'diff-review',
    ]);

    for (const purpose of PANEL_BRIEF_PURPOSES) {
      const brief = writer.generatePanelBrief(basePanelParams(purpose));
      expect(brief).toContain(`Panel purpose: ${purpose}`);
      expect(brief).toContain('VERDICT-READY');
    }
  });

  it('R5.18: rejects an unknown purpose at runtime (fail-closed; no silent default)', () => {
    expect(() => assertPanelBriefPurpose('not-a-purpose')).toThrow(/purpose must be one of/);
    expect(() =>
      writer.generatePanelBrief({
        // Cast only to exercise the runtime guard — TypeScript rejects this at compile time.
        purpose: 'not-a-purpose' as PanelBriefPurpose,
        batchId: 'b1-bad',
        seat: 'A',
        lens: 'x',
      }),
    ).toThrow(/purpose must be one of/);
  });

  it('R5.19: diff-review brief contains no draft-authoring or candidate-reconciliation instructions', () => {
    const brief = writer.generatePanelBrief({
      ...basePanelParams('diff-review'),
      implementedDiff: '--- a/x\n+++ b/x\n@@\n-old\n+new\n',
    });

    expect(brief).toContain('Panel purpose: diff-review');
    expect(brief).toContain('Implemented diff under test:');
    expect(brief).toContain('VERDICT-READY');
    expect(brief).toContain('Do NOT implement fixes');

    // Draft-authoring / reconcile grammar lands in B2/B3 — must not appear here (R5.19).
    expect(brief).not.toMatch(/DRAFT-SUBMITTED/i);
    expect(brief).not.toMatch(/CANDIDATE-SUBMITTED/i);
    expect(brief).not.toMatch(/seat-scoped draft/i);
    expect(brief).not.toMatch(/write only your own draft/i);
    expect(brief).not.toMatch(/reconcile both drafts/i);
    expect(brief).not.toMatch(/plan-reconcile/i);
    expect(brief).not.toMatch(/plan-draft/i);
    expect(brief).not.toMatch(/plan-signature/i);
    expect(brief).not.toMatch(/\bSIGNED plan=/i);
    expect(brief).not.toMatch(/competing draft/i);
  });

  it('R5.17: production callers pass the migrated purpose literals (re-verified)', () => {
    const round = readService('planning-review-round.ts');
    const phase = readService('planning-phase-service.ts');
    const panel = readService('panel-service.ts');
    const writerSrc = readService('brief-writer-service.ts');

    // Signature requires purpose — no optional / default in the param type.
    expect(writerSrc).toMatch(/purpose:\s*PanelBriefPurpose/);
    expect(writerSrc).not.toMatch(/purpose\?:\s*PanelBriefPurpose/);
    expect(writerSrc).not.toMatch(/purpose\s*=\s*['"]diff-review['"]/);

    // ROUND temporarily uses diff-review (empty implementedDiff) until R2/B3.
    expect(round).toMatch(/generatePanelBrief\(\{\s*purpose:\s*['"]diff-review['"]/);

    // Post-ingest reconvene → task-conflict-reconvene.
    expect(phase).toMatch(/generatePanelBrief\(\{\s*purpose:\s*['"]task-conflict-reconvene['"]/);

    // Both panel-service sites → diff-review (bodies otherwise unchanged).
    const panelMatches = panel.match(/generatePanelBrief\(\{[\s\S]*?purpose:\s*['"]([^'"]+)['"]/g) || [];
    expect(panelMatches.length).toBeGreaterThanOrEqual(2);
    for (const m of panelMatches) {
      expect(m).toMatch(/purpose:\s*['"]diff-review['"]/);
    }
  });
});
