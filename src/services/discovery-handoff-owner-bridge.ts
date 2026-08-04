/**
 * S11 — Owner confirm/decline bridge for Discovery→Planning handoffs.
 *
 * Revalidates docs/phase/no-active-run/manifest digest, CAS pending→starting,
 * calls S10 once (fire-and-forget after durable run row), persists started/run id
 * or typed failure. Returns after durable run creation — not model startup.
 */
import path from 'node:path';
import type { DatabaseService } from '../db/database.js';
import type { AgentAssignmentService } from './agent-assignment-service.js';
import type { CycleService } from './cycle-service.js';
import type { PlannerPanelService } from './planner-panel-service.js';
import type { RunArtifactService } from './run-artifact-service.js';
import {
  DiscoveryHandoffService,
  type DiscoveryHandoffRow,
} from './discovery-handoff-service.js';
import { validateDiscoveryDocs } from './discovery-handoff-ingress.js';
import {
  PlanningStaffingService,
  buildManifestDigestPayload,
  computeManifestDigest,
  type PlanningStaffingManifest,
} from './planning-staffing-service.js';
import { isDiscoveryPhase } from './discovery-contract.js';
import { CANONICAL_CYCLE_ARTIFACTS } from './cycle-artifact-paths.js';
import {
  ConfirmedHandoffPlanningError,
  type RunOrchestratorService,
} from './run-orchestrator-service.js';

export type OwnerBridgeErrorCode =
  | 'NOT_FOUND'
  | 'BAD_STATE'
  | 'MISMATCH'
  | 'MISSING_DOCS'
  | 'ACTIVE_RUN'
  | 'NO_HANDOFF'
  | 'CAS_LOST'
  | 'STAFFING'
  | 'INTERNAL';

export interface OwnerConfirmInput {
  cycleId: number;
  expectedDigest?: string | null;
  handoffId?: number | null;
  batchId?: string;
}

export interface OwnerDeclineInput {
  cycleId: number;
  handoffId?: number | null;
  reason?: string | null;
}

export interface OwnerConfirmOk {
  ok: true;
  handoffId: number;
  runId: number;
  state: 'starting' | 'started';
  digest: string;
  /** True when this call did not launch a new S10 (double/stale click). */
  already: boolean;
}

export interface OwnerConfirmErr {
  ok: false;
  code: OwnerBridgeErrorCode;
  reason: string;
  handoffId?: number;
}

export type OwnerConfirmResult = OwnerConfirmOk | OwnerConfirmErr;

export interface OwnerDeclineOk {
  ok: true;
  handoffId: number;
  state: 'declined';
}

export interface OwnerDeclineErr {
  ok: false;
  code: OwnerBridgeErrorCode;
  reason: string;
  handoffId?: number;
}

export type OwnerDeclineResult = OwnerDeclineOk | OwnerDeclineErr;

export interface OwnerBridgeDeps {
  db: DatabaseService;
  handoffs: DiscoveryHandoffService;
  cycleService: CycleService;
  artifacts: RunArtifactService;
  assignments: AgentAssignmentService;
  plannerPanel?: PlannerPanelService;
  orchestrator: Pick<RunOrchestratorService, 'startPlanningFromConfirmedHandoff'>;
  /**
   * When true (default), S10 runs detached after durable run create so HTTP can return 202
   * without waiting for model startup. Tests may set false to await S10 inline.
   */
  detachS10?: boolean;
}

function err(
  code: OwnerBridgeErrorCode,
  reason: string,
  handoffId?: number
): OwnerConfirmErr {
  return { ok: false, code, reason, handoffId };
}

function resolveHandoff(
  handoffs: DiscoveryHandoffService,
  cycleId: number,
  handoffId?: number | null
): DiscoveryHandoffRow | null {
  if (handoffId != null && Number.isFinite(Number(handoffId))) {
    const row = handoffs.getById(Number(handoffId));
    if (!row || Number(row.cycle_id) !== cycleId) return null;
    return row;
  }
  return handoffs.getLive(cycleId);
}

function recomputeFrozenDigest(manifestJson: string | null): string | null {
  try {
    const frozen = JSON.parse(String(manifestJson || '{}')) as Partial<PlanningStaffingManifest>;
    if (!frozen.plancore || !Array.isArray(frozen.coPlanners)) return null;
    return computeManifestDigest(
      buildManifestDigestPayload({
        plancore: frozen.plancore,
        coPlanners: frozen.coPlanners,
      })
    );
  } catch {
    return null;
  }
}

/**
 * Owner confirm: revalidate → CAS pending→starting → durable run → S10 once → 202-ready result.
 */
