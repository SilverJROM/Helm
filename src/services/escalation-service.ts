import { DatabaseService } from '../db/database.js';
import { PROVIDERS } from '../config/providers.js';
import type { AgentAssignmentService } from './agent-assignment-service.js';
import { parseBrainVerdict } from './plan-schema.js';

export interface LedgerEntry {
  attempt: number;
  rung: number;
  brief_path: string | null;
  model: string;
  validator_diagnosis: string | null;
  failed_gates?: string[] | null;
  evidence?: string | null;
  diff_summary?: string | null;
  preserved_changes?: string | null;
  ts?: string;
}

export type ValidatorEscalateAction = 'revalidate' | 'override';

export interface Decision {
  action:
    | 'bump-rung'
    | 'validator-handholding'
    | 're-brief'
    | 'deliberation'
    | 'escalate-to-JROM'
    | 're-plan'
    | 'escalate-validator';
  targetRung?: number;
  decisionId: string;
  reason?: string;
  spoonFedDirections?: string;
  /** re-plan: what's wrong with the task spec + what to fix (required). */
  planRevisionDirective?: string;
  /** escalate-validator sub-form: revalidate (bump validator rung) or override (accept as PASS). */
  validatorAction?: ValidatorEscalateAction;
  /** escalate-validator:override justification (required when validatorAction=override). */
  overrideJustification?: string;
}

export class EscalationService {
  /** Absolute max orchestrator rung (L4 / position 3). L4 is optional — no hardcoded default model. */
  static readonly MAX_RUNG = 3;

  private rung0Overrides: Record<string, {model: string, provider?: string}> = {};
  // C5: injected for low-budget trigger (fake in tests mirrors p1-6b); worker uses isDepleted as <threshold signal
  private usageGateway?: { isDepleted(provider: string, model: string): Promise<boolean | null> };

  constructor(
    private readonly db?: DatabaseService,
    usageGateway?: { isDepleted(p: string, m: string): Promise<boolean | null> },
    private readonly assignment?: AgentAssignmentService
  ) {
    this.usageGateway = usageGateway;
  }

  // POCFIX12: rung-0 from role binding (binding is the BASE model for rung 0 for impl/validator; ladder rungs 1-2 unchanged; no binding keeps original hard-coded rung-0 e.g. grok for impl)
  setRung0Override(role: string, model: string, provider?: string) {
    const r = (role || '').toLowerCase();
    if (r === 'implementer' || r === 'validator') {
      this.rung0Overrides[r] = {model, provider};
    }
  }

  getProviderForRung(role: string, rung: number, ctx?: { projectId?: number; agentId?: number }): string | null {
    const r = (role || '').toLowerCase();
    if (rung === 0 && this.rung0Overrides[r]) {
      const ov = this.rung0Overrides[r];
      return ov.provider || this.getProviderForModel(ov.model);
    }
    const model = this.getModelForRung(role, rung, ctx);
    return this.getProviderForModel(model);
  }

  // Fallback ladders (match B3 seeds in schema.ts; used when no DB or for unit tests).
  // B6a/AC-9: rungs 0–2 only. L4 (rung 3 / position 3) has NO hardcoded default — resolve only from
  // agent_escalations / project_agent_escalations when configured. Absent L4 ⇒ identical to today.
  private getLadder(role: string): Record<number, string> {
    const r = (role || '').toLowerCase();
    if (r === 'implementer' || r === 'routine-implementer') {
      return { 0: 'grok-4.5', 1: 'codex-5.5', 2: 'claude-opus' };
    }
    if (r === 'validator') {
      return { 0: 'claude-sonnet-4-6', 1: 'codex-5.5', 2: 'claude-opus' };
    }
    // default safe
    return { 0: 'grok-4.5', 1: 'codex-5.5', 2: 'claude-opus' };
  }

  /**
   * B6a / AC-9: highest rung that currently resolves a model for role (0..MAX_RUNG).
   * Default seeds (positions 1–2 only) → 2. With position-3 configured → 3.
   */
  getMaxResolvableRung(role: string, ctx?: { projectId?: number; agentId?: number }): number {
    for (let r = EscalationService.MAX_RUNG; r >= 0; r--) {
      try {
        this.resolveRungAndModel({ role, explicitRung: r, projectId: ctx?.projectId, agentId: ctx?.agentId });
        return r;
      } catch {
        /* try lower */
      }
    }
    return 0;
  }

