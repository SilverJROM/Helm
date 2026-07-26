import { DatabaseService } from '../db/database.js';
import {
  AgentAssignmentService,
  LeanEffectiveProjectAgent,
  assertRegistryEditable,
  type AgentProvider,
  type ResolvedModelSource,
  type ResolvedModelType,
} from './agent-assignment-service.js';
import { loadConfig } from '../config/config.js';

export interface AgentStub {
  id: number;
  name: string;
  provider: string;
  /** agents.model TEXT launch field (used when default_model_id is null). */
  model?: string | null;
  default_model_id: number | null;
  /** AC-1/AC-2: solo|tiered|team for list chip; defaults solo when missing. */
  classification: 'solo' | 'tiered' | 'team';
}

export interface ResolvedModel {
  type: ResolvedModelType;
  /** AC-13: dynamic | override | inherited | unknown */
  source: ResolvedModelSource;
  id: number | null;
  name: string | null;
  /** Launch slug when known (models.model_id or agents.model TEXT). */
  model_id?: string | null;
}

export interface ProjectAgentRow {
  id: number;
  project_id: number;
  agent_id: number;
  model_id: number | null;
  use_dynamic: number;
  backup_model_id: number | null;
  effort_override: string | null;
  spawn_pref_override: string | null;
  disabled_override: number | null;
  has_persona_override: boolean;
  toolkits_overridden: number;
  escalations_overridden: number;
  is_primary_driver: number;
  agent: AgentStub;
  resolved: ResolvedModel;
  effective: LeanEffectiveProjectAgent;
}

export interface ProjectAgentOverridePayload {
  is_primary_driver?: boolean | number;
  model_id?: number | null;
  use_dynamic?: boolean | number;
  backup_model_id?: number | null;
  effort_override?: string | null;
  spawn_pref_override?: string | null;
  disabled_override?: boolean | number | string | null;
  definition_md_override?: string | null;
  toolkits?: { overridden: boolean; toolkits?: Array<{ toolkit_id: number; position?: number }> };
  escalations?: { overridden: boolean; escalations?: Array<{ position: number; model_id: number; trigger?: string; effort?: string | null }> };
}

export interface ProjectAgentScalarOverrides {
  backup_model_id?: number | null;
  effort_override?: string | null;
  spawn_pref_override?: string | null;
  disabled_override?: boolean | number | string | null;
  definition_md_override?: string | null;
}

export interface ProjectAgentToolkitOverrideRow {
  id: number;
  toolkit_id: number;
  position: number;
  name: string;
  description: string | null;
  body_md: string;
}

export interface ProjectAgentEscalationOverrideRow {
  id: number;
  position: number;
  model_id: number;
  trigger: string;
  model_name: string;
  provider: string;
  /** B5/AC-10: per-rung effort; null = inherit L1/agent default. */
  effort: string | null;
}

function normalizeStubClassification(value: unknown): 'solo' | 'tiered' | 'team' {
  const v = String(value ?? 'solo').toLowerCase().trim();
  if (v === 'tiered' || v === 'team' || v === 'solo') return v;
  return 'solo';
}

function rowToAgentStub(r: any): AgentStub {
  const rawModel = r.a_model ?? r.agent_model;
  return {
    id: Number(r.a_id ?? r.agent_id),
    name: String(r.a_name ?? r.agent_name),
    provider: String(r.a_provider ?? r.agent_provider),
    model: rawModel == null || String(rawModel).trim() === '' ? null : String(rawModel),
    default_model_id: r.a_def_mid == null ? null : Number(r.a_def_mid),
    classification: normalizeStubClassification(r.a_classification),
  };
}

