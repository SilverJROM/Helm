import { resolveRunDir } from './run-paths.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ITransport } from './fake-transport.js';
import { RunArtifactService } from './run-artifact-service.js';
import { PlanningPhaseService } from './planning-phase-service.js';
import { PlanParserService } from './plan-parser-service.js';
import { parseExecutionPlan } from './execution-plan-parser.js';
import { TaskQueueService, type TaskTerminalToken } from './task-queue-service.js';
import { OrchestratorLoop, RunAbortedError, TERMINAL_RUN_PHASES, TERMINAL_RUN_STATUSES } from './orchestrator-loop.js';
import { getRunAbort, clearRunAbort } from './run-abort-registry.js';
import { ProjectService } from './project-service.js';
import { roleMatches } from './role-alias.js';
import { parseCallbackLine } from './agent-event-ingest.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { PhaseStaffingService, type ProjectPhase, type ResolvedPhaseAgent } from './phase-staffing.js';
import { EscalationService } from './escalation-service.js';
import { PanelService } from './panel-service.js';
import { BriefWriterService } from './brief-writer-service.js';
import { resolveRequirementsText } from './requirements-resolver-service.js';
import { selectCoPlannerMode } from './planning-phase-service.js';
import { makeStrictReadProfileEnv, resolveDeploymentStrictReadAllow } from '../security/landlock-sandbox.js';
import type { RoutingConfigService } from './routing-config-service.js';
import type { AgentEventsService } from './agent-events-service.js';
import { discoverDevDeployConfig, createRealDeployRunner, type DeployRunner } from './deploy-service.js';
import { discoverFinalTestConfig, createRealTestRunner, type TestRunner } from './final-test-service.js';
import { assertNoValCollision, assertRedteamPanelSize, ResolveStallError } from '../db/resolve-time-invariants.js';
import { CANONICAL_CYCLE_ARTIFACTS, materializeCanonicalArtifactSet, readCycleArtifact } from './cycle-artifact-paths.js';
import { isAwaitingApproval } from './cycle-service.js';
import { PROVIDERS } from '../config/providers.js';
import {
  httpNotificationTransport,
  notifyBlockedRun,
  type NotificationTransport,
} from './notification-transport.js';
import type { PlannerPanelService } from './planner-panel-service.js';
import type { PlannerPanel } from './adaptive-planning-phase.js';
import { makeGrokAwareProviderModelAvailability } from './grok-auth-availability.js';
import { finalizeBrainSessionRow } from './worker-runtime-finalize.js';
import type { LifecycleToken } from './lifecycle-cas.js';
import {
  PlanningStaffingService,
  toCorePlanningStaffingArgs,
  type CorePlanningStaffingArgs,
} from './planning-staffing-service.js';
import type { DatabaseService } from '../db/database.js';

// CYCLE-BUILDDIR: a cycle-plan run builds the deliverable in this subdir OF the cycle workspace (never the
// workspace root — that holds north-star.md, which puts helm-sandbox in PROTECTED-ROOT mode and blocks
// from-scratch scaffolding). Override with HELM_CYCLE_BUILD_SUBDIR; single path segment, no separators.
const CYCLE_BUILD_SUBDIR = (() => {
  const v = (process.env.HELM_CYCLE_BUILD_SUBDIR || 'repo').trim();
  return v && !v.includes('/') && !v.includes('\\') && v !== '.' && v !== '..' ? v : 'repo';
})();

export interface StartRunInput {
  projectId: number;
  prompt: string;
  roleBindings?: Array<{ role: string; agent_id?: number; model?: string; provider?: string }>;  // POCFIX5: support provider from binding for robust resolution
  batchId?: string; // test seam for deterministic callback batch match
  // PLAN-CACHE (Phase-2 replay): when set, SKIP interview + planning entirely. Restore the project to the
  // cached plan's code baseline, ingest the cached plan.json directly, and run ONLY the implementation loop with
  // the given roleBindings. Lets us A/B many implementer/validator models (e.g. kloo OSS) against one frozen
  // plan without re-paying for Phase-1. Resolves under HELM_PLAN_CACHE_DIR (default <cwd>/plan-cache)/<seedPlan>/.
  seedPlan?: string;
  // B13-T03d (cards dogfood): link this run to a CC cycle so it is reviewable in the cycle's
  // Implementation tab (getCycleRunState queries runs WHERE cycle_id=?). Threaded to createRun as
  // the 4th arg. Null/absent => a project-level (cycle-less) run, unchanged legacy behavior.
  cycleId?: number | null;
  // IS-R1 (impl-start): when set (by start-implementation when there's a cycleId and NO seedPlan),
  // take the cycle-plan implementation-only path: read the cycle folder's canonical plan.md, ingest
  // it into run_tasks, and run ONLY the implementation loop (no interview, no planning-phase spawn,
  // no baseline restore). Mirrors the seedFromCache structure but sources the plan from the CYCLE.
  cyclePlan?: boolean;
  // CC-CHAT-1 B2 (internal, set by startRunDetached): run row already created by the detached
  // wrapper so POST /runs can return the runId immediately — every path below MUST reuse it
  // instead of creating a second row.
  precreatedRunId?: number;
  // B-ISO1 (sol wiring review fix #4): the RUN-SCOPED opt-in strict read allowlist. This is the seam
  // that carries an already-chosen run policy to EVERY real seat the run spawns — the interview +
  // planning (projcore/partner) seats AND every execution seat (implementer/validator/brain/final
  // tests via OrchestratorLoop). undefined (default) => read-all, byte-identical to before. The actual
  // cards2 allowlist VALUE is chosen later (Phase 5); this is the plumbing to carry it end-to-end.
  strictReadAllow?: string[];
}

export interface RunStatus {
  runId: number;
  phase: string;
  status: string;
  tasks: any[];
  current: any | null;
}

export class RunOrchestratorService {
  private readonly recoveryLocks = new Set<number>();

  constructor(private readonly deps: {
    artifacts: RunArtifactService;
    planning: PlanningPhaseService;
    parser: PlanParserService;
    queue: TaskQueueService;
    transport: ITransport;
    projectService: ProjectService;
    assignmentService: AgentAssignmentService;
    escalationService?: EscalationService;
    panelService?: PanelService;
    // A4: optional — when provided, OrchestratorLoop consults it (routeFor) as the source of routing
    // decisions, with the hardcoded FSM as fallback. Absent => pure hardcoded path (unchanged).
    routingConfig?: RoutingConfigService;
    // CC-CHAT-2 R3: when provided, startRunDetached persists the run-starting prompt as an owner
    // chat bubble (agent_events, batch chat-<projectId>) so the run conversation survives
    // reloads/other browsers instead of living only in the sender's local state.
    events?: AgentEventsService;
    // B10-T06: stubbable deploy runner (MUST be injected in all tests — see reinforcement 1).
    // Real runner is only for non-test paths and runs *exactly* the discovered cmd from project_specs.
    deployRunner?: DeployRunner;
    // B11-T02: stubbable final-tests runner (MUST be injected in all tests — see reinforcement 1).
    // Real runner is only for non-test paths. Runs local smoke (first) then authoritative DEV e2e.
    // Respect cycle.final_tests_enabled (from B11-T01). Graceful pause on no smoke/e2e config.
    finalTestRunner?: TestRunner;
    // IS-R1 (impl-start): resolves the cycle folder for the cycle-plan implementation-only path
    // (getCycleDocDir → <cycle folder>/plan.md). Only needed for cyclePlan runs; absent
    // for legacy/project-level runs. Typed structurally to avoid a service import cycle.
    // A5 / R3.13: finishPlanning is called from production at planning-done (idempotent-safe N7).
    // A7 / R3.15: setCyclePhase('complete') at true run terminals (terminalizeCycleAtRunEnd).
    cycleService?: {
      getCycleDocDir(cycleId: number): string;
      finishPlanning?(cycleId: number): unknown;
      setCyclePhase?(cycleId: number, phase: string): unknown;
    };
    // A1a (seat-binary pre-flight): when provided, the run refuses to start if any rostered model's
    // launch CLI is not on the seat's PATH (the "binary vanished" bug) — instead of discovering it as a
    // per-seat generic timeout mid-run. Optional (like the other injected runners): absent => skipped.
    // Typed structurally to avoid a service import cycle.
    masterRuntime?: {
      preflightRunRoster(
        projectId: number,
        roster: Array<{ provider: string; model: string }>,
        cwd?: string
      ): Promise<{ ok: boolean; missing: Array<{ provider: string; model: string; bin: string | null; reason: string }> }>;
      // review #3: per-run cached verifier for the dispatch boundary (per-task/rung models resolved later).
      makeSeatBinaryVerifier(cwd?: string): (provider: string, model: string) => Promise<{ ok: boolean; bin: string | null; reason?: string }>;
    };
    notificationTransport?: NotificationTransport;
    /** v93: per-project adaptive planner panel config (read when adaptive_planning ON). */
    plannerPanelService?: PlannerPanelService;
  }) {
    const validateIngest = (runId: number, plan: any) => this.validatePlanStartingRungs(runId, plan);
    if (typeof this.deps.parser.setIngestValidator === 'function') this.deps.parser.setIngestValidator(validateIngest);
    if (typeof (this.deps.planning as any).setIngestValidator === 'function') {
      (this.deps.planning as any).setIngestValidator(validateIngest);
    }
  }

  private validatePlanStartingRungs(runId: number, plan: any): void {
    const row: any = this.deps.artifacts['db'].raw.prepare('SELECT project_id FROM runs WHERE id = ?').get(runId);
    const projectId = row?.project_id == null ? undefined : Number(row.project_id);
    const escalation = this.deps.escalationService ?? new EscalationService();
    for (const task of plan.tasks || []) {
      const taskKey = String(task?.task_key || '<unknown>');
      try {
        escalation.resolveRungAndModel({
          role: 'implementer',
          explicitRung: task?.recommended_rung,
          complexity: task?.complexity,
          explicitModel: task?.model || task?.recommended_model,
          projectId,
        });
      } catch (error: any) {
        throw new Error(`Invalid plan starting assignment for task ${taskKey}: ${error?.message || error}`);
      }
      if (task?.validator_rung != null) {
        try {
          // Tasks may start either seat at any valid rung, including the top. Resolution still
          // validates the rung, model, and provider assignment before ingest persists the task.
          escalation.resolveRungAndModel({
            role: 'validator',
            explicitRung: task.validator_rung,
            explicitModel: task?.validator_model,
            projectId,
          });
        } catch (error: any) {
          throw new Error(`Invalid plan validator starting assignment for task ${taskKey}: ${error?.message || error}`);
        }
      }
    }
  }

  // v92: read the project's opt-in adaptive-planning flag (fail-safe false). Threaded into runPlanningPhase
  // so an ON project delegates to the adaptive tiered planner module; OFF (default) keeps the existing path.
  private isAdaptivePlanning(projectId?: number): boolean {
    if (projectId == null) return false;
    try {
      const row: any = this.deps.artifacts['db'].raw
        .prepare('SELECT adaptive_planning FROM projects WHERE id = ?')
        .get(projectId);
      return Number(row?.adaptive_planning || 0) === 1;
    } catch {
      return false;
    }
  }

  // S05 / AC20: planning_panel_size = N co-planners excluding plancore (default 2).
  // Independent of adaptive_planning. Callers that need A10 total-seat panelSize use N+1.
  private resolvePlanningPanelSize(projectId?: number): number {
    if (projectId == null) return 2;
    try {
      const row: any = this.deps.artifacts['db'].raw
        .prepare('SELECT planning_panel_size FROM projects WHERE id = ?')
        .get(projectId);
      const n = Number(row?.planning_panel_size ?? 2);
      return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 2;
    } catch {
      return 2;
    }
  }

  /**
   * S05 fix1: resolve core-path Planning seats via PlanningStaffingService when a panel is
   * configured (adaptive ON or OFF). Never substitutes generic `planner` for configured seats.
   * Empty panel → legacy partner binding + N co-planner count from DB.
   * S06 will replace partnerModel with ordered per-seat identities; until then count + first
   * ready co-planner model are wired so N partners are spawned from the panel.
   */
  private resolveCorePlanningStaffing(projectId: number): CorePlanningStaffingArgs {
    const legacyN = this.resolvePlanningPanelSize(projectId);
    const legacy: CorePlanningStaffingArgs = {
      usedPanel: false,
      panelSizeTotal: Math.max(1, legacyN + 1),
    };
    if (!this.deps.assignmentService) return legacy;
    try {
      const db = this.deps.artifacts['db'] as DatabaseService;
      const svc = new PlanningStaffingService(
        db,
        this.deps.assignmentService,
        this.deps.plannerPanelService
      );
      const manifest = svc.resolveManifest(projectId, {
        throwOnEmpty: false,
        throwOnMismatch: false,
      });
      return toCorePlanningStaffingArgs(manifest);
    } catch (e: any) {
      console.warn(
        `[RunOrchestrator] PlanningStaffingService resolve failed for project ${projectId}: ${e?.message || e}`
      );
      return legacy;
    }
  }

  // A11 (R1.6 + D7): read the project's co-planner agreement round cap — default 3 (fail-safe on any
  // read error) — threaded into runPlanningPhase so the bounded-exit budget is config-driven, not a
  // constant. Same fail-safe pattern as resolvePlanningPanelSize.
  private resolvePlanningRoundCap(projectId?: number): number {
    if (projectId == null) return 3;
    try {
      const row: any = this.deps.artifacts['db'].raw
        .prepare('SELECT planning_round_cap FROM projects WHERE id = ?')
        .get(projectId);
      const n = Number(row?.planning_round_cap ?? 3);
      return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : 3;
    } catch {
      return 3;
    }
  }

  /**
   * v93: when adaptive_planning is ON, build PlannerPanel from project config (members/lead/backups).
   * Applies seat-binary availability for backup fallback when masterRuntime is present.
   * Returns null when adaptive is OFF or no panel is configured (legacy defaults).
   */
  private async resolveAdaptivePlannerPanel(
    projectId: number | undefined,
    projectDir?: string,
  ): Promise<{ panel?: PlannerPanel; isModelAvailable?: (provider: string, model: string) => Promise<boolean> } | null> {
    if (projectId == null || !this.isAdaptivePlanning(projectId)) return null;
    if (!this.deps.plannerPanelService) return { panel: undefined };

    let isModelAvailable: ((provider: string, model: string) => Promise<boolean>) | undefined;
    let unavailable: Set<string> | undefined;

    // B12 / AC-18: always attach a pre-spawn availability probe so expired grok auth
    // fails over to configured backups via resolvePanelWithAvailability — not #53 pause.
    // Seat-binary remains an additional gate when masterRuntime is present.
    let binaryOk: ((provider: string, model: string) => Promise<boolean>) | undefined;
    if (this.deps.masterRuntime && process.env.HELM_DISABLE_SEAT_PREFLIGHT !== '1') {
      const verifier = this.deps.masterRuntime.makeSeatBinaryVerifier(projectDir);
      binaryOk = async (provider: string, model: string) => {
        const res = await verifier(provider, model);
        return res.ok;
      };
    }
    isModelAvailable = makeGrokAwareProviderModelAvailability(binaryOk);

    try {
      // buildPlannerPanel applies sync unavailable set when provided; for async seat-binary we
      // leave members as configured and thread isModelAvailable so adaptive can resolve at spawn.
      const panel = this.deps.plannerPanelService.buildPlannerPanel(projectId, unavailable);
      return { panel: panel || undefined, isModelAvailable };
    } catch {
      return { panel: undefined, isModelAvailable };
    }
  }

  // #52: `kind` distinguishes a genuine FAILURE (status=failed) from an operator-recoverable PAUSE
  // (status=paused) — both set phase=blocked, but a run that merely halted for missing config or a
  // grok relogin is NOT failed, and recording it as such contradicted its own completion summary and
  // false-alarmed status-keyed monitoring. Default 'failure' preserves every existing caller verbatim.
  /**
   * @param expectedGeneration B04 fix cycle 2 (validator V1): when the caller reached this from a
   *   detached startRunDetached continuation, its captured runs.generation. Gates this method's own
   *   terminal UPDATE plus its finalizeRunWorkerRuntimes/assertImplementationBrainComplete calls so a
   *   stale continuation cannot blocked-fail a recycled occupant of the same numeric id. Omitted by
   *   callers with no captured token (unchanged pre-B04 behavior).
   */
  private transitionRunToBlocked(
    runId: number,
    message: string,
    project?: any,
    kind: 'failure' | 'operator-pause' = 'failure',
    expectedGeneration?: number
  ): void {
    const db = this.deps.artifacts['db'].raw;
    const status = kind === 'operator-pause' ? 'paused' : 'failed';
    const gated = expectedGeneration != null && Number.isFinite(Number(expectedGeneration));
    try {
      const changed = gated
        ? db.prepare(
            "UPDATE runs SET phase = 'blocked', status = ?, ended_at = datetime('now') WHERE id = ? AND generation = ? AND phase NOT IN ('complete','failed','blocked','paused')"
          ).run(status, runId, expectedGeneration)
        : db.prepare(
            "UPDATE runs SET phase = 'blocked', status = ?, ended_at = datetime('now') WHERE id = ? AND phase NOT IN ('complete','failed','blocked','paused')"
          ).run(status, runId);
      if (changed.changes !== 1) return;
      const run: any = db.prepare(
        'SELECT r.batch_id, p.name AS project_name FROM runs r LEFT JOIN projects p ON p.id = r.project_id WHERE r.id = ?'
      ).get(runId);
      notifyBlockedRun(this.deps.notificationTransport ?? httpNotificationTransport, {
        runId,
        batchId: run?.batch_id,
        project: project?.name || run?.project_name,
        message,
      });
      // A7 / R3.15: true blocked-failure terminalizes the cycle board. Operator-pause (A6 park,
      // missing deploy/final-test config) is recoverable — leave cycles.phase alone.
      if (kind === 'failure') {
        this.terminalizeCycleAtRunEnd({ runId });
        // A15 + S03: finalize workers first, THEN assert ibrain (no race where a just-registered
        // ibrain ledger row is picked up by finalizeRunWorkerRuntimes and reaped — D-a3 keep-alive).
        const projId =
          project?.id != null
            ? Number(project.id)
            : Number(
                (db.prepare('SELECT project_id FROM runs WHERE id = ?').get(runId) as any)?.project_id
              );
        void (async () => {
          try {
            await this.finalizeRunWorkerRuntimes(runId, 'run-blocked-failure', expectedGeneration);
            if (Number.isFinite(projId)) {
              this.assertImplementationBrainComplete({
                projectId: projId,
                runId,
                reason: 'run-blocked-failure',
                state: 'failed',
                expectedGeneration,
              });
            }
          } catch { /* best-effort terminal bookkeeping */ }
        })();
      }
    } catch { /* terminal transition and operator alert are best-effort */ }
  }