  resolveRungAndModel(params: {
    role: string;
    explicitModel?: string;
    explicitRung?: number;
    complexity?: 'low' | 'med' | 'high' | 'xhigh';
    projectId?: number;
    agentId?: number;
  }): { rung: number; model: string; source: string; effort: string | null } {
    const { role, explicitModel, explicitRung, complexity, projectId, agentId } = params;
    const r = (role || 'implementer').toLowerCase();

    // POCFIX12: rung-0 binding override (from RunOrch role_bindings) for impl/validator; only rung 0.
    // explicitModel takes precedence (per existing). For rung0 explicit or default, ov wins if set.
    if (!explicitModel && (r === 'implementer' || r === 'validator')) {
      const effectiveRung = (explicitRung != null) ? explicitRung : 0;
      if (effectiveRung === 0) {
        const ov = this.rung0Overrides[r];
        if (ov) {
          const provider = ov.provider || this.getProviderForModel(ov.model);
          const allowed = this.getAllowedProvidersForRole(r);
          if (provider && allowed.length && !allowed.includes(provider)) {
            throw new Error(`UNSUPPORTED_RUNG_PROVIDER_FOR_ROLE: ${provider} for ${r} at rung 0`);
          }
          return { rung: 0, model: ov.model, source: 'role-binding-rung0', effort: null };
        }
      }
    }

    // Precedence: explicit model > explicit rung > complexity default > role default
    if (explicitModel && explicitModel.trim()) {
      const name = explicitModel.trim();
      if (this.db) {
        const row = this.db.prepare(
          'SELECT id, name, provider FROM models WHERE name = ? OR model_id = ? LIMIT 1'
        ).get(name, name) as { id: number; name: string; provider: string } | undefined;
        if (!row) {
          throw new Error(`UNKNOWN_MODEL: ${name}`);
        }
        if (!this.hasProvider(row.provider)) {
          throw new Error(`UNKNOWN_PROVIDER: ${row.provider} for ${name}`);
        }
      } else {
        const known = ['grok-4.5', 'codex-5.5', 'claude-opus', 'claude-sonnet-4-6', 'claude-sonnet', 'spark'];
        if (!known.includes(name)) {
          throw new Error(`UNKNOWN_MODEL: ${name}`);
        }
      }
      return { rung: 0, model: name, source: 'explicit-model', effort: null };
    }

    if (explicitRung != null) {
      const ladder = this.getLadder(r);
      // B6a/AC-9: domain 0..MAX_RUNG (L4). Ladder fallback only has 0..2; rung 3 requires a DB/project row.
      if (!Number.isInteger(explicitRung) || explicitRung < 0 || explicitRung > EscalationService.MAX_RUNG) {
        throw new Error(`INVALID_RUNG_FOR_ROLE: ${explicitRung} for ${r}`);
      }
      const pos = explicitRung;
      let model: string | null = null;
      let effort: string | null = null;
      if (pos > 0) {
        const projectEsc = this.resolveProjectEscalation(projectId, r, pos, agentId);
        if (projectEsc) {
          model = projectEsc.model_name;
          effort = projectEsc.effort;
        }
      }
      if (this.db && model == null) {
        const agentRow = this.db.prepare('SELECT id FROM agents WHERE name = ?').get(r) as { id: number } | undefined;
        if (agentRow) {
          if (pos === 0) {
            const base = this.db.prepare(
              'SELECT m.name FROM agents a LEFT JOIN models m ON a.default_model_id = m.id WHERE a.id = ?'
            ).get(agentRow.id) as { name: string } | undefined;
            model = base?.name || null;
          } else {
            const esc = this.db.prepare(`
              SELECT m.name, e.effort FROM agent_escalations e
              JOIN models m ON e.model_id = m.id
              WHERE e.agent_id = ? AND e.position = ?
            `).get(agentRow.id, pos) as { name: string; effort: string | null } | undefined;
            model = esc?.name || null;
            effort = esc?.effort == null || String(esc.effort).trim() === '' ? null : String(esc.effort);
          }
        }
      }
      if (!model) {
        model = ladder[pos];
      }
      if (!model) {
        throw new Error(`NO_RUNG_${pos}_FOR_ROLE ${r}`);
      }
      // Unsupported rung-provider-for-role check (fail-closed per ESC6)
      const provider = this.getProviderForModel(model);
      const allowed = this.getAllowedProvidersForRole(r);
      if (provider && allowed.length && !allowed.includes(provider)) {
        throw new Error(`UNSUPPORTED_RUNG_PROVIDER_FOR_ROLE: ${provider} for ${r} at rung ${pos}`);
      }
      return { rung: pos, model, source: `explicit-rung-${pos}`, effort: pos > 0 ? effort : null };
    }

    if (complexity === 'high' || complexity === 'xhigh') {
      const projectEsc = this.resolveProjectEscalation(projectId, r, 1, agentId);
      let model = projectEsc?.model_name ?? null;
      let effort = projectEsc?.effort ?? null;
      if (!model && this.db) {
        const agentRow = this.db.prepare('SELECT id FROM agents WHERE name = ?').get(r) as { id: number } | undefined;
        if (agentRow) {
          const esc = this.db.prepare(`
            SELECT m.name, e.effort FROM agent_escalations e
            JOIN models m ON e.model_id = m.id
            WHERE e.agent_id = ? AND e.position = 1
          `).get(agentRow.id) as { name: string; effort: string | null } | undefined;
          model = esc?.name || null;
          effort = esc?.effort == null || String(esc?.effort ?? '').trim() === '' ? null : String(esc!.effort);
        }
      }
      if (!model) {
        const ladder = this.getLadder(r);
        model = ladder[1] || ladder[0];
      }
      const provider = this.getProviderForModel(model);
      const allowed = this.getAllowedProvidersForRole(r);
      if (provider && allowed.length && !allowed.includes(provider)) {
        throw new Error(`UNSUPPORTED_RUNG_PROVIDER_FOR_ROLE: ${provider} for ${r} at rung 1`);
      }
      return { rung: 1, model, source: 'complexity-high', effort };
    }

    // role default (rung 0)
    const ladder = this.getLadder(r);
    const model = ladder[0];
    return { rung: 0, model, source: 'role-default', effort: null };
  }

