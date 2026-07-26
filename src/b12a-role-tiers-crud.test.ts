/**
 * B12a — R3.12 role_tiers schema + CRUD (primary+backup per L1/L2/L3).
 * Scope: schema/mig + RoleTierService + API surface tests via service.
 * B12b may seed defaults on fresh DBs — CRUD tests work with or clear seeds.
 * No B13 invariants, no UI.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { DatabaseService } from './db/database.js';
import { SCHEMA_VERSION } from './db/schema.js';
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

function modelIdsBySlug(ms: ModelService): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of ms.listModels()) {
    out[m.slug] = m.id;
  }
  return out;
}

describe('B12a role_tiers schema + CRUD (R3.12)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh DB lands SCHEMA_VERSION ≥66 with role_tiers table shape', () => {
    const t = tempDbPath('helm-b12a-fresh-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(66);

    const tables = (
      dbs.raw.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='role_tiers'`).all() as any[]
    ).map((r) => r.name);
    expect(tables).toContain('role_tiers');

    const cols = (dbs.raw.prepare('PRAGMA table_info(role_tiers)').all() as any[]).map((c) => c.name);
    for (const name of ['id', 'role', 'tier', 'primary_model_id', 'backup_model_id', 'created_at', 'updated_at']) {
      expect(cols, name).toContain(name);
    }

    // B12b seeds defaults on fresh path; schema/CRUD contract only requires table usability.
    const count = (dbs.raw.prepare('SELECT COUNT(*) AS c FROM role_tiers').get() as any).c;
    expect(count).toBeGreaterThanOrEqual(0);

    const svc = new RoleTierService(dbs);
    expect(Array.isArray(svc.listRoleTiers())).toBe(true);

    dbs.close();
  });

  it('v65→v66+ migration creates role_tiers table (usable for CRUD)', () => {
    const t = tempDbPath('helm-b12a-mig-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    // Minimal pre-v66 DB: schema_version=65, models table only (FK target).
    const old = new Database(t.dbPath);
    old.exec(`
CREATE TABLE schema_version (version INTEGER PRIMARY KEY);
INSERT INTO schema_version (version) VALUES (65);
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
VALUES (1, 'g45', 'grok', 'grok-4.5', 'grok', 'grok45', 'Grok 4.5');
`);
    old.close();

    const dbs = new DatabaseService(t.dbPath);
    const ver = (dbs.raw.prepare('SELECT version FROM schema_version').get() as any).version;
    expect(ver).toBe(SCHEMA_VERSION);
    expect(ver).toBeGreaterThanOrEqual(66);

    // Table usable after mig (B12b may seed any rows whose primary slug exists, e.g. grok45).
    const svc = new RoleTierService(dbs);
    const existing = svc.getRoleTier('implementer', 'L1');
    if (existing) {
      svc.deleteRoleTier('implementer', 'L1');
    }
    const row = svc.createRoleTier({
      role: 'implementer',
      tier: 'L1',
      primary_model_id: 1,
      backup_model_id: null,
    });
    expect(row.primary_model_id).toBe(1);
    expect(row.backup_model_id).toBeNull();

    dbs.close();
  });

  it('CRUD: implementer L1/L2/L3 primary+backup; validator primary-only; update; delete', () => {
    const t = tempDbPath('helm-b12a-crud-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;

    const dbs = new DatabaseService(t.dbPath);
    const ms = new ModelService(dbs);
    const ids = modelIdsBySlug(ms);

    // B04 seeds present (hard dep context)
    expect(ids.grokcompose).toBeTruthy();
    expect(ids.spark).toBeTruthy();
    expect(ids.grok45).toBeTruthy();
    expect(ids.haiku).toBeTruthy();
    expect(ids.codex55).toBeTruthy();
    expect(ids.sonnet5).toBeTruthy();
    expect(ids['opus4.8']).toBeTruthy();

    const opus = ids['opus4.8'];
    const svc = new RoleTierService(dbs);

    // Clear B12b defaults so this test owns full create/list/delete surface.
    for (const role of ['implementer', 'validator'] as const) {
      for (const tier of ['L1', 'L2', 'L3'] as const) {
        if (svc.getRoleTier(role, tier)) svc.deleteRoleTier(role, tier);
      }
    }
    expect(svc.listRoleTiers()).toHaveLength(0);

    // Implementer: all three tiers with primary + backup
    const iL1 = svc.createRoleTier({
      role: 'implementer',
      tier: 'L1',
      primary_model_id: ids.grokcompose,
      backup_model_id: ids.spark,
    });
    const iL2 = svc.createRoleTier({
      role: 'implementer',
      tier: 'L2',
      primary_model_id: ids.grok45,
      backup_model_id: ids.haiku,
    });
    const iL3 = svc.createRoleTier({
      role: 'implementer',
      tier: 'L3',
      primary_model_id: ids.codex55,
      backup_model_id: ids.sonnet5,
    });

    expect(iL1.tier).toBe('L1');
    expect(iL1.primary_model_id).toBe(ids.grokcompose);
    expect(iL1.backup_model_id).toBe(ids.spark);
    expect(iL1.primary_model_slug).toBe('grokcompose');
    expect(iL1.backup_model_slug).toBe('spark');

    expect(iL2.primary_model_id).toBe(ids.grok45);
    expect(iL2.backup_model_id).toBe(ids.haiku);
    expect(iL3.primary_model_id).toBe(ids.codex55);
    expect(iL3.backup_model_id).toBe(ids.sonnet5);

    // Validator: primary only (backup null — I7 backup-less is data shape, not schema ban)
    const vL1 = svc.createRoleTier({
      role: 'validator',
      tier: 'L1',
      primary_model_id: ids.grok45,
      backup_model_id: null,
    });
    const vL2 = svc.createRoleTier({
      role: 'validator',
      tier: 'L2',
      primary_model_id: ids.sonnet5,
    });
    const vL3 = svc.createRoleTier({
      role: 'validator',
      tier: 'L3',
      primary_model_id: opus,
    });
    expect(vL1.backup_model_id).toBeNull();
    expect(vL2.backup_model_id).toBeNull();
    expect(vL3.primary_model_id).toBe(opus);
    expect(vL3.backup_model_id).toBeNull();

    // list all + by role
    const all = svc.listRoleTiers();
    expect(all).toHaveLength(6);
    const implOnly = svc.listRoleTiers('implementer');
    expect(implOnly).toHaveLength(3);
    expect(implOnly.map((r) => r.tier)).toEqual(['L1', 'L2', 'L3']);

    // get one
    const got = svc.getRoleTier('implementer', 'L2');
    expect(got).toBeTruthy();
    expect(got!.primary_model_slug).toBe('grok45');
    expect(got!.backup_model_slug).toBe('haiku');

    // update primary and backup independently
    const updPrimary = svc.updateRoleTier('implementer', 'L2', { primary_model_id: ids.sonnet5 });
    expect(updPrimary.primary_model_id).toBe(ids.sonnet5);
    expect(updPrimary.backup_model_id).toBe(ids.haiku); // backup unchanged

    const updBackup = svc.updateRoleTier('implementer', 'L2', { backup_model_id: ids.spark });
    expect(updBackup.primary_model_id).toBe(ids.sonnet5);
    expect(updBackup.backup_model_id).toBe(ids.spark);

    // clear backup explicitly
    const cleared = svc.updateRoleTier('implementer', 'L2', { backup_model_id: null });
    expect(cleared.backup_model_id).toBeNull();

    // delete
    svc.deleteRoleTier('validator', 'L1');
    expect(svc.getRoleTier('validator', 'L1')).toBeNull();
    expect(svc.listRoleTiers('validator')).toHaveLength(2);

    // duplicate create rejects
    expect(() =>
      svc.createRoleTier({
        role: 'implementer',
        tier: 'L1',
        primary_model_id: ids.grok45,
      })
    ).toThrow(/already exists/i);

    // bad role / tier
    expect(() => svc.createRoleTier({ role: 'planner', tier: 'L1', primary_model_id: ids.grok45 })).toThrow(
      /invalid role/i
    );
    expect(() =>
      svc.createRoleTier({ role: 'implementer', tier: 'L4', primary_model_id: ids.grok45 })
    ).toThrow(/invalid tier/i);

    // unknown model id
    expect(() =>
      svc.createRoleTier({
        role: 'validator',
        tier: 'L1',
        primary_model_id: 999999,
      })
    ).toThrow(/unknown model id for primary_model_id/i);
    expect(() =>
      svc.updateRoleTier('implementer', 'L3', { backup_model_id: 999999 })
    ).toThrow(/unknown model id for backup_model_id/i);

    // update missing → throw
    expect(() => svc.updateRoleTier('validator', 'L1', { primary_model_id: ids.grok45 })).toThrow(
      /unknown role tier/i
    );

    dbs.close();
  });
});
