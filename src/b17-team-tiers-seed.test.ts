/**
 * B17 — R4 seed team_tiers from topology intent (B04 model slugs).
 * Scope: seeds + idempotent re-run + v68→v69 mig. UI covered by validation/b17 capture.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import {
  SCHEMA_VERSION,
  B17_TEAM_TIER_SEEDS,
  applyB17TeamTierSeeds,
  applyB04CanonicalModelSeeds,
} from './db/schema.js';
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

function slugMap(svc: TeamService): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of svc.listTeamTiers()) {
    out[`${r.team_type}/${r.tier}`] = r.models.map((m) => String(m.slug || ''));
  }
  return out;
}

describe('B17 team_tiers seeds from topology (R4)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB seeds exactly 6 topology tiers (deliberation+red-team × budget|standard|elite)', () => {
    const t = tempDbPath('helm-b17-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(69);

    const svc = new TeamService(dbs);
    const all = svc.listTeamTiers();
    expect(all).toHaveLength(6);
    expect(B17_TEAM_TIER_SEEDS).toHaveLength(6);

    const m = slugMap(svc);
    expect(m['red-team/budget']).toEqual(['spark', 'sonnet5', 'haiku']);
    expect(m['red-team/standard']).toEqual(['sonnet5', 'grok45', 'spark']);
    expect(m['red-team/elite']).toEqual([
      'opus5',
      'sonnet5',
      'grok45',
      'grokcompose',
      'spark',
      'haiku',
    ]);
    expect(m['deliberation/budget']).toEqual(['sonnet5', 'haiku', 'spark']);
    expect(m['deliberation/standard']).toEqual(['opus5', 'grok45', 'sonnet5']);
    expect(m['deliberation/elite']).toEqual([
      'opus5',
      'sonnet5',
      'grok45',
      'grokcompose',
      'spark',
      'haiku',
    ]);

    dbs.close();
  });

  it('applyB17TeamTierSeeds is idempotent (no dupe rows; rosters stable)', () => {
    const t = tempDbPath('helm-b17-idem-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const before = slugMap(new TeamService(dbs));
    expect(Object.keys(before)).toHaveLength(6);

    applyB17TeamTierSeeds(dbs.raw);
    applyB17TeamTierSeeds(dbs.raw);

    const count = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM team_tiers').get() as any).c;
    expect(count).toBe(6);
    expect(slugMap(new TeamService(dbs))).toEqual(before);

    dbs.close();
  });

  it('v68→v69 migration seeds topology tiers on upgraded DB', () => {
    const t = tempDbPath('helm-b17-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const old = new Database(t.dbPath);
    old.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version (version) VALUES (68);
CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  cli TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL
);
CREATE TABLE team_tiers (
  id INTEGER PRIMARY KEY,
  team_type TEXT NOT NULL CHECK(team_type IN ('deliberation', 'red-team')),
  tier TEXT NOT NULL CHECK(tier IN ('budget', 'standard', 'elite')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_type, tier)
);
CREATE TABLE team_tier_models (
  id INTEGER PRIMARY KEY,
  team_type TEXT NOT NULL CHECK(team_type IN ('deliberation', 'red-team')),
  tier TEXT NOT NULL CHECK(tier IN ('budget', 'standard', 'elite')),
  model_id INTEGER NOT NULL REFERENCES models(id),
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(team_type, tier, position),
  UNIQUE(team_type, tier, model_id)
);
`);
    // Minimal B04 rows needed by applyB04CanonicalModelSeeds path + seed slugs
    applyB04CanonicalModelSeeds(old);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(ver).toBeGreaterThanOrEqual(69);

    const m = slugMap(new TeamService(dbs));
    expect(Object.keys(m)).toHaveLength(6);
    expect(m['red-team/budget']).toEqual(['spark', 'sonnet5', 'haiku']);
    expect(m['deliberation/standard']).toEqual(['opus5', 'grok45', 'sonnet5']);

    dbs.close();
  });
});
