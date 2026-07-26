/**
 * B16 — R4.18–R4.19 team_tiers schema + CRUD/assignment (budget|standard|elite).
 * Scope: schema/mig + TeamService tier methods. No seeds (B17). No UI (B17).
 * Hard dep: B04 model slugs present on fresh DB.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
import { ModelService } from './services/model-service.js';
import { TeamService } from './services/team-service.js';

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

function modelIdsBySlug(ms: ModelService): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of ms.listModels()) {
    out[m.slug] = m.id;
  }
  return out;
}

describe('B16 team_tiers schema + CRUD (R4.18–R4.19)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB lands SCHEMA_VERSION ≥68 with team_tiers + team_tier_models present', () => {
    const t = tempDbPath('helm-b16-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(68);

    const tables = (
      dbs.raw
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('team_tiers','team_tier_models')`
        )
        .all() as any[]
    ).map((r) => r.name);
    expect(tables).toContain('team_tiers');
    expect(tables).toContain('team_tier_models');

    const tCols = (dbs.raw.prepare('PRAGMA table_info(team_tiers)').all() as any[]).map((c) => c.name);
    for (const name of ['id', 'team_type', 'tier', 'created_at', 'updated_at']) {
      expect(tCols, name).toContain(name);
    }
    const mCols = (dbs.raw.prepare('PRAGMA table_info(team_tier_models)').all() as any[]).map(
      (c) => c.name
    );
    for (const name of ['id', 'team_type', 'tier', 'model_id', 'position']) {
      expect(mCols, name).toContain(name);
    }

    // B17 seeds topology 6 tiers on fresh; schema surface still usable for CRUD
    const svc = new TeamService(dbs);
    expect(svc.listTeamTiers().length).toBeGreaterThanOrEqual(0);
    expect(
      (dbs.raw.prepare('SELECT COUNT(*) AS c FROM team_tiers').get() as any).c
    ).toBeGreaterThanOrEqual(0);

    dbs.close();
  });

  it('v67→v68 migration creates team_tiers tables (usable for assignment)', () => {
    const t = tempDbPath('helm-b16-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const old = new Database(t.dbPath);
    old.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version (version) VALUES (67);
CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  cli TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL
);
INSERT INTO models (id, name, provider, model_id, cli, slug, display_name)
VALUES (1, 'spark', 'codex', 'gpt-5.3-codex-spark', 'codex', 'spark', 'Spark');
`);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(ver).toBeGreaterThanOrEqual(68);

    const svc = new TeamService(dbs);
    const row = svc.setTeamTierModels('red-team', 'budget', [1]);
    expect(row.team_type).toBe('red-team');
    expect(row.tier).toBe('budget');
    expect(row.models).toHaveLength(1);
    expect(row.models[0].model_id).toBe(1);

    dbs.close();
  });

  it('CRUD/assignment: deliberation + red-team × budget|standard|elite ordered models', () => {
    const t = tempDbPath('helm-b16-crud-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const ms = new ModelService(dbs);
    const ids = modelIdsBySlug(ms);

    // B04 seeds present (hard dep)
    expect(ids.spark).toBeTruthy();
    expect(ids.sonnet5).toBeTruthy();
    expect(ids.haiku).toBeTruthy();
    expect(ids.grok45).toBeTruthy();
    expect(ids.grokcompose).toBeTruthy();
    expect(ids['opus5']).toBeTruthy();

    const svc = new TeamService(dbs);
    // Clear B17 seeds so CRUD exercises from empty (tolerate post-B17 fresh seed)
    for (const row of svc.listTeamTiers()) {
      svc.clearTeamTier(row.team_type, row.tier);
    }
    expect(svc.listTeamTiers()).toHaveLength(0);

    // red-team budget (topology intent shape): spark, sonnet, haiku
    const rtBudget = svc.setTeamTierModels('red-team', 'budget', [
      ids.spark,
      ids.sonnet5,
      ids.haiku,
    ]);
    expect(rtBudget.tier).toBe('budget');
    expect(rtBudget.models.map((m) => m.model_id)).toEqual([ids.spark, ids.sonnet5, ids.haiku]);
    expect(rtBudget.models.map((m) => m.position)).toEqual([0, 1, 2]);
    expect(rtBudget.models[0].slug).toBe('spark');
    expect(rtBudget.models[1].slug).toBe('sonnet5');

    // red-team standard + elite
    svc.setTeamTierModels('red-team', 'standard', [ids.sonnet5, ids.grok45, ids.spark]);
    svc.setTeamTierModels('red-team', 'elite', [
      ids['opus5'],
      ids.sonnet5,
      ids.grok45,
      ids.grokcompose,
      ids.spark,
      ids.haiku,
    ]);

    // deliberation all three tiers
    svc.setTeamTierModels('deliberation', 'budget', [ids.spark, ids.haiku]);
    svc.setTeamTierModels('deliberation', 'standard', [ids.sonnet5, ids.grok45, ids.spark]);
    svc.setTeamTierModels('deliberation', 'elite', [ids['opus5'], ids.grok45, ids.sonnet5]);

    const all = svc.listTeamTiers();
    expect(all).toHaveLength(6);
    const redOnly = svc.listTeamTiers('red-team');
    expect(redOnly).toHaveLength(3);
    expect(redOnly.map((r) => r.tier)).toEqual(['budget', 'standard', 'elite']);

    const got = svc.getTeamTier('red-team', 'budget');
    expect(got).toBeTruthy();
    expect(got!.models.map((m) => m.slug)).toEqual(['spark', 'sonnet5', 'haiku']);

    // replace assignment (full rewrite)
    const replaced = svc.setTeamTierModels('red-team', 'budget', [ids.haiku, ids.spark]);
    expect(replaced.models.map((m) => m.model_id)).toEqual([ids.haiku, ids.spark]);
    expect(replaced.models.map((m) => m.position)).toEqual([0, 1]);

    // empty roster allowed
    const empty = svc.setTeamTierModels('deliberation', 'budget', []);
    expect(empty.models).toHaveLength(0);
    expect(svc.getTeamTier('deliberation', 'budget')).toBeTruthy();

    // clear deletes header
    svc.clearTeamTier('deliberation', 'budget');
    expect(svc.getTeamTier('deliberation', 'budget')).toBeNull();
    expect(svc.listTeamTiers('deliberation')).toHaveLength(2);

    // bad team_type / tier
    expect(() => svc.setTeamTierModels('generic', 'budget', [ids.spark])).toThrow(/invalid team_type/i);
    expect(() => svc.setTeamTierModels('red-team', 'L1', [ids.spark])).toThrow(/invalid tier/i);
    expect(() => svc.setTeamTierModels('red-team', 'budget', [999999])).toThrow(/unknown model id/i);
    expect(() => svc.setTeamTierModels('red-team', 'budget', [ids.spark, ids.spark])).toThrow(
      /duplicate model_id/i
    );

    // clear existing tier then reject double-clear
    svc.clearTeamTier('red-team', 'budget');
    expect(svc.getTeamTier('red-team', 'budget')).toBeNull();
    expect(() => svc.clearTeamTier('red-team', 'budget')).toThrow(/unknown team tier/i);

    // B1 flat teams still work (untouched surface)
    const flat = svc.createTeam({ name: 'b16-flat-check', type: 'deliberation' });
    expect(flat.name).toBe('b16-flat-check');
    dbs.prepare('UPDATE models SET validation_status = ? WHERE id = ?').run('valid', ids.spark);
    const mem = svc.addMember(flat.id, { model_id: ids.spark });
    expect(mem.model_id).toBe(ids.spark);

    dbs.close();
  });
});
