/**
 * S05 — Authoritative co-planner staffing resolver (pure over DB + panel config).
 *
 * Resolves plancore separately (phase brain `plancore`) and co-planners exclusively from
 * `project_planner_panel`. Never consults the generic `planner` role binding for configured
 * seats. Works on the core path regardless of `adaptive_planning`.
 *
 * ACs: 19–22, 24 (manifest digest for confirmation binding).
 */
import { createHash } from 'node:crypto';
import type { DatabaseService } from '../db/database.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { PhaseStaffingService } from './phase-staffing.js';
import {
  DEFAULT_PLANNER_EFFORT,
  PlannerPanelService,
  type PlannerEffort,
  type PlannerPanelConfig,
} from './planner-panel-service.js';

export type StaffingSeatSource = 'primary' | `backup for slot ${number}` | 'phase-owner';

export interface StaffingSeat {
  /** 0-based co-planner slot; null for plancore. */
  slot: number | null;
  role: 'plancore' | 'co-planner';
  provider: string;
  model: string;
  modelRowId: number | null;
  effort: PlannerEffort | string;
  source: StaffingSeatSource;
  ready: boolean;
  blockReason: string | null;
}

export interface PlanningStaffingManifest {
  projectId: number;
  adaptivePlanning: boolean;
  /** N co-planners excluding plancore (projects.planning_panel_size when consistent). */
  planningPanelSize: number;
  panelMemberCount: number;
  plancore: StaffingSeat;
  coPlanners: StaffingSeat[];
  /** True when any required seat is not ready or config is empty/mismatched. */
  blocked: boolean;
  blockReasons: string[];
  /** Stable digest over ordered seat identities + readiness (AC24). */
  digest: string;
}

export type UnavailableInput =
  | Set<string>
  | ((provider: string, model: string) => boolean);

function modelKey(provider: string, model: string): string {
  return `${provider}/${model}`;
}

function isDown(unavailable: UnavailableInput | undefined, provider: string, model: string): boolean {
  if (!unavailable) return false;
  if (typeof unavailable === 'function') return unavailable(provider, model);
  return unavailable.has(modelKey(provider, model));
}

function normalizeEffortValue(value: unknown, fallback: PlannerEffort = DEFAULT_PLANNER_EFFORT): PlannerEffort {
  if (value == null || value === '') return fallback;
  const v = String(value).toLowerCase().trim();
  const alias = v === 'medium' ? 'med' : v;
  if (alias === 'low' || alias === 'med' || alias === 'high' || alias === 'xhigh') return alias;
  return fallback;
}

/** Canonical digest payload — order-stable, no timestamps. */
export function buildManifestDigestPayload(manifest: {
  plancore: Pick<StaffingSeat, 'provider' | 'model' | 'effort' | 'source' | 'ready'>;
  coPlanners: Array<Pick<StaffingSeat, 'slot' | 'provider' | 'model' | 'effort' | 'source' | 'ready'>>;
}): string {
  return JSON.stringify({
    plancore: {
      provider: manifest.plancore.provider,
      model: manifest.plancore.model,
      effort: manifest.plancore.effort,
      source: manifest.plancore.source,
      ready: manifest.plancore.ready,
    },
    coPlanners: manifest.coPlanners.map((s) => ({
      slot: s.slot,
      provider: s.provider,
      model: s.model,
      effort: s.effort,
      source: s.source,
      ready: s.ready,
    })),
  });
}

export function computeManifestDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export class PlanningStaffingMismatchError extends Error {
  constructor(
    public readonly projectId: number,
    public readonly panelMemberCount: number,
    public readonly planningPanelSize: number
  ) {
    super(
      `planning_panel_size mismatch: panel has ${panelMemberCount} co-planner(s) but planning_panel_size=${planningPanelSize} (typed block; will not truncate or invent seats)`
    );
    this.name = 'PlanningStaffingMismatchError';
  }
}

export class PlanningStaffingEmptyError extends Error {
  constructor(public readonly projectId: number) {
    super(
      'planning panel is empty: configure co-planners in Agent Studio (typed block; no generic planner substitute)'
    );
    this.name = 'PlanningStaffingEmptyError';
  }
}

export class PlanningStaffingService {
  private readonly panel: PlannerPanelService;
  private readonly phaseStaffing: PhaseStaffingService;

  constructor(
    private readonly db: DatabaseService,
    assignments: AgentAssignmentService,
    panel?: PlannerPanelService
  ) {
    this.panel = panel ?? new PlannerPanelService(db);
    this.phaseStaffing = new PhaseStaffingService(assignments);
  }

