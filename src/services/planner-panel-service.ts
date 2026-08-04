// Per-project adaptive planner panel configuration (v93).
// Storage: project_planner_panel rows (members + backups) + projects.planner_default_effort.
// Consumed by run-orchestrator when adaptive_planning is ON → AdaptivePlanningInputs.panel.

import type { DatabaseService } from '../db/database.js';
import type { PlannerPanel } from './adaptive-planning-phase.js';

export const PLANNER_EFFORTS = ['low', 'med', 'high', 'xhigh'] as const;
export type PlannerEffort = (typeof PLANNER_EFFORTS)[number];
export const DEFAULT_PLANNER_EFFORT: PlannerEffort = 'med';

export interface ModelStub {
  id: number;
  name: string;
  provider: string;
  model_id: string;
  slug: string | null;
  display_name: string | null;
}

export interface PanelMemberDTO {
  model_id: number;
  model: ModelStub | null;
  is_lead: boolean;
  effort: PlannerEffort | null;
  slot_index: number;
}

export interface PanelBackupDTO {
  model_id: number;
  model: ModelStub | null;
  slot_index: number;
}

export interface PlannerPanelConfig {
  members: PanelMemberDTO[];
  backups: PanelBackupDTO[];
  default_effort: PlannerEffort;
}

export interface PanelMemberInput {
  model_id: number;
  is_lead?: boolean;
  effort?: string | null;
}

export interface PanelBackupInput {
  model_id: number;
}

export interface ReplacePlannerPanelInput {
  members: PanelMemberInput[];
  backups?: PanelBackupInput[];
  default_effort?: string | null;
}

export interface ResolvedPanelSeat {
  model: string;
  provider: string;
  modelRowId: number;
  effort: PlannerEffort;
  fromBackup: boolean;
  sourceSlot: number;
}

function normalizeEffort(value: unknown, fallback: PlannerEffort = DEFAULT_PLANNER_EFFORT): PlannerEffort {
  if (value == null || value === '') return fallback;
  const v = String(value).toLowerCase().trim();
  // Accept common aliases from the agent-override UI ("medium").
  const alias = v === 'medium' ? 'med' : v;
  if ((PLANNER_EFFORTS as readonly string[]).includes(alias)) return alias as PlannerEffort;
  throw new Error(`invalid effort: ${value} (expected low|med|high|xhigh)`);
}

function optionalEffort(value: unknown): PlannerEffort | null {
  if (value == null || value === '') return null;
  return normalizeEffort(value);
}

function modelStubFromRow(r: any): ModelStub | null {
  if (r == null || r.m_id == null) return null;
  return {
    id: Number(r.m_id),
    name: String(r.m_name ?? ''),
    provider: String(r.m_provider ?? ''),
    model_id: String(r.m_model_id ?? r.m_name ?? ''),
    slug: r.m_slug == null ? null : String(r.m_slug),
    display_name: r.m_display_name == null ? null : String(r.m_display_name),
  };
}

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

/**
 * Given ordered panel members + ordered backups, pick an available model for each member
 * slot. When a member's CLI is unavailable, walk the backup list (skipping models already
 * taken by earlier slots) and substitute the first available backup.
 *
 * Pure / sync — callers supply the availability set (e.g. from seat-binary preflight).
 * `unavailable` keys are "provider/model_id" (the CLI model id, not the DB row id).
 */