function buildLeanEffectiveFromListRow(r: any): LeanEffectiveProjectAgent {
  const projectId = Number(r.project_id);
  const agentId = Number(r.agent_id);
  const studioInDevelopment = Number(r.a_in_development) === 1;
  const disabledOverride = r.disabled_override == null ? null : Number(r.disabled_override);
  const toolkitsOverridden = Number(r.toolkits_overridden) === 1;
  const escalationsOverridden = Number(r.escalations_overridden) === 1;
  const agentBackupModelId = r.a_backup_model_id == null ? null : Number(r.a_backup_model_id);
  const paBackupModelId = r.backup_model_id == null ? null : Number(r.backup_model_id);
  const agentModelText =
    r.a_model != null && String(r.a_model).trim() !== '' ? String(r.a_model) : null;
  const agentProvider =
    r.a_provider == null || String(r.a_provider).trim() === ''
      ? null
      : (String(r.a_provider) as AgentProvider);

  let model: LeanEffectiveProjectAgent['model'];
  // AC-13 chain: dynamic → project override → Studio default_model_id → agents.model TEXT → unknown
  if (Number(r.use_dynamic) === 1) {
    model = {
      type: 'dynamic',
      source: 'dynamic',
      id: null,
      model_id: null,
      name: 'dynamic (coordinator picks from global pool)',
      provider: null
    };
  } else if (r.model_id != null && r.om_model_ref) {
    model = {
      type: 'override',
      source: 'override',
      id: Number(r.om_id),
      model_id: String(r.om_model_ref),
      name: r.om_name == null ? null : String(r.om_name),
      provider: r.om_provider == null ? null : String(r.om_provider) as AgentProvider
    };
  } else if (r.a_def_mid != null && r.dm_model_ref) {
    model = {
      type: 'default',
      source: 'inherited',
      id: Number(r.dm_id),
      model_id: String(r.dm_model_ref),
      name: r.dm_name == null ? null : String(r.dm_name),
      provider: r.dm_provider == null ? null : String(r.dm_provider) as AgentProvider
    };
  } else if (agentModelText) {
    model = {
      type: 'inherited',
      source: 'inherited',
      id: null,
      model_id: agentModelText,
      name: agentModelText,
      provider: agentProvider
    };
  } else {
    model = { type: 'unknown', source: 'unknown', id: null, model_id: null, name: null, provider: null };
  }

  return {
    project_id: projectId,
    agent_id: agentId,
    model,
    backup_model_id: paBackupModelId ?? agentBackupModelId,
    effort: r.effort_override ?? r.a_default_effort ?? null,
    spawn_pref: r.spawn_pref_override || r.a_spawn_pref || 'tmux',
    in_development: studioInDevelopment || disabledOverride === 1,
    overrides: {
      backup_model_id: paBackupModelId,
      effort_override: r.effort_override == null ? null : String(r.effort_override),
      spawn_pref_override: r.spawn_pref_override == null ? null : String(r.spawn_pref_override),
      disabled_override: disabledOverride,
      toolkits_overridden: toolkitsOverridden,
      escalations_overridden: escalationsOverridden
    }
  };
}

