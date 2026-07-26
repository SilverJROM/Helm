/**
 * B5 / AC-10 — per-rung effort on escalation ladders + spawn threading.
 * Schema v95, set/list round-trips, whitelist reject, NULL inherits,
 * mechanism: L2 effort=high + dispatch at rung1 → launch effort=high.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';
import { EscalationService } from './services/escalation-service.js';
import { FakeTransport } from './services/fake-transport.js';
import { OrchestratorLoop } from './services/orchestrator-loop.js';
import { RunArtifactService } from './services/run-artifact-service.js';

function tempDbPath(prefix: string): { dbPath: string; dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  return {
    dbPath,
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('B5 per-rung effort (schema v95 + API + AC-10 spawn)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB: SCHEMA_VERSION ≥95; effort column + CHECK on both escalation tables', () => {
    const t = tempDbPath('helm-b5-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(95);

    for (const table of ['agent_escalations', 'project_agent_escalations'] as const) {
      const cols = (dbs.raw.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
      expect(cols).toContain('effort');
      const createSql = (
        dbs.raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name=?`).get(table) as any
      ).sql as string;
      expect(createSql).toMatch(
        /effort[^,]*CHECK\(effort IS NULL OR effort IN \('low','medium','high','xhigh','max'\)\)/
      );
    }

    dbs.close();
  });

  it('v94→v95 migration: guarded ADD COLUMN effort on both tables; idempotent', () => {
    const t = tempDbPath('helm-b5-mig-');
    cleanups.push(t.cleanup);

    // Minimal pre-v95 DB: schema_version=94 with both escalation tables WITHOUT effort
    const raw = new Database(t.dbPath);
    raw.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (94);
      CREATE TABLE models (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT,
        cli TEXT,
        slug TEXT,
        display_name TEXT,
        effort TEXT
      );
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        provider TEXT NOT NULL,
        model TEXT,
        default_effort TEXT DEFAULT 'medium',
        spawn_pref TEXT DEFAULT 'tmux',
        agent_type TEXT DEFAULT 'project',
        classification TEXT NOT NULL DEFAULT 'solo'
      );
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        directory TEXT
      );
      CREATE TABLE project_agents (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        escalations_overridden INTEGER NOT NULL DEFAULT 0,
        UNIQUE(project_id, agent_id)
      );
      CREATE TABLE agent_escalations (
        id INTEGER PRIMARY KEY,
        agent_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        model_id INTEGER NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'on-fail', effort TEXT,
        UNIQUE(agent_id, position)
      );
      CREATE TABLE project_agent_escalations (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        agent_id INTEGER NOT NULL,
        position INTEGER NOT NULL,
        model_id INTEGER NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'on-fail', effort TEXT,
        UNIQUE(project_id, agent_id, position)
      );
      INSERT INTO models (id, name, provider, model_id, cli, slug, display_name, effort)
        VALUES (1, 'm1', 'grok', 'grok-4.5', 'grok', 'm1', 'm1', 'medium');
      INSERT INTO agents (id, name, provider, model) VALUES (1, 'implementer', 'grok', 'grok-4.5');
      INSERT INTO agent_escalations (agent_id, position, model_id, trigger) VALUES (1, 1, 1, 'on-fail');
    `);
    raw.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(98);

    for (const table of ['agent_escalations', 'project_agent_escalations'] as const) {
      const cols = (dbs.raw.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
      expect(cols).toContain('effort');
    }
    // Existing row survives with NULL effort (inherit)
    const row = dbs.raw.prepare('SELECT effort FROM agent_escalations WHERE agent_id=1 AND position=1').get() as any;
    expect(row.effort).toBeNull();

    // Idempotent re-open
    dbs.close();
    const dbs2 = new DatabaseService(t.dbPath);
    expect((dbs2.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(98);
    dbs2.close();
  });

  it('set/list round-trips effort on agent_escalations; NULL inherits; bogus rejected', () => {
    const t = tempDbPath('helm-b5-studio-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);

    const impl = dbs.raw.prepare("SELECT id FROM agents WHERE name='implementer'").get() as { id: number };
    const codex = dbs.raw.prepare("SELECT id FROM models WHERE name='codex-5.5' OR model_id='gpt-5.5' LIMIT 1").get() as { id: number };
    const opus = dbs.raw.prepare("SELECT id FROM models WHERE name LIKE '%opus%' LIMIT 1").get() as { id: number };
    expect(impl && codex && opus).toBeTruthy();

    const set = as.setAgentEscalations(impl.id, [
      { position: 1, model_id: codex.id, trigger: 'on-fail', effort: 'high' },
      { position: 2, model_id: opus.id, trigger: 'on-fail', effort: null },
    ]);
    expect(set.find((e) => e.position === 1)?.effort).toBe('high');
    expect(set.find((e) => e.position === 2)?.effort).toBeNull();

    const listed = as.listAgentEscalations(impl.id);
    expect(listed.find((e) => e.position === 1)?.effort).toBe('high');
    expect(listed.find((e) => e.position === 2)?.effort).toBeNull();

    expect(() =>
      as.setAgentEscalations(impl.id, [
        { position: 1, model_id: codex.id, effort: 'turbo' as any },
      ])
    ).toThrow(/invalid effort/);

    dbs.close();
  });

  it('set/list round-trips effort on project_agent_escalations; effective view includes effort', () => {
    const t = tempDbPath('helm-b5-proj-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const pas = new ProjectAgentService(dbs, as);

    const impl = dbs.raw.prepare("SELECT id FROM agents WHERE name='implementer'").get() as { id: number };
    const codex = dbs.raw.prepare("SELECT id FROM models WHERE name='codex-5.5' OR model_id='gpt-5.5' LIMIT 1").get() as { id: number };
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b5-projdir-'));
    cleanups.push(() => {
      try {
        fs.rmSync(projDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const pid = Number(
      (dbs.raw.prepare('INSERT INTO projects (name, directory) VALUES (?,?) RETURNING id').get(`b5-${Date.now()}`, projDir) as any).id
    );
    pas.addAgent(pid, impl.id);

    const set = pas.setProjectAgentEscalations(pid, impl.id, {
      overridden: true,
      escalations: [{ position: 1, model_id: codex.id, trigger: 'on-fail', effort: 'xhigh' }],
    });
    expect(set.escalations[0]?.effort).toBe('xhigh');

    const listed = pas.listProjectAgentEscalations(pid, impl.id);
    expect(listed.escalations[0]?.effort).toBe('xhigh');

    const effective = as.resolveProjectAgent(pid, impl.id)!;
    expect(effective.overrides.escalations_overridden).toBe(true);
    expect(effective.escalations.find((e) => e.position === 1)?.effort).toBe('xhigh');

    expect(() =>
      pas.setProjectAgentEscalations(pid, impl.id, {
        overridden: true,
        escalations: [{ position: 1, model_id: codex.id, effort: 'bogus' as any }],
      })
    ).toThrow(/invalid effort/);

    dbs.close();
  });

  it('EscalationService: getEffortForRung / resolveLaunchEffort prefer rung effort when set', () => {
    const t = tempDbPath('helm-b5-resolve-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const esc = new EscalationService(dbs, undefined, as);

    const impl = dbs.raw.prepare("SELECT id FROM agents WHERE name='implementer'").get() as { id: number };
    const codex = dbs.raw.prepare("SELECT id FROM models WHERE name='codex-5.5' OR model_id='gpt-5.5' LIMIT 1").get() as { id: number };
    const opus = dbs.raw.prepare("SELECT id FROM models WHERE name LIKE '%opus%' LIMIT 1").get() as { id: number };

    // L1 agent default stays low (not on escalation row); L2=high; L3=NULL inherits
    dbs.raw.prepare("UPDATE agents SET default_effort = 'low' WHERE id = ?").run(impl.id);
    as.setAgentEscalations(impl.id, [
      { position: 1, model_id: codex.id, effort: 'high' },
      { position: 2, model_id: opus.id, effort: null },
    ]);

    expect(esc.getEffortForRung('implementer', 0)).toBeNull();
    expect(esc.getEffortForRung('implementer', 1)).toBe('high');
    expect(esc.getEffortForRung('implementer', 2)).toBeNull();

    expect(esc.resolveLaunchEffort(1, 'low', 'implementer')).toBe('high');
    expect(esc.resolveLaunchEffort(2, 'low', 'implementer')).toBe('low'); // NULL inherits base
    expect(esc.resolveLaunchEffort(0, 'low', 'implementer')).toBe('low');

    const resolved = esc.resolveRungAndModel({ role: 'implementer', explicitRung: 1 });
    expect(resolved.rung).toBe(1);
    expect(resolved.effort).toBe('high');

    dbs.close();
  });

  it('AC-10 mechanism: L2 effort=high, L1 base=low; dispatch at rung1 → spawn effort=high', async () => {
    process.env.USE_FAKE_TMUX = '1';
    const t = tempDbPath('helm-b5-spawn-');
    cleanups.push(t.cleanup);
    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const esc = new EscalationService(dbs, undefined, as);
    const svc = new RunArtifactService(dbs);

    const impl = dbs.raw.prepare("SELECT id FROM agents WHERE name='implementer'").get() as { id: number };
    const codex = dbs.raw.prepare("SELECT id FROM models WHERE name='codex-5.5' OR model_id='gpt-5.5' LIMIT 1").get() as { id: number };
    const opus = dbs.raw.prepare("SELECT id FROM models WHERE name LIKE '%opus%' LIMIT 1").get() as { id: number };
    dbs.raw.prepare("UPDATE agents SET default_effort = 'low' WHERE id = ?").run(impl.id);
    as.setAgentEscalations(impl.id, [
      { position: 1, model_id: codex.id, trigger: 'on-fail', effort: 'high' },
      { position: 2, model_id: opus.id, trigger: 'on-fail', effort: null },
    ]);

    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b5-run-'));
    cleanups.push(() => {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    fs.writeFileSync(path.join(runDir, 'callbacks.md'), '# B5 AC-10 callbacks\n', 'utf8');

    const transport = new FakeTransport();
    const loop = new OrchestratorLoop(transport, {
      runDir,
      batchId: 'batch-B5',
      artifactService: svc,
      escalationService: esc,
    });

    // Plan base effort = low (L1/agent); recommended_rung = 1 (L2)
    const p = loop.runTask({
      brief: 'B5 AC-10 rung effort spawn',
      recommendedRung: 1,
      effort: 'low',
      taskType: 'feature',
    });
    const cbp = path.join(runDir, 'callbacks.md');
    await fs.promises.appendFile(cbp, `[helm callback] implementer batch-B5 STATUS: DONE — rung1\n`);
    await sleep(20);
    await fs.promises.appendFile(cbp, `[helm callback] validator batch-B5 STATUS: PASS — ok\n`);
    await sleep(20);
    const res = await p;

    expect(res.finalStatus).toBe('PASS');
    expect(loop.getCurrentRung()).toBe(1);

    const implSpawns = transport.spawnCalls.filter((s) => s.role === 'implementer');
    expect(implSpawns.length).toBeGreaterThanOrEqual(1);
    const first = implSpawns[0] as any;
    expect(first.rung).toBe(1);
    // AC-10: launch opts effort is the rung's high, NOT the L1/plan low
    expect(first.effort).toBe('high');

    dbs.close();
  });
});
