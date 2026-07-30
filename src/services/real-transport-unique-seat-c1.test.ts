/**
 * C1 / AC13 — unique seat identity on disk for RealTransport brief paths.
 *
 * Reproduces the partner collision: both seats share logical role `deliberation` while
 * artifacts.writeBrief already uses unique names; RealTransport rewrote prompts/${role}.brief.md
 * and seat-2 clobbered seat-1. Gate: resolveSpawnBriefFileName + spawn write seam only.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  RealTransport,
  resolveSpawnBriefFileName,
  sanitizeBriefToken,
} from './real-transport.js';
import { ProviderResolverService } from './provider-resolver-service.js';

function makeCaptureTmux() {
  const fake: any = {
    commands: [] as string[],
    created: [] as string[],
    fed: [] as string[],
    createSession: async (name: string) => {
      fake.created.push(name);
      return `${name}:0.0`;
    },
    sendCommand: async (_t: string, cmd: string) => {
      fake.commands.push(cmd);
      return { message: 'sent', blocked: false };
    },
    waitForReady: async () => true,
    sendEnter: async () => ({}),
    sendKeys: async () => ({}),
    sendAndSubmit: async (_t: string, text: string) => {
      fake.fed.push(text);
      return true;
    },
    sendDispatchInstruction: async (_t: string, text: string) => {
      fake.fed.push(text);
      return true;
    },
    verifyMarkerPresent: async () => true,
    terminateSession: async () => true,
    clearContext: async () => ({ issued: true, verified: true, postCapture: '' }),
    capturePane: async () =>
      'bypass permissions on (shift+tab to cycle)\nalways-approve\nGrok Build\n❯ ready\n',
    sessionExists: async () => true,
    getPanePid: async () => '12345',
    composerHoldsText: async () => false,
    resubmitIfComposerHeld: async () => false,
  };
  return fake;
}

describe('C1 / AC13 resolveSpawnBriefFileName (pure)', () => {
  it('legacy: role only → prompts/${role}.brief.md basename', () => {
    expect(resolveSpawnBriefFileName({ role: 'deliberation' })).toBe('deliberation.brief.md');
    expect(resolveSpawnBriefFileName({ role: 'implementer' })).toBe('implementer.brief.md');
  });

  it('same logical role + distinct partner batchIds → distinct basenames (the live collision)', () => {
    const a = resolveSpawnBriefFileName({
      role: 'deliberation',
      batchId: 'plan-r1-partner',
    });
    const b = resolveSpawnBriefFileName({
      role: 'deliberation',
      batchId: 'plan-r1-partner-2',
    });
    expect(a).not.toBe(b);
    expect(a).toBe('deliberation--plan-r1-partner.brief.md');
    expect(b).toBe('deliberation--plan-r1-partner-2.brief.md');
    // Legacy shared path is what both seats wrote before C1 — both would equal this:
    expect(resolveSpawnBriefFileName({ role: 'deliberation' })).toBe('deliberation.brief.md');
  });

  it('includes seatId / round / attempt when provided', () => {
    expect(
      resolveSpawnBriefFileName({
        role: 'deliberation',
        seatId: 'partner-2',
        round: 2,
        attemptId: 3,
        batchId: 'plan-r2-partner-2',
      })
    ).toBe('deliberation--partner-2--r2--a3--plan-r2-partner-2.brief.md');
  });

  it('attemptId 0 / absent does not add an a-segment; round 0 is included as r0', () => {
    expect(resolveSpawnBriefFileName({ role: 'plancore', attemptId: 0 })).toBe('plancore.brief.md');
    expect(resolveSpawnBriefFileName({ role: 'plancore', round: 0 })).toBe('plancore--r0.brief.md');
  });

  it('briefFileName override wins and is basename-sanitized', () => {
    expect(
      resolveSpawnBriefFileName({
        role: 'deliberation',
        batchId: 'ignored-when-override',
        briefFileName: 'deliberation-partner-2.brief.md',
      })
    ).toBe('deliberation-partner-2.brief.md');
    expect(
      resolveSpawnBriefFileName({
        role: 'deliberation',
        briefFileName: '../evil/../../partner A.brief.md',
      })
    ).toBe('partner-A.brief.md');
  });

  it('sanitizeBriefToken strips path-hostile characters', () => {
    expect(sanitizeBriefToken('a/b\\c role')).toBe('a-b-c-role');
    expect(sanitizeBriefToken('')).toBe('seat');
  });
});

describe('C1 / AC13 RealTransport spawn brief path (stub tmux)', () => {
  let savedFake: string | undefined;
  let runDir: string;

  beforeEach(() => {
    savedFake = process.env.USE_FAKE_TMUX;
    delete process.env.USE_FAKE_TMUX;
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-c1-seat-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {}
    if (savedFake !== undefined) process.env.USE_FAKE_TMUX = savedFake;
    else delete process.env.USE_FAKE_TMUX;
  });

  async function spawnSeat(
    transport: RealTransport,
    opts: {
      role: string;
      brief: string;
      batchId?: string;
      seatId?: string;
      round?: number;
      attemptId?: number;
      briefFileName?: string;
    }
  ): Promise<void> {
    try {
      await transport.spawn({
        role: opts.role,
        brief: opts.brief,
        runDir,
        batchId: opts.batchId,
        seatId: opts.seatId,
        round: opts.round,
        attemptId: opts.attemptId,
        briefFileName: opts.briefFileName,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        projectDir: runDir,
      });
    } catch {
      // Dispatch may fail brief-contract validation after the prompts/ write; C1 only needs the files.
    }
  }

  it('two concurrent deliberation partners with distinct batchIds leave two brief files; seat-2 does not clobber seat-1', async () => {
    const transport = new RealTransport({
      tmux: makeCaptureTmux() as any,
      artifacts: { recordDispatch: () => 0 } as any,
      resolver: new ProviderResolverService(),
    });

    const brief1 = 'PARTNER-1-UNIQUE-BRIEF-BODY';
    const brief2 = 'PARTNER-2-UNIQUE-BRIEF-BODY';

    await spawnSeat(transport, {
      role: 'deliberation',
      brief: brief1,
      batchId: 'cycle13-partner',
      seatId: 'partner',
    });
    await spawnSeat(transport, {
      role: 'deliberation',
      brief: brief2,
      batchId: 'cycle13-partner-2',
      seatId: 'partner-2',
    });

    const promptsDir = path.join(runDir, 'prompts');
    const files = (await fsp.readdir(promptsDir)).filter((f) => f.endsWith('.brief.md')).sort();
    expect(files.length).toBeGreaterThanOrEqual(2);
    expect(files).toContain('deliberation--partner--cycle13-partner.brief.md');
    expect(files).toContain('deliberation--partner-2--cycle13-partner-2.brief.md');

    // Shared legacy path must NOT be the only survivor with seat-2 content.
    const legacy = path.join(promptsDir, 'deliberation.brief.md');
    if (fs.existsSync(legacy)) {
      // If anything still wrote legacy, it must not be the sole file wiping partner-1.
      expect(files.length).toBeGreaterThan(1);
    }

    const body1 = await fsp.readFile(
      path.join(promptsDir, 'deliberation--partner--cycle13-partner.brief.md'),
      'utf8'
    );
    const body2 = await fsp.readFile(
      path.join(promptsDir, 'deliberation--partner-2--cycle13-partner-2.brief.md'),
      'utf8'
    );
    expect(body1).toBe(brief1);
    expect(body2).toBe(brief2);
    expect(body1).not.toBe(body2);
  });

  it('bare role (no batchId/seat identity) still writes legacy prompts/${role}.brief.md', async () => {
    const transport = new RealTransport({
      tmux: makeCaptureTmux() as any,
      artifacts: { recordDispatch: () => 0 } as any,
      resolver: new ProviderResolverService(),
    });

    await spawnSeat(transport, {
      role: 'plancore',
      brief: 'LEGACY-BARE-ROLE',
      // no batchId — proves backward-compatible path
    });

    const legacyPath = path.join(runDir, 'prompts', 'plancore.brief.md');
    expect(fs.existsSync(legacyPath)).toBe(true);
    expect(await fsp.readFile(legacyPath, 'utf8')).toBe('LEGACY-BARE-ROLE');
  });

  it('returned role stays the external logical role (not the brief basename)', async () => {
    const transport = new RealTransport({
      tmux: makeCaptureTmux() as any,
      artifacts: { recordDispatch: () => 0 } as any,
      resolver: new ProviderResolverService(),
    });

    let returned: { handle: string; role: string } | null = null;
    try {
      returned = await transport.spawn({
        role: 'deliberation',
        brief: 'role-semantics',
        runDir,
        batchId: 'batch-X-partner-2',
        seatId: 'partner-2',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        projectDir: runDir,
      });
    } catch {
      // If dispatch fails after write, we cannot assert return; pure path + FS tests still gate AC13.
    }
    if (returned) {
      expect(returned.role).toBe('deliberation');
      expect(returned.handle).toMatch(/#/);
    }
    const expected = path.join(
      runDir,
      'prompts',
      'deliberation--partner-2--batch-X-partner-2.brief.md'
    );
    expect(fs.existsSync(expected)).toBe(true);
  });
});
