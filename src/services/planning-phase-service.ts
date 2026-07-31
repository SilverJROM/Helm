import fs from 'node:fs/promises';
import path from 'node:path';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { PlanParserService, Plan, PlannedTask } from './plan-parser-service.js';
import type { ITransport } from './fake-transport.js';
import { bindDispatchNonce, BriefWriterService, createDispatchNonce } from './brief-writer-service.js';
import { roleMatches } from './role-alias.js';
import { parseCallbackLine } from './agent-event-ingest.js';
import { classifySeatPane } from './seat-pane-state.js';
import { CANONICAL_CYCLE_ARTIFACTS, materializeCanonicalArtifactSet } from './cycle-artifact-paths.js';
import { validateExecutionPlan } from './execution-plan-parser.js';
import { finalizeWorkerRuntimeRow } from './worker-runtime-finalize.js';
import { readPlanRevision } from './plan-revision.js';
import { runReviewRound } from './planning-review-round.js';
import type { RoundBlockedReasonKind } from './planning-review-round.js';

/**
 * B9 PLN1: Planning-phase orchestration (projcore-brain + co-planner).
 * - Consumes north-star.md + conversation log (fixture or real).
 * - Per projcore agent def (B3 seeds): planning_partner.mode (auto|planner|deliberation), agree_before_proceed.
 * - auto pick: simple/clear/low-risk -> 'planner'; cross-cutting/ambiguous/arch/schema/security -> 'deliberation'.
 * - agree-before-proceed gate: **BLOCKS** ingest/hand-off to the B6 loop until agreement.
 *   A8 (R1.2): a planning run always convenes a partner and always requires its agreement signal —
 *   'planner' selects a single co-reviewer, 'deliberation' a cross-cutting review; neither skips the
 *   partner. The former POCFIX9 no-co-planner fast path (mode='planner' spawns no partner and PLAN-READY
 *   alone passes the gate) is deleted; a stall with no partner signal returns agreed:false, never a
 *   silent pass.
 * - Under USE_FAKE_TMUX: fixture-driven for tests (cbs + spawns); representative plan only on missing file (guarded).
 * - Real path (!USE_FAKE_TMUX / prod): plancore authors canonical og-requirements.md + plan.md; Helm validates plan.md and derives the internal runDir/plan.json.
 * - On agreement + valid plan: delegates to PlanParserService.ingestPlan (no new exec path after).
 * - Real chat later (the projcore worker will author via its brief; phase just drives the spawns/gate).
 */

export type CoPlannerMode = 'auto' | 'planner' | 'deliberation';

// A9 (N11): teams.consensus_rule is a free-text policy string (seed: 'unanimous <=3 rounds;
// opus+codex-5.5 settle'). Two of its three clauses are locked policy (D1 unanimous, D7 <=3 rounds,
// per-project configurable); the third (settle role) is undecided and contradicts topology.yaml, so it
// is deliberately never parsed/exposed here — wiring it would install an undecided arbitration rule as
// live behaviour. maxRounds defaults to 3 (D7's configured default) when the clause is absent or
// unparseable; unanimous reflects only what the clause literally states (no default — an omission is
// a real config gap the caller should see, not something to paper over).
export interface ConsensusPolicy {
  unanimous: boolean;
  maxRounds: number;
}

export function parseConsensusRule(rule: string | null | undefined): ConsensusPolicy {
  const text = (rule || '').toLowerCase();
  const unanimous = text.includes('unanimous');
  const roundsMatch = /<=\s*(\d+)\s*rounds?/.exec(text);
  const maxRounds = roundsMatch ? Math.max(1, parseInt(roundsMatch[1], 10)) : 3;
  return { unanimous, maxRounds };
}

// A13 (D6 per-task half / R1.29 reconvene half): the per-task machine verdict retained on the plan.
// ACCEPT is the implicit default when a seat emits no TASK-VERDICT line for a task (never on a task
// both seats accept — no default per-task convene loop). AMEND/ESCALATE must be explicit.
export type TaskVerdict = 'ACCEPT' | 'AMEND' | 'ESCALATE';

export interface TaskVerdictConflict {
  taskKey: string;
  plancoreVerdict: TaskVerdict;
  partnerVerdict: TaskVerdict;
  reason: 'ESCALATE' | 'CONFLICTING-AMEND';
}

/**
 * Pure conflict detector (A13/R1.29 reconvene half — A9's scope half, the whole-plan gate, is
 * untouched and unrelated). Convene the pair ONLY when:
 * - either seat's verdict for a task is ESCALATE (always dispositive on its own), or
 * - both propose AMEND but with DIFFERENT notes (a genuine conflicting amendment).
 * Never convenes when both seats ACCEPT, nor when both seats independently converge on the
 * byte-identical AMEND (they have already agreed on the same change — no conflict to resolve).
 * A seat with no TASK-VERDICT line for a task defaults to ACCEPT (the retained default).
 */
export function detectTaskReconveneConflicts(
  taskKeys: string[],
  plancoreVerdicts: Map<string, { verdict: TaskVerdict; note: string }>,
  partnerVerdicts: Map<string, { verdict: TaskVerdict; note: string }>
): TaskVerdictConflict[] {
  const conflicts: TaskVerdictConflict[] = [];
  for (const taskKey of taskKeys) {
    const pc = plancoreVerdicts.get(taskKey) ?? { verdict: 'ACCEPT' as TaskVerdict, note: '' };
    const pt = partnerVerdicts.get(taskKey) ?? { verdict: 'ACCEPT' as TaskVerdict, note: '' };
    if (pc.verdict === 'ESCALATE' || pt.verdict === 'ESCALATE') {
      conflicts.push({ taskKey, plancoreVerdict: pc.verdict, partnerVerdict: pt.verdict, reason: 'ESCALATE' });
      continue;
    }
    // A13 send-back (attempt=2, redteam HIGH): CONFLICTING-AMEND requires BOTH seats to actually
    // propose AMEND — a unilateral AMEND against an (implicit or explicit) ACCEPT is not a conflict
    // per the locked contract ("never on a task both seats accept... convene only on ESCALATE or a
    // conflicting AMEND"). The prior fallthrough treated ANY non-identical pair as CONFLICTING-AMEND,
    // which incorrectly reconvened on AMEND-vs-ACCEPT. Only two AMENDs with differing notes conflict;
    // identical AMEND (already handled above) and every other combination proceed with no reconvene.
    if (pc.verdict === 'AMEND' && pt.verdict === 'AMEND' && pc.note.trim() !== pt.note.trim()) {
      conflicts.push({ taskKey, plancoreVerdict: pc.verdict, partnerVerdict: pt.verdict, reason: 'CONFLICTING-AMEND' });
    }
  }
  return conflicts;
}