  /**
   * B5 / AC-10: per-rung effort for L2+ (position = rung when rung > 0).
   * NULL = inherit L1/agent / plan base effort. Rung 0 always returns null.
   */
  getEffortForRung(
    role: string,
    rung: number,
    ctx?: { projectId?: number; agentId?: number }
  ): string | null {
    if (!Number.isInteger(rung) || rung <= 0) return null;
    const r = (role || 'implementer').toLowerCase();
    const projectEsc = this.resolveProjectEscalation(ctx?.projectId, r, rung, ctx?.agentId);
    if (projectEsc) return projectEsc.effort;
    if (!this.db) return null;
    const agentRow = this.db.prepare('SELECT id FROM agents WHERE name = ?').get(r) as { id: number } | undefined;
    if (!agentRow) return null;
    const esc = this.db.prepare(`
      SELECT effort FROM agent_escalations
      WHERE agent_id = ? AND position = ?
    `).get(agentRow.id, rung) as { effort: string | null } | undefined;
    if (!esc || esc.effort == null || String(esc.effort).trim() === '') return null;
    return String(esc.effort);
  }

  /**
   * B5 / AC-10: launch effort prefers rung effort when rung > 0 and set; else base (agent/plan).
   */
  resolveLaunchEffort(
    rung: number,
    baseEffort: string | null | undefined,
    role: string,
    ctx?: { projectId?: number; agentId?: number }
  ): string {
    if (rung > 0) {
      const rungEffort = this.getEffortForRung(role, rung, ctx);
      if (rungEffort) return rungEffort;
    }
    const base = (baseEffort || '').trim().toLowerCase();
    if (['low', 'medium', 'high', 'xhigh', 'max'].includes(base)) return base;
    return baseEffort && String(baseEffort).trim() ? String(baseEffort).trim() : 'medium';
  }

