import { DatabaseService } from '../db/database.js';
import { assertMasterWriteAllowed } from '../db/schema.js';

/**
 * Master chain seeded onto a new project. `claude` is rejected as a persistent master (RTF-H1), so
 * this is grok — the same chain every existing project runs its ibrain master on. Validated against
 * PROVIDERS at insert time so a stale default fails loudly instead of creating a dead project.
 */
export const DEFAULT_MASTER_PROVIDER = 'grok';
export const DEFAULT_MASTER_MODEL = 'grok-4.5';

export const AUTONOMY_DEFAULT_VALUES = ['autonomous_after_discovery', 'pause_after_planning'] as const;
export type AutonomyDefault = (typeof AUTONOMY_DEFAULT_VALUES)[number];
export const DEFAULT_AUTONOMY_DEFAULT: AutonomyDefault = 'pause_after_planning';

export function normalizeFinalTestsDefault(value: unknown): boolean {
  if (value == null || value === '') return true;
  if (typeof value === 'boolean') return value;
  const n = Number(value);
  if (n === 0) return false;
  if (n === 1) return true;
  const s = String(value).toLowerCase();
  if (s === 'false' || s === 'off' || s === '0') return false;
  if (s === 'true' || s === 'on' || s === '1') return true;
  throw new Error(`invalid final_tests_default: ${value}`);
}

export function normalizeAutonomyDefault(value: unknown): AutonomyDefault {
  if (value == null || value === '') return DEFAULT_AUTONOMY_DEFAULT;
  const v = String(value);
  if ((AUTONOMY_DEFAULT_VALUES as readonly string[]).includes(v)) return v as AutonomyDefault;
  throw new Error(`invalid autonomy_default: ${v}`);
}

export interface Project {
  id: number;
  name: string;
  directory: string;
  directory_name: string;
  description: string | null;
  dev_url: string | null;
  qa_url: string | null;
  tags: string[];
  status: 'active' | 'archived';
  active: number;
  tmux_session: string | null;
  plancore_session: string | null;
  primary_driver_agent_id: number | null;
  autonomy_default: AutonomyDefault;
  final_tests_default: boolean;
  adaptive_planning: boolean; // v92: opt-in adaptive tiered planner
  planner_default_effort: string | null; // v93: panel default effort (low|med|high|xhigh)
  planning_panel_size: number; // v99: core (non-adaptive) planning panel size, total seats, default 2
  created_at: string;
  updated_at: string;
}