export async function confirmDiscoveryHandoff(
  input: OwnerConfirmInput,
  deps: OwnerBridgeDeps
): Promise<OwnerConfirmResult> {
  const cycleId = Number(input.cycleId);
  if (!Number.isFinite(cycleId)) {
    return err('NOT_FOUND', 'invalid cycle id');
  }

  const cycleRow: any = deps.db
    .prepare('SELECT id, project_id, phase, status FROM cycles WHERE id = ?')
    .get(cycleId);
  if (!cycleRow) {
    return err('NOT_FOUND', 'unknown cycle');
  }
  const projectId = Number(cycleRow.project_id);

  // Active-run guard (no second concurrent run for the cycle)
  try {
    const rs = deps.artifacts.getCycleRunState(cycleId);
    if (rs.hasRun && rs.runActive) {
      // Idempotent path: if the active run is the handoff's planning run, return it
      const live = resolveHandoff(deps.handoffs, cycleId, input.handoffId);
      if (
        live &&
        (live.state === 'starting' || live.state === 'started') &&
        live.planning_run_id != null &&
        Number(live.planning_run_id) === Number(rs.runId)
      ) {
        return {
          ok: true,
          handoffId: live.id,
          runId: Number(live.planning_run_id),
          state: live.state === 'started' ? 'started' : 'starting',
          digest: String(live.manifest_digest || ''),
          already: true,
        };
      }
      return err('ACTIVE_RUN', 'a run is already active for this cycle', live?.id);
    }
  } catch {
    /* fall through to handoff resolution */
  }

  let handoff = resolveHandoff(deps.handoffs, cycleId, input.handoffId);
  if (!handoff) {
    return err('NO_HANDOFF', 'no live discovery handoff for this cycle');
  }

  // Idempotent: starting/started with a durable run id → same run, never a second S10.
  if (
    (handoff.state === 'starting' || handoff.state === 'started') &&
    handoff.planning_run_id != null &&
    Number.isFinite(Number(handoff.planning_run_id))
  ) {
    return {
      ok: true,
      handoffId: handoff.id,
      runId: Number(handoff.planning_run_id),
      state: handoff.state === 'started' ? 'started' : 'starting',
      digest: String(handoff.manifest_digest || ''),
      already: true,
    };
  }

  // RT R1 / fix1: state=starting without planning_run_id is an in-flight CAS gap.
  // Do NOT fall through to create another durable run / second S10.
  if (handoff.state === 'starting') {
    return err(
      'CAS_LOST',
      'handoff already starting; confirm in flight — retry shortly (no second run)',
      handoff.id
    );
  }

  // Only pending may be consumed (via atomic CAS pending→starting below).
  if (handoff.state !== 'pending') {
    return err(
      'BAD_STATE',
      `handoff state is ${handoff.state}; confirm requires pending`,
      handoff.id
    );
  }

  if (Number(handoff.project_id) !== projectId) {
    return err('MISMATCH', 'handoff project/cycle binding mismatch', handoff.id);
  }

  // Phase: discovery (or already planning if recovering mid-start)
  if (
    !isDiscoveryPhase(cycleRow.phase) &&
    String(cycleRow.phase).toLowerCase() !== 'planning'
  ) {
    return err(
      'BAD_STATE',
      `cycle phase is ${cycleRow.phase}, expected discovery`,
      handoff.id
    );
  }

  // Docs revalidation
  const cycleDocDir = deps.cycleService.getCycleDocDir(cycleId);
  const docs = await validateDiscoveryDocs(cycleDocDir);
  if (!docs.ok) {
    return err('MISSING_DOCS', docs.reason, handoff.id);
  }

  // Frozen digest presence + JSON recompute (S10 fix1 parity)
  const frozenDigest = String(handoff.manifest_digest || '').trim();
  if (!frozenDigest) {
    return err('MISMATCH', 'handoff missing frozen manifest_digest', handoff.id);
  }
  const recomputed = recomputeFrozenDigest(handoff.manifest_json);
  if (!recomputed || recomputed !== frozenDigest) {
    return err(
      'MISMATCH',
      'frozen manifest_json does not recompute to handoff.manifest_digest',
      handoff.id
    );
  }
  if (
    input.expectedDigest != null &&
    String(input.expectedDigest) !== frozenDigest
  ) {
    return err(
      'MISMATCH',
      'expectedDigest does not match frozen handoff digest',
      handoff.id
    );
  }

  // Live staffing revalidation (AC24)
  let liveDigest: string;
  try {
    const staffing = new PlanningStaffingService(
      deps.db,
      deps.assignments,
      deps.plannerPanel
    );
    const live = staffing.resolveManifest(projectId, {
      throwOnEmpty: false,
      throwOnMismatch: false,
    });
    liveDigest = live.digest;
  } catch (e: any) {
    return err(
      'STAFFING',
      `live staffing resolve failed: ${e?.message || e}`,
      handoff.id
    );
  }
  if (liveDigest !== frozenDigest) {
    return err(
      'MISMATCH',
      'live seat-manifest digest changed since handoff was frozen; refresh preview',
      handoff.id
    );
  }

  // Atomic consume: only pending→starting wins the right to create a run + call S10.
  const cas = deps.handoffs.casTransition(handoff.id, 'pending', 'starting');
  if (cas === 0) {
    // Lost race — re-read; never create a second run from here.
    const again = deps.handoffs.getById(handoff.id);
    if (
      again &&
      (again.state === 'starting' || again.state === 'started') &&
      again.planning_run_id != null
    ) {
      return {
        ok: true,
        handoffId: again.id,
        runId: Number(again.planning_run_id),
        state: again.state === 'started' ? 'started' : 'starting',
        digest: String(again.manifest_digest || ''),
        already: true,
      };
    }
    if (again?.state === 'starting') {
      return err(
        'CAS_LOST',
        'handoff already starting; confirm in flight — retry shortly (no second run)',
        handoff.id
      );
    }
    return err(
      'CAS_LOST',
      'handoff is no longer pending (stale confirm)',
      handoff.id
    );
  }
  handoff = deps.handoffs.getById(handoff.id) || handoff;

  // Durable run creation BEFORE model startup (AC30 / 202) — only the CAS winner reaches here.
  const batchId =
    (input.batchId && String(input.batchId).trim()) ||
    `handoff-confirm-${handoff.id}-${Date.now().toString(36)}`;
  const nsPath = path.join(cycleDocDir, CANONICAL_CYCLE_ARTIFACTS.northStar);
  let runId: number;
  try {
    runId = deps.artifacts.createRun(projectId, batchId, nsPath, cycleId);
    try {
      deps.db.raw
        .prepare(
          "UPDATE runs SET phase = 'planning', cycle_id = ?, status = 'active' WHERE id = ?"
        )
        .run(cycleId, runId);
    } catch {
      /* best-effort */
    }
  } catch (e: any) {
    deps.handoffs.fail(handoff.id, `run create failed: ${e?.message || e}`, 'starting');
    return err('INTERNAL', `failed to create planning run: ${e?.message || e}`, handoff.id);
  }

  // Persist run id while still starting (S10 will CAS starting→started after planning)
  deps.handoffs.casTransition(handoff.id, 'starting', 'starting', {
    planningRunId: runId,
  });

  const s10Input = {
    projectId,
    cycleId,
    handoffId: handoff.id,
    expectedDigest: frozenDigest,
    batchId,
    precreatedRunId: runId,
  };

  const runS10 = async () => {
    try {
      await deps.orchestrator.startPlanningFromConfirmedHandoff(s10Input);
    } catch (e: any) {
      const reason =
        e instanceof ConfirmedHandoffPlanningError
          ? `${e.code}: ${e.message}`
          : String(e?.message || e);
      try {
        deps.handoffs.fail(handoff!.id, reason, 'starting');
      } catch {
        /* best-effort */
      }
      try {
        deps.db.raw
          .prepare(
            "UPDATE runs SET phase = 'failed', status = 'failed', ended_at = datetime('now') WHERE id = ? AND phase NOT IN ('complete','failed')"
          )
          .run(runId);
      } catch {
        /* best-effort */
      }
    }
  };

  const detach = deps.detachS10 !== false;
  if (detach) {
    void runS10();
  } else {
    await runS10();
  }

  return {
    ok: true,
    handoffId: handoff.id,
    runId,
    state: 'starting',
    digest: frozenDigest,
    already: false,
  };
}