  private getProviderForModel(modelName: string): string | null {
    if (!modelName) return null;
    if (this.db) {
      const row = this.db.prepare('SELECT provider FROM models WHERE name = ? OR model_id = ? LIMIT 1').get(modelName, modelName) as { provider: string } | undefined;
      if (row) return row.provider;
    }
    // fallback from known
    if (modelName.includes('grok')) return 'grok';
    if (modelName.includes('codex') || modelName.includes('gpt-5')) return 'codex';
    if (modelName.includes('claude') || modelName.includes('sonnet') || modelName.includes('opus')) return 'claude';
    return null;
  }

  // C0 (kloo route threading): parallel lookup to getProviderForModel — resolves the bound model's
  // `route` (models.route, added B1) so kloo dispatches can fill `<route>` at spawn (e.g. 'openrouter').
  // Public: orchestrator-loop calls this directly (getProviderForModel above is reached via an `as any`
  // cast for the same reason — no DB-backed lookup was previously exposed on the public surface).
  getRouteForModel(modelName: string): string | null {
    if (!modelName) return null;
    if (this.db) {
      const row = this.db.prepare('SELECT route FROM models WHERE name = ? OR model_id = ? LIMIT 1').get(modelName, modelName) as { route: string | null } | undefined;
      if (row && row.route) return row.route;
    }
    return null;
  }

  // R6 (escalation dead-end fix): ladder/agent_escalations rows carry the model's DISPLAY name
  // (e.g. 'codex-5.5'), but the provider registries only know launchable ids (model_id 'gpt-5.5').
  // Escalating with the display name made resolveAgentLaunchSpec throw "Unknown model" exactly when
  // the safety net was needed. Map display-name → launchable model_id via the models table when a
  // row exists; pass through unchanged otherwise (registry names like 'claude-sonnet-4-6' already
  // launch as-is, and unit stubs without a db keep prior behavior).
  getLaunchableModel(modelName: string): string {
    if (!modelName) return modelName;
    if (this.db) {
      try {
        const row = this.db.prepare('SELECT model_id FROM models WHERE name = ? LIMIT 1').get(modelName) as { model_id: string | null } | undefined;
        if (row && row.model_id) return row.model_id;
      } catch { /* fall through */ }
    }
    return modelName;
  }

  // Safe access for PROVIDERS (typed literal object, no index signature)
  private hasProvider(provider: string): boolean {
    const p = provider as keyof typeof PROVIDERS;
    return !!(PROVIDERS as any)[p];
  }

  private getAllowedProvidersForRole(role: string): string[] {
    const r = (role || '').toLowerCase();
    // 'stub' = deterministic scenario-harness provider (Phase-2). 'kloo' = dynamic OSS-model harness
    // (openrouter/local via kloo CLI) — allowed as implementer/validator for the model A/B loop.
    if (r === 'implementer' || r === 'routine-implementer') return ['grok', 'codex', 'claude', 'stub', 'kloo'];
    if (r === 'validator') return ['claude', 'codex', 'grok', 'stub', 'kloo'];
    if (r === 'plancore' || r === 'ibrain' || r === 'coord') return ['claude', 'codex', 'grok', 'stub', 'kloo'];
    return ['grok', 'codex', 'claude', 'stub', 'kloo'];
  }

  getModelForRung(role: string, rung: number, ctx?: { projectId?: number; agentId?: number }): string {
    const resolved = this.resolveRungAndModel({ role, explicitRung: rung, projectId: ctx?.projectId, agentId: ctx?.agentId });
    return resolved.model;
  }

