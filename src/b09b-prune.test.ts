/**
 * B09b — Prune non-canonical agents + FK cleanup (R2.11).
 * Scope: prune migration, FK integrity, counts; keep B09a seeds; no UI.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import {
  SCHEMA_VERSION,
  B09A_CANONICAL_AGENT_SEEDS,
  B09A_CANONICAL_NAMES,
  B09A_HOUSE_NAMES,
  B09A_PROJECT_NAMES,
  applyB09aCanonicalRosterSeeds,
  applyB09bPruneNonCanonicalAgents,
} from './db/schema.js';

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

describe('B09b prune + FK cleanup (R2.11)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB: SCHEMA_VERSION ≥65; exactly the 10 canonical agents; no legacy house stubs', () => {
    const t = tempDbPath('helm-b09b-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(65);

    const names = (
      dbs.raw.prepare('SELECT name FROM agents ORDER BY name').all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(names).toEqual([...B09A_CANONICAL_NAMES].sort());
    expect(names).toHaveLength(10);
    expect(names).not.toContain('master_agent');
    expect(names).not.toContain('jkagebunshin');
    expect(names).not.toContain('coord');
    expect(names).not.toContain('project_maintainer');

    for (const seed of B09A_CANONICAL_AGENT_SEEDS) {
      const raw = dbs.raw.prepare('SELECT agent_type FROM agents WHERE name = ?').get(seed.name) as any;
      expect(raw.agent_type).toBe(seed.kind);
    }
    for (const n of B09A_HOUSE_NAMES) {
      expect(names).toContain(n);
    }
    for (const n of B09A_PROJECT_NAMES) {
      expect(names).toContain(n);
    }

    // role_defaults bind to a surviving canonical AGENT. Post name-layer rename the role token can
    // differ from an agent display name, so assert on the bound agent.
    const defs = dbs.raw
      .prepare(
        'SELECT rd.role AS role, a.name AS agent_name FROM role_defaults rd JOIN agents a ON a.id = rd.agent_id ORDER BY rd.role'
      )
      .all() as Array<{ role: string; agent_name: string }>;
    for (const d of defs) {
      expect(B09A_CANONICAL_NAMES).toContain(d.agent_name);
    }

    // No orphan agent FKs among tables we manage
    const fkProblems = (dbs.raw.prepare('PRAGMA foreign_key_check').all() as any[]).filter(
      (p: any) => p.parent === 'agents' || p.table === 'agents'
    );
    expect(fkProblems).toHaveLength(0);

    dbs.close();
  });

  it('applyB09bPruneNonCanonicalAgents is idempotent (second pass no-ops; canonicals intact)', () => {
    const t = tempDbPath('helm-b09b-idem-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const before = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c;
    expect(before).toBe(10);

    const c1 = applyB09bPruneNonCanonicalAgents(dbs.raw);
    const c2 = applyB09bPruneNonCanonicalAgents(dbs.raw);
    expect(c1.pruned_names).toEqual([]);
    expect(c2.pruned_names).toEqual([]);
    expect(c1.agents_after).toBe(10);
    expect(c2.agents_after).toBe(10);

    const after = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c;
    expect(after).toBe(before);

    const nameCount = (
      dbs.raw
        .prepare(
          `SELECT COUNT(*) AS c FROM agents WHERE name IN (${B09A_CANONICAL_NAMES.map(() => '?').join(',')})`
        )
        .get(...B09A_CANONICAL_NAMES) as { c: number }
    ).c;
    expect(nameCount).toBe(10);

    dbs.close();
  });

  it('v64→v65 migration prunes non-canonical, cleans FKs, remaps master_agent→agent-master', () => {
    const t = tempDbPath('helm-b09b-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Synthetic v64: full enough for FK children + mix of canonical and legacy rows.
    const old = new Database(t.dbPath);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (64);
      CREATE TABLE models (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        effort TEXT NOT NULL DEFAULT 'medium',
        approval TEXT NOT NULL DEFAULT 'auto',
        flags TEXT,
        bypass INTEGER NOT NULL DEFAULT 0,
        cli TEXT,
        slug TEXT,
        display_name TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO models (id, name, provider, model_id, cli, slug, display_name) VALUES
        (1, 'claude-sonnet', 'claude', 'claude-sonnet-4-6', 'claude', 'sonnet5', 'Sonnet 5');
      CREATE TABLE agents (
        id INTEGER PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        provider TEXT NOT NULL CHECK(provider IN ('claude', 'codex', 'grok', 'kloo')),
        model TEXT NOT NULL,
        default_effort TEXT NOT NULL DEFAULT 'medium',
        definition_md TEXT,
        default_model_id INTEGER REFERENCES models(id),
        backup_model_id INTEGER REFERENCES models(id),
        spawn_pref TEXT NOT NULL DEFAULT 'tmux',
        in_development INTEGER NOT NULL DEFAULT 0 CHECK(in_development IN (0,1)),
        agent_type TEXT NOT NULL DEFAULT 'project' CHECK(agent_type IN ('house','project')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO agents (id, name, provider, model, agent_type, definition_md) VALUES
        (1, 'implementer', 'grok', 'grok-4.5', 'project', '# implementer keep'),
        (2, 'master_agent', 'claude', 'claude-sonnet-4-6', 'house', '# legacy master'),
        (3, 'legacy-extra', 'claude', 'claude-sonnet-4-6', 'project', '# prune me'),
        (4, 'jkagebunshin', 'claude', 'claude-sonnet-4-6', 'house', '# legacy jkage');
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        directory TEXT,
        primary_driver_agent_id INTEGER REFERENCES agents(id),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO projects (id, name, directory, primary_driver_agent_id) VALUES
        (1, 'b09b-proj', '/tmp/b09b', 3);
      CREATE TABLE project_agents (
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        PRIMARY KEY (project_id, agent_id)
      );
      INSERT INTO project_agents (project_id, agent_id) VALUES (1, 1), (1, 3);
      CREATE TABLE role_bindings (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(project_id, role, agent_id)
      );
      INSERT INTO role_bindings (project_id, role, agent_id) VALUES (1, 'implementer', 3);
      CREATE TABLE role_defaults (
        role TEXT PRIMARY KEY,
        agent_id INTEGER NOT NULL REFERENCES agents(id),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO role_defaults (role, agent_id) VALUES
        ('implementer', 1),
        ('coord', 3);
      CREATE TABLE team_members (
        id INTEGER PRIMARY KEY,
        team_id INTEGER NOT NULL,
        member_type TEXT,
        agent_id INTEGER REFERENCES agents(id) ON DELETE CASCADE,
        model_id INTEGER,
        position INTEGER
      );
      INSERT INTO team_members (team_id, member_type, agent_id, position) VALUES (1, 'agent', 2, 1);
      CREATE TABLE agent_toolkits (
        agent_id INTEGER NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
        toolkit_id INTEGER NOT NULL,
        PRIMARY KEY (agent_id, toolkit_id)
      );
      INSERT INTO agent_toolkits (agent_id, toolkit_id) VALUES (3, 1);
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY,
        scope TEXT,
        project_id INTEGER,
        agent_id INTEGER REFERENCES agents(id),
        title TEXT,
        description TEXT,
        type TEXT,
        body TEXT,
        status TEXT,
        horizon TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      INSERT INTO memories (scope, agent_id, title, body, status, horizon, created_at, updated_at)
        VALUES ('agent', 2, 'master mem', 'body', 'approved', 'long', datetime('now'), datetime('now'));
      CREATE TABLE plumbing_configs (
        project_id INTEGER PRIMARY KEY,
        brain_agent_id INTEGER REFERENCES agents(id),
        backup_brain_agent_id INTEGER REFERENCES agents(id)
      );
      INSERT INTO plumbing_configs (project_id, brain_agent_id, backup_brain_agent_id) VALUES (1, 2, 4);
    `);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );

    const names = (
      dbs.raw.prepare('SELECT name FROM agents ORDER BY name').all() as Array<{ name: string }>
    ).map((r) => r.name);
    // All 10 canonical agents are present (B09a plus the v89 iBrain seed).
    for (const n of B09A_CANONICAL_NAMES) {
      expect(names).toContain(n);
    }
    expect(names).not.toContain('master_agent');
    expect(names).not.toContain('jkagebunshin');
    expect(names).not.toContain('legacy-extra');

    // implementer preserved (canonical)
    const impl = dbs.raw.prepare('SELECT definition_md FROM agents WHERE name = ?').get('implementer') as any;
    expect(impl.definition_md).toBe('# implementer keep');

    // FK cleanup: no role_bindings / project_agents pointing at missing agents
    const orphanBinds = (
      dbs.raw
        .prepare(
          `SELECT COUNT(*) AS c FROM role_bindings rb LEFT JOIN agents a ON a.id = rb.agent_id WHERE a.id IS NULL`
        )
        .get() as { c: number }
    ).c;
    expect(orphanBinds).toBe(0);

    const orphanPa = (
      dbs.raw
        .prepare(
          `SELECT COUNT(*) AS c FROM project_agents pa LEFT JOIN agents a ON a.id = pa.agent_id WHERE a.id IS NULL`
        )
        .get() as { c: number }
    ).c;
    expect(orphanPa).toBe(0);

    // coord default deleted (no surviving coord agent); implementer default intact
    expect(dbs.raw.prepare("SELECT 1 FROM role_defaults WHERE role='coord'").get()).toBeFalsy();
    expect(dbs.raw.prepare("SELECT 1 FROM role_defaults WHERE role='implementer'").get()).toBeTruthy();

    // master_agent memory rebound to agent-master
    const am = dbs.raw.prepare("SELECT id FROM agents WHERE name='agent-master'").get() as { id: number };
    const mem = dbs.raw.prepare("SELECT agent_id FROM memories WHERE title='master mem'").get() as any;
    expect(mem.agent_id).toBe(am.id);

    // plumbing brain remapped to agent-master; backup to jkage
    const jk = dbs.raw.prepare("SELECT id FROM agents WHERE name='jkage'").get() as { id: number };
    const pl = dbs.raw.prepare('SELECT brain_agent_id, backup_brain_agent_id FROM plumbing_configs WHERE project_id=1').get() as any;
    expect(pl.brain_agent_id).toBe(am.id);
    expect(pl.backup_brain_agent_id).toBe(jk.id);

    // primary_driver was legacy-extra → nulled (no remap)
    const proj = dbs.raw.prepare('SELECT primary_driver_agent_id FROM projects WHERE id=1').get() as any;
    expect(proj.primary_driver_agent_id).toBeNull();

    const fkProblems = (dbs.raw.prepare('PRAGMA foreign_key_check').all() as any[]).filter(
      (p: any) => p.parent === 'agents' || p.table === 'agents'
    );
    expect(fkProblems).toHaveLength(0);

    dbs.close();
  });

  it('does not wipe canonical seeds when extras are present (additive B09a then prune)', () => {
    const t = tempDbPath('helm-b09b-no-wipe-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    // Inject a non-canonical, re-run prune
    dbs.raw
      .prepare(
        `INSERT INTO agents (name, provider, model, default_effort, spawn_pref, agent_type, definition_md)
         VALUES ('accidental-extra', 'claude', 'claude-sonnet-4-6', 'medium', 'tmux', 'project', '# extra')`
      )
      .run();
    // Point a RESTRICT binding at it
    const extraId = (
      dbs.raw.prepare("SELECT id FROM agents WHERE name='accidental-extra'").get() as { id: number }
    ).id;
    dbs.raw
      .prepare(
        `INSERT INTO role_bindings (project_id, role, agent_id) VALUES (1, 'implementer', ?)`
      )
      .run(extraId);

    const counts = applyB09bPruneNonCanonicalAgents(dbs.raw);
    expect(counts.pruned_names).toEqual(['accidental-extra']);
    expect(counts.role_bindings_deleted).toBe(1);
    expect(counts.agents_after).toBe(10);

    applyB09aCanonicalRosterSeeds(dbs.raw);
    applyB09bPruneNonCanonicalAgents(dbs.raw);

    for (const n of B09A_CANONICAL_NAMES) {
      expect(dbs.raw.prepare('SELECT 1 FROM agents WHERE name = ?').get(n)).toBeTruthy();
    }
    expect(dbs.raw.prepare("SELECT 1 FROM agents WHERE name='accidental-extra'").get()).toBeFalsy();

    dbs.close();
  });
});
