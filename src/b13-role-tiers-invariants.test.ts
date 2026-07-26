/**
 * B13 — R3.16 save-time role_tiers invariants + re-validate B12b seeds.
 * Reject: opus on implementer; backup == same-tier validator model.
 * Accept: all 6 B12b topology seed rows pass assertAll.
 * No B12c UI, no B15x resolve-time.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { assertAllRoleTiersInvariants } from './db/role-tier-invariants.js';
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

describe('B13 role_tiers save-time invariants (R3.16)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('rejects opus on implementer primary and backup', () => {
    const t = tempDbPath('helm-b13-opus-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;
    const dbs = new DatabaseService(t.dbPath);
    const ids = modelIdsBySlug(new ModelService(dbs));
    const opus = ids['opus5'];
    expect(opus).toBeTruthy();
    const svc = new RoleTierService(dbs);

    // Clear seeds so we own the surface
    for (const role of ['implementer', 'validator'] as const) {
      for (const tier of ['L1', 'L2', 'L3'] as const) {
        if (svc.getRoleTier(role, tier)) svc.deleteRoleTier(role, tier);
      }
    }

    expect(() =>
      svc.createRoleTier({
        role: 'implementer',
        tier: 'L1',
        primary_model_id: opus,
        backup_model_id: ids.spark,
      })
    ).toThrow(/opus never implements/i);

    expect(() =>
      svc.createRoleTier({
        role: 'implementer',
        tier: 'L1',
        primary_model_id: ids.grok45,
        backup_model_id: opus,
      })
    ).toThrow(/opus never implements/i);

    // Update path: legal create then set opus
    svc.createRoleTier({
      role: 'implementer',
      tier: 'L2',
      primary_model_id: ids.grok45,
      backup_model_id: ids.haiku,
    });
    expect(() => svc.updateRoleTier('implementer', 'L2', { primary_model_id: opus })).toThrow(
      /opus never implements/i
    );
    expect(() => svc.updateRoleTier('implementer', 'L2', { backup_model_id: opus })).toThrow(
      /opus never implements/i
    );

    // Validator may be opus (L3 seat)
    const v = svc.createRoleTier({
      role: 'validator',
      tier: 'L3',
      primary_model_id: opus,
      backup_model_id: null,
    });
    expect(v.primary_model_id).toBe(opus);
    dbs.close();
  });

  it('rejects implementer backup equal to same-tier validator model (and mirror on validator write)', () => {
    const t = tempDbPath('helm-b13-backup-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;
    const dbs = new DatabaseService(t.dbPath);
    const ids = modelIdsBySlug(new ModelService(dbs));
    const svc = new RoleTierService(dbs);

    for (const role of ['implementer', 'validator'] as const) {
      for (const tier of ['L1', 'L2', 'L3'] as const) {
        if (svc.getRoleTier(role, tier)) svc.deleteRoleTier(role, tier);
      }
    }

    // Val L2 primary = sonnet5
    svc.createRoleTier({
      role: 'validator',
      tier: 'L2',
      primary_model_id: ids.sonnet5,
      backup_model_id: null,
    });

    // Implementer L2 backup = sonnet5 → reject (backup_rule)
    expect(() =>
      svc.createRoleTier({
        role: 'implementer',
        tier: 'L2',
        primary_model_id: ids.grok45,
        backup_model_id: ids.sonnet5,
      })
    ).toThrow(/backup must not equal same-tier validator model/i);

    // Legal create (backup haiku ≠ val sonnet5)
    svc.createRoleTier({
      role: 'implementer',
      tier: 'L2',
      primary_model_id: ids.grok45,
      backup_model_id: ids.haiku,
    });

    // Update backup into collision
    expect(() => svc.updateRoleTier('implementer', 'L2', { backup_model_id: ids.sonnet5 })).toThrow(
      /backup must not equal same-tier validator model/i
    );

    // Mirror: change validator primary onto implementer backup (haiku)
    expect(() => svc.updateRoleTier('validator', 'L2', { primary_model_id: ids.haiku })).toThrow(
      /backup must not equal same-tier validator model/i
    );

    // Cross-tier is NOT rejected (B15x territory): impl L2 backup haiku, val L1 primary haiku OK
    svc.createRoleTier({
      role: 'validator',
      tier: 'L1',
      primary_model_id: ids.haiku,
      backup_model_id: null,
    });
    expect(svc.getRoleTier('validator', 'L1')!.primary_model_id).toBe(ids.haiku);
    dbs.close();
  });

  it('re-validates all B12b seeded rows fail-closed (green on topology seeds)', () => {
    const t = tempDbPath('helm-b13-seed-reval-');
    cleanups.push(t.cleanup);
    process.env.HELM_DB_PATH = t.dbPath;
    const dbs = new DatabaseService(t.dbPath);
    const svc = new RoleTierService(dbs);

    const all = svc.listRoleTiers();
    expect(all).toHaveLength(6);

    // Must not throw — seeds satisfy R3.16
    expect(() => assertAllRoleTiersInvariants(dbs)).not.toThrow();

    // Explicit content still matches topology (regression guard)
    const byKey = Object.fromEntries(all.map((r) => [`${r.role}/${r.tier}`, r]));
    expect(byKey['implementer/L1'].primary_model_slug).toBe('grokcompose');
    expect(byKey['implementer/L1'].backup_model_slug).toBe('spark');
    expect(byKey['implementer/L2'].primary_model_slug).toBe('grok45');
    expect(byKey['implementer/L2'].backup_model_slug).toBe('haiku');
    expect(byKey['implementer/L3'].primary_model_slug).toBe('codex55');
    expect(byKey['implementer/L3'].backup_model_slug).toBe('sonnet5');
    expect(byKey['validator/L1'].primary_model_slug).toBe('grok45');
    expect(byKey['validator/L1'].backup_model_id).toBeNull();
    expect(byKey['validator/L2'].primary_model_slug).toBe('sonnet5');
    expect(byKey['validator/L3'].primary_model_slug).toBe('opus5');

    // No implementer seat is opus
    for (const r of all.filter((x) => x.role === 'implementer')) {
      expect(r.primary_model_slug).not.toBe('opus5');
      expect(r.backup_model_slug).not.toBe('opus5');
    }
    dbs.close();
  });
});
