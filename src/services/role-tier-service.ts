/**
 * B12a / R3.12 — Studio role×tier model bindings (API only; seeds = B12b; UI = B12c).
 * B13 / R3.16 — save-time invariants on create/update (opus never implements; backup≠same-tier val).
 * implementer|validator × L1|L2|L3 × primary + optional backup.
 */
import { DatabaseService } from '../db/database.js';
import {
  assertAllRoleTiersInvariants,
  assertRoleTierSaveInvariants,
} from '../db/role-tier-invariants.js';

export type RoleTierRole = 'implementer' | 'validator';
export type RoleTierLevel = 'L1' | 'L2' | 'L3';

export const ROLE_TIER_ROLES: readonly RoleTierRole[] = ['implementer', 'validator'] as const;
export const ROLE_TIER_LEVELS: readonly RoleTierLevel[] = ['L1', 'L2', 'L3'] as const;

export { assertAllRoleTiersInvariants, assertRoleTierSaveInvariants };

export interface RoleTier {
  id: number;
  role: RoleTierRole;
  tier: RoleTierLevel;
  primary_model_id: number | null;
  backup_model_id: number | null;
  /** Joined from models when present (read convenience; not stored). */
  primary_model_slug?: string | null;
  primary_model_name?: string | null;
  backup_model_slug?: string | null;
  backup_model_name?: string | null;
  created_at: string;
  updated_at: string;
}

function requireRole(role: string | undefined | null): RoleTierRole {
  const r = String(role || '').trim();
  if (!(ROLE_TIER_ROLES as readonly string[]).includes(r)) {
    throw new Error(`invalid role: ${role} (allowed: ${ROLE_TIER_ROLES.join(', ')})`);
  }
  return r as RoleTierRole;
}

function requireTier(tier: string | undefined | null): RoleTierLevel {
  const t = String(tier || '').trim();
  if (!(ROLE_TIER_LEVELS as readonly string[]).includes(t)) {
    throw new Error(`invalid tier: ${tier} (allowed: ${ROLE_TIER_LEVELS.join(', ')})`);
  }
  return t as RoleTierLevel;
}

function modelIdExists(db: DatabaseService, id: number | null): boolean {
  if (id == null) return true;
  const row = db.prepare('SELECT id FROM models WHERE id = ?').get(id);
  return !!row;
}

