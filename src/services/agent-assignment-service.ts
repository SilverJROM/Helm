import { DatabaseService } from '../db/database.js';
import { AGENT_ROLES } from '../guardrails.js';
import { PROVIDERS } from '../config/providers.js';
import {
  assertOwnerDecisionAuthority,
  type DecisionActor,
} from './decision-authority.js';

export type AgentProvider = 'claude' | 'codex' | 'grok' | 'kloo';
/** R2.7 kind: project | house. Legacy alias name AgentType kept for callers. */
export type AgentKind = 'project' | 'house';
export type AgentType = AgentKind;
/** AC-1: UX classification (solo|tiered|team). Independent of kind/agent_type. */
export type AgentClassification = 'solo' | 'tiered' | 'team';
export type AgentRole = typeof AGENT_ROLES[number];

/**
 * R2.6 / B08: model binding tiers on a single agent prompt.
 * L1 base = agents.default_model_id (+ backup_model_id).
 * L2/L3 = agent_escalations positions 1/2 (not separate agent rows).
 */
export type AgentTier = 'L1' | 'L2' | 'L3';

export interface AgentTierModelBinding {
  tier: AgentTier;
  model_id: number | null;
  model_name: string | null;
  provider: AgentProvider | null;
  /** models.model_id launch string (not the agent free-floating identity). */
  model_ref: string | null;
  source: 'default_model_id' | 'agent_escalations' | 'none';
  backup_model_id?: number | null;
}

export interface AgentDefinition {
  id: number;
  name: string;
  provider: AgentProvider;
  model: string;
  default_effort: string | null;
  /**
   * R2.6: agent **identity** is this prompt/definition body — not name/role label alone,
   * and not the free-floating provider/model fields.
   */
  definition_md: string | null;
  /** L1 primary model binding (tier), not identity. */
  default_model_id: number | null;
  /** L1 backup model binding (tier), not identity. */
  backup_model_id: number | null;
  spawn_pref: string;
  in_development: boolean;
  /** R2.7 canonical kind (project | house). */
  kind: AgentKind;
  /** Legacy alias of kind (pre-B07a column/API name). Always equals kind. */
  agent_type: AgentKind;
  /** AC-1: solo | tiered | team — drives override-editor layout + list chip. */
  classification: AgentClassification;
  created_at: string;
  updated_at: string;
}

/**
 * R2.6: read an agent's prompt identity.
 * Name/role/provider/model alone are labels or launch hints — not identity.
 * Throws when definition_md is missing or empty/whitespace-only.
 */
export function getAgentPromptIdentity(agent: {
  id?: number;
  name?: string;
  definition_md?: string | null;
}): string {
  const md = agent.definition_md;
  if (typeof md === 'string' && md.trim().length > 0) return md;
  const who =
    agent.id != null
      ? `id=${agent.id}${agent.name ? ` name=${agent.name}` : ''}`
      : agent.name
        ? `name=${agent.name}`
        : 'unknown';
  throw new Error(
    `agent has no prompt identity (definition_md empty); name/model are not identity (${who})`
  );
}

/**
 * R2.6: when definition_md is supplied on create/update it must be a real prompt body.
 * Preserves exact content (no trim) once non-empty after the emptiness check.
 */
function assertNonEmptyPromptIdentity(definition_md: string | null | undefined, field: string): string {
  if (definition_md === null || definition_md === undefined || typeof definition_md !== 'string' || definition_md.trim().length === 0) {
    throw new Error(`${field} is required for agent identity (empty prompt is not identity)`);
  }
  return definition_md;
}

export interface RoleBinding {
  id: number;
  project_id: number;
  role: AgentRole;
  agent_id: number;
  created_at: string;
  updated_at: string;
}

export interface RoleDefault {
  role: AgentRole;
  agent_id: number;
  updated_at: string;
}

export interface RoleBindingWithAgent extends RoleBinding {
  agent: AgentDefinition;
}

export interface RoleDefaultWithAgent extends RoleDefault {
  agent: AgentDefinition;
}

export interface ResolvedRoleAgent {
  source: 'binding' | 'default';
  agent: AgentDefinition;
}

/**
 * AC-13 / B2: where the resolved launch model came from.
 * `inherited` covers both Studio default_model_id and agents.model TEXT fallback.
 */
export type ResolvedModelSource = 'dynamic' | 'override' | 'inherited' | 'unknown';
/**
 * Existing `type` kept for back-compat consumers/tests.
 * `default` = Studio default_model_id; `inherited` = agents.model TEXT only (no FK).
 */
export type ResolvedModelType = 'dynamic' | 'override' | 'default' | 'inherited' | 'unknown';

/** List-view effective: scalar resolution only — no persona text or collection bodies. */
export interface LeanEffectiveProjectAgent {
  project_id: number;
  agent_id: number;
  model: {
    type: ResolvedModelType;
    /** AC-13 source enum (dynamic | override | inherited | unknown). */
    source: ResolvedModelSource;
    id: number | null;
    model_id: string | null;
    name: string | null;
    provider: AgentProvider | null;
  };
  backup_model_id: number | null;
  effort: string | null;
  spawn_pref: string;
  in_development: boolean;
  overrides: {
    backup_model_id: number | null;
    effort_override: string | null;
    spawn_pref_override: string | null;
    disabled_override: number | null;
    toolkits_overridden: boolean;
    escalations_overridden: boolean;
  };
}

export interface EffectiveProjectAgent {
  project_id: number;
  agent_id: number;
  agent: AgentDefinition;
  model: {
    type: ResolvedModelType;
    /** AC-13 source enum (dynamic | override | inherited | unknown). */
    source: ResolvedModelSource;
    id: number | null;
    model_id: string | null;
    name: string | null;
    provider: AgentProvider | null;
  };
  backup_model_id: number | null;
  effort: string | null;
  spawn_pref: string;
  definition_md: string | null;
  in_development: boolean;
  toolkits: EffectiveProjectToolkit[];
  escalations: EffectiveProjectEscalation[];
  overrides: {
    backup_model_id: number | null;
    effort_override: string | null;
    spawn_pref_override: string | null;
    disabled_override: number | null;
    definition_md_override: string | null;
    toolkits_overridden: boolean;
    escalations_overridden: boolean;
  };
}

export interface EffectiveProjectToolkit {
  id: number;
  name: string;
  description: string | null;
  body_md: string;
  position: number;
}

export interface EffectiveProjectEscalation {
  position: number;
  model_id: number;
  trigger: string;
  model_name: string;
  provider: string;
  /** B5/AC-10: per-rung effort; null = inherit L1/agent default. */
  effort: string | null;
}

function requireRole(role: string): AgentRole {
  if (!AGENT_ROLES.includes(role as AgentRole)) throw new Error(`invalid role: ${role}`);
  return role as AgentRole;
}

function requireProvider(p: string): AgentProvider {
  if (!['claude','codex','grok','kloo'].includes(p)) throw new Error(`invalid provider: ${p}`);
  return p as AgentProvider;
}