  /**
   * Resolve the full Planning seat manifest for a project.
   * Pure over current DB + optional availability set — no spawns, no writes.
   *
   * @throws PlanningStaffingEmptyError when panel has zero members
   * @throws PlanningStaffingMismatchError when members.length !== planning_panel_size
   * @throws when plancore phase brain is unavailable
   */
  resolveManifest(
    projectId: number,
    opts?: { unavailable?: UnavailableInput; throwOnMismatch?: boolean; throwOnEmpty?: boolean }
  ): PlanningStaffingManifest {
    const throwOnMismatch = opts?.throwOnMismatch !== false;
    const throwOnEmpty = opts?.throwOnEmpty !== false;

    const proj = this.db.prepare(
      'SELECT adaptive_planning, planning_panel_size FROM projects WHERE id = ?'
    ).get(projectId) as
      | { adaptive_planning: number; planning_panel_size: number }
      | undefined;
    if (!proj) throw new Error(`unknown project: ${projectId}`);

    const adaptivePlanning = Number(proj.adaptive_planning || 0) === 1;
    const planningPanelSize = Math.max(1, Math.trunc(Number(proj.planning_panel_size ?? 2)));

    // Plancore: phase brain only — never generic planner worker binding.
    const phase = this.phaseStaffing.resolvePhaseAgents(projectId, 'planning');
    const brain = phase.brain;
    if (!brain) {
      throw new Error('required brain unavailable for phase planning: plancore');
    }
    const plancore: StaffingSeat = {
      slot: null,
      role: 'plancore',
      provider: String(brain.agent.provider || ''),
      model: String(brain.agent.model || ''),
      modelRowId: null,
      effort: normalizeEffortValue(brain.agent.default_effort),
      source: 'phase-owner',
      ready: !isDown(opts?.unavailable, String(brain.agent.provider || ''), String(brain.agent.model || '')),
      blockReason: null,
    };
    if (!plancore.ready) {
      plancore.blockReason = `plancore unavailable: ${plancore.provider}/${plancore.model}`;
    }

    let config: PlannerPanelConfig;
    try {
      config = this.panel.getConfig(projectId);
    } catch (e: any) {
      throw e;
    }

    const panelMemberCount = config.members.length;
    const blockReasons: string[] = [];

    if (panelMemberCount === 0) {
      if (throwOnEmpty) throw new PlanningStaffingEmptyError(projectId);
      blockReasons.push('planning panel is empty: configure co-planners in Agent Studio');
    } else if (panelMemberCount !== planningPanelSize) {
      if (throwOnMismatch) {
        throw new PlanningStaffingMismatchError(projectId, panelMemberCount, planningPanelSize);
      }
      blockReasons.push(
        `planning_panel_size mismatch: panel has ${panelMemberCount} co-planner(s) but planning_panel_size=${planningPanelSize}`
      );
    }

    const defaultEffort = config.default_effort;
    const backups = config.backups.map((b) => {
      if (!b.model) throw new Error(`panel backup model_id ${b.model_id} missing from models table`);
      return {
        provider: b.model.provider,
        model: b.model.model_id || b.model.name,
        modelRowId: b.model.id,
      };
    });

    const used = new Set<string>();
    const coPlanners: StaffingSeat[] = [];

    for (let i = 0; i < config.members.length; i++) {
      const m = config.members[i];
      if (!m.model) throw new Error(`panel member model_id ${m.model_id} missing from models table`);
      const provider = m.model.provider;
      const model = m.model.model_id || m.model.name;
      const effort = m.effort ?? defaultEffort;
      const primaryKey = modelKey(provider, model);
      const primaryDown = isDown(opts?.unavailable, provider, model);

      if (!primaryDown && !used.has(primaryKey)) {
        used.add(primaryKey);
        coPlanners.push({
          slot: i,
          role: 'co-planner',
          provider,
          model,
          modelRowId: m.model.id,
          effort,
          source: 'primary',
          ready: true,
          blockReason: null,
        });
        continue;
      }

      // Walk ordered backups for first available not already used (AC22).
      let picked: StaffingSeat | null = null;
      for (const b of backups) {
        const bk = modelKey(b.provider, b.model);
        if (used.has(bk)) continue;
        if (isDown(opts?.unavailable, b.provider, b.model)) continue;
        used.add(bk);
        picked = {
          slot: i,
          role: 'co-planner',
          provider: b.provider,
          model: b.model,
          modelRowId: b.modelRowId,
          effort,
          source: `backup for slot ${i}`,
          ready: true,
          blockReason: null,
        };
        break;
      }

      if (picked) {
        coPlanners.push(picked);
        continue;
      }

      // No configured candidate — block the slot; do not invent unconfigured models.
      const reason = primaryDown
        ? `slot ${i}: primary ${provider}/${model} unavailable and no configured backup is available`
        : `slot ${i}: primary ${provider}/${model} already used and no configured backup is available`;
      blockReasons.push(reason);
      coPlanners.push({
        slot: i,
        role: 'co-planner',
        provider,
        model,
        modelRowId: m.model.id,
        effort,
        source: 'primary',
        ready: false,
        blockReason: reason,
      });
    }

    if (!plancore.ready && plancore.blockReason) {
      blockReasons.push(plancore.blockReason);
    }

    const blocked =
      blockReasons.length > 0 ||
      !plancore.ready ||
      coPlanners.some((s) => !s.ready) ||
      panelMemberCount === 0;

    const digest = computeManifestDigest(
      buildManifestDigestPayload({ plancore, coPlanners })
    );

    return {
      projectId,
      adaptivePlanning,
      planningPanelSize,
      panelMemberCount,
      plancore,
      coPlanners,
      blocked,
      blockReasons,
      digest,
    };
  }
}
