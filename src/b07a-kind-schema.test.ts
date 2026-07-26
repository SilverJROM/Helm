/**
 * B07a — R2.7 kind field: project | house; helm → house backfill; API reject invalid.
 * Scope: schema + migration + AgentAssignmentService surface only (no B07b/B07c fences).
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
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

describe('B07a kind schema: project|house; helm→house', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB: SCHEMA_VERSION ≥63; agent_type CHECK house|project; house stubs seeded', () => {
    const t = tempDbPath('helm-b07a-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(63);

    const createSql = (dbs.raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get() as any).sql as string;
    expect(createSql).toMatch(/agent_type[^,]*CHECK\(agent_type IN \('house','project'\)\)/);
    expect(createSql).not.toMatch(/'helm'/);

    const as = new AgentAssignmentService(dbs);
    const houseNames = ['agent-master', 'jkage', 'overseer'];
    for (const name of houseNames) {
      const a = as.listAgents().find((x) => x.name === name)!;
      expect(a, name).toBeTruthy();
      expect(a.kind).toBe('house');
      expect(a.agent_type).toBe('house');
      const raw = dbs.raw.prepare('SELECT agent_type FROM agents WHERE name = ?').get(name) as any;
      expect(raw.agent_type).toBe('house');
    }

    const impl = as.listAgents().find((x) => x.name === 'implementer')!;
    expect(impl.kind).toBe('project');
    expect(impl.agent_type).toBe('project');

    // Freeform kind rejected at DB layer for raw inserts
    expect(() => {
      dbs.raw
        .prepare(
          `INSERT INTO agents (name, provider, model, default_effort, spawn_pref, agent_type) VALUES (?,?,?,?,?,?)`
        )
        .run('b07a-raw-bad', 'claude', 'claude-sonnet-4-6', 'medium', 'tmux', 'studio');
    }).toThrow(/CHECK|constraint/i);

    dbs.close();
  });

  it('v62→v63 migration: helm rows backfill to house; project preserved; row count stable', () => {
    const t = tempDbPath('helm-b07a-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const old = new Database(t.dbPath);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (62);
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
        agent_type TEXT NOT NULL DEFAULT 'project' CHECK(agent_type IN ('helm','project')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO agents (id, name, provider, model, agent_type) VALUES
        (1, 'legacy-house', 'claude', 'claude-sonnet-4-6', 'helm'),
        (2, 'legacy-project', 'grok', 'grok-4.5', 'project'),
        (3, 'already-house-name', 'claude', 'claude-sonnet-4-6', 'helm');
    `);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);

    // v63 rebuild maps helm→house. B09b may prune non-canonical rows (legacy-house etc.);
    // assert the CHECK + remaining rows, not the pre-B09b ids.
    const createSql = (dbs.raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get() as any).sql as string;
    expect(createSql).toMatch(/'house'/);
    expect(createSql).not.toMatch(/'helm'/);

    // No residual helm values on any remaining row
    const helmLeft = (dbs.raw.prepare(`SELECT COUNT(*) as c FROM agents WHERE agent_type = 'helm'`).get() as any).c;
    expect(helmLeft).toBe(0);

    // Canonical house/project seeds land with correct kinds
    const overseer = dbs.raw.prepare("SELECT agent_type FROM agents WHERE name='overseer'").get() as any;
    const impl = dbs.raw.prepare("SELECT agent_type FROM agents WHERE name='implementer'").get() as any;
    expect(overseer?.agent_type).toBe('house');
    expect(impl?.agent_type).toBe('project');

    // Idempotent re-open
    dbs.close();
    const dbs2 = new DatabaseService(t.dbPath);
    expect((dbs2.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(SCHEMA_VERSION);
    expect(
      (dbs2.raw.prepare(`SELECT agent_type FROM agents WHERE name = 'overseer'`).get() as any).agent_type
    ).toBe('house');
    dbs2.close();
  });

  it('API surface: kind returned; create/update accept kind; reject invalid; legacy helm alias → house', () => {
    const t = tempDbPath('helm-b07a-api-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);

    const created = as.createAgent({
      name: 'b07a-default-kind',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });
    expect(created.kind).toBe('project');
    expect(created.agent_type).toBe('project');

    const house = as.createAgent({
      name: 'b07a-house-kind',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      kind: 'house',
    });
    expect(house.kind).toBe('house');
    expect(house.agent_type).toBe('house');

    // Legacy agent_type input still accepted
    const viaLegacy = as.createAgent({
      name: 'b07a-via-agent-type',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      agent_type: 'house',
    });
    expect(viaLegacy.kind).toBe('house');

    // Legacy helm alias maps to house
    const viaHelm = as.createAgent({
      name: 'b07a-via-helm-alias',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      kind: 'helm' as any,
    });
    expect(viaHelm.kind).toBe('house');

    const updated = as.updateAgent(created.id, { kind: 'house' });
    expect(updated.kind).toBe('house');
    const back = as.updateAgent(created.id, { agent_type: 'project' });
    expect(back.kind).toBe('project');

    // Reject invalid freeform
    expect(() =>
      as.createAgent({
        name: 'b07a-bad-kind',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        kind: 'studio',
      })
    ).toThrow(/invalid kind/);
    expect(() => as.updateAgent(created.id, { kind: 'registry' })).toThrow(/invalid kind/);
    expect(() => as.updateAgent(created.id, { agent_type: 'other' })).toThrow(/invalid kind/);

    // GET surfaces kind + agent_type alias equal
    const got = as.getAgent(house.id)!;
    expect(got.kind).toBe('house');
    expect(got.agent_type).toBe(got.kind);

    dbs.close();
  });
});