export function applyBackupFallback(
  members: Array<{ provider: string; model: string; modelRowId: number; effort: PlannerEffort }>,
  backups: Array<{ provider: string; model: string; modelRowId: number }>,
  unavailable: Set<string> | ((provider: string, model: string) => boolean) = new Set(),
): ResolvedPanelSeat[] {
  const isDown = typeof unavailable === 'function'
    ? unavailable
    : (provider: string, model: string) => unavailable.has(modelKey(provider, model));

  const used = new Set<string>();
  const result: ResolvedPanelSeat[] = [];

  for (let i = 0; i < members.length; i++) {
    const m = members[i];
    const primaryKey = modelKey(m.provider, m.model);
    if (!isDown(m.provider, m.model) && !used.has(primaryKey)) {
      used.add(primaryKey);
      result.push({
        model: m.model,
        provider: m.provider,
        modelRowId: m.modelRowId,
        effort: m.effort,
        fromBackup: false,
        sourceSlot: i,
      });
      continue;
    }
    // Walk backups for the first available not already used.
    let picked: ResolvedPanelSeat | null = null;
    for (const b of backups) {
      const bk = modelKey(b.provider, b.model);
      if (used.has(bk)) continue;
      if (isDown(b.provider, b.model)) continue;
      used.add(bk);
      picked = {
        model: b.model,
        provider: b.provider,
        modelRowId: b.modelRowId,
        effort: m.effort,
        fromBackup: true,
        sourceSlot: i,
      };
      break;
    }
    if (picked) {
      result.push(picked);
    } else {
      // No backup available — keep the original (spawn may still fail later; surface honesty).
      used.add(primaryKey);
      result.push({
        model: m.model,
        provider: m.provider,
        modelRowId: m.modelRowId,
        effort: m.effort,
        fromBackup: false,
        sourceSlot: i,
      });
    }
  }
  return result;
}

/**
 * Build the adaptive-planning PlannerPanel shape from a resolved seat list (post backup fallback).
 * Lead = first seat marked lead in original config, or seat 0 after resolution order.
 */
export function buildAdaptivePlannerPanel(
  seats: ResolvedPanelSeat[],
  opts?: { leadIndex?: number },
): PlannerPanel {
  const leadIndex = opts?.leadIndex ?? 0;
  const lead = seats[leadIndex] || seats[0];
  return {
    size: Math.max(1, seats.length),
    leadModel: lead?.model,
    leadProvider: lead?.provider,
    memberModels: seats.map((s) => s.model),
    memberProviders: seats.map((s) => s.provider),
    memberEfforts: seats.map((s) => s.effort),
    backups: [], // already applied; adaptive phase may still carry raw backups via inputs
    defaultEffort: lead?.effort || DEFAULT_PLANNER_EFFORT,
  };
}

export class PlannerPanelService {
  constructor(private readonly db: DatabaseService) {}

  getConfig(projectId: number): PlannerPanelConfig {
    const proj = this.db.prepare('SELECT planner_default_effort FROM projects WHERE id = ?').get(projectId) as
      | { planner_default_effort: string | null }
      | undefined;
    if (!proj) throw new Error('unknown project');

    const default_effort = normalizeEffort(proj.planner_default_effort ?? DEFAULT_PLANNER_EFFORT);

    const rows = this.db.prepare(`
      SELECT
        ppp.slot_index, ppp.role, ppp.model_id, ppp.is_lead, ppp.effort,
        m.id AS m_id, m.name AS m_name, m.provider AS m_provider, m.model_id AS m_model_id,
        m.slug AS m_slug, m.display_name AS m_display_name
      FROM project_planner_panel ppp
      LEFT JOIN models m ON m.id = ppp.model_id
      WHERE ppp.project_id = ?
      ORDER BY ppp.role ASC, ppp.slot_index ASC
    `).all(projectId) as any[];

    const members: PanelMemberDTO[] = [];
    const backups: PanelBackupDTO[] = [];
    for (const r of rows) {
      if (r.role === 'member') {
        members.push({
          model_id: Number(r.model_id),
          model: modelStubFromRow(r),
          is_lead: Number(r.is_lead) === 1,
          effort: r.effort == null ? null : normalizeEffort(r.effort),
          slot_index: Number(r.slot_index),
        });
      } else if (r.role === 'backup') {
        backups.push({
          model_id: Number(r.model_id),
          model: modelStubFromRow(r),
          slot_index: Number(r.slot_index),
        });
      }
    }
    members.sort((a, b) => a.slot_index - b.slot_index);
    backups.sort((a, b) => a.slot_index - b.slot_index);
    return { members, backups, default_effort };
  }