function parseOptionalModelId(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid ${field}: must be a positive integer model id or null`);
  }
  return n;
}

function rowToRoleTier(row: any): RoleTier {
  return {
    id: Number(row.id),
    role: row.role as RoleTierRole,
    tier: row.tier as RoleTierLevel,
    primary_model_id: row.primary_model_id != null ? Number(row.primary_model_id) : null,
    backup_model_id: row.backup_model_id != null ? Number(row.backup_model_id) : null,
    primary_model_slug: row.primary_model_slug != null ? String(row.primary_model_slug) : null,
    primary_model_name: row.primary_model_name != null ? String(row.primary_model_name) : null,
    backup_model_slug: row.backup_model_slug != null ? String(row.backup_model_slug) : null,
    backup_model_name: row.backup_model_name != null ? String(row.backup_model_name) : null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  };
}

const SELECT_WITH_MODELS = `
  SELECT
    rt.*,
    pm.slug AS primary_model_slug,
    pm.name AS primary_model_name,
    bm.slug AS backup_model_slug,
    bm.name AS backup_model_name
  FROM role_tiers rt
  LEFT JOIN models pm ON pm.id = rt.primary_model_id
  LEFT JOIN models bm ON bm.id = rt.backup_model_id
`;

export class RoleTierService {
  constructor(private readonly db: DatabaseService) {}

  listRoleTiers(role?: string | null): RoleTier[] {
    if (role != null && String(role).trim()) {
      const r = requireRole(role);
      const rows = this.db
        .prepare(
          `${SELECT_WITH_MODELS}
           WHERE rt.role = ?
           ORDER BY CASE rt.tier WHEN 'L1' THEN 1 WHEN 'L2' THEN 2 WHEN 'L3' THEN 3 ELSE 9 END`
        )
        .all(r) as any[];
      return rows.map(rowToRoleTier);
    }
    const rows = this.db
      .prepare(
        `${SELECT_WITH_MODELS}
         ORDER BY rt.role,
           CASE rt.tier WHEN 'L1' THEN 1 WHEN 'L2' THEN 2 WHEN 'L3' THEN 3 ELSE 9 END`
      )
      .all() as any[];
    return rows.map(rowToRoleTier);
  }

  getRoleTier(role: string, tier: string): RoleTier | null {
    const r = requireRole(role);
    const t = requireTier(tier);
    const row = this.db
      .prepare(`${SELECT_WITH_MODELS} WHERE rt.role = ? AND rt.tier = ?`)
      .get(r, t) as any;
    return row ? rowToRoleTier(row) : null;
  }

  createRoleTier(input: {
    role: string;
    tier: string;
    primary_model_id?: number | null;
    backup_model_id?: number | null;
  }): RoleTier {
    const role = requireRole(input.role);
    const tier = requireTier(input.tier);
    const primary_model_id = parseOptionalModelId(input.primary_model_id, 'primary_model_id');
    const backup_model_id = parseOptionalModelId(input.backup_model_id, 'backup_model_id');
    if (!modelIdExists(this.db, primary_model_id)) {
      throw new Error(`unknown model id for primary_model_id: ${primary_model_id}`);
    }
    if (!modelIdExists(this.db, backup_model_id)) {
      throw new Error(`unknown model id for backup_model_id: ${backup_model_id}`);
    }
    // B13 / R3.16 save-time invariants (before write)
    assertRoleTierSaveInvariants(this.db, {
      role,
      tier,
      primary_model_id,
      backup_model_id,
    });
    try {
      this.db
        .prepare(
          `INSERT INTO role_tiers (role, tier, primary_model_id, backup_model_id)
           VALUES (?, ?, ?, ?)`
        )
        .run(role, tier, primary_model_id, backup_model_id);
    } catch (e: any) {
      const msg = String(e?.message || e);
      if (msg.includes('UNIQUE') || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error(`role tier already exists: ${role}/${tier}`);
      }
      throw e;
    }
    const created = this.getRoleTier(role, tier);
    if (!created) throw new Error('role tier not found after create');
    return created;
  }

  updateRoleTier(
    role: string,
    tier: string,
    input: {
      primary_model_id?: number | null;
      backup_model_id?: number | null;
    }
  ): RoleTier {
    const existing = this.getRoleTier(role, tier);
    if (!existing) throw new Error(`unknown role tier: ${role}/${tier}`);

    const sets: string[] = [];
    const vals: any[] = [];
    let nextPrimary = existing.primary_model_id;
    let nextBackup = existing.backup_model_id;

    if ('primary_model_id' in input) {
      const primary_model_id = parseOptionalModelId(input.primary_model_id, 'primary_model_id');
      if (!modelIdExists(this.db, primary_model_id)) {
        throw new Error(`unknown model id for primary_model_id: ${primary_model_id}`);
      }
      sets.push('primary_model_id = ?');
      vals.push(primary_model_id);
      nextPrimary = primary_model_id;
    }
    if ('backup_model_id' in input) {
      const backup_model_id = parseOptionalModelId(input.backup_model_id, 'backup_model_id');
      if (!modelIdExists(this.db, backup_model_id)) {
        throw new Error(`unknown model id for backup_model_id: ${backup_model_id}`);
      }
      sets.push('backup_model_id = ?');
      vals.push(backup_model_id);
      nextBackup = backup_model_id;
    }

    if (sets.length === 0) {
      return existing;
    }

    // B13 / R3.16: validate merged final state before write
    assertRoleTierSaveInvariants(this.db, {
      role: existing.role,
      tier: existing.tier,
      primary_model_id: nextPrimary,
      backup_model_id: nextBackup,
    });

    sets.push(`updated_at = datetime('now')`);
    this.db
      .prepare(`UPDATE role_tiers SET ${sets.join(', ')} WHERE role = ? AND tier = ?`)
      .run(...vals, existing.role, existing.tier);

    const updated = this.getRoleTier(existing.role, existing.tier);
    if (!updated) throw new Error('role tier not found after update');
    return updated;
  }

  deleteRoleTier(role: string, tier: string): void {
    const existing = this.getRoleTier(role, tier);
    if (!existing) throw new Error(`unknown role tier: ${role}/${tier}`);
    this.db.prepare('DELETE FROM role_tiers WHERE role = ? AND tier = ?').run(existing.role, existing.tier);
  }
}