  // C5 low-budget escalation trigger (G8b): called at dispatch time for worker base.
  // If bound model 's usage reports below threshold (isDepleted==true via gateway), swap to next rung/headroom model.
  // Compatible with C6 per-task base (called after resolve with explicit).
  // Threshold configurable via gateway ctor/env (tests inject fake that returns true to fire).
  async maybeLowBudgetEscalate(
    role: string,
    rung: number,
    model: string,
    ctx?: { projectId?: number; agentId?: number }
  ): Promise<{ rung: number; model: string; triggered: boolean; source?: string }> {
    if (!this.usageGateway) return { rung, model, triggered: false };
    const prov = this.getProviderForModel(model);
    try {
      const low = await this.usageGateway.isDepleted(prov || '', model);
      if (low === true) {
        const nextRung = Math.min(EscalationService.MAX_RUNG, rung + 1);
        try {
          const next = this.resolveRungAndModel({ role, explicitRung: nextRung, projectId: ctx?.projectId, agentId: ctx?.agentId });
          return { rung: next.rung, model: next.model, triggered: true, source: 'low-budget' };
        } catch {
          // Next rung unresolvable (e.g. optional L4 absent) — do not trigger
          return { rung, model, triggered: false };
        }
      }
    } catch {}
    return { rung, model, triggered: false };
  }

  private resolveAgentIdForRole(projectId: number, role: string): number | null {
    if (!this.assignment) return null;
    const binding = this.assignment.getProjectBinding(projectId, role);
    if (binding?.agent?.id != null) return binding.agent.id;
    const def = this.assignment.listRoleDefaults().find((d) => d.role === role);
    return def?.agent?.id ?? null;
  }

  private resolveProjectEscalationModel(
    projectId: number | undefined,
    role: string,
    position: number,
    agentId?: number
  ): string | null {
    return this.resolveProjectEscalation(projectId, role, position, agentId)?.model_name ?? null;
  }

  /** Project-scoped ladder row (model + optional per-rung effort). */
  private resolveProjectEscalation(
    projectId: number | undefined,
    role: string,
    position: number,
    agentId?: number
  ): { model_name: string; effort: string | null } | null {
    if (projectId == null || !this.assignment) return null;
    const aid = agentId ?? this.resolveAgentIdForRole(projectId, role);
    if (aid == null) return null;
    const effective = this.assignment.resolveProjectAgent(projectId, aid);
    if (!effective) return null;
    const esc = effective.escalations.find((e) => e.position === position);
    if (!esc?.model_name) return null;
    return {
      model_name: esc.model_name,
      effort: esc.effort == null || String(esc.effort).trim() === '' ? null : String(esc.effort),
    };
  }

  buildLedger(entries: LedgerEntry[]): { version: number; attempts: LedgerEntry[]; generated_at: string } {
    return {
      version: 1,
      attempts: entries,
      generated_at: new Date().toISOString()
    };
  }

