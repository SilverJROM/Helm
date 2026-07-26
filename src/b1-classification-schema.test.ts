/**
 * B1 — agents.classification (solo|tiered|team): schema + migration + backfill + API.
 * AC-1, AC-2, AC-15 (partial). Backend only.
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

describe('B1 agents.classification: solo|tiered|team', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB: SCHEMA_VERSION ≥94; classification column + CHECK; AC-2 name map on seeds', () => {
    const t = tempDbPath('helm-b1-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(94);

    const createSql = (
      dbs.raw.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='agents'`).get() as any
    ).sql as string;
    expect(createSql).toMatch(
      /classification[^,]*CHECK\(classification IN \('solo','tiered','team'\)\)/
    );

    const cols = (dbs.raw.prepare('PRAGMA table_info(agents)').all() as any[]).map((c) => c.name);
    expect(cols).toContain('classification');

    const as = new AgentAssignmentService(dbs);
    const byName = (name: string) => as.listAgents().find((x) => x.name === name);

    expect(byName('implementer')!.classification).toBe('tiered');
    expect(byName('validator')!.classification).toBe('tiered');
    expect(byName('planner')!.classification).toBe('team');
    expect(byName('discovery')!.classification).toBe('solo');
    expect(byName('plancore')!.classification).toBe('solo');
    expect(byName('ibrain')!.classification).toBe('solo');
    expect(byName('panelist')!.classification).toBe('solo');
    // B11: panelist remains solo but is hidden from product surfaces
    expect(byName('panelist')!.in_development).toBe(true);

    // Freeform classification rejected at DB layer for raw inserts
    expect(() => {
      dbs.raw
        .prepare(
          `INSERT INTO agents (name, provider, model, default_effort, spawn_pref, agent_type, classification)
           VALUES (?,?,?,?,?,?,?)`
        )
        .run('b1-raw-bad', 'claude', 'claude-sonnet-4-6', 'medium', 'tmux', 'project', 'bogus');
    }).toThrow(/CHECK|constraint/i);

    dbs.close();
  });

  it('v93→v94 migration: ADD COLUMN + AC-2 name-map backfill; custom stays solo; idempotent', () => {
    const t = tempDbPath('helm-b1-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Minimal pre-v94 agents table (no classification column)
    const old = new Database(t.dbPath);
    old.exec(`
      CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
      INSERT INTO schema_version (version) VALUES (93);
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
        agent_type TEXT NOT NULL DEFAULT 'project' CHECK(agent_type IN ('house','project')),
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
      INSERT INTO agents (id, name, provider, model, agent_type) VALUES
        (1, 'discovery', 'claude', 'claude-sonnet-4-6', 'project'),
        (2, 'plancore', 'claude', 'claude-sonnet-4-6', 'project'),
        (3, 'ibrain', 'claude', 'claude-sonnet-4-6', 'project'),
        (4, 'panelist', 'claude', 'claude-sonnet-4-6', 'project'),
        (5, 'implementer', 'grok', 'grok-4.5', 'project'),
        (6, 'validator', 'claude', 'claude-sonnet-4-6', 'project'),
        (7, 'planner', 'claude', 'claude-opus-4-8', 'project'),
        (8, 'custom-widget', 'grok', 'grok-4.5', 'project');
    `);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);

    const cols = (dbs.raw.prepare('PRAGMA table_info(agents)').all() as any[]).map((c) => c.name);
    expect(cols).toContain('classification');

    const classOf = (name: string) =>
      (dbs.raw.prepare('SELECT classification FROM agents WHERE name = ?').get(name) as any)
        ?.classification;

    // AC-2 map: discovery/plancore/ibrain/panelist/implementer/validator/planner/custom
    expect(classOf('discovery')).toBe('solo');
    expect(classOf('plancore')).toBe('solo');
    expect(classOf('ibrain')).toBe('solo');
    expect(classOf('panelist')).toBe('solo');
    expect(classOf('implementer')).toBe('tiered');
    expect(classOf('validator')).toBe('tiered');
    expect(classOf('planner')).toBe('team');
    expect(classOf('custom-widget')).toBe('solo');

    // Idempotent re-open
    dbs.close();
    const dbs2 = new DatabaseService(t.dbPath);
    expect((dbs2.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    const classOf2 = (name: string) =>
      (dbs2.raw.prepare('SELECT classification FROM agents WHERE name = ?').get(name) as any)
        ?.classification;
    expect(classOf2('implementer')).toBe('tiered');
    expect(classOf2('planner')).toBe('team');
    expect(classOf2('custom-widget')).toBe('solo');
    dbs2.close();
  });

  it('API surface: create defaults solo; explicit tiered/team persist; bogus rejected; update whitelist', () => {
    const t = tempDbPath('helm-b1-api-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const as = new AgentAssignmentService(dbs);

    // create with no classification → solo
    const created = as.createAgent({
      name: 'b1-default-class',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
    });
    expect(created.classification).toBe('solo');
    expect(as.getAgent(created.id)!.classification).toBe('solo');

    // create with explicit tiered / team
    const tiered = as.createAgent({
      name: 'b1-tiered-agent',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      classification: 'tiered',
    });
    expect(tiered.classification).toBe('tiered');
    expect(as.listAgents().find((a) => a.id === tiered.id)!.classification).toBe('tiered');

    const team = as.createAgent({
      name: 'b1-team-agent',
      provider: 'claude',
      model: 'claude-sonnet-4-6',
      classification: 'team',
    });
    expect(team.classification).toBe('team');

    // create with bogus → throw (route maps to 4xx)
    expect(() =>
      as.createAgent({
        name: 'b1-bogus-class',
        provider: 'claude',
        model: 'claude-sonnet-4-6',
        classification: 'bogus',
      })
    ).toThrow(/invalid classification/);

    // update whitelist-guarded
    const updated = as.updateAgent(created.id, { classification: 'tiered' });
    expect(updated.classification).toBe('tiered');
    const back = as.updateAgent(created.id, { classification: 'solo' });
    expect(back.classification).toBe('solo');
    expect(() => as.updateAgent(created.id, { classification: 'bogus' })).toThrow(
      /invalid classification/
    );

    // kind/agent_type untouched by classification
    expect(created.kind).toBe('project');
    expect(tiered.agent_type).toBe('project');

    dbs.close();
  });
});
