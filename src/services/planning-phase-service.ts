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
  runId?: number;              // D-b1: if provided (interview path pre-created the run), reuse for ingest instead of createRun
  strictReadAllow?: string[];  // B-ISO1 (sol wiring review fix #4): run-scoped opt-in strict read allowlist, threaded from RunOrchestrator to the projcore + partner planning seats. undefined => read-all (unchanged).
  adaptivePlanning?: boolean;  // v92: project.adaptive_planning — when true, runPlanningPhase delegates to the adaptive tiered planner module. Default/undefined => existing single-author path.
  /** v93: per-project adaptive planner panel (size / lead / members / backups / default effort). */
  panel?: import('./adaptive-planning-phase.js').PlannerPanel;
  /** v93: optional availability probe for backup fallback (seat-binary). */
  isModelAvailable?: (provider: string, model: string) => boolean | Promise<boolean>;
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
}

export function selectCoPlannerMode(
  northStar: string,
  signals: { isCrossCutting?: boolean; isAmbiguous?: boolean; isHighRisk?: boolean } = {}
): 'planner' | 'deliberation' {
  if (signals.isCrossCutting || signals.isAmbiguous || signals.isHighRisk) return 'deliberation';
  const t = (northStar || '').toLowerCase();
  if (/cross.?module|schema|arch|ambiguous|multiple (viable|approach)|security|high.?risk/.test(t)) {
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

    // POCFIX8 (B): compute timeout early (after batchId/mode). Real !fake path: long ~10min default (env HELM_PLANNING_TIMEOUT_MS overridable);
    // fake/fixture: keep 4000ms for fast tests. This + post-wait poll for BOTH signals/file fixes real projcore planning (minutes) always blocking on 4s.
    const isFake = process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
    const PLANNING_TIMEOUT_MS = parseInt(process.env.HELM_PLANNING_TIMEOUT_MS || (isFake ? '4000' : '600000'), 10);

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
    let planningBrief = briefWriter.generatePlanningBrief({
      batchId,
      northStar: effectiveNorthStar,
      conversationLog: effectiveConversationLog,
      mode: partner,
      projectDir: effectiveProjectDir,
      callbacksFile: path.join(runDir, 'callbacks.md'),
      runDir,
      canonicalArtifactRoot,
    });

    // A15: hoist seat runtime ids so phase exit can finalize both (A1 only finalized plancore on retry).
    let plancoreRuntimeId: number | null = null;
    let partnerRuntimeId: number | null = null;

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

    // A8 (R1.2): a planning run always convenes a partner — 'planner' selects a single co-reviewer,
    // 'deliberation' a cross-cutting review, but neither mode skips the partner (D1). Default-config
    // planning therefore always spawns exactly 2 seats (plancore + partner).
    const partnerBrief = briefWriter.generatePanelBrief({
      role: partner,
      batchId: `${batchId}-partner`,
      seat: 'partner',
      lens: 'plan atomicity, deps, fields, complexity/recommended_model, validation_criteria',
      requirement: 'Review canonical plan.md and north-star.md. Pressure-test atomicity, deps, fields, complexity/recommended_model. Return agreement or concrete gaps.',
      projectDir: effectiveProjectDir,
      callbacksFile: path.join(runDir, 'callbacks.md'),
    });
    await this.artifacts.writeBrief(runDir, partner, partnerBrief);
    const partnerSpawned = await this.transport.spawn({ role: partner, brief: partnerBrief, runDir, batchId: `${batchId}-partner`, model: inputs.partnerModel, provider: inputs.partnerProvider, attemptId: 0, projectDir: effectiveProjectDir, projectId: inputs.projectId, runId: inputs.runId, ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}) });  // B-ISO1 + A2: projectId/runId → helm_sessions via createSession
    // A1 (R4.16): record the partner seat so it is DB-observable with run+cycle linkage.
    partnerRuntimeId = this.registerWorkerRuntime(inputs.projectId, inputs.runId, partner, `${batchId}-partner`, partnerSpawned.handle, inputs.partnerProvider, inputs.partnerModel);

    // Fixture drive: simulate the exchange + agreement (tests append real [helm callback] lines + sleep).
    // The phase "blocks" here in real waits; in fixture the caller (test) drives the callbacks.md to PLAN-READY.
    // We simulate a minimal agree handshake by expecting the final state.
    const cbPath = path.join(runDir, 'callbacks.md');
    // (In real usage the projcore/partner workers append; here tests control timing.)

    // POCFIX8 (B): long timeout on real !USE_FAKE_TMUX (projcore needs minutes to think, write the canonical docs, and emit PLAN-READY); fast 4s preserved under fixture.
    // A8 (R1.2): waitForAgreement requires BOTH the partner agreement signal AND projcore PLAN-READY in
    // every mode — 'planner' no longer fast-paths on PLAN-READY alone. real path adds explicit file poll
    // below for BOTH before ingest.
    const agreed = await this.waitForAgreement(cbPath, batchId, partner, brainRole, PLANNING_TIMEOUT_MS);

    // Short grace for plancore to flush canonical documents before the PLAN-READY callback is consumed.
    await new Promise((r) => setTimeout(r, 120));

    const planJsonPath = path.join(runDir, 'plan.json');
    const planMdPath = path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.plan);
    const reqPath = path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.requirements);

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

    if (!agreed) {
      // Gate blocked — do not ingest or hand off.
      // A15: finalize planning seats so they do not stick as running after a failed gate.
      this.finalizeWorkerRuntime(plancoreRuntimeId, 'reaped', 'planning-not-agreed');
      this.finalizeWorkerRuntime(partnerRuntimeId, 'reaped', 'planning-not-agreed');
      return {
        agreed: false,
        coPlannerUsed: partner,
        northStarPath: nsPath,
        reqPath,
        planJsonPath,
        planMdPath,
        plan,
        createdTaskIds: [],
        keyToId: {},
        runId: 0
      };
    }

    // Gate passed: snapshot the one canonical set into runDir for implementation consumers, then
    // derive plan.json while ingesting that exact canonical plan.md.
    await materializeCanonicalArtifactSet(canonicalArtifactRoot, runDir);
    const rid = inputs.runId ?? this.artifacts.createRun(inputs.projectId ?? null, batchId, nsPath);
    const { createdTaskIds, keyToId } = await this.parser.ingestExecutionPlan(rid, planMarkdown, this.queue, runDir);

    // A15: planning phase exit (success) — mark seats done. Orchestrator also finalizes at
    // planning-done-yield (idempotent). Partner no longer depends on the generic janitor alone.
    this.finalizeWorkerRuntime(plancoreRuntimeId, 'done', 'planning-phase-complete');
    this.finalizeWorkerRuntime(partnerRuntimeId, 'done', 'planning-phase-complete');

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
      runId: rid
    };
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
  private parseAgreementCallbackLine(line: string): { role: string; batchId: string; state: string; note: string | null } | null {
    const match = /^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+([A-Z-]+)(?:\s+[—-]\s+(.+))?\s*$/.exec(line);
    if (!match) return null;
    return { role: match[1], batchId: match[2], state: match[3], note: match[4] ?? null };
  }

  /**
   * Whole-plan agreement gate (D6/R1.29 scope half — exactly ONE gate per planning run; the per-task
   * reconvene-on-conflict half is A13's, not built here). Requires BOTH signals in the SAME poll pass:
   * - projcore's PLAN-READY for this run's own batchId (brainRole).
   * - the partner's own VERDICT-READY for `${batchId}-partner` (R1.5/N3 — the partner is spawned under
   *   its own namespaced batch; a bare `batchId` equality matches nothing, dead-locking every run, and an
   *   unscoped match would accept a stale/foreign partner line from a different run).
   * R1.4/N2: VERDICT-READY is the literal STATUS token for BOTH verdicts — the actual CLEAN/BROKEN
   * verdict lives in the note payload after the em-dash, never the token. Only a note that resolves to
   * CLEAN satisfies the gate; a confirmed BROKEN verdict fails it FAST (returns false as soon as it's
   * seen — it must not wait out the full timeout, which is 600_000ms/10min in production: the verdict
   * has already arrived and is negative, there is nothing left to wait for under this row's scope).
   * A missing/unparseable verdict body is treated as "no verdict yet" (keeps waiting, fail-closed by
   * omission) rather than an immediate BROKEN, in case the payload is still being written mid-line.
   * Each poll re-derives the LATEST matching line for each signal (reversed scan) rather than latching a
   * boolean forever, so a later BROKEN can never be shadowed by an earlier accidental CLEAN.
   */
  private async waitForAgreement(cbPath: string, batchId: string, partnerRole: string, brainRole: string, timeoutMs: number): Promise<boolean> {
    const start = Date.now();
    const partnerBatchId = `${batchId}-partner`;
    while (Date.now() - start < timeoutMs) {
      try {
        const raw = await fs.readFile(cbPath, 'utf8');
        const lines = raw.split(/\r?\n/).reverse(); // newest first
        let sawPlanReady = false;
        let partnerVerdict: 'CLEAN' | 'BROKEN' | null = null;
        for (const line of lines) {
          const parsed = this.parseAgreementCallbackLine(line);
          if (!parsed) continue;
          if (!sawPlanReady && parsed.batchId === batchId && parsed.state === 'PLAN-READY' && roleMatches(brainRole, parsed.role)) {
            sawPlanReady = true;
          }
          if (
            partnerVerdict === null &&
            parsed.batchId === partnerBatchId &&
            parsed.state === 'VERDICT-READY' &&
            roleMatches(partnerRole, parsed.role)
          ) {
            const verdictMatch = /^\s*(CLEAN|BROKEN)\b/i.exec(parsed.note || '');
            partnerVerdict = verdictMatch ? (verdictMatch[1].toUpperCase() as 'CLEAN' | 'BROKEN') : null;
          }
          if (sawPlanReady && partnerVerdict !== null) break; // latest of each already locked in (reversed scan)
        }
        if (sawPlanReady && partnerVerdict === 'CLEAN') return true;
        // R1.4: a confirmed BROKEN verdict fails the gate immediately — dispositive on its own, whether
        // or not PLAN-READY has arrived yet. It has already arrived and is negative, so there is nothing
        // left to wait for (never byte-identical to a silent CLEAN pass, and never forced to burn the
        // full 10min production timeout to reach the same conclusion).
        if (partnerVerdict === 'BROKEN') return false;
      } catch {}
      await new Promise((r) => setTimeout(r, 20));
    }
    // A8 (R1.2) still holds: a timeout with no confirmed CLEAN partner agreement is a bounded stall,
    // never a silent pass — return false so the caller's existing agreed:false path (reap seats, no
    // ingest) takes over instead of proceeding on PLAN-READY alone.
    return false;
  }
}
