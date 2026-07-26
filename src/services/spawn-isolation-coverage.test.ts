/**
 * B4-T04 (R-H1): spawn isolation coverage-lock + opt-in live probe.
 *
 * Coverage-lock: table-driven regression guard — each Helm spawn service must construct
 * claude launch commands with envelope isolation markers (3 disable-envs, --setting-sources '',
 * --append-system-prompt) and must NOT use --bare or CLAUDE_CONFIG_DIR.
 *
 * Live isolation probe (skipped by default — requires real claude CLI + tmux):
 *   HELM_LIVE_ISOLATION_PROBE=1 npx vitest run src/services/spawn-isolation-coverage.test.ts -t "live isolation probe"
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { DatabaseService } from '../db/database.js';
import { AgentEventsService } from './agent-events-service.js';
import { ProviderResolverService } from './provider-resolver-service.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { RealTransport } from './real-transport.js';
import { ChatSessionService } from './chat-session-service.js';
import { MasterRuntimeService } from './master-runtime-service.js';
import { MasterModelService } from './master-model-service.js';
import { WorkerService } from './worker-service.js';
import { ModelService } from './model-service.js';
import { ModelValidationService, type CommandRunner } from './model-validation-service.js';
import { HELM_ENVELOPE_DIRECTIVE } from './envelope-isolation.js';
import { TmuxService } from '../tmux/tmux-service.js';

// Default fake-tmux for services that honour USE_FAKE_TMUX shortcuts (master/chat-session).
// real-transport forbids USE_FAKE_TMUX=1; worker polls capturePane for '>' (no fake shortcut).

const CLAUDE_LAUNCH = 'claude --model claude-sonnet-4-6 --dangerously-skip-permissions';
const PROBE_PROMPT =
  'Do you see a CLAUDE.md? List any projcore/lead/coord agents you can see. Reply briefly.';

function assertClaudeIsolationOnShellCmd(cmd: string) {
  expect(cmd).toMatch(/CLAUDE_CODE_DISABLE_CLAUDE_MDS=1/);
  expect(cmd).toMatch(/CLAUDE_CODE_DISABLE_AUTO_MEMORY=1/);
  expect(cmd).toMatch(/CLAUDE_CODE_DISABLE_BUNDLED_SKILLS=1/);
  expect(cmd).toContain("--setting-sources ''");
  expect(cmd).toContain('--append-system-prompt');
  expect(cmd).not.toContain('--bare');
  expect(cmd).not.toContain('CLAUDE_CONFIG_DIR');
  const sandboxIdx = cmd.search(/helm-sandbox\S*\s/);
  const disableIdx = cmd.indexOf('CLAUDE_CODE_DISABLE_CLAUDE_MDS=1');
  expect(disableIdx).toBeGreaterThanOrEqual(0);
  expect(disableIdx).toBeLessThan(sandboxIdx);
}

function assertClaudeIsolationOnCliArgs(args: string[], env?: NodeJS.ProcessEnv) {
  expect(args).toContain('--setting-sources');
  expect(args).toContain('');
  expect(args).toContain('--append-system-prompt');
  expect(args).toContain(HELM_ENVELOPE_DIRECTIVE);
  const joined = args.join(' ');
  expect(joined).not.toContain('--bare');
  expect(joined).not.toContain('CLAUDE_CONFIG_DIR');
  if (env) {
    expect(env.CLAUDE_CODE_DISABLE_CLAUDE_MDS).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    expect(env.CLAUDE_CODE_DISABLE_BUNDLED_SKILLS).toBe('1');
  }
}

function makeCaptureTmux(paneContent = 'bypass permissions on (shift+tab to cycle)\n❯ > ready\n') {
  const fake: any = {
    commands: [] as string[],
    createSession: async (name: string) => `${name}:0.0`,
    sendCommand: async (_t: string, cmd: string) => {
      fake.commands.push(cmd);
      return { message: 'sent', blocked: false };
    },
    waitForReady: async () => true,
    sendEnter: async () => ({}),
    sendKeys: async () => ({}),
    sendAndSubmit: async () => true,
    verifyMarkerPresent: async () => true,
    terminateSession: async () => {},
    clearContext: async () => ({}),
    capturePane: async () => paneContent,
    sessionExists: async () => false,
    getPanePid: async () => '12345',
    composerHoldsText: async () => false,
    resubmitIfComposerHeld: async () => false,
  };
  return fake;
}

function makeTempProjectDb() {
  const helmDbPath = `/tmp/helm-b4t04-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
  const helmDb = new DatabaseService(helmDbPath);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b4t04-proj-'));
  helmDb.raw.prepare('INSERT OR REPLACE INTO projects (id, name, directory) VALUES (?,?,?)').run(
    1,
    'b4t04-coverage',
    projectDir
  );
  return { helmDb, helmDbPath, projectDir, cleanup: () => {
    try { helmDb.close(); } catch {}
    try { fs.unlinkSync(helmDbPath); } catch {}
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  } };
}

describe('B4-T04: spawn isolation coverage-lock (all 5 spawn services)', () => {
  const cases = [
    {
      service: 'real-transport',
      build: async () => {
        const prevFake = process.env.USE_FAKE_TMUX;
        delete process.env.USE_FAKE_TMUX;
        const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b4t04-rt-'));
        const fenceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b4t04-fence-'));
        const fakeTmux = makeCaptureTmux();
        try {
          const transport = new RealTransport({
            tmux: fakeTmux,
            artifacts: { recordDispatch: () => 0 } as any,
            resolver: new ProviderResolverService(),
          });
          try {
            await transport.spawn({
              role: 'implementer',
              brief: 'coverage-lock brief',
              runDir,
              batchId: 'b4t04-rt',
              provider: 'claude',
              model: 'claude-sonnet-4-6',
              projectDir: fenceDir,
            });
          } catch {
            // dispatch.start may fail brief-contract validation after launch cmd is sent;
            // coverage-lock only needs the fenced launch command from sendCommand.
          }
          const launchCmd = fakeTmux.commands.find((c: string) => c.includes('claude --model')) ?? '';
          return { kind: 'shell' as const, cmd: launchCmd, cleanup: () => {
            try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
            try { fs.rmSync(fenceDir, { recursive: true, force: true }); } catch {}
            if (prevFake === undefined) delete process.env.USE_FAKE_TMUX;
            else process.env.USE_FAKE_TMUX = prevFake;
          } };
        } catch (e) {
          if (prevFake === undefined) delete process.env.USE_FAKE_TMUX;
          else process.env.USE_FAKE_TMUX = prevFake;
          throw e;
        }
      },
    },
    {
      service: 'chat-session-service',
      build: async () => {
        process.env.USE_FAKE_TMUX = '1';
        const fakeTmux = makeCaptureTmux();
        const agent = {
          id: 1,
          name: 'iso-chat-agent',
          provider: 'claude' as const,
          model: 'claude-sonnet-4-6',
          default_model_id: null,
          backup_model_id: null,
          definition_md: '---\nrole: test\n---\n# test',
        };
        const svc = new ChatSessionService({
          tmux: fakeTmux,
          modelService: { getModel: () => null } as any,
          assignmentService: { getAgent: (id: number) => (id === 1 ? agent : null) } as any,
          resolverService: {
            resolveAgentLaunchSpec: (req: any) => ({
              provider: req.provider,
              model: req.model,
              launch_cmd: CLAUDE_LAUNCH,
              bypass_flag: null,
              effort_flag: null,
              callback_mechanism: 'pane',
              session_suffix: 'claude',
              worktree_support: { supported: false, flag: null },
            }),
          } as any,
        });
        await svc.create(1);
        return { kind: 'shell' as const, cmd: fakeTmux.commands[0] ?? '', cleanup: undefined };
      },
    },
    {
      service: 'master-runtime-service',
      build: async () => {
        process.env.USE_FAKE_TMUX = '1';
        const { helmDb, helmDbPath, projectDir, cleanup } = makeTempProjectDb();
        const events = new AgentEventsService(helmDb);
        const resolver = new ProviderResolverService();
        const masterModels = new MasterModelService(helmDb);
        masterModels.setChain(1, [{ provider: 'grok', model: 'grok-4.5' }]);
        const fakeTmux = makeCaptureTmux();
        const runtime = new MasterRuntimeService(helmDb, events, fakeTmux as any, resolver, masterModels);
        await runtime.launchMaster(1, { provider: 'claude', model: 'claude-sonnet-4-6' });
        const launchCmd = fakeTmux.commands.find((c: string) => c.includes('claude --model')) ?? '';
        return { kind: 'shell' as const, cmd: launchCmd, cleanup: () => { cleanup(); try { fs.unlinkSync(helmDbPath); } catch {} } };
      },
    },
    {
      service: 'worker-service',
      build: async () => {
        const { helmDb, helmDbPath, cleanup } = makeTempProjectDb();
        const events = new AgentEventsService(helmDb);
        const resolver = new ProviderResolverService();
        const assignment = new AgentAssignmentService(helmDb);
        const claude = assignment.createAgent({
          name: `b4t04-worker-${Math.random().toString(36).slice(2)}`,
          provider: 'claude',
          model: 'claude-sonnet-4-6',
        });
        assignment.setRoleDefault('validator', claude.id);
        const fakeTmux = makeCaptureTmux();
        const worker = new WorkerService(helmDb, events, fakeTmux as any, resolver, assignment);
        await worker.spawnWorker({ projectId: 1, role: 'validator', taskBrief: 'coverage-lock worker brief' });
        const launchCmd = fakeTmux.commands.find((c: string) => c.includes('claude --model')) ?? '';
        return { kind: 'shell' as const, cmd: launchCmd, cleanup: () => { cleanup(); try { fs.unlinkSync(helmDbPath); } catch {} } };
      },
    },
    {
      service: 'model-validation-service',
      build: async () => {
        const { dbPath, cleanup } = (() => {
          const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b4t04-mv-'));
          return { dbPath: path.join(dir, 'test.db'), cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} } };
        })();
        const db = new DatabaseService(dbPath);
        const ms = new ModelService(db);
        const model = ms.createModel({ cli: 'claude', name: 'b4t04-claude', provider: 'claude', model_id: 'claude-sonnet-4-6' });
        let capturedArgs: string[] = [];
        let capturedEnv: NodeJS.ProcessEnv | undefined;
        const runner: CommandRunner = async (_cmd, args, opts) => {
          capturedArgs = args;
          capturedEnv = opts.env;
          const prompt = args[1] ?? '';
          const m = prompt.match(/HELM_VALID_[a-f0-9]+/);
          return { stdout: m ? m[0] : '', stderr: '', code: 0 };
        };
        const svc = new ModelValidationService(db, runner, { hardWallMs: 5_000 });
        await svc.validate(model.id);
        db.close();
        return { kind: 'cli' as const, args: capturedArgs, env: capturedEnv, cleanup };
      },
    },
  ] as const;

  it.each(cases)('$service constructs isolated claude command', async ({ build }) => {
    const built = await build();
    try {
      if (built.kind === 'shell') {
        expect(built.cmd).toBeTruthy();
        expect(built.cmd).toContain('claude --model');
        assertClaudeIsolationOnShellCmd(built.cmd);
      } else {
        expect(built.args.length).toBeGreaterThan(0);
        assertClaudeIsolationOnCliArgs(built.args, built.env);
      }
    } finally {
      if ('cleanup' in built && built.cleanup) built.cleanup();
    }
  });
});

describe.skipIf(!process.env.HELM_LIVE_ISOLATION_PROBE)('B4-T04: live isolation probe (env-gated)', () => {
  let helmDbPath: string;
  let helmDb: DatabaseService;
  let tmux: TmuxService;
  let worker: WorkerService;
  let sessionName: string | null = null;
  let workerId: number | null = null;

  beforeEach(() => {
    helmDbPath = `/tmp/helm-b4t04-live-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    helmDb = new DatabaseService(helmDbPath);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b4t04-live-proj-'));
    helmDb.raw.prepare('INSERT OR REPLACE INTO projects (id, name, directory) VALUES (?,?,?)').run(1, 'live-probe', projectDir);
    const events = new AgentEventsService(helmDb);
    const resolver = new ProviderResolverService();
    const assignment = new AgentAssignmentService(helmDb);
    const claude = assignment.createAgent({
      name: `b4t04-live-${Math.random().toString(36).slice(2)}`,
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });
    assignment.setRoleDefault('implementer', claude.id);
    tmux = new TmuxService();
    worker = new WorkerService(helmDb, events, tmux, resolver, assignment);
  });

  afterEach(async () => {
    if (sessionName) {
      try { await tmux.terminateSession(sessionName); } catch {}
    }
    if (workerId != null) {
      try { await worker.reapWorker(workerId, 'live-probe-cleanup'); } catch {}
    }
    try { helmDb.close(); } catch {}
    try { fs.unlinkSync(helmDbPath); } catch {}
  });

  it('live isolation probe: spawned claude worker reports no CLAUDE.md and no operator agents', async () => {
    const spawned: any = await worker.spawnWorker({
      projectId: 1,
      role: 'implementer',
      taskBrief: PROBE_PROMPT,
      spawnedBy: 'b4t04-live-probe',
    });
    workerId = spawned.id;
    sessionName = spawned.session;
    const target = `${sessionName}:0.0`;

    const deadline = Date.now() + 120_000;
    let pane = '';
    let stable = 0;
    let prev = '';
    while (Date.now() < deadline) {
      pane = await tmux.capturePane(target, 200);
      if (pane === prev && pane.length > 80) stable++;
      else stable = 0;
      prev = pane;
      if (stable >= 4) break;
      await new Promise((r) => setTimeout(r, 2000));
    }

    expect(pane.length).toBeGreaterThan(40);
    const tail = pane.slice(-4000).toLowerCase();

    const claimsClaudeMdVisible = /(?:yes|i see|there is|found|visible|present).{0,40}claude\.md/i.test(tail);
    expect(claimsClaudeMdVisible).toBe(false);

    const listsOperatorAgents = /(?:available|can (?:see|invoke|use)|visible agents?|i have access).{0,60}(?:projcore|\/lead|\/coord|fast_lead|mockup)/i.test(tail);
    expect(listsOperatorAgents).toBe(false);
  }, 180_000);
});