function requireText(v: string | undefined, name: string): string {
  if (!v || typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}

function normalizeEffort(e?: string): string {
  const v = (e || 'medium').toLowerCase();
  if (['low','medium','high','xhigh','max'].includes(v)) return v;
  return 'medium';
}

/** B5/AC-10: nullable per-rung effort whitelist (same as effort_override). Reject out-of-whitelist. */
function normalizeNullableEscalationEffort(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null;
  const v = String(value).trim().toLowerCase();
  if (!v) return null;
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(v)) return v;
  throw new Error('invalid effort');
}

function requireSpawnPref(s?: string): string {
  const v = (s || 'tmux').toLowerCase();
  if (['tmux', 'in-process'].includes(v)) return v;
  throw new Error(`invalid spawn_pref: ${s} (allowed: tmux, in-process)`);
}

/** Normalize stored/legacy values to R2.7 kind. helm (legacy) → house. */
function normalizeKind(value: unknown): AgentKind {
  const v = String(value ?? 'project').toLowerCase();
  if (v === 'helm' || v === 'house') return 'house';
  return 'project';
}

/**
 * Require a valid kind for create/update.
 * Accepts: project | house. Legacy alias helm → house.
 * Rejects freeform / unknown values.
 */
function requireKind(t?: string | null): AgentKind {
  if (t === undefined || t === null || t === '') return 'project';
  const v = String(t).toLowerCase().trim();
  if (v === 'project') return 'project';
  if (v === 'house' || v === 'helm') return 'house';
  throw new Error(`invalid kind: ${t} (allowed: project, house)`);
}

/** Resolve kind from API body: prefer `kind`, fall back to legacy `agent_type`. */
function resolveKindInput(input: { kind?: string | null; agent_type?: string | null }): AgentKind | undefined {
  if (input.kind !== undefined && input.kind !== null && String(input.kind).trim() !== '') {
    return requireKind(String(input.kind));
  }
  if (input.agent_type !== undefined && input.agent_type !== null && String(input.agent_type).trim() !== '') {
    return requireKind(String(input.agent_type));
  }
  return undefined;
}

const CLASSIFICATION_WHITELIST: readonly AgentClassification[] = ['solo', 'tiered', 'team'];

/**
 * AC-1: normalize stored/synthetic classification. Defaults to 'solo' when
 * null/missing (pre-v94 fixtures, synthetic rows). Whitelist only.
 */
function normalizeClassification(value: unknown): AgentClassification {
  if (value === undefined || value === null || value === '') return 'solo';
  const v = String(value).toLowerCase().trim();
  if ((CLASSIFICATION_WHITELIST as readonly string[]).includes(v)) return v as AgentClassification;
  return 'solo';
}

/**
 * AC-1: require a valid classification for create/update. Rejects freeform.
 * Default 'solo' when omitted/empty.
 */
function requireClassification(t?: string | null): AgentClassification {
  if (t === undefined || t === null || t === '') return 'solo';
  const v = String(t).toLowerCase().trim();
  if ((CLASSIFICATION_WHITELIST as readonly string[]).includes(v)) return v as AgentClassification;
  throw new Error(`invalid classification: ${t} (allowed: solo, tiered, team)`);
}

/**
 * B07b / R2.7 house dispatch fence: house-kind agents must not enter a project run
 * (assignment into project roles, role defaults that feed runs, or resolve-for-dispatch).
 * Project-kind agents remain dispatchable. Registry-edit fence is B07c (separate helper).
 */
export function assertProjectRunDispatchable(agent: {
  id?: number;
  name?: string;
  kind?: string;
  agent_type?: string;
}): void {
  const kind = normalizeKind(agent.kind ?? agent.agent_type);
  if (kind === 'house') {
    const who =
      agent.id != null
        ? `id=${agent.id}${agent.name ? ` name=${agent.name}` : ''}`
        : agent.name
          ? `name=${agent.name}`
          : 'unknown';
    throw new Error(`house-kind agent cannot be dispatched into a project run (${who})`);
  }
}

/** Caller surface for agent registry (Studio `agents` table) mutations. */
export type RegistryEditSurface = 'studio' | 'project';

/**
 * Agent prompt bodies are Studio-owned identity.  Unlike other registry fields,
 * callers must state their Studio surface explicitly before changing one.  This
 * keeps project/binding code from accidentally acquiring an identity-write path.
 */
function assertStudioDefinitionWrite(surface?: RegistryEditSurface): asserts surface is 'studio' {
  if (surface !== 'studio') {
    throw new Error('definition_md writes require an explicit Studio-authorized surface');
  }
}

function agentWho(agent: { id?: number; name?: string }): string {
  return agent.id != null
    ? `id=${agent.id}${agent.name ? ` name=${agent.name}` : ''}`
    : agent.name
      ? `name=${agent.name}`
      : 'unknown';
}

/**
 * B07c / R2.7 registry-edit fence: project surfaces must not mutate house/registry
 * agent definitions (Studio `agents` rows with kind=house, incl. legacy helm).
 * Studio / house ops use surface 'studio' (default) and remain allowed.
 * Does not re-open B07b dispatch fence.
 */
export function assertRegistryEditable(
  agent: {
    id?: number;
    name?: string;
    kind?: string;
    agent_type?: string;
  },
  surface: RegistryEditSurface = 'studio'
): void {
  if (surface !== 'project') return;
  const kind = normalizeKind(agent.kind ?? agent.agent_type);
  if (kind === 'house') {
    throw new Error(
      `project surface cannot edit house/registry agent definitions (${agentWho(agent)})`
    );
  }
}

function modelIdExists(db: DatabaseService, id: number | null): boolean {
  if (id == null) return true;
  const row = db.prepare('SELECT 1 FROM models WHERE id = ?').get(id);
  return !!row;
}

