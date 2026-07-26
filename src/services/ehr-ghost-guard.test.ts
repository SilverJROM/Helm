// CC-CHAT-4 (F4) — EHR ghost root-cause guard.
//
// ROOT CAUSE (live evidence: tmux session `helm-projcore-EHR` re-spawning every ~30-60min with
// HELM_DISABLE_MASTER_SUPERVISOR=1 set and master_runtimes EMPTY): the spawner was NEVER a Helm
// runtime service — it was the VITEST SUITE ITSELF. p1-5b/p1-6a/p1-6b build MasterRuntimeService
// with the REAL TmuxService and call launchMaster(realPid) where realPid comes from the shared
// AGJAssist DB (first active project = id 1, directory_name 'EHR'). launchMaster's D-a1 session
// naming (master-runtime-service.ts ~:133-141) falls back to `helm-projcore-<agj slug>` when the
// helm projects row has no projcore_session → `helm-projcore-EHR`, a REAL grok TUI session. The
// suites' cleanup then killed `helm-<slug>` (helm-EHR) — the WRONG name — so the session leaked
// on every full-suite run (each batch gate ≈ the observed 30-60min cadence). Deterministic repro:
// kill the session, run `vitest run src/p1-6a.test.ts` → it reappears at the suite timestamp.
//
// THE GUARD (semantically correct option: test-owned session identity, not an env kill-switch):
// the real-launch fixtures now seed a TEST-SCOPED projects.projcore_session (helm-p5b/p6a/p6b-
// test-<nonce>) — launchMaster then launches under a test-owned name it can deterministically
// reap in afterEach — and this file pins (1) the naming behavior and (2) the fixture contract
// so the leak cannot regress silently.
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { AgentEventsService } from './agent-events-service.js';
import { ProviderResolverService } from './provider-resolver-service.js';
import { MasterModelService } from './master-model-service.js';
import { MasterRuntimeService } from './master-runtime-service.js';
import { HelmIdentityService } from './helm-identity-service.js';
import { PROVIDERS } from '../config/providers.js';

const PID = 1;

function makeFixture(projcoreSession: string | null) {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-ghost-guard-'));
  const dbs = new DatabaseService(path.join(tmpRoot, 'test.db'));
  const projDir = fs.mkdtempSync(path.join(tmpRoot, 'proj-'));
  dbs.raw.prepare('INSERT INTO projects (id, name, directory, plancore_session) VALUES (?,?,?,?)')
    .run(PID, 'ghost-guard', projDir, projcoreSession);
  // O7.2: identity is native-only — there is no AGJAssist stub to read, so the D-a1 session-name
  // fallback can ONLY derive from the native directory_name, never the legacy 'EHR' slug.
  const identity = new HelmIdentityService(dbs);
  const masterModels = new MasterModelService(dbs, identity);
  masterModels.setChain(PID, [{ provider: 'grok', model: 'grok-4.5' }]);
  const created: string[] = [];
  // fake tmux (p1-5b pattern): records createSession names; capture never shows the ready signal
  // so launchMaster fails on a 1ms probe AFTER the session-name decision we are pinning.
  const fakeTmux: any = {
    sessionExists: async () => false,
    createSession: async (name: string) => { created.push(name); },
    sendCommand: async () => ({ blocked: false }),
    sendAndSubmit: async () => true,
    capturePane: async () => 'no ready signal here',
    terminateSession: async () => {},
    getPanePid: async () => null,
    listPanes: async () => [],
    forceKillPane: async () => {},
    sendKeys: async () => ({ blocked: false }),
  };
  const runtime = new MasterRuntimeService(dbs, new AgentEventsService(dbs), fakeTmux, new ProviderResolverService(), masterModels, undefined, undefined, undefined, undefined, identity);
  return { dbs, runtime, created, nativeSlug: path.basename(projDir), cleanup: () => { try { dbs.close(); } catch {}; try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {} } };
}

describe('EHR ghost guard — launchMaster session identity is test-ownable and the fixtures own it', () => {
  const grokDef: any = (PROVIDERS as any).grok;
  const origProbe = grokDef.readyProbe;
  afterEach(() => { grokDef.readyProbe = origProbe; });

  it('plancore_session set → launchMaster creates that session, never a shared-slug ghost name', async () => {
    grokDef.readyProbe = { signal: '❯', timeoutMs: 1 };
    const guardName = `helm-ghost-guard-test-${Date.now().toString(36)}`;
    const f = makeFixture(guardName);
    try {
      await f.runtime.launchMaster(PID).catch(() => { /* 1ms probe fails AFTER the naming decision */ });
      expect(f.created).toContain(guardName);
      expect(f.created).not.toContain('helm-plancore-EHR');
    } finally { f.cleanup(); }
  });

  it('plancore_session NULL → fallback derives helm-plancore-<native slug>, never a legacy shared slug', async () => {
    grokDef.readyProbe = { signal: '❯', timeoutMs: 1 };
    const f = makeFixture(null);
    try {
      await f.runtime.launchMaster(PID).catch(() => {});
      expect(f.created).toContain(`helm-plancore-${f.nativeSlug}`);
      expect(f.created).not.toContain('helm-plancore-EHR');
    } finally { f.cleanup(); }
  });

  it('fixture contract: every real-launch suite seeds a test-scoped plancore_session AND reaps it', () => {
    // The leak lived in the FIXTURES, so the guard pins the fixtures: each suite that can reach a
    // REAL launchMaster must (a) seed projcore_session with its test-scoped name and (b) terminate
    // that exact session in cleanup. A future edit that drops either re-opens the ghost.
    const suites = ['p1-5a.test.ts', 'p1-5b.test.ts', 'p1-6a.test.ts', 'p1-6b.test.ts'];
    for (const s of suites) {
      const src = fs.readFileSync(path.join(process.cwd(), 'src', s), 'utf8');
      expect(src, `${s} must declare a test-scoped session name`).toMatch(/testSession\s*=\s*`helm-p\d\w?-test-/);
      expect(src, `${s} must seed projects.plancore_session with the test-scoped name`).toMatch(/INSERT OR (REPLACE|IGNORE) INTO projects \(id, name, directory, plancore_session\)/);
      expect(src, `${s} must reap the ACTUAL launched session (testSession) in cleanup`).toMatch(/terminateSession\(testSession\)/);
    }
  });
});