export function normalizeProjectTags(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(',')
      : [];
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of raw) {
    const tag = String(value ?? '').trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

export function parseProjectTags(value: unknown): string[] {
  if (value == null || value === '') return [];
  try {
    const parsed = JSON.parse(String(value));
    return normalizeProjectTags(parsed);
  } catch {
    return [];
  }
}

export function serializeProjectTags(input: unknown): string {
  return JSON.stringify(normalizeProjectTags(input));
}

function rowToProject(row: any): Project {
  return {
    id: Number(row.id),
    name: String(row.name),
    directory: String(row.directory),
    directory_name: String(row.directory_name),
    description: row.description ?? null,
    dev_url: row.dev_url ?? null,
    qa_url: row.qa_url ?? null,
    tags: parseProjectTags(row.tags),
    status: row.status === 'archived' ? 'archived' : 'active',
    active: Number(row.active),
    tmux_session: row.tmux_session ?? null,
    plancore_session: row.plancore_session ?? null,
    primary_driver_agent_id: row.primary_driver_agent_id ?? null,
    autonomy_default: normalizeAutonomyDefault(row.autonomy_default),
    final_tests_default: normalizeFinalTestsDefault(row.final_tests_default),
    adaptive_planning: Number(row.adaptive_planning ?? 0) === 1,
    planner_default_effort: row.planner_default_effort == null ? 'med' : String(row.planner_default_effort),
    planning_panel_size: Math.max(1, Number(row.planning_panel_size ?? 2) || 2),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

function requireText(v: string | undefined, name: string): string {
  if (!v || typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}

export class ProjectService {
  constructor(private readonly db: DatabaseService) {}

  listProjects(): Project[] {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY created_at DESC').all() as any[];
    return rows.map(rowToProject);
  }

  getProject(id: number): Project | null {
    const row = this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as any;
    return row ? rowToProject(row) : null;
  }

  createProject(input: { name: string; directory: string; plancore_session?: string | null; primary_driver_agent_id?: number | null }): Project {
    const name = requireText(input.name, 'name');
    const directory = requireText(input.directory, 'directory');
    let plancore_session = input.plancore_session ? input.plancore_session.trim() : null;
    const primary_driver_agent_id = input.primary_driver_agent_id ?? null;
    if (primary_driver_agent_id != null) {
      const agent = this.db.prepare('SELECT 1 FROM agents WHERE id = ?').get(primary_driver_agent_id);
      if (!agent) throw new Error('unknown primary driver agent');
    }
    if (!plancore_session) {
      const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      plancore_session = `helm-plancore-${slug}`;
    }
    try {
      // A project seeded with ibrain alone came up unusable in the UI, and neither symptom named its
      // cause: with no project_master_models row the Command Center chat/terminal 400 ("project not
      // set up (no master chain)") while runs stay ungated, and with no role_bindings every agent's
      // `role` is null, which silently hides the role-specific override editors (the planner row
      // renders a deliberation/red-team stub instead of the Planner Panel). Seed the full surface in
      // the same transaction — a created project is always usable — and let the operator delete the
      // agents they don't want (JROM 2026-07-26).
      assertMasterWriteAllowed(DEFAULT_MASTER_PROVIDER, DEFAULT_MASTER_MODEL);
      const create = this.db.raw.transaction(() => {
        const row = this.db.prepare(
          `INSERT INTO projects (name, directory, plancore_session, primary_driver_agent_id) VALUES (?,?,?,?) RETURNING *`
        ).get(name, directory, plancore_session, primary_driver_agent_id) as any;
        const pid = Number(row.id);
        // Roster: the same candidate set ProjectAgentService.addAllAgents uses, and for the same
        // reasons — skip in_development agents (D5/R-02E; e.g. the retired panelist) and never put a
        // house/helm-kind agent on a project roster (B07b/R2.7). Divergence here would seed agents
        // the "add all" button itself refuses to add.
        this.db.prepare(
          `INSERT OR IGNORE INTO project_agents (project_id, agent_id)
           SELECT ?, id FROM agents
           WHERE (in_development = 0 OR in_development IS NULL)
             AND lower(coalesce(agent_type, 'project')) NOT IN ('house', 'helm')`
        ).run(pid);
        // Role bindings from role_defaults — the house's own declaration of which agent fills which
        // role. Same candidate filter, so a binding can never point at an agent absent from the roster.
        this.db.prepare(
          `INSERT OR IGNORE INTO role_bindings (project_id, role, agent_id)
           SELECT ?, rd.role, rd.agent_id FROM role_defaults rd
           WHERE EXISTS (
             SELECT 1 FROM agents a
             WHERE a.id = rd.agent_id
               AND (a.in_development = 0 OR a.in_development IS NULL)
               AND lower(coalesce(a.agent_type, 'project')) NOT IN ('house', 'helm')
           )`
        ).run(pid);
        this.db.prepare(
          `INSERT INTO project_master_models (project_id, position, provider, model) VALUES (?, 0, ?, ?)`
        ).run(pid, DEFAULT_MASTER_PROVIDER, DEFAULT_MASTER_MODEL);
        return row;
      });
      const row = create();
      return rowToProject(row);
    } catch (e: any) {
      if (String(e.message || e).includes('UNIQUE') || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error(`project name must be unique: ${name}`);
      }
      throw e;
    }
  }

  deleteProject(id: number): void {
    const existing = this.getProject(id);
    if (!existing) throw new Error('unknown project');
    // B19-fix1: intentional cascade (projects -> cycles -> cycle_topology_freezes) — asserted via
    // the allow-flag so the freeze table's immutability trigger doesn't block it.
    this.db.withCascadeDeleteAllowed(() => {
      // These three carry a project_id but NO foreign key to projects, so DELETE FROM projects does
      // not reach them (unlike project_agents/cycles/runs, which cascade). role_team_bindings was
      // already swept here for that reason; role_bindings and project_master_models now must be too,
      // because createProject seeds them for every project. A leaked role_bindings row is not
      // cosmetic: AgentAssignmentService.deleteAgent counts them, so an orphan from a deleted project
      // blocks that agent's deletion forever, citing a project id that no longer exists.
      this.db.prepare('DELETE FROM role_team_bindings WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM role_bindings WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM project_master_models WHERE project_id = ?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    });
  }

  getAutonomyDefault(id: number): AutonomyDefault {
    const project = this.getProject(id);
    if (!project) throw new Error('unknown project');
    return project.autonomy_default;
  }

  setAutonomyDefault(id: number, value: unknown): AutonomyDefault {
    if (!this.getProject(id)) throw new Error('unknown project');
    const autonomy_default = normalizeAutonomyDefault(value);
    this.db.prepare(`UPDATE projects SET autonomy_default = ?, updated_at = datetime('now') WHERE id = ?`).run(autonomy_default, id);
    return autonomy_default;
  }
}
