/**
 * S03 — Role-aware current-cycle document guard (AC6).
 *
 * Discovery-owned project chats must not create/replace/unlink/rename the bound
 * cycle folder's og-requirements.md, plan.md, or plan.json. Allowed Discovery
 * docs (north-star.md, conversation-log.md) continue to write. Other cycles and
 * non-Discovery phases are not over-blocked.
 */
import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  DISCOVERY_FORBIDDEN_CYCLE_DOC_BASENAMES,
  isDiscoveryDocGuardContext,
  isDiscoveryForbiddenCycleDocPath,
  safeCycleFolderName,
  startGovernedDocGuard,
} from './services/doc-path-guard.js';

const PROJ = path.join(os.homedir(), 'helm-s03-discovery-doc-ownership-fixture');
const BOUND = 'bound-cycle_0729';
const OTHER = 'other-cycle_0729';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function cyclePath(folder: string, basename: string): string {
  return path.join(PROJ, 'cycle', folder, basename);
}

function setupBoundCycle(opts: { seedForbidden?: boolean } = {}): void {
  const seedForbidden = opts.seedForbidden !== false;
  fs.rmSync(PROJ, { recursive: true, force: true });
  fs.mkdirSync(path.join(PROJ, 'cycle', BOUND), { recursive: true });
  fs.mkdirSync(path.join(PROJ, 'cycle', OTHER), { recursive: true });
  if (seedForbidden) {
    for (const f of DISCOVERY_FORBIDDEN_CYCLE_DOC_BASENAMES) {
      fs.writeFileSync(cyclePath(BOUND, f), `ORIGINAL ${f}`, 'utf8');
    }
  }
  fs.writeFileSync(cyclePath(BOUND, 'north-star.md'), 'NS v1', 'utf8');
  fs.writeFileSync(cyclePath(BOUND, 'conversation-log.md'), 'LOG v1', 'utf8');
  fs.writeFileSync(cyclePath(OTHER, 'plan.md'), 'OTHER plan v1', 'utf8');
  fs.writeFileSync(cyclePath(OTHER, 'og-requirements.md'), 'OTHER og v1', 'utf8');
}

describe('S03 discovery forbidden path classifiers', () => {
  it('isDiscoveryDocGuardContext true for discovery role or phase', () => {
    expect(isDiscoveryDocGuardContext({ role: 'discovery' })).toBe(true);
    expect(isDiscoveryDocGuardContext({ phase: 'discovery' })).toBe(true);
    expect(isDiscoveryDocGuardContext({ role: 'Discovery', phase: 'IDLE' })).toBe(true);
    expect(isDiscoveryDocGuardContext({ phase: 'DISCOVERY' })).toBe(true);
    expect(isDiscoveryDocGuardContext({ role: 'plancore', phase: 'planning' })).toBe(false);
    expect(isDiscoveryDocGuardContext({})).toBe(false);
  });

  it('safeCycleFolderName rejects traversal and multi-segment', () => {
    expect(safeCycleFolderName(BOUND)).toBe(BOUND);
    expect(safeCycleFolderName('../x')).toBe(null);
    expect(safeCycleFolderName('a/b')).toBe(null);
    expect(safeCycleFolderName('')).toBe(null);
  });

  it('isDiscoveryForbiddenCycleDocPath only matches bound cycle forbidden basenames', () => {
    for (const f of DISCOVERY_FORBIDDEN_CYCLE_DOC_BASENAMES) {
      expect(isDiscoveryForbiddenCycleDocPath(`cycle/${BOUND}/${f}`, BOUND)).toBe(true);
    }
    expect(isDiscoveryForbiddenCycleDocPath(`cycle/${BOUND}/north-star.md`, BOUND)).toBe(false);
    expect(isDiscoveryForbiddenCycleDocPath(`cycle/${BOUND}/conversation-log.md`, BOUND)).toBe(false);
    expect(isDiscoveryForbiddenCycleDocPath(`cycle/${OTHER}/plan.md`, BOUND)).toBe(false);
    expect(isDiscoveryForbiddenCycleDocPath(`plan/${BOUND}/plan.md`, BOUND)).toBe(false);
  });
});

