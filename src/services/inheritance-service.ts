/**
 * B18 / R5.20–R5.21 — Inheritance: Agent Studio → Project → Cycle.
 *
 * Studio role_tiers + team_tiers are defaults. Project may sparse-override
 * (row presence = override). Cycle inherits the project's effective setup
 * (no cycle-level tier store this batch; freeze into topology.yaml = B19).
 */
import { DatabaseService } from '../db/database.js';
import {
  assertRoleTierSaveInvariants,
  assertEffectiveRoleTiersInvariants,
} from '../db/role-tier-invariants.js';
import {
  RoleTierService,
  ROLE_TIER_LEVELS,
  ROLE_TIER_ROLES,
  type RoleTier,
  type RoleTierLevel,
  type RoleTierRole,
} from './role-tier-service.js';
import {
  TeamService,
  TEAM_TIER_LEVELS,
  TEAM_TIER_TYPES,
  type TeamTier,
  type TeamTierLevel,
  type TeamTierModel,
  type TeamTierType,
} from './team-service.js';

export type InheritSource = 'studio' | 'project';

export interface EffectiveRoleTier {
  role: RoleTierRole;
  tier: RoleTierLevel;
  primary_model_id: number | null;
  backup_model_id: number | null;
  primary_model_slug?: string | null;
  primary_model_name?: string | null;
  backup_model_slug?: string | null;
  backup_model_name?: string | null;
  source: InheritSource;
}

export interface EffectiveTeamTierModel {
  model_id: number;
  position: number;
  slug?: string | null;
  name?: string | null;
  provider?: string | null;
}

export interface EffectiveTeamTier {
  team_type: TeamTierType;
  tier: TeamTierLevel;
  models: EffectiveTeamTierModel[];
  source: InheritSource;
}

export interface EffectiveTopology {
  project_id: number;
  cycle_id?: number;
  role_tiers: EffectiveRoleTier[];
  team_tiers: EffectiveTeamTier[];
}

function modelIdExists(db: DatabaseService, id: number | null): boolean {
  if (id == null) return true;
  return !!db.prepare('SELECT id FROM models WHERE id = ?').get(id);
}

function parseOptionalModelId(v: unknown, field: string): number | null {
  if (v === undefined || v === null || v === '') return null;
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`invalid ${field}: must be a positive integer model id or null`);
  }
  return n;
}

function parseModelIdList(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    throw new Error('model_ids must be an array of positive integer model ids');
  }
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const n = Number(item);
    if (!Number.isInteger(n) || n <= 0) {
      throw new Error('model_ids must be an array of positive integer model ids');
    }
    if (seen.has(n)) {
      throw new Error(`duplicate model_id in assignment: ${n}`);
    }
    seen.add(n);
    out.push(n);
  }
  return out;
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

function requireTeamType(t: string | undefined | null): TeamTierType {
  const v = String(t || '').trim();
  if (!(TEAM_TIER_TYPES as readonly string[]).includes(v)) {
    throw new Error(`invalid team_type: ${t} (allowed: ${TEAM_TIER_TYPES.join(', ')})`);
  }
  return v as TeamTierType;
}

function requireTeamLevel(t: string | undefined | null): TeamTierLevel {
  const v = String(t || '').trim();
  if (!(TEAM_TIER_LEVELS as readonly string[]).includes(v)) {
    throw new Error(`invalid tier: ${t} (allowed: ${TEAM_TIER_LEVELS.join(', ')})`);
  }
  return v as TeamTierLevel;
}

function studioRoleToEffective(row: RoleTier): EffectiveRoleTier {
  return {
    role: row.role,
    tier: row.tier,
    primary_model_id: row.primary_model_id,
    backup_model_id: row.backup_model_id,
    primary_model_slug: row.primary_model_slug ?? null,
    primary_model_name: row.primary_model_name ?? null,
    backup_model_slug: row.backup_model_slug ?? null,
    backup_model_name: row.backup_model_name ?? null,
    source: 'studio',
  };
}

function studioTeamToEffective(row: TeamTier): EffectiveTeamTier {
  return {
    team_type: row.team_type,
    tier: row.tier,
    models: row.models.map((m: TeamTierModel) => ({
      model_id: m.model_id,
      position: m.position,
      slug: m.slug ?? null,
      name: m.name ?? null,
      provider: m.provider ?? null,
    })),
    source: 'studio',
  };
}

export class InheritanceService {
  private readonly roleTiers: RoleTierService;
  private readonly teamService: TeamService;

  constructor(private readonly db: DatabaseService) {
    this.roleTiers = new RoleTierService(db);
    this.teamService = new TeamService(db);
  }

