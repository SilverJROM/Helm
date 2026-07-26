// A1a (seat-binary pre-flight) + A1b (per-seat command-not-found backstop).
// A1a: before a run dispatches its agents, every rostered model's launch CLI must resolve to a runnable
// binary IN A FRESH SEAT SHELL (the seat PATH can diverge from the app process env — the "binary vanished"
// bug). preflightSeatBinaries probes `command -v <bin>` in a throwaway tmux window; preflightRunRoster
// refuses the run + writes a durable record when any is missing.
// A1b: a seat launched with a missing/broken binary is caught the instant the pane shows "command not
// found" (fast, clear failed row + gate event) instead of after the full 30-60s ready-probe timeout.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { DatabaseService } from './db/database.js';
import { AgentEventsService } from './services/agent-events-service.js';
import { TmuxService } from './tmux/tmux-service.js';
import { ProviderResolverService } from './services/provider-resolver-service.js';
import { MasterModelService } from './services/master-model-service.js';
import { MasterRuntimeService } from './services/master-runtime-service.js';
import { HelmIdentityService } from './services/helm-identity-service.js';

// A fake tmux that simulates a fresh seat shell for the `command -v <bin>` probe. On sendCommand it parses
// the probed binary out of the `printf '...' <bin> "$(command -v <bin> ...)"` line and records the
// HELM_BINPROBE sentinel line (FOUND/MISSING) exactly as a real shell would print it; capturePane returns
// the accumulated buffer.
function makeProbeTmux(availableBins: Set<string>) {
  let buffer = '';
  const sessions = new Set<string>();
  return {
    createSession: async (name: string) => { sessions.add(name); return `${name}:0.0`; },
    terminateSession: async (name: string) => { sessions.delete(name); },
    sessionExists: async (name: string) => sessions.has(name),
    sendCommand: async (_t: string, cmd: string) => {
      const m = /command -v (\S+)/.exec(cmd);
      if (m) {
        const bin = m[1];
        buffer += `HELM_BINPROBE ${bin} ${availableBins.has(bin) ? 'FOUND' : 'MISSING'}\n`;
      }
      return { blocked: false, message: '' };
    },
    capturePane: async () => buffer,
    _sessions: sessions
  };
}

