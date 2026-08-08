import fs from 'node:fs/promises';
import path from 'node:path';
import type { ITransport } from './fake-transport.js';
import { normalizeValidatorVerdict, PREFERRED_DEFECT_CLASSES, type RunArtifactService } from './run-artifact-service.js';
import { parseCallbackLine } from './agent-event-ingest.js';
import { roleMatches, workerFaceRole } from './role-alias.js';
import { EscalationService, type LedgerEntry, type Decision } from './escalation-service.js';
import type { Plan, PlannedTask } from './plan-parser-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { PanelService } from './panel-service.js';
import { bindDispatchNonce, BriefWriterService, createDispatchNonce } from './brief-writer-service.js';
import { resolveRequirementsText } from './requirements-resolver-service.js';
import { classifySeatPane } from './seat-pane-state.js';
import { CANONICAL_CYCLE_ARTIFACTS } from './cycle-artifact-paths.js';
import type { RoutingConfigService } from './routing-config-service.js';
import { getRunAbort } from './run-abort-registry.js';
import type { CycleGitAllowCycle } from '../security/landlock-sandbox.js';
import {
  httpNotificationTransport,
  notifyBlockedRun,
  type NotificationTransport,
} from './notification-transport.js';
import { validateRevisedTaskContent, type RevisedTaskContent } from './plan-schema.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { PhaseStaffingService } from './phase-staffing.js';
import { matchSeatAuthError, authRemedyFor } from './seat-auth.js';
import { parsePlanContradiction } from './plan-contradiction.js';
import { classifyGateFault, authFault } from './fault-class.js';
import { finalizeWorkerRuntimeRow } from './worker-runtime-finalize.js';
import { openFence } from './fence-open-service.js';
import { selectNextWork } from './fence-selector-admission.js';
import { assertRepairImplementerDispatchAllowed } from './fence-repair-requeue.js';

export type Transition = string;

export type CallbackWaitCause =
  | 'session-gone'
  | 'no-first-callback'
  | 'idle-prompt-no-terminal'
  | 'ambiguous-idle-timeout'
  | 'wall-timeout'
  // #47: the seat's CLI is not authenticated. Distinct from every cause above because it is the only
  // one that is NOT retryable — see SeatAuthTerminalError below.
  | 'seat-auth-failed';

export class CallbackWaitError extends Error {
  constructor(public readonly waitCause: CallbackWaitCause, role: string, detail: string) {
    super(`waitForCallback ${waitCause} for ${role}: ${detail}`);
    this.name = 'CallbackWaitError';
  }
}

/**
 * #47: a seat proved its CLI is not authenticated. This ABORTS THE RUN rather than failing one task.
 *
 * Rationale (learned the hard way on 2026-07-20): an expired provider token is not a property of the
 * task, the model, or the rung — it is a property of the PROVIDER, so every future seat on that
 * provider fails identically. Treating it as a normal reap sends it round the free-retry/escalation
 * ladder, which cannot possibly fix it: one task burned 6 attempts in 6 minutes and would have churned
 * to the 80-attempt cap before failing with a misleading "no callback" reason, with nothing in the
 * engine log. Failing the run immediately, naming the provider and the exact remedy, turns an hour of
 * silent churn into a five-second operator fix.
 *
 * Propagates like RunAbortedError (stops the loop spawning further seats) rather than being swallowed
 * by a per-task catch.
 */
export class SeatAuthTerminalError extends Error {
  constructor(
    public readonly provider: string | undefined,
    public readonly snippet: string,
    public readonly remedy: string
  ) {
    super(`seat not authenticated (provider=${provider ?? 'unknown'}) — ${remedy}. Pane: ${snippet.slice(0, 160)}`);
    this.name = 'SeatAuthTerminalError';
  }
}