  private assertProject(projectId: number): void {
    const row = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!row) throw new Error(`unknown project: ${projectId}`);
  }

  private loadProjectRoleOverride(
    projectId: number,
    role: RoleTierRole,
    tier: RoleTierLevel
  ): {
    primary_model_id: number | null;
    backup_model_id: number | null;
    primary_model_slug: string | null;
    primary_model_name: string | null;
    backup_model_slug: string | null;
    backup_model_name: string | null;
  } | null {
    const row = this.db
      .prepare(
        `SELECT prt.primary_model_id, prt.backup_model_id,
                pm.slug AS primary_model_slug, pm.name AS primary_model_name,
                bm.slug AS backup_model_slug, bm.name AS backup_model_name
         FROM project_role_tiers prt
         LEFT JOIN models pm ON pm.id = prt.primary_model_id
         LEFT JOIN models bm ON bm.id = prt.backup_model_id
         WHERE prt.project_id = ? AND prt.role = ? AND prt.tier = ?`
      )
      .get(projectId, role, tier) as any;
    if (!row) return null;
    return {
      primary_model_id: row.primary_model_id != null ? Number(row.primary_model_id) : null,
      backup_model_id: row.backup_model_id != null ? Number(row.backup_model_id) : null,
      primary_model_slug: row.primary_model_slug != null ? String(row.primary_model_slug) : null,
      primary_model_name: row.primary_model_name != null ? String(row.primary_model_name) : null,
      backup_model_slug: row.backup_model_slug != null ? String(row.backup_model_slug) : null,
      backup_model_name: row.backup_model_name != null ? String(row.backup_model_name) : null,
    };
  }

  private loadProjectTeamModels(
    projectId: number,
    teamType: TeamTierType,
    tier: TeamTierLevel
  ): EffectiveTeamTierModel[] | null {
    const header = this.db
      .prepare(
        `SELECT id FROM project_team_tiers WHERE project_id = ? AND team_type = ? AND tier = ?`
      )
      .get(projectId, teamType, tier);
    if (!header) return null;
    const rows = this.db
      .prepare(
        `SELECT ptm.model_id, ptm.position, m.slug, m.name, m.provider
         FROM project_team_tier_models ptm
         LEFT JOIN models m ON m.id = ptm.model_id
         WHERE ptm.project_id = ? AND ptm.team_type = ? AND ptm.tier = ?
         ORDER BY ptm.position, ptm.id`
      )
      .all(projectId, teamType, tier) as any[];
    return rows.map((r) => ({
      model_id: Number(r.model_id),
      position: Number(r.position || 0),
      slug: r.slug != null ? String(r.slug) : null,
      name: r.name != null ? String(r.name) : null,
      provider: r.provider != null ? String(r.provider) : null,
    }));
  }

  /** R5.20 Studio→Project: effective role tiers for a project. */
  resolveRoleTiers(projectId: number): EffectiveRoleTier[] {
    this.assertProject(projectId);
    const studio = this.roleTiers.listRoleTiers();
    const out: EffectiveRoleTier[] = [];
    for (const row of studio) {
      const ov = this.loadProjectRoleOverride(projectId, row.role, row.tier);
      if (ov) {
        out.push({
          role: row.role,
          tier: row.tier,
          primary_model_id: ov.primary_model_id,
          backup_model_id: ov.backup_model_id,
          primary_model_slug: ov.primary_model_slug,
          primary_model_name: ov.primary_model_name,
          backup_model_slug: ov.backup_model_slug,
          backup_model_name: ov.backup_model_name,
          source: 'project',
        });
      } else {
        out.push(studioRoleToEffective(row));
      }
    }
    // Project-only seats that studio lacks (rare; still surface for honesty)
    const projOnly = this.db
      .prepare(
        `SELECT prt.role, prt.tier, prt.primary_model_id, prt.backup_model_id,
                pm.slug AS primary_model_slug, pm.name AS primary_model_name,
                bm.slug AS backup_model_slug, bm.name AS backup_model_name
         FROM project_role_tiers prt
         LEFT JOIN models pm ON pm.id = prt.primary_model_id
         LEFT JOIN models bm ON bm.id = prt.backup_model_id
         WHERE prt.project_id = ?`
      )
      .all(projectId) as any[];
    for (const r of projOnly) {
      const role = r.role as RoleTierRole;
      const tier = r.tier as RoleTierLevel;
      if (out.some((e) => e.role === role && e.tier === tier)) continue;
      out.push({
        role,
        tier,
        primary_model_id: r.primary_model_id != null ? Number(r.primary_model_id) : null,
        backup_model_id: r.backup_model_id != null ? Number(r.backup_model_id) : null,
        primary_model_slug: r.primary_model_slug != null ? String(r.primary_model_slug) : null,
        primary_model_name: r.primary_model_name != null ? String(r.primary_model_name) : null,
        backup_model_slug: r.backup_model_slug != null ? String(r.backup_model_slug) : null,
        backup_model_name: r.backup_model_name != null ? String(r.backup_model_name) : null,
        source: 'project',
      });
    }
    return out;
  }

  /** R5.20 Studio→Project: effective team tiers for a project. */
  resolveTeamTiers(projectId: number): EffectiveTeamTier[] {
    this.assertProject(projectId);
    const studio = this.teamService.listTeamTiers();
    const out: EffectiveTeamTier[] = [];
    for (const row of studio) {
      const ov = this.loadProjectTeamModels(projectId, row.team_type, row.tier);
      if (ov) {
        out.push({
          team_type: row.team_type,
          tier: row.tier,
          models: ov,
          source: 'project',
        });
      } else {
        out.push(studioTeamToEffective(row));
      }
    }
    // Project-only team seats
    const headers = this.db
      .prepare(
        `SELECT team_type, tier FROM project_team_tiers WHERE project_id = ?`
      )
      .all(projectId) as any[];
    for (const h of headers) {
      const team_type = h.team_type as TeamTierType;
      const tier = h.tier as TeamTierLevel;
      if (out.some((e) => e.team_type === team_type && e.tier === tier)) continue;
      const models = this.loadProjectTeamModels(projectId, team_type, tier) || [];
      out.push({ team_type, tier, models, source: 'project' });
    }
    return out;
  }

  /** Project effective topology (role + team tiers). */
  resolveForProject(projectId: number): EffectiveTopology {
    return {
      project_id: projectId,
      role_tiers: this.resolveRoleTiers(projectId),
      team_tiers: this.resolveTeamTiers(projectId),
    };
  }

  /**
   * R5.21: cycle inherits the project's setup (live read; freeze is B19).
   */
  resolveForCycle(cycleId: number): EffectiveTopology {
    const row = this.db
      .prepare('SELECT id, project_id FROM cycles WHERE id = ?')
      .get(cycleId) as { id: number; project_id: number } | undefined;
    if (!row) throw new Error(`unknown cycle: ${cycleId}`);
    const topo = this.resolveForProject(Number(row.project_id));
    return { ...topo, cycle_id: Number(row.id) };
  }

  setProjectRoleTier(
    projectId: number,
    roleInput: string,
    tierInput: string,
    input: { primary_model_id?: number | null; backup_model_id?: number | null }
  ): EffectiveRoleTier {
    this.assertProject(projectId);
    const role = requireRole(roleInput);
    const tier = requireTier(tierInput);

    // Merge with existing project override or studio for partial updates.
    // Row presence decides base so an explicit project null is preserved
    // (?? would coalesce null → studio and resurrect the inherited value).
    const existing = this.loadProjectRoleOverride(projectId, role, tier);
    const studio = this.roleTiers.getRoleTier(role, tier);
    const basePrimary = existing
      ? existing.primary_model_id
      : (studio?.primary_model_id ?? null);
    const baseBackup = existing
      ? existing.backup_model_id
      : (studio?.backup_model_id ?? null);

    // !== undefined (not `in`): spreading { primary_model_id: undefined } must not clear.
    const primary_model_id =
      input.primary_model_id !== undefined
        ? parseOptionalModelId(input.primary_model_id, 'primary_model_id')
        : basePrimary;
    const backup_model_id =
      input.backup_model_id !== undefined
        ? parseOptionalModelId(input.backup_model_id, 'backup_model_id')
        : baseBackup;

    if (!modelIdExists(this.db, primary_model_id)) {
      throw new Error(`unknown model id for primary_model_id: ${primary_model_id}`);
    }
    if (!modelIdExists(this.db, backup_model_id)) {
      throw new Error(`unknown model id for backup_model_id: ${backup_model_id}`);
    }

    // B13 / R3.16 against project-effective peer topology (not Studio-only seats).
    const peerSeatForProject = (
      peerRole: 'implementer' | 'validator',
      peerTier: string
    ): { primary_model_id: number | null; backup_model_id: number | null } | null => {
      const ov = this.loadProjectRoleOverride(projectId, peerRole, peerTier as RoleTierLevel);
      if (ov) {
        return {
          primary_model_id: ov.primary_model_id,
          backup_model_id: ov.backup_model_id,
        };
      }
      const st = this.roleTiers.getRoleTier(peerRole, peerTier);
      if (!st) return null;
      return {
        primary_model_id: st.primary_model_id,
        backup_model_id: st.backup_model_id,
      };
    };
    assertRoleTierSaveInvariants(
      this.db,
      {
        role,
        tier,
        primary_model_id,
        backup_model_id,
      },
      { peerSeat: peerSeatForProject }
    );

    this.db
      .prepare(
        `INSERT INTO project_role_tiers (project_id, role, tier, primary_model_id, backup_model_id)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, role, tier) DO UPDATE SET
           primary_model_id = excluded.primary_model_id,
           backup_model_id = excluded.backup_model_id,
           updated_at = datetime('now')`
      )
      .run(projectId, role, tier, primary_model_id, backup_model_id);

    const resolved = this.resolveRoleTiers(projectId).find(
      (r) => r.role === role && r.tier === tier
    );
    if (!resolved) throw new Error('role tier not found after set');
    return resolved;
  }

  /**
   * B19 / B18-fix1 carry-forward: clearing an override reverts that seat to Studio's value,
   * which can collide with a peer that is still project-overridden (R3.16) even though neither
   * write was illegal in isolation. Delete + re-validate the composed effective topology in one
   * transaction so the delete rolls back on violation — a postcondition, not a per-site check.
   */
  clearProjectRoleTier(projectId: number, roleInput: string, tierInput: string): void {
    this.assertProject(projectId);
    const role = requireRole(roleInput);
    const tier = requireTier(tierInput);
    const apply = this.db.raw.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM project_role_tiers WHERE project_id = ? AND role = ? AND tier = ?`
        )
        .run(projectId, role, tier);
      assertEffectiveRoleTiersInvariants(this.db, this.resolveRoleTiers(projectId));
    });
    apply();
  }

  setProjectTeamTierModels(
    projectId: number,
    teamTypeInput: string,
    tierInput: string,
    modelIds: unknown
  ): EffectiveTeamTier {
    this.assertProject(projectId);
    const teamType = requireTeamType(teamTypeInput);
    const tier = requireTeamLevel(tierInput);
    const ids = parseModelIdList(modelIds);
    for (const mid of ids) {
      if (!modelIdExists(this.db, mid)) {
        throw new Error(`unknown model id: ${mid}`);
      }
    }

    const apply = this.db.raw.transaction(() => {
      const existing = this.db
        .prepare(
          `SELECT id FROM project_team_tiers WHERE project_id = ? AND team_type = ? AND tier = ?`
        )
        .get(projectId, teamType, tier);
      if (!existing) {
        this.db
          .prepare(
            `INSERT INTO project_team_tiers (project_id, team_type, tier) VALUES (?, ?, ?)`
          )
          .run(projectId, teamType, tier);
      } else {
        this.db
          .prepare(
            `UPDATE project_team_tiers SET updated_at = datetime('now')
             WHERE project_id = ? AND team_type = ? AND tier = ?`
          )
          .run(projectId, teamType, tier);
      }
      this.db
        .prepare(
          `DELETE FROM project_team_tier_models
           WHERE project_id = ? AND team_type = ? AND tier = ?`
        )
        .run(projectId, teamType, tier);
      const ins = this.db.prepare(
        `INSERT INTO project_team_tier_models (project_id, team_type, tier, model_id, position)
         VALUES (?, ?, ?, ?, ?)`
      );
      ids.forEach((mid, i) => {
        ins.run(projectId, teamType, tier, mid, i);
      });
    });
    apply();

    const resolved = this.resolveTeamTiers(projectId).find(
      (t) => t.team_type === teamType && t.tier === tier
    );
    if (!resolved) throw new Error('team tier not found after set');
    return resolved;
  }

  clearProjectTeamTier(
    projectId: number,
    teamTypeInput: string,
    tierInput: string
  ): void {
    this.assertProject(projectId);
    const teamType = requireTeamType(teamTypeInput);
    const tier = requireTeamLevel(tierInput);
    const apply = this.db.raw.transaction(() => {
      this.db
        .prepare(
          `DELETE FROM project_team_tier_models
           WHERE project_id = ? AND team_type = ? AND tier = ?`
        )
        .run(projectId, teamType, tier);
      this.db
        .prepare(
          `DELETE FROM project_team_tiers
           WHERE project_id = ? AND team_type = ? AND tier = ?`
        )
        .run(projectId, teamType, tier);
    });
    apply();
  }
}
