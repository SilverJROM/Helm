/**
 * B11 / AC-3 — panelist retirement (SAFE path).
 * Hidden seed (solo + in_development) for runtime panel/OFF-adaptive role='panelist';
 * unbound as live seat owner (role_defaults / role_bindings / project_agents).
 * Does NOT rewrite panel-service or remove the OFF-adaptive fallback.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION, applyB11PanelistRetirement } from './db/schema.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { ProjectAgentService } from './services/project-agent-service.js';
import { ProjectService } from './services/project-service.js';
import { PanelService } from './services/panel-service.js';
import { FakeTransport } from './services/fake-transport.js';

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-test-${process.pid}.db`);
  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

describe('B11 panelist retirement (AC-3 SAFE path)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB: SCHEMA_VERSION ≥98; panelist seed exists solo+in_development; not a role_default; not add-all candidate', () => {
    const t = tempDbPath('helm-b11-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(98);

    const as = new AgentAssignmentService(dbs);
    const panelist = as.listAgents().find((a) => a.name === 'panelist');
    expect(panelist, 'hidden seed must remain').toBeTruthy();
    expect(panelist!.classification).toBe('solo');
    expect(panelist!.in_development).toBe(true);

    const defs = as.listRoleDefaults();
    expect(defs.map((d) => d.role)).not.toContain('panelist');
    expect(as.resolveProjectRole(999999, 'panelist')).toBeNull();

    // Product surfaces: in_development excludes from add-all / project assignment
    const proj = new ProjectService(dbs).createProject({
      name: `b11-fresh-${Date.now()}`,
      directory: path.join(os.tmpdir(), `b11-fresh-${Date.now()}`),
    });
    const pas = new ProjectAgentService(dbs, as);
    pas.addAllAgents(proj.id);
    const rosterIds = (
      dbs.raw.prepare('SELECT agent_id FROM project_agents WHERE project_id = ?').all(proj.id) as any[]
    ).map((r) => Number(r.agent_id));
    expect(rosterIds).not.toContain(panelist!.id);
    expect(() => pas.addAgent(proj.id, panelist!.id)).toThrow(/in development/i);

    // OFF-adaptive binding path still accepts role 'panelist' (empty when unbound)
    const rows = as.resolveProjectRoleBindings(proj.id, ['red-team', 'panelist']);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows.every((r) => r.role !== 'panelist' || r.agent_id === panelist!.id)).toBe(true);

    dbs.close();
  });

  it('applyB11PanelistRetirement is idempotent and unbinds live seat ownership', () => {
    const t = tempDbPath('helm-b11-idem-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const panelist = as.listAgents().find((a) => a.name === 'panelist')!;

    // Simulate pre-retirement state: force ready + rebind as seat owner
    dbs.raw
      .prepare(
        "UPDATE agents SET in_development = 0 WHERE id = ?"
      )
      .run(panelist.id);
    dbs.raw
      .prepare(
        "INSERT OR REPLACE INTO role_defaults (role, agent_id) VALUES ('panelist', ?)"
      )
      .run(panelist.id);

    const proj = new ProjectService(dbs).createProject({
      name: `b11-idem-${Date.now()}`,
      directory: path.join(os.tmpdir(), `b11-idem-${Date.now()}`),
    });
    // This fixture un-retires panelist ABOVE, so createProject's roster/binding seed already added
    // both rows for it — upsert instead of insert, and keep asserting the seat-owner flag.
    dbs.raw
      .prepare(
        `INSERT INTO project_agents (project_id, agent_id, model_id, use_dynamic, is_primary_driver) VALUES (?,?,NULL,0,1)
         ON CONFLICT(project_id, agent_id) DO UPDATE SET is_primary_driver = 1`
      )
      .run(proj.id, panelist.id);
    dbs.raw
      .prepare("INSERT OR IGNORE INTO role_bindings (project_id, role, agent_id) VALUES (?,?,?)")
      .run(proj.id, 'panelist', panelist.id);
    dbs.raw
      .prepare('UPDATE projects SET primary_driver_agent_id = ? WHERE id = ?')
      .run(panelist.id, proj.id);

    applyB11PanelistRetirement(dbs.raw);
    applyB11PanelistRetirement(dbs.raw); // second pass no-op

    const row = dbs.raw
      .prepare('SELECT in_development, classification FROM agents WHERE id = ?')
      .get(panelist.id) as any;
    expect(row.in_development).toBe(1);
    expect(row.classification).toBe('solo');
    expect(
      dbs.raw.prepare("SELECT 1 FROM role_defaults WHERE role = 'panelist'").get()
    ).toBeFalsy();
    expect(
      dbs.raw
        .prepare("SELECT COUNT(*) AS c FROM role_bindings WHERE role = 'panelist'")
        .get() as { c: number }
    ).toEqual({ c: 0 });
    expect(
      dbs.raw
        .prepare('SELECT COUNT(*) AS c FROM project_agents WHERE agent_id = ?')
        .get(panelist.id) as { c: number }
    ).toEqual({ c: 0 });
    const p = dbs.raw
      .prepare('SELECT primary_driver_agent_id FROM projects WHERE id = ?')
      .get(proj.id) as any;
    expect(p.primary_driver_agent_id).toBeNull();

    dbs.close();
  });

  it('v97→v98 migration: applies retirement; second open idempotent at SCHEMA_VERSION', () => {
    const t = tempDbPath('helm-b11-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Start from a full fresh DB, then rewind version + re-surface panelist as product seat
    const seed = new DatabaseService(t.dbPath);
    const panelistId = (
      seed.raw.prepare("SELECT id FROM agents WHERE name = 'panelist'").get() as { id: number }
    ).id;
    seed.raw.prepare("UPDATE agents SET in_development = 0 WHERE id = ?").run(panelistId);
    seed.raw
      .prepare("INSERT OR REPLACE INTO role_defaults (role, agent_id) VALUES ('panelist', ?)")
      .run(panelistId);
    seed.raw.prepare('UPDATE schema_version SET version = 97').run();
    seed.close();

    const first = new DatabaseService(t.dbPath);
    expect((first.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    const p1 = first.raw
      .prepare('SELECT in_development, classification FROM agents WHERE id = ?')
      .get(panelistId) as any;
    expect(p1.in_development).toBe(1);
    expect(p1.classification).toBe('solo');
    expect(first.raw.prepare("SELECT 1 FROM role_defaults WHERE role = 'panelist'").get()).toBeFalsy();
    first.close();

    const second = new DatabaseService(t.dbPath);
    expect((second.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(
      (second.raw.prepare('SELECT in_development FROM agents WHERE id = ?').get(panelistId) as any)
        .in_development
    ).toBe(1);
    second.close();
  });

  it('HARD gate: deliberation panel still spawns role=panelist seats (panel-service unchanged)', async () => {
    const t = tempDbPath('helm-b11-panel-');
    cleanups.push(t.cleanup);
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';

    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b11-panel-run-'));
    cleanups.push(() => {
      try {
        fs.rmSync(runDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    });
    const cbp = path.join(runDir, 'callbacks.md');
    fs.writeFileSync(cbp, '# B11 panel callbacks\n', 'utf8');
    // waitForVerdict matches role=panelist + VERDICT-READY (seat tag not required)
    fs.appendFileSync(
      cbp,
      '[helm callback] panelist batch-B11 STATUS: VERDICT-READY — sound approach (seat delib:0)\n' +
        '[helm callback] panelist batch-B11 STATUS: VERDICT-READY — sound approach (seat delib:1)\n',
      'utf8'
    );

    const transport = new FakeTransport();
    const panel = new PanelService(transport, undefined, 'batch-B11');
    const result = await panel.conveneDeliberationPanel({
      runDir,
      batchId: 'batch-B11',
      topic: 'B11 regression: panelist role still spawns',
      seats: [
        { lens: 'correctness', model: 'claude-sonnet-4-6', provider: 'claude' },
        { lens: 'tests', model: 'gpt-5.5', provider: 'codex' },
      ],
    });

    expect(transport.spawnCalls.length).toBe(2);
    expect(transport.spawnCalls.every((s) => s.role === 'panelist')).toBe(true);
    expect(result.verdicts.length).toBe(2);
    expect(result.state).toBe('CONSENSUS');
  });
});