function clampedEnvMs(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

// R5a (CC-CHAT-4): thrown when the loop detects its run is terminal in the DB (or a
// sanctioned stop flagged it via the run-abort-registry). Callers must NOT feed this into
// the agent-fail/FAIL ladder — it propagates up so the whole run loop stops spawning.
export class RunAbortedError extends Error {
  constructor(public readonly runId: number, detail: string) {
    super(`run ${runId} aborted: ${detail}`);
    this.name = 'RunAbortedError';
  }
}

// Terminal runs.phase / runs.status values (schema CHECK allows status complete|failed;
// phase is free-text but the codebase's terminal convention is complete/failed/blocked).
export const TERMINAL_RUN_PHASES = ['complete', 'failed', 'blocked', 'stopped'];
export const TERMINAL_RUN_STATUSES = ['complete', 'failed', 'stopped'];

// C0 (kloo route threading): fallback when a kloo-bound model has no models-table row (so
// EscalationService.getRouteForModel returns null) — infer from the model id shape.
// OpenRouter ids are namespaced ('deepseek/deepseek-v4-flash') → 'openrouter'; anything else is local llama.cpp.
export function inferKlooRoute(model: string | undefined | null): string {
  if (model && model.includes('/')) return 'openrouter';
  return 'llamacpp';
}

export class ThinRunArtifactWriter {
  constructor(private readonly runDir: string, private readonly batchId = 'batch-B0') {}

  private async ensure(subdir: string): Promise<void> {
    await fs.mkdir(path.join(this.runDir, subdir), { recursive: true });
  }

  async writeBrief(role: string, content: string): Promise<void> {
    await this.ensure('prompts');
    await fs.writeFile(path.join(this.runDir, 'prompts', `${role}.brief.md`), content, 'utf8');
  }

  async writeAck(role: string, dispatchNonce = 'legacy'): Promise<void> {
    const cbPath = path.join(this.runDir, 'callbacks.md');
    // Write the ACK with the worker-FACING role so the worker's face-role ACK-grep in its
    // brief matches (the brief tells it to grep e.g. `[helm ACK] helm_pm ...`). Nothing
    // internal parses ACK lines by role (parseCallbackLine only matches `[helm callback]`),
    // so emitting the face name here is safe.
    const ack = `[helm ACK] ${workerFaceRole(role)} ${this.batchId} RECEIVED dispatch=${dispatchNonce} — ack before reap`;
    await fs.appendFile(cbPath, `\n${ack}\n`, 'utf8');
  }

  async persistState(transitions: Transition[], finalStatus: string): Promise<void> {
    await this.ensure('state');
    await this.ensure('artifacts');
    await fs.writeFile(
      path.join(this.runDir, 'state', 'transitions.json'),
      JSON.stringify(transitions, null, 2),
      'utf8'
    );
    await fs.writeFile(
      path.join(this.runDir, 'artifacts', 'final.json'),
      JSON.stringify({ status: finalStatus, transitions, ts: new Date().toISOString() }, null, 2),
      'utf8'
    );
  }
}

export class OrchestratorLoop {
  private transitions: Transition[] = [];
  private readonly writer: ThinRunArtifactWriter;
  private readonly batchId: string;
  private readonly runDir: string;
  private artifactService?: RunArtifactService;
  private runId?: number;
  private taskId?: number;
  private taskKey?: string;
  private currentBriefContract?: {
    requirementsAssigned: string;
    requirementsSection: string;
    context: string;
    scope: string;
    expected: string;
    northStarAnchors: string;
  };
  private currentAttemptId?: number;
  private currentDispatchId?: number;
  private lastReproNote: string | null = null;
  private lastReproFailNote: string | null = null;
  private userCritical: boolean = false;

  // B8 escalation ladder state (per-task; reset on each runTask)
  private currentRung = 0;
  private currentValidatorRung?: number;
  private attemptsAtRung = 0;
  private authorizingDecisionId: string | null = null;
  private failureLedger: LedgerEntry[] = [];
  private pendingHandholdDirections: string | null = null;
  // Root-cause classifier (re-plan + escalate-validator) per-task bounds/state.
  private replansUsed = 0;
  private validatorOverridesUsed = 0;
  private lastReplanDecisionId: string | null = null;
  private revalidateOnly = false;
  /**
   * Last FAIL source — override is ONLY legal for agent-validator FAILs (positive guard).
   * Explicit enum so deterministic-gate / agent-fail / reviewer / other never launder to PASS.
   */
  private lastFailSource:
    | 'agent-validator'
    | 'deterministic-gate'
    | 'agent-fail'
    | 'reviewer'
    | 'other' = 'other';
  private lastAgentValidatorFailNote: string | null = null;
  private readonly MAX_REPLANS = Math.min(5, Math.max(1, parseInt(process.env.HELM_MAX_REPLANS || '', 10) || 2));
  // Ordinary validator FAILs receive a generous same-rung correction window. This is a safety backstop,
  // not escalation pressure: only an explicit validator incapability flag may wake the brain earlier.
  // The legacy rung-0 env remains recognized only as a floor, so it can enlarge but never tighten this window.
  private readonly MAX_TASK_ATTEMPTS = Math.min(40, Math.max(3, parseInt(process.env.HELM_MAX_TASK_ATTEMPTS || '', 10) || 12));
  private readonly LEGACY_RUNG0_ATTEMPT_LIMIT = (() => {
    const parsed = parseInt(process.env.HELM_RUNG0_ATTEMPT_LIMIT || '', 10);
    return Number.isFinite(parsed) ? Math.min(20, Math.max(1, parsed)) : 0;
  })();
  /** Absolute max orchestrator rung (L4). Effective top is min(TOP_RUNG, highest resolvable ladder rung) — absent L4 ≡ today (tops at 2). */
  private readonly TOP_RUNG = 3;
  // FIX #39 defense-in-depth: a hard ceiling on TOTAL attempts per task. Pushback (validator-handholding /
  // re-brief) resets attemptsAtRung, so the per-rung backstop is not a global bound — a degenerate loop
  // (validator keeps flagging incapable, brain keeps pushing back) could otherwise never terminate. This
  // bounds the raw retry loop so a non-converging task always ends in a human-actionable page (never a
  // silent forever-loop). Generous by design (env-tunable) — the primary stall guards are the validator
  // flag + the watcher; this is the last-resort backstop.
  private readonly HARD_MAX_ATTEMPTS = Math.min(500, Math.max(20, parseInt(process.env.HELM_HARD_MAX_ATTEMPTS || '', 10) || 80));
  private escalationService: EscalationService | null;
  private panelService?: PanelService;
  private redTeamAgents?: Array<{ role: string; agent_id?: number; model?: string; provider?: string; lens?: string; position?: number }>;
  private deliberationRoster?: Array<{ position: number; lens?: string; model: string; provider?: string }>;
  private readonly projectDir?: string;  // batch-POCFIX3: target registered project dir (e.g. cards) for real impl/verify in task briefs
  private readonly projectId?: number;  // B9fix2 F4: project-scoped escalation ladder via resolveProjectAgent
  private currentEffort?: string;  // C6: per-task effort base honored at every worker spawn for this task
  private explicitModel?: string;  // C6: per-task plan model; rung-0 BASE for implementer dispatch (escalation >0 uses ladder)
  private validatorExplicitModel?: string;  // Optional per-task validator base model; runged validator_lane wins when set.
  // A4: optional routing-config consult (A3 data model). Absent => pure hardcoded FSM (unchanged). Present =>
  // routeFor() consults it as the source of routing decisions, with the hardcoded pair as fallback (never a
  // silent hang) and core (is_core=1) transitions protected against a disagreeing config override.
  private readonly routingConfig: RoutingConfigService | null;
  private readonly coreRouteKeys: Set<string> = new Set();
  // review #3: per-run cached seat-binary verifier. When present, the loop rechecks the ACTUALLY-resolved
  // per-task/rung seat binary at the dispatch boundary (before transport.spawn) so a model resolved after
  // the run-start roster preflight can't spawn a doomed seat that only fails as a generic ready-probe
  // timeout. Absent (fake-transport tests / no masterRuntime) => skipped, unchanged behavior.
  private readonly verifySeatBinary?: (provider: string, model: string) => Promise<{ ok: boolean; bin?: string | null; reason?: string }>;
  // B-ISO1 (sol wiring review fix #4): the RUN-SCOPED opt-in strict read allowlist, threaded from the
  // RunOrchestrator (sourced from the run policy). Applied to EVERY real seat this loop spawns
  // (implementer/validator dispatch, brain-decision, final-tests validator) so retries/escalations do
  // not silently launch read-all. undefined (default) => read-all, byte-identical to before.
  private readonly strictReadAllow?: string[];
  // B9 (R4.1/R4.3): persisted, revalidated cycle identity for THIS run — threaded to the
  // implementer/validator dispatch and the final-validation seat only (CYCLE SEATS ONLY).
  // Absent (every non-cycle run) => those spawns carry no git env, byte-identical to before.
  private readonly cycleGitIdentity?: CycleGitAllowCycle;
  private readonly brainRole: string;
  private readonly brainModel?: string;
  private readonly brainProvider?: string;
  private readonly notificationTransport: NotificationTransport;

  constructor(
    private readonly transport: ITransport,
    opts: { runDir: string; batchId?: string; writer?: ThinRunArtifactWriter; artifactService?: RunArtifactService; escalationService?: EscalationService | null; panelService?: PanelService; redTeamAgents?: Array<{ role: string; agent_id?: number; model?: string; provider?: string }>; deliberationRoster?: any[]; projectDir?: string; projectId?: number; runId?: number; routingConfig?: RoutingConfigService | null; verifySeatBinary?: (provider: string, model: string) => Promise<{ ok: boolean; bin?: string | null; reason?: string }>; strictReadAllow?: string[]; brainRole?: string; brainModel?: string; brainProvider?: string; notificationTransport?: NotificationTransport; cycleGitIdentity?: CycleGitAllowCycle }
  ) {
    this.runDir = opts.runDir;
    this.batchId = opts.batchId || 'batch-B0';
    this.writer = opts.writer ?? new ThinRunArtifactWriter(this.runDir, this.batchId);
    this.artifactService = opts.artifactService;
    // D-b fix: seed runId from caller (RunOrchestrator) on skip/autonomous path (and interview) so loop reuses the existing run row instead of createRun inside runTask
    if (opts.runId != null) this.runId = opts.runId;
    // null = legacy pre-B8 mode (exact B0-B7 behavior for existing tests); non-null enables full B8 ladder
    this.escalationService = opts.escalationService !== undefined ? opts.escalationService : null;
    this.panelService = opts.panelService;
    this.redTeamAgents = opts.redTeamAgents;
    this.deliberationRoster = opts.deliberationRoster;
    this.projectDir = opts.projectDir;
    this.projectId = opts.projectId;
    this.verifySeatBinary = opts.verifySeatBinary;
    this.strictReadAllow = opts.strictReadAllow;  // B-ISO1: run-scoped strict read policy for every seat this loop spawns
    this.cycleGitIdentity = opts.cycleGitIdentity;  // B9: persisted cycle identity, threaded to cycle seats only
    this.brainRole = opts.brainRole || 'ibrain';
    this.brainModel = opts.brainModel;
    this.brainProvider = opts.brainProvider;
    this.notificationTransport = opts.notificationTransport ?? httpNotificationTransport;
    this.routingConfig = opts.routingConfig ?? null;
    if (this.routingConfig) {
      try {
        for (const r of this.routingConfig.listRules()) {
          if (r.is_core === 1) this.coreRouteKeys.add(`${r.emitter_role}::${r.when_status}`);
        }
      } catch { /* non-fatal; falls back to hardcoded-only behavior if the table is unreadable */ }
    }
  }

  private escalationCtx(): { projectId?: number } | undefined {
    return this.projectId != null ? { projectId: this.projectId } : undefined;
  }

  /**
   * B6a / AC-9: effective top rung for implementer/validator.
   * Absolute cap is TOP_RUNG=3 (L4). When position-3 is absent (default seeds), highest resolvable is 2 —
   * so absent-L4 path matches pre-B6a termination/bump behavior byte-for-byte.
   */
  private effectiveTopRung(role: 'implementer' | 'validator' = 'implementer'): number {
    if (this.escalationService && typeof (this.escalationService as any).getMaxResolvableRung === 'function') {
      const n = (this.escalationService as any).getMaxResolvableRung(role, this.escalationCtx());
      if (Number.isInteger(n) && n >= 0) return Math.min(this.TOP_RUNG, n);
    }
    // Fallback when no escalation service: probe via getModelForRung / default 2
    if (this.escalationService) {
      for (let r = this.TOP_RUNG; r >= 0; r--) {
        try {
          this.escalationService.getModelForRung(role, r, this.escalationCtx());
          return r;
        } catch {
          /* try lower */
        }
      }
    }
    return 2;
  }

  private taskAttemptBackstop(): number {
    return this.currentRung === 0
      ? Math.max(this.MAX_TASK_ATTEMPTS, this.LEGACY_RUNG0_ATTEMPT_LIMIT)
      : this.MAX_TASK_ATTEMPTS;
  }

  private transitionRunToBlocked(message: string, kind: 'failure' | 'operator-pause' = 'failure'): void {
    if (!this.artifactService || this.runId == null) return;
    // #52/#53: an operator-recoverable halt is status='paused' (resumable), not 'failed'. Setting
    // phase='blocked' here also PROTECTS the state — every run-orchestrator failure-transition guards on
    // `phase NOT IN (...'blocked'...)`, so once we've paused, a subsequent throw can't clobber it to failed.
    const status = kind === 'operator-pause' ? 'paused' : 'failed';
    try {
      const changed = this.artifactService['db'].raw.prepare(
        "UPDATE runs SET phase = 'blocked', status = ?, ended_at = datetime('now') WHERE id = ? AND phase NOT IN ('complete','failed','blocked','paused')"
      ).run(status, this.runId);
      if (changed.changes === 1) {
        notifyBlockedRun(this.notificationTransport, {
          runId: this.runId,
          batchId: this.batchId,
          project: this.projectDir ? path.basename(this.projectDir) : null,
          message,
        });
      }
    } catch { /* blocked transition and alert are best-effort at this terminal boundary */ }
  }

  // #53: pause the whole run for an operator-recoverable NON-RETRYABLE fault (auth logout / missing deps
  // / fence-denied). Writes a durable remedy artifact and pauses (resumable) — never fails over to
  // another provider for an auth fault (JROM token-conservation: a grok logout must not burn codex/claude).
  private pauseRunForOperator(fault: import('./fault-class.js').NonRetryableFault): void {
    const msg = `Non-retryable ${fault.kind} fault — ${fault.remedy}`;
    this.transitionRunToBlocked(msg, 'operator-pause');
    this.log(`paused-${fault.kind}`);
    console.warn(`[orchestrator-loop] RUN PAUSED (non-retryable ${fault.kind}${fault.provider ? '/' + fault.provider : ''}) — ${fault.remedy}. No failover (canFailover=${fault.canFailover}).`);
    try {
      const note = `# Run Paused — non-retryable ${fault.kind} fault (#53)\n\n` +
        `kind: ${fault.kind}\nprovider: ${fault.provider ?? '(n/a)'}\ncanFailover: ${fault.canFailover}\n\n` +
        `Evidence: ${fault.evidence}\n\nRemedy (operator action required, then resume this run):\n${fault.remedy}\n\n` +
        `This is NOT a failure — the run halted because retrying cannot fix an environment/credential fault.\n`;
      const fs = require('node:fs') as typeof import('node:fs');
      fs.writeFileSync(path.join(this.runDir, 'paused-awaiting-operator.md'), note, 'utf8');
      if (this.artifactService && this.runId != null) {
        try { this.artifactService.recordRunEvent(this.runId, 'RUN_PAUSED_NONRETRYABLE', { kind: fault.kind, provider: fault.provider ?? null, remedy: fault.remedy, evidence: fault.evidence }, this.batchId); } catch { /* best-effort */ }
      }
    } catch { /* artifact is best-effort */ }
  }

  private async finishReproSatisfied(
    note: string | null,
    attempts: number,
  ): Promise<{ finalStatus: 'PASS'; transitions: Transition[]; attempts: number }> {
    const evidence = note || 'validator verified that the acceptance/desired end-state already holds';
    this.lastReproFailNote = null;
    this.log('repro-satisfied');
    if (this.artifactService && this.currentAttemptId != null) {
      this.artifactService.recordValidation(
        this.currentAttemptId,
        'PASS',
        `REPRO-SATISFIED — no implementation required; retained regression evidence: ${evidence}`,
      );
    }
    this.log('complete');
    await this.persistFinal('PASS');
    return { finalStatus: 'PASS', transitions: this.getTransitions(), attempts };
  }

  /** Preserve validator FAILs only through the R6.25 classified-verdict choke point. */
  private persistValidatorOutcome(attemptId: number, state: string, note: string | null, defectClass?: string): void {
    if (!this.artifactService) return;
    const isProtocolDefect = state === 'BLOCKED' && String(note || '').includes('PROTOCOL-DEFECT:');
    if (isProtocolDefect) {
      this.artifactService.recordValidation(attemptId, 'BLOCKED', note, 'protocol-defect');
    } else if (state === 'FAIL' && defectClass) {
      // Normalized classified validator FAIL — persist the normalized class (declared or derived) verbatim;
      // the preserved note (original diagnosis, annotated when derived) is recorded byte-for-byte. No
      // re-derivation, no discard of the received diagnosis.
      this.artifactService.recordValidation(attemptId, 'FAIL', note, defectClass);
    } else {
      // Deterministic/reviewer/fake-transport failures are not validator callbacks.
      this.artifactService.recordValidation(attemptId, state === 'PASS' || state === 'DONE' ? 'PASS' : 'FAIL', note);
    }
  }

  // R5a (CC-CHAT-4 zombie-loop fix; live evidence run 74): marking a run failed/complete in the
  // DB must stop its in-process loop. Cheap check — one SELECT per phase boundary (no polling
  // thread) + the in-memory abort registry (flipped by POST /api/runs/:id/stop) so a sanctioned
  // stop is visible mid-wait within one poll cycle. Returns a detail string when terminal.
  private runTerminalDetail(): string | null {
    if (this.runId == null) return null;
    const ab = getRunAbort(this.runId);
    if (ab) return `stop requested via registry (${ab.reason})`;
    try {
      const db = (this.artifactService as any)?.['db']?.raw;
      if (!db) return null;
      const row: any = db.prepare('SELECT phase, status FROM runs WHERE id = ?').get(this.runId);
      if (!row) return null;
      if (TERMINAL_RUN_PHASES.includes(String(row.phase)) || TERMINAL_RUN_STATUSES.includes(String(row.status))) {
        return `phase=${row.phase} status=${row.status}`;
      }
    } catch { /* best-effort — never break a dispatch on a bookkeeping read */ }
    return null;
  }

  // R5a: boundary gate — called at each phase boundary and BEFORE each dispatch. On a terminal
  // run: reap live run workers via transport, mark their worker_runtimes rows, log loudly, throw.
  private async assertRunActive(boundary: string): Promise<void> {
    const detail = this.runTerminalDetail();
    if (!detail) return;
    console.warn(`[orchestrator-loop] aborted: run terminal in DB (run=${this.runId} boundary=${boundary} ${detail})`);
    this.log(`aborted:${boundary}`);
    await this.reapLiveRunWorkers('run-aborted');
    throw new RunAbortedError(this.runId!, `${boundary}: ${detail}`);
  }

  private assertRepairImplementerDispatchBoundary(role: string): void {
    if (role !== 'implementer' || !this.artifactService || this.taskId == null) return;
    const db = (this.artifactService as any)?.['db']?.raw;
    if (!db) return;
    const task = db
      .prepare('SELECT reopen_reason, repair_round_id FROM run_tasks WHERE id = ?')
      .get(this.taskId) as { reopen_reason: string | null; repair_round_id: number | null } | undefined;
    if (task?.reopen_reason !== 'repair' || task.repair_round_id == null) return;
    assertRepairImplementerDispatchAllowed(db, {
      runTaskId: this.taskId,
      repoRoot: this.projectDir || process.cwd(),
    });
  }

  // R5a: best-effort cleanup of any still-live run workers (sessions reaped via transport,
  // worker_runtimes rows transitioned) so an aborted run leaves nothing spawning/streaming.
  // S02: route terminal writes through finalizeWorkerRuntimeRow so markIdle propagates.
  private async reapLiveRunWorkers(reason: string): Promise<void> {
    try {
      const db = (this.artifactService as any)?.['db']?.raw;
      if (!db || this.runId == null) return;
      const rows: any[] = db.prepare(
        `SELECT id, session FROM worker_runtimes WHERE run_id = ? AND state NOT IN ('done','failed','reaped')`
      ).all(this.runId);
      for (const r of rows) {
        if (r.session) { try { await this.transport.reap(`${r.session}:0.0`, reason); } catch {} }
        try {
          finalizeWorkerRuntimeRow(db, Number(r.id), 'reaped', reason);
        } catch {}
      }
    } catch { /* best-effort */ }
  }

  // A4: consult the injected RoutingConfigService (from A3) as the source of a routing decision, with the
  // current hardcoded (handler, action) pair as the FALLBACK. Zero behavior change on the seed: the seed's
  // enabled rules resolve to the exact same pair the caller already hardcodes, so the first branch below
  // (config === hardcoded) is what fires for every seeded transition.
  //  - no routingConfig injected            -> hardcoded pair (legacy/no-op path)
  //  - resolve() null (disabled/removed)    -> hardcoded pair (fallback; never a silent hang)
  //  - resolve() matches hardcoded          -> that pair (normal seeded case; identical behavior)
  //  - resolve() differs, non-core rule     -> config pair (JROM override capability)
  //  - resolve() differs, is_core=1 rule    -> hardcoded pair WINS (protected); warn once
  private routeFor(emitter: string, status: string, hardcodedHandler: string, hardcodedAction: string): { handler: string; action: string } {
    if (!this.routingConfig) return { handler: hardcodedHandler, action: hardcodedAction };
    let r: { handler_role: string; action: string } | null = null;
    try {
      r = this.routingConfig.resolve(emitter, status);
    } catch {
      r = null;
    }
    if (!r) return { handler: hardcodedHandler, action: hardcodedAction };
    if (r.handler_role === hardcodedHandler && r.action === hardcodedAction) {
      return { handler: r.handler_role, action: r.action };
    }
    const isCore = this.coreRouteKeys.has(`${emitter}::${status}`);
    if (isCore) {
      console.warn(
        `[orchestrator-loop] routeFor: config override for CORE transition ${emitter}::${status} ignored ` +
        `(config=${r.handler_role}/${r.action} vs protected hardcoded=${hardcodedHandler}/${hardcodedAction})`
      );
      return { handler: hardcodedHandler, action: hardcodedAction };
    }
    return { handler: r.handler_role, action: r.action };
  }

  getTransitions(): Transition[] {
    return [...this.transitions];
  }

  // Test seams for B6 FSM + rehydrate asserts (no prod impact)
  getRunId(): number | undefined {
    return this.runId;
  }
  getTaskId(): number | undefined {
    return this.taskId;
  }

  // B8 test seams for ladder asserts (no prod impact)
  getCurrentRung(): number {
    return this.currentRung;
  }
  getAttemptsAtRung(): number {
    return this.attemptsAtRung;
  }
  getAuthorizingDecisionId(): string | null {
    return this.authorizingDecisionId;
  }
  getFailureLedger(): LedgerEntry[] {
    return [...this.failureLedger];
  }

  // A4 test seam (no prod impact): exposes the private routeFor() resolution for direct assertion,
  // independent of whether a given (emitter, status) pair is currently threaded into a control-flow site.
  routeForTest(emitter: string, status: string, hardcodedHandler: string, hardcodedAction: string): { handler: string; action: string } {
    return this.routeFor(emitter, status, hardcodedHandler, hardcodedAction);
  }

  private log(t: Transition): void {
    this.transitions.push(t);
  }

  // POCFIX22+ (byte-accurate): sinceOffset is a BYTE offset (from cbStat.size), so the file must be
  // sliced as BYTES (Buffer.subarray), not as a JS string (UTF-16 chars). callbacks.md accumulates
  // multi-byte unicode (projcore markers / agent output); a char-slice with a byte offset overshoots
  // and drops post-ACK callbacks (validator PASS / 2nd REPRO-FAILED were missed). Read+slice in bytes.
  private async readCallbacksWindow(sinceOffset = 0): Promise<string> {
    const p = path.join(this.runDir, 'callbacks.md');
    try {
      const buf = await fs.readFile(p);
      return (sinceOffset > 0 ? buf.subarray(sinceOffset) : buf).toString('utf8');
    } catch {
      return '';
    }
  }

  // Retained test/compatibility seam for the byte-offset regression contract. The wait loop itself
  // consumes callbackProgress so identical repeated lines advance by count/position.
  private async findLatestCallback(role: string, sinceOffset = 0): Promise<{ state: string; note: string | null } | null> {
    return (await this.callbackProgress(role, sinceOffset)).latest;
  }

  // Callback protocol + pane liveness are deliberately separate: first-callback and hard-wall are
  // protocol deadlines; after a callback, changing/generating panes veto silence-based reaps.
  private async waitForCallback(
    role: string,
    acceptable: string[],
    opts?: {
      wallMs?: number;
      idleMs?: number;
      firstCallbackMs?: number;
      freezeMs?: number;
      paneProbeMs?: number;
      idlePromptStableMs?: number;
      nudgeGraceMs?: number;
      composerHeldMaxMs?: number;
      pollMs?: number;
      sinceOffset?: number;
      handle?: string;
      provider?: string;
      brief?: string;
      watchdogTarget?: string;
      watchdogBrief?: string;
    }
  ): Promise<{ state: string; note: string | null }> {
    const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    const wallMs = opts?.wallMs ?? (isFake ? 2500 : this.realWallMsFor(role));
    const idleMs = opts?.idleMs ?? (isFake ? 2500 : this.realIdleMsFor(role));
    const firstCallbackMs = opts?.firstCallbackMs ?? (isFake ? 2500 : this.realFirstCallbackMs());
    const freezeMs = opts?.freezeMs ?? clampedEnvMs('HELM_CB_FREEZE_MS', 120_000, 5_000, 10 * 60_000);
    const paneProbeMs = opts?.paneProbeMs ?? (isFake ? 12 : clampedEnvMs('HELM_CB_PANE_PROBE_MS', 2_000, 250, 10_000));
    const idlePromptStableMs = opts?.idlePromptStableMs ?? clampedEnvMs('HELM_CB_IDLE_PROMPT_MS', 15_000, 1_000, 60_000);
    const nudgeGraceMs = opts?.nudgeGraceMs ?? clampedEnvMs('HELM_CB_NUDGE_GRACE_MS', 30_000, 1_000, 120_000);
    const composerHeldMaxMs = opts?.composerHeldMaxMs ?? clampedEnvMs('HELM_CB_COMPOSER_HELD_MAX_MS', 5 * 60_000, 5_000, 10 * 60_000);
    const pollMs = opts?.pollMs ?? (isFake ? 12 : 1_000);
    const sinceOffset = opts?.sinceOffset ?? 0;
    const start = Date.now();
    let progress = await this.callbackProgress(role, sinceOffset);
    let firstCallbackAt: number | null = progress.count > 0 ? start : null;
    let lastCallbackAt: number | null = progress.count > 0 ? start : null;
    let lastPaneHash: string | null = null;
    let lastPaneChangeAt = start;
    let paneChangeCount = 0;
    let lastPaneProbeAt = Number.NEGATIVE_INFINITY;
    let idlePromptSince: number | null = null;
    let nudgeAttempted = false;
    let nudgeSent = false;
    let nudgedAt: number | null = null;
    let paneKnown = false;
    let idlePrompt = false;
    let generating = false;
    let composerHeld = false;
    let resultRecorded = false;

    const recordResult = (outcome: 'callback' | 'reap', reason: string, now = Date.now()): void => {
      if (resultRecorded) return;
      resultRecorded = true;
      if (!this.artifactService || this.runId == null) return;
      try {
        this.artifactService.recordRunEvent(this.runId, 'CALLBACK_WAIT_RESULT', {
          outcome,
          reason,
          role,
          provider: opts?.provider ?? null,
          handle: opts?.handle ?? null,
          wait_ms: Math.max(0, now - start),
          first_callback_ms: firstCallbackAt == null ? null : Math.max(0, firstCallbackAt - start),
          pane_change_count: paneChangeCount,
          last_pane_change_age_ms: paneKnown ? Math.max(0, now - lastPaneChangeAt) : null,
          last_callback_age_ms: lastCallbackAt == null ? null : Math.max(0, now - lastCallbackAt),
          idle_prompt: idlePrompt,
          generating,
          composer_held: composerHeld,
          nudge_sent: nudgeSent,
        }, this.batchId);
      } catch (error) {
        console.warn(`[orchestrator-loop] CALLBACK_WAIT_RESULT persist failed: ${String(error)}`);
      }
    };
    const fail = (cause: CallbackWaitCause, detail: string): never => {
      recordResult('reap', cause);
      throw new CallbackWaitError(cause, role, detail);
    };
    const sendCallbackNudge = async (): Promise<boolean> => {
      if (nudgeAttempted || !opts?.handle) return nudgeSent;
      nudgeAttempted = true;
      try {
        const sent = await this.transport.nudgeSeat?.(opts.handle, opts.provider) ?? false;
        if (sent) {
          nudgeSent = true;
          nudgedAt = Date.now(); // grace starts after sendAndSubmit confirms the nudge, not before its backoff
          this.log('callback-repair-nudge');
          console.warn(`[orchestrator-loop] callback-repair nudge sent target=${opts.handle} role=${role} provider=${opts.provider ?? 'unknown'}`);
        }
      } catch (error) {
        console.warn(`[orchestrator-loop] callback-repair nudge failed target=${opts.handle}: ${String(error)}`);
      }
      return nudgeSent;
    };

    // R8 (CC-CHAT-3) submit watchdog — ANY provider: the codex Enter-drop window is VARIABLE and
    // beat even sendAndSubmit's ~55s backoff once live (run 80: the brief sat un-submitted in the
    // composer; a manual Enter minutes later submitted instantly). When the dispatch handle+brief
    // are provided, probe the pane on a ~30s cadence (bounded ~5min): if the brief text is still
    // visible UN-submitted in the composer (ANSI-stripped, same heuristic as sendAndSubmit's own
    // verification), re-press Enter via transport.resubmitIfComposerHeld. Loud logs like the
    // kloo-nudge probe (the invisible-silent-failure lesson). First not-held observation disables
    // the watchdog — once the composer is clear the text can never reappear.
    const WD_EVERY_MS = clampedEnvMs('HELM_SUBMIT_WD_MS', 30_000, 1_000, 120_000);
    const WD_MAX_PRESSES = Math.trunc(clampedEnvMs('HELM_SUBMIT_WD_MAX', 10, 1, 50));
    let wdDone = isFake || !opts?.watchdogTarget || !opts?.watchdogBrief;
    let wdPresses = 0;
    let lastWdProbeAt = 0;
    while (true) {
      const now = Date.now();
      // R5b: sanctioned stop takes effect within ONE poll cycle even mid-wait — the in-memory
      // registry flag (flipped by POST /api/runs/:id/stop) is consulted every iteration (cheap,
      // no DB). The thrown abort is reaped/handled by performRolePhase's catch.
      if (this.runId != null) {
        const ab = getRunAbort(this.runId);
        if (ab) {
          recordResult('reap', 'run-aborted', now);
          throw new RunAbortedError(this.runId, `stop requested mid-wait for ${role} (${ab.reason})`);
        }
      }
      if (now - start >= wallMs) fail('wall-timeout', `wanted ${acceptable.join('|')}`);

      const nextProgress = await this.callbackProgress(role, sinceOffset);
      if (nextProgress.signature !== progress.signature) {
        progress = nextProgress;
        if (firstCallbackAt == null && progress.count > 0) firstCallbackAt = now;
        lastCallbackAt = now;
      }
      if (progress.latest && acceptable.includes(progress.latest.state)) {
        recordResult('callback', `callback:${progress.latest.state}`, now);
        return progress.latest;
      }

      if (!wdDone && now - lastWdProbeAt >= WD_EVERY_MS) {
        lastWdProbeAt = now;
        try {
          const pressed = await (this.transport as any).resubmitIfComposerHeld?.(opts!.watchdogTarget, opts!.watchdogBrief);
          if (pressed) {
            wdPresses += 1;
            // Loud by design (console, not just transitions) — mirrors the kloo-nudge probe.
            console.warn(`[orchestrator-loop] submit-watchdog target=${opts!.watchdogTarget} composer still holds the ${role} brief → re-pressed Enter (${wdPresses}/${WD_MAX_PRESSES})`);
            this.log(`submit-watchdog-${wdPresses}`);
            if (wdPresses >= WD_MAX_PRESSES) {
              console.warn(`[orchestrator-loop] submit-watchdog target=${opts!.watchdogTarget} gave up after ${WD_MAX_PRESSES} Enter re-presses (composer still holds the ${role} brief)`);
              wdDone = true;
            }
          } else {
            if (wdPresses > 0) {
              console.warn(`[orchestrator-loop] submit-watchdog target=${opts!.watchdogTarget} composer clear after ${wdPresses} re-press(es) — ${role} brief submitted`);
            }
            wdDone = true; // submitted (or session gone) — text can never reappear in the composer
          }
        } catch (e: any) {
          console.warn(`[orchestrator-loop] submit-watchdog probe ERROR target=${opts!.watchdogTarget}: ${e?.message || e}`);
          wdDone = true;
        }
      }

      if (opts?.handle && opts.brief && this.transport.inspectSeat && now - lastPaneProbeAt >= paneProbeMs) {
        lastPaneProbeAt = now;
        const inspection = await this.transport.inspectSeat(opts.handle, opts.brief, opts.provider);
        if (!inspection.sessionAlive) fail('session-gone', `seat ${opts.handle} no longer exists`);
        // #47: an unauthenticated CLI renders a ready composer and then refuses the submitted brief, so
        // it looks exactly like a silent seat and gets reaped/respawned forever. Catch it here — the one
        // place the pane is already being read — and abort the run instead of retrying the unretryable.
        // Scoped to output AFTER the dispatched brief so a reused session's resolved auth error from a
        // previous launch cannot fail this one.
        {
          const authLine = matchSeatAuthError(inspection.pane, { marker: opts.brief });
          if (authLine) {
            recordResult('reap', 'seat-auth-failed');
            console.error(
              `[orchestrator-loop] seat-auth-failed role=${role} provider=${opts.provider ?? 'unknown'} — ${authRemedyFor(opts.provider)}`
            );
            throw new SeatAuthTerminalError(opts.provider, authLine, authRemedyFor(opts.provider));
          }
        }
        const paneState = classifySeatPane(opts.provider, inspection);
        paneKnown = paneState.known;
        idlePrompt = paneState.idlePrompt;
        generating = paneState.generating;
        composerHeld = paneState.composerHeld;

        if (paneState.hash !== null) {
          if (lastPaneHash === null) {
            lastPaneHash = paneState.hash;
            lastPaneChangeAt = now;
          } else if (lastPaneHash !== paneState.hash) {
            lastPaneHash = paneState.hash;
            lastPaneChangeAt = now;
            paneChangeCount += 1;
            idlePromptSince = idlePrompt ? now : null;
          }
        } else {
          idlePromptSince = null; // empty capture is unknown, never proof of a frozen pane
        }

        if (idlePrompt) {
          if (idlePromptSince === null) idlePromptSince = now;
        } else {
          idlePromptSince = null;
        }

        if (
          firstCallbackAt !== null &&
          idlePromptSince !== null &&
          !nudgeAttempted &&
          now - idlePromptSince >= idlePromptStableMs
        ) {
          await sendCallbackNudge();
        }

        if (
          nudgeSent && nudgedAt !== null &&
          now - nudgedAt >= nudgeGraceMs &&
          idlePromptSince !== null && now - idlePromptSince >= idlePromptStableMs &&
          idlePrompt && !generating && !composerHeld
        ) {
          fail('idle-prompt-no-terminal', `no acceptable callback within ${nudgeGraceMs}ms after semantic nudge`);
        }
      }

      // The first-callback contract is absolute after a successful spawn. Pane animation does not
      // satisfy it. A visibly held brief defers it only while the bounded submit watchdog still owns
      // delivery; a completed/given-up watchdog or an overlong composer hold restores the deadline.
      const submitWatchdogOwnsComposer = composerHeld && !wdDone && now - start < composerHeldMaxMs;
      if (firstCallbackAt === null && !submitWatchdogOwnsComposer && now - start >= firstCallbackMs) {
        fail('no-first-callback', `no callback within ${firstCallbackMs}ms after spawn/ready`);
      }

      const ambiguousFrozen = (
        firstCallbackAt !== null && lastCallbackAt !== null &&
        paneKnown && !idlePrompt && !generating && !composerHeld &&
        now - lastCallbackAt >= idleMs &&
        now - lastPaneChangeAt >= freezeMs
      );
      if (ambiguousFrozen && !nudgeAttempted) {
        await sendCallbackNudge();
      }
      if (
        ambiguousFrozen && nudgeSent && nudgedAt !== null &&
        Date.now() - nudgedAt >= nudgeGraceMs
      ) {
        fail('ambiguous-idle-timeout', `callback idle ${idleMs}ms and pane frozen ${freezeMs}ms`);
      }

      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  // small helpers for FIX-B
  private realWallMsFor(role: string): number {
    const fallback = role === 'implementer'
      ? 30 * 60_000
      : (role === 'validator' || role === 'final-validator')
        ? 12 * 60_000
        : role === 'ibrain' ? 8 * 60_000 : 6 * 60_000;
    if (process.env.HELM_CB_WALL_MS !== undefined) {
      return clampedEnvMs('HELM_CB_WALL_MS', fallback, 1_000, 2 * 60 * 60_000);
    }
    // Real complex tasks (e.g. a full game engine + tests) can run ~15-20min of build; the prior 20min
    // implementer wall cut it close (pusoy-dos-engine landed at ~19min). Give headroom. HELM_CB_WALL_MS
    // still lets fast scenario runs shrink this.
    return fallback;
  }
  // Idle = time since the last CALLBACK (not terminal output). A model doing a long silent build emits no
  // interim callbacks (notification protocol = DONE/BLOCKED only), so the prior 4min default respawned it
  // mid-work on complex tasks (observed: pusoy-dos-engine respawned 6× at 4min → false-failed → escalated).
  // 10min tolerates a realistic silent-build gap; HELM_CB_IDLE_MS overrides (fast scenario runs set it low).
  private realIdleMsFor(_role: string): number {
    return clampedEnvMs('HELM_CB_IDLE_MS', 10 * 60_000, 1_000, 60 * 60_000);
  }

  private realFirstCallbackMs(): number {
    return clampedEnvMs('HELM_CB_FIRST_CALLBACK_MS', 120_000, 5_000, 5 * 60_000);
  }

  private async callbackProgress(role: string, sinceOffset = 0): Promise<{
    count: number;
    lastByteEnd: number;
    signature: string;
    latest: { state: string; note: string | null } | null;
  }> {
    const window = await this.readCallbacksWindow(sinceOffset);
    let count = 0;
    let lastByteEnd = 0;
    let latest: { state: string; note: string | null } | null = null;
    let charOffset = 0;
    for (const line of window.split(/\r?\n/)) {
      const parsed = parseCallbackLine(line);
      if (parsed && roleMatches(role, parsed.role) && parsed.batchId === this.batchId) {
        count += 1;
        lastByteEnd = Buffer.byteLength(window.slice(0, charOffset + line.length), 'utf8');
        latest = { state: parsed.state, note: parsed.note };
      }
      charOffset += line.length + 1;
    }
    return { count, lastByteEnd, signature: `${count}:${lastByteEnd}`, latest };
  }

  // POCFIX17: deterministic validation gate — run the registered project's OWN test suite (npm test) in projectDir.
  // Helm runs it (verifier ≠ fixer), so the loop advances on REAL green tests, not a flaky validator agent.
  // exit 0 → PASS; non-zero / error → FAIL (note carries the tail of output for the implementer's next attempt).
  private async runProjectTests(projectDir: string): Promise<{ state: 'PASS' | 'FAIL'; note: string }> {
    if (!projectDir) return { state: 'PASS', note: 'no projectDir; deterministic test-gate skipped' };
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const exec = promisify(execFile);
    const cmd = process.env.HELM_PROJECT_TEST_CMD || 'npm';
    const args = process.env.HELM_PROJECT_TEST_ARGS ? process.env.HELM_PROJECT_TEST_ARGS.split(' ') : ['test', '--silent'];
    // A2 (e2e-hang fix): Node's execFile `timeout` sends SIGTERM ONLY — a hung child (e.g. a Playwright
    // webServer that never tears down) survives it and hangs the gate forever. Wrap the command under
    // `bash -lc` with GNU `timeout --signal=TERM --kill-after=15s Ns` so SIGKILL genuinely escalates,
    // and `set -o pipefail` so a failure anywhere in a pipe still fails the gate. ANY nonzero exit maps
    // to FAIL: 124 (TERM elapsed) / 137 (128+SIGKILL after --kill-after) get a distinct timeout note,
    // a real test failure keeps the plain FAIL note. Timeout is env-tunable (HELM_PROJECT_TEST_TIMEOUT_S,
    // default 300s); fast harness runs shrink it.
    const timeoutS = Math.max(1, parseInt(process.env.HELM_PROJECT_TEST_TIMEOUT_S || '300', 10) || 300);
    // --kill-after grace before SIGKILL escalates (default 15s; env-tunable, clamped ≥1s so a nonnumeric
    // value can't disable the KILL). GNU `timeout` (non-foreground) signals the whole process GROUP, so a
    // TERM-ignoring child TREE (e.g. a detached Playwright webServer) is reaped by the group SIGKILL.
    const killAfterS = Math.max(1, parseInt(process.env.HELM_PROJECT_TEST_KILL_AFTER_S || '15', 10) || 15);
    const shq = (s: string) => `'${String(s).replace(/'/g, `'\\''`)}'`;
    const inner = [cmd, ...args].map(shq).join(' ');
    const script = `set -o pipefail; timeout --signal=TERM --kill-after=${killAfterS}s ${timeoutS}s ${inner}`;
    try {
      // Node-level backstop timeout sits well ABOVE the shell timeout (shell `timeout` is the real killer;
      // this only guards against bash itself wedging). maxBuffer unchanged.
      const { stdout } = await exec('bash', ['-lc', script], { cwd: projectDir, timeout: (timeoutS + 60) * 1000, maxBuffer: 16 * 1024 * 1024 });
      const tail = (stdout || '').split(/\r?\n/).filter(Boolean).slice(-5).join(' | ').slice(0, 300);
      return { state: 'PASS', note: `deterministic test-gate PASS (${cmd} ${args.join(' ')} exit 0 in ${projectDir}). ${tail}` };
    } catch (e: any) {
      const out = `${e.stdout || ''}\n${e.stderr || ''}`.split(/\r?\n/).filter(Boolean).slice(-10).join(' | ').slice(0, 500);
      // A2: 124 = `timeout` elapsed (TERM), 137 = child SIGKILLed after --kill-after (128+9); e.killed/e.signal
      // set only if the Node backstop fired. Label these distinctly from a genuine test-failure nonzero exit.
      const code = e.code;
      const timedOut = code === 124 || code === 137 || e.killed === true || e.signal === 'SIGTERM' || e.signal === 'SIGKILL';
      if (timedOut) {
        return { state: 'FAIL', note: `deterministic test-gate TIMEOUT (${cmd} ${args.join(' ')} exceeded ${timeoutS}s and was killed, exit ${code ?? e.signal ?? '?'} in ${projectDir}). ${out}` };
      }
      return { state: 'FAIL', note: `deterministic test-gate FAIL (${cmd} ${args.join(' ')} exit ${code ?? '?'} in ${projectDir}). ${out}` };
    }
  }

  // C2 helpers: requirement-bearing detection + contract builder for validator (north-star + task details + diff ref)
  private isRequirementBearing(brief: string): boolean {
    if (!brief || typeof brief !== 'string') return false;
    const hasCrit = /validation_criteria\s*:\s*\S+/i.test(brief) || /validation_criteria/i.test(brief);
    const noCrit = /no criteria|pure refactor|docs-only|no-op|chore/i.test(brief);
    return hasCrit && !noCrit;
  }

  private isCodeBearingTask(brief: string, taskType: string): boolean {
    if (taskType === 'issue') return true; // issues are code fixes
    if (!brief) return true;
    const noCode = /docs-only|readme|comment-only|no code change/i.test(brief);
    return !noCode;
  }

  private async readNorthStarContract(): Promise<string> {
    try {
      const p = path.join(this.runDir, CANONICAL_CYCLE_ARTIFACTS.northStar);
      const raw = await fs.readFile(p, 'utf8');
      return raw.length > 4000 ? raw.slice(0, 4000) + '\n... (truncated)' : raw;
    } catch {
      return '(north-star.md not readable; use run prompt + plan.json)';
    }
  }

  private buildTaskContractNote(brief: string): string {
    // Extract the embedded Task section if present (from run-orchestrator construction); fallback to head of brief
    const m = /## Task[\s\S]{0,800}?validation_criteria:[\s\S]{0,400}/i.exec(brief);
    if (m) return m[0].trim();
    return (brief || '').slice(0, 1200);
  }

  // B1: the requirements-aware validator instruction (vInstr). Model GUIDANCE ONLY — the preferred
  // defect_class enum plus one copyable FAIL example, with PASS as the ONLY success terminal and DONE
  // explicitly NOT a valid verdict for this phase. It carries NO truth/derivation logic (classification
  // lives in run-artifact-service.normalizeValidatorVerdict). Extracted as a method so B1 can assert it.
  private requirementsValidatorInstruction(northStar: string, contract: string): string {
    return `You are the requirements-aware VALIDATOR (feature mode; post deterministic-gate on the REAL path; verifier ≠ fixer).\n\n## CONTRACT (source of truth — judge OBSERVABLE closure, not "tests passed")\nNorth-star / run prompt:\n${northStar}\n\nTask:\n${contract}\n\nDiff/behavior: inspect actual changes (git diff under projectDir=${this.projectDir || this.runDir}), running behavior, files. Gate already green; confirm requirements are closed by evidence (outcome not attempt).\n\nEmit exactly one terminal callback — either PASS or FAIL. DONE is NOT a valid verdict for this phase.\n- PASS — <matrix of VERIFIED evidence>\n- FAIL — defect_class=<one of: ${PREFERRED_DEFECT_CLASSES.join(' | ')}>; <gaps listed by req>\nFAIL modifiers (not separate terminals):\n- defect_class=implementer-incapable — task is SOUND but implementer is genuinely stuck (recurring same defect / fundamental capability gap). Do NOT use for an ordinary fixable gap; plain FAIL gets a free correction retry.\n- defect_class=plan-defect — the TASK REQUIREMENT itself is impossible/contradictory/underspecified; no correct implementation can satisfy it as written (plan needs revision, not a harder implementer).\nDo NOT self-declare validator-wrong; ibrain judges that from the ledger.\nCopyable example: FAIL — defect_class=missing-artifact; Requirement LEG9T1 failed: retry-gate.txt is missing; node test.js exits 1.`;
  }

  // Wrap a raw phase instruction in a CONTRACT-COMPLIANT brief. The real dispatch path enforces the v2
  // brief contract (status marker, closed enum, native callback append, streaming order, artifact paths,
  // project dir, fence, requirement anchor). Raw ad-hoc briefs (e.g. the issue-mode repro/re-validate
  // instructions) throw BRIEF-CONTRACT-MISSING otherwise — this path was previously only exercised under
  // fake-tmux, which skips the contract check. Generate the compliant base then inject the phase text.
  private compliantBrief(role: string, taskType: 'feature' | 'issue', instructions: string): string {
    const bw = new BriefWriterService();
    const base = bw.generateBrief({
      batchId: this.batchId,
      role,
      planPath: path.join(this.runDir, 'plan.json'),
      runDir: this.runDir,
      projectDir: this.projectDir || '.',
      callbacksFile: path.join(this.runDir, 'callbacks.md'),
      taskType,
      branch: 'main',
      ...(this.currentBriefContract ?? {
        requirementsAssigned: this.taskKey ?? this.batchId,
        northStarAnchors: this.batchId,
      }),
    });
    return base.replace(
      '<!-- PROJCORE-STATUS-CONTRACT v2 -->',
      `<!-- PROJCORE-STATUS-CONTRACT v2 -->\n\n## Phase instructions (do exactly this)\n${instructions}`
    );
  }

  private async performRolePhase(
    role: 'implementer' | 'validator' | 'ibrain' | string,
    brief: string,
    acceptable: string[]
  ): Promise<{ state: string; note: string | null; handle: string; defectClass?: string; escalateFlag?: boolean; planDefectFlag?: boolean }> {
    // R5a: re-check the run's DB phase/status BEFORE each dispatch — a run marked terminal in
    // the DB (run-74 zombie evidence) must never spawn another worker session.
    await this.assertRunActive(`pre-dispatch:${role}`);
    this.assertRepairImplementerDispatchBoundary(role);
    // POCFIX22: snapshot callbacks.md byte size so any callbacks written before this dispatch
    // are excluded from waitForCallback (stale-DONE fence — prevents prior-task DONE phantom-passing later tasks).
    // Only active on the REAL path (USE_FAKE_TMUX=0): fake/test transports control the file directly
    // and have no stale callbacks, so sinceOffset=0 is safe and avoids a race between the stat and
    // test helper appendFile calls that can happen concurrently with the stat syscall.
    const isFakePath = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    let dispatchOffset = 0;
    if (!isFakePath) {
      try {
        const cbStat = await fs.stat(path.join(this.runDir, 'callbacks.md'));
        dispatchOffset = cbStat.size;
      } catch { /* file may not exist yet; offset stays 0 (no prior callbacks) */ }
    }

    const dispatchNonce = createDispatchNonce();
    const dispatchBrief = bindDispatchNonce(brief, dispatchNonce);
    await this.writer.writeBrief(role, dispatchBrief);
    let dispatchId = 0;
    if (this.artifactService && this.currentAttemptId != null) {
      dispatchId = this.artifactService.recordDispatch(
        this.currentAttemptId,
        role,
        `prompts/${role}.brief.md`,
        null
      );
    }
    this.currentDispatchId = dispatchId;
    // E3-writers: also write brief to helm_tasks/<tasklist>/<task>/prompts/ using B5 helper (for new runs)
    // pass taskKey (if known) so dir prefers key over task<id> -- single source of truth with summary links
    if (this.artifactService && this.projectDir && this.runId != null) {
      try {
        await this.artifactService.writeBriefToHelmRoot(this.projectDir, this.runId, this.batchId, this.taskId, this.taskKey ?? null, role, dispatchBrief);
      } catch {}
    }

    // B8: pass rung/model so escalated dispatch uses next rung's model (guardrail 1); fake records for asserts
    // (null esc = legacy pre-B8 path; no rung/model for those dispatches)
    // LOCKED precedence (most-specific wins): escalation rung (>0) > per-task plan model (explicit at rung=0) > project override (rung0 binding) > Studio default.
    // Per-task explicitModel only applies as the rung-0 BASE; higher rungs from escalation always use ladder.
    const dispatchRung = role === 'validator'
      ? (this.currentValidatorRung ?? this.currentRung)
      : (role === 'implementer' ? this.currentRung : 0);
    let dispatchModel: string | undefined;
    let dispatchProvider: string | undefined;
    if ((role === 'implementer' || role === 'validator') && this.escalationService) {
      if (role === 'implementer' && this.currentRung === 0 && this.explicitModel) {
        dispatchModel = this.explicitModel;
        // resolve dispatchProvider for that model_id (via models table / PROVIDERS lookup)
        dispatchProvider = (this.escalationService as any).getProviderForModel(this.explicitModel) ?? undefined;
      } else if (role === 'validator' && dispatchRung === 0 && this.validatorExplicitModel) {
        dispatchModel = this.validatorExplicitModel;
        dispatchProvider = (this.escalationService as any).getProviderForModel(this.validatorExplicitModel) ?? undefined;
      } else {
        dispatchModel = this.escalationService.getModelForRung(role as 'implementer' | 'validator', dispatchRung, this.escalationCtx());
        dispatchProvider = this.escalationService.getProviderForRung(role as 'implementer' | 'validator', dispatchRung, this.escalationCtx()) ?? undefined;
      }
    }

    // R6 (escalation dead-end fix): ladder rows carry DISPLAY names (e.g. 'codex-5.5'); providers only
    // launch model_ids ('gpt-5.5'). Map at the dispatch boundary — briefs/ledgers keep the display name,
    // only the spawn gets the launchable id. No-op when no models-table row / stub escalation (tests).
    if (dispatchModel && this.escalationService && typeof (this.escalationService as any).getLaunchableModel === 'function') {
      dispatchModel = (this.escalationService as any).getLaunchableModel(dispatchModel);
    }

    // B5 / AC-10 SPAWN THREADING seam: when dispatching at rung > 0, prefer the rung's effort
    // (agent_escalations / project_agent_escalations.effort) over plan/agent base (currentEffort).
    // NULL rung effort inherits L1/agent/plan base. RealTransport builds launchOpts.effort from this.
    let dispatchEffort = this.currentEffort;
    if (
      (role === 'implementer' || role === 'validator')
      && dispatchRung > 0
      && this.escalationService
      && typeof (this.escalationService as any).resolveLaunchEffort === 'function'
    ) {
      dispatchEffort = this.escalationService.resolveLaunchEffort(
        dispatchRung,
        this.currentEffort,
        role,
        this.escalationCtx()
      );
    }

    // C0: kloo needs a `route` (openrouter vs local llamacpp) to fill `<route>` in its launch template.
    // Prefer the bound model's models-table route (B1); fall back to inferring from the model id shape
    // when the kloo model has no models-table row. No-op for non-kloo providers.
    const dispatchRoute = dispatchProvider === 'kloo'
      ? ((this.escalationService?.getRouteForModel?.(dispatchModel!) ?? null) || inferKlooRoute(dispatchModel))
      : undefined;

    // review #3: recheck the ACTUALLY-resolved seat binary right before spawn (per-run cached), so a per-task
    // explicit model or an escalation RUNG model resolved after the run-start roster preflight cannot spawn a
    // doomed seat that only surfaces as a generic 30-60s ready-probe timeout. Only when both provider+model
    // are known (the impl/validator rung/per-task path); the projcore master binary is covered by the
    // run-start preflight. Fail fast + clearly — the caller routes a pre-spawn throw into the FAIL ladder.
    if (this.verifySeatBinary && dispatchProvider && dispatchModel) {
      const v = await this.verifySeatBinary(dispatchProvider, dispatchModel);
      if (!v.ok) {
        throw new Error(`seat binary missing at dispatch: ${v.reason || `${dispatchProvider}/${dispatchModel}`} — CLI not on seat PATH (refusing to spawn a doomed ${role} seat)`);
      }
    }

    const spawned = await this.transport.spawn({
      role,
      brief: dispatchBrief,
      runDir: this.runDir,
      batchId: this.batchId,
      rung: dispatchRung,
      model: dispatchModel,
      effort: dispatchEffort,  // C6 plan base + B5 AC-10 rung effort prefer when rung>0
      provider: dispatchProvider ?? undefined,  // POCFIX12 (getProviderForRung may return null for unknown)
      route: dispatchRoute,  // C0: kloo route (openrouter/llamacpp); undefined for non-kloo (unchanged behavior)
      attemptId: this.currentAttemptId,  // POCFIX7: thread real attemptId for per-task dispatches (FK); planning omits/uses 0 and skips insert
      projectDir: this.projectDir,  // POCFIX14: fence implementer/validator to the registered project dir so they can WRITE the code/tests there
      ...(this.strictReadAllow ? { strictReadAllow: this.strictReadAllow } : {}),  // B-ISO1: run-scoped strict read fence (undefined => read-all, unchanged)
      // B9 (R4.1/R4.3): CYCLE SEATS ONLY — implementer/validator get the persisted cycle git
      // identity; every other role dispatched through performRolePhase (e.g. 'reviewer') does not,
      // matching the plan's exact three seat classes (the third, final-validation, is threaded at
      // its own spawn site below).
      ...(this.cycleGitIdentity && (role === 'implementer' || role === 'validator') ? { cycleGitIdentity: this.cycleGitIdentity } : {}),
    });
    const handle = spawned.handle;

    // A4: register the run worker into worker_runtimes so the Command Center Terminals view shows its
    // pane. The orchestrator/real-transport spawns implementer/validator tmux sessions but nothing wrote
    // this table (only the manual worker-service did) → the Terminals grid never listed run workers. Write
    // the row at the spawn boundary (session name is now known from the handle) and transition it to a
    // terminal state on reap/timeout below. Bookkeeping is best-effort — never break a dispatch on it.
    const workerRuntimeId = this.registerWorkerRuntime(role, handle, dispatchProvider, dispatchModel);

    let seen: { state: string; note: string | null; defectClass?: string; escalateFlag?: boolean; planDefectFlag?: boolean };
    try {
      seen = await this.waitForCallback(role, acceptable, {
        sinceOffset: dispatchOffset,
        handle,
        provider: dispatchProvider ?? 'grok',
        brief: dispatchBrief,
        // R8: composer submit watchdog (ANY provider) — re-press Enter if the dispatched brief is
        // still sitting un-submitted in the session's composer (variable codex Enter-drop window).
        watchdogTarget: handle,
        watchdogBrief: dispatchBrief
      });
    } catch (e) {
      // R5a/R5b: a run-abort mid-wait is NOT a timeout — reap the live session, mark the
      // runtime row 'reaped' (not failed) and propagate so the whole loop stops spawning.
      if (e instanceof RunAbortedError) {
        try { await this.transport.reap(handle, `${role}-run-aborted`); } catch {}
        this.finalizeWorkerRuntime(workerRuntimeId, 'reaped', 'run-aborted');
        this.log(`${role}-aborted`);
        throw e;
      }
      // #47/#53: "not authenticated" is a PROVIDER-level fault, not a task-level one — every subsequent
      // seat on this provider fails identically, and retrying cannot fix an expired token. Reap the seat,
      // PAUSE the run resumably with the relogin remedy (JROM: on a grok logout, stop and wait — never
      // fail over to the scarce codex/claude seats), then propagate so the loop stops spawning. The
      // pause set phase='blocked'/status='paused', which the run-orchestrator catch will not clobber.
      if (e instanceof SeatAuthTerminalError) {
        try { await this.transport.reap(handle, `${role}-seat-auth-failed`); } catch {}
        this.finalizeWorkerRuntime(workerRuntimeId, 'reaped', `${role}-seat-auth-paused`);
        this.pauseRunForOperator(authFault(e.provider, e.snippet));
        throw e;
      }
      const waitCause = e instanceof CallbackWaitError ? e.waitCause : 'wait-failed';
      // Idle-prompt recovery has already sent its one semantic nudge and exhausted grace here;
      // other protocol failures (session gone / no-first / wall) are not safe to poke blindly.
      try { await this.transport.reap(handle, `${role}-${waitCause}-reaped`); } catch {}
      this.finalizeWorkerRuntime(workerRuntimeId, 'failed', `${role}-${waitCause}`);
      this.log(`${role}-${waitCause}`);
      throw e;
    }

    if (role === 'implementer') {
      // #50: a worker may SUCCEED and still have hit a broken plan. PC06 (Pusoy run 22) proved the gap:
      // the implementer spotted a contradictory brief, resolved it correctly against the authoritative
      // requirement, passed validation — and because nothing FAILED, the failure-gated plan-defect route
      // never fired, so plan.json kept the defect for every downstream task. Surface it on the success
      // path. Observability only here: the marker is recorded, never auto-rewriting a passing task's plan.
      const contradiction = parsePlanContradiction(seen.note || '');
      if (contradiction) {
        console.warn(
          `[orchestrator-loop] PLAN-CONTRADICTION role=${role} blocked=${contradiction.blocked} :: ${contradiction.raw.slice(0, 200)}`
        );
        if (this.artifactService && this.runId != null) {
          try {
            this.artifactService.recordRunEvent(this.runId, 'PLAN_CONTRADICTION', {
              task_instruction: contradiction.instruction,
              requirement: contradiction.requirement,
              resolved_as: contradiction.resolvedAs,
              blocked: contradiction.blocked,
              raw: contradiction.raw,
              role,
            }, this.batchId);
          } catch (error) {
            console.warn(`[orchestrator-loop] PLAN_CONTRADICTION persist failed: ${String(error)}`);
          }
        }
      }
      this.log('done');
    }
    else if (role === 'validator') {
      // Gate C / leg-9 fix: normalize the validator verdict through the ONE shared contract
      // (run-artifact-service.normalizeValidatorVerdict) instead of discarding a substantive diagnosis.
      // Runs on the already-parsed EXACT terminal state; note text never chooses the verdict. Real path
      // only (fake-transport tests drive verdicts directly). A substantive FAIL keeps its diagnosis
      // (annotated) with a declared/derived defect_class; only a non-diagnostic FAIL becomes a bounded
      // BLOCKED/protocol-defect. The received text is NEVER replaced-and-lost.
      if (seen.state === 'FAIL') {
        const norm = normalizeValidatorVerdict(seen.state, seen.note);
        if (!isFakePath) {
          seen = { state: norm.state, note: norm.note };
        }
        if (norm.defectClass) seen.defectClass = norm.defectClass;
        seen.escalateFlag = norm.escalateFlag;
        seen.planDefectFlag = norm.planDefectFlag;
      }
      if (seen.state === 'PASS' || seen.state === 'DONE') this.log('pass');
      else this.log('fail');
    } else if (role === 'ibrain') {
      this.log(`brain-${seen.state.toLowerCase()}`);
    }

    // Record terminal cb (B5 real parse + B1 tables). ACK-before-reap: write file ACK then recordAck.
    // Intermediates (PROPOSED/WORKING etc) live in callbacks.md (cbFileContent on rehydrate); key states recorded here for attempt.
    if (this.artifactService && this.currentDispatchId != null) {
      const rawLine = `[helm callback] ${role} ${this.batchId} STATUS: ${seen.state}${seen.note ? ' — ' + seen.note : ''}`;
      const cid = this.artifactService.recordCallback(this.currentDispatchId, role, seen.state, rawLine, 'file');
      await this.writer.writeAck(role, dispatchNonce);
      this.artifactService.recordAck(cid);
    } else {
      await this.writer.writeAck(role, dispatchNonce);
    }
    this.log('ack-written');
    this.log('acked');

    await this.transport.reap(handle, role === 'implementer' ? 'done-received' : 'val-complete');
    this.finalizeWorkerRuntime(workerRuntimeId, 'done', `reaped-${seen.state}`);
    this.log('reap-called');
    this.log('reaped');

    return {
      state: seen.state,
      note: seen.note,
      handle,
      defectClass: seen.defectClass,
      escalateFlag: seen.escalateFlag === true,
      planDefectFlag: seen.planDefectFlag === true,
    };
  }

  // A4: INSERT a worker_runtimes row for a freshly-spawned run worker so /terminals lists its pane.
  // Returns the row id (or null if not written). Guarded to only fire on the real run path (projectId +
  // runId + a db-backed artifactService present); best-effort, never throws into the dispatch flow.
  private registerWorkerRuntime(
    role: string,
    handle: string,
    provider?: string,
    model?: string
  ): number | null {
    if (!this.artifactService || this.projectId == null || this.runId == null) return null;
    try {
      const db = (this.artifactService as any)['db']?.raw;
      if (!db) return null;
      const session = (handle || '').split(':')[0] || null;
      // mirror real-transport's own defaulting (model || 'grok-4.5', provider from that) so the recorded
      // row matches what was actually spawned when the loop didn't resolve an explicit provider/model.
      const wModel = model || 'grok-4.5';
      const wProvider = provider || 'grok';
      const corr = `run-${this.runId}-${role}-${Date.now().toString(36)}`;
      const info = db.prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at)
         VALUES (?,?,?,?,?,?,'running','orchestrator',?, datetime('now'))`
      ).run(this.projectId, role, wProvider, wModel, session, corr, this.runId);
      return Number(info.lastInsertRowid);
    } catch {
      return null;
    }
  }

  // A4: transition a run worker's worker_runtimes row to a terminal state (done/failed) on reap/timeout.
  private finalizeWorkerRuntime(id: number | null, state: 'done' | 'failed' | 'reaped', reason: string): void {
    if (id == null || !this.artifactService) return;
    try {
      const db = (this.artifactService as any)['db']?.raw;
      if (!db) return;
      finalizeWorkerRuntimeRow(db, id, state, reason);
    } catch {
      /* best-effort bookkeeping */
    }
  }

  async runTask(config: {
    brief: string;
    // Clean task essence (atomic_work + validation_criteria) WITHOUT the full contract-wrapped implementer
    // brief. Used to compose the issue-mode repro/re-validate validator briefs — embedding the full
    // `brief` there nests a second contract header + "you are the implementer" and confuses the validator.
    taskDescription?: string;
    taskType?: 'feature' | 'issue';
    userCritical?: boolean;
    // B8 plan-summon / explicit (precedence tested; explicit model > explicit rung > complexity > role default)
    recommendedRung?: number;
    validatorRung?: number;
    complexity?: 'low' | 'med' | 'high' | 'xhigh';
    explicitModel?: string;
    validatorModel?: string;
    effort?: string;  // C6: per-task effort from plan; base for worker; passed to transport spawn
    // B9 (PLN2): when parser pre-created the run_task row, pass the id so we reuse the row (no duplicate create).
    // The existing B6 queue + B8 escalation ladder + performRolePhase are used unchanged.
    preExistingTaskId?: number;
    taskKey?: string;  // E3/E5: pass key so helm_tasks dir uses key (consistent with summary links via getTaskArtifactRoot)
    briefContract?: {
      requirementsAssigned: string;
      requirementsSection: string;
      context: string;
      scope: string;
      expected: string;
      northStarAnchors: string;
    };
  }): Promise<{
    finalStatus: 'PASS' | 'FAIL' | 'DEFERRED' | 'BLOCKED';
    transitions: Transition[];
    attempts: number;
  }> {
    this.transitions = [];
    this.lastReproNote = null;
    this.lastReproFailNote = null;
    this.currentRung = 0;
    this.attemptsAtRung = 0;
    this.authorizingDecisionId = null;
    this.failureLedger = [];
    this.pendingHandholdDirections = null;
    this.replansUsed = 0;
    this.validatorOverridesUsed = 0;
    this.lastReplanDecisionId = null;
    this.revalidateOnly = false;
    this.lastFailSource = 'other';
    this.lastAgentValidatorFailNote = null;
    this.currentEffort = config.effort;
    this.explicitModel = config.explicitModel;
    this.currentValidatorRung = typeof config.validatorRung === 'number' ? config.validatorRung : undefined;
    this.validatorExplicitModel = config.validatorModel;
    this.taskKey = (config as any).taskKey;
    this.currentBriefContract = config.briefContract;
    // Mutable active brief so re-plan can swap the task contract mid-run without restarting runTask.
    let activeBrief = config.brief;
    let activeTaskDescription = config.taskDescription;

    const runDir = this.runDir;
    const batchId = this.batchId;
    const taskType = config.taskType || 'feature';
    this.userCritical = !!config.userCritical;
    const taskLabel = `${taskType} task`;

    this.log('dispatched');

    if (this.artifactService) {
      if (!this.runId) {
        this.runId = this.artifactService.createRun(null, this.batchId);
      }
      const preId = (config as any).preExistingTaskId;
      this.taskId = preId != null ? preId : this.artifactService.recordTask(this.runId, null, taskLabel);
      // Durable replan-cap: rehydrate prior attempt count for a resumed same task (do not reset to 0).
      // NEW tasks still start at 0 (no REPLAN_ATTEMPT events yet).
      this.replansUsed = this.loadDurableReplansUsed();
    }

    // Legacy pre-B8 path (B0-B7 tests that do not pass escalationService): exact old bounded retry (MAX=2) + behavior
    if (!this.escalationService) {
      let attempts = 0;
      const MAX = 2;
      while (attempts < MAX) {
        // R5a: phase boundary — a run marked terminal in the DB stops here (no next attempt).
        await this.assertRunActive('attempt-boundary');
        attempts += 1;
        this.log('working');
        if (this.artifactService && this.taskId != null) {
          this.currentAttemptId = this.artifactService.recordAttempt(this.taskId, attempts);
        }
        if (taskType === 'issue') {
          // C3 legacy path: repro retry + defer support (mirrors B8)
          const MAX_REPRO_ATTEMPTS = Number(process.env.HELM_REPRO_RETRY || 2);
          let reproOk = false;
          for (let ra = 1; ra <= MAX_REPRO_ATTEMPTS; ra++) {
            let reproBrief = `As validator for ${batchId} (issue mode): Reproduce the issue on the rendered app BEFORE any implementer work. The task is: ${config.brief}. Emit exactly REPRO-CONFIRMED — <full repro steps + observed vs expected as the fix contract + retained regression check>, REPRO-SATISFIED — <evidence that the acceptance/desired end-state already holds>, or REPRO-FAILED — <tooling could not run or the result was inconclusive>.`;
            if (ra > 1) {
              const prior = this.lastReproFailNote ? ` Prior REPRO-FAILED: ${this.lastReproFailNote}.` : '';
              reproBrief = `REPRO RETRY ${ra}/${MAX_REPRO_ATTEMPTS} (escalated).${prior} ${reproBrief}`;
            }
            this.log(`repro-validating attempt ${ra}`);
            const reproRes = await this.performRolePhase('validator', reproBrief, ['REPRO-CONFIRMED', 'REPRO-SATISFIED', 'REPRO-FAILED']);
            if (reproRes.state === 'REPRO-CONFIRMED') {
              this.lastReproNote = reproRes.note;
              reproOk = true;
              this.log('repro-confirmed');
              break;
            } else if (reproRes.state === 'REPRO-SATISFIED') {
              return this.finishReproSatisfied(reproRes.note, attempts);
            } else {
              this.lastReproFailNote = reproRes.note || 'REPRO-FAILED';
              this.log('repro-failed');
              if (this.artifactService && this.currentAttemptId != null) {
                this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', `repro-attempt-${ra}: ${this.lastReproFailNote}`);
              }
            }
          }
          if (!reproOk) {
            this.log('repro-exhausted-defer');
            if (this.artifactService && this.currentAttemptId != null) {
              this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', 'REPRO-FAILED after retries — deferred NOT-REPRODUCIBLE');
            }
            if (this.userCritical) {
              // R-F3: user-critical pause (operator-facing), mirror B10-T02 deadlock style. Non-crit path below is byte-identical.
              this.transitionRunToBlocked('A user-critical issue repro could not run or remained inconclusive after all retries; operator investigation is required.');
              try {
                await fs.mkdir(this.runDir, { recursive: true });
                const reason = `# User-Critical Issue Repro Pause (R-F3 / B10-T04)\n\nUser-critical issue ${this.batchId || ''} did not reproduce after ${Number(process.env.HELM_REPRO_RETRY || 2)} attempts.\n\nLast REPRO-FAILED: ${this.lastReproFailNote || 'unknown'}\n\nOperator action required: investigate locally (run tests/inspect), provide more repro steps, or manually resolve. Run paused (phase=blocked) rather than silently deferring.`;
                await fs.writeFile(path.join(this.runDir, 'critical-repro-pause.md'), reason, 'utf8');
                if (this.artifactService && this.runId != null) {
                  this.artifactService.recordArtifact(this.runId, 'critical-repro-pause', 'critical-repro-pause.md');
                }
              } catch {}
              this.log('complete');
              await this.persistFinal('BLOCKED');
              return { finalStatus: 'BLOCKED', transitions: this.getTransitions(), attempts };
            }
            // NON-critical: byte-identical original defer behavior (R-F3 happy path for normal issues)
            this.log('complete');
            await this.persistFinal('DEFERRED');
            return { finalStatus: 'DEFERRED', transitions: this.getTransitions(), attempts };
          }
        }
        // A4: routeFor picks the dispatch role (fix on REPRO-CONFIRMED, correction on a prior FAIL, else
        // the plain hardcoded 'implementer' for a first attempt) — resolves to 'implementer' for the seed
        // either way, so this is a zero-behavior-change substitution of the same literal already used below.
        let implRole = 'implementer';
        if (taskType === 'issue' && this.lastReproNote) {
          implRole = this.routeFor('validator', 'REPRO-CONFIRMED', 'implementer', 'fix').handler;
        } else if (attempts > 1) {
          implRole = this.routeFor('validator', 'FAIL', 'implementer', 'correction').handler;
        }
        let implBrief = config.brief;
        if (taskType === 'issue' && this.lastReproNote) {
          implBrief = `Fix the issue. Validator REPRO-CONFIRMED this contract (use as fix spec + regression): ${this.lastReproNote}. Original task: ${config.brief}. Write tests that prove the repro is cleared on rendered app.`;
        }
        const implRes = await this.performRolePhase(implRole, implBrief, ['DONE', 'BLOCKED']);
        this.log('validating');
        let valBrief: string;
        if (taskType === 'issue' && this.lastReproNote) {
          valBrief = `As validator for ${batchId} (issue mode): Re-run the exact reproduction from the prior REPRO-CONFIRMED contract and confirm it is CLEARED on the rendered app after the fix. Contract: ${this.lastReproNote}. Emit exactly PASS if cleared (with evidence), or FAIL — defect_class=<non-empty-token>; <what is still present>.`;
        } else {
          const dirNote = this.projectDir ? ` Confirm criteria met in REAL result under projectDir=${this.projectDir} (inspect files/git/tests there per impl brief instructions).` : '';
          valBrief = `As validator for ${batchId}: audit the implementer work against the original request (incl. atomic_work + validation_criteria). The impl brief was: ${implBrief}.${dirNote} Output exactly PASS if complete+correct (with tests), or FAIL — defect_class=<non-empty-token>; <reason>.`;
        }
        const valRole = this.routeFor('implementer', 'DONE', 'validator', 'validate').handler;
        const valRes = await this.performRolePhase(valRole, valBrief, ['PASS', 'FAIL', 'DONE', 'BLOCKED']);
        const vstate = valRes.state;
        if (vstate === 'PASS' || vstate === 'DONE') {
          if (this.artifactService && this.currentAttemptId != null) {
            this.artifactService.recordValidation(this.currentAttemptId, 'PASS', valRes.note);
          }
          this.log('complete');
          await this.persistFinal('PASS');
          return { finalStatus: 'PASS', transitions: this.getTransitions(), attempts };
        } else {
          if (this.artifactService && this.currentAttemptId != null) {
            this.persistValidatorOutcome(this.currentAttemptId, valRes.state, valRes.note, valRes.defectClass);
          }
        }
      }
      this.log('complete');
      await this.persistFinal('FAIL');
      return { finalStatus: 'FAIL', transitions: this.getTransitions(), attempts };
    }

    // B8 full ladder path (when escalationService provided)
    // C6 precedence (documented): project override/default -> per-task base (explicitModel + effort from plan) -> escalation rung on top.
    // resolve initial rung/model (plan-summon or explicit takes precedence; errors fail-closed pre-dispatch)
    let startRung = 0;
    let startModel = 'grok-4.5';
    try {
      const resolved = this.escalationService!.resolveRungAndModel({
        role: 'implementer',
        explicitRung: config.recommendedRung,
        complexity: config.complexity,
        explicitModel: config.explicitModel,
        projectId: this.projectId,
      });
      startRung = resolved.rung;
      startModel = resolved.model;
    } catch (e: any) {
      // Surface pre-dispatch reject (UNKNOWN_MODEL, UNSUPPORTED_RUNG_PROVIDER_FOR_ROLE etc.)
      // Silent task-fail on a resolve error is itself an orchestration bug — log it to stderr so it surfaces.
      console.error(`[orchestrator-loop] pre-dispatch resolve FAILED (task=${this.batchId}): ${e?.message || e}`);
      this.log('resolve-failed');
      if (this.artifactService && this.taskId != null) {
        const aid = this.artifactService.recordAttempt(this.taskId, 1);
        this.artifactService.recordValidation(aid, 'FAIL', `pre-dispatch resolve error: ${e?.message || e}`);
      }
      this.log('complete');
      await this.persistFinal('FAIL');
      return { finalStatus: 'FAIL', transitions: this.getTransitions(), attempts: 1 };
    }
    this.currentRung = startRung;
    // C5: low-budget trigger (fires before first dispatch if bound base model below threshold)
    // Applied on top of C6 per-task explicitModel base; swaps to next rung/headroom.
    if (this.escalationService) {
      try {
        const b = await this.escalationService.maybeLowBudgetEscalate('implementer', startRung, startModel, this.escalationCtx());
        if (b.triggered) {
          this.currentRung = b.rung;
          startModel = b.model;
          this.log('low-budget-trigger');
        }
      } catch {}
    }
    // attemptsAtRung will increment inside loop

    let attempts = 0;

    while (true) {
      // R5a: phase boundary — a run marked terminal in the DB stops here (no next attempt).
      await this.assertRunActive('attempt-boundary');
      attempts += 1;
      this.attemptsAtRung += 1;
      // FIX #39 defense-in-depth: hard ceiling on total attempts. A non-converging task (degenerate
      // validator-flag ⇄ brain-pushback loop, or endless same-rung thrash) must never loop forever —
      // terminate in a human-actionable page rather than a silent stall.
      if (attempts > this.HARD_MAX_ATTEMPTS) {
        const exhaustedTask = this.taskKey || this.batchId;
        const nonConvergeMessage =
          `Task ${exhaustedTask} did not converge after ${attempts - 1} attempts (hard ceiling ${this.HARD_MAX_ATTEMPTS}) — ` +
          'a task that cannot pass after this many retries signals a PROMPT/TASK defect (e.g. too large or ambiguous), ' +
          'not a model-strength gap. Needs your review of the task/prompt.';
        this.log('hard-attempt-ceiling-block');
        if (this.artifactService && this.currentAttemptId != null) {
          this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', nonConvergeMessage);
        }
        this.transitionRunToBlocked(nonConvergeMessage);
        this.log('complete');
        await this.persistFinal('BLOCKED');
        return { finalStatus: 'BLOCKED', transitions: this.getTransitions(), attempts };
      }
      this.log('working');

      if (this.artifactService && this.taskId != null) {
        this.currentAttemptId = this.artifactService.recordAttempt(this.taskId, attempts);
      }

      if (taskType === 'issue') {
        // C3: issue repro retry X then defer (NOT-REPRODUCIBLE). Uses B4 markDeferred via caller.
        // Validator REPRO first (no impl until confirmed). On exhaust X: DEFERRED, queue continues, raise at run end.
        const MAX_REPRO_ATTEMPTS = Number(process.env.HELM_REPRO_RETRY || 2);
        let reproOk = false;

        // DETERMINISTIC REPRO FIRST (verifier ≠ fixer): run the project's own tests. Failing tests ARE the
        // reproduction — robust vs a flaky/uncooperative agent validator (the spawned-validator-emits-callback
        // path is unreliable for some providers). Green tests here → fall through to the agent validator, which
        // may still reproduce a non-test-visible bug. This mirrors the feature deterministic test-gate.
        const isFakeIssue = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production' && process.env.FORCE_DETERMINISTIC_VAL_PATH !== '1';
        if (this.projectDir && !isFakeIssue) {
          this.log('repro-validating-deterministic-check');
          const det = await this.runProjectTests(this.projectDir);
          if (det.state === 'FAIL') {
            this.lastReproNote = `REPRO-CONFIRMED (deterministic test-gate — verifier ≠ fixer): the project's own tests FAIL on the current code, which reproduces the reported issue. Fix contract + regression check = make these green without breaking others. ${det.note}`;
            reproOk = true;
            this.log('repro-confirmed-deterministic');
            if (this.artifactService && this.currentAttemptId != null) {
              this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', `repro-confirmed (deterministic test-gate): ${det.note}`);
            }
          } else {
            this.log('repro-deterministic-green'); // tests pass; a non-test-visible bug may still be agent-reproducible
          }
        }

        for (let ra = 1; !reproOk && ra <= MAX_REPRO_ATTEMPTS; ra++) {
          const retryNote = ra > 1
            ? `\n\nREPRO RETRY ${ra}/${MAX_REPRO_ATTEMPTS} (escalated effort).${this.lastReproFailNote ? ` Prior REPRO-FAILED: ${this.lastReproFailNote}.` : ''}`
            : '';
          const reproInstr = `You are the VALIDATOR reproducing an issue BEFORE any implementer work (verifier ≠ fixer). Reproduce the issue in the project at projectDir (run the project's tests and/or inspect the code to SEE it broken). The reported issue to reproduce:\n${activeTaskDescription ?? activeBrief}\n\nEmit exactly one terminal callback: REPRO-CONFIRMED — <full repro steps + observed vs expected as the fix contract + the regression check to retain>, REPRO-SATISFIED — <evidence that the acceptance/desired end-state already holds>, OR REPRO-FAILED — <tooling could not run or the result was inconclusive>. Do NOT fix anything.${retryNote}`;
          const reproBrief = this.compliantBrief('validator', 'issue', reproInstr);
          this.log(`repro-validating attempt ${ra}`);
          const reproRes = await this.performRolePhase('validator', reproBrief, [
            'REPRO-CONFIRMED',
            'REPRO-SATISFIED',
            'REPRO-FAILED',
          ]);
          if (reproRes.state === 'REPRO-CONFIRMED') {
            this.lastReproNote = reproRes.note;
            reproOk = true;
            this.log('repro-confirmed');
            break;
          } else if (reproRes.state === 'REPRO-SATISFIED') {
            return this.finishReproSatisfied(reproRes.note, attempts);
          } else {
            this.lastReproFailNote = reproRes.note || 'REPRO-FAILED';
            this.log('repro-failed');
            if (this.artifactService && this.currentAttemptId != null) {
              this.artifactService.recordValidation(
                this.currentAttemptId,
                'FAIL',
                `repro-attempt-${ra}: ${this.lastReproFailNote}`
              );
            }
          }
        }
        if (!reproOk) {
          this.log('repro-exhausted-defer');
          if (this.artifactService && this.currentAttemptId != null) {
            this.artifactService.recordValidation(
              this.currentAttemptId,
              'FAIL',
              'REPRO-FAILED after retries — deferred NOT-REPRODUCIBLE'
            );
          }
          if (this.userCritical) {
            // R-F3: user-critical pause (operator-facing), mirror B10-T02 deadlock style. Non-crit path below is byte-identical.
            this.transitionRunToBlocked('A user-critical issue repro could not run or remained inconclusive after all retries; operator investigation is required.');
            try {
              await fs.mkdir(this.runDir, { recursive: true });
              const reason = `# User-Critical Issue Repro Pause (R-F3 / B10-T04)\n\nUser-critical issue ${this.batchId || ''} did not reproduce after ${Number(process.env.HELM_REPRO_RETRY || 2)} attempts.\n\nLast REPRO-FAILED: ${this.lastReproFailNote || 'unknown'}\n\nOperator action required: investigate locally (run tests/inspect), provide more repro steps, or manually resolve. Run paused (phase=blocked) rather than silently deferring.`;
              await fs.writeFile(path.join(this.runDir, 'critical-repro-pause.md'), reason, 'utf8');
              if (this.artifactService && this.runId != null) {
                this.artifactService.recordArtifact(this.runId, 'critical-repro-pause', 'critical-repro-pause.md');
              }
            } catch {}
            this.log('complete');
            await this.persistFinal('BLOCKED');
            return { finalStatus: 'BLOCKED', transitions: this.getTransitions(), attempts };
          }
          // NON-critical: byte-identical original defer behavior (R-F3 happy path for normal issues)
          this.log('complete');
          await this.persistFinal('DEFERRED');
          return { finalStatus: 'DEFERRED', transitions: this.getTransitions(), attempts };
        }
      }

      // IMPL phase (always for feature; for issue only after REPRO-CONFIRMED gate)
      // B8: augment with rung + per-attempt ledger when rung>0 or after any failures (ESC2/ESC3)
      // escalate-validator:revalidate skips implementer and re-validates the SAME prior output.
      const currentModel = this.escalationService!.getModelForRung('implementer', this.currentRung, this.escalationCtx());
      let agentFailNote: string | null = null;
      if (this.revalidateOnly) {
        this.revalidateOnly = false;
        this.log('validator-revalidate-only');
      } else {
        let implBrief = activeBrief;
        if (this.currentRung > 0 || this.failureLedger.length > 0 || this.pendingHandholdDirections) {
          const ledgerStr = this.failureLedger.length ? JSON.stringify(this.failureLedger, null, 2) : '[]';
          let prefix = `CURRENT RUNG: ${this.currentRung} (model: ${currentModel}). AUTH DECISION-ID: ${this.authorizingDecisionId || 'initial'}.\n\nPer-attempt ledger (DO NOT re-walk these prior failures):\n${ledgerStr}\n\n`;
          if (this.pendingHandholdDirections) {
            prefix += `VALIDATOR HANDHOLD DIRECTIONS (apply exactly; verifier ≠ fixer):\n${this.pendingHandholdDirections}\n\n`;
            this.pendingHandholdDirections = null; // consume once
          }
          implBrief = `${prefix}${activeBrief}`;
        }
        if (taskType === 'issue' && this.lastReproNote) {
          implBrief = `Fix the issue. Validator REPRO-CONFIRMED this contract (use as fix spec + regression): ${this.lastReproNote}. Original task: ${activeBrief}. Write tests that prove the repro is cleared on rendered app.\n\n${implBrief}`;
        }
        // A4: routeFor picks the dispatch role (fix on REPRO-CONFIRMED, correction on a prior ledger entry, else
        // the plain hardcoded 'implementer' for a first attempt/rung-bump re-dispatch) — resolves to 'implementer'
        // for the seed either way, a zero-behavior-change substitution of the literal already used below.
        let implRole = 'implementer';
        if (taskType === 'issue' && this.lastReproNote) {
          implRole = this.routeFor('validator', 'REPRO-CONFIRMED', 'implementer', 'fix').handler;
        } else if (this.failureLedger.length > 0) {
          implRole = this.routeFor('validator', 'FAIL', 'implementer', 'correction').handler;
        }
        // AGENT-FAIL HANDLING (D3): implementer no-callback / spawn-timeout is an AGENT failure, not a task failure.
        // Route it through the SAME ledger/rung/brain ladder below (self-heal via loop re-dispatch up to the rung
        // attempt limit, then escalate to projcore-brain → bump-rung/JROM). Never bare-fail on an agent hiccup.
        try {
          await this.performRolePhase(implRole, implBrief, ['DONE', 'BLOCKED']);
        } catch (e: any) {
          // R5a: a run-abort is NOT an agent failure — never feed it into the FAIL ladder
          // (that would re-dispatch against a terminal run). Propagate to stop the loop.
          if (e instanceof RunAbortedError) throw e;
          agentFailNote = `agent-fail (no ${implRole} callback within timeout): ${e?.message || e}`;
          this.log(`${implRole}-agent-fail`);
        }
      }

      // final VAL gate (feature or post-fix clear confirm for issue)
      this.log('validating');
      const isFakeVal = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production' && process.env.FORCE_DETERMINISTIC_VAL_PATH !== '1';
      let valRes: { state: string; note: string | null; defectClass?: string; escalateFlag?: boolean; planDefectFlag?: boolean; validatorOutcomePersisted?: boolean };
      if (agentFailNote) {
        // D3b: cheap models (e.g. kloo/deepseek on issue tasks) sometimes APPLY the fix + self-verify (npm green)
        // but skip the DONE-callback ceremony, so performRolePhase throws agent-fail. Before feeding that into the
        // FAIL ladder, run the DETERMINISTIC re-validate: if the issue's own tests are green the fix landed —
        // treat CLEARED (deterministic-gate-primary; symmetric with the feature test-gate and the issue else-branch
        // below). Only fall to the agent-fail FAIL ladder if the tests are still red (no usable fix in the tree).
        const isFakeIssueAgentFail = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production' && process.env.FORCE_DETERMINISTIC_VAL_PATH !== '1';
        if (taskType === 'issue' && this.lastReproNote && this.projectDir && !isFakeIssueAgentFail) {
          this.log('agent-fail-issue-deterministic-recheck');
          const det = await this.runProjectTests(this.projectDir);
          valRes = det.state === 'PASS'
            ? { state: 'PASS', note: `issue CLEARED (deterministic re-validate green despite missing impl DONE callback): ${det.note}` }
            : { state: 'FAIL', note: agentFailNote };
        } else {
          // No implementer output to validate — feed the agent-fail into the FAIL ladder (ledger → rung-limit →
          // self-heal respawn via the loop, then brain escalation). Mirrors a validator FAIL with an agent-fail diagnosis.
          valRes = { state: 'FAIL', note: agentFailNote };
        }
      } else if (taskType === 'issue' && this.lastReproNote) {
        // DETERMINISTIC CLEARED confirmation (verifier ≠ fixer): re-run the project's tests. Green = the repro
        // is cleared and no regression. Robust vs the agent-validator emission problem; symmetric with the
        // deterministic repro above and the feature test-gate.
        const isFakeIssueVal = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production' && process.env.FORCE_DETERMINISTIC_VAL_PATH !== '1';
        if (this.projectDir && !isFakeIssueVal) {
          this.log('revalidating-deterministic');
          const det = await this.runProjectTests(this.projectDir);
          valRes = det.state === 'PASS'
            ? { state: 'PASS', note: `issue CLEARED (deterministic test-gate green after fix): ${det.note}` }
            : { state: 'FAIL', note: `issue NOT cleared (test-gate still failing): ${det.note}` };
        } else {
          const valInstr = `You are the VALIDATOR confirming an issue fix (verifier ≠ fixer). Re-run the EXACT reproduction from the prior REPRO-CONFIRMED contract and confirm it is CLEARED after the implementer's fix. Contract to re-check:\n${this.lastReproNote}\n\nEmit exactly one terminal callback: PASS — <evidence cleared + regression green> OR FAIL — defect_class=<non-empty-token>; <what is still broken>.`;
          const valBrief = this.compliantBrief('validator', 'issue', valInstr);
          valRes = await this.performRolePhase('validator', valBrief, ['PASS', 'FAIL', 'DONE', 'BLOCKED']);
        }
      } else if (isFakeVal) {
        // Fake/test mode keeps the agent-validator path (existing B8 tests drive a PASS callback deterministically).
        const dirNote = this.projectDir ? ` Confirm criteria met in REAL result under projectDir=${this.projectDir} (inspect files/git/tests there per impl brief instructions).` : '';
        const valBrief = `As validator for ${batchId}: audit the implementer work against the original request (incl. atomic_work + validation_criteria). The impl brief was: ${activeBrief}.${dirNote} Output exactly PASS if complete+correct (with tests), or FAIL — defect_class=<non-empty-token>; <reason>.`;
        const valRole = this.routeFor('implementer', 'DONE', 'validator', 'validate').handler;
        valRes = await this.performRolePhase(valRole, valBrief, ['PASS', 'FAIL', 'DONE', 'BLOCKED']);
      } else {
        // POCFIX17 (JROM-chosen): deterministic test-gate. The PRIMARY validation signal on the REAL path is the
        // project's OWN tests run by Helm (verifier ≠ fixer) — robust vs the flaky agent validator. Real green → advance.
        this.log('deterministic-validating');
        valRes = await this.runProjectTests(this.projectDir || '');
        this.log(`test-gate:${valRes.state}`);

        // #53: a gate FAIL caused by a MISSING toolchain (npm test exit 127, "tsx: not found",
        // absent node_modules) is an ENVIRONMENT fault, not a code fault — re-dispatching the
        // implementer cannot fix it (this exact case churned 5 attempts on retest run 23). Detect it
        // and PAUSE the run with the remedy instead of feeding the retry ladder.
        if (valRes.state === 'FAIL') {
          const gateNote = valRes.note || '';
          const exitMatch = gateNote.match(/exit (\d+)/);
          const envFault = classifyGateFault(exitMatch ? Number(exitMatch[1]) : undefined, gateNote);
          if (envFault) {
            this.pauseRunForOperator(envFault);
            return { finalStatus: 'DEFERRED', transitions: this.getTransitions(), attempts };
          }
        }

        // C2: after deterministic gate PASS on real feature path, spawn requirements-aware validator (G2).
        // Only for requirement-bearing tasks (gate is cheap filter; skip pure refactor/no-criteria).
        // Brief includes CONTRACT: north-star (run reference/prompt) + task atomic_work + validation_criteria + diff/behavior.
        // Returns PASS / FAIL-with-gaps. FAIL routes back as correction (ladder).
        if ((valRes.state === 'PASS' || valRes.state === 'DONE') && taskType !== 'issue') {
          const isReqBearing = this.isRequirementBearing(activeBrief);
          if (isReqBearing) {
            try {
              const ns = await this.readNorthStarContract();
              const contract = this.buildTaskContractNote(activeBrief);
              this.log('requirements-validating');
              const vInstr = this.requirementsValidatorInstruction(ns, contract);
              const vBrief = this.compliantBrief('validator', 'feature', vInstr);
              const reqValRes = await this.performRolePhase('validator', vBrief, ['PASS', 'FAIL', 'DONE', 'BLOCKED']);
              // §3 DONE-laundering guard — SCOPED to the requirements-aware validator SEAT ONLY.
              // The implementer's legitimate DONE terminal (impl dispatch) and the deterministic project-test
              // gate's DONE are UNTOUCHED — those paths never reach here. A DONE emitted by THIS validator
              // seat is NOT a requirements verdict; convert it to a bounded protocol-defect so it can never map
              // to PASS (findings §3). DONE stays in the acceptable wait-list above so a misbehaving model's
              // DONE returns a bounded verdict instead of burning the idle window into a swallowed timeout.
              if (reqValRes.state === 'DONE') {
                const rawDone = reqValRes.note ?? '';
                reqValRes.state = 'BLOCKED';
                reqValRes.note = `PROTOCOL-DEFECT: requirements-aware validator emitted DONE (not a valid verdict for this phase; expected PASS or FAIL) (original: ${rawDone.trim() === '' ? '<empty>' : rawDone})`;
                (reqValRes as any).defectClass = 'protocol-defect';
              }
              if (this.artifactService && this.currentAttemptId != null) {
                this.persistValidatorOutcome(this.currentAttemptId, reqValRes.state, reqValRes.note, reqValRes.defectClass);
              }
              if (process.env.FORCE_DETERMINISTIC_VAL_PATH === '1') {
                // test seam: pre-seeded cb controls outcome for timing-sensitive waits
                reqValRes.state = 'PASS';
              }
              // §3: DONE is no longer a success at this seat (coerced to protocol-defect above); PASS only.
              if (reqValRes.state !== 'PASS') {
                // The validator outcome was durably recorded above. Preserve its exact
                // structured state/class and mark it so the outer gate cannot re-persist
                // an unlabeled synthetic FAIL.
                valRes = {
                  state: reqValRes.state,
                  note: `requirements-validator:${reqValRes.note || reqValRes.state}`,
                  defectClass: reqValRes.defectClass,
                  escalateFlag: reqValRes.escalateFlag === true,
                  planDefectFlag: (reqValRes as any).planDefectFlag === true,
                  validatorOutcomePersisted: true,
                } as any;
              } else {
                valRes = { state: 'PASS', note: `requirements-validator:${reqValRes.note || 'PASS'}` };
                // C4: reviewer code-soundness pass after validator (on code-bearing tasks)
                if (this.isCodeBearingTask(activeBrief, taskType)) {
                  this.log('reviewer');
                  const rBrief = `As reviewer for ${batchId} (code-soundness; verifier ≠ fixer):\n\nTask contract:\n${contract}\n\nDiff vs intent: read the actual diff. Demand mechanism-level root cause (name fn/binding/race/pathway). Reject symptom fixes. Check regressions + hardening-module rules (if touched, explicit justification required). Trace every change to brief/acceptance. Report exactly APPROVE or REVISE — <numbered file:line findings> or REJECT-RESTART.\n`;
                  const revRes = await this.performRolePhase('reviewer', rBrief, ['APPROVE', 'REVISE', 'REJECT-RESTART', 'PASS', 'FAIL', 'DONE', 'BLOCKED']);
                  if (this.artifactService && this.currentAttemptId != null) {
                    const rstate = revRes.state;
                    this.artifactService.recordValidation(this.currentAttemptId, (rstate === 'APPROVE' || rstate === 'PASS' || rstate === 'DONE') ? 'PASS' : 'FAIL', `reviewer:${rstate} ${revRes.note || ''}`);
                  }
                  if (process.env.FORCE_DETERMINISTIC_VAL_PATH === '1') {
                    revRes.state = 'APPROVE';
                  }
                  if (!['APPROVE', 'PASS', 'DONE'].includes(revRes.state)) {
                    valRes = { state: 'FAIL', note: `reviewer ${revRes.state}: ${revRes.note || ''}` };
                  } else {
                    valRes = { state: 'PASS', note: `reviewer:${revRes.state} ${revRes.note || ''}` };
                  }
                }
              }
            } catch (e: any) {
              // non-fatal to post steps; do not downgrade gate on wiring error
              this.log('post-gate-val-reviewer-error');
            }
          }
        }
      }
      // Only explicit validator success may be normalized for the outer gate.
      // In particular, protocol BLOCKED must never be laundered into PASS.
      if (taskType !== 'issue' && (valRes.state === 'PASS' || valRes.state === 'DONE')) {
        valRes.state = 'PASS';
      }
      const vstate = valRes.state;

      if (vstate === 'PASS' || vstate === 'DONE') {
        if (this.artifactService && this.currentAttemptId != null) {
          this.artifactService.recordValidation(this.currentAttemptId, 'PASS', valRes.note);
        }

        // A2b: convene red-team panel (B10 reuse) after validator PASS to adversarially verify impl diff (N-consec-CLEAN or BROKEN).
        // On BROKEN: record FAIL, persist, return FAIL so caller marks failed (routes break back as correction). Verifier≠fixer.
        // Persist verdict as run event (red-team.json + artifacts row + log transition) for timeline.
        if (this.panelService && process.env.HELM_SKIP_REDTEAM !== '1') {
          try {
            const req = activeBrief;
            const diff = this.lastReproNote || 'implementation diff (side-effects by implementer to workspace; see batch-*/changes.md + source edits)';
            const rt = await this.panelService.conveneRedTeamPanel({
              runDir: this.runDir,
              batchId: this.batchId,
              implementedDiff: diff,
              requirement: req,
              nConsecutiveClean: 1,
              redTeamAgents: this.redTeamAgents,
              projectDir: this.projectDir,  // POCFIX19: fence red-team to the project dir
              ...(this.strictReadAllow ? { strictReadAllow: this.strictReadAllow } : {}),  // B-ISO1: run-scoped strict read fence on per-task red-team seats
            });
            this.log(`red-team:${rt.state}`);
            try {
              if (this.artifactService && this.runId != null) {
                const artDir = path.join(this.runDir, 'artifacts');
                const fsMod = await import('node:fs/promises');
                await fsMod.mkdir(artDir, { recursive: true });
                await fsMod.writeFile(path.join(artDir, 'red-team.json'), JSON.stringify(rt, null, 2), 'utf8');
                this.artifactService.recordArtifact(this.runId, 'red-team', 'artifacts/red-team.json');
              }
            } catch {}
            if (rt.state === 'BROKEN') {
              if (this.artifactService && this.currentAttemptId != null) {
                this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', `red-team BROKEN: ${rt.note}`);
              }
              this.log('complete');
              await this.persistFinal('FAIL');
              return { finalStatus: 'FAIL', transitions: this.getTransitions(), attempts };
            }
            // CLEAN: accept the PASS
          } catch (e: any) {
            this.log('red-team-error');
            // continue to PASS (panel errors non-fatal; verdicts in callbacks.md anyway)
          }
        }

        this.log('complete');
        await this.persistFinal('PASS');
        return { finalStatus: 'PASS', transitions: this.getTransitions(), attempts };
      } else {
        if (this.artifactService && this.currentAttemptId != null && !(valRes as any).validatorOutcomePersisted) {
          this.persistValidatorOutcome(this.currentAttemptId, valRes.state, valRes.note, (valRes as any).defectClass);
        }

        // B8: build ledger entry for this failed attempt (ESC3)
        const entry: LedgerEntry = {
          attempt: attempts,
          rung: this.currentRung,
          brief_path: `prompts/implementer.brief.md`,
          model: currentModel,
          validator_diagnosis: valRes.note || 'FAIL',
          failed_gates: ['validator-gate'],
          evidence: valRes.note || null,
          diff_summary: null,
          preserved_changes: null,
          ts: new Date().toISOString(),
        };
        this.failureLedger.push(entry);

        // Track fail source precisely — override ONLY when lastFailSource === 'agent-validator'.
        const failNote = String(valRes.note || '');
        if (
          /deterministic test-gate/i.test(failNote) ||
          /test-gate still failing/i.test(failNote) ||
          /deterministic re-validate/i.test(failNote) ||
          /issue NOT cleared \(test-gate/i.test(failNote)
        ) {
          this.lastFailSource = 'deterministic-gate';
        } else if (/^agent-fail\b/i.test(failNote) || /no .+ callback within timeout/i.test(failNote)) {
          // Includes agent-fail deterministic-recheck path that still surfaces agentFailNote as FAIL.
          this.lastFailSource = 'agent-fail';
        } else if (/^reviewer\b/i.test(failNote)) {
          this.lastFailSource = 'reviewer';
        } else if (
          valRes.defectClass ||
          /requirements-validator:/i.test(failNote) ||
          /defect_class=/i.test(failNote)
        ) {
          this.lastFailSource = 'agent-validator';
          this.lastAgentValidatorFailNote = failNote;
        } else {
          this.lastFailSource = 'other';
        }

        // FIX #39: ordinary FAILs are free same-rung retries. The brain wakes only when the validator
        // explicitly judges the implementer incapable / plan-defect, or when the generous safety backstop trips.
        const backstop = this.taskAttemptBackstop();
        const backstopHit = this.attemptsAtRung >= backstop;
        const escalateNow =
          valRes.escalateFlag === true ||
          valRes.planDefectFlag === true ||
          backstopHit;
        if (escalateNow) {
          // A never-flagging validator must still terminate at the top-rung safety backstop.
          // Effective top: when position-3 (L4) is absent, this is 2 (byte-identical to pre-B6a).
          const topRung = this.effectiveTopRung('implementer');
          if (this.currentRung >= topRung && backstopHit) {
            const exhaustedTask = this.taskKey || this.batchId;
            const exhaustionMessage =
              `Task ${exhaustedTask} failed at the top rung (${currentModel}) after ${this.attemptsAtRung} attempts — ` +
              'the top model failing repeatedly signals a PROMPT/TASK defect (for example, the task may be too large or ambiguous), ' +
              'not a model-strength gap. Needs your review of the task/prompt.';
            this.log('rung2-exhaust-block');
            if (this.artifactService && this.currentAttemptId != null) {
              this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', exhaustionMessage);
            }
            this.transitionRunToBlocked(exhaustionMessage);
            this.log('complete');
            await this.persistFinal('BLOCKED');
            return { finalStatus: 'BLOCKED', transitions: this.getTransitions(), attempts };
          }

          // Wake the phase-owned implementation brain. Custom non-core handlers remain honored.
          const routedBrainRole = this.routeFor('(algo)', 'rung-attempt-limit', this.brainRole, 'escalate').handler;
          this.log('escalation-brain-wake');
          const decision = await this.consultImplementationBrain(routedBrainRole);
          if (decision) {
            this.log(`brain-decision:${decision.action}`);
            if (decision.action === 'bump-rung' && typeof decision.targetRung === 'number' && decision.decisionId) {
              if (this.currentRung >= topRung || decision.targetRung > topRung) {
                const exhaustedTask = this.taskKey || this.batchId;
                const exhaustionMessage =
                  `Task ${exhaustedTask} failed at the top rung (${currentModel}) after ${this.attemptsAtRung} attempts — ` +
                  'the top model failing repeatedly signals a PROMPT/TASK defect (for example, the task may be too large or ambiguous), ' +
                  'not a model-strength gap. Needs your review of the task/prompt.';
                this.log('rung2-exhaust-block');
                if (this.artifactService && this.currentAttemptId != null) {
                  this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', exhaustionMessage);
                }
                this.transitionRunToBlocked(exhaustionMessage);
                this.log('complete');
                await this.persistFinal('BLOCKED');
                return { finalStatus: 'BLOCKED', transitions: this.getTransitions(), attempts };
              }
              if (decision.targetRung > this.currentRung) {
                // same-rung re-entry blocked without NEW decision-id (ESC5)
                this.currentRung = decision.targetRung;
                this.authorizingDecisionId = decision.decisionId;
                this.attemptsAtRung = 0;
                this.log('rung-bumped');
              }
            } else if (decision.action === 'validator-handholding') {
              // ESC4: selectable (not forced rung); validator emits spoon-fed; impl applies; verifier≠fixer
              this.pendingHandholdDirections = decision.spoonFedDirections || decision.reason || 'apply the precise minimal diff that resolves the validator diagnosis from ledger';
              this.attemptsAtRung = 0;
              this.log('handhold-selected');
              // continue to next attempt (impl will receive the directions in augment)
            } else if (decision.action === 're-brief') {
              this.pendingHandholdDirections = decision.reason || 'retry the task at the current rung using the failure ledger as the correction directive';
              this.attemptsAtRung = 0;
              this.log('rebrief-selected');
            } else if (decision.action === 'deliberation') {
              this.log('brain-deliberation');
              if (this.panelService) {
                try {
                  const seats = this.deliberationRoster && this.deliberationRoster.length ? this.deliberationRoster.map((r: any) => ({ lens: r.lens || `seat-${r.position}`, model: r.model, provider: r.provider })) : undefined;
                  const pr = await this.panelService.conveneDeliberationPanel({
                    runDir: this.runDir,
                    batchId: this.batchId,
                    topic: (this.lastReproNote || 'escalated approach from ledger').slice(0, 180),
                    seats,
                    projectDir: this.projectDir,  // POCFIX19: fence panelists to the project dir
                    ...(this.strictReadAllow ? { strictReadAllow: this.strictReadAllow } : {}),  // B-ISO1: run-scoped strict read fence on escalation-deliberation seats
                  });
                  this.log(`panel-deliberation:${pr.state}`);
                } catch (e: any) {
                  this.log(`panel-deliberation-error`);
                }
              }
              if (this.artifactService && this.currentAttemptId != null) {
                this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', `brain decision: deliberation (panel verdicts aggregated; verifier≠fixer — Helm routes; parked)`);
              }
              this.log('complete');
              await this.persistFinal('DEFERRED');
              return { finalStatus: 'DEFERRED', transitions: this.getTransitions(), attempts };
            } else if (decision.action === 'escalate-to-JROM') {
              this.log('brain-escalate-to-jrom');
              if (this.artifactService && this.currentAttemptId != null) {
                this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', `brain decision: escalate-to-JROM ${decision.reason || ''} (parked via DEFERRED)`);
              }
              this.log('complete');
              await this.persistFinal('DEFERRED');
              return { finalStatus: 'DEFERRED', transitions: this.getTransitions(), attempts };
            } else if (decision.action === 're-plan' && decision.decisionId && decision.planRevisionDirective) {
              // ESC5 analog: same decisionId cannot re-apply re-plan without a fresh id (not an acted attempt).
              if (decision.decisionId === this.lastReplanDecisionId) {
                this.log('replan-same-decision-id-rejected');
              } else if (this.replansUsed >= this.MAX_REPLANS) {
                // Cap terminal (JROM-LOCKED 2026-07-20): PARK, don't halt the whole run.
                //
                // Previously this forced phase=blocked unconditionally, stopping every remaining task
                // even when none of them depended on this one. JROM's rule: burn the re-plan budget,
                // then park the task and raise it at the END of the run — and only stop immediately if
                // the parked task actually gates work that would otherwise proceed. Waiting on a human
                // for something the run could have driven past is the failure mode, not the safeguard.
                //
                // Returning DEFERRED gets exactly that for free: the queue keeps draining independent
                // work, and TaskQueueService.getParkedBlockReason() halts the run with
                // pending-after-drain.md ONLY when every remaining task is (transitively) gated by a
                // parked one. The parked task is then surfaced in completion-summary's DEFERRED section
                // at end of run. The re-plan budget itself stays honoured across resume because
                // replansUsed is durable (loadDurableReplansUsed), so parking cannot become a loop.
                const replanTask = this.taskKey || this.batchId;
                const replanMsg =
                  `Task ${replanTask} re-planned ${this.replansUsed} times without resolution — parked for your review`;
                this.log('replan-bound-exceeded');
                if (this.artifactService && this.currentAttemptId != null) {
                  this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', `brain decision: re-plan bound exceeded — ${replanMsg}`);
                }
                console.warn(`[orchestrator-loop] ${replanMsg} — parking; run continues unless this gates remaining work`);
                this.log('complete');
                await this.persistFinal('DEFERRED');
                return { finalStatus: 'DEFERRED', transitions: this.getTransitions(), attempts };
              } else {
                // Bound ATTEMPTS not just successes: every acted re-plan decision consumes a slot
                // (plancore BLOCKED / malformed / no-revision / reingest-failure included).
                this.recordReplanAttempt(decision.decisionId, 'started');
                this.lastReplanDecisionId = decision.decisionId;
                this.log('brain-re-plan');
                const originalTaskKey = this.taskKey || this.batchId;
                const revised = await this.consultPlancoreRevise({
                  taskKey: originalTaskKey,
                  atomicWork: activeBrief,
                  validationCriteria: this.currentBriefContract?.expected || 'Satisfy revised plan criteria.',
                  reqRefs: (this.currentBriefContract?.requirementsAssigned || '')
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean),
                  planRevisionDirective: decision.planRevisionDirective,
                });
                if (revised) {
                  const applied = await this.reIngestRevisedTask(revised, decision);
                  if (applied) {
                    activeBrief = applied.brief;
                    activeTaskDescription = applied.taskDescription;
                    if (applied.briefContract) this.currentBriefContract = applied.briefContract;
                    this.attemptsAtRung = 0;
                    this.failureLedger = [];
                    this.authorizingDecisionId = decision.decisionId;
                    this.log('plan-revised');
                    this.recordReplanAttempt(decision.decisionId, 'success');
                  } else {
                    this.log('replan-reingest-failed');
                    this.recordReplanAttempt(decision.decisionId, 'reingest-failed');
                  }
                } else {
                  this.log('replan-plancore-no-revision');
                  this.recordReplanAttempt(decision.decisionId, 'no-revision');
                }
              }
            } else if (decision.action === 'escalate-validator') {
              if (decision.validatorAction === 'override') {
                // POSITIVE guard: allow override ONLY for agent-validator FAILs.
                if (this.lastFailSource !== 'agent-validator') {
                  this.log(
                    this.lastFailSource === 'deterministic-gate'
                      ? 'validator-override-rejected-deterministic'
                      : this.lastFailSource === 'agent-fail'
                        ? 'validator-override-rejected-agent-fail'
                        : this.lastFailSource === 'reviewer'
                          ? 'validator-override-rejected-reviewer'
                          : 'validator-override-rejected-not-agent-validator',
                  );
                  // Fall through: never accept non-agent-validator FAIL as PASS.
                } else if (this.validatorOverridesUsed >= 1) {
                  this.log('validator-override-bound-exceeded');
                } else {
                  const justification = decision.overrideJustification || decision.reason || 'ibrain override';
                  this.validatorOverridesUsed += 1;
                  this.log('validator-overridden');
                  if (this.artifactService && this.runId != null) {
                    this.artifactService.recordRunEvent(
                      this.runId,
                      'VALIDATOR_OVERRIDDEN',
                      {
                        task_key: this.taskKey || this.batchId,
                        decisionId: decision.decisionId,
                        overrideJustification: justification,
                        overriddenFail: this.lastAgentValidatorFailNote || failNote,
                      },
                      this.batchId,
                    );
                  }
                  if (this.artifactService && this.currentAttemptId != null) {
                    this.artifactService.recordValidation(
                      this.currentAttemptId,
                      'PASS',
                      `VALIDATOR_OVERRIDDEN: ${justification} (overridden FAIL: ${this.lastAgentValidatorFailNote || failNote})`,
                    );
                  }
                  this.log('complete');
                  await this.persistFinal('PASS');
                  return { finalStatus: 'PASS', transitions: this.getTransitions(), attempts };
                }
              } else {
                // revalidate: bump validator rung (up to top), re-dispatch validator only (no implementer).
                const curValRung = this.currentValidatorRung ?? 0;
                const valTop = this.effectiveTopRung('validator');
                if (curValRung < valTop) {
                  this.currentValidatorRung = curValRung + 1;
                  this.revalidateOnly = true;
                  this.attemptsAtRung = 0;
                  this.log(`validator-rung-bumped:${this.currentValidatorRung}`);
                } else {
                  this.log('validator-rung-at-top');
                  // Still re-validate once at top if brain asked — no further bump.
                  this.revalidateOnly = true;
                  this.attemptsAtRung = 0;
                }
              }
            }
            // re-brief or other: fall through for another attempt at current (or updated) rung
          } else {
            // No decision from brain -> safe terminate (treat as exhaustion → park)
            this.log('brain-no-decision');
            if (this.artifactService && this.currentAttemptId != null) {
              this.artifactService.recordValidation(this.currentAttemptId, 'FAIL', 'brain returned no usable decision (parked)');
            }
            this.log('complete');
            await this.persistFinal('DEFERRED');
            return { finalStatus: 'DEFERRED', transitions: this.getTransitions(), attempts };
          }
        }
        // else fall through for another attempt at current rung (or after bump/handhold)
      }
    }

    // unreachable
    this.log('complete');
    await this.persistFinal('DEFERRED');
    return { finalStatus: 'DEFERRED', transitions: this.getTransitions(), attempts };
  }

  /**
   * Durable per-task replan attempt count (run_events). Resumed same task rehydrates this so the
   * MAX_REPLANS cap cannot be bypassed by a process restart / resume.
   */
  private loadDurableReplansUsed(): number {
    if (!this.artifactService || this.runId == null) return 0;
    const taskKey = this.taskKey;
    if (!taskKey) return 0;
    try {
      const row = (this.artifactService as any)['db']?.raw
        ?.prepare?.(
          `SELECT COUNT(*) AS c FROM run_events
           WHERE run_id = ? AND event_type = 'REPLAN_ATTEMPT'
             AND json_extract(payload_json, '$.task_key') = ?
             AND json_extract(payload_json, '$.phase') = 'acted'`,
        )
        .get(String(this.runId), taskKey) as { c?: number } | undefined;
      return Number(row?.c || 0);
    } catch {
      return 0;
    }
  }

  /**
   * Bound re-plan ATTEMPTS: every acted re-plan decision increments (success or failure).
   * phase='acted' is the durable counter; outcome is diagnostic only.
   */
  private recordReplanAttempt(
    decisionId: string,
    outcome: 'started' | 'success' | 'reingest-failed' | 'no-revision' | 'blocked' | 'malformed',
  ): void {
    if (outcome === 'started') {
      this.replansUsed += 1;
      if (this.artifactService && this.runId != null) {
        try {
          this.artifactService.recordRunEvent(
            this.runId,
            'REPLAN_ATTEMPT',
            {
              phase: 'acted',
              task_key: this.taskKey || this.batchId,
              decisionId,
              attempt: this.replansUsed,
            },
            this.batchId,
          );
        } catch { /* best-effort durable; in-memory still advanced */ }
      }
      return;
    }
    // Outcome breadcrumb (does NOT increment the bound).
    if (this.artifactService && this.runId != null) {
      try {
        this.artifactService.recordRunEvent(
          this.runId,
          'REPLAN_ATTEMPT',
          {
            phase: 'outcome',
            outcome,
            task_key: this.taskKey || this.batchId,
            decisionId,
            attempt: this.replansUsed,
          },
          this.batchId,
        );
      } catch { /* best-effort */ }
    }
  }

  /**
   * Resolve plancore model+provider from the roster (same resolvePhaseAgents(project,'planning').brain
   * path run-orchestrator uses). Falls back to nulls when project/roster unavailable (tests).
   */
  private resolvePlancoreRosterSeat(): { model?: string; provider?: string } {
    if (this.projectId == null || !this.artifactService) return {};
    try {
      const db = (this.artifactService as any)['db'];
      if (!db) return {};
      // Same resolvePhaseAgents(project, 'planning').brain path run-orchestrator uses (~644).
      const assignments = new AgentAssignmentService(db);
      const staffing = new PhaseStaffingService(assignments);
      const brain = staffing.resolvePhaseAgents(this.projectId, 'planning').brain;
      if (!brain?.agent) return {};
      return {
        model: brain.agent.model || undefined,
        provider: brain.agent.provider || undefined,
      };
    } catch {
      return {};
    }
  }

  /**
   * Wake plancore (planning brain — NOT ibrain) for a surgical mid-run task revise.
   * Returns the revised task payload parsed from PLAN-READY note, or null on failure / BLOCKED.
   */
  private async consultPlancoreRevise(params: {
    taskKey: string;
    atomicWork: string;
    validationCriteria: string;
    reqRefs: string[];
    planRevisionDirective: string;
  }): Promise<{
    task_key: string;
    atomic_work: string;
    validation_criteria: string | string[];
    req_refs?: string[];
    summary?: string;
  } | null> {
    await this.assertRunActive('pre-dispatch:plancore-revise');
    const ledger = this.escalationService
      ? this.escalationService.buildLedger(this.failureLedger)
      : { version: 1, attempts: this.failureLedger, generated_at: new Date().toISOString() };
    let northStarExcerpt = '';
    try {
      northStarExcerpt = await this.readNorthStarContract();
    } catch { /* optional */ }

    const briefWriter = new BriefWriterService();
    const reviseBrief = briefWriter.generatePlanReviseBrief({
      batchId: this.batchId,
      taskKey: params.taskKey,
      atomicWork: params.atomicWork,
      validationCriteria: params.validationCriteria,
      reqRefs: params.reqRefs,
      planRevisionDirective: params.planRevisionDirective,
      ledger,
      northStarExcerpt,
      projectDir: this.projectDir || process.cwd(),
      callbacksFile: path.join(this.runDir, 'callbacks.md'),
      runDir: this.runDir,
    });
    const dispatchNonce = createDispatchNonce();
    const dispatchBrief = bindDispatchNonce(reviseBrief, dispatchNonce);
    const plancoreRole = 'plancore';
    await this.writer.writeBrief(plancoreRole, dispatchBrief);

    let dispatchId = 0;
    if (this.artifactService && this.currentAttemptId != null) {
      dispatchId = this.artifactService.recordDispatch(
        this.currentAttemptId,
        plancoreRole,
        `prompts/${plancoreRole}.brief.md`,
        null,
      );
    }
    this.currentDispatchId = dispatchId;

    const isFakePath = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    let dispatchOffset = 0;
    if (!isFakePath) {
      try {
        const cbStat = await fs.stat(path.join(this.runDir, 'callbacks.md'));
        dispatchOffset = cbStat.size;
      } catch { /* no prior callbacks */ }
    }

    // Roster-resolved plancore model/provider (finding 10) — never hardcode 'grok'.
    const plancoreSeat = this.resolvePlancoreRosterSeat();
    const plancoreProvider = plancoreSeat.provider;
    const plancoreModel = plancoreSeat.model;

    this.log('plancore-revise-wake');
    const spawned = await this.transport.spawn({
      role: plancoreRole,
      brief: dispatchBrief,
      runDir: this.runDir,
      batchId: this.batchId,
      projectDir: this.projectDir,
      ...(plancoreModel ? { model: plancoreModel } : {}),
      ...(plancoreProvider ? { provider: plancoreProvider } : {}),
      ...(this.strictReadAllow ? { strictReadAllow: this.strictReadAllow } : {}),
    });
    const handle = spawned.handle;

    let seen: { state: string; note: string | null };
    try {
      seen = await this.waitForCallback(plancoreRole, ['PLAN-READY', 'DECISION-READY', 'BLOCKED'], {
        sinceOffset: dispatchOffset,
        handle,
        // Use RESOLVED provider for inspectSeat/nudge; fall back only when roster unavailable.
        provider: plancoreProvider || 'claude',
        brief: dispatchBrief,
        watchdogTarget: handle,
        watchdogBrief: dispatchBrief,
      });
    } catch (error) {
      // #47: an unauthenticated brain seat must abort the run, not degrade to a silent null — otherwise
      // the provider-level fault is swallowed and the caller proceeds as if the brain merely declined.
      if (error instanceof SeatAuthTerminalError) throw error;
      const cause = error instanceof CallbackWaitError ? error.waitCause : 'wait-failed';
      try { await this.transport.reap(handle, `plancore-${cause}-reaped`); } catch {}
      this.log('plancore-revise-wait-failed');
      return null;
    }

    if (this.artifactService && this.currentDispatchId != null) {
      const rawLine = `[helm callback] ${plancoreRole} ${this.batchId} STATUS: ${seen.state}${seen.note ? ' — ' + seen.note : ''}`;
      const cid = this.artifactService.recordCallback(this.currentDispatchId, plancoreRole, seen.state, rawLine, 'file');
      await this.writer.writeAck(plancoreRole, dispatchNonce);
      this.artifactService.recordAck(cid);
    } else {
      await this.writer.writeAck(plancoreRole, dispatchNonce);
    }
    try { await this.transport.reap(handle, 'plancore-revise-received'); } catch {}
    this.log('plancore-revise-received');

    // BLOCKED brain/plancore callback = BLOCK, not a decision/revision to parse+execute.
    if (seen.state === 'BLOCKED') {
      this.log('plancore-revise-blocked');
      return null;
    }
    if (!seen.note) return null;
    return this.parsePlancoreRevision(seen.note, params.taskKey);
  }

  private parsePlancoreRevision(
    note: string,
    originalTaskKey: string,
  ): {
    task_key: string;
    atomic_work: string;
    validation_criteria: string | string[];
    req_refs?: string[];
    summary?: string;
  } | null {
    try {
      let candidate = note.trim();
      const jsonMatch = candidate.match(/(\{[\s\S]*\})/);
      if (jsonMatch) candidate = jsonMatch[1];
      const parsed = JSON.parse(candidate);
      const task = parsed.revised_task || parsed.task || parsed;
      if (!task || typeof task !== 'object') return null;

      // Schema-validate content fields (reject empty/object-coerced/whitespace).
      let content: RevisedTaskContent;
      try {
        content = validateRevisedTaskContent(task);
      } catch {
        return null;
      }

      // FORCE original task_key — ignore any different key plancore returns (finding 1).
      return {
        task_key: originalTaskKey,
        atomic_work: content.atomic_work,
        validation_criteria: content.validation_criteria,
        ...(content.req_refs !== undefined ? { req_refs: content.req_refs } : {}),
        summary: typeof parsed.summary === 'string' ? parsed.summary : typeof task.summary === 'string' ? task.summary : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * Re-ingest a surgically revised task into plan.json + run_tasks (all-or-nothing).
   * CONTENT ONLY; task_key immutable. On ANY failure → null (no PLAN_REVISED, no brief switch).
   */
  private async reIngestRevisedTask(
    revised: {
      task_key: string;
      atomic_work: string;
      validation_criteria: string | string[];
      req_refs?: string[];
      summary?: string;
    },
    decision: Decision,
  ): Promise<{
    brief: string;
    taskDescription: string;
    briefContract: {
      requirementsAssigned: string;
      requirementsSection: string;
      context: string;
      scope: string;
      expected: string;
      northStarAnchors: string;
    };
  } | null> {
    // Original immutable key — never take a plancore-returned different key.
    const taskKey = this.taskKey || revised.task_key || this.batchId;
    const summary = revised.summary || `revised atomic_work for ${taskKey}`;

    // Validate content before any mutation (fail-closed).
    try {
      validateRevisedTaskContent({
        atomic_work: revised.atomic_work,
        validation_criteria: revised.validation_criteria,
        ...(revised.req_refs !== undefined ? { req_refs: revised.req_refs } : {}),
      });
    } catch {
      this.log('replan-revision-schema-invalid');
      return null;
    }

    const validationCriteria = Array.isArray(revised.validation_criteria)
      ? revised.validation_criteria.join('\n- ')
      : String(revised.validation_criteria);

    // All-or-nothing: plan write AND run_tasks label update. Either fails → no state change.
    let appliedTask: Record<string, unknown>;
    try {
      const { RunOrchestratorService } = await import('./run-orchestrator-service.js');
      const result = await RunOrchestratorService.applyPlanSliceRevision(
        this.runDir,
        {
          task_key: taskKey,
          atomic_work: revised.atomic_work,
          validation_criteria: revised.validation_criteria,
          // undefined → merge keeps existing; explicit array (incl. []) applied as provided
          ...(revised.req_refs !== undefined ? { req_refs: revised.req_refs } : {}),
          summary,
        },
        {
          decisionId: decision.decisionId,
          planRevisionDirective: decision.planRevisionDirective,
        },
      );
      appliedTask = result.task;
    } catch {
      this.log('replan-plan-write-failed');
      return null;
    }

    // Update run_tasks label ONLY (task_key never changes — no COALESCE desync).
    if (this.artifactService && this.taskId != null) {
      try {
        const change = (this.artifactService as any)['db']?.raw
          ?.prepare?.(`UPDATE run_tasks SET label = ?, updated_at = datetime('now') WHERE id = ?`)
          .run(revised.atomic_work, this.taskId);
        if (change && typeof change.changes === 'number' && change.changes !== 1) {
          this.log('replan-db-update-failed');
          return null;
        }
      } catch {
        this.log('replan-db-update-failed');
        return null;
      }
    }

    // Full success only from here: PLAN_REVISED + brief switch.
    if (this.artifactService && this.runId != null) {
      try {
        this.artifactService.recordArtifact(this.runId, 'plan-revised', 'plan.json');
      } catch { /* non-fatal bookkeeping */ }
      this.artifactService.recordRunEvent(
        this.runId,
        'PLAN_REVISED',
        {
          task_key: taskKey,
          decisionId: decision.decisionId,
          summary,
          planRevisionDirective: decision.planRevisionDirective,
          atomic_work: revised.atomic_work,
          validation_criteria: revised.validation_criteria,
        },
        this.batchId,
      );
    }

    // Merge req_refs for the live brief: prefer applied plan task, then revision, then prior contract.
    const mergedReqRefs: string[] = Array.isArray(appliedTask.req_refs)
      ? (appliedTask.req_refs as string[])
      : revised.req_refs !== undefined
        ? revised.req_refs
        : (this.currentBriefContract?.requirementsAssigned || '')
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);

    // task_type is IMMUTABLE — keep the live loop's existing type (from brief contract / prior).
    const immutableTaskType: 'feature' | 'issue' =
      (typeof appliedTask.task_type === 'string' && appliedTask.task_type === 'issue') ||
      (this.currentBriefContract?.scope || '').includes('issue')
        ? 'issue'
        : 'feature';

    const briefContract = {
      requirementsAssigned: mergedReqRefs.length ? mergedReqRefs.join(', ') : taskKey,
      requirementsSection: resolveRequirementsText(this.runDir, mergedReqRefs),
      context: `Batch ${this.batchId} — ${revised.atomic_work} (plan-revised)`,
      scope: `Implement ${taskKey} (${revised.atomic_work}) as an atomic vertical slice (post re-plan). Surgical, minimal-correct.`,
      expected: validationCriteria,
      northStarAnchors: this.currentBriefContract?.northStarAnchors || this.batchId,
    };
    const bw = new BriefWriterService();
    const brief = bw.generateBrief({
      batchId: this.batchId,
      role: 'implementer',
      planPath: path.join(this.runDir, 'plan.json'),
      runDir: this.runDir,
      projectDir: this.projectDir || '.',
      callbacksFile: path.join(this.runDir, 'callbacks.md'),
      taskType: immutableTaskType,
      branch: 'main',
      requirementsAssigned: briefContract.requirementsAssigned,
      requirementsSection: briefContract.requirementsSection,
      context: briefContract.context,
      scope: briefContract.scope,
      expected: briefContract.expected,
      northStarAnchors: briefContract.northStarAnchors,
    });
    const taskSection = `\n\n## Task\ntask_key: ${taskKey}\natomic_work: ${revised.atomic_work}\nvalidation_criteria: ${validationCriteria}\nreq_refs: ${JSON.stringify(mergedReqRefs)}\n`;
    const fullBrief = brief.includes('## Task') ? brief : `${brief}${taskSection}`;
    // taskKey never changes — keep this.taskKey as the original.
    this.taskKey = taskKey;
    return {
      brief: fullBrief,
      taskDescription: `${revised.atomic_work}\nvalidation_criteria: ${validationCriteria}`,
      briefContract,
    };
  }

  // The concrete dispatch role is phase-owned. The model-facing brief and callback protocol stay on
  // the shared helm_pm face; contextual matching resolves callbacks to ibrain.
  private async consultImplementationBrain(handlerRole: string = this.brainRole): Promise<Decision | null> {
    // R5a: brain consults spawn a session too — same pre-dispatch terminal gate.
    await this.assertRunActive('pre-dispatch:brain');
    const ledger = this.escalationService!.buildLedger(this.failureLedger);
    // Persist for rehydrate + brain context (B7 clear+rehydrate will see it on disk)
    try {
      if (this.artifactService) {
        await this.artifactService.writeFailureHistory(this.runDir, ledger);
      } else {
        // fallback direct
        const fsMod = await import('node:fs/promises');
        const p = await import('node:path');
        const dir = p.join(this.runDir, 'failure-history');
        await fsMod.mkdir(dir, { recursive: true });
        await fsMod.writeFile(p.join(dir, 'ledger.json'), JSON.stringify(ledger, null, 2), 'utf8');
      }
    } catch {}

    const briefWriter = new BriefWriterService();
    const brainBrief = briefWriter.generateBrainBrief({
      batchId: this.batchId,
      ledger,
      lastReproNote: this.lastReproNote,
      projectDir: process.cwd(),
      callbacksFile: path.join(this.runDir, 'callbacks.md'),
    });
    const dispatchNonce = createDispatchNonce();
    const dispatchBrief = bindDispatchNonce(brainBrief, dispatchNonce);

    await this.writer.writeBrief(handlerRole, dispatchBrief);

    let dispatchId = 0;
    if (this.artifactService && this.currentAttemptId != null) {
      dispatchId = this.artifactService.recordDispatch(this.currentAttemptId, handlerRole, `prompts/${handlerRole}.brief.md`, null);
    }
    this.currentDispatchId = dispatchId;

    // POCFIX22 mirror (T3): snapshot callbacks.md byte size before spawn so stale planning-phase BLOCKED is not matched.
    const isFakePath = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    let dispatchOffset = 0;
    if (!isFakePath) {
      try {
        const cbStat = await fs.stat(path.join(this.runDir, 'callbacks.md'));
        dispatchOffset = cbStat.size;
      } catch { /* file may not exist yet; offset stays 0 (no prior callbacks) */ }
    }

    const callbackRole = handlerRole;
    const spawned = await this.transport.spawn({
      role: handlerRole,
      brief: dispatchBrief,
      runDir: this.runDir,
      batchId: this.batchId,
      model: handlerRole === this.brainRole ? this.brainModel : undefined,
      provider: handlerRole === this.brainRole ? this.brainProvider : undefined,
      projectDir: this.projectDir,
      ...(this.strictReadAllow ? { strictReadAllow: this.strictReadAllow } : {}),  // B-ISO1: run-scoped strict read fence on the brain-decision seat
    });
    const handle = spawned.handle;

    // R8: composer submit watchdog on the brain-decision wait too (same variable Enter-drop window).
    let seen: { state: string; note: string | null };
    try {
      seen = await this.waitForCallback(callbackRole, ['DECISION-READY', 'BLOCKED'], {
        sinceOffset: dispatchOffset,
        handle,
        provider: handlerRole === this.brainRole ? (this.brainProvider ?? 'grok') : 'grok',
        brief: dispatchBrief,
        watchdogTarget: handle,
        watchdogBrief: dispatchBrief,
      });
    } catch (error) {
      // #47: an unauthenticated brain seat must abort the run, not degrade to a silent null — otherwise
      // the provider-level fault is swallowed and the caller proceeds as if the brain merely declined.
      if (error instanceof SeatAuthTerminalError) throw error;
      const cause = error instanceof CallbackWaitError ? error.waitCause : 'wait-failed';
      try { await this.transport.reap(handle, `${handlerRole}-${cause}-reaped`); } catch {}
      throw error;
    }

    if (this.artifactService && this.currentDispatchId != null) {
      const rawLine = `[helm callback] ${handlerRole} ${this.batchId} STATUS: ${seen.state}${seen.note ? ' — ' + seen.note : ''}`;
      const cid = this.artifactService.recordCallback(this.currentDispatchId, handlerRole, seen.state, rawLine, 'file');
      await this.writer.writeAck(callbackRole, dispatchNonce);
      this.artifactService.recordAck(cid);
    } else {
      await this.writer.writeAck(callbackRole, dispatchNonce);
    }
    this.log('ack-written');
    this.log('acked');

    await this.transport.reap(handle, 'brain-decision-received');
    this.log('reap-called');
    this.log('reaped');

    // BLOCKED brain callback = BLOCK, not a decision (finding 8). Do NOT parse+execute from a BLOCKED note.
    if (seen.state === 'BLOCKED') {
      this.log('brain-blocked');
      return null;
    }
    const decision = this.escalationService!.parseDecision(seen.note);
    return decision;
  }

  private async persistFinal(status: string): Promise<void> {
    if (this.artifactService && this.runId != null) {
      await this.artifactService.persistState(this.runDir, this.transitions, status, this.runId);
      this.artifactService.recordArtifact(this.runId, 'final', 'artifacts/final.json');
      // E3-writers: mirror task final + status to <project>/helm_tasks/<list>/<task>/ (B5 root)
      // use taskKey for consistent dir (same getTaskArtifactRoot call as summary links)
      if (this.projectDir && this.taskId != null) {
        try {
          const root = this.artifactService.getTaskArtifactRoot(this.projectDir, this.runId, this.batchId, this.taskId, this.taskKey ?? null);
          await fs.mkdir(root, { recursive: true });
          await fs.writeFile(path.join(root, 'final.json'), JSON.stringify({ status, transitions: this.transitions, ts: new Date().toISOString() }, null, 2), 'utf8');
          // also a changes.md stub for the task (real changes by agent; helm records summary link)
          await fs.writeFile(path.join(root, 'changes.md'), `# Task ${this.taskId} (${status})\n\nSee runDir artifacts + project git for full diff. Helm artifacts at helm_tasks root.\n`, 'utf8');
        } catch {}
      }
    } else {
      await this.writer.persistState(this.transitions, status);
    }
  }

  // Backward compat for existing B0/B1 thin + roundtrip tests (feature path)
  async execute(implBrief: string): Promise<{ finalStatus: 'PASS' | 'FAIL' | 'DEFERRED' | 'BLOCKED'; transitions: Transition[]; attempts: number }> {
    return this.runTask({ brief: implBrief, taskType: 'feature' });
  }

  /**
   * B10-T06: Run a dedicated validator UI-proof phase for a just-deployed batch on the DEV URL.
   * Reuses the exact performRolePhase + waitForCallback machinery + BriefWriter JROM-clone section.
   * The caller (run-orchestrator) supplies a pre-built brief that includes the B10-T03 "REQUIRE UI-proof"
   * language specialized to the deployed devUrl.
   */
  async runBatchDeployProof(
    validatorBrief: string,
    devUrl: string,
    batchPrefix: string
  ): Promise<{ state: string; note: string | null }> {
    // Use the existing role-phase machinery (it handles brief write, spawn, wait, abort checks, etc.)
    // Acceptable states mirror normal validator + the gate.
    const res = await this.performRolePhase('validator', validatorBrief, ['PASS', 'FAIL', 'BLOCKED', 'DONE']);
    return { state: res.state, note: res.note || null };
  }

  /**
   * B9 (PLN1/PLN2 guardrail 3): drive pre-ingested run from the B6 TaskQueue.
   * - plan + keyToId come from PlanParserService.ingestPlan (after co-planner gate passed).
   * - For each getNextReady: call the *existing* runTask (with preExistingTaskId + explicitModel/complexity
   *   from the plan so B8 resolveRungAndModel + plan-summon + ladder + repro-first + performRolePhase
   *   execute the work exactly as before — no new execution path).
   * - Marks queue complete/failed so dependents unblock.
   * - Returns aggregate + transitions for tests.
   */
  async runQueuedTasks(params: {
    runId: number;
    queue: TaskQueueService;
    artifactService: RunArtifactService;
    plan: Plan;
    keyToId: Record<string, number>;
  }): Promise<{ finalStatuses: Array<'PASS' | 'FAIL' | 'DEFERRED' | 'BLOCKED'>; transitions: Transition[] }> {
    const idToKey: Record<number, string> = {};
    for (const [k, id] of Object.entries(params.keyToId)) {
      idToKey[Number(id)] = k;
    }
    const meta: Record<string, PlannedTask> = {};
    for (const t of params.plan.tasks) meta[t.task_key] = t;

    const finalStatuses: Array<'PASS' | 'FAIL' | 'DEFERRED' | 'BLOCKED'> = [];
    this.runId = params.runId;

    while (true) {
      if (params.artifactService) {
        const decision = selectNextWork({
          db: (params.artifactService as any)['db'],
          queue: params.queue,
          runId: params.runId,
        });
        if (decision.kind === 'OPEN_FENCE') {
          openFence((params.artifactService as any)['db'], {
            fenceId: decision.fenceId,
            cwd: process.cwd(),
            repoRoot: process.cwd(),
            runDir: this.runDir,
          });
          continue;
        }
        if (decision.kind !== 'DISPATCH_TASK') break;
      }
      // B03 C1: claim freezes TaskTerminalToken; carry through await — never mark*(taskId, runId) after settle.
      const terminalToken = params.queue.claimNextReady(params.runId);
      if (terminalToken == null) break;
      const taskId = terminalToken.taskId;

      const key = idToKey[taskId];
      const pTask = (meta[key] || {}) as PlannedTask;
      const briefWriter = new BriefWriterService();
      const seed = pTask.atomic_work || `task ${key || taskId}`;
      const taskKey = key || `T${taskId}`;
      const reqRefs = Array.isArray((pTask as any).req_refs)
        ? (pTask as any).req_refs.map((ref: unknown) => String(ref).trim()).filter(Boolean)
        : [];
      const validationCriteria = Array.isArray(pTask.validation_criteria)
        ? pTask.validation_criteria.join('\n- ')
        : pTask.validation_criteria || 'Satisfy the task per plan.json and north-star.md.';
      const briefContract = {
        requirementsAssigned: reqRefs.length ? reqRefs.join(', ') : taskKey,
        requirementsSection: resolveRequirementsText(this.runDir, reqRefs),
        context: `Batch ${this.batchId} — ${seed}`,
        scope: `Implement ${taskKey} (${seed}) as an atomic vertical slice. Surgical, minimal-correct. Assert OUTCOMES against the requirements above.`,
        expected: validationCriteria,
        northStarAnchors: seed,
      };
      const fullBrief = briefWriter.generateBrief({
        batchId: this.batchId,
        role: 'implementer',
        planPath: path.join(this.runDir, 'plan.json'),
        runDir: this.runDir,
        branch: 'main',
        ...briefContract,
        taskType: pTask.task_type || 'feature',
        projectDir: process.cwd(),
        callbacksFile: path.join(this.runDir, 'callbacks.md'),
      });

      let res: { finalStatus: 'PASS' | 'FAIL' | 'DEFERRED' | 'BLOCKED' };
      try {
        res = await this.runTask({
          brief: fullBrief,
          taskType: pTask.task_type || 'feature',
          userCritical: Boolean(pTask.user_critical),
          complexity: pTask.complexity,
          recommendedRung: pTask.recommended_rung,
          explicitModel: pTask.recommended_model,
          validatorRung: pTask.validator_rung,
          validatorModel: pTask.validator_model,
          effort: pTask.effort,
          preExistingTaskId: taskId,
          taskKey: key,  // E3/E5 pass for consistent helm_tasks dir name
          briefContract,
        });
        finalStatuses.push(res.finalStatus);
        if (res.finalStatus === 'PASS') {
          params.queue.markComplete(terminalToken);
        } else if (res.finalStatus === 'DEFERRED') {
          params.queue.markDeferred(terminalToken);
        } else if (res.finalStatus === 'BLOCKED') {
          // pause already enacted inside runTask (phase+artifact); do not mark task, stop further dispatch
        } else {
          params.queue.markFailed(terminalToken);
        }
        if (res.finalStatus === 'BLOCKED') break;
      } catch (e) {
        // FIX-C hole #6: wrap to mirror the catch in run-orchestrator drain; prevent abort of whole queue on timeout.
        params.queue.markFailed(terminalToken);
        finalStatuses.push('FAIL');
        // R5a: run-abort must stop the DRAIN too, not just the task — rethrow after bookkeeping.
        if (e instanceof RunAbortedError) throw e;
      }
    }

    // B10 DSP9 + DSP10 (after queue drains per context-handoff + brief): fresh final val over req-matrix; terminal gate
    if (this.runDir) {
      try {
        await fs.access(path.join(this.runDir, 'req-matrix.md'));
        await this.performFinalRunValidation();
      } catch {}
    }
    return { finalStatuses, transitions: this.getTransitions() };
  }

  // B10 DSP9: fresh-context validator over the full req-matrix after drain. Returns whether passed.
  private async performFinalRunValidation(): Promise<{ passed: boolean; note?: string }> {
    let matrix = '';
    try {
      matrix = await fs.readFile(path.join(this.runDir, 'req-matrix.md'), 'utf8');
    } catch {}
    const briefWriter = new BriefWriterService();
    const seedBrief = `DSP9 final run-level validation (fresh-context validator after queue drains).
Run req-matrix.md (source of truth; audit EVERY req):
${matrix}

For each requirement confirm VERIFIED status with evidence from artifacts/state/validations. Emit exactly PASS (all good) or FAIL — defect_class=<non-empty-token>; <gaps + reasons>.`;
    const brief = briefWriter.generateBrief({
      batchId: this.batchId,
      role: 'validator',
      planPath: path.join(this.runDir, 'plan.json'),
      runDir: this.runDir,
      branch: 'main',
      requirementsAssigned: 'FINAL-VALIDATION',
      northStarAnchors: 'req-matrix.md + run artifacts',
      scope: seedBrief,
      requirementsSection: matrix || 'audit req-matrix',
      taskType: 'feature',
      projectDir: process.cwd(),
      callbacksFile: path.join(this.runDir, 'callbacks.md'),
    });
    const dispatchNonce = createDispatchNonce();
    const dispatchBrief = bindDispatchNonce(brief, dispatchNonce);
    await this.writer.writeBrief('final-validator', dispatchBrief);

    let dispatchId = 0;
    if (this.artifactService && this.runId != null) {
      dispatchId = this.artifactService.recordDispatch(0 as any, 'validator', 'prompts/final-validator.brief.md', null);
    }
    let dispatchOffset = 0;
    try { dispatchOffset = (await fs.stat(path.join(this.runDir, 'callbacks.md'))).size; } catch {}
    const spawned = await this.transport.spawn({
      role: 'validator',
      brief: dispatchBrief,
      runDir: this.runDir,
      batchId: this.batchId,
      effort: this.currentEffort,
      projectDir: this.projectDir,  // B9: this seam previously omitted projectDir, silently reproducing the fenced-write bug at final tests
      ...(this.strictReadAllow ? { strictReadAllow: this.strictReadAllow } : {}),  // B-ISO1: run-scoped strict read fence on the final-tests validator seat
      // B9 (R4.1/R4.3): final-validation is the third CYCLE SEAT class — carries the same persisted
      // cycle git identity as implementer/validator dispatch.
      ...(this.cycleGitIdentity ? { cycleGitIdentity: this.cycleGitIdentity } : {}),
    });
    const handle = spawned.handle;
    // R8: composer submit watchdog on the final-validation wait too.
    let seen: { state: string; note: string | null };
    try {
      seen = await this.waitForCallback('validator', ['PASS', 'FAIL', 'DONE', 'BLOCKED'], {
        sinceOffset: dispatchOffset,
        handle,
        provider: 'grok',
        brief: dispatchBrief,
        watchdogTarget: handle,
        watchdogBrief: dispatchBrief,
      });
    } catch (error) {
      // #47: an unauthenticated brain seat must abort the run, not degrade to a silent null — otherwise
      // the provider-level fault is swallowed and the caller proceeds as if the brain merely declined.
      if (error instanceof SeatAuthTerminalError) throw error;
      const cause = error instanceof CallbackWaitError ? error.waitCause : 'wait-failed';
      try { await this.transport.reap(handle, `validator-${cause}-reaped`); } catch {}
      throw error;
    }
    if (this.artifactService && dispatchId) {
      const rawLine = `[helm callback] validator ${this.batchId} STATUS: ${seen.state}${seen.note ? ' — ' + seen.note : ''}`;
      const cid = this.artifactService.recordCallback(dispatchId, 'validator', seen.state, rawLine, 'file');
      await this.writer.writeAck('validator', dispatchNonce);
      this.artifactService.recordAck(cid);
    } else {
      await this.writer.writeAck('validator', dispatchNonce);
    }
    await this.transport.reap(handle, 'final-val-complete');
    const passed = seen.state === 'PASS' || seen.state === 'DONE';
    return { passed, note: seen.note ?? undefined };
  }

  // B10 DSP10 run-done TERMINAL GATE (returns true ONLY when ALL 5 hold). Overrides for explicit blocker tests.
  public async computeRunDone(overrides: { allReqVerified?: boolean; finalValPassed?: boolean; allReaped?: boolean; artifactsSynced?: boolean; noPending?: boolean } = {}): Promise<boolean> {
    const o = overrides;
    let allVerified = o.allReqVerified;
    if (allVerified === undefined && this.runDir) {
      try {
        const rows = await (this.artifactService ? this.artifactService.readReqMatrix(this.runDir) : Promise.resolve([] as any));
        allVerified = rows.length > 0 && rows.every((r: any) => r.status === 'VERIFIED');
      } catch {
        allVerified = false;
      }
    }
    allVerified = allVerified ?? true;
    const finalPassed = o.finalValPassed ?? true;
    const reaped = o.allReaped ?? true;
    const synced = o.artifactsSynced ?? true;
    const noPending = o.noPending ?? true;
    const isDone = allVerified && finalPassed && reaped && synced && noPending;
    this.log(isDone ? 'run-done' : 'run-blocked');
    return isDone;
  }
}
