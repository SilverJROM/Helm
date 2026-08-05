/**
 * B09a — Seed project + house roster (R2.8–R2.9).
 * Scope: seeds only (no B09b prune/FK cleanup, no UI).
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
} from './db/schema.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';

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

describe('B09a canonical roster seeds (R2.8–R2.9)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB: SCHEMA_VERSION ≥64; all 12 canonical names present with stable kinds', () => {
    const t = tempDbPath('helm-b09a-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(64);
    // B09b (v65) may also have run on this open — still must keep all 12 seeds (S15 +housekeeper + B3 branch-safety).

    expect(B09A_PROJECT_NAMES).toEqual([
      'discovery',
      'plancore',
      'ibrain',
      'planner',
      'implementer',
      'validator',
      'panelist',
    ]);
    expect(B09A_HOUSE_NAMES).toEqual(['agent-master', 'overseer', 'jkage', 'housekeeper', 'branch-safety']);
    expect(B09A_CANONICAL_NAMES).toHaveLength(12);

    const as = new AgentAssignmentService(dbs);
    const byName = new Map(as.listAgents().map((a) => [a.name, a]));

    for (const seed of B09A_CANONICAL_AGENT_SEEDS) {
      const row = byName.get(seed.name);
      expect(row, `missing canonical agent ${seed.name}`).toBeTruthy();
      expect(row!.kind).toBe(seed.kind);
      expect(row!.agent_type).toBe(seed.kind);
      expect(row!.definition_md && row!.definition_md.trim().length).toBeGreaterThan(0);
      const raw = dbs.raw.prepare('SELECT agent_type FROM agents WHERE name = ?').get(seed.name) as any;
      expect(raw.agent_type).toBe(seed.kind);
    }

    // House seeds never project; project seeds never house
    for (const name of B09A_HOUSE_NAMES) {
      expect(byName.get(name)!.kind).toBe('house');
    }
    for (const name of B09A_PROJECT_NAMES) {
      expect(byName.get(name)!.kind).toBe('project');
    }

    // jkage L0 identity in prompt (R2.10 UI later; seed stamps frontmatter now)
    expect(byName.get('jkage')!.definition_md).toMatch(/authority:\s*L0|L0 \(learner\)/i);

    dbs.close();
  });

  it('applyB09aCanonicalRosterSeeds is idempotent (stable counts + kinds on re-run)', () => {
    const t = tempDbPath('helm-b09a-idem-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const before = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c;

    applyB09aCanonicalRosterSeeds(dbs.raw);
    applyB09aCanonicalRosterSeeds(dbs.raw);

    const after = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM agents').get() as { c: number }).c;
    expect(after).toBe(before);

    const nameCount = (
      dbs.raw
        .prepare(
          `SELECT COUNT(*) AS c FROM agents WHERE name IN (${B09A_CANONICAL_NAMES.map(() => '?').join(',')})`
        )
        .get(...B09A_CANONICAL_NAMES) as { c: number }
    ).c;
    expect(nameCount).toBe(12);

    const distinct = (
      dbs.raw
        .prepare(
          `SELECT COUNT(DISTINCT name) AS c FROM agents WHERE name IN (${B09A_CANONICAL_NAMES.map(() => '?').join(',')})`
        )
        .get(...B09A_CANONICAL_NAMES) as { c: number }
    ).c;
    expect(distinct).toBe(12);

    for (const seed of B09A_CANONICAL_AGENT_SEEDS) {
      const raw = dbs.raw.prepare('SELECT agent_type FROM agents WHERE name = ?').get(seed.name) as any;
      expect(raw.agent_type).toBe(seed.kind);
    }

    dbs.close();
  });

  it('v63→current migration seeds missing canonical roster rows (B09a additive; B09b may prune extras)', () => {
    const t = tempDbPath('helm-b09a-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Synthetic v63: kind CHECK house|project, only a couple of agents, no north/agent-master/jkage.
    const old = new Database(t.dbPath);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (63);
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
      INSERT INTO models (name, provider, model_id, cli, slug, display_name) VALUES
        ('claude-sonnet', 'claude', 'claude-sonnet-4-6', 'claude', 'sonnet5', 'Sonnet 5');
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
        (1, 'implementer', 'grok', 'grok-4.5', 'project', '# implementer legacy body'),
        (2, 'legacy-extra', 'claude', 'claude-sonnet-4-6', 'project', '# keep me for B09b'),
        (3, 'master_agent', 'claude', 'claude-sonnet-4-6', 'house', '# legacy house name');
    `);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );

    const rows = dbs.raw
      .prepare('SELECT name, agent_type, definition_md FROM agents')
      .all() as Array<{ name: string; agent_type: string; definition_md: string | null }>;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));

    for (const seed of B09A_CANONICAL_AGENT_SEEDS) {
      expect(byName[seed.name], seed.name).toBeTruthy();
      expect(byName[seed.name].agent_type).toBe(seed.kind);
    }

    // MIG1: pre-existing implementer definition preserved through B09a seed
    expect(byName['implementer'].definition_md).toBe('# implementer legacy body');

    // New rows have non-empty prompts
    expect(String(byName['discovery'].definition_md || '').trim().length).toBeGreaterThan(0);
    expect(String(byName['agent-master'].definition_md || '').trim().length).toBeGreaterThan(0);
    expect(String(byName['jkage'].definition_md || '').trim().length).toBeGreaterThan(0);

    // B09a alone is additive; full open may include B09b prune (v65) which removes extras.
    // Scope of this test: canonical seeds land. B09b asserts prune separately.
    if (SCHEMA_VERSION < 65) {
      expect(byName['legacy-extra']).toBeTruthy();
      expect(byName['master_agent']).toBeTruthy();
    }

    dbs.close();
  });

  it('house canonical seeds remain undeliverable into project runs (B07b fence)', () => {
    const t = tempDbPath('helm-b09a-fence-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);
    const pid = (
      dbs.raw
        .prepare(
          `INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`
        )
        .get('b09a-fence-proj', '/tmp/b09a-fence') as { id: number }
    ).id;

    for (const name of B09A_HOUSE_NAMES) {
      const a = as.listAgents().find((x) => x.name === name)!;
      expect(a.kind).toBe('house');
      expect(() => as.setProjectBinding(pid, 'implementer', a.id)).toThrow(
        /house-kind|cannot be dispatched/i
      );
    }

    dbs.close();
  });
});
