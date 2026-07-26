import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DatabaseService } from './db/database.js';
import { AgentEventsService } from './services/agent-events-service.js';
import { TmuxService } from './tmux/tmux-service.js';
import { ProviderResolverService } from './services/provider-resolver-service.js';
import { MasterModelService } from './services/master-model-service.js';
import { MasterRuntimeService } from './services/master-runtime-service.js';
import { HelmIdentityService } from './services/helm-identity-service.js';
import { PROVIDERS } from './config/providers.js';
import { SCHEMA_VERSION } from './db/schema.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = path.resolve(__dirname, '../prompts/agent-os');

describe('P1-5a Master launch (launchMaster + readyProbe + master-launched gate + master_runtimes v4)', () => {
  let helmDbPath: string;
  let helmDb: DatabaseService;
  let identity: HelmIdentityService;
  let realPid: number;
  let realSlug: string;
  let testSession: string;

  // GREEN-1: shared helper (real temp dir) for beforeEach seed of projects.directory.
  // Required by C3 fail-closed write-fence for *all* launchMaster callers (test-only precondition; do not weaken fence).
  // CC-CHAT-4 EHR-ghost fix: seed a TEST-SCOPED projcore_session so a REAL launchMaster never
  // uses the `helm-projcore-<agj slug>` fallback (helm-projcore-EHR) — an interrupted suite run
  // (afterEach skipped) then leaks a live grok session that looks like a production ghost.
  function seedProjectDirectory(db: any, pid: number, name?: string) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `helm-g1-proj-${pid}-`));
    db.raw.prepare('INSERT OR REPLACE INTO projects (id, name, directory, plancore_session) VALUES (?,?,?,?)').run(pid, name || `g1-test-${pid}`, dir, testSession);
  }

  beforeEach(() => {
    helmDbPath = `/tmp/helm-p5a-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;

    helmDb = new DatabaseService(helmDbPath); // v4 mig
    identity = new HelmIdentityService(helmDb);

    realPid = 501;
    realSlug = 'test';
    testSession = `helm-p5a-test-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

    // GREEN-1: seed real temp directory for realPid so launchMaster (even faked negative paths) passes C3 write-fence.
    // O4.1: also the native project-identity row setChain now requires (a project must exist
    // natively BEFORE its master chain can be set) — must run before setChain below.
    seedProjectDirectory(helmDb, realPid, 'p5a-g1');

    // Ensure a grok-4.5 master chain exists for realPid in *this* helm temp DB (native identity only).
    const master = new MasterModelService(helmDb, identity);
    master.setChain(realPid, [{ provider: 'grok', model: 'grok-4.5' }]);
  });

  afterEach(() => {
    if (helmDb && helmDb.close) helmDb.close();
    try { fs.unlinkSync(helmDbPath); } catch {}
    // Best-effort cleanup of any test master session left behind (swallow 'can't find' from prior kills in suite)
    try {
      const tmux = new TmuxService();
      // CC-CHAT-4: reap the session ACTUALLY launched (testSession) + the legacy fallback name.
      tmux.terminateSession(testSession).catch(() => {});
      tmux.terminateSession(`helm-plancore-${realSlug}`).catch((e: any) => { if (!/can't find session/i.test(String(e||''))) { /* rethrow non-cleanup */ } });
    } catch {}
  });

  it('migration v3 seed upgrades to current (v4 master_runtimes + v5+); fresh also at SCHEMA_VERSION', () => {
    // Seed a pure v3 DB (current tables + version=3, NO master_runtimes). Service applies all additive blocks to current.
    const v3Path = `/tmp/helm-v3-seed-${Date.now()}.db`;
    const v3 = new Database(v3Path);
    v3.exec(`
CREATE TABLE IF NOT EXISTS schema_version ( version INTEGER NOT NULL );
CREATE TABLE IF NOT EXISTS agent_events ( id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, role TEXT NOT NULL, batch_id TEXT NOT NULL, session TEXT, type TEXT NOT NULL CHECK(type IN ('message', 'status', 'tool', 'gate')), state TEXT, source TEXT NOT NULL CHECK(source IN ('callback', 'git', 'pane', 'post')), correlation_id TEXT NOT NULL, body TEXT NOT NULL DEFAULT '{}', ts TEXT NOT NULL DEFAULT (datetime('now')) );
CREATE INDEX IF NOT EXISTS idx_agent_events_run_ts ON agent_events(run_id, ts);
CREATE INDEX IF NOT EXISTS idx_agent_events_batch_type ON agent_events(run_id, batch_id, type);
CREATE UNIQUE INDEX IF NOT EXISTS idx_agent_events_terminal_dedupe ON agent_events(run_id, batch_id, state, correlation_id) WHERE type = 'status' AND state IN ('DONE', 'BLOCKED');
CREATE TABLE IF NOT EXISTS agents ( id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL, provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok')), model TEXT NOT NULL, default_effort TEXT NOT NULL DEFAULT 'medium', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')) );
CREATE TABLE IF NOT EXISTS role_bindings ( id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, role TEXT NOT NULL CHECK(role IN ('projcore', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')), agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT, created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE(project_id, role) );
CREATE TABLE IF NOT EXISTS role_defaults ( role TEXT PRIMARY KEY CHECK(role IN ('projcore', 'coord', 'implementer', 'validator', 'deliberation', 'red-team', 'planner', 'routine-implementer', 'panelist')), agent_id INTEGER NOT NULL REFERENCES agents(id), updated_at TEXT NOT NULL DEFAULT (datetime('now')) );
CREATE TABLE IF NOT EXISTS project_master_models ( id INTEGER PRIMARY KEY, project_id INTEGER NOT NULL, position INTEGER NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, UNIQUE(project_id, position) );
CREATE INDEX IF NOT EXISTS idx_pmm_project ON project_master_models(project_id);
    `);
    v3.prepare("INSERT INTO schema_version (version) VALUES (3)").run();
    v3.close();

    // Open via service -> v3->v4 (master) + v5 (seq/switches) must apply; final == current
    const up = new DatabaseService(v3Path);
    const hasMaster = up.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='master_runtimes'").get() as any;
    expect(!!hasMaster).toBe(true);
    const ver = up.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(ver.version).toBe(SCHEMA_VERSION);
    up.close();

    // Fresh db also gets current (incl v5)
    const freshPath = `/tmp/helm-fresh-p5a-${Date.now()}.db`;
    const fr = new DatabaseService(freshPath);
    const fver = fr.raw.prepare("SELECT version FROM schema_version").get() as any;
    expect(fver.version).toBe(SCHEMA_VERSION);
    const fhas = fr.raw.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='master_runtimes'").get() as any;
    expect(!!fhas).toBe(true);
    fr.close();

    try { fs.unlinkSync(v3Path); } catch {}
    try { fs.unlinkSync(freshPath); } catch {}
  });

  it('launchMaster throws if project not set up (no master chain)', async () => {
    const events = new AgentEventsService(helmDb);
    const tmux = new TmuxService();
    const resolver = new ProviderResolverService();
    const master = new MasterModelService(helmDb, identity);
    const runtime = new MasterRuntimeService(helmDb, events, tmux, resolver, master, undefined, undefined, undefined, undefined, identity);

    // Use a pid that has no chain in this temp DB (different pid)
    const badPid = 99999999;
    await expect(runtime.launchMaster(badPid)).rejects.toThrow(/not set up/);
  });

  it('REAL grok launch proof for real OVM project (seed grok-4.5 chain, live tmux session + real readyProbe passed + master-launched event with shas + master_runtimes row running, THEN cleanup)', async () => {
    const events = new AgentEventsService(helmDb);
    const tmux = new TmuxService();
    const resolver = new ProviderResolverService();
    const masterModels = new MasterModelService(helmDb, identity);
    const runtime = new MasterRuntimeService(helmDb, events, tmux, resolver, masterModels, undefined, undefined, undefined, undefined, identity);

    // C3: seed projects row so directory query succeeds (fail-closed path) and the real launch is fenced.
    // Use process.cwd() (safe for short launch+feed proof; no agent FS side-effects asserted in this it).
    // CC-CHAT-4: keep the test-scoped projcore_session — an OR REPLACE without it would NULL the
    // column and resurrect the helm-projcore-<agj-slug> ghost fallback.
    helmDb.raw.prepare("INSERT OR REPLACE INTO projects (id, name, directory, plancore_session) VALUES (?,?,?,?)").run(realPid, 'c3-real-p1-5a', process.cwd(), testSession);

    // The beforeEach already seeded the grok-4.5 primary for realPid (native identity boundary)
    const result = await runtime.launchMaster(realPid);

    // (a) tmux session exists — small retry for robustness in full suite (real tmux timing).
    // CC-CHAT-4: launch identity is the test-scoped projcore_session (D-a1 honors the column;
    // the AGJ-slug fallback is pinned separately in ehr-ghost-guard.test.ts with fake tmux).
    const sessionName = testSession;
    let hasSession = false;
    for (let i = 0; i < 30; i++) {
      const panes = await tmux.listPanes();
      hasSession = panes.some((p: any) => p.session === sessionName);
      if (hasSession) break;
      await new Promise(r => setTimeout(r, 200));
    }
    expect(hasSession).toBe(true);

    // (b) readyProbe passed (we reached the feed without timeout throw)
    // (c) master-launched event with exact provenance body
    const allEvents = events.listEvents(result.run_id);
    const launchGate = allEvents.find((e: any) => e.type === 'gate' && e.state === 'master-launched');
    expect(launchGate).toBeTruthy();
    const body = launchGate!.body as any;
    expect(body).toMatchObject({
      provider: 'grok',
      model: 'grok-4.5',
      session: expect.stringContaining(sessionName)
    });
    expect(typeof body.core_sha).toBe('string');
    expect(body.core_sha.length > 10).toBe(true);
    expect(typeof body.overlay_sha).toBe('string');
    expect(body.overlay_sha.length > 10).toBe(true);

    // Compute expected shas from the actual files on disk (outcome proof, not theater)
    const core = fs.readFileSync(path.join(PROMPTS_DIR, 'projcore.core.md'), 'utf8');
    const overlay = fs.readFileSync(path.join(PROMPTS_DIR, 'overlays', 'grok.md'), 'utf8');
    const expectedCoreSha = createHash('sha256').update(core, 'utf8').digest('hex');
    const expectedOverlaySha = createHash('sha256').update(overlay, 'utf8').digest('hex');
    expect(body.core_sha).toBe(expectedCoreSha);
    expect(body.overlay_sha).toBe(expectedOverlaySha);

    // (d) master_runtimes row state=running with matching shas
    const rtRow = helmDb.raw.prepare('SELECT * FROM master_runtimes WHERE project_id = ?').get(realPid) as any;
    expect(rtRow).toBeTruthy();
    expect(rtRow.state).toBe('running');
    expect(rtRow.provider).toBe('grok');
    expect(rtRow.model).toBe('grok-4.5');
    expect(rtRow.core_sha).toBe(expectedCoreSha);
    expect(rtRow.overlay_sha).toBe(expectedOverlaySha);
    expect(rtRow.master_run_id).toBe(result.run_id);

    // Evidence for report (session list + event row)
    const summary = await tmux.listJobsSummary();
    console.log('P1-5a REAL PROOF — SESSION LIST (pre-cleanup):', summary);
    console.log('P1-5a REAL PROOF — master-launched EVENT BODY:', body);
    console.log('P1-5a REAL PROOF — master_runtimes ROW state:', rtRow.state, 'project_id:', rtRow.project_id);

    // THEN cleanup (kill the test session)
    await tmux.terminateSession(sessionName);

    // Post-cleanup verify session gone (best effort)
    const afterPanes = await tmux.listPanes();
    const stillHas = afterPanes.some((p: any) => p.session === sessionName);
    expect(stillHas).toBe(false);
  }, 120000); // generous timeout for real grok-4.5 startup + probe (<=30s) + feed + asserts + kill

  it('readyProbe TIMEOUT negative path (deterministic, no real launch): fake launch_cmd that never emits signal + short timeoutMs → assert cli-startup-timeout event + master_runtimes state=failed + NO feed happened + kills the session we created', async () => {
    // Force very short timeout for the provider used by the (already seeded) chain
    const grokDef: any = (PROVIDERS as any).grok;
    const origProbe = grokDef.readyProbe;
    grokDef.readyProbe = { signal: '❯', timeoutMs: 5 };

    let feedCalled = false;
    let terminated = false;
    const fakeTmux: any = {
      sessionExists: async () => false,
      createSession: async () => {},
      sendCommand: async () => ({ blocked: false, message: '' }),
      capturePane: async () => 'pane content that never contains the ready signal (no chevron here at all)',
      sendAndSubmit: async () => { feedCalled = true; return true; },
      terminateSession: async () => { terminated = true; },
      listPanes: async () => [],
    };

    const events = new AgentEventsService(helmDb);
    const resolver = new ProviderResolverService();
    const master = new MasterModelService(helmDb, identity);
    const runtime = new MasterRuntimeService(helmDb, events, fakeTmux, resolver, master, undefined, undefined, undefined, undefined, identity);

    try {
      await expect(runtime.launchMaster(realPid)).rejects.toThrow(/timeout/);

      // timeout event recorded (query raw table; body is stored as JSON string, parse it)
      const rawFailed = helmDb.raw
        .prepare("SELECT * FROM agent_events WHERE type='gate' AND state='failed' ORDER BY id DESC LIMIT 1")
        .get() as any;
      expect(rawFailed).toBeTruthy();
      const body = typeof rawFailed.body === 'string' ? JSON.parse(rawFailed.body) : (rawFailed.body || {});
      expect(body.reason).toBe('cli-startup-timeout');

      // row marked failed
      const rt = helmDb.raw.prepare('SELECT * FROM master_runtimes WHERE project_id = ?').get(realPid) as any;
      expect(rt.state).toBe('failed');

      // no feed attempted
      expect(feedCalled).toBe(false);
      // we created it → killed on timeout path
      expect(terminated).toBe(true);
    } finally {
      grokDef.readyProbe = origProbe;
    }
  });

  it('re-launch guard negative path (deterministic, no real launch): second launchMaster when running row exists + tmux session alive → throws "master already running"', async () => {
    const events = new AgentEventsService(helmDb);
    const resolver = new ProviderResolverService();
    const master = new MasterModelService(helmDb, identity);

    const sessionNameForThis = `helm-plancore-${realSlug}`;
    const fakeTmux: any = {
      sessionExists: async (s: string) => s === sessionNameForThis,
      // other methods not reached (guard throws before create/send)
    };

    const runtime = new MasterRuntimeService(helmDb, events, fakeTmux, resolver, master, undefined, undefined, undefined, undefined, identity);

    // Seed a running master row for this project (simulates prior successful launchMaster)
    helmDb
      .prepare(
        `INSERT OR REPLACE INTO master_runtimes
         (project_id, master_run_id, tmux_session, tmux_pane, provider, model, state, core_sha, overlay_sha, last_launched_at, updated_at)
         VALUES (?, ?, ?, '0.0', 'grok', 'grok-4.5', 'running', 's1', 's2', datetime('now'), datetime('now'))`
      )
      .run(realPid, 'prev-master-run', sessionNameForThis);

    await expect(runtime.launchMaster(realPid)).rejects.toThrow(/master already running/i);
  });
});