function clampedPlanningMs(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

export interface PlanningInputs {
  runDir: string;
  canonicalArtifactRoot?: string; // Cycle workspace for cycle-backed planning; runDir otherwise.
  batchId?: string;
  northStar: string;           // fallback content; an existing canonical north-star.md wins
  conversationLog?: string;    // the "interview" product
  mode?: CoPlannerMode;        // default 'auto'
  autoSignals?: { isCrossCutting?: boolean; isAmbiguous?: boolean; isHighRisk?: boolean };
  sessionName?: string;        // A2: per-project configurable for projcore (e.g. helm_cards)
  projectId?: number;          // A2: associate created run with project
  projectDir?: string;         // registered project.directory (e.g. /home/agjrom/websites/cards); passed to briefs for real builds; real path requires projcore-authored plan for this project
  brainRole?: string;          // Phase ownership role for the concrete planning seat (plancore).
  planningBrainModel?: string; // Bound model for the plancore role.
  partnerModel?: string;       // POCFIX4: bound model from role_bindings for the auto-chosen co-planner partner role (planner or deliberation)
  planningBrainProvider?: string; // Provider from the plancore role binding.
  partnerProvider?: string;    // POCFIX5: provider for the co-planner partner
  /**
   * S06: ordered configured co-planner seat specs from S05 PlanningStaffingService.
   * When non-empty, each partner spawn uses that seat's exact model/provider/effort
   * (never a single repeated partnerModel). Partner count = length. Legacy partnerModel
   * + panelSize path remains when absent/empty.
   */
  coPlannerSeats?: Array<{
    slot: number;
    provider: string;
    model: string;
    effort?: string;
    source?: string;
  }>;
  runId?: number;              // D-b1: if provided (interview path pre-created the run), reuse for ingest instead of createRun
  strictReadAllow?: string[];  // B-ISO1 (sol wiring review fix #4): run-scoped opt-in strict read allowlist, threaded from RunOrchestrator to the projcore + partner planning seats. undefined => read-all (unchanged).
  adaptivePlanning?: boolean;  // v92: project.adaptive_planning — when true, runPlanningPhase delegates to the adaptive tiered planner module. Default/undefined => existing single-author path.
  /** A10 (R1.3): core (non-adaptive) planning panel size — total seats (plancore + partners), from
   *  project.planning_panel_size. Default/undefined => 2 (today's plancore+1-partner behavior).
   *  Distinct from the adaptive planner's own `panel.size` (only consulted when adaptivePlanning is on).
   *  S06: ignored for partner count when coPlannerSeats is non-empty. */
  panelSize?: number;
  /** v93: per-project adaptive planner panel (size / lead / members / backups / default effort). */
  panel?: import('./adaptive-planning-phase.js').PlannerPanel;
  /** v93: optional availability probe for backup fallback (seat-binary). */
  isModelAvailable?: (provider: string, model: string) => boolean | Promise<boolean>;
  /** A11 (R1.6 + D7): co-planner agreement round cap, from project.planning_round_cap. Default/undefined
   *  => 3. The bounded-exit wall-clock budget is PLANNING_TIMEOUT_MS * roundCap (see effectiveTimeoutMs) —
   *  exhausting it is D7's "round cap exhausted", the SAME mechanism as R1.6's timeout, never a silent pass. */
  roundCap?: number;
}

export interface PlanningResult {
  agreed: boolean;
  coPlannerUsed: 'planner' | 'deliberation';
  northStarPath: string;
  reqPath: string;
  planJsonPath: string;
  planMdPath: string;
  plan: Plan;                  // the ingested machine plan
  createdTaskIds: number[];
  keyToId: Record<string, number>;
  runId: number;               // A2: the DB run created (now supports projectId)
  /** A11 (R1.6 + D7): set only when agreed===false — a mechanism-level reason naming the missing
   *  partner batch id(s) and the round-cap budget exhausted, for the caller's visible BLOCKED state. */
  blockedReason?: string;
  /** C8: typed non-agreement cause from the round machine, set alongside blockedReason when available. */
  blockedReasonKind?: RoundBlockedReasonKind;
  /** C4: number of review rounds attempted before agreement or blocked return. */
  roundsAttempted?: number;
  /** A13 (R1.29 reconvene half): task_keys the pair was reconvened for (ESCALATE or a conflicting
   *  AMEND). Empty when every task was ACCEPTed by both seats (or carried no explicit verdict at all) —
   *  never populated by the whole-plan gate itself, only by this row's per-task conflict detector. */
  reconvenedTaskKeys?: string[];
}

export function selectCoPlannerMode(
  northStar: string,
  signals: { isCrossCutting?: boolean; isAmbiguous?: boolean; isHighRisk?: boolean } = {}
): 'planner' | 'deliberation' {
  if (signals.isCrossCutting || signals.isAmbiguous || signals.isHighRisk) return 'deliberation';
  const t = (northStar || '').toLowerCase();
  // A10 (R1.3): the bare `arch` alternative false-positived on any north-star mentioning "search"
  // (se-ARCH matches an unanchored substring) — replaced with `architect` (architecture/architect),
  // the actual cross-cutting signal this clause was meant to catch; "search" does not contain it.
  if (/cross.?module|schema|architect|ambiguous|multiple (viable|approach)|security|high.?risk/.test(t)) {
    return 'deliberation';
  }
  return 'planner';
}

export class PlanningPhaseService {
  private readonly parser: PlanParserService;

  constructor(
    private readonly transport: ITransport,
    private readonly artifacts: RunArtifactService,
    private readonly queue: TaskQueueService
  ) {
    this.parser = new PlanParserService(artifacts);
  }

  setIngestValidator(validator: (runId: number, plan: Plan) => void): void {
    this.parser.setIngestValidator(validator);
  }

  // A1 (R4.16 substrate): record a planning seat's worker_runtimes row so plancore/partner are
  // DB-observable with run+cycle linkage (SEAM-1). Mirrors orchestrator-loop.ts's A4
  // registerWorkerRuntime — same bracket-idiom DB access, same best-effort/never-throw contract,
  // guarded off when projectId/runId are absent (fixture/no-DB paths untouched).
  private registerWorkerRuntime(
    projectId: number | undefined,
    runId: number | undefined,
    role: string,
    correlationId: string,
    handle: string,
    provider?: string,
    model?: string
  ): number | null {
    if (projectId == null || runId == null) return null;
    try {
      const db = (this.artifacts as any)['db']?.raw;
      if (!db) return null;
      const session = (handle || '').split(':')[0] || null;
      // Mirror RealTransport's own defaulting (model || 'grok-4.5', provider from that) so the
      // recorded row matches what was actually spawned when the caller left provider/model unresolved.
      const wModel = model || 'grok-4.5';
      const wProvider = provider || 'grok';
      const info = db.prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at)
         VALUES (?,?,?,?,?,?,'running','planning-phase',?, datetime('now'))`
      ).run(projectId, role, wProvider, wModel, session, correlationId, runId);
      return Number(info.lastInsertRowid);
    } catch {
      return null;
    }
  }

  // A1/A15: transition a planning seat's worker_runtimes row to a terminal state (shared finalizeWriter).
  private finalizeWorkerRuntime(id: number | null, state: 'done' | 'failed' | 'reaped', reason: string): void {
    if (id == null) return;
    try {
      const db = (this.artifacts as any)['db']?.raw;
      if (!db) return;
      finalizeWorkerRuntimeRow(db, id, state, reason);
    } catch {
      /* best-effort bookkeeping */
    }
  }

  // A5 (AC5/AC23): reap a retained planning seat transport handle. Best-effort/never-throw, same
  // contract as finalizeWorkerRuntime and the existing retry-loop reap (above) — a transport-level
  // failure to tear down a session must never block the DB finalize that follows it. Both FakeTransport
  // and RealTransport's own reap() are already no-ops on an already-reaped handle, so calling this twice
  // for the same handle (e.g. a respawned seat whose earlier attempt was reaped in-loop) is idempotent.
  private async reapPlanningHandle(handle: string | null, reason: string): Promise<void> {
    if (!handle) return;
    try {
      await this.transport.reap(handle, reason);
    } catch {
      /* best-effort — see comment above */
    }
  }

  // A9 (N11): resolve the deliberation team's consensus_rule and log it as the consensus source for
  // this planning run — "wire it or delete it" (og-requirements §5) for the two decided clauses.
  // Best-effort/never-throw (same bracket-idiom DB access as registerWorkerRuntime): a missing
  // teams row or DB access failure falls back to parseConsensusRule's own defaults, it never blocks
  // planning. Round-cap ENFORCEMENT (blocking after maxRounds) is A11's row, not this one — this only
  // sources the policy so A11 has a config value to read instead of a constant.
  private resolveConsensusPolicy(): ConsensusPolicy {
    try {
      const db = (this.artifacts as any)['db']?.raw;
      const row = db?.prepare("SELECT consensus_rule FROM teams WHERE type = 'deliberation' LIMIT 1").get() as
        | { consensus_rule: string | null }
        | undefined;
      return parseConsensusRule(row?.consensus_rule ?? null);
    } catch {
      return parseConsensusRule(null);
    }
  }

  // A9 send-back (attempt=3): the agreement fence is a DURABLE sidecar file in runDir, not a
  // process-local Map — attempt=2's in-memory high-water mark was wiped by a process/service restart
  // (a fresh PlanningPhaseService instance has an empty map), so a same-batch restart/rerun landing
  // after a redeploy or crash was exactly as vulnerable to a stale VERDICT-READY CLEAN as before the
  // first send-back fix. A file survives the process that wrote it. Named per (runDir, batchId) —
  // runDir is deterministic per (projectId, batchId) in production, but a test/edge case can reuse one
  // runDir across different batchIds, so the batchId is embedded in the filename to stay scoped
  // correctly per key, matching R1.5's own batch-scoping contract for the gate itself.
  private agreementFencePath(runDir: string, batchId: string): string {
    const safeBatchId = String(batchId).replace(/[^A-Za-z0-9_.-]/g, '_');
    return path.join(runDir, `.agreement-fence-${safeBatchId}`);
  }

  // Absent fence file (a genuinely first-ever attempt for this key, on ANY process instance) reads as
  // offset 0 — nothing fenced — so a fixture/caller that pre-seeds the whole callbacks.md before
  // starting the run (the established pattern throughout this codebase's tests, and structurally the
  // same as a real run's own first attempt) stays unaffected.
  // Self-heal: callbacks.md is append-only in normal operation, so a valid fence can never exceed the
  // file's CURRENT size — the recorded high-water mark only ever pointed at a byte offset that existed
  // at write time, and the file only grows from there. If the fence on disk is somehow larger than the
  // current file (the runDir was reused for a fresh callbacks.md — recreated/truncated rather than
  // appended to, e.g. after a disaster-recovery reset, or a test/fixture that rewrites callbacks.md in
  // place without clearing runDir), that proves the recorded history no longer corresponds to this
  // file's reality, so it is discarded (treated as a first-ever attempt) rather than blocking every
  // current line forever.
  private async readAgreementFence(runDir: string, batchId: string, cbPath: string): Promise<number> {
    try {
      const raw = await fs.readFile(this.agreementFencePath(runDir, batchId), 'utf8');
      const n = parseInt(raw.trim(), 10);
      const recorded = Number.isFinite(n) && n >= 0 ? n : 0;
      if (recorded === 0) return 0;
      const currentSize = (await fs.stat(cbPath)).size;
      return recorded <= currentSize ? recorded : 0;
    } catch {
      return 0;
    }
  }

  // Record this key's high-water mark at the end of a runPlanningPhase call (both the agreed:false and
  // agreed:true exits) — everything this call saw or wrote is now "old" for any FUTURE call (in this
  // process or any later one) that reuses the same (runDir, batchId). Best-effort: a write failure
  // just leaves the prior mark (or none) in place rather than blocking the return.
  private async advanceAgreementFence(runDir: string, batchId: string, cbPath: string): Promise<void> {
    try {
      const size = (await fs.stat(cbPath)).size;
      await fs.writeFile(this.agreementFencePath(runDir, batchId), String(size), 'utf8');
    } catch { /* leave prior mark (or none) in place */ }
  }

  private async ensureDir(sub: string, runDir: string): Promise<void> {
    await fs.mkdir(path.join(runDir, sub), { recursive: true });
  }

  private async writeFileSafe(p: string, content: string): Promise<void> {
    await fs.writeFile(p, content, 'utf8');
  }

  /**
   * Run the planning phase (real projcore-authored canonical plan.md on prod/real path; guarded fixture ONLY under USE_FAKE_TMUX for tests).
   * Gate (A8/R1.2 — every mode always convenes a partner and requires its agreement signal):
   *   - 'planner' (single, for clear non-cross-cutting features per selectCoPlannerMode): partner agreement
   *     (REVIEW/AGREE/CONSENSUS) + projcore PLAN-READY + valid canonical plan.md.
   *   - 'deliberation': partner agreement (REVIEW/AGREE/CONSENSUS) + projcore PLAN-READY + valid canonical plan.md.
   * Real path: if canonical requirements + plan are absent/invalid -> clear BLOCK error (throw), no ingest, no fixture fallback.
   * Returns the plan + ingest results (task ids) so caller can drive runQueuedTasks.
   */
  async runPlanningPhase(inputs: PlanningInputs): Promise<PlanningResult> {
    // v92 (adaptive tiered planner, opt-in): when the project has adaptive_planning ON, delegate to the
    // SEPARATE module (grok red-team FIX 7 — no if-soup here). OFF (default) → the existing single-author
    // flow below runs byte-identical. The delegate emits the SAME PlanningResult so ingest is unchanged.
    if (inputs.adaptivePlanning) {
      const { runAdaptivePlanningPhase } = await import('./adaptive-planning-phase.js');
      return runAdaptivePlanningPhase(
        { transport: this.transport, artifacts: this.artifacts, taskQueue: this.queue },
        inputs as any
      );
    }
    const runDir = inputs.runDir;
    const canonicalArtifactRoot = inputs.canonicalArtifactRoot || runDir;
    const batchId = inputs.batchId || 'batch-B9';
    const mode = inputs.mode || 'auto';
    const brainRole = inputs.brainRole || 'plancore';

    // A9 send-back (attempt=3): read this key's DURABLE fence (see agreementFencePath doc above) —
    // survives a process/service restart, unlike attempt=2's in-memory map. Absent on a first-ever
    // attempt for this key on any process instance — offset 0, nothing fenced — so a fixture/caller
    // that pre-seeds the whole callbacks.md before starting the run (common throughout this codebase's
    // tests, and structurally the same as a real run's own first attempt) is unaffected.
    const agreementFenceOffset = await this.readAgreementFence(runDir, batchId, path.join(runDir, 'callbacks.md'));

    // POCFIX8 (B): compute timeout early (after batchId/mode). Real !fake path: long ~10min default (env HELM_PLANNING_TIMEOUT_MS overridable);
    // fake/fixture: keep 4000ms for fast tests. This + post-wait poll for BOTH signals/file fixes real projcore planning (minutes) always blocking on 4s.
    const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    const PLANNING_TIMEOUT_MS = parseInt(process.env.HELM_PLANNING_TIMEOUT_MS || (isFake ? '4000' : '600000'), 10);
    // A11 (R1.6 + D7): the agreement gate's bounded-exit budget is now expressed in project-configurable
    // "rounds" of the existing per-round window (default roundCap=3, so the effective budget is 3x the
    // window above) — exhausting it is D7's "round cap exhausted", the SAME mechanism as R1.6's timeout.
    // Only the whole-plan agreement wait (waitForAgreement) is scaled; the canonical-doc-write poll
    // below is a separate wait (plancore finishing its write after agreement) and is untouched.
    const roundCap = Math.max(1, Math.trunc(inputs.roundCap ?? 3) || 3);

    await this.ensureDir('prompts', runDir);
    await this.ensureDir('', runDir);
    await fs.mkdir(canonicalArtifactRoot, { recursive: true });

    // Discovery's canonical file is authoritative. Only seed it from the input when it does not exist.
    const nsPath = path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.northStar);
    let effectiveNorthStar = inputs.northStar;
    try {
      effectiveNorthStar = await fs.readFile(nsPath, 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      await this.writeFileSafe(nsPath, inputs.northStar);
    }

    const convPath = path.join(canonicalArtifactRoot, 'conversation-log.md');
    let effectiveConversationLog = inputs.conversationLog;
    try {
      effectiveConversationLog = await fs.readFile(convPath, 'utf8');
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
      if (inputs.conversationLog) await this.writeFileSafe(convPath, inputs.conversationLog);
    }

    // Determine partner (auto logic per brief + projcore def)
    const partner = mode === 'auto'
      ? selectCoPlannerMode(effectiveNorthStar, inputs.autoSignals)
      : (mode as 'planner' | 'deliberation');

    // A9 (N11): source the consensus policy from teams.consensus_rule (unanimous + round cap) rather
    // than a hardcoded constant — "wire it or delete it" for D1/D7's two locked clauses. This run's
    // gate below already requires BOTH seats to agree (unanimous, by construction); maxRounds is
    // exposed here for A11 (round-cap-exceeded BLOCKED), which owns enforcement, not this row.
    const consensusPolicy = this.resolveConsensusPolicy();
    console.log(
      `[planning-phase] consensus policy for batch ${batchId} (mode=${partner}): ` +
      `unanimous=${consensusPolicy.unanimous} maxRounds=${consensusPolicy.maxRounds} (source: teams.consensus_rule; settle-role clause not wired)`
    );

    // Generate contract-compliant planning brief via BriefWriter (projcore role gets its own enum + full v2 sections + streaming/helper/paths etc).
    // This fixes the live POST /runs 400 BRIEF-CONTRACT-MISSING for the planning (projcore) brief under real dispatch/RealTransport.
    const briefWriter = new BriefWriterService();
    const effectiveProjectDir = inputs.projectDir || process.cwd();
    // A12 / R1.7: pass D7 config-sourced planning_round_cap into the brief (no open-ended "iterate").
    let planningBrief = briefWriter.generatePlanningBrief({
      batchId,
      northStar: effectiveNorthStar,
      conversationLog: effectiveConversationLog,
      mode: partner,
      projectDir: effectiveProjectDir,
      callbacksFile: path.join(runDir, 'callbacks.md'),
      runDir,
      canonicalArtifactRoot,
      planningRoundCap: roundCap,
    });
    // A12: persist the planning brief immediately so the contract is on disk before plancore cold-spawn
    // (which can take minutes). Dispatch-nonce rebind rewrites the same path after spawn.
    try {
      await this.artifacts.writeBrief(runDir, 'plancore', planningBrief);
    } catch { /* best-effort early write; post-spawn write remains below */ }

    // A15: hoist seat runtime ids so phase exit can finalize both (A1 only finalized plancore on retry).
    // A10: partner seats are now N (>= 0), one runtime id per spawned partner.
    let plancoreRuntimeId: number | null = null;
    const partnerRuntimeIds: (number | null)[] = [];
    // A5 (AC5/AC23): retain each seat's transport handle too — the runtime id alone finalizes the DB
    // row, but never reaps the live transport session. A normal terminal exit (agreed or blocked) must
    // reap before it finalizes, or the session leaks and can poison a retry. plancoreHandle tracks only
    // the LAST successful spawn attempt; an earlier failed-attempt handle is already reaped in-loop below.
    let plancoreHandle: string | null = null;
    const partnerHandles: string[] = [];

    // A6 (AC5/AC23): ONE terminal owner for this call. Success, blocked, AND thrown planning exits all
    // route through this same reap-then-finalize routine (A5 order preserved: every retained handle is
    // reaped before any worker_runtimes row is finalized) instead of each exit duplicating its own
    // cleanup — the prior asymmetry where only the pre-partner-spawn spawn-retry throw had any cleanup
    // at all, while every later thrown exit (after partner seats exist) had none. terminalReason /
    // terminalState are set by whichever exit is actually taken; the catch below's default covers any
    // exception this try region raises, so a thrown exit can no longer bypass reap+finalize. Both
    // reapPlanningHandle and finalizeWorkerRuntime are already best-effort/never-throw/idempotent, so
    // this owner itself can never throw and never masks the real error.
    let terminalReason = 'planning-thrown-exit';
    let terminalState: 'done' | 'reaped' | 'failed' = 'failed';
    const runPlanningTerminal = async (): Promise<void> => {
      await this.reapPlanningHandle(plancoreHandle, terminalReason);
      for (const h of partnerHandles) await this.reapPlanningHandle(h, terminalReason);
      this.finalizeWorkerRuntime(plancoreRuntimeId, terminalState, terminalReason);
      for (const id of partnerRuntimeIds) this.finalizeWorkerRuntime(id, terminalState, terminalReason);
    };

    try {
    // POCFIX20: projcore spawn-retry. Helm's claude spawn is intermittently flaky (empty pane / brief never
    // lands → no plan → dead run), while grok's is reliable; root cause is a hard-to-pin spawn timing/race.
    // Cause-agnostic robustness: if projcore emits NO callback within a window, reap + respawn (up to 3x).
    // Real path only (fake/test short-circuits to a single spawn so existing tests are unchanged).
    {
      const isFakeP = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
      const maxSpawnAttempts = isFakeP ? 1 : 3;
      const firstCbWindowMs = isFakeP ? 0 : clampedPlanningMs('HELM_CB_FIRST_CALLBACK_MS', 120_000, 5_000, 5 * 60_000);
      const cbPath = path.join(runDir, 'callbacks.md');
      let lastDispatchBrief = planningBrief;
      for (let attempt = 1; attempt <= maxSpawnAttempts; attempt++) {
        let dispatchOffset = 0;
        try { dispatchOffset = (await fs.stat(cbPath)).size; } catch {}
        const dispatchNonce = createDispatchNonce();
        const dispatchBrief = bindDispatchNonce(planningBrief, dispatchNonce);
        lastDispatchBrief = dispatchBrief;
        // The concrete seat is phase-owned (`plancore`). The brief/callback face intentionally
        // remains the existing helm_pm/projcore compatibility seam so no raw role token reaches
        // the model and callback ingest remains backward-compatible.
        const spawned = await this.transport.spawn({ role: brainRole, brief: dispatchBrief, runDir, batchId, sessionName: inputs.sessionName, model: inputs.planningBrainModel, provider: inputs.planningBrainProvider, attemptId: 0, projectDir: effectiveProjectDir, projectId: inputs.projectId, runId: inputs.runId, ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}) });  // B-ISO1 + A2: projectId/runId → helm_sessions via createSession
        // A1 (R4.16): record this plancore seat so it is DB-observable with run+cycle linkage.
        plancoreRuntimeId = this.registerWorkerRuntime(inputs.projectId, inputs.runId, brainRole, batchId, spawned.handle, inputs.planningBrainProvider, inputs.planningBrainModel);
        // A5: latest surviving spawn's handle — overwritten every attempt (a failed attempt's own
        // handle is reaped inline just below, before the loop moves on).
        plancoreHandle = spawned.handle;
        if (isFakeP) break;
        // R8: pass the live handle+brief so the first-callback wait can watchdog a brief that is
        // still sitting un-submitted in the composer (variable codex Enter-drop window) instead of
        // burning the whole window and respawning.
        const first = await this.waitForFirstCallback(cbPath, brainRole, batchId, firstCbWindowMs, dispatchOffset, {
          handle: spawned.handle,
          brief: dispatchBrief,
          provider: inputs.planningBrainProvider ?? 'grok',
          runId: inputs.runId,
        });
        if (first.ok) break;
        try { await this.transport.reap(spawned.handle, `${brainRole}-${first.reason}-reaped`); } catch {}
        this.finalizeWorkerRuntime(plancoreRuntimeId, 'reaped', `${first.reason}-reaped`);
        if (attempt === maxSpawnAttempts) {
          throw new Error(`planning ${first.reason}: ${brainRole} emitted no first callback after ${maxSpawnAttempts} spawn attempts`);
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      planningBrief = lastDispatchBrief;
    }

    // Always persist the plancore brief so prompts/plancore.brief.md exists on both planner and
    // deliberation paths.
    await this.artifacts.writeBrief(runDir, 'plancore', planningBrief);

    // Fixture drive: simulate the exchange + agreement (tests append real [helm callback] lines + sleep).
    // The phase "blocks" here in real waits; in fixture the caller (test) drives the callbacks.md to PLAN-READY.
    // We simulate a minimal agree handshake by expecting the final state.
    const cbPath = path.join(runDir, 'callbacks.md');
    // (In real usage the projcore/partner workers append; here tests control timing.)

    // B5 (AC7/AC23): planMdPath is hoisted here (before the review round runs) so it can be passed BOTH
    // as the race-guard path param (BROKEN-vs-not-yet-written guard) and as currentPlanPath (CLEAN-vs-
    // current-bytes SHA binding) inside runReviewRound below, and reused again by the canonical
    // read/ingest further down this function.
    const planMdPath = path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.plan);

    // C2 (AC11): the partner-spawn loop (A8/A10/S06/CONVENE-RACE-FIX) and the single waitForAgreement
    // call now live in runReviewRound (planning-review-round.ts) — pure seam extraction, no semantic
    // change. runPlanningPhase remains the owner of plancore spawn (above), canonical plan
    // polling/read/ingest and terminalization (below). waitForAgreement itself (and its parser helpers)
    // stays put on this class, untouched — B3/B4/B5's direct unit tests call it here — and is handed to
    // the seam already bound. partnerHandles/partnerRuntimeIds are the SAME arrays the terminal owner
    // (runPlanningTerminal) already closes over, passed in and mutated in place so a spawn that throws
    // mid-loop still leaves every already-spawned seat reapable/finalizable (A5/A6), even though the
    // throw itself propagates out of runReviewRound before it can return a result.
    const { agreed, partnerBatchIds, blockedReason, blockedReasonKind, roundsAttempted } = await runReviewRound({
      transport: this.transport,
      briefWriter,
      writeBrief: (role, content) => this.artifacts.writeBrief(runDir, role, content),
      registerWorkerRuntime: (role, correlationId, handle, provider, model) =>
        this.registerWorkerRuntime(inputs.projectId, inputs.runId, role, correlationId, handle, provider, model),
      waitForAgreement: this.waitForAgreement.bind(this),
      runDir,
      batchId,
      brainRole,
      partner,
      effectiveProjectDir,
      cbPath,
      planMdPath,
      perRoundTimeoutMs: PLANNING_TIMEOUT_MS,
      roundCap,
      agreementFenceOffset,
      isFake,
      panelSize: inputs.panelSize,
      coPlannerSeats: inputs.coPlannerSeats,
      partnerModel: inputs.partnerModel,
      partnerProvider: inputs.partnerProvider,
      projectId: inputs.projectId,
      runId: inputs.runId,
      strictReadAllow: inputs.strictReadAllow,
      partnerHandles,
      partnerRuntimeIds,
    });

    const planJsonPath = path.join(runDir, 'plan.json');
    const reqPath = path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.requirements);

    // B6 (AC9): check non-agreement BEFORE any canonical-plan polling/read/ingest. A `false` result
    // here can mean round-cap exhaustion, a confirmed BROKEN verdict, or (B5) a current-plan-SHA
    // mismatch — whatever the cause, it is a planning-agreement outcome, not a plan-read outcome, so
    // it must never fall through into the poll/read block below (which can itself throw a
    // PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN error and mask the real, mechanism-level reason).
    if (!agreed) {
      // Gate blocked — do not ingest or hand off.
      // A6: route through the one terminal owner — reason/state feed runPlanningTerminal(), which the
      // finally below runs (reap BEFORE finalize, same A5 order as every other exit).
      terminalReason = 'planning-not-agreed';
      terminalState = 'reaped';
      await this.advanceAgreementFence(runDir, batchId, path.join(runDir, 'callbacks.md'));
      return {
        agreed: false,
        coPlannerUsed: partner,
        northStarPath: nsPath,
        reqPath,
        planJsonPath,
        planMdPath,
        // B6: no canonical-plan read is attempted on the blocked path, so there is no ingested plan
        // to return — an empty task list, never a stale/partial read of a plan that was not agreed.
        plan: { tasks: [] },
        createdTaskIds: [],
        keyToId: {},
        runId: 0,
        blockedReason,
        blockedReasonKind,
        roundsAttempted
      };
    }

    // Short grace for plancore to flush canonical documents before the PLAN-READY callback is consumed.
    await new Promise((r) => setTimeout(r, 120));

    const readCanonicalPlan = async (): Promise<{ markdown: string; plan: Plan }> => {
      const markdown = await fs.readFile(planMdPath, 'utf8');
      const parsed = validateExecutionPlan(markdown);
      if (!parsed.ok) throw new Error(parsed.errors.join('; '));
      return { markdown, plan: { tasks: parsed.normalizedTasks as unknown as PlannedTask[] } };
    };

    // Real planning requires both canonical authored documents. plan.json is deliberately not accepted as
    // the authored contract here; it is derived only after plan.md validates and the agreement gate passes.
    if (!isFake) {
      const pollStart = Date.now();
      while (Date.now() - pollStart < PLANNING_TIMEOUT_MS) {
        try {
          await fs.access(reqPath);
          await readCanonicalPlan();
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }

    // Fake transport may synthesize a representative canonical document. A pre-seeded plan.json remains
    // a read-only test/cache compatibility input, but it is immediately rendered into canonical plan.md.
    let plan: Plan;
    let planMarkdown: string;
    try {
      if (!isFake) await fs.access(reqPath);
      const canonical = await readCanonicalPlan();
      plan = canonical.plan;
      planMarkdown = canonical.markdown;
    } catch (e) {
      if (isFake) {
        try {
          plan = this.parser.parsePlanFromJson(await fs.readFile(planJsonPath, 'utf8'));
        } catch {
          plan = {
            tasks: [
              { task_key: 'P1', atomic_work: 'Bootstrap the planning parser + types from approved plan schema', complexity: 'med', model: 'claude-sonnet', recommended_model: 'claude-sonnet', effort: 'med', needs_more_info: false, task_type: 'feature', validation_criteria: 'parser roundtrips all fields + deps into run_tasks; queue orders correctly', deps: [] },
              { task_key: 'P2', atomic_work: 'Implement planning-phase orchestration + co-planner gate + auto pick', complexity: 'high', recommended_model: 'codex-5.5', effort: 'high', needs_more_info: false, task_type: 'feature', validation_criteria: 'auto selects planner for simple north-star; deliberation for cross-cutting; gate blocks handoff until PLAN-READY + partner agree', deps: ['P1'] }
            ],
            meta: { source: 'planning-phase-fixture' }
          };
        }
        const canonicalTasks = plan.tasks.map((task, index) => ({
          id: task.task_key,
          batch: String((task as any).batch || 'default'),
          title: task.atomic_work,
          req_refs: Array.isArray((task as any).req_refs) ? (task as any).req_refs : [`P-${index + 1}`],
          assignee: (task as any).recommended_rung != null
            ? `L${Number((task as any).recommended_rung) + 1}`
            : (task as any).recommended_model || (task as any).model || 'L1',
          validator_lane: (task as any).validator_rung != null
            ? `L${Number((task as any).validator_rung) + 1}`
            : (task as any).validator_model || 'L1',
          effort: task.effort || task.complexity,
          type: task.task_type,
          deps: task.deps || [],
          validation_criteria: task.validation_criteria,
          user_critical: Boolean((task as any).user_critical),
          ...((task as any).redteam != null ? { redteam: (task as any).redteam } : {}),
          ...((task as any).exception_handling != null ? { exception_handling: (task as any).exception_handling } : {}),
        }));
        planMarkdown = `# Plan\n\n\`\`\`json\n${JSON.stringify(canonicalTasks, null, 2)}\n\`\`\`\n`;
        await this.writeFileSafe(planMdPath, planMarkdown);
        try { await fs.access(reqPath); } catch {
          await this.writeFileSafe(reqPath, `# Requirements\n\n${canonicalTasks.map((task) => `- **${task.req_refs[0]}** — ${task.title}`).join('\n')}\n`);
        }
        const canonical = await readCanonicalPlan();
        plan = canonical.plan;
        planMarkdown = canonical.markdown;
      } else {
        const errMsg = `[${batchId}] PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN: plancore must write valid ${reqPath} then ${planMdPath} before PLAN-READY. plan.json is Helm-derived and is not an authored fallback. ${(e as Error).message || e}`;
        throw new Error(errMsg);
      }
    }

    // Gate passed: snapshot the one canonical set into runDir for implementation consumers, then
    // derive plan.json while ingesting that exact canonical plan.md.
    await materializeCanonicalArtifactSet(canonicalArtifactRoot, runDir);
    const rid = inputs.runId ?? this.artifacts.createRun(inputs.projectId ?? null, batchId, nsPath);
    const { createdTaskIds, keyToId } = await this.parser.ingestExecutionPlan(rid, planMarkdown, this.queue, runDir);

    // A13 (R1.29 reconvene half): AFTER the whole-plan gate (A9's scope half, untouched above), scan
    // for per-task ACCEPT/AMEND/ESCALATE verdicts and convene the pair ONLY for a genuine conflict —
    // never a default per-task loop, never re-opening the already-passed whole-plan gate.
    const taskKeys = plan.tasks.map((t) => t.task_key);
    const { plancore: plancoreTaskVerdicts, partner: partnerTaskVerdicts } = await this.collectTaskVerdicts(
      cbPath, batchId, partnerBatchIds, brainRole, partner, agreementFenceOffset
    );
    const taskConflicts = detectTaskReconveneConflicts(taskKeys, plancoreTaskVerdicts, partnerTaskVerdicts);
    const reconvenedTaskKeys = taskConflicts.length
      ? await this.reconveneConflictingTasks(taskConflicts, batchId, partner, runDir, effectiveProjectDir, briefWriter, rid, this.resolveCycleId(rid), inputs)
      : [];

    // A6: route through the one terminal owner — same reason/state pattern as the blocked exit, same
    // A5 reap-before-finalize order, run by the finally below (orchestrator also finalizes at
    // planning-done-yield; idempotent).
    terminalReason = 'planning-phase-complete';
    terminalState = 'done';
    await this.advanceAgreementFence(runDir, batchId, path.join(runDir, 'callbacks.md'));

    return {
      agreed: true,
      coPlannerUsed: partner,
      northStarPath: nsPath,
      reqPath,
      planJsonPath,
      planMdPath,
      plan,
      createdTaskIds,
      keyToId,
      runId: rid,
      reconvenedTaskKeys
    };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      terminalReason = `planning-thrown-exit: ${msg}`;
      terminalState = 'failed';
      throw err;
    } finally {
      await runPlanningTerminal();
    }
  }

  // POCFIX20: poll for the agent's FIRST callback (any STATUS) — proves the brief landed + the agent is alive.
  // Accepts both [helm callback] and [projcore callback] prefixes. Used to detect a dead/empty spawn for retry.
  private async waitForFirstCallback(
    cbPath: string,
    role: string,
    batchId: string,
    timeoutMs: number,
    sinceOffset: number,
    watchdog?: { handle: string; brief: string; provider: string; runId?: number }
  ): Promise<{ ok: boolean; reason: 'callback' | 'session-gone' | 'no-first-callback' }> {
    const start = Date.now();
    // R8 submit watchdog (see orchestrator-loop waitForCallback): ~30s cadence; first not-held
    // observation disables it (a cleared composer can never re-hold the text). Loud logs.
    const WD_EVERY_MS = clampedPlanningMs('HELM_SUBMIT_WD_MS', 30_000, 1_000, 120_000);
    const WD_MAX_PRESSES = Math.trunc(clampedPlanningMs('HELM_SUBMIT_WD_MAX', 10, 1, 50));
    const COMPOSER_HELD_MAX_MS = clampedPlanningMs('HELM_CB_COMPOSER_HELD_MAX_MS', 5 * 60_000, 5_000, 10 * 60_000);
    const PANE_PROBE_MS = clampedPlanningMs('HELM_CB_PANE_PROBE_MS', 2_000, 250, 10_000);
    let wdDone = !watchdog;
    let wdPresses = 0;
    let lastWdProbeAt = Date.now();
    let lastPaneProbeAt = Number.NEGATIVE_INFINITY;
    let lastPaneHash: string | null = null;
    let lastPaneChangeAt = start;
    let paneChangeCount = 0;
    let idlePrompt = false;
    let generating = false;
    let composerHeld = false;
    const record = (outcome: 'callback' | 'reap', reason: string, now = Date.now()): void => {
      if (!watchdog?.runId) return;
      this.artifacts.recordRunEvent(watchdog.runId, 'CALLBACK_WAIT_RESULT', {
        outcome,
        reason,
        role,
        provider: watchdog.provider,
        handle: watchdog.handle,
        wait_ms: Math.max(0, now - start),
        first_callback_ms: outcome === 'callback' ? Math.max(0, now - start) : null,
        pane_change_count: paneChangeCount,
        last_pane_change_age_ms: lastPaneHash === null ? null : Math.max(0, now - lastPaneChangeAt),
        last_callback_age_ms: outcome === 'callback' ? 0 : null,
        idle_prompt: idlePrompt,
        generating,
        composer_held: composerHeld,
        nudge_sent: false,
      }, batchId);
    };
    while (true) {
      const now = Date.now();
      try {
        const raw = await fs.readFile(cbPath);
        const window = (sinceOffset > 0 ? raw.subarray(sinceOffset) : raw).toString('utf8');
        const matched = window.split(/\r?\n/).some((line) => {
          const parsed = parseCallbackLine(line);
          return !!parsed && parsed.batchId === batchId && roleMatches(role, parsed.role);
        });
        if (matched) {
          record('callback', 'callback', now);
          return { ok: true, reason: 'callback' };
        }
      } catch {}
      if (watchdog && this.transport.inspectSeat && now - lastPaneProbeAt >= PANE_PROBE_MS) {
        lastPaneProbeAt = now;
        const inspection = await this.transport.inspectSeat(watchdog.handle, watchdog.brief, watchdog.provider);
        if (!inspection.sessionAlive) {
          record('reap', 'session-gone', now);
          return { ok: false, reason: 'session-gone' };
        }
        const pane = classifySeatPane(watchdog.provider, inspection);
        idlePrompt = pane.idlePrompt;
        generating = pane.generating;
        composerHeld = pane.composerHeld;
        if (pane.hash !== null) {
          if (lastPaneHash !== null && lastPaneHash !== pane.hash) {
            paneChangeCount += 1;
            lastPaneChangeAt = now;
          }
          if (lastPaneHash === null) lastPaneChangeAt = now;
          lastPaneHash = pane.hash;
        }
      }
      if (!wdDone && now - lastWdProbeAt >= WD_EVERY_MS) {
        lastWdProbeAt = now;
        try {
          const pressed = await (this.transport as any).resubmitIfComposerHeld?.(watchdog!.handle, watchdog!.brief);
          if (pressed) {
            wdPresses += 1;
            console.warn(`[planning-phase] submit-watchdog target=${watchdog!.handle} composer still holds the ${role} brief → re-pressed Enter (${wdPresses}/${WD_MAX_PRESSES})`);
            if (wdPresses >= WD_MAX_PRESSES) {
              console.warn(`[planning-phase] submit-watchdog target=${watchdog!.handle} gave up after ${WD_MAX_PRESSES} Enter re-presses (composer still holds the ${role} brief)`);
              wdDone = true;
            }
          } else {
            if (wdPresses > 0) console.warn(`[planning-phase] submit-watchdog target=${watchdog!.handle} composer clear after ${wdPresses} re-press(es) — ${role} brief submitted`);
            wdDone = true;
          }
        } catch (e: any) {
          console.warn(`[planning-phase] submit-watchdog probe ERROR target=${watchdog!.handle}: ${e?.message || e}`);
          wdDone = true;
        }
      }
      const submitWatchdogOwnsComposer = composerHeld && !wdDone && now - start < COMPOSER_HELD_MAX_MS;
      if (!submitWatchdogOwnsComposer && now - start >= timeoutMs) {
        record('reap', 'no-first-callback', now);
        return { ok: false, reason: 'no-first-callback' };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // A9 (R1.4/R1.5/N4): local dual-prefix callback parser scoped to THIS function only. The shared
  // parseCallbackLine (agent-event-ingest.ts) is genuinely [helm callback]-only despite several nearby
  // comments elsewhere claiming otherwise (it is used unchanged by orchestrator-loop.ts, panel-service.ts,
  // waitForFirstCallback below, and run-orchestrator-service.ts's waitForNorthStarReady — broadening it
  // is a wider, separate fix outside this row's scope: "rewrite the partner matcher in waitForAgreement").
  // B3 (AC8): separator class widened from [—-] (em dash/hyphen only) to also accept en dash
  // and colon — agents use all four forms and a colon/en-dash line previously failed the whole
  // match, so the seat read as silent instead of failing closed. B3 (AC6 foundation): optional
  // planSha extracted from the note as additive data (plan-revision.ts's short12); B5 owns
  // enforcing it against the current plan.md bytes — B3 only parses it out when present.
  private parseAgreementCallbackLine(line: string): { role: string; batchId: string; state: string; note: string | null; planSha: string | null } | null {
    const match = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+([A-Z-]+)(?:\s+[\-—–:]\s+(.+))?\s*$/.exec(line);
    if (!match) return null;
    const note = match[4] ?? null;
    const planShaMatch = note ? /\bplan=([0-9a-f]{12})\b/.exec(note) : null;
    return { role: match[1], batchId: match[2], state: match[3], note, planSha: planShaMatch ? planShaMatch[1] : null };
  }

  // A9 send-back (attempt=2): byte-accurate window read (Buffer.subarray, not a char-slice) — callbacks.md
  // accumulates multi-byte UTF-8 (em-dashes in every note), so a char-offset read would drift against a
  // byte offset captured via fs.stat (same POCFIX22 lesson orchestrator-loop.ts already learned).
  private async readCallbacksWindow(cbPath: string, sinceOffset: number): Promise<string> {
    const buf = await fs.readFile(cbPath);
    return (sinceOffset > 0 ? buf.subarray(sinceOffset) : buf).toString('utf8');
  }

  // A13 (R1.29 reconvene half): per-task verdict lines are a SEPARATE STATUS token (TASK-VERDICT) from
  // the whole-plan PLAN-READY/VERDICT-READY signals A9 already owns — same [helm|projcore callback]
  // prefix + STATUS-token shape, so this reuses parseAgreementCallbackLine rather than a third parser.
  // Note payload format: "<task_key>: <ACCEPT|AMEND|ESCALATE>[: free-text reason]".
  private parseTaskVerdictLine(line: string): { role: string; batchId: string; taskKey: string; verdict: TaskVerdict; note: string } | null {
    const parsed = this.parseAgreementCallbackLine(line);
    if (!parsed || parsed.state !== 'TASK-VERDICT' || !parsed.note) return null;
    const m = /^\s*([^:]+):\s*(ACCEPT|AMEND|ESCALATE)\b(?:\s*:\s*(.*))?$/i.exec(parsed.note);
    if (!m) return null;
    return { role: parsed.role, batchId: parsed.batchId, taskKey: m[1].trim(), verdict: m[2].toUpperCase() as TaskVerdict, note: (m[3] || '').trim() };
  }

  // Scan callbacks.md (same fence-scoped window as the whole-plan gate) for each seat's LATEST
  // TASK-VERDICT per task_key (reversed scan — a later verdict can never be shadowed by an earlier
  // one, mirroring waitForAgreement's own latest-wins pattern). A task absent from a seat's map
  // defaults to ACCEPT in detectTaskReconveneConflicts — never fenced/blocked on here.
  private async collectTaskVerdicts(
    cbPath: string,
    batchId: string,
    partnerBatchIds: string[],
    brainRole: string,
    partnerRole: string,
    sinceOffset: number
  ): Promise<{ plancore: Map<string, { verdict: TaskVerdict; note: string }>; partner: Map<string, { verdict: TaskVerdict; note: string }> }> {
    const plancore = new Map<string, { verdict: TaskVerdict; note: string }>();
    const partner = new Map<string, { verdict: TaskVerdict; note: string }>();
    try {
      const raw = await this.readCallbacksWindow(cbPath, sinceOffset);
      const lines = raw.split(/\r?\n/).reverse();
      for (const line of lines) {
        const tv = this.parseTaskVerdictLine(line);
        if (!tv) continue;
        if (tv.batchId === batchId && roleMatches(brainRole, tv.role) && !plancore.has(tv.taskKey)) {
          plancore.set(tv.taskKey, { verdict: tv.verdict, note: tv.note });
        }
        if (partnerBatchIds.includes(tv.batchId) && roleMatches(partnerRole, tv.role) && !partner.has(tv.taskKey)) {
          partner.set(tv.taskKey, { verdict: tv.verdict, note: tv.note });
        }
      }
    } catch { /* no verdict lines yet — every task defaults to ACCEPT/ACCEPT, zero conflicts */ }
    return { plancore, partner };
  }

  private resolveCycleId(runId: number): number | null {
    try {
      const db = (this.artifacts as any)['db']?.raw;
      const row = db?.prepare('SELECT cycle_id FROM runs WHERE id = ?').get(runId) as { cycle_id: number | null } | undefined;
      return row?.cycle_id ?? null;
    } catch {
      return null;
    }
  }

  // A13: convene the pair for EACH conflicting task — spawn a fresh, task-scoped mini review seat
  // (mirrors the whole-plan partner spawn) and record a durable, auditable run_events row (run + cycle,
  // per the AC). Best-effort per conflict: a single convene failing to spawn/record must never retract
  // the already-agreed whole-plan handoff (D6: the reconvene path is a conflict-only ADDITION on top of
  // an already-passed gate, not a new blocking gate of its own — "do not build a default per-task
  // convene loop" applies equally to not inventing a second wait-for-resolution loop here).
  private async reconveneConflictingTasks(
    conflicts: TaskVerdictConflict[],
    batchId: string,
    partner: 'planner' | 'deliberation',
    runDir: string,
    effectiveProjectDir: string,
    briefWriter: BriefWriterService,
    runId: number,
    cycleId: number | null,
    inputs: PlanningInputs
  ): Promise<string[]> {
    const reconvened: string[] = [];
    for (const c of conflicts) {
      const safeKey = String(c.taskKey).replace(/[^A-Za-z0-9_.-]/g, '_');
      const reconveneBatchId = `${batchId}-reconvene-${safeKey}`;
      try {
        const brief = briefWriter.generatePanelBrief({
          role: partner,
          batchId: reconveneBatchId,
          seat: `reconvene-${safeKey}`,
          lens: 'per-task conflict resolution (D6 reconvene-on-conflict half)',
          requirement: `Task ${c.taskKey}: plancore verdict=${c.plancoreVerdict}, partner verdict=${c.partnerVerdict} (${c.reason}). Reconvene and resolve to a single agreed verdict for THIS task only — do not re-open the whole-plan gate.`,
          projectDir: effectiveProjectDir,
          callbacksFile: path.join(runDir, 'callbacks.md'),
        });
        await this.artifacts.writeBrief(runDir, `reconvene-${safeKey}`, brief);
        const spawned = await this.transport.spawn({ role: partner, brief, runDir, batchId: reconveneBatchId, model: inputs.partnerModel, provider: inputs.partnerProvider, attemptId: 0, projectDir: effectiveProjectDir, projectId: inputs.projectId, runId: inputs.runId, ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}) });
        this.registerWorkerRuntime(inputs.projectId, inputs.runId, partner, reconveneBatchId, spawned.handle, inputs.partnerProvider, inputs.partnerModel);
        this.artifacts.recordRunEvent(
          runId,
          'A13_TASK_RECONVENE',
          { task_key: c.taskKey, cycle_id: cycleId, trigger: c.reason, plancore_verdict: c.plancoreVerdict, partner_verdict: c.partnerVerdict },
          batchId
        );
        reconvened.push(c.taskKey);
      } catch { /* best-effort — one convene failing must never retract the already-agreed handoff */ }
    }
    return reconvened;
  }

  /**
   * Whole-plan agreement gate (D6/R1.29 scope half — exactly ONE gate per planning run; the per-task
   * reconvene-on-conflict half is A13's, not built here). Requires PLAN-READY plus a CLEAN verdict from
   * EVERY partner batch id in `partnerBatchIds` (N11 unanimous — a project configured for panelSize=3
   * spawns 2 partners, and BOTH must agree, not just one) in the SAME poll pass:
   * - projcore's PLAN-READY for this run's own batchId (brainRole).
   * - EACH partner's own VERDICT-READY for its namespaced batch id (R1.5/N3 — every partner is spawned
   *   under its own `${batchId}-partner[-N]` batch; a bare `batchId` equality matches nothing, dead-
   *   locking every run, and an unscoped match would accept a stale/foreign partner line from a
   *   different run). `partnerBatchIds` may be empty (A10: panelSize=1, solo planning) — PLAN-READY
   *   alone then satisfies the gate, since there is no partner to convene.
   * R1.4/N2: VERDICT-READY is the literal STATUS token for every verdict — the actual CLEAN/BROKEN
   * verdict lives in the note payload after the em-dash, never the token. A confirmed BROKEN from ANY
   * partner fails the gate FAST (returns false as soon as it's seen — dispositive on its own, it must
   * not wait out the full timeout, which is 600_000ms/10min in production).
   * A missing/unparseable verdict body is treated as "no verdict yet" (keeps waiting, fail-closed by
   * omission) rather than an immediate BROKEN, in case the payload is still being written mid-line.
   * Each poll re-derives the LATEST matching line per partner (reversed scan) rather than latching a
   * boolean forever, so a later BROKEN can never be shadowed by an earlier accidental CLEAN.
   * A9 send-back (attempt=2/3): `sinceOffset` fences every signal to lines appended after the PRIOR
   * runPlanningPhase call's own end for this (runDir, batchId) key (see the durable agreementFencePath
   * sidecar file / a first-ever call for a key is never fenced). runDir is deterministic per (projectId, batchId) and
   * callbacks.md is never truncated between attempts, so a restart/rerun reusing the same batchId can
   * otherwise leave an OLD VERDICT-READY CLEAN for the same partner batch id (or an old PLAN-READY)
   * sitting in the file — same-batch stale, not the different-batch/foreign case R1.5 alone closes. A
   * prior attempt's agreement must never satisfy a later one just because the batch id was reused.
   * B5 (AC7/AC23): a CLEAN verdict is no longer a bare enum — it must also carry a `plan=<sha12>`
   * (B3 grammar) matching the CURRENT plan.md bytes (B1's readPlanRevision), re-derived fresh on
   * EVERY poll pass via `currentPlanPath` (never cached at call-start), so a seat that reviewed an
   * earlier revision and never re-emits stays excluded even after plancore rewrites plan.md mid-wait.
   * A CLEAN with no `plan=`, a malformed SHA (B3 already nulls those), or a SHA for a superseded
   * revision does not count. `currentPlanPath` is additive/optional — omitted (as B3/B4's existing
   * direct unit tests do) falls back to the pre-B5 bare-enum CLEAN check, byte-identical behaviour.
   */
  private async waitForAgreement(
    cbPath: string,
    batchId: string,
    partnerRole: string,
    brainRole: string,
    timeoutMs: number,
    sinceOffset = 0,
    partnerBatchIds: string[] = [`${batchId}-partner`],
    /** Canonical plan.md. When given, a BROKEN verdict is not dispositive until this file exists
     *  and is non-empty — absence means plancore has not authored it yet, so no seat can have
     *  legitimately reviewed it. Omitted by existing callers/fixtures, which keep prior behaviour. */
    planMdPathForRaceGuard?: string,
    /** B5: canonical plan.md, read fresh every poll pass to bind each accepted CLEAN to the plan
     *  revision actually in effect right now. Deliberately a SEPARATE parameter from the race-guard
     *  path above (that one only ever proves existence for the BROKEN race guard; this one proves
     *  byte-identity for the CLEAN agreement gate) — additive/optional, omitted by B3/B4's existing
     *  direct unit tests, which keep their pre-B5 unbound-CLEAN behaviour. */
    currentPlanPath?: string
  ): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const raw = await this.readCallbacksWindow(cbPath, sinceOffset);
        const lines = raw.split(/\r?\n/).reverse(); // newest first
        let sawPlanReady = false;
        // B5: per-seat evidence is now {verdict, planSha} rather than a bare enum — planSha is the
        // plan=<sha12> parsed from that seat's own NEWEST VERDICT-READY note (null if absent/malformed).
        const verdicts = new Map<string, { verdict: 'CLEAN' | 'BROKEN'; planSha: string | null }>(); // partnerBatchId -> latest parsed evidence
        // B4 (AC8): tracks "have we already resolved this seat's NEWEST VERDICT-READY line", separate
        // from whether that line parsed to a valid verdict. Set on first encounter (reversed = newest
        // first) regardless of parse outcome, so a malformed newest line locks the seat out of `verdicts`
        // for this poll pass instead of letting the scan fall through to an older, stale CLEAN/BROKEN for
        // the same seat — that fallthrough was the stale-side fail-open this row fixes.
        const seenNewestVerdict = new Set<string>();
        for (const line of lines) {
          const parsed = this.parseAgreementCallbackLine(line);
          if (!parsed) continue;
          if (!sawPlanReady && parsed.batchId === batchId && parsed.state === 'PLAN-READY' && roleMatches(brainRole, parsed.role)) {
            sawPlanReady = true;
          }
          if (
            !seenNewestVerdict.has(parsed.batchId) &&
            partnerBatchIds.includes(parsed.batchId) &&
            parsed.state === 'VERDICT-READY' &&
            roleMatches(partnerRole, parsed.role)
          ) {
            seenNewestVerdict.add(parsed.batchId); // lock this seat to its NEWEST verdict line, parseable or not
            const verdictMatch = /^\s*(CLEAN|BROKEN)\b/i.exec(parsed.note || '');
            if (verdictMatch) {
              verdicts.set(parsed.batchId, { verdict: verdictMatch[1].toUpperCase() as 'CLEAN' | 'BROKEN', planSha: parsed.planSha });
            }
            // else: newest line for this seat is malformed/unparseable — fail closed. Leaving `verdicts`
            // unset for this batchId (rather than falling through to an older line) means the "every
            // partnerBatchId is CLEAN" pass check below can never be satisfied by stale evidence.
          }
          if (sawPlanReady && seenNewestVerdict.size === partnerBatchIds.length) break; // every seat's newest line already locked in (reversed scan)
        }
        // R1.4/N11 (unanimous): a confirmed BROKEN from ANY partner fails the gate immediately —
        // dispositive on its own, whether or not PLAN-READY or the other seats' verdicts have arrived
        // yet. It has already arrived and is negative, so there is nothing left to wait for (never
        // byte-identical to a silent CLEAN pass, and never forced to burn the full 10min production
        // timeout to reach the same conclusion).
        if ([...verdicts.values()].some((v) => v.verdict === 'BROKEN')) {
          // Race guard: a BROKEN cannot be a real plan defect if plan.md does not exist yet. Keep
          // waiting so the (brief-instructed) re-review can supersede it — the reversed scan already
          // takes each seat's LATEST verdict, so a later CLEAN legitimately replaces this one. The
          // outer timeout still bounds the wait, so a seat that never re-emits still fails, just not
          // instantly and not on evidence it could not have had.
          let planPresent = true;
          if (planMdPathForRaceGuard) {
            try {
              planPresent = (await fs.stat(planMdPathForRaceGuard)).size > 0;
            } catch {
              planPresent = false;
            }
          }
          if (planPresent) return false;
        } else if (sawPlanReady) {
          // B5 (AC7/AC23): re-derive the CURRENT plan.md revision on THIS poll pass — never cached at
          // call-start — so a plancore rewrite mid-wait (a partner CLEAN'd R1, plan.md is now R2) is
          // reflected immediately. `currentPlanPath` omitted (B3/B4's direct unit tests) => currentShort12
          // stays null and the sha check is skipped entirely (pre-B5 bare-enum behaviour, untouched).
          const currentShort12 = currentPlanPath ? readPlanRevision(currentPlanPath)?.short12 ?? null : null;
          const allAgreed = partnerBatchIds.every((id) => {
            const v = verdicts.get(id);
            if (!v || v.verdict !== 'CLEAN') return false;
            if (!currentPlanPath) return true; // legacy: no plan revision to bind against
            // If the current plan is absent/unreadable, this is not a non-convergence outcome: the seats
            // have signaled agreement, but the canonical plan contract is invalid. Let the caller's
            // canonical read fail on the thrown path so A6 cleanup/finalization still owns that terminal
            // class. No stale plan can be handed off because the read below must succeed before ingest.
            if (currentShort12 === null) return true;
            // Fail closed: missing plan=, malformed SHA (already null from B3's parser), or a SHA
            // for a superseded revision (present but !== the live short12) all fall through here —
            // none of them count as agreement on the plan revision actually in effect right now.
            return v.planSha !== null && v.planSha === currentShort12;
          });
          if (allAgreed) return true;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    // A8 (R1.2) still holds: a timeout with no confirmed unanimous CLEAN agreement is a bounded stall,
    // never a silent pass — return false so the caller's existing agreed:false path (reap seats, no
    // ingest) takes over instead of proceeding on PLAN-READY alone.
    return false;
  }
}