function rowToAgent(row: any): AgentDefinition {
  const kind = normalizeKind(row.agent_type ?? row.kind);
  return {
    id: Number(row.id),
    name: String(row.name),
    provider: row.provider,
    model: String(row.model),
    default_effort: row.default_effort == null ? null : String(row.default_effort),
    definition_md: row.definition_md ?? null,
    default_model_id: row.default_model_id ?? null,
    backup_model_id: row.backup_model_id ?? null,
    spawn_pref: row.spawn_pref || 'tmux',
    in_development: row.in_development === 1,
    kind,
    agent_type: kind,
    classification: normalizeClassification(row.classification),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

// For rows from role_bindings/role_defaults JOIN agents: the SELECT uses rb.*/rd.* which clobbers
// `id` with the binding/default row id. Build the AGENT from the agent_* / *_join aliases so
// agent.id is the real agents.id (critical: project_agents overrides are keyed on agent.id).
function rowToAgentJoined(r: any): AgentDefinition {
  const kind = normalizeKind(r.agent_agent_type ?? r.agent_kind);
  return {
    id: Number(r.agent_id_join),
    name: String(r.name),
    provider: r.provider,
    model: String(r.model),
    default_effort: r.default_effort == null ? null : String(r.default_effort),
    definition_md: r.agent_definition_md ?? null,
    default_model_id: r.agent_default_model_id ?? null,
    backup_model_id: r.agent_backup_model_id ?? null,
    spawn_pref: r.agent_spawn_pref || 'tmux',
    in_development: r.agent_in_development === 1,
    kind,
    agent_type: kind,
    classification: normalizeClassification(r.agent_classification ?? r.classification),
    created_at: String(r.agent_created_at),
    updated_at: String(r.agent_updated_at)
  };
}

export class AgentAssignmentService {
  constructor(private readonly db: DatabaseService) {}

  listAgents(): AgentDefinition[] {
    return this.db.prepare('SELECT * FROM agents ORDER BY name').all().map(rowToAgent);
  }

  getAgent(id: number): AgentDefinition | null {
    const row = this.db.prepare('SELECT * FROM agents WHERE id = ?').get(id) as any;
    return row ? rowToAgent(row) : null;
  }

  resolveProjectAgent(projectId: number, agentId: number): EffectiveProjectAgent | null {
    const row = this.db.prepare(`
      SELECT
        pa.project_id, pa.agent_id, pa.model_id, pa.use_dynamic,
        pa.backup_model_id as pa_backup_model_id,
        pa.effort_override,
        pa.spawn_pref_override,
        pa.disabled_override,
        pa.definition_md_override,
        pa.toolkits_overridden,
        pa.escalations_overridden,
        a.*,
        om.model_id as override_model_id,
        om.name as override_model_name,
        om.provider as override_model_provider,
        dm.model_id as default_model_ref,
        dm.name as default_model_name,
        dm.provider as default_model_provider
      FROM project_agents pa
      JOIN agents a ON a.id = pa.agent_id
      LEFT JOIN models om ON om.id = pa.model_id
      LEFT JOIN models dm ON dm.id = a.default_model_id
      WHERE pa.project_id = ? AND pa.agent_id = ?
    `).get(projectId, agentId) as any;
    if (!row) return null;

    const agent = rowToAgent(row);
    let model: EffectiveProjectAgent['model'];
    // AC-13 chain: dynamic → project override → Studio default_model_id → agents.model TEXT → unknown
    if (Number(row.use_dynamic) === 1) {
      model = {
        type: 'dynamic',
        source: 'dynamic',
        id: null,
        model_id: null,
        name: 'dynamic (coordinator picks from global pool)',
        provider: null
      };
    } else if (row.model_id != null && row.override_model_id) {
      model = {
        type: 'override',
        source: 'override',
        id: Number(row.model_id),
        model_id: String(row.override_model_id),
        name: row.override_model_name == null ? null : String(row.override_model_name),
        provider: row.override_model_provider == null ? null : requireProvider(String(row.override_model_provider))
      };
    } else if (row.default_model_id != null && row.default_model_ref) {
      model = {
        type: 'default',
        source: 'inherited',
        id: Number(row.default_model_id),
        model_id: String(row.default_model_ref),
        name: row.default_model_name == null ? null : String(row.default_model_name),
        provider: row.default_model_provider == null ? null : requireProvider(String(row.default_model_provider))
      };
    } else if (row.model != null && String(row.model).trim() !== '') {
      // Launch-facing TEXT when Studio default_model_id is unset (panelist-like).
      const launchModel = String(row.model);
      model = {
        type: 'inherited',
        source: 'inherited',
        id: null,
        model_id: launchModel,
        name: launchModel,
        provider: row.provider == null ? null : requireProvider(String(row.provider))
      };
    } else {
      model = { type: 'unknown', source: 'unknown', id: null, model_id: null, name: null, provider: null };
    }

    const disabledOverride = row.disabled_override == null ? null : Number(row.disabled_override);
    const definitionMdOverride = row.definition_md_override == null ? null : String(row.definition_md_override);
    const effectiveDefinitionMdOverride =
      definitionMdOverride && definitionMdOverride.trim() ? definitionMdOverride : null;
    const studioInDevelopment = Number(row.in_development) === 1;
    const toolkitsOverridden = Number(row.toolkits_overridden) === 1;
    const escalationsOverridden = Number(row.escalations_overridden) === 1;
    return {
      project_id: Number(row.project_id),
      agent_id: Number(row.agent_id),
      agent,
      model,
      backup_model_id: row.pa_backup_model_id == null ? agent.backup_model_id : Number(row.pa_backup_model_id),
      effort: row.effort_override ?? agent.default_effort ?? null,
      spawn_pref: row.spawn_pref_override || agent.spawn_pref || 'tmux',
      definition_md: effectiveDefinitionMdOverride ?? agent.definition_md,
      in_development: studioInDevelopment || disabledOverride === 1,
      toolkits: this.listEffectiveProjectToolkits(projectId, agentId, toolkitsOverridden),
      escalations: this.listEffectiveProjectEscalations(projectId, agentId, escalationsOverridden),
      overrides: {
        backup_model_id: row.pa_backup_model_id == null ? null : Number(row.pa_backup_model_id),
        effort_override: row.effort_override == null ? null : String(row.effort_override),
        spawn_pref_override: row.spawn_pref_override == null ? null : String(row.spawn_pref_override),
        disabled_override: disabledOverride,
        definition_md_override: effectiveDefinitionMdOverride,
        toolkits_overridden: toolkitsOverridden,
        escalations_overridden: escalationsOverridden
      }
    };
  }

  private listEffectiveProjectToolkits(projectId: number, agentId: number, overridden: boolean): EffectiveProjectToolkit[] {
    const table = overridden ? 'project_agent_toolkits' : 'agent_toolkits';
    const where = overridden ? 'pat.project_id = ? AND pat.agent_id = ?' : 'pat.agent_id = ?';
    const args = overridden ? [projectId, agentId] : [agentId];
    const rows = this.db.prepare(`
      SELECT t.id, t.name, t.description, t.body_md, pat.position
      FROM ${table} pat
      JOIN toolkits t ON t.id = pat.toolkit_id
      WHERE ${where}
      ORDER BY pat.position ASC, t.name ASC
    `).all(...args) as any[];
    return rows.map((r: any) => ({
      id: Number(r.id),
      name: String(r.name),
      description: r.description ?? null,
      body_md: String(r.body_md),
      position: Number(r.position)
    }));
  }

  private listEffectiveProjectEscalations(projectId: number, agentId: number, overridden: boolean): EffectiveProjectEscalation[] {
    const table = overridden ? 'project_agent_escalations' : 'agent_escalations';
    const where = overridden ? 'e.project_id = ? AND e.agent_id = ?' : 'e.agent_id = ?';
    const args = overridden ? [projectId, agentId] : [agentId];
    const rows = this.db.prepare(`
      SELECT e.position, e.model_id, e.trigger, e.effort, m.name as model_name, m.provider
      FROM ${table} e
      JOIN models m ON m.id = e.model_id
      WHERE ${where}
      ORDER BY e.position ASC
    `).all(...args) as any[];
    return rows.map((r: any) => ({
      position: Number(r.position),
      model_id: Number(r.model_id),
      trigger: String(r.trigger),
      model_name: String(r.model_name),
      provider: String(r.provider),
      effort: r.effort == null || String(r.effort).trim() === '' ? null : String(r.effort),
    }));
  }

  private applyEffectiveProjectAgent(effective: EffectiveProjectAgent): AgentDefinition {
    const selectedModel = effective.model.type === 'dynamic'
      ? 'dynamic'
      : (effective.model.model_id ?? effective.agent.model);
    return {
      ...effective.agent,
      provider: effective.model.provider ?? effective.agent.provider,
      model: selectedModel,
      default_effort: effective.effort,
      backup_model_id: effective.backup_model_id,
      spawn_pref: effective.spawn_pref,
      definition_md: effective.definition_md,
      in_development: effective.in_development
    };
  }

  private resolveRoleAgentSettings(projectId: number, agent: AgentDefinition): { agent: AgentDefinition; effective: EffectiveProjectAgent | null } {
    const effective = this.resolveProjectAgent(projectId, agent.id);
    if (!effective) return { agent, effective: null };
    return { agent: this.applyEffectiveProjectAgent(effective), effective };
  }

  /**
   * Create an agent row.
   * R2.6: `definition_md` is the prompt identity (when supplied must be non-empty).
   * `provider`/`model` are launch-compat fields; L1 tier binding is `default_model_id`.
   * Models attach via tiers (default_model_id + agent_escalations), not as identity.
   */
  createAgent(
    input: {
      name: string;
      provider: string;
      model: string;
      default_effort?: string;
      definition_md?: string | null;
      default_model_id?: number | null;
      backup_model_id?: number | null;
      spawn_pref?: string;
      kind?: string;
      agent_type?: string;
      classification?: string;
    },
    opts?: { surface?: RegistryEditSurface; actor?: DecisionActor | null }
  ): AgentDefinition {
    const name = requireText(input.name, 'name');
    const provider = requireProvider(input.provider);
    const model = requireText(input.model, 'model');
    // RTF-M6: validate model against PROVIDERS registry (static import; createAgent is sync)
    const p = (PROVIDERS as Record<string, any>)[provider];
    if (!p || !p.models.some((m: any) => m.model === model)) {
      throw new Error(`unknown model for provider ${provider}: ${model}`);
    }
    const effort = normalizeEffort(input.default_effort);
    // R2.6: omit definition_md → null (legacy callers); if supplied, must be non-empty prompt identity
    if (input.definition_md !== undefined) {
      assertStudioDefinitionWrite(opts?.surface);
      assertOwnerDecisionAuthority(opts?.actor);
    }
    const defMd =
      input.definition_md === undefined ? null : assertNonEmptyPromptIdentity(input.definition_md, 'definition_md');
    const spawn = requireSpawnPref(input.spawn_pref);
    const defId = input.default_model_id ?? null;
    const bakId = input.backup_model_id ?? null;
    if (!modelIdExists(this.db, defId)) throw new Error(`unknown model id for default_model_id: ${defId}`);
    if (!modelIdExists(this.db, bakId)) throw new Error(`unknown model id for backup_model_id: ${bakId}`);
    const kind = resolveKindInput(input) ?? 'project';
    // AC-1: classification whitelist; default 'solo' when omitted
    const classification = requireClassification(input.classification);
    // B07c: project surface cannot create house/registry agents
    assertRegistryEditable({ name, kind }, opts?.surface ?? 'studio');
    // size cap enforced in routes (AGENT_DEFINITION_MAX); here accept as-is (preserve EXACTLY, no trim per consensus)
    // DB column remains agent_type; stored value is R2.7 kind (project|house).
    const row = this.db.prepare(`INSERT INTO agents (name, provider, model, default_effort, definition_md, default_model_id, backup_model_id, spawn_pref, agent_type, classification) VALUES (?,?,?,?,?,?,?,?,?,?) RETURNING *`).get(name, provider, model, effort, defMd, defId, bakId, spawn, kind, classification) as any;
    return rowToAgent(row);
  }

  listProjectBindings(projectId: number): RoleBindingWithAgent[] {
    const rows = this.db.prepare(`
      SELECT rb.*, a.id as agent_id_join, a.name, a.provider, a.model, a.default_effort, a.definition_md as agent_definition_md, a.default_model_id as agent_default_model_id, a.backup_model_id as agent_backup_model_id, a.spawn_pref as agent_spawn_pref, a.created_at as agent_created_at, a.updated_at as agent_updated_at, a.in_development as agent_in_development, a.agent_type as agent_agent_type, a.classification as agent_classification
      FROM role_bindings rb JOIN agents a ON a.id = rb.agent_id
      WHERE rb.project_id = ? ORDER BY rb.role, rb.id
    `).all(projectId) as any[];
    return rows.map((r: any) => ({
      id: Number(r.id), project_id: Number(r.project_id), role: r.role, agent_id: Number(r.agent_id),
      created_at: String(r.created_at), updated_at: String(r.updated_at),
      agent: rowToAgentJoined(r)
    }));
  }

  resolveProjectRoleBindings(projectId: number, roleInputs: string[]): Array<{ role: AgentRole; agent_id: number; agent: AgentDefinition; effective_project_agent: EffectiveProjectAgent | null }> {
    const roles = new Set(roleInputs.map(requireRole));
    return this.listProjectBindings(projectId)
      .filter((binding) => roles.has(binding.role))
      .map((binding) => {
        // B07b: fail-closed at resolve (legacy house bindings, e.g. backfilled helm panelist).
        assertProjectRunDispatchable(binding.agent);
        const resolved = this.resolveRoleAgentSettings(projectId, binding.agent);
        return {
          role: binding.role,
          agent_id: binding.agent_id,
          agent: resolved.agent,
          effective_project_agent: resolved.effective
        };
      });
  }

  getProjectBinding(projectId: number, roleInput: string): RoleBindingWithAgent | null {
    const role = requireRole(roleInput);
    const r = this.db.prepare(`
      SELECT rb.*, a.id as agent_id_join, a.name, a.provider, a.model, a.default_effort, a.definition_md as agent_definition_md, a.default_model_id as agent_default_model_id, a.backup_model_id as agent_backup_model_id, a.spawn_pref as agent_spawn_pref, a.created_at as agent_created_at, a.updated_at as agent_updated_at, a.in_development as agent_in_development, a.agent_type as agent_agent_type, a.classification as agent_classification
      FROM role_bindings rb JOIN agents a ON a.id = rb.agent_id
      WHERE rb.project_id = ? AND rb.role = ?
    `).get(projectId, role) as any;
    if (!r) return null;
    return {
      id: Number(r.id), project_id: Number(r.project_id), role: r.role, agent_id: Number(r.agent_id),
      created_at: String(r.created_at), updated_at: String(r.updated_at),
      agent: rowToAgentJoined(r)
    };
  }

  setProjectBinding(projectId: number, roleInput: string, agentId: number): RoleBindingWithAgent {
    // A4: delegate to batch version (clear + insert 1). Singles stay 1:1; red-team/panelist now support N via setRoleBindings.
    this.setRoleBindings(projectId, roleInput, [agentId]);
    const b = this.getProjectBinding(projectId, requireRole(roleInput));
    if (!b) throw new Error('binding not persisted');
    return b;
  }

  // A4: clear-then-insert batch for a role. Supports 1 (singles) or N (red-team + panelist).
  // Uses DELETE + INSERT OR IGNORE so A2b listProjectBindings (already used for red-team) now sees multiples.
  // Keeps getProjectBinding (first match) working for single-role callers.
  // B07b: house-kind agents rejected before any write (project-run dispatch fence).
  setRoleBindings(projectId: number, roleInput: string, agentIds: number[]): void {
    const role = requireRole(roleInput);
    const ids = (agentIds || []).filter((aid) => aid != null).map((aid) => Number(aid));
    for (const aid of ids) {
      const agent = this.getAgent(aid);
      if (!agent) throw new Error(`unknown agent: ${aid}`);
      assertProjectRunDispatchable(agent);
    }
    this.db.prepare(`DELETE FROM role_bindings WHERE project_id = ? AND role = ?`).run(projectId, role);
    const stmt = this.db.prepare(`INSERT OR IGNORE INTO role_bindings (project_id, role, agent_id) VALUES (?,?,?)`);
    for (const aid of ids) {
      stmt.run(projectId, role, aid);
    }
  }

  listRoleDefaults(): RoleDefaultWithAgent[] {
    const rows = this.db.prepare(`
      SELECT rd.*, a.id as agent_id_join, a.name, a.provider, a.model, a.default_effort, a.definition_md as agent_definition_md, a.default_model_id as agent_default_model_id, a.backup_model_id as agent_backup_model_id, a.spawn_pref as agent_spawn_pref, a.created_at as agent_created_at, a.updated_at as agent_updated_at, a.in_development as agent_in_development, a.agent_type as agent_agent_type, a.classification as agent_classification
      FROM role_defaults rd JOIN agents a ON a.id = rd.agent_id ORDER BY rd.role
    `).all() as any[];
    return rows.map((r: any) => ({
      role: r.role, agent_id: Number(r.agent_id), updated_at: String(r.updated_at),
      agent: rowToAgentJoined(r)
    }));
  }

  resolveProjectRole(projectId: number, roleInput: string): any {
    const role = requireRole(roleInput);
    if (role === 'deliberation' || role === 'red-team') {
      // B8a / AC-12: opt-in project roster override FIRST. Zero rows → fall through to today's
      // role_team_bindings → team_members path unchanged (regression gate: byte-identical).
      const overrideRoster = this._loadProjectRoleRosterOverride(projectId, role);
      if (overrideRoster && overrideRoster.length > 0) {
        return { source: 'project-roster-override', roster: overrideRoster };
      }
      const tb = this.listProjectTeamBindings(projectId).find((b: any) => b.role === role);
      if (tb && tb.team_id) {
        const rosterRows = this.db.prepare(`
          SELECT tm.position, tm.lens, m.model_id as model, m.provider, m.id as model_id
          FROM team_members tm
          JOIN models m ON m.id = tm.model_id
          WHERE tm.team_id = ?
          ORDER BY tm.position
        `).all(tb.team_id) as any[];
        const roster = rosterRows.map((r: any) => ({
          position: Number(r.position),
          lens: r.lens || null,
          model: r.model,
          provider: r.provider,
          model_id: Number(r.model_id)
        }));
        if (roster.length === 0) {
          throw new Error('team bound for role but roster empty');
        }
        return { source: 'project-team-binding', roster, team_id: tb.team_id };
      }
    }
    const binding = this.getProjectBinding(projectId, role);
    let baseAgent = binding && binding.agent ? { ...binding.agent } : null;
    let src = binding ? 'binding' : 'default';
    if (!baseAgent) {
      const def = this.listRoleDefaults().find((d: any) => d.role === role);
      if (def && def.agent) {
        baseAgent = { ...def.agent };
        src = 'default';
      }
    }
    if (baseAgent) {
      // B07b: fail-closed at resolve/dispatch if a house agent is bound or defaulted.
      assertProjectRunDispatchable(baseAgent);
      const resolved = this.resolveRoleAgentSettings(projectId, baseAgent);
      return { source: src, agent: resolved.agent, effective_project_agent: resolved.effective };
    }
    return null;
  }

  setRoleDefault(roleInput: string, agentId: number): RoleDefaultWithAgent {
    const role = requireRole(roleInput);
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    // B07b: role defaults feed project runs via resolveProjectRole — house denied.
    assertProjectRunDispatchable(agent);
    this.db.prepare(`INSERT INTO role_defaults (role, agent_id) VALUES (?,?) ON CONFLICT(role) DO UPDATE SET agent_id=excluded.agent_id, updated_at=datetime('now')`).run(role, agentId);
    const d = this.listRoleDefaults().find(x => x.role === role);
    if (!d) throw new Error('default not persisted');
    return d;
  }

  // P3-1 + B2 + B07a + B07c: update (validate provider/model/kind; UNIQUE name; preserve def_md EXACTLY; updated_at)
  // B07c: surface 'project' cannot mutate house/registry agent rows (or promote kind→house).
  // B10b/R2.10 AS-C1: jkage L0 cannot exercise direct owner definition/metadata write.
  updateAgent(
    id: number,
    input: {
      name?: string;
      provider?: string;
      model?: string;
      default_effort?: string;
      definition_md?: string | null;
      default_model_id?: number | null;
      backup_model_id?: number | null;
      spawn_pref?: string;
      in_development?: boolean;
      kind?: string;
      agent_type?: string;
      classification?: string;
    },
    opts?: { surface?: RegistryEditSurface; actor?: DecisionActor | null }
  ): AgentDefinition {
    assertOwnerDecisionAuthority(opts?.actor);
    const surface = opts?.surface ?? 'studio';
    const existing = this.getAgent(id);
    if (existing) {
      assertRegistryEditable(existing, surface);
    }
    // Deny project-surface kind promote/flip into house registry
    if (input.kind !== undefined || input.agent_type !== undefined) {
      const nextKind = resolveKindInput(input);
      if (nextKind !== undefined) {
        assertRegistryEditable(
          { id, name: existing?.name, kind: nextKind },
          surface
        );
      }
    }
    const sets: string[] = [];
    const vals: any[] = [];
    if (input.name !== undefined) {
      const name = requireText(input.name, 'name');
      const existing = this.db.prepare('SELECT id FROM agents WHERE name = ? AND id != ?').get(name, id);
      if (existing) throw new Error(`agent name must be unique: ${name}`);
      sets.push('name=?');
      vals.push(name);
    }
    if (input.provider !== undefined || input.model !== undefined) {
      const provider = input.provider ? requireProvider(input.provider) : null;
      const model = input.model ? requireText(input.model, 'model') : null;
      // validate against PROVIDERS (reuse create logic)
      const prov = provider || (this.getAgent(id)?.provider);
      const mod = model || (this.getAgent(id)?.model);
      const p = (PROVIDERS as Record<string, any>)[prov!];
      if (!p || !p.models.some((m: any) => m.model === mod)) {
        throw new Error(`unknown model for provider ${prov}: ${mod}`);
      }
      if (provider) { sets.push('provider=?'); vals.push(provider); }
      if (model) { sets.push('model=?'); vals.push(model); }
    }
    if (input.default_effort !== undefined) {
      const effort = normalizeEffort(input.default_effort);
      sets.push('default_effort=?');
      vals.push(effort);
    }
    if (input.default_model_id !== undefined || input.backup_model_id !== undefined || input.spawn_pref !== undefined) {
      const defId = input.default_model_id !== undefined ? input.default_model_id : (this.getAgent(id)?.default_model_id ?? null);
      const bakId = input.backup_model_id !== undefined ? input.backup_model_id : (this.getAgent(id)?.backup_model_id ?? null);
      const spawn = input.spawn_pref !== undefined ? requireSpawnPref(input.spawn_pref) : (this.getAgent(id)?.spawn_pref || 'tmux');
      if (!modelIdExists(this.db, defId)) throw new Error(`unknown model id for default_model_id: ${defId}`);
      if (!modelIdExists(this.db, bakId)) throw new Error(`unknown model id for backup_model_id: ${bakId}`);
      if (input.default_model_id !== undefined) { sets.push('default_model_id=?'); vals.push(defId); }
      if (input.backup_model_id !== undefined) { sets.push('backup_model_id=?'); vals.push(bakId); }
      if (input.spawn_pref !== undefined) { sets.push('spawn_pref=?'); vals.push(spawn); }
    }
    if ('definition_md' in input) {
      assertStudioDefinitionWrite(opts?.surface);
      // R2.6: identity is definition_md — must be non-empty prompt body; preserve EXACTLY (no trim)
      // size cap in routes (AGENT_DEFINITION_MAX -> 400)
      const d = assertNonEmptyPromptIdentity(input.definition_md, 'definition_md');
      sets.push('definition_md=?');
      vals.push(d);
    }
    if (input.in_development !== undefined) {
      sets.push('in_development=?');
      vals.push(input.in_development ? 1 : 0);
    }
    // B07a: kind (canonical) or agent_type (legacy alias). Prefer kind when both present.
    if (input.kind !== undefined || input.agent_type !== undefined) {
      const kind = resolveKindInput(input);
      if (kind !== undefined) {
        sets.push('agent_type=?');
        vals.push(kind);
      }
    }
    // AC-1: classification whitelist-guarded
    if (input.classification !== undefined) {
      const classification = requireClassification(input.classification);
      sets.push('classification=?');
      vals.push(classification);
    }
    if (sets.length === 0) {
      return this.getAgent(id)!;
    }
    sets.push("updated_at=datetime('now')");
    this.db.prepare(`UPDATE agents SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    const updated = this.getAgent(id);
    if (!updated) throw new Error('agent not found after update');
    return updated;
  }

  // ── R2.6 / B08: tiers attach models to a prompt identity (not separate agent rows) ──

  /**
   * Resolve the model binding for a tier on one agent prompt.
   * L1 → agents.default_model_id (+ backup_model_id).
   * L2 → agent_escalations position 1; L3 → position 2.
   */
  resolveAgentTierModel(agentId: number, tier: AgentTier): AgentTierModelBinding {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    if (tier !== 'L1' && tier !== 'L2' && tier !== 'L3') {
      throw new Error(`invalid tier: ${tier} (allowed: L1, L2, L3)`);
    }

    if (tier === 'L1') {
      if (agent.default_model_id == null) {
        return {
          tier: 'L1',
          model_id: null,
          model_name: null,
          provider: null,
          model_ref: null,
          source: 'none',
          backup_model_id: agent.backup_model_id,
        };
      }
      const m = this.db
        .prepare('SELECT id, name, provider, model_id FROM models WHERE id = ?')
        .get(agent.default_model_id) as any;
      if (!m) {
        return {
          tier: 'L1',
          model_id: agent.default_model_id,
          model_name: null,
          provider: null,
          model_ref: null,
          source: 'default_model_id',
          backup_model_id: agent.backup_model_id,
        };
      }
      return {
        tier: 'L1',
        model_id: Number(m.id),
        model_name: String(m.name),
        provider: requireProvider(String(m.provider)),
        model_ref: String(m.model_id),
        source: 'default_model_id',
        backup_model_id: agent.backup_model_id,
      };
    }

    const position = tier === 'L2' ? 1 : 2;
    const row = this.db
      .prepare(
        `
      SELECT e.model_id as mid, m.name, m.provider, m.model_id as model_ref
      FROM agent_escalations e
      JOIN models m ON m.id = e.model_id
      WHERE e.agent_id = ? AND e.position = ?
    `
      )
      .get(agentId, position) as any;
    if (!row) {
      return {
        tier,
        model_id: null,
        model_name: null,
        provider: null,
        model_ref: null,
        source: 'none',
      };
    }
    return {
      tier,
      model_id: Number(row.mid),
      model_name: String(row.name),
      provider: requireProvider(String(row.provider)),
      model_ref: String(row.model_ref),
      source: 'agent_escalations',
    };
  }

  listAgentTierModels(agentId: number): {
    L1: AgentTierModelBinding;
    L2: AgentTierModelBinding;
    L3: AgentTierModelBinding;
  } {
    return {
      L1: this.resolveAgentTierModel(agentId, 'L1'),
      L2: this.resolveAgentTierModel(agentId, 'L2'),
      L3: this.resolveAgentTierModel(agentId, 'L3'),
    };
  }

  /**
   * Bind models to L1/L2/L3 tiers without touching prompt identity (definition_md).
   * Partial updates: only keys present in `tiers` are written.
   */
  bindAgentTierModels(
    agentId: number,
    tiers: {
      L1?: number | null;
      L1_backup?: number | null;
      L2?: number | null;
      L3?: number | null;
    },
    opts?: { surface?: RegistryEditSurface }
  ): {
    identity: string | null;
    tiers: { L1: AgentTierModelBinding; L2: AgentTierModelBinding; L3: AgentTierModelBinding };
  } {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error(`unknown agent: ${agentId}`);
    assertRegistryEditable(agent, opts?.surface ?? 'studio');

    const identityBefore = agent.definition_md;

    if ('L1' in tiers || 'L1_backup' in tiers) {
      const defId = 'L1' in tiers ? (tiers.L1 ?? null) : agent.default_model_id;
      const bakId = 'L1_backup' in tiers ? (tiers.L1_backup ?? null) : agent.backup_model_id;
      if (!modelIdExists(this.db, defId)) throw new Error(`unknown model id for L1: ${defId}`);
      if (!modelIdExists(this.db, bakId)) throw new Error(`unknown model id for L1_backup: ${bakId}`);
      this.db
        .prepare(
          `UPDATE agents SET default_model_id = ?, backup_model_id = ?, updated_at = datetime('now') WHERE id = ?`
        )
        .run(defId, bakId, agentId);
    }

    if ('L2' in tiers || 'L3' in tiers) {
      const existing = this.listAgentEscalations(agentId);
      let l2: number | null =
        existing.find((e: any) => Number(e.position) === 1)?.model_id != null
          ? Number(existing.find((e: any) => Number(e.position) === 1).model_id)
          : null;
      let l3: number | null =
        existing.find((e: any) => Number(e.position) === 2)?.model_id != null
          ? Number(existing.find((e: any) => Number(e.position) === 2).model_id)
          : null;
      if ('L2' in tiers) l2 = tiers.L2 == null ? null : Number(tiers.L2);
      if ('L3' in tiers) l3 = tiers.L3 == null ? null : Number(tiers.L3);
      const rungs: Array<{ position: number; model_id: number }> = [];
      if (l2 != null) rungs.push({ position: 1, model_id: l2 });
      if (l3 != null) rungs.push({ position: 2, model_id: l3 });
      this.setAgentEscalations(agentId, rungs, opts);
    }

    const after = this.getAgent(agentId);
    if (!after) throw new Error('agent not found after tier bind');
    if (after.definition_md !== identityBefore) {
      throw new Error('invariant: bindAgentTierModels must not change definition_md identity');
    }
    return {
      identity: after.definition_md,
      tiers: this.listAgentTierModels(agentId),
    };
  }

  // B6b: agent_escalations CRUD (per-agent rung ladders)
  listAgentEscalations(agentId: number): any[] {
    return this.db.prepare(`
      SELECT e.*, m.name as model_name, m.provider
      FROM agent_escalations e
      JOIN models m ON m.id = e.model_id
      WHERE e.agent_id = ?
      ORDER BY e.position
    `).all(agentId).map((r: any) => ({
      ...r,
      effort: r.effort == null || String(r.effort).trim() === '' ? null : String(r.effort),
    })) as any[];
  }

  setAgentEscalations(
    agentId: number,
    rungs: Array<{ position: number; model_id: number; trigger?: string; effort?: string | null }>,
    opts?: { surface?: RegistryEditSurface }
  ): any[] {
    const agent = this.getAgent(agentId);
    if (!agent) throw new Error('unknown agent');
    // B07c: project surface cannot edit house/registry agent escalations
    assertRegistryEditable(agent, opts?.surface ?? 'studio');
    // clear existing for agent
    this.db.prepare('DELETE FROM agent_escalations WHERE agent_id = ?').run(agentId);
    const stmt = this.db.prepare(`
      INSERT INTO agent_escalations (agent_id, position, model_id, trigger, effort) VALUES (?,?,?,?,?)
    `);
    for (const r of (rungs || [])) {
      const pos = Number(r.position);
      // B6a/AC-9: positions {1,2,3} = L2/L3/L4 (optional L4; silently skip out-of-domain)
      if (pos !== 1 && pos !== 2 && pos !== 3) continue;
      const mid = Number(r.model_id);
      const m = this.db.prepare('SELECT 1 FROM models WHERE id = ?').get(mid);
      if (!m) throw new Error('unknown model for rung');
      const trig = r.trigger || 'on-fail';
      if (!['on-fail', 'plan-summon', 'ibrain'].includes(trig)) {
        throw new Error(`invalid escalation trigger: ${trig}`);
      }
      // B5/AC-10: accept + whitelist-validate optional per-rung effort (NULL inherits L1)
      const effort = Object.prototype.hasOwnProperty.call(r, 'effort')
        ? normalizeNullableEscalationEffort(r.effort)
        : null;
      stmt.run(agentId, pos, mid, trig, effort);
    }
    return this.listAgentEscalations(agentId);
  }

  deleteAgentEscalation(
    agentId: number,
    position: number,
    opts?: { surface?: RegistryEditSurface }
  ): void {
    const agent = this.getAgent(agentId);
    if (agent) assertRegistryEditable(agent, opts?.surface ?? 'studio');
    this.db.prepare('DELETE FROM agent_escalations WHERE agent_id = ? AND position = ?').run(agentId, Number(position));
  }

  // B3: team role bindings (for deliberation/red-team)
  listProjectTeamBindings(projectId: number): any[] {
    const rows = this.db.prepare(`
      SELECT rtb.*, t.id as t_id, t.name as t_name, t.type as t_type, t.consensus_rule as t_consensus
      FROM role_team_bindings rtb
      JOIN teams t ON t.id = rtb.team_id
      WHERE rtb.project_id = ?
      ORDER BY rtb.role
    `).all(projectId) as any[];
    return rows.map((r: any) => ({
      id: Number(r.id), project_id: Number(r.project_id), role: r.role, team_id: Number(r.team_id),
      team: { id: Number(r.t_id), name: r.t_name, type: r.t_type, consensus_rule: r.t_consensus }
    }));
  }

  setProjectTeamBinding(projectId: number, roleInput: string, teamId: number): void {
    const role = requireRole(roleInput);
    if (role !== 'deliberation' && role !== 'red-team') throw new Error('only deliberation/red-team support team binding');
    const t = this.db.prepare('SELECT 1 FROM teams WHERE id = ?').get(teamId);
    if (!t) throw new Error('unknown team');
    this.db.prepare(`DELETE FROM role_team_bindings WHERE project_id = ? AND role = ?`).run(projectId, role);
    this.db.prepare(`INSERT OR IGNORE INTO role_team_bindings (project_id, role, team_id) VALUES (?,?,?)`).run(projectId, role, teamId);
  }

  /** AC-12b: remove project→team binding for deliberation|red-team. Does not touch roster overrides. */
  unbindProjectTeam(projectId: number, roleInput: string): void {
    const role = requireRole(roleInput);
    if (role !== 'deliberation' && role !== 'red-team') {
      throw new Error('only deliberation/red-team support team binding');
    }
    this.db.prepare('DELETE FROM role_team_bindings WHERE project_id = ? AND role = ?').run(projectId, role);
  }

  /**
   * B8a / AC-12: effective roster for a team role.
   * source 'project' = opt-in override rows; 'studio' = bound team's members (or empty if unbound).
   */
  getEffectiveRoleRoster(
    projectId: number,
    roleInput: string
  ): {
    source: 'studio' | 'project';
    members: Array<{ position: number; lens: string | null; model: string; provider: string; model_id: number }>;
    team_id?: number;
  } {
    const role = this._requireTeamRole(roleInput);
    const override = this._loadProjectRoleRosterOverride(projectId, role);
    if (override && override.length > 0) {
      return { source: 'project', members: override };
    }
    const tb = this.listProjectTeamBindings(projectId).find((b: any) => b.role === role);
    if (tb && tb.team_id) {
      const members = this._loadTeamRosterMembers(Number(tb.team_id));
      return { source: 'studio', members, team_id: Number(tb.team_id) };
    }
    return { source: 'studio', members: [] };
  }

  /**
   * B8a: full-replace project roster override for (project, role).
   * members[] order becomes position 0..n-1. Empty array clears override (same as reset).
   */
  setProjectRoleRoster(
    projectId: number,
    roleInput: string,
    members: Array<{ model_id: number; lens?: string | null }>
  ): {
    source: 'studio' | 'project';
    members: Array<{ position: number; lens: string | null; model: string; provider: string; model_id: number }>;
    team_id?: number;
  } {
    const role = this._requireTeamRole(roleInput);
    const proj = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!proj) throw new Error('unknown project');
    if (!Array.isArray(members)) throw new Error('members must be an array');

    const normalized: Array<{ model_id: number; lens: string | null }> = [];
    for (const m of members) {
      if (m == null || m.model_id == null || !Number.isFinite(Number(m.model_id))) {
        throw new Error('each member requires a valid model_id');
      }
      const mid = Number(m.model_id);
      const row = this.db.prepare('SELECT id FROM models WHERE id = ?').get(mid);
      if (!row) throw new Error(`unknown model_id: ${mid}`);
      const lens =
        m.lens == null || m.lens === ''
          ? null
          : String(m.lens);
      normalized.push({ model_id: mid, lens });
    }

    this.db.raw.transaction(() => {
      this.db
        .prepare('DELETE FROM project_role_roster_members WHERE project_id = ? AND role = ?')
        .run(projectId, role);
      const ins = this.db.prepare(`
        INSERT INTO project_role_roster_members (project_id, role, position, model_id, lens)
        VALUES (?, ?, ?, ?, ?)
      `);
      normalized.forEach((m, i) => {
        ins.run(projectId, role, i, m.model_id, m.lens);
      });
    })();

    return this.getEffectiveRoleRoster(projectId, role);
  }

  /** B8a: delete override rows so resolve falls back to Studio team binding. */
  resetProjectRoleRoster(projectId: number, roleInput: string): {
    source: 'studio' | 'project';
    members: Array<{ position: number; lens: string | null; model: string; provider: string; model_id: number }>;
    team_id?: number;
  } {
    const role = this._requireTeamRole(roleInput);
    this.db
      .prepare('DELETE FROM project_role_roster_members WHERE project_id = ? AND role = ?')
      .run(projectId, role);
    return this.getEffectiveRoleRoster(projectId, role);
  }

  private _requireTeamRole(roleInput: string): 'deliberation' | 'red-team' {
    const role = requireRole(roleInput);
    if (role !== 'deliberation' && role !== 'red-team') {
      throw new Error('only deliberation/red-team support project role roster');
    }
    return role;
  }

  /** Load opt-in override roster rows; returns null when zero rows (inherit Studio). */
  private _loadProjectRoleRosterOverride(
    projectId: number,
    role: string
  ): Array<{ position: number; lens: string | null; model: string; provider: string; model_id: number }> | null {
    const rows = this.db.prepare(`
      SELECT pr.position, pr.lens, m.model_id as model, m.provider, m.id as model_id
      FROM project_role_roster_members pr
      JOIN models m ON m.id = pr.model_id
      WHERE pr.project_id = ? AND pr.role = ?
      ORDER BY pr.position
    `).all(projectId, role) as any[];
    if (!rows.length) return null;
    return rows.map((r: any) => ({
      position: Number(r.position),
      lens: r.lens || null,
      model: r.model,
      provider: r.provider,
      model_id: Number(r.model_id),
    }));
  }

  private _loadTeamRosterMembers(
    teamId: number
  ): Array<{ position: number; lens: string | null; model: string; provider: string; model_id: number }> {
    const rosterRows = this.db.prepare(`
      SELECT tm.position, tm.lens, m.model_id as model, m.provider, m.id as model_id
      FROM team_members tm
      JOIN models m ON m.id = tm.model_id
      WHERE tm.team_id = ?
      ORDER BY tm.position
    `).all(teamId) as any[];
    return rosterRows.map((r: any) => ({
      position: Number(r.position),
      lens: r.lens || null,
      model: r.model,
      provider: r.provider,
      model_id: Number(r.model_id),
    }));
  }

  // P3-1: delete with preflight BOTH role_bindings AND role_defaults (per HIGH consensus); 409-mappable error listing blocking refs if bound
  // B07c: surface 'project' cannot delete house/registry agents
  deleteAgent(id: number, opts?: { surface?: RegistryEditSurface }): void {
    const existing = this.getAgent(id);
    if (existing) assertRegistryEditable(existing, opts?.surface ?? 'studio');
    const bCount = this.db.prepare('SELECT COUNT(*) as c FROM role_bindings WHERE agent_id = ?').get(id) as { c: number };
    const dCount = this.db.prepare('SELECT COUNT(*) as c FROM role_defaults WHERE agent_id = ?').get(id) as { c: number };
    if (bCount.c > 0 || dCount.c > 0) {
      const refs: string[] = [];
      if (dCount.c > 0) {
        const defs = this.db.prepare('SELECT role FROM role_defaults WHERE agent_id = ?').all(id) as any[];
        refs.push('role_defaults: ' + defs.map((d: any) => d.role).join(', '));
      }
      if (bCount.c > 0) {
        const binds = this.db.prepare('SELECT role, project_id FROM role_bindings WHERE agent_id = ?').all(id) as any[];
        refs.push('role_bindings: ' + binds.map((b: any) => `${b.role}@p${b.project_id}`).join(', '));
      }
      throw new Error(`agent is bound (cannot delete): ${refs.join('; ')}`);
    }
    this.db.prepare('DELETE FROM agents WHERE id = ?').run(id);
  }
}

export interface RoleCapability {
  role: AgentRole;
  allowed_statuses: string[];      // parsed from JSON
  terminal_statuses: string[];
  can_write_code: boolean;
  requires_repro_first: boolean;
  panel_participant: boolean;
  can_escalate: boolean;
  session_policy: 'fresh' | 'clear+rehydrate';
  required_artifacts: string[];
  timeout_ms: number | null;
  checkin_ms: number | null;
}

function rowToRoleCapability(row: any): RoleCapability {
  const parseJsonArray = (s: string | null): string[] => {
    if (!s) return [];
    try { return JSON.parse(s); } catch { return []; }
  };
  return {
    role: row.role as AgentRole,
    allowed_statuses: parseJsonArray(row.allowed_statuses),
    terminal_statuses: parseJsonArray(row.terminal_statuses),
    can_write_code: !!row.can_write_code,
    requires_repro_first: !!row.requires_repro_first,
    panel_participant: !!row.panel_participant,
    can_escalate: !!row.can_escalate,
    session_policy: (row.session_policy || 'fresh') as 'fresh' | 'clear+rehydrate',
    required_artifacts: parseJsonArray(row.required_artifacts),
    timeout_ms: row.timeout_ms ?? null,
    checkin_ms: row.checkin_ms ?? null
  };
}

export class RoleCapabilityService {
  constructor(private readonly db: DatabaseService) {}

  listRoleCapabilities(): RoleCapability[] {
    const rows = this.db.prepare('SELECT * FROM role_capabilities ORDER BY role').all() as any[];
    return rows.map(rowToRoleCapability);
  }

  getRoleCapability(roleInput: string): RoleCapability | null {
    // allow via AAS requireRole or loose
    const row = this.db.prepare('SELECT * FROM role_capabilities WHERE role = ?').get(roleInput) as any;
    return row ? rowToRoleCapability(row) : null;
  }
}
