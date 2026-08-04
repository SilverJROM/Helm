/**
 * B9 (R4.1/R4.3) — thread the B7/B8 cycle git capability to CYCLE SEATS ONLY: implementer,
 * validator, and final-validation, via RealTransport's fencedLaunch composition, the
 * ITransport/FakeTransport contract, and OrchestratorLoop's dispatch call sites. Master-runtime
 * spawns, chat sessions, and non-cycle workers must never carry the git env; under the strict
 * read profile the git common dir's READ path must also be folded into HELM_SANDBOX_RO_ALLOW.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { RealTransport } from './real-transport.js';
import { FakeTransport } from './fake-transport.js';
import { OrchestratorLoop } from './orchestrator-loop.js';
import { ProviderResolverService } from './provider-resolver-service.js';
import type { CycleGitAllowCycle } from '../security/landlock-sandbox.js';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

interface Fixture {
  root: string;
  projectDir: string;
  common: string;
  worktreePath: string;
  worktreeId: string;
  cycleId: number;
}

const fixtures: string[] = [];

/** Mirrors B8's cycle-git-allow-env.test.ts fixture: a real temp repo with a cycle worktree + namespaced refs. */
function makeFixture(label: string, cycleId = 41): Fixture {
  const root = fs.mkdtempSync(path.join(os.homedir(), `helm-b9-seat-thread-${label}-`));
  fixtures.push(root);

  const projectDir = path.join(root, 'proj');
  fs.mkdirSync(projectDir, { recursive: true });
  git(projectDir, ['init', '-q', '-b', 'main']);
  git(projectDir, ['config', 'user.email', 'b9@test']);
  git(projectDir, ['config', 'user.name', 'b9']);
  fs.writeFileSync(path.join(projectDir, 'f.txt'), 'hello\n');
  git(projectDir, ['add', 'f.txt']);
  git(projectDir, ['commit', '-q', '-m', 'init']);

  const worktreePath = path.join(projectDir, 'cycle', '.worktrees', String(cycleId));
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(projectDir, ['worktree', 'add', '-q', '-b', `helm/cycle/${cycleId}/feat`, worktreePath, 'main']);

  const common = git(projectDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

  const readId = (wt: string): string => {
    const content = fs.readFileSync(path.join(wt, '.git'), 'utf8');
    const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) throw new Error(`no gitdir in ${wt}`);
    return path.basename(m[1].trim());
  };
  const worktreeId = readId(worktreePath);

  // B6 pre-creates the namespaced reflog dir; refs dir exists from worktree add.
  const refDir = path.join(common, 'refs', 'heads', 'helm', 'cycle', String(cycleId));
  const logDir = path.join(common, 'logs', 'refs', 'heads', 'helm', 'cycle', String(cycleId));
  fs.mkdirSync(refDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  return {
    root,
    projectDir: fs.realpathSync(projectDir),
    common: fs.realpathSync(common),
    worktreePath: fs.realpathSync(worktreePath),
    worktreeId,
    cycleId,
  };
}

function identityFor(f: Fixture): CycleGitAllowCycle {
  return {
    id: f.cycleId,
    git_worktree_path: f.worktreePath,
    git_worktree_id: f.worktreeId,
    projectDir: f.projectDir,
  };
}

afterEach(() => {
  while (fixtures.length) {
    const d = fixtures.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

function makeCaptureTmux() {
  const fake: any = {
    commands: [] as string[],
    created: [] as string[],
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
    sendAndSubmit: async () => true,
    sendDispatchInstruction: async () => true,
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

describe('B9 RealTransport — cycle git capability threading (R4.1/R4.3)', () => {
  let savedFake: string | undefined;
  let runDir: string;

  beforeEach(() => {
    savedFake = process.env.USE_FAKE_TMUX;
    delete process.env.USE_FAKE_TMUX; // RealTransport requires the non-fake path
    runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b9-real-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {}
    if (savedFake !== undefined) process.env.USE_FAKE_TMUX = savedFake;
    else delete process.env.USE_FAKE_TMUX;
  });

  function newTransport() {
    const tmux = makeCaptureTmux();
    const transport = new RealTransport({
      tmux: tmux as any,
      artifacts: { recordDispatch: () => 0 } as any,
      resolver: new ProviderResolverService(),
    });
    return { transport, tmux };
  }

  it('implementer seat with a persisted cycle identity carries all four GIT_* env vars in the composed launch', async () => {
    const f = makeFixture('impl');
    const { transport, tmux } = newTransport();
    try {
      await transport.spawn({
        role: 'implementer',
        brief: 'impl brief',
        runDir,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        projectDir: f.projectDir,
        cycleGitIdentity: identityFor(f),
      });
    } catch {
      // dispatch may fail post-write (no real tmux driving a callback); the composed launch is
      // captured by tmux.sendCommand regardless, which is all this assertion needs.
    }
    expect(tmux.commands.length).toBeGreaterThan(0);
    const launch = tmux.commands[0];
    expect(launch).toContain('HELM_SANDBOX_GIT_RO=');
    expect(launch).toContain('HELM_SANDBOX_GIT_ADMIN=');
    expect(launch).toContain('HELM_SANDBOX_GIT_REF_RW=');
    expect(launch).toContain('HELM_SANDBOX_GIT_OBJ=');
  });

  it('validator seat with a persisted cycle identity carries all four GIT_* env vars in the composed launch', async () => {
    const f = makeFixture('val');
    const { transport, tmux } = newTransport();
    try {
      await transport.spawn({
        role: 'validator',
        brief: 'val brief',
        runDir,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        projectDir: f.projectDir,
        cycleGitIdentity: identityFor(f),
      });
    } catch {}
    const launch = tmux.commands[0];
    expect(launch).toContain('HELM_SANDBOX_GIT_RO=');
    expect(launch).toContain('HELM_SANDBOX_GIT_ADMIN=');
    expect(launch).toContain('HELM_SANDBOX_GIT_REF_RW=');
    expect(launch).toContain('HELM_SANDBOX_GIT_OBJ=');
  });

  it('NEGATIVE — a master-runtime-shaped spawn (no cycleGitIdentity) carries none of the git env', async () => {
    const { transport, tmux } = newTransport();
    try {
      await transport.spawn({
        role: 'ibrain',
        brief: 'brain-decision brief',
        runDir,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        // no projectDir, no cycleGitIdentity — master-runtime never threads either through this path
      });
    } catch {}
    const launch = tmux.commands[0];
    expect(launch).not.toMatch(/HELM_SANDBOX_GIT_/);
  });

  it('NEGATIVE — a chat-session-shaped spawn (no cycleGitIdentity) carries none of the git env', async () => {
    const { transport, tmux } = newTransport();
    try {
      await transport.spawn({
        role: 'discovery',
        brief: 'discovery chat brief',
        runDir,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
      });
    } catch {}
    const launch = tmux.commands[0];
    expect(launch).not.toMatch(/HELM_SANDBOX_GIT_/);
  });

  it('NEGATIVE — a non-cycle worker (implementer role, no cycleGitIdentity) carries none of the git env', async () => {
    const f = makeFixture('noncycle');
    const { transport, tmux } = newTransport();
    try {
      await transport.spawn({
        role: 'implementer',
        brief: 'legacy project run, no cycle identity',
        runDir,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        projectDir: f.projectDir, // a registered project dir alone must not imply git access
      });
    } catch {}
    const launch = tmux.commands[0];
    expect(launch).not.toMatch(/HELM_SANDBOX_GIT_/);
  });

  it('a strict-profile launch with a cycle identity also carries the git common-dir READ path in HELM_SANDBOX_RO_ALLOW', async () => {
    const f = makeFixture('strict');
    const { transport, tmux } = newTransport();
    const appOnlyAllow = path.join(f.root, 'app-only-allow');
    fs.mkdirSync(appOnlyAllow, { recursive: true });
    try {
      await transport.spawn({
        role: 'implementer',
        brief: 'strict brief',
        runDir,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        projectDir: f.projectDir,
        cycleGitIdentity: identityFor(f),
        strictReadAllow: [fs.realpathSync(appOnlyAllow)],
      });
    } catch {}
    const launch = tmux.commands[0];
    expect(launch).toContain('HELM_SANDBOX_RO_PROFILE=strict');
    const m = launch.match(/HELM_SANDBOX_RO_ALLOW='([^']*)'/);
    expect(m).toBeTruthy();
    const allowList = (m as RegExpMatchArray)[1].split(':');
    expect(allowList).toContain(fs.realpathSync(appOnlyAllow));
    expect(allowList).toContain(f.common); // the git RO anchor, folded in for this strict-profile seat
  });

  it('strict profile WITHOUT a cycle identity never injects a git path (no spurious widening)', async () => {
    const { transport, tmux } = newTransport();
    const appOnlyAllow = fs.mkdtempSync(path.join(os.homedir(), 'helm-b9-strict-noident-'));
    fixtures.push(appOnlyAllow);
    try {
      await transport.spawn({
        role: 'implementer',
        brief: 'strict brief no identity',
        runDir,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        strictReadAllow: [fs.realpathSync(appOnlyAllow)],
      });
    } catch {}
    const launch = tmux.commands[0];
    const m = launch.match(/HELM_SANDBOX_RO_ALLOW='([^']*)'/);
    expect(m).toBeTruthy();
    expect((m as RegExpMatchArray)[1].split(':')).toEqual([fs.realpathSync(appOnlyAllow)]);
    expect(launch).not.toMatch(/HELM_SANDBOX_GIT_/);
  });

  it('a MISMATCHED identity (worktree not under the registered project) fails the spawn closed before any session is created', async () => {
    const f = makeFixture('mismatch');
    const otherProject = fs.mkdtempSync(path.join(f.root, 'other-proj-'));
    const { transport, tmux } = newTransport();
    await expect(
      transport.spawn({
        role: 'implementer',
        brief: 'mismatched identity',
        runDir,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        projectDir: otherProject, // does not contain the worktree
        cycleGitIdentity: { ...identityFor(f), projectDir: otherProject },
      })
    ).rejects.toThrow(/does not belong to the registered project/);
    expect(tmux.created.length).toBe(0);
    expect(tmux.commands.length).toBe(0);
  });

  it('a STALE identity (worktree removed from disk) fails the spawn closed before any session is created', async () => {
    const f = makeFixture('stale');
    // Simulate the worktree having been cleaned up while the cycle row still references it.
    fs.rmSync(f.worktreePath, { recursive: true, force: true });
    const { transport, tmux } = newTransport();
    await expect(
      transport.spawn({
        role: 'validator',
        brief: 'stale identity',
        runDir,
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        projectDir: f.projectDir,
        cycleGitIdentity: identityFor(f),
      })
    ).rejects.toThrow(/does not resolve/);
    expect(tmux.created.length).toBe(0);
    expect(tmux.commands.length).toBe(0);
  });
});

describe('B9 FakeTransport — cycle git capability threading (R4.1/R4.3)', () => {
  let savedFake: string | undefined;

  beforeEach(() => {
    savedFake = process.env.USE_FAKE_TMUX;
    process.env.USE_FAKE_TMUX = '1';
  });

  afterEach(() => {
    if (savedFake !== undefined) process.env.USE_FAKE_TMUX = savedFake;
    else delete process.env.USE_FAKE_TMUX;
  });

  it('a git-capable cycle seat carries the git env in FakeTransport.spawnCalls', async () => {
    const f = makeFixture('fake-happy');
    const transport = new FakeTransport();
    const { handle } = await transport.spawn({
      role: 'implementer',
      brief: 'impl',
      runDir: f.root,
      cycleGitIdentity: identityFor(f),
    });
    expect(handle).toBeTruthy();
    expect(transport.spawnCalls).toHaveLength(1);
    const call = transport.spawnCalls[0];
    expect(call.gitAllowEnv).toBeTruthy();
    expect(call.gitAllowEnv).toContain('HELM_SANDBOX_GIT_RO=');
    expect(call.gitAllowEnv).toContain('HELM_SANDBOX_GIT_ADMIN=');
    expect(call.gitAllowEnv).toContain('HELM_SANDBOX_GIT_REF_RW=');
    expect(call.gitAllowEnv).toContain('HELM_SANDBOX_GIT_OBJ=');
  });

  it('NEGATIVE — FakeTransport.spawn without cycleGitIdentity carries none of the git env', async () => {
    const transport = new FakeTransport();
    await transport.spawn({ role: 'discovery', brief: 'chat', runDir: '/tmp/whatever' });
    expect(transport.spawnCalls).toHaveLength(1);
    expect(transport.spawnCalls[0].gitAllowEnv).toBeUndefined();
  });

  it('a stale/mismatched identity fails FakeTransport.spawn closed and leaves no trace', async () => {
    const f = makeFixture('fake-stale');
    fs.rmSync(f.worktreePath, { recursive: true, force: true });
    const transport = new FakeTransport();
    await expect(
      transport.spawn({
        role: 'validator',
        brief: 'stale',
        runDir: f.root,
        cycleGitIdentity: identityFor(f),
      })
    ).rejects.toThrow(/does not resolve/);
    expect(transport.spawnCalls).toHaveLength(0);
  });
});

describe('B9 OrchestratorLoop — threads the persisted cycle identity to cycle seats only (R4.1/R4.3)', () => {
  let savedFake: string | undefined;
  let runDir: string;
  let transport: FakeTransport;

  beforeEach(async () => {
    savedFake = process.env.USE_FAKE_TMUX;
    process.env.USE_FAKE_TMUX = '1';
    runDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'helm-b9-loop-'));
    await fsp.writeFile(path.join(runDir, 'callbacks.md'), '# B9 loop callbacks\n', 'utf8');
    transport = new FakeTransport();
  });

  afterEach(async () => {
    if (runDir) await fsp.rm(runDir, { recursive: true, force: true }).catch(() => {});
    if (savedFake !== undefined) process.env.USE_FAKE_TMUX = savedFake;
    else delete process.env.USE_FAKE_TMUX;
  });

  it('implementer AND validator dispatch both carry the git env when the loop holds a persisted cycle identity', async () => {
    const f = makeFixture('loop-implval');
    const loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B9git',
      projectDir: f.projectDir,
      cycleGitIdentity: identityFor(f),
    });

    const p = loop.execute('Implement thing.');
    const cbp = path.join(runDir, 'callbacks.md');
    await fsp.appendFile(cbp, `[helm callback] implementer batch-B9git STATUS: DONE — done\n`);
    await sleep(80);
    await fsp.appendFile(cbp, `[helm callback] validator batch-B9git STATUS: PASS — pass\n`);
    await sleep(80);
    await p;

    const implCall = transport.spawnCalls.find((c) => c.role === 'implementer');
    const valCall = transport.spawnCalls.find((c) => c.role === 'validator');
    expect(implCall?.gitAllowEnv).toContain('HELM_SANDBOX_GIT_RO=');
    expect(valCall?.gitAllowEnv).toContain('HELM_SANDBOX_GIT_RO=');
  });

  it('the final-validation seat carries projectDir AND the git env (the seam that previously omitted projectDir entirely)', async () => {
    const f = makeFixture('loop-finalval');
    const loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B9fv',
      projectDir: f.projectDir,
      cycleGitIdentity: identityFor(f),
    });

    const finalValPromise = (loop as any).performFinalRunValidation();
    finalValPromise.catch(() => {}); // the wait loop will time out (no callback fed) — only the spawn matters here

    let call: any = null;
    for (let i = 0; i < 50 && !call; i++) {
      call = transport.spawnCalls.find((c) => c.brief.includes('DSP9 final run-level validation'));
      if (!call) await sleep(20);
    }
    expect(call).toBeTruthy();
    expect(call.projectDir).toBe(f.projectDir);
    expect(call.gitAllowEnv).toContain('HELM_SANDBOX_GIT_RO=');
    expect(call.gitAllowEnv).toContain('HELM_SANDBOX_GIT_ADMIN=');
    expect(call.gitAllowEnv).toContain('HELM_SANDBOX_GIT_REF_RW=');
    expect(call.gitAllowEnv).toContain('HELM_SANDBOX_GIT_OBJ=');
  });

  it('NEGATIVE — a non-cycle-seat role (reviewer) dispatched by the SAME loop carries none of the git env, even though the loop holds an identity', async () => {
    const f = makeFixture('loop-reviewer');
    const loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B9rev',
      projectDir: f.projectDir,
      cycleGitIdentity: identityFor(f),
    });

    const p = (loop as any).performRolePhase('reviewer', 'review this diff', ['APPROVE']);
    const cbp = path.join(runDir, 'callbacks.md');
    await sleep(60);
    await fsp.appendFile(cbp, `[helm callback] reviewer batch-B9rev STATUS: APPROVE — looks good\n`);
    await p;

    const reviewCall = transport.spawnCalls.find((c) => c.role === 'reviewer');
    expect(reviewCall).toBeTruthy();
    expect(reviewCall?.gitAllowEnv).toBeUndefined();
    expect(reviewCall?.cycleGitIdentity).toBeUndefined();
  });
});