  parseDecision(note: string | null): Decision | null {
    if (!note) return null;
    // Accept either raw JSON or "text — {json}"
    let candidate = note.trim();
    const jsonMatch = candidate.match(/(\{[\s\S]*\})/);
    if (jsonMatch) {
      candidate = jsonMatch[1];
    }
    try {
      const d = JSON.parse(candidate);
      const v = parseBrainVerdict(d);
      const rePlanOk =
        d.action !== 're-plan' ||
        (typeof d.planRevisionDirective === 'string' && d.planRevisionDirective.trim().length > 0);
      const escValOk =
        d.action !== 'escalate-validator' ||
        (d.validatorAction === 'revalidate' ||
          (d.validatorAction === 'override' &&
            typeof d.overrideJustification === 'string' &&
            d.overrideJustification.trim().length > 0));
      // #54 (JROM-LOCKED 2026-07-20): VALIDATE EXECUTABILITY, NOT JUDGEMENT.
      //
      // The brain is the component whose entire purpose is to evaluate root cause and choose a route.
      // Gating its decision on which LABEL it picked buys no safety and throws away the judgement the
      // tokens were spent on — exactly what happened on retest run 24, where a correct re-plan was
      // discarded because the edge_class was 'external-blocker' rather than 'validator-failure'.
      //
      // So the only hard block left is the one that constrains a CONSEQUENCE rather than a vocabulary
      // choice: never let a non-validator-side fault be laundered into a PASS. Fabricating success is
      // the one move that is not reversible by a later step and that silently corrupts the record.
      // Everything else the brain asks for is permitted, and bounded elsewhere by blast-radius controls
      // (HELM_MAX_REPLANS, content-only slice revision with immutable key/deps/batch, atomic re-ingest,
      // and the decision audit trail) rather than by refusing the request.
      const wouldLaunderIntoPass =
        d.action === 'escalate-validator' &&
        d.validatorAction === 'override' &&
        !!v &&
        v.edge_class !== 'validator-failure';
      const edgeClassOk = !!v && !wouldLaunderIntoPass;
      // Non-blocking advisory: a rung bump cannot fix a fault that is external to the ladder. Allowed
      // (the brain may see something we do not), but surfaced so the wasted rung is visible in the log.
      if (v && v.edge_class === 'external-blocker' && d.action === 'bump-rung') {
        console.warn(
          `[escalation] advisory: bump-rung on edge_class=external-blocker (decision=${d.decisionId}) — a higher rung cannot resolve an external fault; allowing per #54 but flagging the likely wasted attempt`
        );
      }
      // #54: name every failed check. A rejected decision used to vanish silently and degrade to a
      // park/defer, so a CORRECT brain answer could disappear with no trace anywhere — the single worst
      // failure mode observed in the whole exercise. Rejection must always leave evidence.
      const failures: string[] = [];
      if (!v) failures.push(`unparseable brain verdict (need edge_class/route_to/blocker_owner/reason; got edge_class=${JSON.stringify((d as any)?.edge_class)} route_to=${JSON.stringify((d as any)?.route_to)})`);
      if (typeof d.action !== 'string') failures.push('action missing or not a string');
      if (typeof d.decisionId !== 'string' || !d.decisionId.trim()) failures.push('decisionId missing/empty');
      if (v && d.action !== v.route_to) failures.push(`action (${d.action}) != route_to (${v.route_to})`);
      if (!edgeClassOk && v) failures.push(`edge_class=${v.edge_class} may not reach PASS via ${d.action}/${d.validatorAction} (override laundering)`);
      if (d.action === 'bump-rung' && !(Number.isInteger(d.targetRung) && d.targetRung >= 0 && d.targetRung <= EscalationService.MAX_RUNG)) failures.push(`bump-rung needs targetRung in 0..${EscalationService.MAX_RUNG} (got ${JSON.stringify(d.targetRung)})`);
      if (d.action === 'validator-handholding' && !(typeof d.spoonFedDirections === 'string' && d.spoonFedDirections.trim())) failures.push('validator-handholding needs non-empty spoonFedDirections');
      if (!rePlanOk) failures.push('re-plan needs a non-empty planRevisionDirective');
      if (!escValOk) failures.push('escalate-validator needs validatorAction=revalidate, or override + non-empty overrideJustification');

      if (failures.length === 0) {
        return d as Decision;
      }
      console.error(
        `[escalation] DECISION REJECTED (id=${(d as any)?.decisionId ?? 'none'} action=${(d as any)?.action ?? 'none'}): ${failures.join('; ')} :: the brain's answer is being discarded — fix the contract or re-ask, do NOT let this silently degrade to a park`
      );
    } catch (error) {
      console.error(`[escalation] DECISION UNPARSEABLE (not valid JSON): ${String(error).slice(0, 200)}`);
    }
    return null;
  }

  async writeFailureHistory(
    runDir: string,
    ledger: { version: number; attempts: LedgerEntry[]; generated_at: string }
  ): Promise<void> {
    const fs = await import('node:fs/promises');
    const p = await import('node:path');
    const dir = p.join(runDir, 'failure-history');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(p.join(dir, 'ledger.json'), JSON.stringify(ledger, null, 2), 'utf8');
    for (const e of ledger.attempts) {
      const safeAttempt = e.attempt || 0;
      await fs.writeFile(
        p.join(dir, `attempt-${safeAttempt}.json`),
        JSON.stringify(e, null, 2),
        'utf8'
      );
    }
  }

  async readFailureHistory(runDir: string): Promise<{ version: number; attempts: LedgerEntry[]; generated_at: string } | null> {
    const fs = await import('node:fs/promises');
    const p = await import('node:path');
    try {
      const raw = await fs.readFile(p.join(runDir, 'failure-history', 'ledger.json'), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