describe('S03 startGovernedDocGuard Discovery cycle ownership', () => {
  beforeEach(() => {
    setupBoundCycle();
  });

  afterAll(() => {
    fs.rmSync(PROJ, { recursive: true, force: true });
  });

  it('fake Discovery chat: write/delete/rename of all three forbidden files are restored/denied', async () => {
    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    try {
      // replace
      fs.writeFileSync(cyclePath(BOUND, 'og-requirements.md'), 'pwned og', 'utf8');
      // unlink
      fs.unlinkSync(cyclePath(BOUND, 'plan.md'));
      // rename away
      fs.renameSync(cyclePath(BOUND, 'plan.json'), cyclePath(BOUND, 'plan.json.bak'));

      await sleep(450);

      expect(fs.readFileSync(cyclePath(BOUND, 'og-requirements.md'), 'utf8')).toBe(
        'ORIGINAL og-requirements.md'
      );
      expect(fs.readFileSync(cyclePath(BOUND, 'plan.md'), 'utf8')).toBe('ORIGINAL plan.md');
      expect(fs.readFileSync(cyclePath(BOUND, 'plan.json'), 'utf8')).toBe('ORIGINAL plan.json');

      const denied = new Set(handle.denials.map((d) => d.relPath));
      expect(denied.has(`cycle/${BOUND}/og-requirements.md`)).toBe(true);
      expect(denied.has(`cycle/${BOUND}/plan.md`)).toBe(true);
      expect(denied.has(`cycle/${BOUND}/plan.json`)).toBe(true);
      expect(handle.denials.length).toBeGreaterThanOrEqual(3);
    } finally {
      handle.stop();
    }
  });

  it('fake Discovery chat: create of a missing forbidden file is denied (removed)', async () => {
    setupBoundCycle({ seedForbidden: false });
    // seed only plan.md so og-requirements + plan.json exercise forbid-create
    fs.writeFileSync(cyclePath(BOUND, 'plan.md'), 'ORIGINAL plan.md', 'utf8');

    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    try {
      fs.writeFileSync(cyclePath(BOUND, 'og-requirements.md'), 'sneak create og', 'utf8');
      fs.writeFileSync(cyclePath(BOUND, 'plan.json'), '{"sneak":true}', 'utf8');

      await sleep(450);

      expect(fs.existsSync(cyclePath(BOUND, 'og-requirements.md'))).toBe(false);
      expect(fs.existsSync(cyclePath(BOUND, 'plan.json'))).toBe(false);
      // existing restore-mode file still protected
      expect(fs.readFileSync(cyclePath(BOUND, 'plan.md'), 'utf8')).toBe('ORIGINAL plan.md');

      const denied = handle.denials.map((d) => d.relPath);
      expect(denied).toEqual(
        expect.arrayContaining([
          `cycle/${BOUND}/og-requirements.md`,
          `cycle/${BOUND}/plan.json`,
        ])
      );
    } finally {
      handle.stop();
    }
  });

  it('north-star.md and conversation-log.md writes survive under Discovery guard', async () => {
    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    try {
      fs.writeFileSync(cyclePath(BOUND, 'north-star.md'), 'NS updated by discovery', 'utf8');
      fs.writeFileSync(cyclePath(BOUND, 'conversation-log.md'), 'LOG updated by discovery', 'utf8');

      await sleep(450);

      expect(fs.readFileSync(cyclePath(BOUND, 'north-star.md'), 'utf8')).toBe(
        'NS updated by discovery'
      );
      expect(fs.readFileSync(cyclePath(BOUND, 'conversation-log.md'), 'utf8')).toBe(
        'LOG updated by discovery'
      );
      expect(handle.denials.some((d) => d.relPath.endsWith('north-star.md'))).toBe(false);
      expect(handle.denials.some((d) => d.relPath.endsWith('conversation-log.md'))).toBe(false);
    } finally {
      handle.stop();
    }
  });

  it('different cycle is not over-blocked', async () => {
    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    try {
      fs.writeFileSync(cyclePath(OTHER, 'plan.md'), 'OTHER plan pwned', 'utf8');
      fs.writeFileSync(cyclePath(OTHER, 'og-requirements.md'), 'OTHER og pwned', 'utf8');

      await sleep(450);

      expect(fs.readFileSync(cyclePath(OTHER, 'plan.md'), 'utf8')).toBe('OTHER plan pwned');
      expect(fs.readFileSync(cyclePath(OTHER, 'og-requirements.md'), 'utf8')).toBe(
        'OTHER og pwned'
      );
      expect(handle.denials.some((d) => d.relPath.includes(OTHER))).toBe(false);
    } finally {
      handle.stop();
    }
  });

  it('non-Discovery phase is not over-blocked on bound cycle plan docs', async () => {
    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'plancore',
      phase: 'planning',
      cycleFolder: BOUND,
    });
    try {
      fs.writeFileSync(cyclePath(BOUND, 'plan.md'), 'Planning authored plan', 'utf8');
      fs.writeFileSync(cyclePath(BOUND, 'og-requirements.md'), 'Planning authored og', 'utf8');
      fs.writeFileSync(cyclePath(BOUND, 'plan.json'), '{"ok":true}', 'utf8');

      await sleep(450);

      expect(fs.readFileSync(cyclePath(BOUND, 'plan.md'), 'utf8')).toBe('Planning authored plan');
      expect(fs.readFileSync(cyclePath(BOUND, 'og-requirements.md'), 'utf8')).toBe(
        'Planning authored og'
      );
      expect(fs.readFileSync(cyclePath(BOUND, 'plan.json'), 'utf8')).toBe('{"ok":true}');
      expect(handle.denials.length).toBe(0);
    } finally {
      handle.stop();
    }
  });
});
