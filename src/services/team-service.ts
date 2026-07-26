import { DatabaseService } from '../db/database.js';

export interface Team {
  id: number;
  name: string;
  type: 'deliberation' | 'red-team' | 'generic';
  consensus_rule: string | null;
  protocol_note: string | null;
  created_at: string;
  updated_at: string;
}

export interface TeamMember {
  id: number;
  team_id: number;
  member_type: 'agent' | 'model';
  agent_id: number | null;
  model_id: number;
  lens: string | null;
  position: number;
  context_meta: string | null;
  model?: { id: number; name: string; provider: string };
}

/** B16 / R4.18–R4.19: studio team×tier kinds (not B1 flat team rows). */
export type TeamTierType = 'deliberation' | 'red-team';
export type TeamTierLevel = 'budget' | 'standard' | 'elite';

export const TEAM_TIER_TYPES: readonly TeamTierType[] = ['deliberation', 'red-team'] as const;
export const TEAM_TIER_LEVELS: readonly TeamTierLevel[] = ['budget', 'standard', 'elite'] as const;

export interface TeamTierModel {
  id: number;
  model_id: number;
  position: number;
  slug?: string | null;
  name?: string | null;
  provider?: string | null;
}

export interface TeamTier {
  id: number;
  team_type: TeamTierType;
  tier: TeamTierLevel;
  models: TeamTierModel[];
  created_at: string;
  updated_at: string;
}

const ALLOWED_TYPES = ['deliberation', 'red-team', 'generic'] as const;