export class ProjectAgentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly assignmentService: AgentAssignmentService
  ) {}

  listProjectAgents(projectId: number): ProjectAgentRow[] {
    const rows = this.db.prepare(`
      SELECT
        pa.id, pa.project_id, pa.agent_id, pa.model_id, pa.use_dynamic, pa.is_primary_driver,
        pa.backup_model_id, pa.effort_override, pa.spawn_pref_override, pa.disabled_override,
        CASE WHEN pa.definition_md_override IS NOT NULL AND trim(pa.definition_md_override) != '' THEN 1 ELSE 0 END AS has_persona_override,
        pa.toolkits_overridden, pa.escalations_overridden,
        a.id as a_id, a.name as a_name, a.provider as a_provider, a.model as a_model, a.default_model_id as a_def_mid,
        a.default_effort as a_default_effort, a.spawn_pref as a_spawn_pref, a.in_development as a_in_development,
        a.backup_model_id as a_backup_model_id, a.classification as a_classification,
        om.id as om_id, om.name as om_name, om.model_id as om_model_ref, om.provider as om_provider,
        dm.id as dm_id, dm.name as dm_name, dm.model_id as dm_model_ref, dm.provider as dm_provider
      FROM project_agents pa
      JOIN agents a ON a.id = pa.agent_id
      LEFT JOIN models om ON om.id = pa.model_id
      LEFT JOIN models dm ON dm.id = a.default_model_id
      WHERE pa.project_id = ?
      ORDER BY a.name COLLATE NOCASE
    `).all(projectId) as any[];

    return rows.map((r: any) => {
      let resolved: ResolvedModel;
      const agentModelText =
        r.a_model != null && String(r.a_model).trim() !== '' ? String(r.a_model) : null;
      // AC-13 chain: dynamic → override → Studio default_model_id → agents.model TEXT → unknown
      if (Number(r.use_dynamic) === 1) {
        // dynamic = coordinator picks from the GLOBAL model pool at runtime (per brief + C2 contract)
        resolved = {
          type: 'dynamic',
          source: 'dynamic',
          id: null,
          name: 'dynamic (coordinator picks from global pool)',
          model_id: null
        };
      } else if (r.model_id != null && r.om_name) {
        resolved = {
          type: 'override',
          source: 'override',
          id: Number(r.om_id),
          name: String(r.om_name),
          model_id: r.om_model_ref == null ? null : String(r.om_model_ref)
        };
      } else if (r.dm_name) {
        resolved = {
          type: 'default',
          source: 'inherited',
          id: Number(r.dm_id),
          name: String(r.dm_name),
          model_id: r.dm_model_ref == null ? null : String(r.dm_model_ref)
        };
      } else if (agentModelText) {
        resolved = {
          type: 'inherited',
          source: 'inherited',
          id: null,
          name: agentModelText,
          model_id: agentModelText
        };
      } else {
        resolved = { type: 'unknown', source: 'unknown', id: null, name: null, model_id: null };
      }
      return {
        id: Number(r.id),
        project_id: Number(r.project_id),
        agent_id: Number(r.agent_id),
        model_id: r.model_id == null ? null : Number(r.model_id),
        use_dynamic: Number(r.use_dynamic),
        backup_model_id: r.backup_model_id == null ? null : Number(r.backup_model_id),
        effort_override: r.effort_override == null ? null : String(r.effort_override),
        spawn_pref_override: r.spawn_pref_override == null ? null : String(r.spawn_pref_override),
        disabled_override: r.disabled_override == null ? null : Number(r.disabled_override),
        has_persona_override: Number(r.has_persona_override) === 1,
        toolkits_overridden: Number(r.toolkits_overridden),
        escalations_overridden: Number(r.escalations_overridden),
        is_primary_driver: Number(r.is_primary_driver),
        agent: rowToAgentStub(r),
        resolved,
        effective: buildLeanEffectiveFromListRow(r)
      };
    });
  }

  applyAgentOverrides(projectId: number, agentId: number, body: ProjectAgentOverridePayload): void {
    const hasPrimary = body.is_primary_driver === 1 || body.is_primary_driver === true;
    const hasModel = body.model_id !== undefined || body.use_dynamic !== undefined;
    const hasScalar =
      body.backup_model_id !== undefined ||
      body.effort_override !== undefined ||
      body.spawn_pref_override !== undefined ||
      body.disabled_override !== undefined ||
      body.definition_md_override !== undefined;
    if (body.toolkits !== undefined) {
      if (body.toolkits == null || typeof body.toolkits !== 'object' || typeof body.toolkits.overridden !== 'boolean') {
        throw new Error('invalid toolkits payload');
      }
    }
    if (body.escalations !== undefined) {
      if (body.escalations == null || typeof body.escalations !== 'object' || typeof body.escalations.overridden !== 'boolean') {
        throw new Error('invalid escalations payload');
      }
    }
    const hasToolkits = body.toolkits !== undefined;
    const hasEscalations = body.escalations !== undefined;
    if (!hasPrimary && !hasModel && !hasScalar && !hasToolkits && !hasEscalations) {
      throw new Error('no overrides provided');
    }

    this.runTransaction(() => {
      this.requireProjectAgentMutable(projectId, agentId);
      if (hasPrimary) this.setPrimaryDriver(projectId, agentId);
      if (hasModel) this.setModelOverride(projectId, agentId, body);
      if (hasScalar) this.setScalarOverrides(projectId, agentId, body);
      if (hasToolkits) {
        this.setProjectAgentToolkits(projectId, agentId, {
          overridden: body.toolkits!.overridden,
          toolkits: body.toolkits!.toolkits || []
        });
      }
      if (hasEscalations) {
        this.setProjectAgentEscalations(projectId, agentId, {
          overridden: body.escalations!.overridden,
          escalations: body.escalations!.escalations || []
        });
      }
    });
  }

  addAgent(projectId: number, agentId: number): void {
    // validate existence (404-mappable upstream)
    const agent = this.db.prepare('SELECT id, in_development, agent_type FROM agents WHERE id = ?').get(agentId) as
      | { id: number; in_development: number; agent_type: string }
      | undefined;
    if (!agent) throw new Error('unknown agent');
    // D5 (R-02E): in_development agents are not project-ready — block assignment
    if (agent.in_development === 1) throw new Error('agent is in development and cannot be assigned to a project');
    // B07b / R2.7: house-kind agents never enter a project roster / project run.
    const kind = String(agent.agent_type ?? 'project').toLowerCase();
    if (kind === 'house' || kind === 'helm') {
      throw new Error(`house-kind agent cannot be dispatched into a project run (id=${agentId})`);
    }
    const proj = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!proj) throw new Error('unknown project');
    try {
      this.db.prepare(`
        INSERT INTO project_agents (project_id, agent_id, model_id, use_dynamic, is_primary_driver)
        VALUES (?, ?, NULL, 0, 0)
      `).run(projectId, agentId);
    } catch (e: any) {
      if (String(e.message || e).includes('UNIQUE') || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error('agent already added to this project');
      }
      throw e;
    }
  }

  removeAgent(projectId: number, agentId: number): void {
    this.db.prepare('DELETE FROM project_agents WHERE project_id = ? AND agent_id = ?').run(projectId, agentId);
  }

  getProjectAgent(projectId: number, agentId: number): { id: number } | null {
    const row = this.db.prepare('SELECT id FROM project_agents WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as any;
    return row ? { id: Number(row.id) } : null;
  }

  setModelOverride(
    projectId: number,
    agentId: number,
    spec: { model_id?: number | null; use_dynamic?: boolean | number } | 'dynamic' | 'default'
  ): void {
    this.requireProjectAgentMutable(projectId, agentId);
    let modelId: number | null = null;
    let useDyn = 0;
    if (spec === 'dynamic' || (typeof spec === 'object' && (spec.use_dynamic === true || spec.use_dynamic === 1))) {
      useDyn = 1;
      modelId = null;
    } else if (spec === 'default' || (typeof spec === 'object' && spec.model_id === null)) {
      modelId = null;
      useDyn = 0;
    } else if (typeof spec === 'object' && typeof spec.model_id === 'number') {
      const m = this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(spec.model_id);
      if (!m) throw new Error('unknown model');
      modelId = spec.model_id;
      useDyn = 0;
    } else {
      throw new Error('invalid model override spec (use "dynamic" | "default" | {model_id:number|null} | {use_dynamic:true})');
    }
    this.db.prepare(`
      UPDATE project_agents
      SET model_id = ?, use_dynamic = ?, updated_at = datetime('now')
      WHERE project_id = ? AND agent_id = ?
    `).run(modelId, useDyn, projectId, agentId);
  }

  setScalarOverrides(projectId: number, agentId: number, input: ProjectAgentScalarOverrides): void {
    const row = this.db.prepare(`
      SELECT pa.id, a.in_development, a.name as a_name, a.agent_type as a_agent_type
      FROM project_agents pa
      JOIN agents a ON a.id = pa.agent_id
      WHERE pa.project_id = ? AND pa.agent_id = ?
    `).get(projectId, agentId) as {
      id: number;
      in_development: number;
      a_name: string;
      a_agent_type: string;
    } | undefined;
    if (!row) throw new Error('project agent not found');
    // B07c: project surface cannot mutate house/registry agents (even via overrides)
    assertRegistryEditable(
      { id: agentId, name: String(row.a_name), agent_type: row.a_agent_type },
      'project'
    );

    const sets: string[] = [];
    const vals: any[] = [];
    if (Object.prototype.hasOwnProperty.call(input, 'backup_model_id')) {
      const modelId = normalizeNullableNumber(input.backup_model_id, 'backup_model_id');
      if (modelId != null) {
        const model = this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(modelId);
        if (!model) throw new Error('unknown model');
      }
      sets.push('backup_model_id = ?');
      vals.push(modelId);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'effort_override')) {
      sets.push('effort_override = ?');
      vals.push(normalizeNullableEffort(input.effort_override));
    }
    if (Object.prototype.hasOwnProperty.call(input, 'spawn_pref_override')) {
      sets.push('spawn_pref_override = ?');
      vals.push(normalizeNullableSpawn(input.spawn_pref_override));
    }
    if (Object.prototype.hasOwnProperty.call(input, 'disabled_override')) {
      const disabled = normalizeNullableDisabled(input.disabled_override);
      if (Number(row.in_development) === 1 && disabled === 0) {
        throw new Error('cannot set disabled_override=0 for an agent that is in development in Studio');
      }
      sets.push('disabled_override = ?');
      vals.push(disabled);
    }
    if (Object.prototype.hasOwnProperty.call(input, 'definition_md_override')) {
      sets.push('definition_md_override = ?');
      vals.push(normalizeNullableDefinitionMd(input.definition_md_override, (loadConfig() as any).AGENT_DEFINITION_MAX || 50000));
    }
    if (sets.length === 0) throw new Error('no scalar overrides provided');
    sets.push("updated_at = datetime('now')");
    this.db.prepare(`
      UPDATE project_agents
      SET ${sets.join(', ')}
      WHERE project_id = ? AND agent_id = ?
    `).run(...vals, projectId, agentId);
  }

  listProjectAgentToolkits(projectId: number, agentId: number): { overridden: boolean; toolkits: ProjectAgentToolkitOverrideRow[] } {
    this.requireProjectAgent(projectId, agentId);
    const flags = this.getCollectionFlags(projectId, agentId);
    const rows = this.db.prepare(`
      SELECT pat.id, pat.toolkit_id, pat.position, t.name, t.description, t.body_md
      FROM project_agent_toolkits pat
      JOIN toolkits t ON t.id = pat.toolkit_id
      WHERE pat.project_id = ? AND pat.agent_id = ?
      ORDER BY pat.position ASC, t.name ASC
    `).all(projectId, agentId) as any[];
    return {
      overridden: flags.toolkits_overridden === 1,
      toolkits: rows.map((r: any) => ({
        id: Number(r.id),
        toolkit_id: Number(r.toolkit_id),
        position: Number(r.position),
        name: String(r.name),
        description: r.description ?? null,
        body_md: String(r.body_md)
      }))
    };
  }

  setProjectAgentToolkits(projectId: number, agentId: number, input: { overridden: boolean; toolkits?: Array<{ toolkit_id: number; position?: number }> }): { overridden: boolean; toolkits: ProjectAgentToolkitOverrideRow[] } {
    this.requireProjectAgentMutable(projectId, agentId);
    return this.runTransaction(() => {
      if (!input.overridden) {
        this.db.prepare('DELETE FROM project_agent_toolkits WHERE project_id = ? AND agent_id = ?').run(projectId, agentId);
        this.db.prepare("UPDATE project_agents SET toolkits_overridden = 0, updated_at = datetime('now') WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
        return this.listProjectAgentToolkits(projectId, agentId);
      }
      const rows = (input.toolkits || []).map((r, i) => ({
        toolkit_id: normalizeNullableNumber(r.toolkit_id, 'toolkit_id')!,
        position: r.position == null ? i : requireInteger(r.position, 'position')
      }));
      this.db.prepare('DELETE FROM project_agent_toolkits WHERE project_id = ? AND agent_id = ?').run(projectId, agentId);
      const stmt = this.db.prepare(`
        INSERT INTO project_agent_toolkits (project_id, agent_id, toolkit_id, position)
        VALUES (?, ?, ?, ?)
      `);
      for (const r of rows) {
        this.requireToolkit(r.toolkit_id);
        stmt.run(projectId, agentId, r.toolkit_id, r.position);
      }
      this.db.prepare("UPDATE project_agents SET toolkits_overridden = 1, updated_at = datetime('now') WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
      return this.listProjectAgentToolkits(projectId, agentId);
    });
  }

  attachProjectAgentToolkit(projectId: number, agentId: number, toolkitId: number, position?: number): { overridden: boolean; toolkits: ProjectAgentToolkitOverrideRow[] } {
    this.requireProjectAgentMutable(projectId, agentId);
    this.requireToolkit(toolkitId);
    return this.runTransaction(() => {
      this.seedInheritedToolkitsIfNeeded(projectId, agentId);
      let pos = position == null ? null : requireInteger(position, 'position');
      if (pos == null) {
        const maxr = this.db.prepare('SELECT MAX(position) as m FROM project_agent_toolkits WHERE project_id = ? AND agent_id = ?').get(projectId, agentId) as any;
        pos = (maxr && typeof maxr.m === 'number' ? maxr.m : -1) + 1;
      }
      this.db.prepare(`
        INSERT INTO project_agent_toolkits (project_id, agent_id, toolkit_id, position)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(project_id, agent_id, toolkit_id) DO UPDATE SET position = excluded.position
      `).run(projectId, agentId, toolkitId, pos);
      this.db.prepare("UPDATE project_agents SET toolkits_overridden = 1, updated_at = datetime('now') WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
      return this.listProjectAgentToolkits(projectId, agentId);
    });
  }

  detachProjectAgentToolkit(projectId: number, agentId: number, toolkitId: number): { overridden: boolean; toolkits: ProjectAgentToolkitOverrideRow[] } {
    this.requireProjectAgentMutable(projectId, agentId);
    return this.runTransaction(() => {
      this.db.prepare('DELETE FROM project_agent_toolkits WHERE project_id = ? AND agent_id = ? AND toolkit_id = ?').run(projectId, agentId, toolkitId);
      this.db.prepare("UPDATE project_agents SET toolkits_overridden = 1, updated_at = datetime('now') WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
      return this.listProjectAgentToolkits(projectId, agentId);
    });
  }

  listProjectAgentEscalations(projectId: number, agentId: number): { overridden: boolean; escalations: ProjectAgentEscalationOverrideRow[] } {
    this.requireProjectAgent(projectId, agentId);
    const flags = this.getCollectionFlags(projectId, agentId);
    const rows = this.db.prepare(`
      SELECT pae.id, pae.position, pae.model_id, pae.trigger, pae.effort, m.name as model_name, m.provider
      FROM project_agent_escalations pae
      JOIN models m ON m.id = pae.model_id
      WHERE pae.project_id = ? AND pae.agent_id = ?
      ORDER BY pae.position ASC
    `).all(projectId, agentId) as any[];
    return {
      overridden: flags.escalations_overridden === 1,
      escalations: rows.map((r: any) => ({
        id: Number(r.id),
        position: Number(r.position),
        model_id: Number(r.model_id),
        trigger: String(r.trigger),
        model_name: String(r.model_name),
        provider: String(r.provider),
        effort: r.effort == null || String(r.effort).trim() === '' ? null : String(r.effort),
      }))
    };
  }

  setProjectAgentEscalations(projectId: number, agentId: number, input: { overridden: boolean; escalations?: Array<{ position: number; model_id: number; trigger?: string; effort?: string | null }> }): { overridden: boolean; escalations: ProjectAgentEscalationOverrideRow[] } {
    this.requireProjectAgentMutable(projectId, agentId);
    return this.runTransaction(() => {
      if (!input.overridden) {
        this.db.prepare('DELETE FROM project_agent_escalations WHERE project_id = ? AND agent_id = ?').run(projectId, agentId);
        this.db.prepare("UPDATE project_agents SET escalations_overridden = 0, updated_at = datetime('now') WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
        return this.listProjectAgentEscalations(projectId, agentId);
      }
      const rows = (input.escalations || []).map((r) => ({
        position: requireEscalationPosition(r.position),
        model_id: normalizeNullableNumber(r.model_id, 'model_id')!,
        trigger: requireEscalationTrigger(r.trigger),
        effort: Object.prototype.hasOwnProperty.call(r, 'effort')
          ? normalizeNullableEscalationEffort(r.effort)
          : null,
      }));
      this.db.prepare('DELETE FROM project_agent_escalations WHERE project_id = ? AND agent_id = ?').run(projectId, agentId);
      const stmt = this.db.prepare(`
        INSERT INTO project_agent_escalations (project_id, agent_id, position, model_id, trigger, effort)
        VALUES (?, ?, ?, ?, ?, ?)
      `);
      for (const r of rows) {
        this.requireModel(r.model_id);
        stmt.run(projectId, agentId, r.position, r.model_id, r.trigger, r.effort);
      }
      this.db.prepare("UPDATE project_agents SET escalations_overridden = 1, updated_at = datetime('now') WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
      return this.listProjectAgentEscalations(projectId, agentId);
    });
  }

  upsertProjectAgentEscalation(projectId: number, agentId: number, input: { position: number; model_id: number; trigger?: string; effort?: string | null }): { overridden: boolean; escalations: ProjectAgentEscalationOverrideRow[] } {
    this.requireProjectAgentMutable(projectId, agentId);
    const position = requireEscalationPosition(input.position);
    const modelId = normalizeNullableNumber(input.model_id, 'model_id')!;
    const trigger = requireEscalationTrigger(input.trigger);
    const effort = Object.prototype.hasOwnProperty.call(input, 'effort')
      ? normalizeNullableEscalationEffort(input.effort)
      : null;
    this.requireModel(modelId);
    return this.runTransaction(() => {
      this.seedInheritedEscalationsIfNeeded(projectId, agentId);
      this.db.prepare(`
        INSERT INTO project_agent_escalations (project_id, agent_id, position, model_id, trigger, effort)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(project_id, agent_id, position) DO UPDATE SET
          model_id = excluded.model_id,
          trigger = excluded.trigger,
          effort = excluded.effort
      `).run(projectId, agentId, position, modelId, trigger, effort);
      this.db.prepare("UPDATE project_agents SET escalations_overridden = 1, updated_at = datetime('now') WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
      return this.listProjectAgentEscalations(projectId, agentId);
    });
  }

  deleteProjectAgentEscalation(projectId: number, agentId: number, positionInput: number): { overridden: boolean; escalations: ProjectAgentEscalationOverrideRow[] } {
    this.requireProjectAgentMutable(projectId, agentId);
    const position = requireEscalationPosition(positionInput);
    return this.runTransaction(() => {
      this.db.prepare('DELETE FROM project_agent_escalations WHERE project_id = ? AND agent_id = ? AND position = ?').run(projectId, agentId, position);
      this.db.prepare("UPDATE project_agents SET escalations_overridden = 1, updated_at = datetime('now') WHERE project_id = ? AND agent_id = ?").run(projectId, agentId);
      return this.listProjectAgentEscalations(projectId, agentId);
    });
  }

  setPrimaryDriver(projectId: number, agentId: number): void {
    this.requireProjectAgentMutable(projectId, agentId);
    // Enforce exactly-one-primary-driver invariant (per C2 brief + user reqs)
    // Clear all others first, then set this one. (txn not strictly needed for sqlite here but safe)
    this.db.prepare('UPDATE project_agents SET is_primary_driver = 0 WHERE project_id = ?').run(projectId);
    this.db.prepare(`
      UPDATE project_agents
      SET is_primary_driver = 1, updated_at = datetime('now')
      WHERE project_id = ? AND agent_id = ?
    `).run(projectId, agentId);
  }

  setAllToDefault(projectId: number): void {
    const raw = this.db.raw;
    raw.exec('BEGIN IMMEDIATE;');
    try {
      this.db.prepare('DELETE FROM project_agent_toolkits WHERE project_id = ?').run(projectId);
      this.db.prepare('DELETE FROM project_agent_escalations WHERE project_id = ?').run(projectId);
      this.db.prepare(`
        UPDATE project_agents
        SET
          model_id = NULL,
          use_dynamic = 0,
          backup_model_id = NULL,
          effort_override = NULL,
          spawn_pref_override = NULL,
          disabled_override = NULL,
          definition_md_override = NULL,
          toolkits_overridden = 0,
          escalations_overridden = 0,
          updated_at = datetime('now')
        WHERE project_id = ?
      `).run(projectId);
      raw.exec('COMMIT;');
    } catch (e) {
      try { raw.exec('ROLLBACK;'); } catch {}
      throw e;
    }
  }

  addAllAgents(projectId: number): void {
    // Idempotent: add every Studio agent (from agents table) not already present for this project
    const proj = this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(projectId);
    if (!proj) throw new Error('unknown project');
    const existingRows = this.db.prepare('SELECT agent_id FROM project_agents WHERE project_id = ?').all(projectId) as any[];
    const existing = new Set(existingRows.map((r: any) => Number(r.agent_id)));
    // D5 (R-02E): skip in_development agents.
    // B07b / R2.7: house-kind (incl. legacy helm) never enter a project roster.
    const allAgents = this.db.prepare(`
      SELECT id FROM agents
      WHERE (in_development = 0 OR in_development IS NULL)
        AND lower(coalesce(agent_type, 'project')) NOT IN ('house', 'helm')
    `).all() as any[];
    for (const a of allAgents) {
      const aid = Number(a.id);
      if (!existing.has(aid)) {
        this.db.prepare(`
          INSERT INTO project_agents (project_id, agent_id, model_id, use_dynamic, is_primary_driver)
          VALUES (?, ?, NULL, 0, 0)
        `).run(projectId, aid);
      }
    }
  }

  private runTransaction<T>(fn: () => T): T {
    return this.db.raw.transaction(fn)();
  }

  private requireProjectAgent(projectId: number, agentId: number): void {
    if (!this.getProjectAgent(projectId, agentId)) throw new Error('project agent not found');
  }

  /**
   * B07c: project-surface mutations must not target house/registry agents
   * (defense-in-depth if a legacy house row is already on project_agents).
   */
  private requireProjectAgentMutable(projectId: number, agentId: number): void {
    this.requireProjectAgent(projectId, agentId);
    const row = this.db.prepare('SELECT id, name, agent_type FROM agents WHERE id = ?').get(agentId) as
      | { id: number; name: string; agent_type: string }
      | undefined;
    if (row) {
      assertRegistryEditable(
        { id: Number(row.id), name: String(row.name), agent_type: row.agent_type },
        'project'
      );
    }
  }

  private getCollectionFlags(projectId: number, agentId: number): { toolkits_overridden: number; escalations_overridden: number } {
    const row = this.db.prepare(`
      SELECT toolkits_overridden, escalations_overridden
      FROM project_agents
      WHERE project_id = ? AND agent_id = ?
    `).get(projectId, agentId) as any;
    if (!row) throw new Error('project agent not found');
    return {
      toolkits_overridden: Number(row.toolkits_overridden),
      escalations_overridden: Number(row.escalations_overridden)
    };
  }

  private requireToolkit(toolkitId: number): void {
    const row = this.db.prepare('SELECT 1 FROM toolkits WHERE id = ?').get(toolkitId);
    if (!row) throw new Error('unknown toolkit');
  }

  private requireModel(modelId: number): void {
    const row = this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(modelId);
    if (!row) throw new Error('unknown model');
  }

  /** B9fix1 (RT-3 F1): on inherit→override transition, copy Studio rows before attach/upsert. */
  private seedInheritedToolkitsIfNeeded(projectId: number, agentId: number): void {
    const flags = this.getCollectionFlags(projectId, agentId);
    if (flags.toolkits_overridden === 1) return;
    const studioRows = this.db.prepare(`
      SELECT toolkit_id, position
      FROM agent_toolkits
      WHERE agent_id = ?
      ORDER BY position ASC
    `).all(agentId) as Array<{ toolkit_id: number; position: number }>;
    const stmt = this.db.prepare(`
      INSERT INTO project_agent_toolkits (project_id, agent_id, toolkit_id, position)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(project_id, agent_id, toolkit_id) DO NOTHING
    `);
    for (const row of studioRows) {
      stmt.run(projectId, agentId, Number(row.toolkit_id), Number(row.position));
    }
  }

  /** B9fix1 (RT-3 F1): on inherit→override transition, copy Studio rows before attach/upsert. */
  private seedInheritedEscalationsIfNeeded(projectId: number, agentId: number): void {
    const flags = this.getCollectionFlags(projectId, agentId);
    if (flags.escalations_overridden === 1) return;
    const studioRows = this.db.prepare(`
      SELECT position, model_id, trigger, effort
      FROM agent_escalations
      WHERE agent_id = ?
      ORDER BY position ASC
    `).all(agentId) as Array<{ position: number; model_id: number; trigger: string; effort: string | null }>;
    const stmt = this.db.prepare(`
      INSERT INTO project_agent_escalations (project_id, agent_id, position, model_id, trigger, effort)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, agent_id, position) DO NOTHING
    `);
    for (const row of studioRows) {
      stmt.run(
        projectId,
        agentId,
        Number(row.position),
        Number(row.model_id),
        String(row.trigger),
        row.effort == null || String(row.effort).trim() === '' ? null : String(row.effort),
      );
    }
  }
}

function normalizeNullableNumber(value: unknown, name: string): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`invalid ${name}`);
  return n;
}

function normalizeNullableEffort(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(v)) return v;
  throw new Error('invalid effort_override');
}

/** B5/AC-10: per-rung escalation effort (same whitelist as effort_override). */
function normalizeNullableEscalationEffort(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(v)) return v;
  throw new Error('invalid effort');
}

function normalizeNullableSpawn(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  if (v === 'tmux' || v === 'in-process') return v;
  throw new Error('invalid spawn_pref_override');
}

function normalizeNullableDisabled(value: unknown): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (value === true || value === 1 || value === '1' || value === 'true') return 1;
  if (value === false || value === 0 || value === '0' || value === 'false') return 0;
  throw new Error('invalid disabled_override');
}

function normalizeNullableDefinitionMd(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value);
  if (!text.trim()) return null;
  if (text.length > maxLength) throw new Error(`definition_md_override too long (max ${maxLength})`);
  return text;
}

function requireInteger(value: unknown, name: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`invalid ${name}`);
  return n;
}

function requireEscalationPosition(value: unknown): number {
  const n = Number(value);
  // B6a/AC-9: positions {1,2,3} = L2/L3/L4 (L1 is agents.default_model_id, not an escalation row)
  if (n !== 1 && n !== 2 && n !== 3) throw new Error('invalid escalation position');
  return n;
}

function requireEscalationTrigger(value: unknown): string {
  const trigger = value == null || value === '' ? 'on-fail' : String(value);
  if (!['on-fail', 'plan-summon', 'ibrain'].includes(trigger)) {
    throw new Error(`invalid escalation trigger: ${trigger}`);
  }
  return trigger;
}
