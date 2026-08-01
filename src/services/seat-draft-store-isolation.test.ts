/**
 * D2 / R2.6 — Blind isolation OS-enforced for co-drafting seats.
 *
 * Proves:
 *  1. composeSeatDraftReadAllow builds seat-private strictReadAllow (own draft dir
 *     + context only); peer dirs / runDir / planning-drafts root typed-BLOCK.
 *  2. Overlap/widen rejected BEFORE any tmux side effect (RealTransport + FakeTransport).
 *  3. Compiled helm-sandbox: seat A's process cannot cat/ls seat B's draft dir;
 *     seat A can read its own draft + allowlisted context.
 *  4. Engine (outside sandbox) publishDraft(seatId) rehashes both seats after commit.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  makeStrictReadProfileEnv,
  resolveHelmSandboxBin,
} from '../security/landlock-sandbox.js';
import { planRevision } from './plan-revision.js';
import { ProviderResolverService } from './provider-resolver-service.js';
import { RealTransport } from './real-transport.js';
import { FakeTransport } from './fake-transport.js';
import {
  SEAT_DRAFT_ISOLATION,
  SeatDraftIsolationError,
  assertNoPeerDraftAccess,
  atomicWriteFile,
  composeSeatDraftReadAllow,
  draftPlanPath,
  draftReqPath,
  publishDraft,
  seatDraftDir,
} from './seat-draft-store.js';

const BIN = resolveHelmSandboxBin();

// System paths the launched cmd (bash + coreutils) needs under strict. Filter to what exists.
const SYS_ALLOW = ['/usr', '/lib', '/lib64', '/bin', '/etc'].filter((p) => fs.existsSync(p));

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

function makeHomeTemp(prefix: string): string {
  // Under $HOME — /tmp is a tooling write exception and is UNREADABLE under strict,
  // so draft fixtures for binary probes live under home (mirrors strict-read-profile.test.ts).
  const dir = fs.mkdtempSync(path.join(os.homedir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeTmpTemp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

// ---------------------------------------------------------------------------
// compose + assert (typed BLOCK, pure)
// ---------------------------------------------------------------------------
describe('composeSeatDraftReadAllow — seat-private fence composition (R2.6)', () => {
  it('includes own draft dir + context; excludes peer draft dirs', () => {
    const runDir = '/tmp/helm-run-iso-compose';
    const ctx = '/tmp/helm-ctx-north-star.md';
    const allow = composeSeatDraftReadAllow({
      runDir,
      seatId: 'seat-a',
      peerSeatIds: ['seat-b', 'seat-c'],
      contextInputs: [ctx],
      deploymentAllow: ['/usr'],
    });

    const own = seatDraftDir(runDir, 'seat-a');
    expect(allow).toContain(own);
    expect(allow).toContain(path.resolve(ctx));
    expect(allow).toContain('/usr');
    expect(allow).not.toContain(seatDraftDir(runDir, 'seat-b'));
    expect(allow).not.toContain(seatDraftDir(runDir, 'seat-c'));
    // First entry is own isolation unit.
    expect(allow[0]).toBe(own);
  });

  it('typed-BLOCKs when contextInputs includes a peer seat draft dir', () => {
    const runDir = '/tmp/helm-run-iso-peer-ctx';
    const peerDir = seatDraftDir(runDir, 'seat-b');
    expect(() =>
      composeSeatDraftReadAllow({
        runDir,
        seatId: 'seat-a',
        peerSeatIds: ['seat-b'],
        contextInputs: [peerDir],
      }),
    ).toThrow(SeatDraftIsolationError);

    try {
      composeSeatDraftReadAllow({
        runDir,
        seatId: 'seat-a',
        peerSeatIds: ['seat-b'],
        contextInputs: [peerDir],
      });
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SeatDraftIsolationError);
      expect((e as SeatDraftIsolationError).code).toBe(SEAT_DRAFT_ISOLATION);
      expect(String(e)).toMatch(/SEAT-DRAFT-ISOLATION|peer seat draft/i);
    }
  });

  it('typed-BLOCKs widening allowlist to runDir (covers all peer dirs via PATH_BENEATH)', () => {
    const runDir = '/tmp/helm-run-iso-widen';
    expect(() =>
      composeSeatDraftReadAllow({
        runDir,
        seatId: 'seat-a',
        peerSeatIds: ['seat-b'],
        contextInputs: [path.resolve(runDir)],
      }),
    ).toThrow(/SEAT-DRAFT-ISOLATION|widen|peer/i);
  });

  it('typed-BLOCKs widening to planning-drafts/ parent of all seats', () => {
    const runDir = '/tmp/helm-run-iso-drafts-root';
    const draftsRoot = path.join(path.resolve(runDir), 'planning-drafts');
    expect(() =>
      composeSeatDraftReadAllow({
        runDir,
        seatId: 'seat-a',
        peerSeatIds: ['seat-b'],
        deploymentAllow: [draftsRoot],
      }),
    ).toThrow(/SEAT-DRAFT-ISOLATION|widen|peer/i);
  });

  it('typed-BLOCKs relative context paths (absolute required)', () => {
    expect(() =>
      composeSeatDraftReadAllow({
        runDir: '/tmp/run',
        seatId: 'a',
        peerSeatIds: ['b'],
        contextInputs: ['relative/north-star.md'],
      }),
    ).toThrow(/absolute/i);
  });

  it('assertNoPeerDraftAccess rejects ad-hoc allowlist that includes peer dir', () => {
    const runDir = '/tmp/helm-run-iso-assert';
    expect(() =>
      assertNoPeerDraftAccess(
        [seatDraftDir(runDir, 'seat-a'), seatDraftDir(runDir, 'seat-b')],
        runDir,
        'seat-a',
        ['seat-b'],
      ),
    ).toThrow(SeatDraftIsolationError);
  });

  it('compose result is accepted by makeStrictReadProfileEnv (transport env seam)', () => {
    const runDir = '/tmp/helm-run-iso-env';
    // Create own dir so realpath at binary would succeed; env compose only checks shape.
    const allow = composeSeatDraftReadAllow({
      runDir,
      seatId: 'seat-a',
      peerSeatIds: ['seat-b'],
      deploymentAllow: ['/usr'],
    });
    const env = makeStrictReadProfileEnv(allow);
    expect(env).toMatch(/^HELM_SANDBOX_RO_PROFILE=strict HELM_SANDBOX_RO_ALLOW='/);
    expect(env).toContain(seatDraftDir(runDir, 'seat-a'));
    expect(env).not.toContain(seatDraftDir(runDir, 'seat-b'));
  });
});

// ---------------------------------------------------------------------------
// typed-BLOCK before any tmux side effect (RealTransport + FakeTransport)
// ---------------------------------------------------------------------------
describe('transport: overlapping/widening allowlist typed-BLOCK before tmux (R2.6)', () => {
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

  it('RealTransport: compose throws on peer overlap → no createSession / no sendCommand', async () => {
    const prevFake = process.env.USE_FAKE_TMUX;
    delete process.env.USE_FAKE_TMUX;
    const runDir = makeTmpTemp('helm-d2-rt-run-');
    const fenceDir = makeTmpTemp('helm-d2-rt-fence-');
    const fakeTmux = makeCaptureTmux();
    const transport = new RealTransport({
      tmux: fakeTmux as any,
      artifacts: { recordDispatch: () => 0 } as any,
      resolver: new ProviderResolverService(),
    });

    try {
      let allow: string[] | undefined;
      try {
        allow = composeSeatDraftReadAllow({
          runDir,
          seatId: 'seat-a',
          peerSeatIds: ['seat-b'],
          contextInputs: [seatDraftDir(runDir, 'seat-b')], // overlap
        });
      } catch (e) {
        expect(e).toBeInstanceOf(SeatDraftIsolationError);
        expect((e as SeatDraftIsolationError).code).toBe(SEAT_DRAFT_ISOLATION);
      }
      expect(allow).toBeUndefined();

      // Empty allowlist also refused at transport env seam before tmux.
      await expect(
        transport.spawn({
          role: 'deliberation',
          brief: 'must not spawn',
          runDir,
          batchId: 'd2-iso-block',
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          projectDir: fenceDir,
          strictReadAllow: [],
        }),
      ).rejects.toThrow(/non-empty/);

      expect(fakeTmux.created.length).toBe(0);
      expect(fakeTmux.commands.length).toBe(0);
    } finally {
      if (prevFake === undefined) delete process.env.USE_FAKE_TMUX;
      else process.env.USE_FAKE_TMUX = prevFake;
    }
  });

  it('RealTransport: valid seat allowlist lands in fenced launch (own dir yes, peer no)', async () => {
    const prevFake = process.env.USE_FAKE_TMUX;
    delete process.env.USE_FAKE_TMUX;
    const runDir = makeTmpTemp('helm-d2-rt-ok-run-');
    const fenceDir = makeTmpTemp('helm-d2-rt-ok-fence-');
    // Ensure own dir exists (realpath later); peer dir also created for contrast.
    fs.mkdirSync(seatDraftDir(runDir, 'seat-a'), { recursive: true });
    fs.mkdirSync(seatDraftDir(runDir, 'seat-b'), { recursive: true });

    const allow = composeSeatDraftReadAllow({
      runDir,
      seatId: 'seat-a',
      peerSeatIds: ['seat-b'],
      deploymentAllow: SYS_ALLOW.length ? [SYS_ALLOW[0]] : ['/usr'],
    });

    const fakeTmux = makeCaptureTmux();
    const transport = new RealTransport({
      tmux: fakeTmux as any,
      artifacts: { recordDispatch: () => 0 } as any,
      resolver: new ProviderResolverService(),
    });

    try {
      try {
        await transport.spawn({
          role: 'deliberation',
          brief: 'draft seat A',
          runDir,
          batchId: 'd2-iso-ok',
          provider: 'claude',
          model: 'claude-sonnet-4-6',
          projectDir: fenceDir,
          strictReadAllow: allow,
        });
      } catch {
        // dispatch.start may reject after fenced launch is sent; we only need the launch cmd.
      }
      const cmd = fakeTmux.commands.find((c: string) => c.includes('helm-sandbox')) ?? '';
      expect(cmd).toBeTruthy();
      expect(cmd).toContain('HELM_SANDBOX_RO_PROFILE=strict');
      expect(cmd).toContain(seatDraftDir(runDir, 'seat-a'));
      expect(cmd).not.toContain(seatDraftDir(runDir, 'seat-b'));
      // strict env precedes sandbox bin
      const strictIdx = cmd.indexOf('HELM_SANDBOX_RO_PROFILE=strict');
      const binIdx = cmd.search(/\/\S*helm-sandbox\b/);
      expect(strictIdx).toBeGreaterThanOrEqual(0);
      expect(binIdx).toBeGreaterThan(strictIdx);
      expect(fakeTmux.created.length).toBeGreaterThan(0);
    } finally {
      if (prevFake === undefined) delete process.env.USE_FAKE_TMUX;
      else process.env.USE_FAKE_TMUX = prevFake;
    }
  });

  it('FakeTransport: records strictReadAllow; compose-fail never reaches spawn', async () => {
    const prev = process.env.USE_FAKE_TMUX;
    process.env.USE_FAKE_TMUX = '1';
    try {
      const runDir = makeTmpTemp('helm-d2-fake-run-');
      const transport = new FakeTransport();

      expect(() =>
        composeSeatDraftReadAllow({
          runDir,
          seatId: 'seat-a',
          peerSeatIds: ['seat-b'],
          contextInputs: [path.resolve(runDir)], // widen
        }),
      ).toThrow(SeatDraftIsolationError);
      expect(transport.spawnCalls.length).toBe(0);

      const allow = composeSeatDraftReadAllow({
        runDir,
        seatId: 'seat-a',
        peerSeatIds: ['seat-b'],
        deploymentAllow: ['/usr'],
      });
      await transport.spawn({
        role: 'deliberation',
        brief: 'fake draft',
        runDir,
        strictReadAllow: allow,
      });
      expect(transport.spawnCalls.length).toBe(1);
      expect(transport.spawnCalls[0].strictReadAllow).toEqual(allow);
      expect(transport.spawnCalls[0].strictReadAllow).not.toContain(seatDraftDir(runDir, 'seat-b'));
    } finally {
      if (prev === undefined) delete process.env.USE_FAKE_TMUX;
      else process.env.USE_FAKE_TMUX = prev;
    }
  });
});

// ---------------------------------------------------------------------------
// Compiled sandbox: process-level cat/ls denial across seats
// ---------------------------------------------------------------------------
describe('binary sandbox: seat A cannot cat/ls seat B draft (R2.6 kernel)', () => {
  let runDir = '';
  let fenceDir = '';
  let contextFile = '';

  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error(
        `seat-draft isolation test requires built binary at ${BIN} (run npm run build first)`,
      );
    }
  });

  beforeEach(() => {
    runDir = makeHomeTemp('helm-d2-sandbox-run-');
    fenceDir = makeHomeTemp('helm-d2-sandbox-fence-');
    // Neutral fence project (does not contain peer drafts).
    fs.writeFileSync(path.join(fenceDir, 'package.json'), '{"name":"d2-fence"}\n');

    // Seat A + B draft dirs with secrets.
    atomicWriteFile(draftPlanPath(runDir, 'seat-a'), '# plan A\nOWN-DRAFT-A-OK\n');
    atomicWriteFile(draftReqPath(runDir, 'seat-a'), '# req A\nOWN-REQ-A-OK\n');
    atomicWriteFile(draftPlanPath(runDir, 'seat-b'), '# plan B\nPEER-DRAFT-B-SECRET\n');
    atomicWriteFile(draftReqPath(runDir, 'seat-b'), '# req B\nPEER-REQ-B-SECRET\n');

    contextFile = path.join(makeHomeTemp('helm-d2-ctx-'), 'north-star.md');
    fs.writeFileSync(contextFile, 'CONTEXT-NORTH-STAR-OK\n');
  });

  type RunResult = { status: number | null; stdout: string; stderr: string };

  function runStrict(allow: string[], bashCmd: string): RunResult {
    const r = spawnSync(BIN, [fenceDir, 'bash', '-c', bashCmd], {
      encoding: 'utf8',
      timeout: 15000,
      env: {
        ...process.env,
        HELM_SANDBOX_RO_PROFILE: 'strict',
        HELM_SANDBOX_RO_ALLOW: allow.join(':'),
      },
      cwd: fenceDir,
    });
    return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  it('seat A process can read own draft + context; cannot cat or ls seat B draft dir', () => {
    // Ensure all allowlisted paths exist for realpath (SYS_ALLOW already exists).
    const allow = composeSeatDraftReadAllow({
      runDir,
      seatId: 'seat-a',
      peerSeatIds: ['seat-b'],
      contextInputs: [contextFile],
      deploymentAllow: SYS_ALLOW,
    });

    // Own plan + context readable.
    const rOwn = runStrict(
      allow,
      `cat ${draftPlanPath(runDir, 'seat-a')} && cat ${contextFile}`,
    );
    expect(rOwn.status).toBe(0);
    expect(rOwn.stdout).toContain('OWN-DRAFT-A-OK');
    expect(rOwn.stdout).toContain('CONTEXT-NORTH-STAR-OK');

    // Peer plan cat denied.
    const rCat = runStrict(allow, `cat ${draftPlanPath(runDir, 'seat-b')}`);
    expect(rCat.status).not.toBe(0);
    expect(rCat.stdout).not.toContain('PEER-DRAFT-B-SECRET');
    expect(rCat.stderr).toMatch(/[Pp]ermission denied|Permission denied/);

    // Peer dir listing denied.
    const rLs = runStrict(allow, `ls ${seatDraftDir(runDir, 'seat-b')}`);
    expect(rLs.status).not.toBe(0);
    expect(rLs.stdout).not.toContain('draft-seat-b');
    expect(rLs.stderr).toMatch(/[Pp]ermission denied|Permission denied/);

    // Own dir listing works.
    const rLsOwn = runStrict(allow, `ls ${seatDraftDir(runDir, 'seat-a')}`);
    expect(rLsOwn.status).toBe(0);
    expect(rLsOwn.stdout).toMatch(/draft-seat-a/);
  });

  it('seat B symmetric: cannot read seat A', () => {
    const allow = composeSeatDraftReadAllow({
      runDir,
      seatId: 'seat-b',
      peerSeatIds: ['seat-a'],
      contextInputs: [contextFile],
      deploymentAllow: SYS_ALLOW,
    });
    const r = runStrict(allow, `cat ${draftPlanPath(runDir, 'seat-a')}`);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('OWN-DRAFT-A-OK');
  });
});

// ---------------------------------------------------------------------------
// Engine publishDraft — outside sandbox, both seats readable once committed
// ---------------------------------------------------------------------------
describe('publishDraft — engine rehash after commit (R2.6 / R2.7)', () => {
  it('engine reads both seats via publishDraft after atomic commit', () => {
    const runDir = makeTmpTemp('helm-d2-publish-');
    const planA = Buffer.from('# plan A\nengine-visible-a\n');
    const reqA = Buffer.from('# req A\n');
    const planB = Buffer.from('# plan B\nengine-visible-b\n');
    const reqB = Buffer.from('# req B\n');

    atomicWriteFile(draftPlanPath(runDir, 'seat-a'), planA);
    atomicWriteFile(draftReqPath(runDir, 'seat-a'), reqA);
    atomicWriteFile(draftPlanPath(runDir, 'seat-b'), planB);
    atomicWriteFile(draftReqPath(runDir, 'seat-b'), reqB);

    const pubA = publishDraft(runDir, 'seat-a');
    const pubB = publishDraft(runDir, 'seat-b');

    expect(pubA.seatId).toBe('seat-a');
    expect(pubB.seatId).toBe('seat-b');
    expect(pubA.plan).toEqual(planRevision(planA));
    expect(pubA.req).toEqual(planRevision(reqA));
    expect(pubB.plan).toEqual(planRevision(planB));
    expect(pubB.req).toEqual(planRevision(reqB));
    expect(pubA.plan!.sha256).not.toBe(pubB.plan!.sha256);

    // Missing seat → null revisions, no throw.
    const missing = publishDraft(runDir, 'seat-missing');
    expect(missing.plan).toBeNull();
    expect(missing.req).toBeNull();
  });
});
