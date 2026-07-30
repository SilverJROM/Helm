import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const BRIEF_PATH = path.join(
  process.cwd(),
  'plan',
  'planning-agreement-restructure',
  'dispatch',
  'D12-skeleton.implementer.brief.md',
);

type SkeletonModeState = 'pending' | 'skipped';

const PLANNING_REGRESSION_INDEX: Record<string, { state: SkeletonModeState; note: string }> = {
  'convene-before-artifacts': {
    state: 'skipped',
    note: 'No production-capable assertions yet; index entry is present for migration and future implementation streams.',
  },
  'BROKEN->revise->CLEAN': {
    state: 'skipped',
    note: 'No production-capable assertions yet; index entry is present for migration and future implementation streams.',
  },
  'partner1 CLEAN + partner2 BROKEN': {
    state: 'skipped',
    note: 'No production-capable assertions yet; index entry is present for migration and future implementation streams.',
  },
  'partner-2 silent until timeout': {
    state: 'skipped',
    note: 'No production-capable assertions yet; index entry is present for migration and future implementation streams.',
  },
  'legacy path refuses when north-star exists': {
    state: 'skipped',
    note: 'No production-capable assertions yet; index entry is present for migration and future implementation streams.',
  },
  'ibrain row count unchanged on planning block': {
    state: 'skipped',
    note: 'No production-capable assertions yet; index entry is present for migration and future implementation streams.',
  },
  'stale-CLEAN rejected across revisions': {
    state: 'skipped',
    note: 'No production-capable assertions yet; index entry is present for future implementation streams.',
  },
};

function requiredHistoricalModes(): string[] {
  const brief = fs.readFileSync(BRIEF_PATH, 'utf8');
  const match = brief.match(
    /Tests that burn no model tokens, covering each historical failure:\s*([^"]+?)"\s*$/m,
  );
  if (!match?.[1]) {
    throw new Error('Could not parse AC23 historical failure mode list from dispatch brief.');
  }

  return match[1]
    .split(';')
    .map((mode) => mode.trim().replace(/\.$/, ''))
    .filter((mode) => mode.length > 0);
}

const REQUIRED_MODES = requiredHistoricalModes();

describe('AC23 planning-regression index', () => {
  it('includes all seven historical failure modes from the dispatch brief', () => {
    const required = new Set(REQUIRED_MODES);
    const indexed = new Set(Object.keys(PLANNING_REGRESSION_INDEX));

    expect(REQUIRED_MODES).toHaveLength(7);
    expect(Object.keys(PLANNING_REGRESSION_INDEX)).toHaveLength(7);

    for (const mode of required) {
      expect(indexed.has(mode)).toBe(true);
    }

    for (const mode of indexed) {
      expect(required.has(mode)).toBe(true);
    }
  });

  it('provides explicit pending/skipped skeleton cases with non-empty notes', () => {
    for (const [mode, entry] of Object.entries(PLANNING_REGRESSION_INDEX)) {
      expect(mode).toBeTruthy();
      expect(entry.state).toMatch(/skipped|pending/);
      expect(entry.note.length).toBeGreaterThan(0);
      expect(entry.note).not.toMatch(/TODO/i);
    }
  });

  for (const [mode, entry] of Object.entries(PLANNING_REGRESSION_INDEX)) {
    it.skip(`skeleton mode is tracked for "${mode}" (${entry.state})`, () => {
      expect(mode).toContain(mode);
      expect(entry.state === 'pending' || entry.state === 'skipped').toBe(true);
    });
  }
});
