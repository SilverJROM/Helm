/**
 * B12b — R3.12 seed role_tiers from topology intent (B04 model slugs).
 * Scope: seeds + idempotent re-run + v66→v67 mig. No B13 invariants, no B12c UI.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import {
  SCHEMA_VERSION,
  B12B_ROLE_TIER_SEEDS,
  applyB12bRoleTierSeeds,
  applyB04CanonicalModelSeeds,
} from './db/schema.js';
import { ModelService } from './services/model-service.js';
import { RoleTierService } from './services/role-tier-service.js';

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

function slugMap(svc: RoleTierService): Record<string, { primary: string | null; backup: string | null }> {
  const out: Record<string, { primary: string | null; backup: string | null }> = {};
  for (const r of svc.listRoleTiers()) {
    out[`${r.role}/${r.tier}`] = {
      primary: r.primary_model_slug ?? null,
      backup: r.backup_model_slug ?? null,
    };
  }
  return out;
}

describe('B12b role_tiers seeds from topology (R3.12)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB seeds exactly 6 topology rows (impl p/b + val primary-only)', () => {
    const t = tempDbPath('helm-b12b-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    expect((dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version).toBe(
      SCHEMA_VERSION
    );
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(67);

    const svc = new RoleTierService(dbs);
    const all = svc.listRoleTiers();
    expect(all).toHaveLength(6);
    expect(B12B_ROLE_TIER_SEEDS).toHaveLength(6);

    const m = slugMap(svc);
    expect(m['implementer/L1']).toEqual({ primary: 'grokcompose', backup: 'spark' });
    expect(m['implementer/L2']).toEqual({ primary: 'grok45', backup: 'haiku' });
    expect(m['implementer/L3']).toEqual({ primary: 'codex55', backup: 'sonnet5' });
    expect(m['validator/L1']).toEqual({ primary: 'grok45', backup: null });
    expect(m['validator/L2']).toEqual({ primary: 'sonnet5', backup: null });
    expect(m['validator/L3']).toEqual({ primary: 'opus5', backup: null });

    // opus never implements
    for (const r of all.filter((x) => x.role === 'implementer')) {
      expect(r.primary_model_slug).not.toBe('opus5');
      expect(r.backup_model_slug).not.toBe('opus5');
    }

    dbs.close();
  });

  it('applyB12bRoleTierSeeds is idempotent (no dupe rows; bindings stable)', () => {
    const t = tempDbPath('helm-b12b-idem-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const before = slugMap(new RoleTierService(dbs));
    expect(Object.keys(before)).toHaveLength(6);

    applyB12bRoleTierSeeds(dbs.raw);
    applyB12bRoleTierSeeds(dbs.raw);

    const count = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM role_tiers').get() as any).c;
    expect(count).toBe(6);
    expect(slugMap(new RoleTierService(dbs))).toEqual(before);

    dbs.close();
  });

  it('v66→v67 migration seeds topology rows on upgraded DB', () => {
    const t = tempDbPath('helm-b12b-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Minimal v66: role_tiers empty + enough models for B04 upsert path.
    const old = new Database(t.dbPath);
    old.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version (version) VALUES (66);
CREATE TABLE models (
  id INTEGER PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  provider TEXT NOT NULL,
  model_id TEXT NOT NULL,
  cli TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL
);
CREATE TABLE role_tiers (
  id INTEGER PRIMARY KEY,
  role TEXT NOT NULL CHECK(role IN ('implementer', 'validator')),
  tier TEXT NOT NULL CHECK(tier IN ('L1', 'L2', 'L3')),
  primary_model_id INTEGER REFERENCES models(id),
  backup_model_id INTEGER REFERENCES models(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(role, tier)
);
`);
    // Seed B04 models directly so applyB12b can resolve slugs (mig also re-applies B04).
    applyB04CanonicalModelSeeds(old);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(ver).toBeGreaterThanOrEqual(67);

    const svc = new RoleTierService(dbs);
    expect(svc.listRoleTiers()).toHaveLength(6);
    const m = slugMap(svc);
    expect(m['implementer/L1']).toEqual({ primary: 'grokcompose', backup: 'spark' });
    expect(m['implementer/L3']).toEqual({ primary: 'codex55', backup: 'sonnet5' });
    expect(m['validator/L3']).toEqual({ primary: 'opus5', backup: null });

    // B04 models still present
    const ms = new ModelService(dbs);
    expect(ms.listModels().some((x) => x.slug === 'grokcompose')).toBe(true);

    dbs.close();
  });
});
