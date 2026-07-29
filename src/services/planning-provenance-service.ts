/**
 * S13 — Durable Planning agreement provenance + Start Implementation gate.
 *
 * On successful whole-plan agreement, atomically records:
 *   planning_run_id + confirmed manifest_digest + plan.md SHA-256
 * per cycle. Start Implementation requires that record and byte-matching
 * plan/manifest. Failed/BROKEN/round-cap paths must never write success.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { DatabaseService } from '../db/database.js';
import { CANONICAL_CYCLE_ARTIFACTS } from './cycle-artifact-paths.js';
import type { CycleService } from './cycle-service.js';
import { DiscoveryHandoffService } from './discovery-handoff-service.js';
import { PlanningStaffingService } from './planning-staffing-service.js';
import type { AgentAssignmentService } from './agent-assignment-service.js';
import type { PlannerPanelService } from './planner-panel-service.js';

export const PLANNING_REQUIRED_CODE = 'PLANNING_REQUIRED' as const;
export const PLANNING_REQUIRED_MESSAGE =
  'Helm Planning must complete first: Start Implementation requires a successful cycle-linked Planning agreement with an unchanged plan.md and seat manifest.';

export type ProvenanceFailCode =
  | typeof PLANNING_REQUIRED_CODE
  | 'PLAN_CHANGED'
  | 'MANIFEST_CHANGED'
  | 'MISSING_PLAN'
  | 'MISMATCH_RUN';

export interface PlanningProvenanceRow {
  id: number;
  project_id: number;
  cycle_id: number;
  planning_run_id: number;
  manifest_digest: string;
  plan_sha256: string;
  agreed_at: string;
  created_at: string;
  updated_at: string;
}

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

export class PlanningProvenanceService {
  constructor(private readonly db: DatabaseService) {}

  getByCycle(cycleId: number): PlanningProvenanceRow | null {
    const row = this.db
      .prepare('SELECT * FROM planning_provenance WHERE cycle_id = ?')
      .get(cycleId) as PlanningProvenanceRow | undefined;
    return row ?? null;
  }

  /**
   * Atomically upsert success provenance for a cycle (one row per cycle).
   * Only call on whole-plan agreement — never on failed/BROKEN/round-cap.
   */
  recordSuccess(input: {
    projectId: number;
    cycleId: number;
    planningRunId: number;
    manifestDigest: string;
    planSha256: string;
  }): PlanningProvenanceRow {
    const projectId = Number(input.projectId);
    const cycleId = Number(input.cycleId);
    const planningRunId = Number(input.planningRunId);
    const digest = String(input.manifestDigest || '').trim();
    const planSha = String(input.planSha256 || '').trim();
    if (!Number.isFinite(projectId) || !Number.isFinite(cycleId) || !Number.isFinite(planningRunId)) {
      throw new Error('recordSuccess: invalid project/cycle/run id');
    }
    if (!digest || !planSha) {
      throw new Error('recordSuccess: manifest digest and plan sha required');
    }

    const txn = this.db.raw.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO planning_provenance (
             project_id, cycle_id, planning_run_id, manifest_digest, plan_sha256,
             agreed_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT(cycle_id) DO UPDATE SET
             project_id = excluded.project_id,
             planning_run_id = excluded.planning_run_id,
             manifest_digest = excluded.manifest_digest,
             plan_sha256 = excluded.plan_sha256,
             agreed_at = datetime('now'),
             updated_at = datetime('now')`
        )
        .run(projectId, cycleId, planningRunId, digest, planSha);
      return this.getByCycle(cycleId);
    });
    const row = txn();
    if (!row) throw new Error('recordSuccess: failed to load provenance row');
    return row;
  }

  /** Test/helper: never used on production failure paths. */
  clearCycle(cycleId: number): number {
    const info = this.db
      .prepare('DELETE FROM planning_provenance WHERE cycle_id = ?')
      .run(cycleId);
    return Number(info.changes || 0);
  }
}

/**
 * After agreed planning: hash plan.md, resolve confirmed digest, write provenance.
 * No-op when cycleId missing or plan unreadable — caller only invokes on agreed:true.
 */
export async function recordProvenanceAfterAgreement(opts: {
  db: DatabaseService;
  cycleService: CycleService;
  projectId: number;
  cycleId: number | null | undefined;
  planningRunId: number;
  /** Optional explicit plan path (canonical cycle plan.md preferred). */
  planMdPath?: string | null;
  assignments?: AgentAssignmentService;
  plannerPanel?: PlannerPanelService;
}): Promise<PlanningProvenanceRow | null> {
  const cycleId =
    opts.cycleId != null && Number.isFinite(Number(opts.cycleId))
      ? Number(opts.cycleId)
      : null;
  if (cycleId == null) return null;

  let planPath =
    opts.planMdPath && String(opts.planMdPath).trim()
      ? String(opts.planMdPath)
      : '';
  if (!planPath && opts.cycleService?.getCycleDocDir) {
    planPath = path.join(
      opts.cycleService.getCycleDocDir(cycleId),
      CANONICAL_CYCLE_ARTIFACTS.plan
    );
  }
  if (!planPath) return null;

  let planBytes: string;
  try {
    planBytes = await fs.readFile(planPath, 'utf8');
  } catch {
    return null;
  }
  if (!planBytes.trim()) return null;
  const planSha256 = sha256Hex(planBytes);

  // Prefer frozen handoff digest (confirmed seats); else live S05 resolve.
  let manifestDigest = '';
  try {
    const handoffs = new DiscoveryHandoffService(opts.db);
    const rows = handoffs.listByCycle(cycleId);
    // Prefer started handoff with digest, then any with digest
    const started = [...rows].reverse().find((r) => r.state === 'started' && r.manifest_digest);
    const any = [...rows].reverse().find((r) => r.manifest_digest);
    manifestDigest = String((started || any)?.manifest_digest || '').trim();
  } catch {
    /* fall through to live */
  }
  if (!manifestDigest && opts.assignments) {
    try {
      const staffing = new PlanningStaffingService(
        opts.db,
        opts.assignments,
        opts.plannerPanel
      );
      const live = staffing.resolveManifest(opts.projectId, {
        throwOnEmpty: false,
        throwOnMismatch: false,
      });
      manifestDigest = live.digest;
    } catch {
      return null;
    }
  }
  if (!manifestDigest) return null;

  const svc = new PlanningProvenanceService(opts.db);
  return svc.recordSuccess({
    projectId: opts.projectId,
    cycleId,
    planningRunId: opts.planningRunId,
    manifestDigest,
    planSha256,
  });
}

export type ProvenanceGateResult =
  | { ok: true; provenance: PlanningProvenanceRow }
  | { ok: false; code: ProvenanceFailCode; message: string };

/**
 * Start Implementation gate (AC27–28): require cycle-linked success + matching plan/manifest bytes.
 */
export async function assertPlanningProvenanceForImplementation(opts: {
  db: DatabaseService;
  cycleService: CycleService;
  projectId: number;
  cycleId: number;
  assignments?: AgentAssignmentService;
  plannerPanel?: PlannerPanelService;
}): Promise<ProvenanceGateResult> {
  const svc = new PlanningProvenanceService(opts.db);
  const prov = svc.getByCycle(opts.cycleId);
  if (!prov) {
    return {
      ok: false,
      code: PLANNING_REQUIRED_CODE,
      message: PLANNING_REQUIRED_MESSAGE,
    };
  }

  // Plan bytes must still match
  const planPath = path.join(
    opts.cycleService.getCycleDocDir(opts.cycleId),
    CANONICAL_CYCLE_ARTIFACTS.plan
  );
  let planBytes: string;
  try {
    planBytes = await fs.readFile(planPath, 'utf8');
  } catch {
    return {
      ok: false,
      code: 'MISSING_PLAN',
      message:
        'plan.md is missing or unreadable; Helm Planning must complete again before Start Implementation.',
    };
  }
  const currentSha = sha256Hex(planBytes);
  if (currentSha !== prov.plan_sha256) {
    return {
      ok: false,
      code: 'PLAN_CHANGED',
      message:
        'plan.md changed after Planning agreement; Helm Planning must complete again before Start Implementation.',
    };
  }

  // Manifest digest must still match live (or frozen handoff still bound)
  let liveDigest = '';
  try {
    const handoffs = new DiscoveryHandoffService(opts.db);
    const rows = handoffs.listByCycle(opts.cycleId);
    const started = [...rows].reverse().find((r) => r.state === 'started' && r.manifest_digest);
    if (started?.manifest_digest) liveDigest = String(started.manifest_digest);
  } catch {
    /* use staffing */
  }
  if (!liveDigest && opts.assignments) {
    try {
      const staffing = new PlanningStaffingService(
        opts.db,
        opts.assignments,
        opts.plannerPanel
      );
      liveDigest = staffing.resolveManifest(opts.projectId, {
        throwOnEmpty: false,
        throwOnMismatch: false,
      }).digest;
    } catch {
      liveDigest = '';
    }
  }
  if (liveDigest && liveDigest !== prov.manifest_digest) {
    return {
      ok: false,
      code: 'MANIFEST_CHANGED',
      message:
        'Planning seat manifest changed after agreement; Helm Planning must complete again before Start Implementation.',
    };
  }

  // Run still cycle-linked
  try {
    const run: any = opts.db
      .prepare('SELECT id, cycle_id FROM runs WHERE id = ?')
      .get(prov.planning_run_id);
    if (!run || Number(run.cycle_id) !== Number(opts.cycleId)) {
      return {
        ok: false,
        code: 'MISMATCH_RUN',
        message: PLANNING_REQUIRED_MESSAGE,
      };
    }
  } catch {
    return {
      ok: false,
      code: PLANNING_REQUIRED_CODE,
      message: PLANNING_REQUIRED_MESSAGE,
    };
  }

  return { ok: true, provenance: prov };
}