  /**
   * Atomically replace the entire panel config for a project.
   * Validates: ≥1 member, exactly one lead, all model_ids exist.
   */
  replaceConfig(projectId: number, input: ReplacePlannerPanelInput): PlannerPanelConfig {
    const proj = this.db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
    if (!proj) throw new Error('unknown project');

    const members = Array.isArray(input.members) ? input.members : [];
    const backups = Array.isArray(input.backups) ? input.backups : [];
    if (members.length < 1) throw new Error('at least one panel member is required');

    const leadCount = members.filter((m) => !!m.is_lead).length;
    if (leadCount !== 1) throw new Error('exactly one panel member must be lead (is_lead)');

    const default_effort = normalizeEffort(input.default_effort ?? DEFAULT_PLANNER_EFFORT);

    for (const m of members) {
      if (m.model_id == null || !Number.isFinite(Number(m.model_id))) {
        throw new Error('each member requires a valid model_id');
      }
      this.requireModel(Number(m.model_id));
      if (m.effort != null && m.effort !== '') optionalEffort(m.effort); // validate
    }
    for (const b of backups) {
      if (b.model_id == null || !Number.isFinite(Number(b.model_id))) {
        throw new Error('each backup requires a valid model_id');
      }
      this.requireModel(Number(b.model_id));
    }

    // S05 / AC20: planning_panel_size = N co-planners (member count), excluding plancore.
    // Mirror member count in the same transaction as the panel rows — never drift silently.
    const panelSize = members.length;

    this.db.raw.transaction(() => {
      this.db.prepare('DELETE FROM project_planner_panel WHERE project_id = ?').run(projectId);
      this.db.prepare(
        `UPDATE projects SET planner_default_effort = ?, planning_panel_size = ?, updated_at = datetime('now') WHERE id = ?`
      ).run(default_effort, panelSize, projectId);

      const ins = this.db.prepare(`
        INSERT INTO project_planner_panel (project_id, slot_index, role, model_id, is_lead, effort)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      members.forEach((m, i) => {
        const effort = m.effort == null || m.effort === '' ? null : normalizeEffort(m.effort);
        ins.run(projectId, i, 'member', Number(m.model_id), m.is_lead ? 1 : 0, effort);
      });
      backups.forEach((b, i) => {
        ins.run(projectId, i, 'backup', Number(b.model_id), 0, null);
      });
    })();

    return this.getConfig(projectId);
  }

  /**
   * Build a PlannerPanel for adaptive planning from stored config.
   * Returns null when the project has no members configured (caller keeps legacy defaults).
   *
   * When `unavailable` is provided, applies backup fallback for down members.
   */
  buildPlannerPanel(
    projectId: number,
    unavailable?: Set<string> | ((provider: string, model: string) => boolean),
  ): PlannerPanel | null {
    let config: PlannerPanelConfig;
    try {
      config = this.getConfig(projectId);
    } catch {
      return null;
    }
    if (!config.members.length) return null;

    const defaultEffort = config.default_effort;
    const memberSpecs = config.members.map((m) => {
      if (!m.model) throw new Error(`panel member model_id ${m.model_id} missing from models table`);
      return {
        provider: m.model.provider,
        model: m.model.model_id || m.model.name,
        modelRowId: m.model.id,
        effort: m.effort ?? defaultEffort,
      };
    });
    const backupSpecs = config.backups.map((b) => {
      if (!b.model) throw new Error(`panel backup model_id ${b.model_id} missing from models table`);
      return {
        provider: b.model.provider,
        model: b.model.model_id || b.model.name,
        modelRowId: b.model.id,
      };
    });

    const seats = applyBackupFallback(memberSpecs, backupSpecs, unavailable ?? new Set());
    const leadIndex = Math.max(0, config.members.findIndex((m) => m.is_lead));
    // After fallback, seats stay in the same member order; lead index still maps.
    const panel = buildAdaptivePlannerPanel(seats, { leadIndex: leadIndex >= 0 ? leadIndex : 0 });
    panel.backups = backupSpecs.map((b) => ({ model: b.model, provider: b.provider }));
    panel.defaultEffort = defaultEffort;
    return panel;
  }

  private requireModel(modelId: number): void {
    const row = this.db.prepare('SELECT id FROM models WHERE id = ?').get(modelId);
    if (!row) throw new Error(`unknown model_id: ${modelId}`);
  }
}