/**
 * Owner decline: pending→declined, no run, permits a later fresh pending handoff.
 */
export function declineDiscoveryHandoff(
  input: OwnerDeclineInput,
  deps: Pick<OwnerBridgeDeps, 'handoffs'>
): OwnerDeclineResult {
  const cycleId = Number(input.cycleId);
  const handoff = resolveHandoff(deps.handoffs, cycleId, input.handoffId);
  if (!handoff) {
    return {
      ok: false,
      code: 'NO_HANDOFF',
      reason: 'no live discovery handoff for this cycle',
    };
  }
  if (handoff.state !== 'pending') {
    return {
      ok: false,
      code: 'BAD_STATE',
      reason: `handoff state is ${handoff.state}; decline requires pending`,
      handoffId: handoff.id,
    };
  }
  const reason =
    (input.reason && String(input.reason).trim()) || 'owner declined (Not yet)';
  const n = deps.handoffs.decline(handoff.id, reason);
  if (n === 0) {
    return {
      ok: false,
      code: 'CAS_LOST',
      reason: 'handoff is no longer pending (stale decline)',
      handoffId: handoff.id,
    };
  }
  return { ok: true, handoffId: handoff.id, state: 'declined' };
}

/** HTTP status mapping for confirm/decline errors. */
export function ownerBridgeHttpStatus(code: OwnerBridgeErrorCode): number {
  switch (code) {
    case 'NOT_FOUND':
    case 'NO_HANDOFF':
      return 404;
    case 'ACTIVE_RUN':
    case 'CAS_LOST':
    case 'BAD_STATE':
      return 409;
    case 'MISMATCH':
    case 'MISSING_DOCS':
    case 'STAFFING':
      return 409;
    case 'INTERNAL':
      return 500;
    default:
      return 400;
  }
}