function requireText(v: string | undefined, name: string): string {
  if (!v || typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}

function requireValidType(t: string): 'deliberation' | 'red-team' | 'generic' {
  if (!ALLOWED_TYPES.includes(t as any)) throw new Error(`invalid team type: ${t} (allowed: ${ALLOWED_TYPES.join(',')})`);
  return t as any;
}

function requireTeamTierType(t: string | undefined | null): TeamTierType {
  const v = String(t || '').trim();
  if (!(TEAM_TIER_TYPES as readonly string[]).includes(v)) {
    throw new Error(`invalid team_type: ${t} (allowed: ${TEAM_TIER_TYPES.join(', ')})`);
  }
  return v as TeamTierType;
}

function requireTeamTierLevel(t: string | undefined | null): TeamTierLevel {
  const v = String(t || '').trim();
  if (!(TEAM_TIER_LEVELS as readonly string[]).includes(v)) {
    throw new Error(`invalid tier: ${t} (allowed: ${TEAM_TIER_LEVELS.join(', ')})`);
  }
  return v as TeamTierLevel;
}

function modelIdExists(db: DatabaseService, id: number): boolean {
  return !!db.prepare('SELECT id FROM models WHERE id = ?').get(id);
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

const TIER_ORDER_SQL = `CASE tt.tier WHEN 'budget' THEN 1 WHEN 'standard' THEN 2 WHEN 'elite' THEN 3 ELSE 9 END`;

export class TeamService {
  constructor(private readonly db: DatabaseService) {}

  listTeams(): Team[] {
    return this.db.prepare('SELECT * FROM teams ORDER BY name').all() as Team[];
  }

  getTeam(id: number): Team | null {
    const row = this.db.prepare('SELECT * FROM teams WHERE id = ?').get(id) as any;
    return row ? (row as Team) : null;
  }

  createTeam(input: { name: string; type: string; consensus_rule?: string | null; protocol_note?: string | null }): Team {
    const name = requireText(input.name, 'name');
    const type = requireValidType(input.type);
    const consensus_rule = input.consensus_rule ?? null;
    const protocol_note = input.protocol_note ?? null;
    try {
      const row = this.db.prepare(
        `INSERT INTO teams (name, type, consensus_rule, protocol_note) VALUES (?,?,?,?) RETURNING *`
      ).get(name, type, consensus_rule, protocol_note) as any;
      return row as Team;
    } catch (e: any) {
      if (String(e.message || e).includes('UNIQUE') || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error(`team name must be unique: ${name}`);
      }
      throw e;
    }
  }

  updateTeam(id: number, input: { name?: string; type?: string; consensus_rule?: string | null; protocol_note?: string | null }): Team {
    const existing = this.getTeam(id);
    if (!existing) throw new Error('unknown team');
    const sets: string[] = [];
    const vals: any[] = [];
    if (input.name !== undefined) {
      const name = requireText(input.name, 'name');
      const dup = this.db.prepare('SELECT id FROM teams WHERE name = ? AND id != ?').get(name, id);
      if (dup) throw new Error(`team name must be unique: ${name}`);
      sets.push('name=?');
      vals.push(name);
    }
    if (input.type !== undefined) {
      const type = requireValidType(input.type);
      sets.push('type=?');
      vals.push(type);
    }
    if ('consensus_rule' in input) {
      sets.push('consensus_rule=?');
      vals.push(input.consensus_rule ?? null);
    }
    if ('protocol_note' in input) {
      sets.push('protocol_note=?');
      vals.push(input.protocol_note ?? null);
    }
    if (sets.length === 0) return existing;
    sets.push("updated_at=datetime('now')");
    this.db.prepare(`UPDATE teams SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    const updated = this.getTeam(id);
    if (!updated) throw new Error('team not found after update');
    return updated;
  }

  deleteTeam(id: number): void {
    const exists = this.getTeam(id);
    if (!exists) throw new Error('unknown team');
    // members cascade on FK, but check if bound to roles?
    const bound = this.db.prepare('SELECT role, project_id FROM role_team_bindings WHERE team_id = ?').all(id) as any[];
    if (bound.length > 0) {
      const refs = bound.map((b: any) => `${b.role}@p${b.project_id}`).join(', ');
      throw new Error(`team is bound (cannot delete): ${refs}`);
    }
    this.db.prepare('DELETE FROM teams WHERE id = ?').run(id);
  }

  listMembers(teamId: number): TeamMember[] {
    const rows = this.db.prepare(`
      SELECT tm.*, m.id as m_id, m.name as m_name, m.provider as m_provider
      FROM team_members tm
      LEFT JOIN models m ON m.id = tm.model_id
      WHERE tm.team_id = ?
      ORDER BY tm.position, tm.id
    `).all(teamId) as any[];
    return rows.map((r: any) => ({
      id: Number(r.id),
      team_id: Number(r.team_id),
      member_type: (r.member_type ?? 'model') as 'agent' | 'model',
      agent_id: r.agent_id != null ? Number(r.agent_id) : null,
      model_id: Number(r.model_id),
      lens: r.lens ?? null,
      position: Number(r.position || 0),
      context_meta: r.context_meta ?? null,
      model: r.m_id ? { id: Number(r.m_id), name: String(r.m_name), provider: String(r.m_provider) } : undefined
    }));
  }

  addMember(teamId: number, input: {
    member_type?: 'agent' | 'model';
    agent_id?: number | null;
    model_id?: number;
    lens?: string | null;
    position?: number;
  }): TeamMember {
    const team = this.getTeam(teamId);
    if (!team) throw new Error('unknown team');
    const memberType = (input.member_type ?? 'model') as 'agent' | 'model';
    let modelId: number;
    let agentId: number | null = null;
    if (memberType === 'agent') {
      if (input.agent_id == null) throw new Error('agent_id required for agent member');
      const agent = this.db.prepare('SELECT id, in_development, default_model_id FROM agents WHERE id = ?').get(input.agent_id) as any;
      if (!agent) throw new Error('unknown agent');
      if (agent.in_development) throw new Error('agent is still in development — mark as ready before adding to a team');
      if (input.model_id != null) {
        modelId = Number(input.model_id);
        if (!this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(modelId)) throw new Error('unknown model');
      } else {
        if (agent.default_model_id == null) throw new Error('agent has no default_model_id; provide model_id explicitly');
        modelId = Number(agent.default_model_id);
      }
      agentId = Number(input.agent_id);
      const agentModelRow = this.db.prepare('SELECT validation_status FROM models WHERE id = ?').get(modelId) as any;
      if (!agentModelRow || agentModelRow.validation_status !== 'valid') throw new Error('agent model is not validated — run validation first');
    } else {
      if (input.model_id == null) throw new Error('model_id required for model member');
      modelId = Number(input.model_id);
      const modelRow = this.db.prepare('SELECT validation_status FROM models WHERE id = ?').get(modelId) as any;
      if (!modelRow) throw new Error('unknown model');
      if (modelRow.validation_status !== 'valid') throw new Error('model is not validated — run validation first');
    }
    const lens = input.lens ?? null;
    let position: number;
    if (input.position != null) {
      position = Number(input.position);
    } else {
      const maxRow = this.db.prepare('SELECT MAX(position) as mp FROM team_members WHERE team_id = ?').get(teamId) as any;
      position = (maxRow?.mp ?? -1) + 1;
    }
    try {
      const row = this.db.prepare(
        `INSERT INTO team_members (team_id, member_type, agent_id, model_id, lens, position) VALUES (?,?,?,?,?,?) RETURNING *`
      ).get(teamId, memberType, agentId, modelId, lens, position) as any;
      return {
        id: Number(row.id),
        team_id: Number(row.team_id),
        member_type: row.member_type as 'agent' | 'model',
        agent_id: row.agent_id != null ? Number(row.agent_id) : null,
        model_id: Number(row.model_id),
        lens: row.lens ?? null,
        position: Number(row.position || 0),
        context_meta: row.context_meta ?? null
      };
    } catch (e: any) {
      if (String(e.message || e).includes('UNIQUE')) {
        throw new Error('position already taken in team');
      }
      throw e;
    }
  }

  removeMember(teamId: number, memberId: number): void {
    this.db.prepare('DELETE FROM team_members WHERE team_id = ? AND id = ?').run(teamId, memberId);
  }

  // ── B16 / R4.18–R4.19: studio team×tier model lists ──────────────────────

  private loadTeamTierModels(teamType: TeamTierType, tier: TeamTierLevel): TeamTierModel[] {
    const rows = this.db
      .prepare(
        `SELECT ttm.id, ttm.model_id, ttm.position, m.slug, m.name, m.provider
         FROM team_tier_models ttm
         LEFT JOIN models m ON m.id = ttm.model_id
         WHERE ttm.team_type = ? AND ttm.tier = ?
         ORDER BY ttm.position, ttm.id`
      )
      .all(teamType, tier) as any[];
    return rows.map((r) => ({
      id: Number(r.id),
      model_id: Number(r.model_id),
      position: Number(r.position || 0),
      slug: r.slug != null ? String(r.slug) : null,
      name: r.name != null ? String(r.name) : null,
      provider: r.provider != null ? String(r.provider) : null,
    }));
  }

  private rowToTeamTier(row: any): TeamTier {
    const team_type = row.team_type as TeamTierType;
    const tier = row.tier as TeamTierLevel;
    return {
      id: Number(row.id),
      team_type,
      tier,
      models: this.loadTeamTierModels(team_type, tier),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  listTeamTiers(teamType?: string | null): TeamTier[] {
    if (teamType != null && String(teamType).trim()) {
      const tt = requireTeamTierType(teamType);
      const rows = this.db
        .prepare(
          `SELECT * FROM team_tiers tt
           WHERE tt.team_type = ?
           ORDER BY ${TIER_ORDER_SQL}`
        )
        .all(tt) as any[];
      return rows.map((r) => this.rowToTeamTier(r));
    }
    const rows = this.db
      .prepare(
        `SELECT * FROM team_tiers tt
         ORDER BY tt.team_type, ${TIER_ORDER_SQL}`
      )
      .all() as any[];
    return rows.map((r) => this.rowToTeamTier(r));
  }

  getTeamTier(teamType: string, tier: string): TeamTier | null {
    const tt = requireTeamTierType(teamType);
    const t = requireTeamTierLevel(tier);
    const row = this.db
      .prepare('SELECT * FROM team_tiers WHERE team_type = ? AND tier = ?')
      .get(tt, t) as any;
    return row ? this.rowToTeamTier(row) : null;
  }

  /**
   * Upsert (team_type, tier) header and replace its ordered model roster.
   * Empty model_ids[] is allowed (tier exists with empty roster).
   */
  setTeamTierModels(
    teamType: string,
    tier: string,
    modelIds: unknown
  ): TeamTier {
    const tt = requireTeamTierType(teamType);
    const t = requireTeamTierLevel(tier);
    const ids = parseModelIdList(modelIds);
    for (const mid of ids) {
      if (!modelIdExists(this.db, mid)) {
        throw new Error(`unknown model id: ${mid}`);
      }
    }

    const existing = this.db
      .prepare('SELECT id FROM team_tiers WHERE team_type = ? AND tier = ?')
      .get(tt, t) as any;

    const apply = this.db.raw.transaction(() => {
      if (!existing) {
        this.db
          .prepare('INSERT INTO team_tiers (team_type, tier) VALUES (?, ?)')
          .run(tt, t);
      } else {
        this.db
          .prepare(
            `UPDATE team_tiers SET updated_at = datetime('now') WHERE team_type = ? AND tier = ?`
          )
          .run(tt, t);
      }
      this.db
        .prepare('DELETE FROM team_tier_models WHERE team_type = ? AND tier = ?')
        .run(tt, t);
      const ins = this.db.prepare(
        `INSERT INTO team_tier_models (team_type, tier, model_id, position) VALUES (?, ?, ?, ?)`
      );
      ids.forEach((mid, i) => {
        ins.run(tt, t, mid, i);
      });
    });
    apply();

    const row = this.getTeamTier(tt, t);
    if (!row) throw new Error('team tier not found after set');
    return row;
  }

  /** Remove tier header + models (full clear). */
  clearTeamTier(teamType: string, tier: string): void {
    const tt = requireTeamTierType(teamType);
    const t = requireTeamTierLevel(tier);
    const existing = this.getTeamTier(tt, t);
    if (!existing) throw new Error(`unknown team tier: ${tt}/${t}`);
    const apply = this.db.raw.transaction(() => {
      this.db
        .prepare('DELETE FROM team_tier_models WHERE team_type = ? AND tier = ?')
        .run(tt, t);
      this.db
        .prepare('DELETE FROM team_tiers WHERE team_type = ? AND tier = ?')
        .run(tt, t);
    });
    apply();
  }
}