describe('A1a seat-binary pre-flight (preflightSeatBinaries + preflightRunRoster)', () => {
  let helmDbPath: string;
  let helmDb: DatabaseService;
  let identity: HelmIdentityService;

  beforeEach(() => {
    helmDbPath = `/tmp/helm-a1a-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    helmDb = new DatabaseService(helmDbPath);
    identity = new HelmIdentityService(helmDb);
  });

  afterEach(() => {
    if (helmDb && helmDb.close) helmDb.close();
    for (const p of [helmDbPath, `${helmDbPath}-wal`, `${helmDbPath}-shm`]) {
      try { fs.unlinkSync(p); } catch {}
    }
  });

  function makeRuntime(tmux: any) {
    const events = new AgentEventsService(helmDb);
    const resolver = new ProviderResolverService();
    const masterModels = new MasterModelService(helmDb, identity);
    return new MasterRuntimeService(helmDb, events, tmux, resolver, masterModels, undefined, undefined, undefined, undefined, identity);
  }

  it('all rostered binaries present on the seat PATH → ok:true, no missing', async () => {
    const tmux = makeProbeTmux(new Set(['grok', 'codex', 'claude']));
    const runtime = makeRuntime(tmux);
    const res = await runtime.preflightSeatBinaries([
      { provider: 'grok', model: 'grok-4.5' },
      { provider: 'codex', model: 'gpt-5.5' },
      { provider: 'claude', model: 'claude-opus-4-8' }
    ]);
    expect(res.ok).toBe(true);
    expect(res.missing).toEqual([]);
  });

  it('a binary missing from the seat PATH → ok:false, missing names the model + its binary', async () => {
    // grok present, codex CLI vanished off the seat PATH.
    const tmux = makeProbeTmux(new Set(['grok']));
    const runtime = makeRuntime(tmux);
    const res = await runtime.preflightSeatBinaries([
      { provider: 'grok', model: 'grok-4.5' },
      { provider: 'codex', model: 'gpt-5.5' }
    ]);
    expect(res.ok).toBe(false);
    expect(res.missing).toHaveLength(1);
    const miss = res.missing[0];
    expect(miss.provider).toBe('codex');
    expect(miss.model).toBe('gpt-5.5');
    expect(miss.bin).toBe('codex');
    expect(miss.reason).toMatch(/not found on seat PATH/i);
  });

  it('a configured model with NO launch entry at all → rejected (never probed)', async () => {
    const tmux = makeProbeTmux(new Set(['grok']));
    const runtime = makeRuntime(tmux);
    const res = await runtime.preflightSeatBinaries([
      { provider: 'grok', model: 'this-model-does-not-exist' }
    ]);
    expect(res.ok).toBe(false);
    expect(res.missing).toHaveLength(1);
    expect(res.missing[0].bin).toBeNull();
    expect(res.missing[0].reason).toMatch(/no launch entry/i);
  });

  it('preflightRunRoster REFUSES the run via a gate event but NEVER clobbers the project master_runtimes singleton (review #1)', async () => {
    // seed a native project + grok-4.5 master chain.
    const pid = 7010;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `helm-a1a-proj-${pid}-`));
    helmDb.raw.prepare('INSERT OR REPLACE INTO projects (id, name, directory) VALUES (?,?,?)').run(pid, 'a1a-refuse', dir);
    new MasterModelService(helmDb, identity).setChain(pid, [{ provider: 'grok', model: 'grok-4.5' }]);

    // review #1: a HEALTHY running master row already exists for this project — a worker-roster preflight
    // failure must NOT overwrite it with a synthetic "refused" row (PK = project_id).
    helmDb.raw
      .prepare(`INSERT OR REPLACE INTO master_runtimes (project_id, master_run_id, tmux_session, tmux_pane, provider, model, state, updated_at)
                VALUES (?, 'healthy-run', 'helm-live-sess', '0.0', 'grok', 'grok-4.5', 'running', datetime('now'))`)
      .run(pid);

    const tmux = makeProbeTmux(new Set(['grok'])); // codex missing
    const runtime = makeRuntime(tmux);

    await expect(
      runtime.preflightRunRoster(pid, [
        { provider: 'grok', model: 'grok-4.5' },
        { provider: 'codex', model: 'gpt-5.5' }
      ])
    ).rejects.toThrow(/seat-binary pre-flight failed/i);

    // durable gate event (the record lives here + on the run row/artifact, NOT the master singleton)
    const gate = helmDb.raw
      .prepare("SELECT * FROM agent_events WHERE type='gate' AND state='failed' ORDER BY id DESC LIMIT 1")
      .get() as any;
    expect(gate).toBeTruthy();
    const body = typeof gate.body === 'string' ? JSON.parse(gate.body) : (gate.body || {});
    expect(body.reason).toBe('seat-binary-preflight-failed');
    expect(String(body.detail)).toMatch(/codex\/gpt-5\.5/);

    // the healthy master row is UNTOUCHED (not clobbered to 'failed', run_id preserved)
    const rt = helmDb.raw.prepare('SELECT * FROM master_runtimes WHERE project_id = ?').get(pid) as any;
    expect(rt.state).toBe('running');
    expect(rt.master_run_id).toBe('healthy-run');
    expect(rt.tmux_session).toBe('helm-live-sess');

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('preflightRunRoster passes cleanly (no throw, no failed row) when all binaries present', async () => {
    const pid = 7011;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `helm-a1a-proj-${pid}-`));
    helmDb.raw.prepare('INSERT OR REPLACE INTO projects (id, name, directory) VALUES (?,?,?)').run(pid, 'a1a-ok', dir);
    new MasterModelService(helmDb, identity).setChain(pid, [{ provider: 'grok', model: 'grok-4.5' }]);

    const tmux = makeProbeTmux(new Set(['grok', 'codex']));
    const runtime = makeRuntime(tmux);
    const res = await runtime.preflightRunRoster(pid, [
      { provider: 'grok', model: 'grok-4.5' },
      { provider: 'codex', model: 'gpt-5.5' }
    ]);
    expect(res.ok).toBe(true);
    const rt = helmDb.raw.prepare('SELECT * FROM master_runtimes WHERE project_id = ?').get(pid) as any;
    expect(rt).toBeFalsy();

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });
});

describe('A1b per-seat command-not-found backstop (launchMaster fails FAST + clearly)', () => {
  let helmDbPath: string;
  let helmDb: DatabaseService;
  let identity: HelmIdentityService;
  let realPid: number;
  let projectDir: string;
  let testSession: string;

  beforeEach(() => {
    helmDbPath = `/tmp/helm-a1b-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    helmDb = new DatabaseService(helmDbPath);
    identity = new HelmIdentityService(helmDb);
    realPid = 7020;
    testSession = `helm-a1b-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), `helm-a1b-proj-`));
    helmDb.raw
      .prepare('INSERT OR REPLACE INTO projects (id, name, directory, plancore_session) VALUES (?,?,?,?)')
      .run(realPid, 'a1b-test', projectDir, testSession);
    new MasterModelService(helmDb, identity).setChain(realPid, [{ provider: 'grok', model: 'grok-4.5' }]);
  });

  afterEach(() => {
    if (helmDb && helmDb.close) helmDb.close();
    for (const p of [helmDbPath, `${helmDbPath}-wal`, `${helmDbPath}-shm`]) {
      try { fs.unlinkSync(p); } catch {}
    }
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
  });

  // A marker-aware fake shell: it records the per-launch marker from the `echo HELM_LAUNCH_<id>` sendCommand
  // and composes capturePane as <historical>\n<marker>\n<current> — mirroring how a real reused pane looks
  // (old scrollback, then this launch's marker, then this launch's output).
  function makeMarkerTmux(opts: { historical?: string; current: () => string; onFeed?: () => void; onTerminate?: () => void }) {
    let marker = '';
    return {
      sessionExists: async () => false,
      createSession: async () => `${testSession}:0.0`,
      sendCommand: async (_t: string, cmd: string) => {
        const m = /HELM_LAUNCH_[\w-]+/.exec(cmd);
        if (m) marker = m[0];
        return { blocked: false, message: '' };
      },
      capturePane: async () => `${opts.historical ? opts.historical + '\n' : ''}${marker}\n${opts.current()}\r\n`,
      sendAndSubmit: async () => { opts.onFeed?.(); return true; },
      sendEnter: async () => ({ blocked: false, message: '' }),
      sendKeys: async () => ({ blocked: false, message: '' }),
      terminateSession: async () => { opts.onTerminate?.(); },
      getPanePid: async () => '0',
      listPanes: async () => []
    };
  }

  it('fresh post-marker "command not found" → seat reaped, failed row + gate event, fails FAST (no full probe wait)', async () => {
    let feedCalled = false;
    let terminated = false;
    const fakeTmux: any = makeMarkerTmux({
      current: () => 'bash: line 1: grok: command not found',
      onFeed: () => { feedCalled = true; },
      onTerminate: () => { terminated = true; }
    });

    const events = new AgentEventsService(helmDb);
    const resolver = new ProviderResolverService();
    const masterModels = new MasterModelService(helmDb, identity);
    const runtime = new MasterRuntimeService(helmDb, events, fakeTmux, resolver, masterModels, undefined, undefined, undefined, undefined, identity);

    const t0 = Date.now();
    await expect(runtime.launchMaster(realPid)).rejects.toThrow(/seat binary missing.*not found on seat PATH/i);
    const elapsedMs = Date.now() - t0;

    // FAST: caught immediately, NOT after the 30-60s ready-probe timeout.
    expect(elapsedMs).toBeLessThan(5000);

    const gate = helmDb.raw
      .prepare("SELECT * FROM agent_events WHERE type='gate' AND state='failed' ORDER BY id DESC LIMIT 1")
      .get() as any;
    expect(gate).toBeTruthy();
    const body = typeof gate.body === 'string' ? JSON.parse(gate.body) : (gate.body || {});
    expect(body.reason).toBe('seat-binary-missing');
    expect(String(body.detail)).toMatch(/grok\/grok-4\.5 CLI 'grok' not found on seat PATH/);

    const rt = helmDb.raw.prepare('SELECT * FROM master_runtimes WHERE project_id = ?').get(realPid) as any;
    expect(rt.state).toBe('failed');

    expect(terminated).toBe(true);
    expect(feedCalled).toBe(false);
  });

  it('REUSED session: an OLD command-not-found in history followed by a healthy ready → must NOT fail (review #2)', async () => {
    let feedCalled = false;
    let terminated = false;
    // historical scrollback carries a stale error from a prior use; THIS launch reaches the grok composer (❯).
    const fakeTmux: any = makeMarkerTmux({
      historical: 'bash: line 9: grok: command not found',
      current: () => '❯ ready composer',
      onFeed: () => { feedCalled = true; },
      onTerminate: () => { terminated = true; }
    });

    const events = new AgentEventsService(helmDb);
    const resolver = new ProviderResolverService();
    const masterModels = new MasterModelService(helmDb, identity);
    const runtime = new MasterRuntimeService(helmDb, events, fakeTmux, resolver, masterModels, undefined, undefined, undefined, undefined, identity);

    const result = await runtime.launchMaster(realPid);
    expect(result.success).toBe(true);

    // launched cleanly: fed the master, master_runtimes row is 'running', NO seat-binary-missing event.
    expect(feedCalled).toBe(true);
    expect(terminated).toBe(false);
    const rt = helmDb.raw.prepare('SELECT * FROM master_runtimes WHERE project_id = ?').get(realPid) as any;
    expect(rt.state).toBe('running');
    const seatMiss = helmDb.raw
      .prepare("SELECT COUNT(*) AS n FROM agent_events WHERE type='gate' AND state='failed'")
      .get() as any;
    expect(Number(seatMiss.n)).toBe(0);
  });
});