  /**
   * CC-CHAT-1 B2: non-blocking run start for POST /api/projects/:id/runs (Cloudflare-524 class fix).
   * Pre-creates the run row synchronously (phase 'starting') and kicks the full startRun off in the
   * background (fire-and-forget with error logging; a background failure marks the run failed via
   * the existing terminal path). Callers poll GET /runs for state — NOTHING blocks on planning/loop.
   */
  startRunDetached(input: StartRunInput): { runId: number; batchId: string } {
    const project = this.deps.projectService.getProject(input.projectId);
    if (!project) throw new Error('unknown project');
    const batchId = input.batchId || `r${Date.now().toString(36)}`;
    const runDir = resolveRunDir(input.projectId, batchId); // #46: single resolver
    const runId = this.deps.artifacts.createRun(input.projectId, batchId, path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar), input.cycleId ?? null);
    // B04 / AC8: freeze the run's lifecycle token (id + B03 allocator generation) at the authoritative
    // dispatch boundary — the instant the row exists. The background continuation below closes over
    // this const and never re-reads runs.generation from the (possibly recycled) runId later.
    const runRow = this.deps.artifacts['db'].raw
      .prepare('SELECT generation FROM runs WHERE id = ?')
      .get(runId) as { generation: number } | undefined;
    const runToken: LifecycleToken = { id: runId, generation: Number(runRow?.generation ?? 0) };
    // A6b: process-local TaskQueueService is keyed by runId. SQLite reuses free runs.id after CASCADE
    // delete; a prior run's stuck inFlight / failedTasks / allTasks then makes getNextReady() return
    // null forever → DB has pending run_tasks but drainDispatch immediately pending-after-drain stalls
    // (live A6b: "implementation queue never dispatched after approve"). Wipe queue state for this id.
    try { this.deps.queue.clearRun(runId); } catch { /* never block start */ }
    try { this.deps.artifacts['db'].raw.prepare("UPDATE runs SET phase = 'starting' WHERE id = ?").run(runId); } catch {}
    // CC-CHAT-2 R3: persist the run-starting prompt as an owner bubble in the project chat
    // transcript (this is the choke point every run start passes through). Must never block/fail
    // a run start.
    try {
      this.deps.events?.recordEvent({
        run_id: String(runId),
        role: 'owner',
        batch_id: `chat-${input.projectId}`,
        session: null,
        type: 'message',
        source: 'post',
        correlation_id: `run-prompt:${input.projectId}:${runId}`,
        body: { text: input.prompt, kind: 'run-prompt', run_pk: runId, batch: batchId }
      });
    } catch { /* transcript persist is best-effort */ }
    void this.startRun({ ...input, batchId, precreatedRunId: runId }).catch((e: any) => {
      console.error(`[run-orchestrator] detached startRun failed for run ${runId} (project ${input.projectId}, batch ${batchId}): ${e?.stack || e?.message || e}`);
      // B04 / AC8: the failure UPDATE is the CAS gate for this whole terminal chain — it compares
      // runs.id + runs.generation against the token frozen at dispatch. changes !== 1 means the row
      // is already terminal, gone, or a new occupant recycled this id; the old chain must no-op
      // rather than mark the recycled row failed or reap/finalize its live workers (D01: changes===0
      // is stale/KEEP, never refresh-and-retry).
      let casApplied = false;
      try {
        const result = this.deps.artifacts['db'].raw
          .prepare(
            `UPDATE runs SET phase = 'failed', status = 'failed', ended_at = datetime('now')
             WHERE id = ? AND generation = ? AND phase NOT IN ('complete','failed','blocked')`
          )
          .run(runToken.id, runToken.generation) as { changes?: number };
        casApplied = Number(result?.changes || 0) === 1;
      } catch { /* casApplied stays false — treat as stale, do not run terminal bookkeeping */ }
      if (!casApplied) {
        console.warn(
          `[run-orchestrator] detached startRun failure for run ${runToken.id} generation ${runToken.generation} is stale/already-terminal — skipping cycle/worker/brain terminal bookkeeping`
        );
        return;
      }
      // A7 / R3.15: detached failure is a true terminal — advance cycle board if linked.
      this.terminalizeCycleAtRunEnd({ runId: runToken.id, cycleId: input.cycleId ?? null });
      // A15 + S03: finalize workers first, then ibrain assert (true terminal; no reap — D-a3).
      // B04: both independently re-compare runs.generation against runToken at their own pre-reap/
      // pre-mutate selection — defense against recycling in the window between the CAS above and
      // these awaited operations.
      void (async () => {
        try {
          await this.finalizeRunWorkerRuntimes(runToken.id, 'detached-start-failed', runToken.generation);
          this.assertImplementationBrainComplete({
            projectId: input.projectId,
            runId: runToken.id,
            reason: 'detached-start-failed',
            state: 'failed',
            expectedGeneration: runToken.generation,
          });
        } catch { /* best-effort terminal bookkeeping */ }
      })();
    });
    return { runId, batchId };
  }

  /**
   * A5 / R3.13: call CycleService.finishPlanning from production at planning-done.
   * Docstring on finishPlanning promised B10 would call it; only tests did until this wire.
   * Idempotent-safe (N7): CONFLICT (phase ≠ 'planning') is swallowed so a second call never
   * fails the run. Other errors are logged and non-fatal (board cosmetic; run must continue).
   * No-op when cycleService is unwired, finishPlanning is missing, or cycleId is absent.
   */
  private finishPlanningAtPlanningDone(cycleId: number | null): void {
    if (cycleId == null || !Number.isFinite(cycleId)) return;
    const fin = this.deps.cycleService?.finishPlanning;
    if (typeof fin !== 'function') return;
    try {
      fin.call(this.deps.cycleService, cycleId);
    } catch (e: any) {
      if (e?.code === 'CONFLICT') {
        // N7: already past planning (double-call / start-implementation race) — board already advanced.
        return;
      }
      console.warn(
        `[RunOrchestrator] finishPlanning(${cycleId}) non-fatal at planning-done: ${e?.message || e}`
      );
    }
  }

  /**
   * A15 / R4: finalize every non-terminal worker_runtimes row for a run (seat ledger).
   * Best-effort reaps the tmux session then shared finalizeWriter → reaped + ended_at.
   * Used at true run terminals and planning-done-yield so seats never stick as running.
   */
  /**
   * @param expectedGeneration B04 / AC8: when supplied, the shared finalizer only selects/reaps
   *   worker_runtimes rows whose run still carries this exact runs.generation — a stale caller
   *   (recycled runId) selects nothing. Omitted by every pre-existing synchronous call site, whose
   *   generation cannot have moved within their own still-live run's execution.
   */
  private async finalizeRunWorkerRuntimes(runId: number, reason: string, expectedGeneration?: number): Promise<number> {
    try {
      const { finalizeRunWorkerRuntimes: finalizeRun } = await import('./worker-runtime-finalize.js');
      const db = this.deps.artifacts['db'].raw;
      return await finalizeRun(db, runId, reason, async (session) => {
        try {
          await this.deps.transport.reap(`${session}:0.0`, reason);
        } catch { /* best-effort */ }
      }, expectedGeneration);
    } catch {
      return 0;
    }
  }

  /**
   * S03 / AC24 brains: assert the named implementation brain (helm-ibrain-*) complete at a true
   * run terminal only. Register-if-needed worker_runtimes + finalizeWorkerRuntimeRow → S02 markIdle.
   * Does NOT reap/terminate — preserves D-a3 close-confirm keep-alive. Never call on intermediate yield.
   */
  private assertImplementationBrainComplete(opts: {
    projectId: number;
    runId: number;
    session?: string | null;
    reason: string;
    state?: 'done' | 'failed' | 'reaped';
    provider?: string;
    model?: string;
    /** B04 / AC8: captured runs.generation — a mismatch makes finalizeBrainSessionRow a no-op. */
    expectedGeneration?: number;
  }): void {
    try {
      const db = this.deps.artifacts['db'].raw;
      let session = String(opts.session ?? '').trim();
      if (!session) {
        const proj: any = db.prepare('SELECT name FROM projects WHERE id = ?').get(opts.projectId);
        if (!proj?.name) return;
        const slug = String(proj.name).toLowerCase().replace(/[^a-z0-9]+/g, '_');
        session = `helm-ibrain-${slug}`;
      }
      finalizeBrainSessionRow(db, {
        projectId: opts.projectId,
        runId: opts.runId,
        session,
        role: 'ibrain',
        reason: opts.reason,
        state: opts.state ?? 'done',
        provider: opts.provider,
        model: opts.model,
        expectedGeneration: opts.expectedGeneration,
      });
    } catch {
      /* best-effort bookkeeping — never block the run terminal path */
    }
  }

  /**
   * A7 / R3.15: on true run completion (success / failed / blocked-failure), advance the linked
   * cycle board to the sole terminal cycle phase `complete`. Does NOT call completeCycle (no
   * folder archive). Operator-pause paths must never call this (A6 park stays non-terminal).
   * Resolves cycle_id from the run row when only runId is known. N7: board write is non-fatal.
   */
  private terminalizeCycleAtRunEnd(opts: { runId?: number | null; cycleId?: number | null }): void {
    let cycleId =
      opts.cycleId != null && Number.isFinite(Number(opts.cycleId)) ? Number(opts.cycleId) : null;
    if (cycleId == null && opts.runId != null && Number.isFinite(Number(opts.runId))) {
      try {
        const r = this.deps.artifacts['db'].raw
          .prepare('SELECT cycle_id FROM runs WHERE id = ?')
          .get(Number(opts.runId)) as any;
        if (r?.cycle_id != null) cycleId = Number(r.cycle_id);
      } catch { /* leave null */ }
    }
    if (cycleId == null || !Number.isFinite(cycleId)) return;
    const setPhase = this.deps.cycleService?.setCyclePhase;
    if (typeof setPhase !== 'function') return;
    try {
      setPhase.call(this.deps.cycleService, cycleId, 'complete');
    } catch (e: any) {
      console.warn(
        `[RunOrchestrator] terminalizeCycleAtRunEnd(${cycleId}) non-fatal: ${e?.message || e}`
      );
    }
  }

  /**
   * A6 / R3.14: true when the cycle is gate-mode (pause_after_planning) and finishPlanning has
   * just flipped it to awaiting_approval. Reads straight from cycles (not the cycleService
   * structural type, which only exposes getCycleDocDir/finishPlanning) — mirrors cycle-service.ts's
   * own isAwaitingApproval predicate so the gate can never drift from the DB flag it reads.
   */
  private isCycleGateParked(cycleId: number | null): boolean {
    if (cycleId == null || !Number.isFinite(cycleId)) return false;
    try {
      const row: any = this.deps.artifacts['db'].raw
        .prepare('SELECT autonomy, awaiting_approval FROM cycles WHERE id = ?')
        .get(cycleId);
      if (!row) return false;
      return isAwaitingApproval({ autonomy: row.autonomy, awaiting_approval: Boolean(Number(row.awaiting_approval)) });
    } catch {
      return false;
    }
  }

  /**
   * A6 / R3.14: park a run whose planning finished into a gate-mode awaiting_approval cycle.
   * Reuses transitionRunToBlocked's #52 operator-pause path (phase='blocked', status='paused') —
   * NOT a bespoke phase value. A live-run proof (real discovery/planning seats still winding down
   * in the background after this returns) showed a fresh custom phase string gets raced/clobbered:
   * every OTHER terminal-phase guard in this file is a literal `NOT IN ('complete','failed',
   * 'blocked'[,'paused'])` SQL string, so only phases already on that list are protected from being
   * overwritten by an unrelated later write. 'blocked' is on every one of them. status='paused' is
   * this codebase's existing "halted for an operator-recoverable reason" contract (#52) — exactly
   * what awaiting_approval is — and getCycleRunState's runActive check already treats phase='blocked'
   * as inactive, so a fresh cyclePlan run can start the moment approveCycle flips the cycle.
   */
  private async parkRunAwaitingApproval(runId: number, runDir: string, cycleId: number, project?: any, expectedGeneration?: number): Promise<void> {
    this.transitionRunToBlocked(
      runId,
      `pause_after_planning gate (R3.14): cycle ${cycleId} is awaiting_approval — implementation queue not started until approveCycle`,
      project,
      'operator-pause',
      expectedGeneration
    );
    try {
      await this.deps.artifacts.persistState(runDir, ['interview', 'planning', 'awaiting_approval'], 'paused', runId);
    } catch {}
    console.log(
      `[RunOrchestrator] run ${runId} parked at planning-done — cycle ${cycleId} awaiting_approval ` +
      `(pause_after_planning gate, R3.14); implementation queue not started until approveCycle`
    );
  }

  // R5a (CC-CHAT-4): phase-boundary terminal gate for the run-orchestrator's own steps —
  // one cheap SELECT + the in-memory stop registry (POST /api/runs/:id/stop). Throws
  // RunAbortedError so the phase flow stops instead of advancing a terminal run.
  private assertRunActive(runId: number, boundary: string): void {
    let detail: string | null = null;
    const ab = getRunAbort(runId);
    if (ab) detail = `stop requested via registry (${ab.reason})`;
    if (!detail) {
      try {
        const row: any = this.deps.artifacts['db'].raw.prepare('SELECT phase, status FROM runs WHERE id = ?').get(runId);
        if (row && (TERMINAL_RUN_PHASES.includes(String(row.phase)) || TERMINAL_RUN_STATUSES.includes(String(row.status)))) {
          detail = `phase=${row.phase} status=${row.status}`;
        }
      } catch { /* best-effort */ }
    }
    if (detail) {
      console.warn(`[run-orchestrator] aborted: run terminal in DB (run=${runId} boundary=${boundary} ${detail})`);
      throw new RunAbortedError(runId, `${boundary}: ${detail}`);
    }
  }

  async startRun(input: StartRunInput): Promise<number> {
    try {
      return await this.startRunInner(input);
    } catch (e: any) {
      // R5a: a run-abort is a CLEAN stop (the run is already terminal in the DB and the loop
      // reaped its workers) — return normally so startRunDetached's failure path (which
      // re-marks the run failed + error-logs) does not fire for a sanctioned stop.
      if (e instanceof RunAbortedError) {
        console.warn(`[run-orchestrator] run ${e.runId} orchestration stopped cleanly: ${e.message}`);
        clearRunAbort(e.runId);
        return e.runId;
      }
      throw e;
    }
  }

  private async startRunInner(input: StartRunInput): Promise<number> {
    const { projectId, prompt } = input;
    let project = this.deps.projectService.getProject(projectId);
    if (!project) throw new Error('unknown project');

    // A6b belt-and-braces: createRun already clearRunAborts the new id, but a caller that reuses a
    // precreatedRunId after an external stop (or a recycled-id race before createRun was fixed)
    // must not inherit a stale abort at pre-execution / task-boundary. Same for process-local queue
    // state (stuck inFlight → getNextReady always null → unknown-pending-stall with zero attempts).
    // B04 fix cycle 2 (validator V1): startRunDetached fires startRun fire-and-forget — when entered
    // through it, EVERY terminal path below (transitionRunToBlocked, planning-done-yield, the
    // run-complete/run-failed terminal block) executes inside that SAME detached continuation and is
    // equally exposed to a project-delete-then-recycle race as the detached-start-failed catch B04
    // originally gated. Re-read runs.generation for the precreated id here — same synchronous tick as
    // startRunDetached's own capture (no await has run yet), so this cannot observe a later recycle —
    // and thread it through every such path.
    // B04 fix cycle 4 (redteam-sol R3 C2): fail CLOSED, not silently ungated, when a detached call
    // cannot capture its generation token. The row was inserted synchronously by startRunDetached in
    // the same tick immediately before this read, so a missing/unreadable generation here is an
    // anomalous state — never treat it as "proceed ungated."
    let runGenToken: number | undefined;
    if (input.precreatedRunId != null && Number.isFinite(Number(input.precreatedRunId))) {
      const rid = Number(input.precreatedRunId);
      clearRunAbort(rid);
      try { this.deps.queue.clearRun(rid); } catch { /* never block start */ }
      let row: { generation: number } | undefined;
      try {
        row = this.deps.artifacts['db'].raw
          .prepare('SELECT generation FROM runs WHERE id = ?')
          .get(rid) as { generation: number } | undefined;
      } catch (e: any) {
        throw new Error(`B04: failed to capture lifecycle generation for precreated run ${rid}; refusing to dispatch ungated: ${e?.message || e}`);
      }
      if (!row || typeof row.generation !== 'number' || !Number.isFinite(row.generation)) {
        throw new Error(`B04: precreated run ${rid} has no readable generation; refusing to dispatch ungated`);
      }
      runGenToken = row.generation;
    }

    // B-ISO1 (sol wiring review fix #4): resolve the RUN-SCOPED strict read policy ONCE, at run start,
    // and thread it to every seat this run spawns (interview + planning + execution loop + panels).
    // Validate fail-fast here (same fail-closed rules the sandbox enforces) so a bad run policy refuses
    // the run BEFORE any seat launches, rather than surfacing as a per-seat spawn throw mid-run.
    // undefined => read-all (default), byte-identical to before this wiring.
    //
    // SEAM NOTE (sol wiring review-2, confirmed): this is an IN-MEMORY run-scoped field, correct today
    // because Helm has NO durable process-restart run-resumption — after a crash there is no live loop
    // to spawn an unfenced seat. If durable run-resumption is EVER added (a fresh process reconstructing
    // OrchestratorLoop from DB state), this MUST become a persisted `runs.strict_read_allow` column so
    // the resumed loop re-reads the policy; otherwise resumed seats would silently launch read-all.
    // B-ISO1 (harness activation): the run's own explicit policy wins; otherwise fall back to the
    // DEPLOYMENT-LEVEL default read fence configured on this instance via HELM_STRICT_READ_ALLOW
    // (see resolveDeploymentStrictReadAllow). This is what makes the cards2 harness :3110 instance
    // fence EVERY run — including a project created entirely through the UI — with no per-run or
    // per-project caller change. On an instance with the env unset (every other deployment + every
    // test), resolveDeploymentStrictReadAllow returns undefined, so runStrictAllow === input.strictReadAllow
    // and behavior is byte-identical. A configured-but-malformed env value throws here (fail-closed),
    // BEFORE any seat spawns, rather than silently launching read-all.
    const runStrictAllow = input.strictReadAllow ?? resolveDeploymentStrictReadAllow();
    if (runStrictAllow !== undefined) makeStrictReadProfileEnv(runStrictAllow);

    // B-ISO1 (sol wiring review-3, the last hole): sync THIS run's validated fence onto the project's
    // singleton master_runtimes row at RUN START — not only at completion. The run takes ownership of the
    // named phase-brain session for its whole duration, but a STALE row left by a PRIOR run (a different or
    // NULL policy) would otherwise expose the entire active-run window: supervisor recovery
    // (superviseTick → launchMaster), auto-fallback (usageTick → switchModel), and the owner model-switch
    // route all read strict_read_allow off this row and could relaunch the run-owned master READ-ALL or
    // wrong-fenced BEFORE completion. Write the current policy now (JSON, or NULL when the run isn't
    // strict) so the fence is correct across the window. UPDATE-only (no upsert): when no row exists none
    // of those three actors can fire (each requires an existing running row), so a no-op is correct+safe.
    //
    // FAIL-CLOSED for a strict run (sol wiring review-3 final): this sync is SECURITY-CRITICAL — it is
    // what closes the stale/NULL recovery window. So a STRICT run MUST ABORT if the UPDATE fails, BEFORE
    // any seat spawns; swallowing would silently re-open exactly the read-all recovery path this sync
    // exists to close. A NON-strict run may stay best-effort (it writes NULL = the read-all default
    // anyway, so a failure changes nothing) to preserve legacy availability.
    {
      const runStrictJsonAtStart = runStrictAllow !== undefined ? JSON.stringify(runStrictAllow) : null;
      try {
        this.deps.artifacts['db'].raw
          .prepare("UPDATE master_runtimes SET strict_read_allow = ? WHERE project_id = ?")
          .run(runStrictJsonAtStart, projectId);
      } catch (e: any) {
        if (runStrictAllow !== undefined) {
          // strict run: refuse to launch — a failed fence-sync could let supervisor recovery /
          // auto-fallback / owner-switch relaunch the run-owned master READ-ALL mid-run.
          throw new Error(
            `B-ISO1: failed to synchronize the strict read fence onto master_runtimes at run start; ` +
            `refusing to launch a strict run that could recover read-all (project ${projectId}): ${String(e?.message || e)}`
          );
        }
        /* non-strict: best-effort — NULL is the read-all default, a failure changes nothing */
      }
    }

    const slug = (project.name || 'proj').toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const discoverySessionName = `helm-discovery-${slug}`;
    const planningSessionName = project.plancore_session || `helm-plancore-${slug}`;
    const implementationSessionName = `helm-ibrain-${slug}`;

    const batchId = input.batchId || `r${Date.now().toString(36)}`;
    const runDir = resolveRunDir(projectId, batchId); // #46: single resolver
    await fs.mkdir(runDir, { recursive: true });

    // A2b: use resolver (now authoritative for project overrides + team rosters) unless explicit roleBindings override
    let redTeamAgents: Array<{ role: string; agent_id?: number; model?: string; provider?: string }> = [];
    // B15x-fix1 / I7 M1: the strip/count<3 guard now applies to EVERY resolution path
    // (explicit roleBindings, resolveProjectRole roster, or resolveProjectRoleBindings)
    // — no provenance exception. The prior `redTeamIsRoster` flag skipped the guard on
    // the resolveProjectRoleBindings path regardless of how many agents it resolved,
    // which let a genuine multi-seat panel bypass the invariant (validator FAIL @fc7ff23).
    if (input.roleBindings && input.roleBindings.length > 0) {
      redTeamAgents = input.roleBindings.filter((b: any) => b.role === 'red-team' || b.role === 'panelist');
    } else if (this.deps.assignmentService) {
      const redRes = this.deps.assignmentService.resolveProjectRole(projectId, 'red-team');
      if (redRes && redRes.roster && redRes.roster.length) {
        redTeamAgents = redRes.roster.map((r: any) => ({ role: 'red-team', model: r.model, provider: r.provider, position: r.position, lens: r.lens }));
      } else {
        const rows = this.deps.assignmentService.resolveProjectRoleBindings(projectId, ['red-team', 'panelist']);
        redTeamAgents = rows.map((r: any) => ({ role: r.role, agent_id: r.agent_id, model: r.agent.model, provider: r.agent.provider }));
      }
    }

    // Phase ownership is the one staffing source. Explicit run inputs may override the
    // resolved seat's model/provider, but never which role owns the phase.
    const phaseStaffing = new PhaseStaffingService(this.deps.assignmentService);
    const resolveBrain = (phase: ProjectPhase): ResolvedPhaseAgent => {
      const resolved = phaseStaffing.resolvePhaseAgents(projectId, phase).brain;
      if (!resolved) throw new Error(`required brain unavailable for phase ${phase}`);
      const explicit = input.roleBindings?.find((binding: any) => binding.role === resolved.role);
      return explicit
        ? {
            ...resolved,
            agent: {
              ...resolved.agent,
              model: explicit.model || resolved.agent.model,
              provider: (explicit.provider || resolved.agent.provider) as typeof resolved.agent.provider,
            },
          }
        : resolved;
    };

    const discoveryBrain = resolveBrain('discovery');
    const planningBrain = resolveBrain('planning');
    const implementationBrain = resolveBrain('implementation');

    // Resolve the co-planner partner independently from the phase brain.
    const partnerRole = selectCoPlannerMode(prompt);
    let planningBrainModel: string | undefined = planningBrain.agent.model;
    let partnerModel: string | undefined;
    let planningBrainProvider: string | undefined = planningBrain.agent.provider;
    let partnerProvider: string | undefined;
    let deliberationRoster: any[] = [];
    if (input.roleBindings && input.roleBindings.length > 0) {
      const pa = input.roleBindings.find((b: any) => b.role === partnerRole);
      if (pa) {
        partnerModel = pa.model;
        partnerProvider = pa.provider;
      }
    } else if (this.deps.assignmentService) {
      const paRes = this.deps.assignmentService.resolveProjectRole(projectId, partnerRole);
      if (paRes && paRes.agent) {
        partnerModel = paRes.agent.model;
        partnerProvider = paRes.agent.provider;
      } else if (paRes && paRes.roster && paRes.roster.length) {
        deliberationRoster = paRes.roster;
        // FIX2: full roster for deliberation; use first for partner model, pass full to convene
        partnerModel = paRes.roster[0].model;
        partnerProvider = paRes.roster[0].provider;
      }
    }

    // Use resolver for implementer/validator (project overrides authoritative); explicit only if passed
    let implementerModel: string | undefined;
    let validatorModel: string | undefined;
    let implementerProvider: string | undefined;
    let validatorProvider: string | undefined;
    if (input.roleBindings && input.roleBindings.length > 0) {
      const impl = input.roleBindings.find((b: any) => b.role === 'implementer');
      if (impl) {
        implementerModel = impl.model;
        implementerProvider = impl.provider;
      }
      const val = input.roleBindings.find((b: any) => b.role === 'validator');
      if (val) {
        validatorModel = val.model;
        validatorProvider = val.provider;
      }
    } else if (this.deps.assignmentService) {
      const implRes = this.deps.assignmentService.resolveProjectRole(projectId, 'implementer');
      if (implRes && implRes.agent) {
        implementerModel = implRes.agent.model;
        implementerProvider = implRes.agent.provider;
      }
      const valRes = this.deps.assignmentService.resolveProjectRole(projectId, 'validator');
      if (valRes && valRes.agent) {
        validatorModel = valRes.agent.model;
        validatorProvider = valRes.agent.provider;
      }
    }

    // B15x-fix1 / I7 (early resolve-time guard): verifier≠fixer for val, and for redteam
    // whenever a real multi-seat panel resolved, regardless of which branch above produced
    // it. Val-collision always runs (I7.1). Redteam strip/count<3 (M1) runs whenever
    // redTeamAgents.length >= 2 — no provenance exception (validator FAIL @fc7ff23: the prior
    // `redTeamIsRoster` gate silently skipped this on the resolveProjectRoleBindings path
    // regardless of count). `>= 2` (not `> 0`) is the actual "is this a panel" signal: a
    // single resolved agent is the pre-existing one-seat round-cycling dispatch mode
    // (PanelService's conveneRedTeamPanel over agents.length===1, e.g. B9b), not a panel,
    // and can never satisfy the ≥3-after-strip invariant regardless of provenance.
    try {
      assertNoValCollision(implementerModel, validatorModel);
      if (redTeamAgents.length >= 2) {
        assertRedteamPanelSize(implementerModel, redTeamAgents);
      }
    } catch (e: any) {
      if (e instanceof ResolveStallError) {
        if (input.precreatedRunId != null) {
          try {
            this.transitionRunToBlocked(input.precreatedRunId, `Resolve-time role collision requires corrected role bindings: ${e.message}`, project, 'failure', runGenToken);
            const reason = `# I7 Resolve-Time Stall (B15x)\n\n${e.message}\n\nOperator action required: adjust role bindings / redteam roster so resolved_impl ∉ {val} ∪ redteam_panel, then re-run.`;
            await fs.writeFile(path.join(runDir, 'i7-resolve-stall.md'), reason, 'utf8');
            this.deps.artifacts.recordArtifact(input.precreatedRunId, 'i7-resolve-stall', 'i7-resolve-stall.md');
          } catch {}
        }
      }
      throw e;
    }

    // CYCLE-BUILDDIR fix (sol review REVISE — fail-closed): a cycle-plan implementation run builds inside
    // the cycle's OWN workspace (<project.directory>/cycle/<slug>_<date>/ — where the cycle's north-star/
    // plan/decisions and the implementer's git repo live), NOT the raw registered project root. The whole
    // run — Landlock write-fence, deterministic `npm test` gate, seat briefs, git — must point at that ONE
    // directory (the root has no package.json → `npm test` exit 254 → the gate could never pass; T01 looped
    // to rung-exhaustion every run). There is NO fallback to the registered root for a cyclePlan request —
    // silently reverting recreates the exact bug — so resolve+validate ONCE, fail loud before any preflight/
    // dispatch, then shadow project.directory so every downstream consumer inherits the one build dir. The
    // workspace must exist, be a directory, and canonically be a STRICT descendant of the canonical
    // registered root (rejects root-equality and symlink escape before it becomes a write-fence). Completed
    // cycles are the reviewable archive, never a writable build. Non-cycle runs are unchanged.
    let effectiveProjectDir = project.directory;
    let resolvedCycleWorkspace: string | null = null;
    let canonicalArtifactRoot = runDir;
    if (input.cyclePlan && input.cycleId != null && !input.seedPlan) {
      // Mark the (pre-created) run blocked + drop a reason artifact, then hand back the Error to throw.
      const invalid = async (reason: string): Promise<Error> => {
        if (input.precreatedRunId != null) {
          try {
            this.transitionRunToBlocked(input.precreatedRunId, `Cycle-plan workspace validation failed: ${reason}`, project, 'failure', runGenToken);
            await fs.writeFile(path.join(runDir, 'cycle-workspace-invalid.md'), `# Cycle-plan run refused (CYCLE-BUILDDIR fail-closed)\n\n${reason}\n\nA cyclePlan run must build in a valid, active, contained cycle workspace; there is NO fallback to the registered project root.`, 'utf8');
            this.deps.artifacts.recordArtifact(input.precreatedRunId, 'cycle-workspace-invalid', 'cycle-workspace-invalid.md');
          } catch { /* best-effort surface */ }
        }
        return new Error(`cycle-plan run refused: ${reason}`);
      };
      if (!this.deps.cycleService) throw await invalid('cycleService not wired (cannot resolve the cycle workspace)');
      // Establish the cycle status and FAIL CLOSED on unknown (no row / query failure) — never build on a
      // cycle whose lifecycle can't be confirmed. Reject completed archives (getCycleDocDir maps
      // status='completed' → cycle/completed/<name>, a reviewable archive, never a writable build).
      let cycleStatus: string | null = null;
      try {
        const cr = this.deps.artifacts['db'].raw.prepare('SELECT status FROM cycles WHERE id=?').get(input.cycleId) as any;
        cycleStatus = cr ? String(cr.status) : null;
      } catch { cycleStatus = null; }
      if (cycleStatus === null) throw await invalid(`cannot establish status for cycle ${input.cycleId} (no cycle row / query failed) — refusing to build on an unknown-state cycle`);
      if (cycleStatus === 'completed') throw await invalid(`cycle ${input.cycleId} is completed — its archive must not be reopened as a writable build`);
      let ws: string;
      try { ws = this.deps.cycleService.getCycleDocDir(input.cycleId); }
      catch (e: any) { throw await invalid(`cannot resolve cycle ${input.cycleId} workspace: ${e?.message || e}`); }
      if (!ws) throw await invalid(`cycle ${input.cycleId} resolved to an empty workspace path`);
      // Canonical containment: exist + be a directory + be a STRICT descendant of the canonical root.
      let canonRoot: string;
      try { canonRoot = await fs.realpath(project.directory); }
      catch (e: any) { throw await invalid(`registered project dir does not resolve: ${project.directory} (${e?.message || e})`); }
      let canonWs: string;
      try {
        canonWs = await fs.realpath(ws);
        const st = await fs.stat(canonWs);
        if (!st.isDirectory()) throw await invalid(`cycle workspace is not a directory: ${canonWs}`);
      } catch (e: any) {
        if (e instanceof Error && e.message.startsWith('cycle-plan run refused')) throw e;
        throw await invalid(`cycle workspace does not exist/resolve: ${ws} (${e?.message || e})`);
      }
      const rel = path.relative(canonRoot, canonWs);
      if (canonWs === canonRoot || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
        throw await invalid(`cycle workspace ${canonWs} is not a strict descendant of registered root ${canonRoot} (fence-escape guard)`);
      }
      resolvedCycleWorkspace = canonWs;
      canonicalArtifactRoot = canonWs;
      // helm-sandbox (Landlock) enters PROTECTED-ROOT mode whenever `north-star.md` exists at the fence
      // root — and it DOES at the cycle-workspace root (a cycle doc). That mode issues no MAKE_REG/MAKE_DIR
      // on the root (denial-by-omission to keep north-star.md non-writable), so a from-scratch scaffold
      // CANNOT create new top-level files there (package.json, tsconfig, ...) → EPERM. Build in a dedicated
      // subdir of the workspace instead: it holds no north-star.md → SCAFFOLD mode → the implementer writes
      // freely, while the cycle's north-star/plan/decisions stay protected at the workspace root. Plan
      // ingest still reads plan.md from resolvedCycleWorkspace (the workspace), not this build dir. The
      // build dir is created here (server-side, unfenced) so the fence has an existing dir to lock onto.
      const buildDir = path.join(canonWs, CYCLE_BUILD_SUBDIR);
      let canonBuild: string;
      try {
        await fs.mkdir(buildDir, { recursive: true });
        canonBuild = await fs.realpath(buildDir);
      } catch (e: any) {
        throw await invalid(`cannot create/resolve cycle build dir ${buildDir}: ${e?.message || e}`);
      }
      if (canonBuild !== canonWs && !canonBuild.startsWith(canonWs + path.sep)) {
        throw await invalid(`cycle build dir ${canonBuild} escaped the workspace ${canonWs} (fence-escape guard)`);
      }
      effectiveProjectDir = canonBuild;
      project = { ...project, directory: canonBuild };

      // One canonical handoff replaces FIX #42b's partial og-requirements/decisions copy. Snapshot the
      // complete hyphen-canonical document set for runDir-relative implementation consumers.
      await materializeCanonicalArtifactSet(canonicalArtifactRoot, runDir);
    } else if (input.cycleId != null && this.deps.cycleService) {
      // B1 (SEAM-2/N10/R2.8): canonicalArtifactRoot must resolve from the cycle for EVERY cycle-linked
      // entry path, not just cyclePlan — otherwise a cycle-linked run reached via start-planning (or a
      // future cycleId-carrying /api/projects/:id/runs call) leaves canonicalArtifactRoot at the tmp
      // scratch runDir and R2.8 is unmet for that path. This branch is deliberately SOFT: unlike the
      // cyclePlan block above (which is a build/fence contract and must fail closed), a bad lookup here
      // only degrades the document view (D2 §Required outcome 2 — a missing file/cycle never blocks the
      // execution view). effectiveProjectDir/resolvedCycleWorkspace/the build subdir/Landlock fence are
      // NOT touched here — they stay exactly project.directory, byte-identical to a non-cycle run.
      try {
        const ws = this.deps.cycleService.getCycleDocDir(input.cycleId);
        const canonRoot = await fs.realpath(project.directory);
        const canonWs = await fs.realpath(ws);
        const st = await fs.stat(canonWs);
        const rel = path.relative(canonRoot, canonWs);
        const contained = st.isDirectory() && canonWs !== canonRoot && rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
        if (contained) {
          canonicalArtifactRoot = canonWs;
          await materializeCanonicalArtifactSet(canonicalArtifactRoot, runDir);
        }
      } catch { /* degrade to the runDir scratch root — never blocks the run */ }
    }

    // A1a (seat-binary pre-flight): BEFORE this run dispatches any agents, verify every model it could
    // launch actually resolves to a runnable binary on the SEAT shell's PATH. An interrupted `npm i -g`
    // that drops a CLI off the seat PATH ("binary vanished") otherwise surfaces only as a per-seat generic
    // 30-60s "cli startup timeout" mid-run. Refuse the whole run up-front with a durable, clearly-worded
    // record. Opt-out via HELM_DISABLE_SEAT_PREFLIGHT=1; skipped entirely when no masterRuntime injected.
    if (this.deps.masterRuntime && process.env.HELM_DISABLE_SEAT_PREFLIGHT !== '1') {
      const roster: Array<{ provider: string; model: string }> = [];
      const addSeat = (provider?: string, model?: string) => {
        if (provider && model) roster.push({ provider, model });
      };
      addSeat(discoveryBrain.agent.provider, discoveryBrain.agent.model);
      addSeat(planningBrainProvider, planningBrainModel);
      addSeat(implementationBrain.agent.provider, implementationBrain.agent.model);
      addSeat(implementerProvider, implementerModel);
      addSeat(validatorProvider, validatorModel);
      addSeat(partnerProvider, partnerModel);
      for (const d of deliberationRoster) addSeat(d?.provider, d?.model);
      for (const rt of redTeamAgents) addSeat((rt as any)?.provider, (rt as any)?.model);
      // review #3: also cover every PROVIDER reachable LATER — the transport default (an undefined role
      // binding still launches grok) and the escalation/low-budget RUNG ladders for implementer+validator
      // (resolved after this point). The "binary vanished" failure is PROVIDER-binary-level (all models of
      // a provider share ONE CLI), so a representative registry model per reachable provider covers its
      // rung/per-task variants here; per-task EXPLICIT models are additionally re-checked at the dispatch
      // boundary (makeSeatBinaryVerifier → OrchestratorLoop.verifySeatBinary).
      const reachableProviders = new Set<string>(['grok']); // real-transport default for undefined bindings
      if (this.deps.escalationService) {
        const esc: any = this.deps.escalationService;
        for (const role of ['implementer', 'validator']) {
          for (let rung = 0; rung <= 3; rung++) {
            try { const prov = esc.getProviderForRung?.(role, rung); if (prov) reachableProviders.add(prov); } catch { /* ladder gap — skip */ }
          }
        }
      }
      for (const prov of reachableProviders) {
        const rep = (PROVIDERS as any)[prov]?.models?.[0]?.model;
        if (rep) addSeat(prov, rep);
      }
      try {
        await this.deps.masterRuntime.preflightRunRoster(projectId, roster, effectiveProjectDir);
      } catch (e: any) {
        if (input.precreatedRunId != null) {
          try {
            this.transitionRunToBlocked(input.precreatedRunId, `Seat-binary pre-flight failed: ${e?.message || e}`, project, 'failure', runGenToken);
            const reason = `# Seat-binary pre-flight refused this run (A1a)\n\n${e?.message || e}\n\nA rostered model's launch CLI is not on the seat shell's PATH (the "binary vanished" failure mode). Operator action: reinstall/repair the missing CLI on the seat PATH (verify with \`command -v <bin>\` in a fresh tmux shell), then re-run.`;
            await fs.writeFile(path.join(runDir, 'seat-binary-preflight.md'), reason, 'utf8');
            this.deps.artifacts.recordArtifact(input.precreatedRunId, 'seat-binary-preflight', 'seat-binary-preflight.md');
          } catch {}
        }
        throw e;
      }
    }

    // Seed initial prompt artifacts. A cycle-backed run keeps Discovery's cycle-folder north-star intact;
    // non-cycle autonomous runs author the same canonical filename directly in runDir.
    await this.deps.artifacts.writeBrief(runDir, 'prompt', prompt);
    try {
      await fs.writeFile(path.join(runDir, 'conversation-log.md'), `Initial user prompt:\n${prompt}\n`, 'utf8');
      if (canonicalArtifactRoot === runDir) {
        await fs.writeFile(path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.northStar), prompt, 'utf8');
      }
    } catch {}

    // D-b1: interview phase support. Pre-authored plan.json (test seam) skips to autonomous planning path.
    // CC "start task list" path: enter 'interview', spawn projcore (D-a session) to conduct north-star
    // interview (writes north-star.md + decisions/ from answers), signal NORTH-STAR-READY.
    // Autonomous loop/execution does NOT start until ns-ready + plan authored.
    const planJsonEarly = path.join(runDir, 'plan.json');
    let planPreexists = false;
    try {
      const raw = await fs.readFile(planJsonEarly, 'utf8');
      const p = JSON.parse(raw);
      if (p && Array.isArray(p.tasks) && p.tasks.length > 0) planPreexists = true;
    } catch {}
    if (!planPreexists) {
      try {
        planPreexists = parseExecutionPlan(await fs.readFile(path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.plan), 'utf8')).ok;
      } catch {}
    }

    let runId: number;
    let planningRes: any;

    if (input.cyclePlan && input.cycleId != null && !input.seedPlan) {
      // IS-R1 (impl-start): cycle-plan implementation-only path. Ingest the cycle folder's own
      // canonical plan.md directly into run_tasks and run ONLY the implementation loop — mirrors the
      // seedFromCache structure (phase='executing', precreatedRunId reuse for cycle_id linkage) but
      // sources the plan from the CYCLE, with NO baseline restore, NO interview, NO planning spawn.
      runId = await this.seedFromCyclePlan(input.cycleId, runDir, batchId, projectId, input.precreatedRunId, resolvedCycleWorkspace);
      try { this.deps.artifacts['db'].raw.prepare("UPDATE runs SET phase = 'executing' WHERE id = ? AND phase NOT IN ('complete','failed','blocked')").run(runId); } catch {}
    } else if (input.seedPlan) {
      // PLAN-CACHE Phase-2 replay: restore baseline + ingest cached plan directly; NO projcore/interview/planning.
      runId = await this.seedFromCache(input.seedPlan, runDir, batchId, projectId, effectiveProjectDir, input.precreatedRunId);
      try { this.deps.artifacts['db'].raw.prepare("UPDATE runs SET phase = 'executing' WHERE id = ? AND phase NOT IN ('complete','failed','blocked')").run(runId); } catch {}
    } else if (planPreexists) {
      // Autonomous/skip-interview path (existing tests with pre-seed continue to work)
      // S05: core path resolves panel via PlanningStaffingService even when adaptive_planning=0.
      const coreStaffing = this.resolveCorePlanningStaffing(projectId);
      if (coreStaffing.blockReasons?.length) {
        runId =
          input.precreatedRunId ??
          this.deps.artifacts.createRun(projectId, batchId, path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar));
        const reason = `PLANNING-STAFFING-BLOCKED: ${coreStaffing.blockReasons.join('; ')}`;
        console.warn(`[RunOrchestrator] run ${runId} BLOCKED pre-planning: ${reason}`);
        this.transitionRunToBlocked(runId, reason, project, 'failure', runGenToken);
        return runId;
      }
      const planningSeat = resolveBrain('planning');
      // v93: when adaptive_planning ON, load per-project panel + backup-fallback probe.
      const adaptivePanel = await this.resolveAdaptivePlannerPanel(projectId, effectiveProjectDir);
      const effPartnerModel = coreStaffing.usedPanel ? coreStaffing.partnerModel : partnerModel;
      const effPartnerProvider = coreStaffing.usedPanel ? coreStaffing.partnerProvider : partnerProvider;
      const effBrainModel = coreStaffing.usedPanel && coreStaffing.planningBrainModel
        ? coreStaffing.planningBrainModel
        : planningSeat.agent.model;
      const effBrainProvider = coreStaffing.usedPanel && coreStaffing.planningBrainProvider
        ? coreStaffing.planningBrainProvider
        : planningSeat.agent.provider;
      planningRes = await this.deps.planning.runPlanningPhase({
        runDir,
        batchId,
        northStar: prompt,
        conversationLog: prompt,
        mode: 'auto',
        sessionName: planningSessionName,
        projectId,
        projectDir: effectiveProjectDir,
        brainRole: planningSeat.role,
        planningBrainModel: effBrainModel,
        partnerModel: effPartnerModel,
        planningBrainProvider: effBrainProvider,
        partnerProvider: effPartnerProvider,
        strictReadAllow: runStrictAllow,  // B-ISO1: run-scoped strict read fence for the planning seats
        adaptivePlanning: this.isAdaptivePlanning(projectId),  // v92: opt-in adaptive tiered planner
        // S05 AC20: DB size is N co-planners; A10 API wants total seats (N+1)
        panelSize: coreStaffing.panelSizeTotal,
        // S06: ordered exact co-planner identities from S05 manifest
        ...(coreStaffing.coPlannerSeats?.length
          ? { coPlannerSeats: coreStaffing.coPlannerSeats }
          : {}),
        roundCap: this.resolvePlanningRoundCap(projectId),  // A11: co-planner agreement round cap
        runId: input.precreatedRunId,  // CC-CHAT-1 B2: reuse the detached-precreated run row (no duplicate)
        canonicalArtifactRoot,
        ...(adaptivePanel?.panel ? { panel: adaptivePanel.panel } : {}),
        ...(adaptivePanel?.isModelAvailable ? { isModelAvailable: adaptivePanel.isModelAvailable } : {}),
      });
      runId = planningRes.runId || 0;
      if (!runId) {
        const row: any = this.deps.artifacts['db']?.raw?.prepare('SELECT id FROM runs WHERE batch_id = ? ORDER BY id DESC LIMIT 1').get(batchId);
        runId = row ? Number(row.id) : 0;
      }
      if (!runId) {
        runId = this.deps.artifacts.createRun(projectId, batchId, path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar));
      }
      try { this.deps.artifacts['db'].raw.prepare("UPDATE runs SET phase = 'executing' WHERE id = ? AND phase NOT IN ('complete','failed','blocked')").run(runId); } catch {}
    } else {
      // D-b1 interview path: create run in 'interview', spawn the discovery phase owner for live CC interview.
      // Chat routes to it (index chat checks non-terminal phase incl. interview). Do not start queue loop yet.
      // CC-CHAT-1 B2: reuse the detached-precreated run row when present (no duplicate run rows).
      runId = input.precreatedRunId ?? this.deps.artifacts.createRun(projectId, batchId, path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar));
      try { this.deps.artifacts['db'].raw.prepare("UPDATE runs SET phase = 'interview' WHERE id = ? AND phase NOT IN ('complete','failed','blocked')").run(runId); } catch {}

      // Interview brief: projcore interviews for north-star (incl. per-task model/effort policy per D-b2),
      // writes north-star.md + decisions/ from answers, signals NORTH-STAR-READY. Planning follows.
      const briefWriter = new BriefWriterService();
      const interviewBrief = briefWriter.generateInterviewBrief({
        batchId,
        prompt,
        projectDir: effectiveProjectDir,
        callbacksFile: path.join(runDir, 'callbacks.md'),
        runDir,
        canonicalArtifactRoot,
      });

      // Resolve at the phase boundary so a binding change before dispatch is honored.
      const interviewSeat = resolveBrain('discovery');
      await this.deps.transport.spawn({
        role: interviewSeat.role,
        brief: interviewBrief,
        runDir,
        batchId,
        sessionName: discoverySessionName,
        model: interviewSeat.agent.model,
        provider: interviewSeat.agent.provider,
        attemptId: 0,
        projectDir: effectiveProjectDir,
        ...(runStrictAllow ? { strictReadAllow: runStrictAllow } : {})  // B-ISO1: run-scoped strict read fence on the interview seat
      });

      // Wait for NORTH-STAR-READY (operator + projcore complete the interview). This blocks autonomous start.
      const cbPath = path.join(runDir, 'callbacks.md');
      const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
      const NS_TIMEOUT = parseInt(process.env.HELM_PLANNING_TIMEOUT_MS || (isFake ? '4000' : '300000'), 10);
      const nsReady = await this.waitForNorthStarReady(cbPath, batchId, NS_TIMEOUT, runId);

      // S04 / AC18: waitForNorthStarReady() === false is a typed blocked transition BEFORE Discovery
      // reap, phase mutation to planning, or runPlanningPhase. Success path below stays byte-compatible.
      if (!nsReady) {
        // R5a first: stopped/failed/aborted runs keep the existing active-run assertion (throws).
        this.assertRunActive(runId, 'post-interview');
        const reason =
          'NORTH-STAR-READY wait returned false: Discovery interview did not signal ready; refusing Planning advance (AC18 fail-closed)';
        console.warn(`[RunOrchestrator] run ${runId} BLOCKED post-interview: ${reason}`);
        try {
          await this.deps.artifacts.persistState(runDir, ['interview', 'blocked'], 'blocked', runId);
        } catch { /* best-effort */ }
        this.transitionRunToBlocked(runId, reason, project, 'failure', runGenToken);
        // Leave Discovery session unreaped; do not set phase=planning; do not call runPlanningPhase.
        return runId;
      }

      // R5a: phase boundary (interview → planning). A run stopped/failed during the interview
      // must not advance into planning (the guarded UPDATE below is belt-and-braces).
      this.assertRunActive(runId, 'post-interview');

      // Discovery owns a distinct live-chat session. Reap it before the planning brain starts;
      // planning gets its own name so TmuxService cannot replace one phase seat with another.
      try { await this.deps.transport.reap(`${discoverySessionName}:0.0`, 'discovery-handoff-to-planning'); } catch {}

      // Transition to planning using Discovery's exact canonical north-star + conversation log.
      try { this.deps.artifacts['db'].raw.prepare("UPDATE runs SET phase = 'planning' WHERE id = ? AND phase NOT IN ('complete','failed','blocked')").run(runId); } catch {}

      // Re-read authored artifacts from interview (prefer what projcore wrote during chat)
      let nsForPlan = prompt;
      let convForPlan = prompt;
      try { nsForPlan = await fs.readFile(path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.northStar), 'utf8'); } catch {}
      try { convForPlan = await fs.readFile(path.join(canonicalArtifactRoot, 'conversation-log.md'), 'utf8'); } catch {}

      const planningSeat = resolveBrain('planning');
      // S05: resolve panel on core path (adaptive ON or OFF); never generic planner for configured seats.
      const coreStaffing = this.resolveCorePlanningStaffing(projectId);
      if (coreStaffing.blockReasons?.length) {
        const reason = `PLANNING-STAFFING-BLOCKED: ${coreStaffing.blockReasons.join('; ')}`;
        console.warn(`[RunOrchestrator] run ${runId} BLOCKED pre-planning: ${reason}`);
        this.transitionRunToBlocked(runId, reason, project, 'failure', runGenToken);
        return runId;
      }
      // v93: when adaptive_planning ON, load per-project panel + backup-fallback probe.
      const adaptivePanel = await this.resolveAdaptivePlannerPanel(projectId, effectiveProjectDir);
      const effPartnerModel = coreStaffing.usedPanel ? coreStaffing.partnerModel : partnerModel;
      const effPartnerProvider = coreStaffing.usedPanel ? coreStaffing.partnerProvider : partnerProvider;
      const effBrainModel = coreStaffing.usedPanel && coreStaffing.planningBrainModel
        ? coreStaffing.planningBrainModel
        : planningSeat.agent.model;
      const effBrainProvider = coreStaffing.usedPanel && coreStaffing.planningBrainProvider
        ? coreStaffing.planningBrainProvider
        : planningSeat.agent.provider;
      planningRes = await this.deps.planning.runPlanningPhase({
        runDir,
        canonicalArtifactRoot,
        batchId,
        northStar: nsForPlan,
        conversationLog: convForPlan,
        mode: 'auto',
        sessionName: planningSessionName,
        projectId,
        projectDir: effectiveProjectDir,
        brainRole: planningSeat.role,
        planningBrainModel: effBrainModel,
        partnerModel: effPartnerModel,
        planningBrainProvider: effBrainProvider,
        partnerProvider: effPartnerProvider,
        strictReadAllow: runStrictAllow,  // B-ISO1: run-scoped strict read fence for the planning seats
        adaptivePlanning: this.isAdaptivePlanning(projectId),  // v92: opt-in adaptive tiered planner
        // S05 AC20: DB size is N co-planners; A10 API wants total seats (N+1)
        panelSize: coreStaffing.panelSizeTotal,
        // S06: ordered exact co-planner identities from S05 manifest
        ...(coreStaffing.coPlannerSeats?.length
          ? { coPlannerSeats: coreStaffing.coPlannerSeats }
          : {}),
        roundCap: this.resolvePlanningRoundCap(projectId),  // A11: co-planner agreement round cap
        runId,  // D-b1: reuse the interview-created run (prevents duplicate run row); phase already advanced to planning
        ...(adaptivePanel?.panel ? { panel: adaptivePanel.panel } : {}),
        ...(adaptivePanel?.isModelAvailable ? { isModelAvailable: adaptivePanel.isModelAvailable } : {}),
      });

      // planning may return 0 if pre-created; ensure we have the id (planning creates inside on ingest if not handed)
      if (!planningRes || !planningRes.runId) {
        const row: any = this.deps.artifacts['db']?.raw?.prepare('SELECT id FROM runs WHERE batch_id = ? ORDER BY id DESC LIMIT 1').get(batchId);
        if (row) runId = Number(row.id);
      } else {
        runId = planningRes.runId || runId;
      }

      try { this.deps.artifacts['db'].raw.prepare("UPDATE runs SET phase = 'executing' WHERE id = ? AND phase NOT IN ('complete','failed','blocked')").run(runId); } catch {}
    }

    // E3-writers: mirror initial run-level artifacts under helm_tasks/<list>/run/ (B5) now that runId is set
    if (effectiveProjectDir && runId) {
      try {
        let canonicalNorthStar = prompt;
        try { canonicalNorthStar = await fs.readFile(path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.northStar), 'utf8'); } catch {}
        await this.deps.artifacts.writeToHelmTaskRoot(effectiveProjectDir, runId, batchId, null, 'run', 'prompts/prompt.brief.md', prompt);
        await this.deps.artifacts.writeToHelmTaskRoot(effectiveProjectDir, runId, batchId, null, 'run', CANONICAL_CYCLE_ARTIFACTS.northStar, canonicalNorthStar);
      } catch {}
    }

    // ROBUSTFIX (live run 76 false-complete): a run must NEVER reach the execution loop with zero
    // ingested tasks — that happens when planning times out un-agreed (partner verdict never arrived)
    // and returns without ingesting; the loop then finds nothing and the run "completes" having built
    // NOTHING (E5 summary failed=false). Fail loudly instead so the operator gets a real verdict.
    // Fake/test envs keep their fixture paths (only the explicit agreed===false gate applies there).
    {
      const isFakeEnv = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
      let zeroTasks = false;
      try {
        const row: any = this.deps.artifacts['db'].raw.prepare('SELECT COUNT(*) AS n FROM run_tasks WHERE run_id = ?').get(runId);
        zeroTasks = Number(row?.n || 0) === 0;
      } catch {}
      const notAgreed = !!(planningRes && planningRes.agreed === false);
      if (notAgreed || (!isFakeEnv && zeroTasks)) {
        // A11 (R1.6 + D7): a bounded planning exit (wall-clock timeout / round-cap exhaustion, the SAME
        // mechanism under D7) must be a VISIBLE BLOCKED state that escalates to JROM, never silently
        // recorded as a plain 'failed' run indistinguishable from any other crash. transitionRunToBlocked
        // sets phase='blocked' (kind='failure' keeps status='failed' — this is genuinely a failure, not
        // an operator-recoverable pause) and fires the same notifyBlockedRun alert other blocked paths use.
        const reason = notAgreed
          ? (planningRes?.blockedReason || 'PLANNING-NOT-AGREED: co-planner verdict never arrived (gate blocked); plan not ingested')
          : 'ZERO-TASKS-INGESTED: no run_tasks after planning; refusing vacuous complete';
        console.warn(`[RunOrchestrator] run ${runId} BLOCKED pre-execution: ${reason}`);
        try { await this.deps.artifacts.persistState(runDir, ['interview', 'planning', 'blocked'], 'blocked', runId); } catch {}
        // transitionRunToBlocked also terminalizes the cycle board + finalizes worker_runtimes seat
        // ledger (kind='failure' path) — no need to duplicate those calls here.
        this.transitionRunToBlocked(runId, reason, project, 'failure', runGenToken);
        return runId;
      }
    }

    // POCFIX12: thread implementer/validator bindings as rung-0 overrides into Escalation (before loop). Binding only for rung 0; rungs 1-2 use ladder. no-binding keeps original (grok rung0 for impl).
    if (this.deps.escalationService) {
      if (implementerModel) this.deps.escalationService.setRung0Override('implementer', implementerModel, implementerProvider);
      if (validatorModel) this.deps.escalationService.setRung0Override('validator', validatorModel, validatorProvider);
    }

    // Drive the tasks via existing orchestrator-loop (A2b: real EscalationService + PanelService from deps; enables B8 ladder on 3x + red-team after val PASS using project role_bindings; legacy only if not passed)
    const implementationSeat = resolveBrain('implementation');
    const loop = new OrchestratorLoop(this.deps.transport, {
      runDir,
      batchId,
      artifactService: this.deps.artifacts,
      escalationService: this.deps.escalationService !== undefined ? this.deps.escalationService : null,
      panelService: this.deps.panelService,
      redTeamAgents,
      deliberationRoster,
      projectDir: project.directory,
      projectId,
      runId,  // D-b fix: seed the (planning or interview-precreated) runId so OrchestratorLoop reuses it in runTask; prevents duplicate createRun on skip/autonomous path (and keeps interview path single-row)
      routingConfig: this.deps.routingConfig ?? null,  // A4: consult routing config (A3 seed matches hardcoded FSM => zero behavior change)
      strictReadAllow: runStrictAllow,  // B-ISO1: run-scoped strict read fence for every execution seat the loop spawns
      brainRole: implementationSeat.role,
      brainModel: implementationSeat.agent.model,
      brainProvider: implementationSeat.agent.provider,
      notificationTransport: this.deps.notificationTransport,
      // review #3: per-run cached seat-binary verifier — rechecks the ACTUALLY-resolved per-task/rung seat
      // binary at the dispatch boundary (models resolved after the run-start roster preflight). Absent when
      // no masterRuntime injected (fake-transport tests) → no-op, same as the preflight.
      verifySeatBinary: (this.deps.masterRuntime && process.env.HELM_DISABLE_SEAT_PREFLIGHT !== '1')
        ? this.deps.masterRuntime.makeSeatBinaryVerifier(project.directory)
        : undefined
    });

    // helm-algo owns execution from here — reap the planning-brain session so it CANNOT keep working past
    // PLAN-READY (runaway / token-burn guard; the brain is re-spawned on demand for decisions only).
    try { await this.deps.transport.reap(`${planningSessionName}:0.0`, 'planning-done-yield-to-algo'); } catch {}
    // A15: tmux reap alone left worker_runtimes state=running/ended_at NULL (A1 insert, never finalize).
    // Finalize ALL non-terminal seats for this run at planning-done yield (plancore + partner).
    await this.finalizeRunWorkerRuntimes(runId, 'planning-done-yield-to-algo', runGenToken);

    // A5 / R3.13: production finishPlanning at planning-done. Only on the real planning path
    // (not cyclePlan / seedPlan skip paths — those never ran planning). Resolves cycle id from
    // input or the run row. N7: CONFLICT is swallowed so a second call cannot fail the run.
    // A6 / R3.14 honours pause_after_planning as a queue gate right below (isCycleGateParked).
    if (!input.cyclePlan && !input.seedPlan) {
      let planningDoneCycleId: number | null =
        input.cycleId != null && Number.isFinite(Number(input.cycleId)) ? Number(input.cycleId) : null;
      if (planningDoneCycleId == null && runId != null) {
        try {
          const r = this.deps.artifacts['db'].raw
            .prepare('SELECT cycle_id FROM runs WHERE id = ?')
            .get(runId) as any;
          if (r?.cycle_id != null) planningDoneCycleId = Number(r.cycle_id);
        } catch { /* leave null */ }
      }
      this.finishPlanningAtPlanningDone(planningDoneCycleId);

      // A6 / R3.14: honour the pause_after_planning gate. finishPlanning (just above) may have
      // flipped the cycle to awaiting_approval — if so, this run's job (produce a plan) is done;
      // park it here instead of falling into runEngineTail. approveCycle (POST /api/cycles/:id/approve)
      // starts a fresh cyclePlan run against the same plan.md once JROM approves.
      if (this.isCycleGateParked(planningDoneCycleId)) {
        await this.parkRunAwaitingApproval(runId, runDir, planningDoneCycleId as number, project, runGenToken);
        return runId;
      }
    }

    // R5a: phase boundary (planning → executing). Never start the dispatch loop for a run
    // that went terminal during planning.
    this.assertRunActive(runId, 'pre-execution');

    return this.runEngineTail(runId, runDir, batchId, project, loop, this.deps.queue, {
      projectId,
      prompt,
      redTeamAgents,
      runStrictAllow,
      effectiveProjectDir,
      implementationSessionName,
      implementationBrainProvider: implementationSeat.agent.provider,
      implementationBrainModel: implementationSeat.agent.model,
      expectedGeneration: runGenToken,
    });
  }

  /** Shared post-ingestion engine: dispatch, stall classification, final gates, and terminalization. */
  private async runEngineTail(
    runId: number,
    runDir: string,
    batchId: string,
    project: any,
    loop: OrchestratorLoop,
    queue: TaskQueueService,
    context: {
      projectId: number;
      prompt: string;
      redTeamAgents: Array<{ role: string; agent_id?: number; model?: string; provider?: string }>;
      runStrictAllow?: string[];
      effectiveProjectDir: string;
      implementationSessionName: string;
      implementationBrainProvider: string;
      implementationBrainModel: string;
      /** B04 fix cycle 2 (validator V1): captured runs.generation when reached via startRunDetached. */
      expectedGeneration?: number;
    }
  ): Promise<number> {
    const {
      projectId, prompt, redTeamAgents, runStrictAllow, effectiveProjectDir,
      implementationSessionName, implementationBrainProvider, implementationBrainModel,
      expectedGeneration
    } = context;

    // B11-T03: extracted to drainDispatch for re-entrancy in final-tests→fix loop.
    // Behavior-preserving refactor (REINFORCEMENT 1): body identical to pre-B11-T03 while.
    await this.drainDispatch(runId, runDir, batchId, project, loop, queue, expectedGeneration);

    // Leg D §4 (D3b) pending-after-drain: getNextReady()===null is NEVER completion. Classify the drain
    // result (cycle / deferred-block / failed-block / unknown-pending-stall / all-complete) as ONE terminal
    // decision. For classes 1–4 the run is blocked (phase=blocked, status=failed), pending-after-drain.md is
    // written, and we RETURN before final tests / run-final red-team / generic completion — a later generic
    // `complete` must not be written. Subsumes the old B10-T02 deadlock + B10-T05 parked guards (which set
    // phase=blocked but let downstream completion logic continue — the exact false-green this fixes).
    if (await this.handlePendingAfterDrain(runId, runDir, batchId, queue, expectedGeneration)) {
      return runId;
    }

    // B11-T03: Final Tests + fix loop control (R-G2/R-F3).
    // After B10 guards, run final gate (which may inject issue fix tasks on FAIL).
    // If injected, drain the fixes (re-enters Implementation; B10-T04 repro applies because task_type=issue).
    // Re-run gate after drain. Recurrence sig + MAX_FIX_ITERS backstop ensure termination (never silent green on still-failing finals).
    let fixIters = 0;
    const MAX_FIX_ITERS = 3;
    let lastGateOutcome: any = null;
    try {
      const r = this.deps.artifacts['db'].raw.prepare('SELECT cycle_id FROM runs WHERE id=?').get(runId) as any;
      if (r && r.cycle_id != null) {
        const c = this.deps.artifacts['db'].raw.prepare('SELECT final_tests_enabled FROM cycles WHERE id=?').get(r.cycle_id) as any;
        if (c && Number(c.final_tests_enabled) !== 0) {
          while (fixIters < MAX_FIX_ITERS) {
            fixIters++;
            lastGateOutcome = await this.maybeRunFinalTestsGate({ runId, runDir, batchId, project, loop, queue, expectedGeneration });
            if (!lastGateOutcome || !lastGateOutcome.injected) {
              break;
            }
            // Loop back: drain the newly injected issue fix task(s)
            await this.drainDispatch(runId, runDir, batchId, project, loop, queue, expectedGeneration);
          }
          // REINFORCEMENT 2: MAX backstop must FAIL-SAFE VISIBLY — never let still-failing finals silently complete green.
          if (fixIters >= MAX_FIX_ITERS && lastGateOutcome && lastGateOutcome.verdict !== 'PASS') {
            await this.doMaxFixItersVisiblePause(runId, runDir, batchId, path.join(runDir, 'callbacks.md'), lastGateOutcome, expectedGeneration);
          }
        }
      }
    } catch {}

    // A2b: convene red-team at run-final (reuse B10 PanelService; in addition to per-task after val PASS inside loop)
    // Persists verdict as run event (artifacts table + red-team-final.json) for timeline; on BROKEN mark run failed (correction route)
    // FIX-C: only if ≥1 task completed (otherwise skip to avoid early baseline BROKEN when all failed due to prior RC)
    const anyCompleted = queue.hasCompleted(runId);
    if (this.deps.panelService && runId && anyCompleted && process.env.HELM_SKIP_REDTEAM !== '1') {
      try {
        const finalReq = prompt;
        const finalDiff = 'aggregate run changes (see per-task changes.md + git diff + artifacts in ' + runDir + ')';
        const rtFinal = await this.deps.panelService.conveneRedTeamPanel({
          runDir,
          batchId: `${batchId}-run-final`,
          implementedDiff: finalDiff,
          requirement: finalReq,
          nConsecutiveClean: 1,
          redTeamAgents,
          projectDir: project.directory,  // POCFIX19: fence run-final red-team to the project dir
          ...(runStrictAllow ? { strictReadAllow: runStrictAllow } : {}),  // B-ISO1: run-scoped strict read fence on run-final red-team seats
        });
        try {
          const artDir = path.join(runDir, 'artifacts');
          await fs.mkdir(artDir, { recursive: true });
          await fs.writeFile(path.join(artDir, 'red-team-final.json'), JSON.stringify(rtFinal, null, 2), 'utf8');
          this.deps.artifacts.recordArtifact(runId, 'red-team-final', 'artifacts/red-team-final.json');
        } catch {}
        if (rtFinal.state === 'BROKEN') {
          try { this.deps.artifacts['db'].raw.prepare("UPDATE runs SET status = 'failed' WHERE id = ?").run(runId); } catch {}
          if (this.deps.artifacts) {
            // mirror loop per-task red BROKEN (orchestrator-loop.ts:434) so run-final red-team BROKEN is persisted in validations (a2bRedBrk test asserts this)
            let attemptId = 0;
            try {
              const row = this.deps.artifacts['db'].raw.prepare('SELECT ta.id FROM task_attempts ta JOIN run_tasks rt ON ta.task_id = rt.id WHERE rt.run_id = ? LIMIT 1').get(runId) as any;
              if (row && row.id) attemptId = row.id;
            } catch {}
            this.deps.artifacts.recordValidation(attemptId, 'FAIL', `red-team BROKEN: ${rtFinal.note || rtFinal.state}`);
          }
        }
      } catch {}
    }

    // C3: raise ALL deferred/not-reproducible issues at run end (the single place they surface to operator).
    // Continue queue past deferred (already handled); list here for visibility + persist artifact.
    let hadDeferred = false;
    let hadFailed = false;
    let failedRows: any[] = [];
    try {
      const deferredRows: any[] = this.deps.artifacts['db'].raw
        .prepare("SELECT id, task_key, label FROM run_tasks WHERE run_id = ? AND status = 'deferred' ORDER BY id")
        .all(runId);
      hadDeferred = deferredRows.length > 0;
      if (hadDeferred) {
        const lines = deferredRows.map((d: any) => `- ${d.task_key || ('T'+d.id)}: ${d.label || ''} (status=deferred, NOT-REPRODUCIBLE)`).join('\n');
        const summary = `# Deferred Issues (raised at run completion)\n\nRun: ${runId} batch ${batchId}\n\n${lines}\n\nThese issues did not reproduce after retry; they were not blocking to independent tasks.\n`;
        console.log(`[RunOrchestrator] DEFERRED ISSUES surfaced at end for run ${runId}:\n${lines}`);
        await fs.mkdir(runDir, { recursive: true });
        await fs.writeFile(path.join(runDir, 'deferred-issues.md'), summary, 'utf8');
        this.deps.artifacts.recordArtifact(runId, 'deferred-issues', 'deferred-issues.md');
      }
      failedRows = this.deps.artifacts['db'].raw
        .prepare("SELECT id, task_key, label FROM run_tasks WHERE run_id = ? AND status = 'failed' ORDER BY id")
        .all(runId);
      hadFailed = failedRows.length > 0;
    } catch {}

    // E5: completion summary with failed + deferred + evidence + helm_tasks links. Do not overwrite terminal signals.
    try {
      const db = this.deps.artifacts['db'].raw;
      // gather verified reqs (from req-matrix if present)
      let verified: string[] = [];
      try {
        const mx = await fs.readFile(path.join(runDir, 'req-matrix.md'), 'utf8');
        for (const line of mx.split('\n')) {
          if (line.includes('VERIFIED')) verified.push(line.trim());
        }
      } catch {}
      // evidence: recent validator/reviewer notes from validations for this run
      let evidenceLines: string[] = [];
      try {
        const ev = db.prepare(`
          SELECT v.result, v.note, rt.task_key, rt.label
          FROM validations v
          JOIN task_attempts ta ON v.attempt_id = ta.id
          JOIN run_tasks rt ON ta.task_id = rt.id
          WHERE rt.run_id = ?
          ORDER BY v.id DESC LIMIT 20
        `).all(runId) as any[];
        for (const e of ev) {
          if (e.note || e.result) {
            evidenceLines.push(`- T${e.task_key || ''}: ${e.result} ${e.note ? '— ' + String(e.note).slice(0,200) : ''}`);
          }
        }
      } catch {}
      // links to helm_tasks -- use getTaskArtifactRoot (single source of truth) so writer dirs and summary links NEVER diverge
      const listSlug = (batchId || `run${runId}`).replace(/[^a-z0-9_-]/gi, '_');
      const linkBase = `helm_tasks/${listSlug}`;
      const failedList = failedRows.map((f: any) => {
        // compute exact subdir using the helper (taskKey preferred, else task<id>)
        const full = this.deps.artifacts.getTaskArtifactRoot('/_b', runId, batchId, f.id, f.task_key || null);
        // `sub` already includes the <tasklist>/<task> segments (helper output after helm_tasks/),
        // so prefix only `helm_tasks/` — NOT linkBase (which re-adds <tasklist> → duplicated segment).
        const sub = full.split('/_b/helm_tasks/')[1] || `${listSlug}/` + (f.task_key || `task${f.id}`).replace(/[^a-z0-9_-]/gi, '_');
        return `- ${f.task_key || 'T'+f.id}: ${f.label || ''}  → helm_tasks/${sub}/`;
      }).join('\n');
      const deferredList = hadDeferred ? (await (async () => { try { return await fs.readFile(path.join(runDir,'deferred-issues.md'),'utf8'); } catch {return ''} })()) : '';
      // #50B (bounded): surface any PLAN-CONTRADICTION a worker flagged — even on tasks that PASSED by
      // routing around the broken plan. Waking ibrain on a passing task is a churn risk (deferred to a
      // design pass), so this is VISIBILITY, not action: the plan defect lands in the summary for the
      // operator instead of dying in a run_event. run_events.run_id is TEXT → query with String(runId).
      let contradictionList = '(none)';
      try {
        const cRows = this.deps.artifacts['db'].raw.prepare(
          "SELECT payload_json FROM run_events WHERE run_id = ? AND event_type = 'PLAN_CONTRADICTION' ORDER BY id"
        ).all(String(runId)) as any[];
        if (cRows.length) {
          contradictionList = cRows.map((r) => {
            try { const p = JSON.parse(r.payload_json || '{}');
              return `- ${p.blocked ? 'BLOCKED' : 'resolved'}: "${(p.task_instruction||'').slice(0,120)}" vs "${(p.requirement||'').slice(0,120)}"${p.resolved_as ? ' → '+String(p.resolved_as).slice(0,80) : ''}`;
            } catch { return `- ${String(r.payload_json||'').slice(0,180)}`; }
          }).join('\n') + `\n\n(A resolved contradiction means a worker shipped correct code but the PLAN is still wrong for downstream tasks — consider a re-plan.)`;
        }
      } catch { /* best-effort */ }
      const summary = [
        `# Run Completion Summary`,
        ``,
        `run_id: ${runId}`,
        `batch: ${batchId}`,
        `status: ${hadFailed ? 'failed' : (hadDeferred ? 'complete (with deferred)' : 'complete')}`,
        ``,
        `## Verified Requirements`,
        verified.length ? verified.join('\n') : '(see req-matrix.md or none)',
        ``,
        `## FAILED Tasks`,
        hadFailed ? failedList : '(none)',
        ``,
        `## DEFERRED Issues`,
        hadDeferred ? deferredList : '(none)',
        ``,
        `## Plan Contradictions (surfaced — #50B)`,
        contradictionList,
        ``,
        `## Validator + Reviewer Evidence`,
        evidenceLines.length ? evidenceLines.join('\n') : '(none recorded)',
        ``,
        `## Helm Task Artifacts`,
        `Per-task artifacts written under: ${linkBase}/<task>/ (prompts/, final.json, changes.md, ...)`,
        `Use getTaskArtifactRoot or list project helm_tasks/ tree.`,
        ``
      ].join('\n');
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, 'completion-summary.md'), summary, 'utf8');
      this.deps.artifacts.recordArtifact(runId, 'completion-summary', 'completion-summary.md');
      // also mirror to helm root for run
      if (effectiveProjectDir) {
        try {
          await this.deps.artifacts.writeToHelmTaskRoot(effectiveProjectDir, runId, batchId, null, 'run', 'completion-summary.md', summary);
        } catch {}
      }
      console.log(`[RunOrchestrator] E5 completion-summary written for run ${runId} (failed=${hadFailed} deferred=${hadDeferred})`);
    } catch (e:any) { /* non fatal */ }

    // Terminal: preserve failed/deferred signals; do not generic-overwrite
    // B04 fix cycle 2 (validator V1): this whole block executes inside the SAME fire-and-forget
    // continuation startRunDetached launches — gate the terminal UPDATE + both finalizers on the
    // captured generation exactly as the detached-start-failed catch does.
    // B04 fix cycle 3 (validator V3): when gated, ALSO check changes and return before
    // persistState/terminalizeCycleAtRunEnd/the finalizers — mirroring transitionRunToBlocked's own
    // `if (changed.changes !== 1) return` and the detached-start-failed catch's `casApplied` gate.
    // Previously the UPDATE gained the generation predicate but its result was discarded, so a stale
    // continuation still fell through to terminalizeCycleAtRunEnd and flipped the RECYCLED occupant's
    // cycle board to 'complete' even though the worker/brain finalizers below were correctly gated.
    const finalRunStatus = hadFailed ? 'failed' : 'complete';
    const finalPhase = hadFailed ? 'failed' : 'complete';
    const genGated = expectedGeneration != null && Number.isFinite(Number(expectedGeneration));
    if (genGated) {
      let casApplied = false;
      try {
        const result = this.deps.artifacts['db'].raw
          .prepare(`UPDATE runs SET phase = ?, status = ?, ended_at = datetime('now') WHERE id = ? AND generation = ? AND phase NOT IN ('complete','failed','blocked')`)
          .run(finalPhase, finalRunStatus, runId, expectedGeneration) as { changes?: number };
        casApplied = Number(result?.changes || 0) === 1;
      } catch { /* casApplied stays false — treat as stale, do not fall through */ }
      if (!casApplied) {
        console.warn(
          `[run-orchestrator] runEngineTail terminal for run ${runId} generation ${expectedGeneration} is stale/already-terminal — skipping persistState/cycle/worker/brain terminal bookkeeping`
        );
        return runId;
      }
    } else {
      try {
        this.deps.artifacts['db'].raw
          .prepare(`UPDATE runs SET phase = ?, status = ?, ended_at = datetime('now') WHERE id = ? AND phase NOT IN ('complete','failed','blocked')`)
          .run(finalPhase, finalRunStatus, runId);
      } catch {}
    }
    try {
      await this.deps.artifacts.persistState(runDir, ['interview', 'planning', 'executing', finalPhase], finalRunStatus, runId);
    } catch {}
    // A7 / R3.15: success or task-failed completion advances the cycle board to terminal `complete`.
    this.terminalizeCycleAtRunEnd({ runId });
    // A15: seat ledger clean on run terminal (success or task-failed).
    await this.finalizeRunWorkerRuntimes(runId, hadFailed ? 'run-failed' : 'run-complete', expectedGeneration);

    // S03 / AC24: ibrain completion assertion at true run terminal ONLY.
    // finalizeBrainSessionRow → finalizeWorkerRuntimeRow → S02 markIdle. No tmux reap (D-a3 below).
    this.assertImplementationBrainComplete({
      projectId,
      runId,
      session: implementationSessionName,
      reason: hadFailed ? 'run-failed' : 'run-complete',
      state: hadFailed ? 'failed' : 'done',
      provider: implementationBrainProvider,
      model: implementationBrainModel,
      expectedGeneration,
    });

    // D-a3: do NOT reap on completion (was silent reap). Instead set the close-confirm state
    // (an ibrain master_runtimes row with no closed_reason yet).
    // This makes completion prompt the operator (UI banner + POST /api/projects/:id/master/close)
    // rather than silently killing the session. Next-run reuses/relaunches the named session.
    try {
      const sess = implementationSessionName;
      const markerRun = `ibrain:${runId}`;
      // B-ISO1 (sol wiring review-2 fix #1): this INSERT OR REPLACE rewrites the singleton master row as
      // state='running' with NO closed_reason (the close-confirm marker), so the supervisor treats it as
      // respawn-eligible. It MUST carry THIS run's validated policy (runStrictAllow) — NOT a read-back of a
      // prior row: the current strict run's allowlist was never written to the master row, so a read-back
      // would write NULL (no prior row) or a STALE/wrong allowlist (a different prior policy). We record
      // the CURRENT run's fence explicitly (JSON, or NULL when the run isn't strict) so supervisor recovery
      // respawns the retained implementation brain behind the same fence the run actually used.
      const runStrictJson = runStrictAllow !== undefined ? JSON.stringify(runStrictAllow) : null;
      this.deps.artifacts['db'].raw.prepare(
        `INSERT OR REPLACE INTO master_runtimes (project_id, master_run_id, tmux_session, tmux_pane, provider, model, state, role, closed_reason, strict_read_allow, updated_at)
         VALUES (?, ?, ?, '0.0', ?, ?, 'running', 'ibrain', NULL, ?, datetime('now'))`
      ).run(projectId, markerRun, sess, implementationBrainProvider, implementationBrainModel, runStrictJson);
    } catch {}

    return runId;
  }

  /**
   * Resume a terminal blocked run from durable run_tasks + plan.json state. Setup is awaited so callers
   * receive validation/conflict errors; the shared engine tail continues in the background under a
   * per-run in-process lock.
   */
  async resumeExistingRun(runId: number): Promise<{ runId: number }> {
    const db = this.deps.artifacts['db'].raw;
    const run: any = db.prepare(
      'SELECT id, project_id, cycle_id, batch_id, north_star_ref, phase, status FROM runs WHERE id = ?'
    ).get(runId);
    if (!run) throw new Error('run not found');
    // #52: a run halted for an operator-recoverable reason is status='paused' (not 'failed'); both are
    // resumable once the operator has addressed the cause (added config / relogged grok in).
    if (run.phase !== 'blocked' || (run.status !== 'failed' && run.status !== 'paused')) {
      throw new Error(`run ${runId} is not resumable: expected phase=blocked/status in (failed,paused), got phase=${run.phase}/status=${run.status}`);
    }
    if (this.recoveryLocks.has(runId)) throw new Error(`run ${runId} resume is already in progress`);
    this.recoveryLocks.add(runId);

    try {
      const liveWorker: any = db.prepare(
        "SELECT id, state FROM worker_runtimes WHERE run_id = ? AND state IN ('launching','running') ORDER BY id LIMIT 1"
      ).get(runId);
      if (liveWorker) throw new Error(`run ${runId} has a live worker seat (${liveWorker.id}, ${liveWorker.state})`);

      const workingTask: any = db.prepare(
        "SELECT id, task_key FROM run_tasks WHERE run_id = ? AND status = 'working' ORDER BY id LIMIT 1"
      ).get(runId);
      if (workingTask) throw new Error(`run ${runId} has a working task (${workingTask.task_key || workingTask.id})`);

      const projectId = Number(run.project_id);
      if (!Number.isInteger(projectId) || projectId <= 0) throw new Error(`run ${runId} has no resumable project`);
      let project = this.deps.projectService.getProject(projectId);
      if (!project) throw new Error(`run ${runId} references unknown project ${projectId}`);

      const northStarRef = String(run.north_star_ref || '').trim();
      if (!northStarRef) throw new Error(`run ${runId} has no north_star_ref; cannot resolve its plan directory`);
      const resolvedRef = path.resolve(northStarRef);
      let runDir = path.dirname(resolvedRef);
      try {
        if ((await fs.stat(resolvedRef)).isDirectory()) runDir = resolvedRef;
      } catch { /* plan existence below is the authoritative recovery check */ }
      const planPath = path.join(runDir, 'plan.json');
      try { await fs.access(planPath); }
      catch { throw new Error(`run ${runId} plan.json not found at ${planPath}`); }
      const plan: any = await this.deps.parser.loadPlanFromRunDir(runDir);
      if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
        throw new Error(`run ${runId} plan.json has no tasks`);
      }

      const taskRows: any[] = db.prepare(
        'SELECT id, task_key, label, batch, status, attempts_count, current_attempt_id FROM run_tasks WHERE run_id = ? ORDER BY id'
      ).all(runId);
      if (taskRows.length === 0) throw new Error(`run ${runId} has no durable run_tasks to resume`);

      const planByKey = new Map<string, any>();
      for (const task of plan.tasks) {
        const key = String(task?.task_key || '').trim();
        if (!key) throw new Error(`run ${runId} plan contains a task without task_key`);
        if (planByKey.has(key)) throw new Error(`run ${runId} plan contains duplicate task_key ${key}`);
        planByKey.set(key, task);
      }
      const rowByKey = new Map<string, any>();
      for (const row of taskRows) {
        const key = String(row.task_key || '').trim();
        if (!key) throw new Error(`run ${runId} run_task ${row.id} has no task_key`);
        if (rowByKey.has(key)) throw new Error(`run ${runId} has duplicate run_tasks task_key ${key}`);
        if (!planByKey.has(key)) throw new Error(`run ${runId} run_task ${key} is missing from plan.json`);
        rowByKey.set(key, row);
      }
      for (const key of planByKey.keys()) {
        if (!rowByKey.has(key)) throw new Error(`run ${runId} plan task ${key} has no matching run_tasks row`);
      }

      // Rehydrate the ONE dependency-injected queue used by normal starts, dynamic injection, final-test
      // task insertion, and every status writer. A second recovery-only queue makes those paths diverge.
      const queue = this.deps.queue;
      queue.clearRun(runId);
      for (const row of taskRows) {
        const task = planByKey.get(String(row.task_key));
        const depIds = (Array.isArray(task?.deps) ? task.deps : []).map((dep: any) => {
          const depRow = rowByKey.get(String(dep));
          if (!depRow) throw new Error(`run ${runId} task ${row.task_key} depends on unknown task ${String(dep)}`);
          return Number(depRow.id);
        });
        // Batch authority is durable run_tasks.batch, never plan array order or plan batch metadata.
        queue.enqueue(runId, Number(row.id), depIds, false, row.batch == null ? 'default' : String(row.batch));
      }
      for (const row of taskRows) {
        queue.rehydrateTaskStatus(Number(row.id), row.status as 'pending' | 'complete' | 'failed' | 'deferred');
      }

      // Reactivate exactly one parked task: the one that becomes the deterministic first ready task while
      // all other durable statuses remain seeded. A resume can therefore never jump a batch barrier.
      let parked: any = null;
      for (const candidate of taskRows.filter((row) => row.status === 'deferred')) {
        queue.rehydrateTaskStatus(Number(candidate.id), 'pending');
        if (queue.peekNextReady(runId) === Number(candidate.id)) {
          parked = candidate;
          break;
        }
        queue.rehydrateTaskStatus(Number(candidate.id), 'deferred');
      }
      if (!parked) {
        throw new Error(`run ${runId} has no deferred task that can be resumed as the first ready task`);
      }
      const firstReady = queue.peekNextReady(runId);
      if (firstReady !== Number(parked.id)) {
        throw new Error(`run ${runId} recovery queue invariant failed: expected first-ready ${parked.id}, got ${firstReady ?? 'none'}`);
      }

      const batchId = String(run.batch_id || `run-${runId}`);
      let prompt = '';
      try { prompt = await fs.readFile(resolvedRef, 'utf8'); }
      catch {
        try { prompt = await fs.readFile(path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar), 'utf8'); } catch {}
      }
      const slug = (project.name || 'proj').toLowerCase().replace(/[^a-z0-9]+/g, '_');
      const implementationSessionName = `helm-ibrain-${slug}`;
      const runStrictAllow = resolveDeploymentStrictReadAllow();
      if (runStrictAllow !== undefined) makeStrictReadProfileEnv(runStrictAllow);

      let redTeamAgents: Array<{ role: string; agent_id?: number; model?: string; provider?: string }> = [];
      if (this.deps.assignmentService) {
        const resolved = this.deps.assignmentService.resolveProjectRole(projectId, 'red-team');
        if (resolved?.roster?.length) {
          redTeamAgents = resolved.roster.map((r: any) => ({
            role: 'red-team', model: r.model, provider: r.provider, position: r.position, lens: r.lens
          }));
        } else {
          redTeamAgents = this.deps.assignmentService.resolveProjectRoleBindings(projectId, ['red-team', 'panelist'])
            .map((r: any) => ({ role: r.role, agent_id: r.agent_id, model: r.agent.model, provider: r.agent.provider }));
        }
      }

      const loop = new OrchestratorLoop(this.deps.transport, {
        runDir,
        batchId,
        artifactService: this.deps.artifacts,
        escalationService: this.deps.escalationService !== undefined ? this.deps.escalationService : null,
        panelService: this.deps.panelService,
        redTeamAgents,
        projectDir: project.directory,
        projectId,
        runId,
        routingConfig: this.deps.routingConfig ?? null,
        strictReadAllow: runStrictAllow,
        notificationTransport: this.deps.notificationTransport,
        verifySeatBinary: (this.deps.masterRuntime && process.env.HELM_DISABLE_SEAT_PREFLIGHT !== '1')
          ? this.deps.masterRuntime.makeSeatBinaryVerifier(project.directory)
          : undefined,
      });
      const implementationBrain = new PhaseStaffingService(this.deps.assignmentService)
        .resolvePhaseAgents(projectId, 'implementation').brain;
      if (!implementationBrain) throw new Error('required brain unavailable for phase implementation');

      // Last setup action before dispatch: atomically re-open the parked task and the independently-terminal
      // run status. Historical attempts/dispatches/validations/callbacks/artifacts remain untouched.
      const unblock = db.transaction(() => {
        const taskChange = db.prepare(
          "UPDATE run_tasks SET status='pending', attempts_count=0, current_attempt_id=NULL, updated_at=datetime('now') WHERE id=? AND run_id=? AND status='deferred'"
        ).run(parked.id, runId);
        if (taskChange.changes !== 1) throw new Error(`run ${runId} parked task ${parked.id} changed before resume`);
        const runChange = db.prepare(
          "UPDATE runs SET phase='executing', status='active', ended_at=NULL WHERE id=? AND phase='blocked' AND status IN ('failed','paused')"
        ).run(runId);
        if (runChange.changes !== 1) throw new Error(`run ${runId} terminal state changed before resume`);
      });
      unblock();
      clearRunAbort(runId);

      const drive = this.runEngineTail(runId, runDir, batchId, project, loop, queue, {
        projectId,
        prompt,
        redTeamAgents,
        runStrictAllow,
        effectiveProjectDir: project.directory,
        implementationSessionName,
        implementationBrainProvider: implementationBrain.agent.provider,
        implementationBrainModel: implementationBrain.agent.model,
      });
      void drive.catch((e: any) => {
        console.error(`[run-orchestrator] resumed engine tail failed for run ${runId}: ${e?.stack || e?.message || e}`);
        this.transitionRunToBlocked(runId, `Resumed engine tail failed: ${e?.message || e}`, project);
      }).finally(() => {
        this.recoveryLocks.delete(runId);
      });
      return { runId };
    } catch (e) {
      this.recoveryLocks.delete(runId);
      throw e;
    }
  }

  async getRunStatus(projectId: number, runId: number): Promise<RunStatus> {
    const run: any = this.deps.artifacts['db'].raw.prepare('SELECT * FROM runs WHERE id = ?').get(runId);
    if (!run) throw new Error('run not found');
    if (run.project_id != null && run.project_id !== projectId) {
      // allow cross for test simplicity; strict would 403
    }
    const tasks = this.deps.artifacts['db'].raw.prepare('SELECT * FROM run_tasks WHERE run_id = ? ORDER BY id').all(runId) as any[];
    const current = tasks.find((t: any) => t.status === 'working') || tasks.find((t: any) => t.status === 'pending') || (tasks.length ? tasks[tasks.length-1] : null);
    const phase = run.phase || (run.status === 'complete' ? 'complete' : 'executing');
    return {
      runId: Number(run.id),
      phase,
      status: run.status,
      tasks,
      current: current ? { id: current.id, label: current.label, status: current.status } : null
    };
  }

  // R5b (CC-CHAT-4): sanctioned stop for POST /api/runs/:id/stop.
  // 1) flips the in-memory abort flag FIRST (the loop's waitForCallback consults it every poll
  //    cycle, so stop lands within ~1s even mid-wait),
  // 2) marks the run terminal in the DB (runs.status CHECK only allows complete/failed →
  //    'failed'; the stop reason is recorded as an agent_events row since runs has no
  //    stop_reason column),
  // 3) best-effort reaps any live run worker sessions + marks their worker_runtimes rows —
  //    covers the orphan case where the run's loop died with a previous process (the live-loop
  //    case is also reaped by the loop's own abort path).
  async stopRun(runId: number, reason?: string): Promise<{ ok: boolean; alreadyTerminal?: boolean; phase: string; status: string; reapedWorkers: number }> {
    const db = this.deps.artifacts['db'].raw;
    const run: any = db.prepare('SELECT id, project_id, phase, status FROM runs WHERE id = ?').get(runId);
    if (!run) throw new Error('run not found');
    if (TERMINAL_RUN_PHASES.includes(String(run.phase)) || TERMINAL_RUN_STATUSES.includes(String(run.status))) {
      return { ok: true, alreadyTerminal: true, phase: run.phase, status: run.status, reapedWorkers: 0 };
    }
    const stopReason = (reason && String(reason).trim()) || 'operator stop via POST /api/runs/:id/stop';
    const { requestRunAbort } = await import('./run-abort-registry.js');
    requestRunAbort(runId, stopReason);
    // A6b-L3 (send-back): do NOT clearRun(runId) here. This run's own background dispatch (drainDispatch
    // awaiting a real implementer/validator callback, real wallMs up to 30min) is typically still in
    // flight when stop is requested — it only unwinds on its next abort-registry poll. A clearRun called
    // HERE, at stop-time, has no way to know whether THIS SAME runId has already been recycled by a brand
    // new run by the time it runs (SQLite reuses a freed runs.id after CASCADE delete) — proven live: it
    // can wipe a NEWER occupant's already-ingested queue out from under it (getNextReady sees an empty
    // queue despite genuinely-pending durable run_tasks — classifyDrainState's queue/DB-divergence
    // fail-safe reports `unknown-pending-stall` with zero attempts even though the new run never
    // dispatched). The three CLAIM-TIME clears (startRunDetached, startRunInner's precreatedRunId
    // belt-and-braces, seedFromCyclePlan) already fully cover "a recycled runId must not inherit a prior
    // occupant's stuck inFlight/failed/allTasks" — they fire at the one safe moment: right before the NEW
    // occupant starts using the id, never racing a stop that targets a still-live but soon-to-be-recycled
    // slot. TaskQueueService's runEpoch/taskEpoch guard on mark* is the remaining defense-in-depth for a
    // stale write that still lands after a claim-time clear.
    db.prepare(`UPDATE runs SET phase = 'failed', status = 'failed', ended_at = datetime('now') WHERE id = ? AND phase NOT IN ('complete','failed','blocked')`).run(runId);
    // A7 / R3.15: operator stop is a true terminal — board must not stay planning/implementation.
    this.terminalizeCycleAtRunEnd({ runId });
    try {
      this.deps.events?.recordEvent({
        run_id: String(runId),
        role: 'owner',
        batch_id: `chat-${run.project_id}`,
        session: null,
        type: 'status',
        state: 'STOPPED',
        source: 'post',
        correlation_id: `run-stop:${runId}:${Date.now()}`,
        body: { text: `run ${runId} stopped by operator`, kind: 'run-stop', stop_reason: stopReason }
      });
    } catch { /* stop-reason note is best-effort */ }
    // A15: shared finalizeRunWorkerRuntimes (was inline UPDATE; now shared writer + reap).
    const reapedWorkers = await this.finalizeRunWorkerRuntimes(runId, 'run-stopped');
    // Pre-executing phases (starting/interview/planning): the active party is the phase-brain
    // session, not a worker_runtimes row — reap it too so a stopped
    // interview doesn't leave a live TUI burning tokens. (In 'executing' the normal flow already
    // reaped it at 'planning-done-yield-to-algo'.)
    const priorPhase = String(run.phase);
    if (['starting', 'interview', 'planning'].includes(priorPhase)) {
      try {
        const proj: any = db.prepare('SELECT name, plancore_session FROM projects WHERE id = ?').get(run.project_id);
        if (proj) {
          const pslug = (proj.name || 'proj').toLowerCase().replace(/[^a-z0-9]+/g, '_');
          const sess = priorPhase === 'interview'
            ? `helm-discovery-${pslug}`
            : (proj.plancore_session || `helm-plancore-${pslug}`);
          await this.deps.transport.reap(`${sess}:0.0`, 'run-stopped-preexec');
        }
      } catch { /* best-effort */ }
    } else {
      // S03: executing (or later) stop — assert ibrain complete without inventing a reap of the
      // named brain (D-a3 keep-alive; worker seats already finalized/reaped above).
      this.assertImplementationBrainComplete({
        projectId: Number(run.project_id),
        runId,
        reason: 'run-stopped',
        state: 'reaped',
      });
    }
    console.warn(`[run-orchestrator] run ${runId} STOP requested (${stopReason}); marked terminal + abort flag set (reaped ${reapedWorkers} worker rows)`);
    return { ok: true, phase: 'failed', status: 'failed', reapedWorkers };
  }

  // E1: structured mid-run consult support. Inject new task (persisted run_tasks + enqueued) or
  // redirect/re-brief existing (update label, requeue at boundary). Injected drained ONLY at
  // next task boundary (getNextReady after current inFlight cleared by mark*). Queue dynamic;
  // drain while continues picking while non-empty.
  async inject(runId: number, payload: any): Promise<{ injected?: number; redirected?: number; error?: string }> {
    const db = this.deps.artifacts['db'].raw;
    const run = db.prepare('SELECT * FROM runs WHERE id = ?').get(runId) as any;
    if (!run) throw new Error('run not found for inject');
    const q = this.deps.queue as any;

    if (payload && payload.taskId != null && payload.redirect != null) {
      const tid = Number(payload.taskId);
      const newLabel = String(payload.redirect);
      db.prepare("UPDATE run_tasks SET label = ?, status = 'pending', updated_at = datetime('now') WHERE id = ? AND run_id = ?")
        .run(newLabel, tid, runId);
      if (typeof q.requeueForRedirect === 'function') {
        q.requeueForRedirect(runId, tid);
      } else if (typeof q.enqueueTask === 'function') {
        q.enqueueTask(runId, tid, true);
      } else {
        q.enqueue(runId, tid, [], true);
      }
      return { redirected: tid };
    }

    // new task inject
    const label = (payload && (payload.label || (payload.task && payload.task.label))) || 'injected mid-run task';
    const taskKey = (payload && (payload.task_key || (payload.task && payload.task.task_key))) || null;
    const urgent = !!(payload && payload.urgent);
    // Leg D dynamic-task resolution: an injection during an active batch INHERITS that batch unless an
    // explicit batch is supplied. Persist the resolved batch so it enters the admission barrier + deploy
    // gate like any planned task (never re-enqueued as unbatched).
    const explicitBatch = payload && (payload.batch != null && String(payload.batch).trim() !== '')
      ? String(payload.batch).trim()
      : undefined;
    const batch = explicitBatch ?? (typeof q.activeBatch === 'function' ? q.activeBatch(runId) : 'default');
    const tid = this.deps.artifacts.recordTask(runId, taskKey, label, batch);
    if (typeof q.enqueueTask === 'function') {
      q.enqueueTask(runId, tid, urgent, batch);
    } else {
      q.enqueue(runId, tid, [], urgent, batch);
    }
    return { injected: tid };
  }

  // PLAN-CACHE Phase-2 replay. Restore the project to the cached plan's code baseline, copy the cached Phase-1
  // artifacts into the fresh runDir, and ingest plan.json directly into run_tasks — NO projcore/interview/planning.
  // The shared executing loop then runs the implementation with the caller's roleBindings. Enables cheap A/B of
  // many implementer/validator models against one frozen, validated plan (no Phase-1 re-spend).
  private async seedFromCache(
    seedPlan: string,
    runDir: string,
    batchId: string,
    projectId: number,
    projectDir: string,
    precreatedRunId?: number
  ): Promise<number> {
    const cacheBase = process.env.HELM_PLAN_CACHE_DIR || path.join(process.cwd(), 'plan-cache');
    const cacheDir = path.join(cacheBase, seedPlan);
    // read meta (baseline + provenance)
    let meta: any = {};
    try { meta = JSON.parse(await fs.readFile(path.join(cacheDir, 'meta.json'), 'utf8')); }
    catch (e: any) { throw new Error(`plan-cache '${seedPlan}' has no readable meta.json under ${cacheDir}: ${e?.message || e}`); }
    // plan.json is mandatory
    let planRaw: string;
    try { planRaw = await fs.readFile(path.join(cacheDir, 'plan.json'), 'utf8'); }
    catch { throw new Error(`plan-cache '${seedPlan}' missing plan.json under ${cacheDir}`); }
    const plan = this.deps.parser.parsePlanFromJson(planRaw);
    if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
      throw new Error(`plan-cache '${seedPlan}' plan.json has no tasks`);
    }

    // 1) Restore the project's code baseline so the implementer starts from the exact state the plan was
    //    authored against (e.g. clean-no-lucky9, or broken-lucky9+no-pusoy). Fair per-model A/B requires this.
    if (projectDir && meta.baseline_sha) {
      const git = promisify(execFile);
      const bundle = path.join(cacheDir, 'baseline.bundle');
      try {
        // ensure the baseline commit is present (restore from the cached bundle if the repo GC'd/reset it away).
        // bundles fetch by ref, not raw SHA — import the bundle's tags (promotion writes a protecting tag).
        try { await git('git', ['-C', projectDir, 'cat-file', '-e', `${meta.baseline_sha}^{commit}`]); }
        catch { try { await git('git', ['-C', projectDir, 'fetch', bundle, 'refs/tags/*:refs/tags/*']); } catch {} }
        await git('git', ['-C', projectDir, 'reset', '--hard', meta.baseline_sha]);
        await git('git', ['-C', projectDir, 'clean', '-fd']);
        console.error(`[plan-cache] '${seedPlan}': restored ${projectDir} to baseline ${meta.baseline_sha} (${meta.baseline_desc || ''})`);
      } catch (e: any) {
        throw new Error(`plan-cache '${seedPlan}' baseline restore to ${meta.baseline_sha} failed: ${e?.message || e}. Refusing to replay against the wrong code state.`);
      }
    }

    // 2) Copy cached Phase-1 artifacts into the fresh runDir using canonical authored names.
    for (const f of [CANONICAL_CYCLE_ARTIFACTS.northStar, 'conversation-log.md', 'plan.json', CANONICAL_CYCLE_ARTIFACTS.plan, CANONICAL_CYCLE_ARTIFACTS.requirements]) {
      try { await fs.copyFile(path.join(cacheDir, f), path.join(runDir, f)); } catch {}
    }
    // Old caches remain readable, but the legacy alias is never authored into the new runDir.
    try {
      await fs.access(path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar));
    } catch {
      try { await fs.copyFile(path.join(cacheDir, 'north_star.md'), path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar)); } catch {}
    }
    try {
      await fs.cp(path.join(cacheDir, 'decisions'), path.join(runDir, 'decisions'), { recursive: true });
    } catch {}

    // 3) Ingest the plan directly → run_tasks (ingestPlan re-writes plan.json into runDir + enqueues by deps).
    const nsPath = path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar);
    const rid = precreatedRunId ?? this.deps.artifacts.createRun(projectId, batchId, nsPath);
    await this.deps.parser.ingestPlan(rid, plan, this.deps.queue, runDir);
    console.error(`[plan-cache] '${seedPlan}': ingested ${plan.tasks.length} cached tasks into run ${rid} — Phase-2 replay (no projcore/interview/planning)`);
    return rid;
  }

  // IS-R1 (impl-start): cycle-plan implementation-only seed. Reads <cycle folder>/plan.md
  // (via cycleService.getCycleDocDir), validates it, and ingests it directly into run_tasks with
  // PlanParserService.ingestExecutionPlan. Reuses precreatedRunId so the cycle_id linkage the detached
  // wrapper established (runs.cycle_id) holds. NO baseline restore, NO interview, NO planning-phase
  // spawn — the shared executing loop then drives the implementation. Missing/invalid plan throws a
  // clear error so the endpoint (and its pre-check) can surface a 400 "author a valid plan.md first".
  private async seedFromCyclePlan(
    cycleId: number,
    runDir: string,
    batchId: string,
    projectId: number,
    precreatedRunId?: number,
    resolvedWorkspace?: string | null
  ): Promise<number> {
    if (!this.deps.cycleService) {
      throw new Error('cycle-plan run requires cycleService (getCycleDocDir) — not wired');
    }
    // sol REVISE #1/#3: the ONE workspace resolved+validated at run start is MANDATORY here — no second
    // getCycleDocDir lookup and no fallback (either would reopen the root/workspace split + a TOCTOU seam).
    // The cyclePlan path always passes it; a missing value is a fail-closed error, never a silent lookup.
    if (!resolvedWorkspace) {
      throw new Error(`cycle-plan seed requires the pre-resolved, validated workspace (cycle ${cycleId}) — refusing an unvalidated getCycleDocDir fallback`);
    }
    const cycleWorkspace = resolvedWorkspace;
    let md: string;
    try {
      const artifact = await readCycleArtifact(cycleWorkspace, CANONICAL_CYCLE_ARTIFACTS.plan);
      md = artifact.content;
      if (artifact.warning) console.warn(`[cycle-plan] ${artifact.warning}`);
    } catch {
      throw new Error(`author a valid plan.md first (no plan.md in cycle ${cycleId} folder)`);
    }
    const parsed = parseExecutionPlan(md);
    if (!parsed.ok) {
      throw new Error(`author a valid plan.md first: ${parsed.errors.join('; ')}`);
    }
    // The complete canonical set was materialized from the cycle workspace before this seed runs.
    const nsPath = path.join(runDir, CANONICAL_CYCLE_ARTIFACTS.northStar);
    const rid = precreatedRunId ?? this.deps.artifacts.createRun(projectId, batchId, nsPath, cycleId);
    // Fresh ingest must not see leftover inFlight/failedTasks from a prior occupant of this runId.
    try { this.deps.queue.clearRun(rid); } catch { /* never block seed */ }
    await this.deps.parser.ingestExecutionPlan(rid, md, this.deps.queue, runDir);
    console.error(`[cycle-plan] cycle ${cycleId}: ingested plan.md into run ${rid} — implementation-only (no interview/planning)`);
    return rid;
  }

  // D-b1: poll for NORTH-STAR-READY callback emitted by discovery at the end of interview.
  // Accepts [helm callback] or [projcore callback] prefix for robustness (matches planning wait style).
  private async waitForNorthStarReady(cbPath: string, batchId: string, timeoutMs: number, runId?: number): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // R5b: sanctioned stop during the interview wait exits within one poll cycle (the
      // post-interview boundary assert then aborts the run flow before planning).
      if (runId != null && getRunAbort(runId)) return false;
      try {
        const raw = await fs.readFile(cbPath, 'utf8');
        const ready = raw.split(/\r?\n/).some((line) => {
          const parsed = parseCallbackLine(line);
          return !!parsed && parsed.batchId === batchId && parsed.state === 'NORTH-STAR-READY' && roleMatches('discovery', parsed.role);
        });
        if (ready) return true;
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    return false;
  }

  /**
   * Leg D §4 (D3b) pending-after-drain terminal decision. Consumes the queue's structured drain
   * classification AND a durable DB completion query. Returns true (caller must RETURN) when the run is
   * BLOCKED — for a queue class cycle/deferred-block/failed-block/unknown-pending-stall, OR a queue/DB
   * divergence (queue thinks done but run_tasks still has pending/working rows). On block it sets the run
   * phase=blocked/status=failed (existing blocked-run convention), keeps blocked dependents `pending`,
   * writes pending-after-drain.md (reason kind, pending keys/batches, blocker keys/statuses/batches, and
   * explicit "no later-batch dispatch occurred" evidence), records the artifact, and logs one loud line.
   * Returns false only when there is genuinely no pending-after-drain block (normal completion may proceed;
   * end-of-run failed/deferred handling still applies).
   */
  private async handlePendingAfterDrain(
    runId: number,
    runDir: string,
    batchId: string,
    queue: TaskQueueService = this.deps.queue,
    /** B04 fix cycle 3 (validator V2, critical): captured runs.generation when reached via
     * startRunDetached. Reachable with ZERO worker_runtimes rows on the cyclePlan/seedPlan path
     * (no interview/planning spawn), the one window where the run row is genuinely FK-deletable. */
    expectedGeneration?: number
  ): Promise<boolean> {
    const db = this.deps.artifacts['db'].raw;
    const q: any = queue;
    const qState = q && typeof q.classifyDrainState === 'function'
      ? q.classifyDrainState(runId)
      : { kind: 'all-complete', reason: '', pendingTaskIds: [], blockerTaskIds: [] };

    // Durable completion truth (never trust getNextReady==null): any pending/working run_task row.
    let dbPending: any[] = [];
    try {
      dbPending = db.prepare("SELECT id, task_key, status, batch FROM run_tasks WHERE run_id = ? AND status IN ('pending','working') ORDER BY id").all(runId) as any[];
    } catch {}

    let kind: string = qState.kind;
    let pendingIds: number[] = Array.isArray(qState.pendingTaskIds) ? qState.pendingTaskIds : [];
    let blockerIds: number[] = Array.isArray(qState.blockerTaskIds) ? qState.blockerTaskIds : [];
    let reason: string = qState.reason || '';

    if (kind === 'all-complete') {
      if (dbPending.length > 0) {
        // Queue believes it drained clean, but the durable store still has pending/working rows — a
        // queue/DB divergence. Fail-safe: visible unknown-pending-stall, never silently green.
        kind = 'unknown-pending-stall';
        pendingIds = dbPending.map((r) => Number(r.id));
        blockerIds = [];
        reason = `queue reported all-complete but ${dbPending.length} run_tasks row(s) remain pending/working (queue/DB divergence)`;
      } else {
        return false; // genuinely nothing blocked — proceed to normal completion handling.
      }
    }

    // Enrich queue ids with durable task_key / status / batch for operator-facing evidence.
    const info = (id: number) => {
      try {
        const r: any = db.prepare('SELECT id, task_key, status, batch FROM run_tasks WHERE id = ?').get(id);
        if (r) return { id: Number(r.id), key: r.task_key || `T${r.id}`, status: r.status, batch: r.batch != null && String(r.batch).trim() !== '' ? String(r.batch) : 'default' };
      } catch {}
      return { id, key: `T${id}`, status: '?', batch: '?' };
    };
    const pendingInfo = pendingIds.map(info);
    const blockerInfo = blockerIds.map(info);
    const pendingKeys = pendingInfo.map((p) => p.key);
    const blockerKeys = blockerInfo.map((b) => `${b.key}(${b.status},${b.batch})`);

    // Blocked-run convention (matches every existing blocked-run UPDATE). Blocked dependents keep their
    // truthful `pending` status (we never mark them complete/failed).
    this.transitionRunToBlocked(runId, `Pending-after-drain classifier: ${kind}. ${reason}`, undefined, 'failure', expectedGeneration);

    const note = [
      `# Pending After Drain — RUN BLOCKED (Leg D §4 / D3b)`,
      ``,
      `run_id: ${runId}`,
      `batch(run): ${batchId}`,
      `reason kind: ${kind}`,
      reason ? `detail: ${reason}` : '',
      ``,
      `## Pending (non-complete) tasks`,
      pendingInfo.length ? pendingInfo.map((p) => `- ${p.key} (status=${p.status}, batch=${p.batch})`).join('\n') : '(none)',
      ``,
      `## Blockers`,
      blockerInfo.length ? blockerInfo.map((b) => `- ${b.key} (status=${b.status}, batch=${b.batch})`).join('\n') : '(none identified — queue/DB divergence fail-safe)',
      ``,
      `## Evidence: no later-batch dispatch occurred`,
      `getNextReady returned null and the queue admission barrier held: no task from a later batch was`,
      `dispatched or attempted after this block. The run is terminal-blocked; final tests, run-final`,
      `red-team, and generic completion were NOT run (no later generic \`complete\` state was written).`,
      ``,
    ].filter((l) => l !== undefined).join('\n');

    try {
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, 'pending-after-drain.md'), note, 'utf8');
      this.deps.artifacts.recordArtifact(runId, 'pending-after-drain', 'pending-after-drain.md');
    } catch {}

    console.log(`[RunOrchestrator] RUN BLOCKED pending-after-drain reason=${kind} run=${runId} pending=${pendingKeys.join(',') || '(none)'} blockers=${blockerKeys.join(',') || '(none)'}`);
    return true;
  }

  // B10-T06: Batch-deploy + DEV UI-proof gate.
  // Called only after a task PASS. Detects if the just-completed task closed its batch.
  // Leg D §5: keyed off run_tasks.batch (the persisted normalized label), NOT the task_key prefix.
  // On close + config: run deploy (via injected runner) then require validator UI-proof on devUrl
  // (reusing B10-T03 JROM-clone + REQUIRE UI-proof framing).
  // On no config: graceful pause with artifact + phase=blocked + break (reinforcement 2).
  private async maybeRunBatchDeployGate(params: {
    runId: number;
    runDir: string;
    batchId: string;
    taskKey: string;
    project: any;
    loop: OrchestratorLoop;
    nextTaskId: number;
    briefContract: {
      requirementsAssigned: string;
      requirementsSection: string;
      context: string;
      scope: string;
      expected: string;
      northStarAnchors: string;
    };
    /** B04 fix cycle 3 (validator V2): captured runs.generation when reached via startRunDetached. */
    expectedGeneration?: number;
  }): Promise<void> {
    const { runId, runDir, batchId, taskKey, project, loop, expectedGeneration } = params;

    // Leg D §5: the deploy gate keys off run_tasks.batch (persisted normalized label), NOT the task_key
    // prefix. Resolve the just-completed task's durable batch; a task key with NO B#- prefix deploy-gates
    // correctly, and a misleading `B99-...` key stored as batch `B1` is treated as `B1`. The synthetic
    // 'default' batch (legacy all-unlabeled plan) is not an inter-batch boundary → skip (end-of-run is
    // covered by the final-tests gate), preserving legacy single-queue behavior.
    let batchPrefix: string | null = null;
    try {
      const trow: any = this.deps.artifacts['db'].raw
        .prepare('SELECT batch FROM run_tasks WHERE id = ?')
        .get(params.nextTaskId);
      const raw = trow && trow.batch != null ? String(trow.batch).trim() : '';
      batchPrefix = raw === '' ? 'default' : raw;
    } catch { return; }
    if (!batchPrefix || batchPrefix === 'default') return;

    // This batch is complete only when NO same-run task with EXACTLY this batch is still non-complete.
    // (The just-completed task is already status='complete' — markComplete ran before this gate.)
    let remaining = 0;
    try {
      const row: any = this.deps.artifacts['db'].raw
        .prepare(`SELECT COUNT(*) as c FROM run_tasks WHERE run_id = ? AND batch = ? AND status != 'complete'`)
        .get(runId, batchPrefix);
      remaining = row ? Number(row.c || 0) : 0;
    } catch { return; }

    if (remaining > 0) return; // not the last task of the batch yet

    // === Batch just completed with PASS. Run the deploy gate. ===

    const devUrlFromProject = project?.dev_url ?? null;
    const projectDir = project?.directory ?? null;

    const config = await discoverDevDeployConfig(projectDir, devUrlFromProject);
    const devUrl = config.devUrl;
    const deployCmd = config.deployCmd;

    const cbPath = path.join(runDir, 'callbacks.md');

    if (!devUrl || !deployCmd) {
      // R-G4: graceful pause, visible, no advance, no fake success
      const pauseNote = `# Batch Deploy Paused — no discoverable DEV config (B10-T06)

Batch: ${batchPrefix}
taskKey that closed batch: ${taskKey}
project.dev_url: ${devUrlFromProject || '(null)'}
deployCmd discovered: ${deployCmd || '(none)'}
projectDir: ${projectDir || '(none)'}

Reason: R-F8 / R-G4 requires deploy + validator UI-proof on DEV URL after a batch of tasks passes.
Missing DEV deploy command / DEV URL → pause for operator. Not skipped silently.

Action: Set dev_url on the project (via UI/API) and ensure the project's project_specs.md contains a documented DEV deploy command under § Deployment / Run.

This run will not advance past batch ${batchPrefix}.
`;
      try {
        await fs.mkdir(runDir, { recursive: true });
        await fs.writeFile(path.join(runDir, 'deploy-paused.md'), pauseNote, 'utf8');
        this.deps.artifacts.recordArtifact(runId, 'deploy-paused', 'deploy-paused.md');
      } catch {}

      // #52: missing deploy config is operator-recoverable (add dev_url/config), not a failure.
      this.transitionRunToBlocked(runId, `Batch ${batchPrefix} deploy configuration is missing; operator configuration is required.`, project, 'operator-pause', expectedGeneration);

      // Emit a visible callback for the gate (helps watcher + artifacts)
      try {
        await fs.appendFile(cbPath, `\n[helm callback] implementer ${batchId} STATUS: BLOCKED — batch ${batchPrefix} deploy paused (no dev_url / deployCmd)\n`, 'utf8');
      } catch {}

      console.log(`[RunOrchestrator B10-T06] Batch ${batchPrefix} deploy paused (no config). deploy-paused.md + phase=blocked`);
      return; // do not continue dispatch past this batch
    }

    // Config present: invoke the (stubbed in tests) runner — reinforcement 1 & 4
    const runner: DeployRunner = this.deps.deployRunner || createRealDeployRunner();

    // Hard safety for tests (reinforcement 1): if we are in test mode and no explicit runner was injected, refuse real exec
    const isTestEnv = !!(process.env.USE_FAKE_TMUX === '1' || process.env.NODE_ENV === 'test');
    if (isTestEnv && !this.deps.deployRunner) {
      throw new Error('TEST SAFETY (B10-T06 reinforcement 1): deployRunner MUST be injected. Real child_process exec is forbidden in the test suite.');
    }

    const deployRes = await runner.runDeploy(projectDir!, deployCmd, devUrl);
    try {
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, `batch-${batchPrefix}-deploy.json`),
        JSON.stringify({ batch: batchPrefix, devUrl, deployCmd, result: deployRes, ts: new Date().toISOString() }, null, 2),
        'utf8'
      );
      this.deps.artifacts.recordArtifact(runId, 'batch-deploy', `batch-${batchPrefix}-deploy.json`);
    } catch {}

    if (!deployRes.success) {
      // Treat deploy failure as visible pause
      try {
        await fs.appendFile(cbPath, `\n[helm callback] implementer ${batchId} STATUS: BLOCKED — batch ${batchPrefix} deploy failed: ${deployRes.note}\n`, 'utf8');
      } catch {}
      this.transitionRunToBlocked(runId, `Batch ${batchPrefix} deploy failed: ${deployRes.note}`, project, 'failure', expectedGeneration);
      return;
    }

    // === Deploy succeeded. Now REQUIRE validator UI-proof on the DEV URL (reuse B10-T03 framing) ===
    // Build validator brief using the same writer + JROM-clone + explicit UI-proof on devUrl.
    const briefWriter = new BriefWriterService();
    const baseValidatorBrief = briefWriter.generateBrief({
      batchId,
      role: 'validator',
      planPath: path.join(runDir, 'plan.json'),
      runDir,
      branch: 'main',
      ...params.briefContract,
      projectDir: projectDir || undefined,
      callbacksFile: cbPath,
      taskType: 'feature'
    });

    const proofBody = `

## B10-T06 Batch Deploy UI-Proof Gate (reuses B10-T03 JROM-clone + REQUIRE UI-proof)

The batch of tasks has locally passed.
A deploy to DEV was executed using the project's own discovered deploy command.

**Your task as validator (verifier ≠ fixer):**
- Visit and interact with the rendered app **at the DEV URL: ${devUrl}**
- Capture evidence (screenshots of key surfaces per north-star.md + decisions/ + og-requirements.md)
- Confirm the app is rendered and functional as expected after the batch changes.
- REQUIRE UI-proof (rendered app + screenshot) on this deployed URL.
- A claim without proof at the actual DEV URL = FAIL.
- Output exactly:
  PASS — <what was verified at ${devUrl} + screenshot refs + no regressions observed>
or
  FAIL — <gaps vs contract at the DEV URL>

Use the exact JROM-clone standards: adversarial, verify against requirements contract (not just "it worked locally").
`;

    const fullProofBrief = (baseValidatorBrief + proofBody).trim();

    // Write the gate brief for auditability
    try {
      await fs.mkdir(path.join(runDir, 'prompts'), { recursive: true });
      await fs.writeFile(path.join(runDir, 'prompts', `validator.batch-${batchPrefix}-deploy-proof.md`), fullProofBrief, 'utf8');
    } catch {}

    // Run the validator phase for the proof (reuses performRolePhase + wait inside the loop instance)
    // The loop already knows how to dispatch validator + wait for terminal state.
    let proofState = 'FAIL';
    try {
      // We call a dedicated helper we will add to the loop (keeps diff clean).
      const proof = await loop.runBatchDeployProof(fullProofBrief, devUrl, batchPrefix);
      proofState = proof.state || 'FAIL';
      if (proof.note) {
        try {
          await fs.appendFile(cbPath, `\n[helm callback] validator ${batchId} STATUS: ${proofState} — ${proof.note.substring(0, 200)}\n`, 'utf8');
        } catch {}
      }
    } catch (e: any) {
      proofState = 'FAIL';
      console.error(`[RunOrchestrator B10-T06] validator proof step error: ${e?.message}`);
    }

    if (proofState === 'PASS' || proofState === 'DONE') {
      // Success — batch fully accepted with DEV proof. Continue to next batch/tasks.
      try {
        await fs.appendFile(cbPath, `\n[helm callback] validator ${batchId} STATUS: PASS — B10-T06 batch ${batchPrefix} DEV UI-proof accepted at ${devUrl}\n`, 'utf8');
      } catch {}
      return;
    }

    // Proof did not PASS → pause the run at this batch boundary (do not advance)
    try {
      await fs.appendFile(cbPath, `\n[helm callback] validator ${batchId} STATUS: FAIL — B10-T06 batch ${batchPrefix} DEV UI-proof rejected; run blocked at batch boundary\n`, 'utf8');
    } catch {}
    try {
      this.transitionRunToBlocked(runId, `Batch ${batchPrefix} DEV UI proof was rejected.`, project, 'failure', expectedGeneration);
      this.deps.artifacts.recordArtifact(runId, 'batch-deploy-proof-failed', `batch-${batchPrefix}-deploy-proof-failed.md`);
    } catch {}
  }

  /**
   * B11-T03: Extracted dispatch hot-loop for safe re-entrancy from final-tests fix injection.
   * REINFORCEMENT 1: body is verbatim copy of the original while (behavior-preserving refactor).
   * All asserts, task loading (taskType from plan), runTask, marking, batch gates, error paths identical.
   */
  private async drainDispatch(
    runId: number,
    runDir: string,
    batchId: string,
    project: any,
    loop: OrchestratorLoop,
    queue: TaskQueueService = this.deps.queue,
    /** B04 fix cycle 3 (validator V2): captured runs.generation when reached via startRunDetached. */
    expectedGeneration?: number
  ): Promise<void> {
    // B04 fix cycle 4 (redteam-sol R3 C2, CRITICAL): expectedGeneration was previously forwarded only
    // to terminal writers below — this claim loop itself had no ownership check at all.
    // TaskQueueService is keyed by numeric runId; a recycled occupant clears and re-enqueues under the
    // SAME id (task-queue-service.ts clearRun/enqueue), so a stale continuation could claim the NEW
    // occupant's own token. That token legitimately carries the new occupant's own fresh generation —
    // B03's per-task terminal CAS is not a defense against this, because the claim itself is not
    // stale from the queue's point of view. The harm is that the STALE continuation would then execute
    // the work with ITS OWN (wrong) project/plan/runDir context and mark the new occupant's task
    // complete. Fence every claim attempt on runs.id + generation BEFORE calling claimNextReady —
    // never claim-then-reject (a claim mutates queue state; rejecting after the fact would still have
    // consumed the new occupant's dispatch slot).
    const genGated = expectedGeneration != null && Number.isFinite(Number(expectedGeneration));
    const ownsCurrentGeneration = (): boolean => {
      if (!genGated) return true; // no captured token (non-detached call) — unchanged, ungated behavior
      try {
        const row = this.deps.artifacts['db'].raw
          .prepare('SELECT generation FROM runs WHERE id = ?')
          .get(runId) as { generation: number } | undefined;
        return !!row && Number(row.generation) === Number(expectedGeneration);
      } catch {
        return false; // read failure — fail closed, never assume ownership
      }
    };
    let claim: TaskTerminalToken | null = null;
    while (true) {
      if (!ownsCurrentGeneration()) {
        if (genGated) {
          console.warn(
            `[run-orchestrator] drainDispatch stopped for run ${runId} generation ${expectedGeneration} — no longer current (stale continuation); no further claims`
          );
        }
        break;
      }
      claim = queue.claimNextReady(runId);
      if (claim == null) break;
      // B03 C1: freeze token at claim; carry through await — never rebuild from taskId maps at mark*.
      const terminalToken = claim;
      const nextTaskId = terminalToken.taskId;
      // R5a: task boundary — re-check before EVERY task dispatch (run-74 zombie evidence:
      // a run UPDATEd to failed kept spawning implementer sessions for 30+ min).
      this.assertRunActive(runId, 'task-boundary');
      // batch-POCFIX3: load full plan (authored by projcore in real path) + task detail (by task_key stored in run_tasks) to build RICH contract brief with atomic_work + validation_criteria + explicit real-build instructions for the target project dir (e.g. cards repo). Bare label is no longer used for real impl.
      const trow: any = this.deps.artifacts['db'].raw.prepare('SELECT * FROM run_tasks WHERE id = ?').get(nextTaskId);
      let taskDetail: any = null;
      try {
        const fullPlan = await this.deps.parser.loadPlanFromRunDir(runDir);
        taskDetail = fullPlan.tasks.find((t: any) => t.task_key === trow?.task_key) || fullPlan.tasks.find((t: any) => t.atomic_work === trow?.label);
      } catch {}
      const atomicWork = taskDetail?.atomic_work || trow?.label || `Implement task ${nextTaskId}`;
      const validationCriteria = taskDetail?.validation_criteria || 'Satisfy the task per plan.json and north-star.md.';
      const taskKey = taskDetail?.task_key || trow?.task_key || `T${nextTaskId}`;
      const reqRefs = Array.isArray(taskDetail?.req_refs)
        ? taskDetail.req_refs.map((ref: unknown) => String(ref).trim()).filter(Boolean)
        : [];
      const briefContract = {
        requirementsAssigned: reqRefs.length ? reqRefs.join(', ') : taskKey,
        requirementsSection: resolveRequirementsText(runDir, reqRefs),
        context: `Batch ${batchId} — ${atomicWork}`,
        scope: `Implement ${taskKey} (${atomicWork}) as an atomic vertical slice. Surgical, minimal-correct. Assert OUTCOMES against the requirements above.`,
        expected: validationCriteria,
        northStarAnchors: atomicWork,
      };
      const taskType = (taskDetail?.task_type as 'feature' | 'issue') || 'feature';
      const userCritical = Boolean(taskDetail?.user_critical);
      // C6: per-task model (or recommended_model) + effort from plan as BASE (before any escalation rung)
      const explicitModel = taskDetail?.model || taskDetail?.recommended_model;
      const taskEffort = taskDetail?.effort;
      const recommendedRung = taskDetail?.recommended_rung;
      const validatorRung = taskDetail?.validator_rung;
      const validatorModel = taskDetail?.validator_model;

      const briefWriter = new BriefWriterService();
      const callbacksFile = path.join(runDir, 'callbacks.md');
      const base = briefWriter.generateBrief({
        batchId,
        role: 'implementer',
        planPath: path.join(runDir, 'plan.json'),
        runDir,
        branch: 'main',
        ...briefContract,
        projectDir: project.directory,
        callbacksFile,
        taskType,
      });
      const taskBody = `
You are the implementer for this atomic task (verifier ≠ fixer; follow full contract header incl. first-callbacks-append, ACK rule, states, fence).
## Task (from plancore plan, for projectDir ${project.directory})
task_key: ${taskKey}
atomic_work: ${atomicWork}
validation_criteria: ${validationCriteria}

## Real build instructions (batch-POCFIX3 critical)
- Target the REGISTERED project directory exclusively: projectDir=${project.directory} (e.g. /home/agjrom/websites/cards for Lucky 9). All edits, new files, test runs, and git commits for this task MUST be inside it (C3 write-fence + sandbox enforce; use absolute paths or cd for tools).
- Read existing code under projectDir, implement the exact atomic_work with minimal correct changes.
- Add/update tests under projectDir that prove the validation_criteria hold (run them).
- Commit: git add -A && git commit -m "[${batchId}] ${taskKey}: ${atomicWork.substring(0, 80)}" (in projectDir).
- Emit per contract (DONE with evidence: files changed, criteria met, commit SHA).
`;
      const fullImplBrief = base.replace('<!-- PROJCORE-STATUS-CONTRACT v2 -->', `<!-- PROJCORE-STATUS-CONTRACT v2 -->${taskBody}`).trim();

      // B04 fix cycle 5 (validator R4): re-check ownership immediately before loop.runTask. The
      // awaited loadPlanFromRunDir above is a window where the run row can be deleted and recycled by
      // a new occupant between the pre-claim fence (top of this loop) and here — the claimed
      // terminalToken stays structurally valid (a real, frozen token), so dispatching now would
      // execute THIS continuation's own stale project/plan/runDir/brief against the numeric task id
      // the new occupant now owns. Do not runTask and do not mark* — leave the new occupant's queue
      // slot untouched; only its own continuation may claim and complete it.
      if (!ownsCurrentGeneration()) {
        console.warn(
          `[run-orchestrator] drainDispatch aborted for run ${runId} task ${nextTaskId} — generation ${expectedGeneration} no longer current after plan load (stale continuation); loop.runTask skipped`
        );
        break;
      }

      try {
        const tres = await loop.runTask({
          brief: fullImplBrief,
          taskDescription: `Task ${taskKey}: ${atomicWork}\nAcceptance criteria: ${validationCriteria}`,  // clean essence for issue-mode repro/re-validate briefs (no nested implementer contract)
          preExistingTaskId: nextTaskId,
          taskType,
          userCritical,
          explicitModel,
          recommendedRung,
          validatorRung,
          validatorModel,
          effort: taskEffort,
          taskKey,  // E3/E5: ensure writer uses key so helm dir == summary links via getTaskArtifactRoot
          briefContract,
        });
        if (tres.finalStatus === 'PASS') {
          queue.markComplete(terminalToken);
          // B10-T06: after any PASS, check if this completed a batch. If so, run deploy + DEV UI-proof gate.
          // Only acts on batch boundary (last task of the batch PASSed). Does not affect per-task flow.
          // Leg D §5: keying the gate off the persisted `batch` means it now fires for EVERY labeled-batch
          // run (not just old `B#-`-prefix keys). The no-DEV-config path is the intentional R-F8/R-G4 pause
          // (deploy-paused.md + phase=blocked) and MUST stay for real runs. HELM_SKIP_BATCH_DEPLOY=1 is an
          // EXPLICIT operator/CI opt-out (mirrors the HELM_SKIP_REDTEAM guard above) for deploy-less runs —
          // ordering/single-batch fixtures and local-showdown DoDs (e.g. cards2 :8081), NOT a silent skip.
          if (process.env.HELM_SKIP_BATCH_DEPLOY !== '1') {
            await this.maybeRunBatchDeployGate({
              runId,
              runDir,
              batchId,
              taskKey,
              project,
              loop,
              nextTaskId,
              briefContract,
              expectedGeneration,
            });
          }
        } else if (tres.finalStatus === 'DEFERRED') {
          queue.markDeferred(terminalToken);
        } else if (tres.finalStatus === 'BLOCKED') {
          // phase=blocked + critical-repro-pause.md already written inside loop (R-F3 operator-facing); stop dispatch
          console.log(`[RunOrchestrator] user-critical repro pause triggered for run ${runId}`);
          break;
        } else {
          queue.markFailed(terminalToken);
        }
      } catch (e: any) {
        // R5a: a run-abort stops the WHOLE loop (task already reaped/marked by the loop's own
        // abort path) — mark the in-flight task failed for bookkeeping and propagate.
        if (e instanceof RunAbortedError) {
          try { queue.markFailed(terminalToken); } catch {}
          throw e;
        }
        // Surfacing a swallowed runTask exception is important: a silent catch here hid an issue-path
        // (validator repro) dispatch failure as a bare task-fail with no diagnosis. Log + record it.
        console.error(`[run-orchestrator] runTask threw for task ${nextTaskId} (${taskKey}, ${taskType}): ${e?.stack || e?.message || e}`);
        try {
          const aid = this.deps.artifacts.recordAttempt(nextTaskId, 99);
          this.deps.artifacts.recordValidation(aid, 'FAIL', `runTask exception: ${e?.message || e}`);
        } catch {}
        queue.markFailed(terminalToken);
      }
    }
  }

  // B11-T02: Final-tests phase runner (local smoke THEN authoritative DEV e2e).
  // Mirrors B10-T06 batch-deploy gate 1:1 (discover + stubbable runner + test safety + graceful pause).
  // Called only when cycle.final_tests_enabled (B11-T01). Post-impl batch hook.
  // Smoke short-circuits on fail. e2e verdict is authoritative.
  // FAILs are PERSISTED plainly (json artifacts + [helm callback] FAIL lines + final-tests-result.json)
  // so a failing final-test is NEVER silently swept into all-green complete (guardrail).
  // On no smoke/e2e config: final-tests-paused.md + phase=blocked (no runner calls, no fake-pass).
  // On !enabled: clean skip (no pause, no calls, no phase change).
  //
  // B11-T03 extensions: on FAIL, compute sig; if new → append issue-type fix task to plan.json + recordTask + enqueueTask(urgent);
  // return {verdict, injected?} so caller can drain + re-gate. Recurrence or max handled by caller.
  private async maybeRunFinalTestsGate(params: {
    runId: number;
    runDir: string;
    batchId: string;
    project: any;
    loop: OrchestratorLoop;
    queue?: TaskQueueService;
    /** B04 fix cycle 3 (validator V2): captured runs.generation when reached via startRunDetached. */
    expectedGeneration?: number;
  }): Promise<{ verdict: 'PASS' | 'FAIL' | 'RECURRENCE_PAUSE' | 'SKIPPED'; injected?: number }> {
    const { runId, runDir, batchId, project, expectedGeneration } = params;
    const queue = params.queue ?? this.deps.queue;

    // Load cycle final_tests_enabled (respect B11-T01). Default-on if no cycle row.
    let cycleEnabled = true;
    let cycleId: number | null = null;
    try {
      const runRow: any = this.deps.artifacts['db'].raw
        .prepare('SELECT cycle_id FROM runs WHERE id=?').get(runId);
      cycleId = runRow?.cycle_id ?? null;
      if (cycleId != null) {
        const c: any = this.deps.artifacts['db'].raw
          .prepare('SELECT final_tests_enabled FROM cycles WHERE id=?').get(cycleId);
        cycleEnabled = c ? (Number(c.final_tests_enabled) !== 0) : true;
      }
    } catch { cycleEnabled = true; }

    if (!cycleEnabled) {
      // R-G1: skip cleanly when disabled (no artifact, no pause, no runner, continue to complete)
      console.log(`[RunOrchestrator B11-T02] final_tests_enabled=false for cycle ${cycleId ?? '(none)'}; skipping final tests cleanly`);
      return { verdict: 'SKIPPED' };
    }

    const devUrlFromProject = project?.dev_url ?? null;
    const projectDir = project?.directory ?? null;

    const config = await discoverFinalTestConfig(projectDir, devUrlFromProject);
    const devUrl = config.devUrl;
    const smokeCmd = config.smokeCmd;
    const e2eCmd = config.e2eCmd;

    const cbPath = path.join(runDir, 'callbacks.md');

    if (!devUrl || !smokeCmd || !e2eCmd) {
      // R-G4: graceful pause, visible, no advance past final-tests, no fake success
      const pauseNote = `# Final Tests Paused — no discoverable local smoke / DEV e2e config (B11-T02)

Batch: ${batchId}
cycle: ${cycleId ?? '(none)'}
project.dev_url: ${devUrlFromProject || '(null)'}
smokeCmd discovered: ${smokeCmd || '(none)'}
e2eCmd discovered: ${e2eCmd || '(none)'}
projectDir: ${projectDir || '(none)'}

Reason: R-G1 / R-G4 requires local smoke (fast pre-check) then AUTHORITATIVE full e2e on the DEV URL in the Final Tests phase.
Missing local smoke cmd or DEV e2e cmd or DEV URL → pause for operator. Not skipped silently.

Action: Set dev_url on the project (via UI/API) and ensure the project's project_specs.md contains documented
"local smoke" and "DEV e2e" commands (see § Test / Final Tests conventions).

This run will not advance past Final Tests for this cycle.
`;
      try {
        await fs.mkdir(runDir, { recursive: true });
        await fs.writeFile(path.join(runDir, 'final-tests-paused.md'), pauseNote, 'utf8');
        this.deps.artifacts.recordArtifact(runId, 'final-tests-paused', 'final-tests-paused.md');
      } catch {}

      // #52: missing final-test config is an operator-recoverable PAUSE, not a failure. The run's tasks
      // all passed; it merely cannot run final tests until dev_url/smoke/e2e are configured.
      this.transitionRunToBlocked(runId, 'Final-test configuration is missing; operator configuration is required.', project, 'operator-pause', expectedGeneration);

      try {
        await fs.appendFile(cbPath, `\n[helm callback] implementer ${batchId} STATUS: BLOCKED — final tests paused (no smokeCmd / e2eCmd / devUrl)\n`, 'utf8');
      } catch {}

      console.log(`[RunOrchestrator B11-T02] Final tests paused (no config). final-tests-paused.md + phase=blocked`);
      return { verdict: 'RECURRENCE_PAUSE' }; // reuse shape; caller treats non-inject as stop
    }

    // Config present: invoke the (stubbed in tests) runner — reinforcement 1 & 4
    const runner: TestRunner = this.deps.finalTestRunner || createRealTestRunner();

    // Hard safety for tests (reinforcement 1): if we are in test mode and no explicit runner was injected, refuse real exec
    const isTestEnv = !!(process.env.USE_FAKE_TMUX === '1' || process.env.NODE_ENV === 'test');
    if (isTestEnv && !this.deps.finalTestRunner) {
      throw new Error('TEST SAFETY (B11-T02 reinforcement 1): finalTestRunner MUST be injected. Real child_process exec is forbidden in the test suite.');
    }

    // === RUN ORDER: LOCAL SMOKE first (fast pre-check), THEN authoritative e2e on DEV ===
    const smokeRes = await runner.runTest(projectDir!, smokeCmd, 'smoke', devUrl);
    try {
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(
        path.join(runDir, 'final-tests-smoke.json'),
        JSON.stringify({ kind: 'smoke', cmd: smokeCmd, devUrl, result: smokeRes, ts: new Date().toISOString() }, null, 2),
        'utf8'
      );
      this.deps.artifacts.recordArtifact(runId, 'final-smoke', 'final-tests-smoke.json');
    } catch {}

    // Persist a unified run-readable marker for B11-T03 + operator visibility (guardrail: never silent pass)
    const finalVerdict: any = {
      batchId,
      cycleId,
      devUrl,
      smoke: { cmd: smokeCmd, success: smokeRes.success, note: smokeRes.note },
      e2e: null as any,
      overall: smokeRes.success ? 'PENDING_E2E' : 'FAIL_SMOKE',
      ts: new Date().toISOString()
    };

    if (!smokeRes.success) {
      // Q1 per APPROVED-PLAN: smoke fail short-circuits (skip e2e)
      try {
        await fs.appendFile(cbPath, `\n[helm callback] implementer ${batchId} STATUS: FAIL — final-tests smoke failed (short-circuit, no e2e run): ${smokeRes.note.substring(0, 160)}\n`, 'utf8');
      } catch {}
      try {
        finalVerdict.overall = 'FAIL_SMOKE';
        await fs.writeFile(path.join(runDir, 'final-tests-result.json'), JSON.stringify(finalVerdict, null, 2), 'utf8');
        this.deps.artifacts.recordArtifact(runId, 'final-tests-result', 'final-tests-result.json');
      } catch {}
      // Do NOT block phase (per Q3). Record plainly so not swept into green complete.
      console.log(`[RunOrchestrator B11-T02] Final tests smoke FAIL (short-circuit). Artifacts + callback recorded.`);
      // fall through to B11-T03 fix logic below
    } else {
      // Smoke passed — run AUTHORITATIVE e2e on DEV URL
      const e2eRes = await runner.runTest(projectDir!, e2eCmd, 'e2e', devUrl);
      try {
        await fs.writeFile(
          path.join(runDir, 'final-tests-e2e.json'),
          JSON.stringify({ kind: 'e2e', cmd: e2eCmd, devUrl, result: e2eRes, ts: new Date().toISOString() }, null, 2),
          'utf8'
        );
        this.deps.artifacts.recordArtifact(runId, 'final-e2e', 'final-tests-e2e.json');
      } catch {}

      finalVerdict.e2e = { cmd: e2eCmd, success: e2eRes.success, note: e2eRes.note };
      finalVerdict.overall = e2eRes.success ? 'PASS' : 'FAIL_E2E';

      try {
        await fs.writeFile(path.join(runDir, 'final-tests-result.json'), JSON.stringify(finalVerdict, null, 2), 'utf8');
        this.deps.artifacts.recordArtifact(runId, 'final-tests-result', 'final-tests-result.json');
      } catch {}

      const verdictLabel = e2eRes.success ? 'PASS' : 'FAIL';
      try {
        await fs.appendFile(cbPath, `\n[helm callback] implementer ${batchId} STATUS: ${verdictLabel} — final-tests e2e on DEV ${devUrl}: ${e2eRes.note.substring(0, 160)}\n`, 'utf8');
      } catch {}

      if (e2eRes.success) {
        console.log(`[RunOrchestrator B11-T02] Final tests PASS on DEV ${devUrl}.`);
        return { verdict: 'PASS' };
      } else {
        console.log(`[RunOrchestrator B11-T02] Final tests e2e FAIL persisted (no phase block).`);
        // fall through to B11-T03 fix logic
      }
    }

    // === B11-T03: convert FAIL → atomic issue fix task (task_type=issue) + enqueue for loop-back ===
    // REUSE: recordTask, enqueueTask(urgent), plan append for taskDetail, B11-T02 result artifact.
    // The injected task will trigger B10-T04 (repro) because task_type==='issue' and B10-T05 escalation inside its drain.
    if (finalVerdict.overall && String(finalVerdict.overall).startsWith('FAIL')) {
      const sig = this.computeFinalFailureSignature(finalVerdict);
      if (sig) {
        const seen = await this.hasSeenFinalFailureSig(runDir, sig);
        if (seen) {
          // Primary terminator: same failure after escalation chain for the prior fix task → pause, no re-inject
          await this.doFinalTestRecurrencePause(runId, runDir, batchId, sig, finalVerdict, cbPath, expectedGeneration);
          return { verdict: 'RECURRENCE_PAUSE' };
        }
        await this.recordSeenFinalFailureSig(runDir, sig);

        // Create atomic fix task entry for plan (so dispatch load finds task_type + contract)
        const shortSig = sig.replace(/[^a-z0-9-]/gi, '').slice(0, 16);
        const fixTaskKey = `FIX-FINAL-${batchId.replace(/[^A-Z0-9]/g, '')}-${shortSig}`;
        const fixLabel = `Fix final-test failure (${finalVerdict.overall}) : ${String(finalVerdict.smoke?.note || finalVerdict.e2e?.note || '').substring(0, 80)}`;
        const fixValidation = `Reproduce the exact final-test failure using the contract recorded in final-tests-result.json (note + overall) BEFORE any implementer changes (B10-T04 repro gate). Then make the minimal edit so that re-running final tests (smoke then e2e) succeeds. Failure details:\n${JSON.stringify({overall: finalVerdict.overall, smoke: finalVerdict.smoke, e2e: finalVerdict.e2e}, null, 2)}\n\nThis task uses task_type=issue so repro-before-impl + escalation apply. If the SAME failure recurs after the fix task's escalation chain (B10-T05), the run will pause (no infinite loop).`;

        // Leg D dynamic-task resolution: a post-queue final-test fix receives a NEW batch ordinal AFTER the
        // last planned batch, so it sorts last and its own deploy gate closes independently.
        const q = queue as any;
        const fixBatch = typeof q.newBatchAfterLast === 'function' ? q.newBatchAfterLast(runId) : 'default';
        try {
          const plan = await this.deps.parser.loadPlanFromRunDir(runDir);
          (plan.tasks as any[]).push({
            task_key: fixTaskKey,
            task_type: 'issue',
            atomic_work: fixLabel,
            validation_criteria: fixValidation,
            batch: fixBatch,
            deps: []
          });
          await fs.writeFile(path.join(runDir, 'plan.json'), JSON.stringify(plan, null, 2), 'utf8');
          this.deps.artifacts.recordArtifact(runId, 'final-fix-task', 'plan.json');
        } catch (e) {
          console.error(`[RunOrchestrator B11-T03] plan append for fix task failed: ${e}`);
        }

        const tid = this.deps.artifacts.recordTask(runId, fixTaskKey, fixLabel, fixBatch);
        if (typeof q.enqueueTask === 'function') {
          q.enqueueTask(runId, tid, true, fixBatch); // urgent — after current in-flight
        } else if (typeof q.enqueue === 'function') {
          q.enqueue(runId, tid, [], true, fixBatch);
        }

        try {
          await fs.appendFile(cbPath, `\n[helm callback] implementer ${batchId} STATUS: FAIL — final-tests injected atomic fix task ${fixTaskKey} (task_type=issue) for loop-back to Implementation\n`, 'utf8');
        } catch {}

        console.log(`[RunOrchestrator B11-T03] Injected fix task ${fixTaskKey} (issue) from final-test FAIL; enqueued urgent.`);
        return { verdict: 'FAIL', injected: tid };
      }
    }

    return { verdict: 'PASS' };
  }

  // === B11-T03 helpers (sig + seen + pause + max backstop). Private, minimal surface. ===
  private computeFinalFailureSignature(result: any): string | null {
    if (!result) return null;
    const overall = String(result.overall || '');
    if (!overall.startsWith('FAIL')) return null;
    const note = String(result.e2e?.note || result.smoke?.note || result.note || '').toLowerCase();
    const tokens = note.replace(/[^a-z0-9\s]/g, ' ').trim().split(/\s+/).filter(Boolean).slice(0, 8).join('-');
    return `${overall}:${tokens || 'unknown'}`;
  }

  private async hasSeenFinalFailureSig(runDir: string, sig: string): Promise<boolean> {
    try {
      const p = path.join(runDir, 'final-test-failure-sigs.json');
      const raw = await fs.readFile(p, 'utf8');
      const data = JSON.parse(raw);
      return Array.isArray(data.sigs) && data.sigs.includes(sig);
    } catch {
      return false;
    }
  }

  private async recordSeenFinalFailureSig(runDir: string, sig: string): Promise<void> {
    try {
      const p = path.join(runDir, 'final-test-failure-sigs.json');
      let data: any = { sigs: [] };
      try {
        const raw = await fs.readFile(p, 'utf8');
        data = JSON.parse(raw);
        if (!Array.isArray(data.sigs)) data.sigs = [];
      } catch {}
      if (!data.sigs.includes(sig)) data.sigs.push(sig);
      await fs.writeFile(p, JSON.stringify(data, null, 2), 'utf8');
      // best-effort artifact record (runId in scope at call site)
    } catch {}
  }

  private async doFinalTestRecurrencePause(runId: number, runDir: string, batchId: string, sig: string, finalVerdict: any, cbPath: string, expectedGeneration?: number): Promise<void> {
    const pauseNote = `# Final Test Failure Recurred — Pause (B11-T03)

Same failure signature detected after prior fix task (which exhausted B10-T04 repro + B10-T05 escalation chain).

sig: ${sig}
batch: ${batchId}
run: ${runId}
final-tests-result: ${JSON.stringify(finalVerdict, null, 2)}

This is the explicit infinite-loop terminator. No further auto fix tasks will be injected for this sig.
Operator action required.

`;
    try {
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, 'final-test-recurrence-pause.md'), pauseNote, 'utf8');
      this.deps.artifacts.recordArtifact(runId, 'final-test-recurrence-pause', 'final-test-recurrence-pause.md');
    } catch {}

    this.transitionRunToBlocked(runId, `Final-test failure ${sig} recurred after the escalation chain; operator action is required.`, undefined, 'failure', expectedGeneration);

    try {
      await fs.appendFile(cbPath, `\n[helm callback] implementer ${batchId} STATUS: BLOCKED — final-test failure ${sig} recurred after escalation chain; paused (no infinite loop)\n`, 'utf8');
    } catch {}

    console.log(`[RunOrchestrator B11-T03] RECURRENCE PAUSE for sig ${sig} — final-test-recurrence-pause.md + phase=blocked`);
  }

  private async doMaxFixItersVisiblePause(runId: number, runDir: string, batchId: string, cbPath: string, lastOutcome: any, expectedGeneration?: number): Promise<void> {
    const note = `# Max Fix Iterations Reached — Final Tests Still Failing (B11-T03)

MAX_FIX_ITERS=3 backstop hit while final tests have not passed (distinct or non-converging failures).

batch: ${batchId}
run: ${runId}
lastGateOutcome: ${JSON.stringify(lastOutcome, null, 2)}

REINFORCEMENT 2: do NOT silently complete. Surface honestly (consistent with no-fake-pass guardrail).
Operator intervention required. Recurrence sig is primary; this is the visible hard cap.

`;
    try {
      await fs.mkdir(runDir, { recursive: true });
      await fs.writeFile(path.join(runDir, 'final-tests-max-fix-iters-reached.md'), note, 'utf8');
      this.deps.artifacts.recordArtifact(runId, 'final-tests-max-fix-iters-reached', 'final-tests-max-fix-iters-reached.md');
    } catch {}

    this.transitionRunToBlocked(runId, 'Final tests remain failing after the maximum automatic fix iterations; operator action is required.', undefined, 'failure', expectedGeneration);

    try {
      await fs.appendFile(cbPath, `\n[helm callback] implementer ${batchId} STATUS: BLOCKED — max fix iterations reached while final tests still failing; visible pause (no fake pass)\n`, 'utf8');
    } catch {}

    console.log(`[RunOrchestrator B11-T03] MAX_FIX_ITERS backstop — final-tests-max-fix-iters-reached.md + phase=blocked`);
  }

  /**
   * Mid-run re-plan re-ingest (ibrain root-cause classifier): surgically update ONE task in plan.json.
   * CONTENT ONLY: atomic_work, validation_criteria, req_refs. task_key/type/batch/deps/complexity IMMUTABLE.
   * Fail-closed: unreadable/malformed plan.json OR missing target task_key → throw (never write a truncated plan).
   * Atomic write: plan.json.tmp then rename.
   */
  static async applyPlanSliceRevision(
    runDir: string,
    revised: {
      task_key: string;
      atomic_work: string;
      validation_criteria: string | string[];
      /** When undefined, keep existing task's req_refs (merge-don't-clobber). */
      req_refs?: string[];
      summary?: string;
    },
    meta: { decisionId: string; planRevisionDirective?: string },
  ): Promise<{ planPath: string; task: Record<string, unknown> }> {
    const planPath = path.join(runDir, 'plan.json');
    let plan: any;
    try {
      const raw = await fs.readFile(planPath, 'utf8');
      plan = JSON.parse(raw);
    } catch (e: any) {
      throw new Error(
        `applyPlanSliceRevision: plan.json unreadable or malformed at ${planPath}: ${e?.message || e}`,
      );
    }
    if (!plan || typeof plan !== 'object' || !Array.isArray(plan.tasks) || plan.tasks.length === 0) {
      throw new Error(`applyPlanSliceRevision: plan.json has no tasks[] at ${planPath}`);
    }
    // Match ONLY the original immutable task_key (no prior/new-key ambiguity).
    const key = revised.task_key;
    if (typeof key !== 'string' || !key.trim()) {
      throw new Error('applyPlanSliceRevision: task_key required');
    }
    const idx = plan.tasks.findIndex((t: any) => t && t.task_key === key);
    if (idx < 0) {
      throw new Error(
        `applyPlanSliceRevision: task_key ${JSON.stringify(key)} not found in plan.json — abort (no truncated write)`,
      );
    }
    const existing = plan.tasks[idx] as Record<string, unknown>;
    // Merge-don't-clobber: only content fields change; immutable identity fields stay from existing.
    const mergedReqRefs =
      revised.req_refs !== undefined
        ? revised.req_refs
        : Array.isArray(existing.req_refs)
          ? existing.req_refs
          : [];
    const updatedTask: Record<string, unknown> = {
      ...existing,
      // IMMUTABLE identity / routing — never overwrite from plancore revision
      task_key: existing.task_key,
      task_type: existing.task_type,
      complexity: existing.complexity,
      deps: existing.deps,
      batch: existing.batch,
      assignee: existing.assignee,
      validator_lane: existing.validator_lane,
      // CONTENT ONLY
      atomic_work: revised.atomic_work,
      validation_criteria: revised.validation_criteria,
      req_refs: mergedReqRefs,
      plan_revision: {
        decisionId: meta.decisionId,
        directive: meta.planRevisionDirective,
        summary: revised.summary,
        at: new Date().toISOString(),
      },
    };
    plan.tasks[idx] = updatedTask;
    // Atomic write: tmp then rename (same-dir rename is atomic on POSIX).
    const tmpPath = `${planPath}.tmp`;
    await fs.writeFile(tmpPath, JSON.stringify(plan, null, 2), 'utf8');
    await fs.rename(tmpPath, planPath);
    return { planPath, task: updatedTask };
  }
}
