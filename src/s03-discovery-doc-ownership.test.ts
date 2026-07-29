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

  it('fix1 restore: unlink plan.md then mkdir same path → file restored with original + denial', async () => {
    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    try {
      const target = cyclePath(BOUND, 'plan.md');
      fs.unlinkSync(target);
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'nested.txt'), 'inside-dir', 'utf8');

      expect(fs.statSync(target).isDirectory()).toBe(true);

      await sleep(450);

      expect(fs.statSync(target).isFile()).toBe(true);
      expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL plan.md');
      const denial = handle.denials.find((d) => d.relPath === `cycle/${BOUND}/plan.md`);
      expect(denial).toBeTruthy();
      expect(denial!.attemptedContentSample).toBe('<directory>');
    } finally {
      handle.stop();
    }
  });

  it('fix1 forbid-create: mkdir og-requirements.md path → removed (absent) + denial', async () => {
    setupBoundCycle({ seedForbidden: false });
    // only plan.md exists (restore); og-requirements is forbid-create
    fs.writeFileSync(cyclePath(BOUND, 'plan.md'), 'ORIGINAL plan.md', 'utf8');

    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    try {
      const target = cyclePath(BOUND, 'og-requirements.md');
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'sneak.txt'), 'x', 'utf8');
      expect(fs.statSync(target).isDirectory()).toBe(true);

      await sleep(450);

      expect(fs.existsSync(target)).toBe(false);
      const denial = handle.denials.find(
        (d) => d.relPath === `cycle/${BOUND}/og-requirements.md`
      );
      expect(denial).toBeTruthy();
      expect(denial!.attemptedContentSample).toBe('<directory>');
      // restore-mode plan.md still intact / not over-touched
      expect(fs.readFileSync(cyclePath(BOUND, 'plan.md'), 'utf8')).toBe('ORIGINAL plan.md');
    } finally {
      handle.stop();
    }
  });

  it('fix2 restore: replace plan.md with symlink→dir → file restored + denial', async () => {
    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    try {
      const target = cyclePath(BOUND, 'plan.md');
      const realDir = path.join(PROJ, 'cycle', BOUND, '_evil_dir_target');
      fs.mkdirSync(realDir, { recursive: true });
      fs.writeFileSync(path.join(realDir, 'nested.txt'), 'via-symlink', 'utf8');
      fs.unlinkSync(target);
      fs.symlinkSync(realDir, target);

      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);
      expect(fs.statSync(target).isDirectory()).toBe(true);

      await sleep(450);

      expect(fs.lstatSync(target).isFile()).toBe(true);
      expect(fs.lstatSync(target).isSymbolicLink()).toBe(false);
      expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL plan.md');
      // symlink target dir must survive (we must not follow/rm the target)
      expect(fs.existsSync(path.join(realDir, 'nested.txt'))).toBe(true);

      const denial = handle.denials.find((d) => d.relPath === `cycle/${BOUND}/plan.md`);
      expect(denial).toBeTruthy();
      expect(denial!.attemptedContentSample).toBe('<symlink>');
    } finally {
      handle.stop();
    }
  });

  it('fix2 forbid-create: symlink at missing og-requirements.md → removed + denial', async () => {
    setupBoundCycle({ seedForbidden: false });
    fs.writeFileSync(cyclePath(BOUND, 'plan.md'), 'ORIGINAL plan.md', 'utf8');

    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    try {
      const target = cyclePath(BOUND, 'og-requirements.md');
      const realDir = path.join(PROJ, 'cycle', BOUND, '_evil_og_target');
      fs.mkdirSync(realDir, { recursive: true });
      fs.symlinkSync(realDir, target);

      expect(fs.lstatSync(target).isSymbolicLink()).toBe(true);

      await sleep(450);

      expect(fs.existsSync(target)).toBe(false);
      // did not follow the link and delete the real target
      expect(fs.existsSync(realDir)).toBe(true);

      const denial = handle.denials.find(
        (d) => d.relPath === `cycle/${BOUND}/og-requirements.md`
      );
      expect(denial).toBeTruthy();
      expect(denial!.attemptedContentSample).toBe('<symlink>');
    } finally {
      handle.stop();
    }
  });

  it('fix3 restore: write EVIL + chmod 0 on plan.md → ORIGINAL restored + denial', async () => {
    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    const target = cyclePath(BOUND, 'plan.md');
    try {
      fs.writeFileSync(target, 'EVIL CONTENT injected by discovery', 'utf8');
      fs.chmodSync(target, 0o000);

      await sleep(450);

      // ensure readable for assertion (guard should already have restored with normal perms)
      try {
        fs.chmodSync(target, 0o644);
      } catch {
        /* already readable */
      }
      expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL plan.md');
      const denial = handle.denials.find((d) => d.relPath === `cycle/${BOUND}/plan.md`);
      expect(denial).toBeTruthy();
      // sample is EVIL content if chmod+re-read worked, else <unreadable>
      expect(
        denial!.attemptedContentSample === 'EVIL CONTENT injected by discovery' ||
          denial!.attemptedContentSample === '<unreadable>'
      ).toBe(true);
    } finally {
      try {
        fs.chmodSync(target, 0o644);
      } catch {
        /* cleanup */
      }
      handle.stop();
    }
  });

  it('fix3 forbid-create: write SNEAK + chmod 0 on og-requirements → absent + denial', async () => {
    setupBoundCycle({ seedForbidden: false });
    fs.writeFileSync(cyclePath(BOUND, 'plan.md'), 'ORIGINAL plan.md', 'utf8');

    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    const target = cyclePath(BOUND, 'og-requirements.md');
    try {
      fs.writeFileSync(target, 'SNEAK unreadable create', 'utf8');
      fs.chmodSync(target, 0o000);

      await sleep(450);

      expect(fs.existsSync(target)).toBe(false);
      const denial = handle.denials.find(
        (d) => d.relPath === `cycle/${BOUND}/og-requirements.md`
      );
      expect(denial).toBeTruthy();
      expect(
        denial!.attemptedContentSample === 'SNEAK unreadable create' ||
          denial!.attemptedContentSample === '<unreadable>'
      ).toBe(true);
    } finally {
      try {
        if (fs.existsSync(target)) fs.chmodSync(target, 0o644);
      } catch {
        /* cleanup */
      }
      try {
        fs.rmSync(target, { force: true, recursive: true });
      } catch {
        /* cleanup */
      }
      handle.stop();
    }
  });

  it('fix4 restore: write EVIL to plan.md + chmod(0) on parent cycle folder → ORIGINAL + denial', async () => {
    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    const parent = path.join(PROJ, 'cycle', BOUND);
    const target = cyclePath(BOUND, 'plan.md');
    try {
      fs.writeFileSync(target, 'EVIL via parent-dir blind', 'utf8');
      fs.chmodSync(parent, 0o000);

      await sleep(450);

      // guard must have restored parent search perms + leaf content
      try {
        fs.chmodSync(parent, 0o755);
      } catch {
        /* already open */
      }
      try {
        fs.chmodSync(target, 0o644);
      } catch {
        /* already readable */
      }
      expect(fs.readFileSync(target, 'utf8')).toBe('ORIGINAL plan.md');
      const denial = handle.denials.find((d) => d.relPath === `cycle/${BOUND}/plan.md`);
      expect(denial).toBeTruthy();
      expect(
        denial!.attemptedContentSample === 'EVIL via parent-dir blind' ||
          denial!.attemptedContentSample === '<parent-unreadable>' ||
          denial!.attemptedContentSample === '<unreadable>'
      ).toBe(true);
    } finally {
      try {
        fs.chmodSync(parent, 0o755);
      } catch {
        /* cleanup */
      }
      try {
        fs.chmodSync(target, 0o644);
      } catch {
        /* cleanup */
      }
      handle.stop();
    }
  });

  it('fix4 forbid-create: write SNEAK + chmod(0) on parent cycle folder → absent + denial', async () => {
    setupBoundCycle({ seedForbidden: false });
    fs.writeFileSync(cyclePath(BOUND, 'plan.md'), 'ORIGINAL plan.md', 'utf8');

    const handle = startGovernedDocGuard(PROJ, {
      pollMs: 50,
      role: 'discovery',
      phase: 'discovery',
      cycleFolder: BOUND,
    });
    const parent = path.join(PROJ, 'cycle', BOUND);
    const target = cyclePath(BOUND, 'og-requirements.md');
    try {
      fs.writeFileSync(target, 'SNEAK via parent-dir blind', 'utf8');
      fs.chmodSync(parent, 0o000);

      await sleep(450);

      try {
        fs.chmodSync(parent, 0o755);
      } catch {
        /* already open */
      }
      expect(fs.existsSync(target)).toBe(false);
      const denial = handle.denials.find(
        (d) => d.relPath === `cycle/${BOUND}/og-requirements.md`
      );
      expect(denial).toBeTruthy();
      expect(
        denial!.attemptedContentSample === 'SNEAK via parent-dir blind' ||
          denial!.attemptedContentSample === '<parent-unreadable>' ||
          denial!.attemptedContentSample === '<unreadable>'
      ).toBe(true);
    } finally {
      try {
        fs.chmodSync(parent, 0o755);
      } catch {
        /* cleanup */
      }
      try {
        if (fs.existsSync(target)) {
          fs.chmodSync(target, 0o644);
          fs.rmSync(target, { force: true, recursive: true });
        }
      } catch {
        /* cleanup */
      }
      handle.stop();
    }
  });
});
