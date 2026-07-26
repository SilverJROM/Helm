// Adaptive tiered planning (spec v2, docs/adaptive-planner-plan.md). Built as a SEPARATE module behind
// the per-project `adaptive_planning` opt-in flag — the existing single-author runPlanningPhase is never
// touched when the flag is OFF (grok red-team FIX 7: isolation, no if-soup in the old file).
//
// Model: plancore = DRIVER only (routes inputs, gates, logs — never authors task prose). A lead_planner
// drafts the skeleton + plan_depth tags and integrates; a configurable panel authors slices, DEPTH-routed
// per task cluster (solo / B=pair / A=panel), convened by TIER/BATCH (never per-task spawns), with an
// upward escalation backstop and structural coverage/contradiction gates before PLAN-READY.
//
// STAGES:
//   1. foundation + isolation (flag hook, types, telemetry names) — done.
//   2. skeleton dual-read gate (this module).
//   3. batch-tier authoring (solo/B/A, parallel A, escalate w/ re-cut).
//   4. integration + structural gates → same PlanningResult / ingest contract.

import fs from 'node:fs/promises';
import path from 'node:path';
import type { PlanningInputs, PlanningResult } from './planning-phase-service.js';
import type { ITransport } from './fake-transport.js';
import type { RunArtifactService } from './run-artifact-service.js';
import type { TaskQueueService } from './task-queue-service.js';
import { PlanParserService, type Plan, type PlannedTask } from './plan-parser-service.js';
import { BriefWriterService, bindDispatchNonce, createDispatchNonce } from './brief-writer-service.js';
import { CANONICAL_CYCLE_ARTIFACTS, materializeCanonicalArtifactSet } from './cycle-artifact-paths.js';
import { validateExecutionPlan } from './execution-plan-parser.js';
import { parsePlanContradiction } from './plan-contradiction.js';

/** plan_depth is the ROUTING key — planning uncertainty, kept SEPARATE from implementer `complexity`
 *  (grok FIX 3). Derived by the lead from {cross_cutting, ambiguity, blast_radius, novelty}. */
export type PlanDepth = 'solo' | 'pair' | 'panel';

/** Closed critic protocol (grok FIX 4) — testable, not prose. Only ESCALATE+hard burns a tier step. */
export type CritiqueVerdict = 'ACCEPT' | 'AMEND' | 'ESCALATE';
export type CritiqueSeverity = 'soft' | 'hard';
export type CritiqueReason =
  | 'cross_cutting' | 'missing_deps' | 'unsafe_solo' | 'contradicts_decision'
  | 'false_atomic' | 'needs_JROM' | 'other';
export interface Critique {
  verdict: CritiqueVerdict;
  severity: CritiqueSeverity;
  reasons: CritiqueReason[];
  patch?: unknown; // structured deltas (merge/split/add-task/add-dep) for ESCALATE_RECOMPOSE
}

/** Telemetry event names (path B — savings must be MEASURED). Emitted to run_events. */
export const ADAPTIVE_PLAN_EVENTS = {
  SKELETON_GATE: 'PLAN_SKELETON_GATE',
  TIER_ROUTED: 'PLAN_TIER_ROUTED',
  TIER_ESCALATED: 'PLAN_TIER_ESCALATED',
  SETTLE: 'PLAN_SETTLE',
  BLOCK: 'PLAN_BLOCK',
  STAGE_TOKENS: 'PLAN_STAGE_TOKENS',
} as const;

/** Per-project planner panel config (grok: explicit N, lead is member[0]).
 *  Built by PlannerPanelService from project_planner_panel + optional backup fallback. */
export interface PlannerPanel {
  size: number;                 // N members, default 2 (1 or 3+ allowed)
  leadModel?: string;           // planner_01 — top-tier
  leadProvider?: string;
  memberModels?: string[];      // the panel (incl. lead); resolved from project role/team bindings
  memberProviders?: string[];   // parallel to memberModels (v93)
  /** Per-seat effort (parallel to memberModels); slot inherits defaultEffort when omitted. */
  memberEfforts?: string[];
  /** Ordered fallback models (provider+model) used when a member CLI is unavailable at spawn. */
  backups?: Array<{ model: string; provider: string }>;
  /** Panel default effort (low|med|high|xhigh); slot with no override inherits this. */
  defaultEffort?: string;
}

export interface AdaptivePlanningInputs extends PlanningInputs {
  panel?: PlannerPanel;
  /** Test/fixture injection — when set, skips agent waits and uses provided artifacts (USE_FAKE_TMUX path). */
  fixture?: AdaptiveFixture;
  /**
   * Optional availability probe for backup fallback at spawn (seat-binary / auth).
   * When a slotted member is unavailable, the next free backup is used. Sync or async.
   */
  isModelAvailable?: (provider: string, model: string) => boolean | Promise<boolean>;
}

export interface AdaptiveFixture {
  skeleton?: PlanSkeleton;
  critique?: Critique;
  soloAudit?: Critique;
  bCritique?: Critique;
  aDrafts?: AuthoredTask[][];  // one array per seat (independent drafts)
  aReconcile?: AuthoredTask[];
  settleTasks?: AuthoredTask[];
  requirementsMarkdown?: string;
  planMarkdown?: string;
  forceDeadlock?: boolean;
  forceNeedsJrom?: boolean;
}

export interface DepthVector {
  cross_cutting: boolean;
  ambiguity: boolean;
  blast_radius: 'low' | 'med' | 'high';
  novelty: boolean;
}

/** Skeleton task = key + one-line intent + plan_depth (+ optional complexity kept SEPARATE). */
export interface SkeletonTask {
  task_key: string;
  intent: string;
  plan_depth: PlanDepth;
  depth_vector: DepthVector;
  complexity?: 'low' | 'med' | 'high' | 'xhigh';
  deps?: string[];
  req_refs?: string[];
  affinity?: string;
  shared_contract?: boolean;
}

export interface PlanSkeleton {
  tasks: SkeletonTask[];
  requirements: string[]; // R-XX ids that must each map to ≥1 task
}

export interface AuthoredTask {
  id: string;
  batch: string;
  title: string;
  req_refs: string[];
  assignee: string;
  validator_lane: string;
  effort: string;
  type: string;
  deps: string[];
  redteam?: string;
  exception_handling?: string;
  plan_depth?: PlanDepth;
  complexity?: string;
  validation_criteria?: string;
}

export interface SkeletonGateResult {
  pass: boolean;
  coverage: Record<string, string[]>; // req → task_keys
  errors: string[];
  orphanDeps: string[];
  uncoveredReqs: string[];
}

export interface TierPartition {
  solo_set: SkeletonTask[];
  B_set: SkeletonTask[];
  A_set: SkeletonTask[];
  A_clusters: Record<string, SkeletonTask[]>;
}

export interface StructuralGateResult {
  pass: boolean;
  errors: string[];
}

export interface SettleResult {
  action: 'settle' | 'block';
  settledTasks?: AuthoredTask[];
  dissent?: string;
  reason: string;
}

export interface AdaptivePlanningRuntimeDeps {
  transport: ITransport;
  artifacts: RunArtifactService;
  taskQueue: TaskQueueService;
}

/** Raised only for explicit operator-facing hard blocks (not "not implemented"). */
export class AdaptivePlanningNotReadyError extends Error {
  constructor(stage: string) {
    super(`adaptive planning: ${stage} not yet implemented — keep adaptive_planning OFF until the build lands`);
    this.name = 'AdaptivePlanningNotReadyError';
  }
}

export class AdaptivePlanningBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdaptivePlanningBlockedError';
  }
}

// ---------------------------------------------------------------------------
// FIX 4 — closed critic protocol parser (testable, not vibes)
// ---------------------------------------------------------------------------

const CRITIQUE_VERDICTS = new Set<CritiqueVerdict>(['ACCEPT', 'AMEND', 'ESCALATE']);
const CRITIQUE_SEVERITIES = new Set<CritiqueSeverity>(['soft', 'hard']);
const CRITIQUE_REASONS = new Set<CritiqueReason>([
  'cross_cutting', 'missing_deps', 'unsafe_solo', 'contradicts_decision',
  'false_atomic', 'needs_JROM', 'other',
]);

/**
 * Parse the machine-closed CRITIQUE-READY block (or a plain Critique JSON object).
 * Control flow must never depend on free-text prose outside the enum fields.
 */
export function parseCritique(raw: string | Critique | null | undefined): Critique | null {
  if (raw == null) return null;
  if (typeof raw === 'object') {
    return normalizeCritique(raw);
  }
  const text = String(raw).trim();
  if (!text) return null;

  // JSON object form
  if (text.startsWith('{')) {
    try {
      return normalizeCritique(JSON.parse(text));
    } catch {
      // fall through to block form
    }
  }

  // Block form:
  // CRITIQUE-READY
  // verdict: ACCEPT
  // severity: soft
  // reasons: [cross_cutting, missing_deps]
  // patch: {...}
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const hasHeader = lines.some((l) => /^CRITIQUE-READY\b/i.test(l));
  const verdictLine = lines.find((l) => /^verdict\s*:/i.test(l));
  const severityLine = lines.find((l) => /^severity\s*:/i.test(l));
  const reasonsLine = lines.find((l) => /^reasons\s*:/i.test(l));
  if (!hasHeader && !verdictLine) return null;

  const verdictRaw = (verdictLine?.split(':').slice(1).join(':') || '').trim().toUpperCase();
  const severityRaw = (severityLine?.split(':').slice(1).join(':') || 'soft').trim().toLowerCase();
  const reasonsRaw = (reasonsLine?.split(':').slice(1).join(':') || '').trim();
  const reasons = reasonsRaw
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(/[,|]/)
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => (CRITIQUE_REASONS.has(r as CritiqueReason) ? (r as CritiqueReason) : 'other'));

  let patch: unknown;
  const patchIdx = lines.findIndex((l) => /^patch\s*:/i.test(l));
  if (patchIdx >= 0) {
    const after = lines[patchIdx].replace(/^patch\s*:/i, '').trim();
    const rest = [after, ...lines.slice(patchIdx + 1)].join('\n').trim();
    if (rest) {
      try { patch = JSON.parse(rest); } catch { patch = rest; }
    }
  }

  return normalizeCritique({
    verdict: verdictRaw as CritiqueVerdict,
    severity: severityRaw as CritiqueSeverity,
    reasons,
    ...(patch !== undefined ? { patch } : {}),
  });
}

function normalizeCritique(v: any): Critique | null {
  if (!v || typeof v !== 'object') return null;
  const verdict = String(v.verdict || '').toUpperCase() as CritiqueVerdict;
  const severity = String(v.severity || 'soft').toLowerCase() as CritiqueSeverity;
  if (!CRITIQUE_VERDICTS.has(verdict)) return null;
  if (!CRITIQUE_SEVERITIES.has(severity)) return null;
  const reasons: CritiqueReason[] = Array.isArray(v.reasons)
    ? v.reasons.map((r: unknown) => {
        const s = String(r);
        return CRITIQUE_REASONS.has(s as CritiqueReason) ? (s as CritiqueReason) : 'other';
      })
    : [];
  return {
    verdict,
    severity,
    reasons,
    ...(v.patch !== undefined ? { patch: v.patch } : {}),
  };
}

/** Only ESCALATE + hard burns a tier step (solo→B, B→A). cross_cutting may jump to A. */
export function shouldEscalateTier(critique: Critique | null | undefined): boolean {
  return !!critique && critique.verdict === 'ESCALATE' && critique.severity === 'hard';
}

/** Under-tag flagged cross_cutting may jump straight to A. */
export function escalateJumpToPanel(critique: Critique | null | undefined): boolean {
  return shouldEscalateTier(critique) && (critique?.reasons || []).includes('cross_cutting');
}

export function nextPlanDepth(current: PlanDepth, critique?: Critique | null): PlanDepth {
  if (escalateJumpToPanel(critique || null)) return 'panel';
  if (current === 'solo') return 'pair';
  return 'panel';
}

// ---------------------------------------------------------------------------
// FIX 1 — skeleton dual-read HARD gate
// ---------------------------------------------------------------------------

export function evaluateSkeletonGate(skeleton: PlanSkeleton): SkeletonGateResult {
  const errors: string[] = [];
  const coverage: Record<string, string[]> = {};
  const taskKeys = new Set(skeleton.tasks.map((t) => t.task_key));
  const orphanDeps: string[] = [];

  for (const req of skeleton.requirements || []) {
    coverage[req] = [];
  }
  for (const t of skeleton.tasks) {
    for (const r of t.req_refs || []) {
      if (!coverage[r]) coverage[r] = [];
      coverage[r].push(t.task_key);
    }
  }

  const uncoveredReqs = (skeleton.requirements || []).filter((r) => (coverage[r] || []).length === 0);
  if (uncoveredReqs.length) {
    errors.push(`coverage: requirements without task_key: ${uncoveredReqs.join(', ')}`);
  }

  for (const t of skeleton.tasks) {
    for (const d of t.deps || []) {
      if (!taskKeys.has(d)) {
        orphanDeps.push(`${t.task_key}->${d}`);
      }
    }
  }
  if (orphanDeps.length) {
    errors.push(`orphan deps: ${orphanDeps.join(', ')}`);
  }

  // no xhigh cluster without a shared-contract task
  const byAffinity = new Map<string, SkeletonTask[]>();
  for (const t of skeleton.tasks) {
    const k = t.affinity || (t.complexity === 'xhigh' ? '__xhigh__' : t.task_key);
    if (!byAffinity.has(k)) byAffinity.set(k, []);
    byAffinity.get(k)!.push(t);
  }
  for (const [aff, group] of byAffinity) {
    const xhigh = group.filter((t) => t.complexity === 'xhigh');
    if (xhigh.length >= 2) {
      const hasContract = group.some(
        (t) => t.shared_contract === true
          || /shared.?contract/i.test(t.intent)
          || /contract/i.test(t.task_key),
      );
      if (!hasContract) {
        errors.push(`xhigh cluster '${aff}' lacks a shared-contract task`);
      }
    }
  }

  // false-atomic / empty keys
  for (const t of skeleton.tasks) {
    if (!t.task_key?.trim()) errors.push('empty task_key');
    if (!t.intent?.trim()) errors.push(`task ${t.task_key}: empty intent`);
    if (!t.plan_depth || !['solo', 'pair', 'panel'].includes(t.plan_depth)) {
      errors.push(`task ${t.task_key}: invalid plan_depth (must be solo|pair|panel, separate from complexity)`);
    }
  }

  return {
    pass: errors.length === 0,
    coverage,
    errors,
    orphanDeps,
    uncoveredReqs,
  };
}

/** FIX 5 — heuristic auto-promote at skeleton time (hardened / cross-cutting → pair). */
export function applyHeuristicAutoPromote(skeleton: PlanSkeleton): PlanSkeleton {
  const HARDENED_RE = /hardened|cross.?cutting|schema|migration|auth|security/i;
  return {
    ...skeleton,
    tasks: skeleton.tasks.map((t) => {
      if (t.plan_depth !== 'solo') return t;
      if (t.depth_vector?.cross_cutting || HARDENED_RE.test(t.intent)) {
        return { ...t, plan_depth: 'pair' as PlanDepth };
      }
      return t;
    }),
  };
}

/**
 * Apply structured re-cut patch from an ESCALATE critique (merge/split/add-task/add-dep).
 * plancore applies PROCEDURE only — patch content comes from the critic, never invented here as prose.
 */
export function applySkeletonPatch(skeleton: PlanSkeleton, patch: unknown): PlanSkeleton {
  if (!patch || typeof patch !== 'object') return skeleton;
  const p = patch as Record<string, unknown>;
  let tasks = [...skeleton.tasks];
  const requirements = [...(skeleton.requirements || [])];

  if (Array.isArray(p.add_tasks)) {
    for (const raw of p.add_tasks) {
      const t = raw as SkeletonTask;
      if (t?.task_key && !tasks.some((x) => x.task_key === t.task_key)) {
        tasks.push({
          task_key: t.task_key,
          intent: t.intent || t.task_key,
          plan_depth: t.plan_depth || 'pair',
          depth_vector: t.depth_vector || {
            cross_cutting: false, ambiguity: false, blast_radius: 'low', novelty: false,
          },
          complexity: t.complexity,
          deps: t.deps || [],
          req_refs: t.req_refs || [],
          affinity: t.affinity,
          shared_contract: t.shared_contract,
        });
      }
    }
  }

  if (Array.isArray(p.add_deps)) {
    for (const edge of p.add_deps as Array<{ from: string; to: string }>) {
      const t = tasks.find((x) => x.task_key === edge.from);
      if (t) {
        const deps = new Set(t.deps || []);
        deps.add(edge.to);
        t.deps = [...deps];
      }
    }
  }

  if (Array.isArray(p.remove_tasks)) {
    const rm = new Set((p.remove_tasks as string[]).map(String));
    tasks = tasks.filter((t) => !rm.has(t.task_key));
  }

  if (Array.isArray(p.merge)) {
    // merge: [{ into: 'T01', from: ['T02'] }] — drop `from`, keep into, fold deps/req_refs
    for (const m of p.merge as Array<{ into: string; from: string[] }>) {
      const into = tasks.find((t) => t.task_key === m.into);
      if (!into) continue;
      for (const fk of m.from || []) {
        const from = tasks.find((t) => t.task_key === fk);
        if (!from) continue;
        into.req_refs = [...new Set([...(into.req_refs || []), ...(from.req_refs || [])])];
        into.deps = [...new Set([...(into.deps || []), ...(from.deps || []).filter((d) => d !== into.task_key)])];
        if (from.plan_depth === 'panel' || into.plan_depth === 'panel') into.plan_depth = 'panel';
        else if (from.plan_depth === 'pair' || into.plan_depth === 'pair') into.plan_depth = 'pair';
      }
      const drop = new Set(m.from || []);
      tasks = tasks.filter((t) => !drop.has(t.task_key));
    }
  }

  if (Array.isArray(p.split)) {
    // split: [{ from: 'T01', into: [SkeletonTask, ...] }]
    for (const s of p.split as Array<{ from: string; into: SkeletonTask[] }>) {
      tasks = tasks.filter((t) => t.task_key !== s.from);
      for (const nt of s.into || []) {
        if (nt?.task_key) {
          tasks.push({
            task_key: nt.task_key,
            intent: nt.intent || nt.task_key,
            plan_depth: nt.plan_depth || 'pair',
            depth_vector: nt.depth_vector || {
              cross_cutting: false, ambiguity: false, blast_radius: 'low', novelty: false,
            },
            complexity: nt.complexity,
            deps: nt.deps || [],
            req_refs: nt.req_refs || [],
            affinity: nt.affinity,
            shared_contract: nt.shared_contract,
          });
        }
      }
    }
  }

  if (Array.isArray(p.set_depth)) {
    for (const sd of p.set_depth as Array<{ task_key: string; plan_depth: PlanDepth }>) {
      const t = tasks.find((x) => x.task_key === sd.task_key);
      if (t && ['solo', 'pair', 'panel'].includes(sd.plan_depth)) {
        t.plan_depth = sd.plan_depth;
      }
    }
  }

  if (Array.isArray(p.add_requirements)) {
    for (const r of p.add_requirements as string[]) {
      if (r && !requirements.includes(r)) requirements.push(r);
    }
  }

  return { tasks, requirements };
}

// ---------------------------------------------------------------------------
// FIX 2 / FIX 3 — partition by plan_depth (never per-task PROCESS convening)
// ---------------------------------------------------------------------------

export function partitionByPlanDepth(tasks: SkeletonTask[]): TierPartition {
  const solo_set: SkeletonTask[] = [];
  const B_set: SkeletonTask[] = [];
  const A_set: SkeletonTask[] = [];
  for (const t of tasks) {
    if (t.plan_depth === 'panel') A_set.push(t);
    else if (t.plan_depth === 'pair') B_set.push(t);
    else solo_set.push(t);
  }
  const A_clusters: Record<string, SkeletonTask[]> = {};
  for (const t of A_set) {
    const k = t.affinity || 'default';
    if (!A_clusters[k]) A_clusters[k] = [];
    A_clusters[k].push(t);
  }
  return { solo_set, B_set, A_set, A_clusters };
}

/** Promote a set of task keys to a higher plan_depth (upward only). */
export function escalateTaskDepths(
  tasks: SkeletonTask[],
  keys: string[],
  to: PlanDepth,
): SkeletonTask[] {
  const set = new Set(keys);
  const rank = { solo: 0, pair: 1, panel: 2 };
  return tasks.map((t) => {
    if (!set.has(t.task_key)) return t;
    if (rank[to] > rank[t.plan_depth]) return { ...t, plan_depth: to };
    return t;
  });
}

// ---------------------------------------------------------------------------
// FIX 6 — structural gates (schema, coverage, dep-cycle, duplicate atomic, contradiction HARD)
// ---------------------------------------------------------------------------

export function extractRequirementIds(requirementsMarkdown: string): string[] {
  const ids = new Set<string>();
  const re = /\*\*([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\*\*|^[-*]\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)\b|`([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*)`/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(requirementsMarkdown)) !== null) {
    const id = m[1] || m[2] || m[3];
    if (id) ids.add(id);
  }
  // also plain R-XX / OPS-1 style tokens after bold markers like `- **R-01** —`
  const re2 = /\b([A-Z]{1,8}-\d+[A-Z0-9]*)\b/g;
  while ((m = re2.exec(requirementsMarkdown)) !== null) {
    ids.add(m[1]);
  }
  return [...ids];
}

export function runStructuralGates(
  planMarkdown: string,
  requirementsMarkdown: string,
): StructuralGateResult {
  const errors: string[] = [];

  // schema + dep-cycle + batch rules via shared validator
  const parsed = validateExecutionPlan(planMarkdown);
  if (!parsed.ok) {
    errors.push(...parsed.errors.map((e) => `schema: ${e}`));
    return { pass: false, errors };
  }

  const tasks = parsed.normalizedTasks;

  // coverage matrix: every requirement id referenced? and every req in og-requirements covered?
  const reqIds = extractRequirementIds(requirementsMarkdown);
  const covered = new Set<string>();
  for (const t of tasks) {
    for (const r of (t as any).req_refs || []) covered.add(String(r));
  }
  for (const r of reqIds) {
    if (!covered.has(r)) errors.push(`coverage: requirement ${r} has no task`);
  }

  // duplicate atomic_work (exact normalized title)
  const seenTitles = new Map<string, string>();
  for (const t of tasks) {
    const title = String((t as any).atomic_work || (t as any).title || '').trim().toLowerCase();
    if (!title) continue;
    if (seenTitles.has(title)) {
      errors.push(`duplicate atomic_work: '${title}' on ${seenTitles.get(title)} and ${(t as any).task_key}`);
    } else {
      seenTitles.set(title, String((t as any).task_key));
    }
  }

  // plan-contradiction HARD gate (existing machinery)
  const contra = parsePlanContradiction(planMarkdown)
    || parsePlanContradiction(requirementsMarkdown);
  if (contra) {
    errors.push(`plan-contradiction HARD: ${contra.raw}`);
  }
  // also scan per-task fields if any marker sneaks into titles
  for (const t of tasks) {
    const blob = JSON.stringify(t);
    const c = parsePlanContradiction(blob);
    if (c) errors.push(`plan-contradiction HARD on ${(t as any).task_key}: ${c.raw}`);
  }

  return { pass: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// FIX 4 — deadlock on A → named settle-pair OR BLOCK (plancore never authors)
// ---------------------------------------------------------------------------

/**
 * When A-panel drafts conflict, plancore chooses PROCEDURE only:
 * - needs_JROM or force block → BLOCK to operator
 * - else named settle-pair content (from the settle-pair models, passed in — never invented by plancore)
 */
export function resolvePanelDeadlock(opts: {
  drafts: AuthoredTask[][];
  settlePairTasks?: AuthoredTask[] | null;
  needsJrom?: boolean;
  settlePairNames?: [string, string];
}): SettleResult {
  if (opts.needsJrom) {
    return {
      action: 'block',
      reason: 'needs_JROM — panel deadlock requires operator',
    };
  }

  // Detect conflict: independent drafts disagree on task titles for same id
  const byId = new Map<string, Set<string>>();
  for (const draft of opts.drafts) {
    for (const t of draft) {
      if (!byId.has(t.id)) byId.set(t.id, new Set());
      byId.get(t.id)!.add(t.title.trim().toLowerCase());
    }
  }
  const conflicts = [...byId.entries()].filter(([, titles]) => titles.size > 1);
  if (conflicts.length === 0) {
    // no real deadlock — take first draft set
    return {
      action: 'settle',
      settledTasks: opts.drafts[0] || [],
      reason: 'no-conflict (consensus)',
      dissent: undefined,
    };
  }

  if (opts.settlePairTasks && opts.settlePairTasks.length > 0) {
    const names = opts.settlePairNames || ['planner_01', 'planner_02'];
    return {
      action: 'settle',
      settledTasks: opts.settlePairTasks,
      dissent: `SETTLED by settle-pair (${names[0]}+${names[1]}) over conflicting ids: ${conflicts.map(([id]) => id).join(', ')}`,
      reason: 'settle-pair wrote settled tasks (plancore did not author)',
    };
  }

  return {
    action: 'block',
    reason: `panel deadlock on ${conflicts.map(([id]) => id).join(', ')} with no settle-pair output`,
  };
}

// ---------------------------------------------------------------------------
// Artifact helpers (plan.md / og-requirements.md — SAME schema as existing path)
// ---------------------------------------------------------------------------

/**
 * Synthesize AuthoredTask rows from skeleton intents.
 * **Test/fixture-only** — call sites must guard with USE_FAKE_TMUX or fixture branches.
 * Production (real) path must NEVER call this; missing author → PLAN_BLOCK.
 */
export function skeletonToAuthoredTasks(tasks: SkeletonTask[], batchId = 'B1'): AuthoredTask[] {
  return tasks.map((t, i) => ({
    id: t.task_key,
    batch: batchId,
    title: t.intent,
    req_refs: t.req_refs && t.req_refs.length ? t.req_refs : [`R-${String(i + 1).padStart(2, '0')}`],
    assignee: t.complexity === 'xhigh' || t.complexity === 'high' ? 'L2' : 'L1',
    validator_lane: 'L1',
    effort: t.complexity || 'med',
    type: 'feature',
    deps: t.deps || [],
    plan_depth: t.plan_depth,
    complexity: t.complexity || 'med',
    validation_criteria: `Implements: ${t.intent}`,
  }));
}

export function renderPlanMarkdown(tasks: AuthoredTask[]): string {
  const canonical = tasks.map((t) => ({
    id: t.id,
    batch: t.batch,
    title: t.title,
    req_refs: t.req_refs,
    assignee: t.assignee,
    validator_lane: t.validator_lane,
    effort: t.effort,
    type: t.type,
    deps: t.deps || [],
    ...(t.redteam != null ? { redteam: t.redteam } : {}),
    ...(t.exception_handling != null ? { exception_handling: t.exception_handling } : {}),
    ...(t.validation_criteria != null ? { validation_criteria: t.validation_criteria } : {}),
  }));
  return `# Plan\n\n\`\`\`json\n${JSON.stringify(canonical, null, 2)}\n\`\`\`\n`;
}

export function renderRequirementsMarkdown(requirements: string[], tasks: AuthoredTask[]): string {
  const lines = requirements.map((r) => {
    const related = tasks.filter((t) => (t.req_refs || []).includes(r));
    const title = related[0]?.title || r;
    return `- **${r}** — ${title}`;
  });
  if (lines.length === 0) {
    const fromTasks = new Set<string>();
    for (const t of tasks) for (const r of t.req_refs || []) fromTasks.add(r);
    for (const r of fromTasks) {
      const related = tasks.filter((t) => (t.req_refs || []).includes(r));
      lines.push(`- **${r}** — ${related[0]?.title || r}`);
    }
  }
  return `# Requirements\n\n${lines.join('\n')}\n`;
}

function isFakePath(): boolean {
  return process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production';
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function writeFileSafe(p: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, content, 'utf8');
}

async function readJsonIfExists<T>(p: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(p, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Stage telemetry accumulator (path B measurement)
// ---------------------------------------------------------------------------

interface StageTelemetry {
  spawn_count: number;
  plan_tokens_by_stage: Record<string, number>;
  stages: string[];
}

function newTelemetry(): StageTelemetry {
  return { spawn_count: 0, plan_tokens_by_stage: {}, stages: [] };
}

function estimateTokens(text: string): number {
  return Math.ceil((text || '').length / 4);
}

function recordStage(tel: StageTelemetry, stage: string, briefText: string): void {
  tel.stages.push(stage);
  tel.plan_tokens_by_stage[stage] = (tel.plan_tokens_by_stage[stage] || 0) + estimateTokens(briefText);
}

function emitEvent(
  artifacts: RunArtifactService | undefined,
  runId: number | undefined,
  eventType: string,
  payload: unknown,
  batchId: string,
): void {
  if (!artifacts || runId == null || runId === 0) return;
  try {
    artifacts.recordRunEvent(runId, eventType, payload, batchId);
  } catch {
    // best-effort telemetry
  }
}

/**
 * v93 backup fallback: re-resolve panel memberModels when a slotted member's CLI is unavailable.
 * Walks ordered backups, skipping models already taken. Pure member order preserved.
 */
export async function resolvePanelWithAvailability(
  panel: PlannerPanel,
  isAvailable: (provider: string, model: string) => boolean | Promise<boolean>,
): Promise<PlannerPanel> {
  const models = panel.memberModels || [];
  const providers = panel.memberProviders || [];
  const backups = panel.backups || [];
  if (!models.length || !backups.length) return panel;

  const used = new Set<string>();
  const outModels: string[] = [];
  const outProviders: string[] = [];

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const provider = providers[i] || panel.leadProvider || 'grok';
    const key = `${provider}/${model}`;
    const ok = await Promise.resolve(isAvailable(provider, model));
    if (ok && !used.has(key)) {
      used.add(key);
      outModels.push(model);
      outProviders.push(provider);
      continue;
    }
    let picked = false;
    for (const b of backups) {
      const bk = `${b.provider}/${b.model}`;
      if (used.has(bk)) continue;
      const bOk = await Promise.resolve(isAvailable(b.provider, b.model));
      if (!bOk) continue;
      used.add(bk);
      outModels.push(b.model);
      outProviders.push(b.provider);
      picked = true;
      break;
    }
    if (!picked) {
      // Keep original so spawn fails clearly rather than inventing a model.
      used.add(key);
      outModels.push(model);
      outProviders.push(provider);
    }
  }

  const leadIdx = 0; // lead stays slot 0 after service build (or first member)
  // Prefer the configured lead when still present; else first resolved seat.
  let leadModel = panel.leadModel;
  let leadProvider = panel.leadProvider;
  if (leadModel) {
    const idx = models.indexOf(leadModel);
    if (idx >= 0 && outModels[idx]) {
      leadModel = outModels[idx];
      leadProvider = outProviders[idx];
    } else {
      leadModel = outModels[leadIdx];
      leadProvider = outProviders[leadIdx];
    }
  } else {
    leadModel = outModels[leadIdx];
    leadProvider = outProviders[leadIdx];
  }

  return {
    ...panel,
    size: outModels.length,
    memberModels: outModels,
    memberProviders: outProviders,
    leadModel,
    leadProvider,
  };
}

// ---------------------------------------------------------------------------
// Entry: stages 2–4 end-to-end
// ---------------------------------------------------------------------------

/**
 * Adaptive tiered planning entry. Same PlanningResult contract as runPlanningPhase so
 * implementation ingest is unchanged (FIX 7). plancore is DRIVER only.
 */
export async function runAdaptivePlanningPhase(
  deps: AdaptivePlanningRuntimeDeps,
  inputs: AdaptivePlanningInputs,
): Promise<PlanningResult> {
  const { transport, artifacts, taskQueue } = deps;
  const parser = new PlanParserService(artifacts);
  const briefWriter = new BriefWriterService();
  const tel = newTelemetry();

  const runDir = inputs.runDir;
  const canonicalArtifactRoot = inputs.canonicalArtifactRoot || runDir;
  const batchId = inputs.batchId || 'batch-adaptive';
  const brainRole = inputs.brainRole || 'plancore';
  const effectiveProjectDir = inputs.projectDir || process.cwd();
  let panel: PlannerPanel = inputs.panel || { size: 2 };
  // v93: when an availability probe is supplied and the panel has backups, swap unavailable
  // member CLIs for the next free backup before any spawn (seat-binary / auth check).
  if (inputs.isModelAvailable && panel.memberModels?.length && panel.backups?.length) {
    panel = await resolvePanelWithAvailability(panel, inputs.isModelAvailable);
  }
  const panelSize = Math.max(1, panel.size || 2);
  const fixture = inputs.fixture;
  const fake = isFakePath();
  const waitMs = fake ? 80 : parseInt(process.env.HELM_PLANNING_TIMEOUT_MS || '600000', 10);

  await fs.mkdir(path.join(runDir, 'prompts'), { recursive: true });
  await fs.mkdir(path.join(runDir, 'adaptive'), { recursive: true });
  await fs.mkdir(canonicalArtifactRoot, { recursive: true });

  // North-star: existing file wins
  const nsPath = path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.northStar);
  let effectiveNorthStar = inputs.northStar;
  try {
    effectiveNorthStar = await fs.readFile(nsPath, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    await writeFileSafe(nsPath, inputs.northStar);
  }

  const convPath = path.join(canonicalArtifactRoot, 'conversation-log.md');
  let effectiveConversationLog = inputs.conversationLog;
  try {
    effectiveConversationLog = await fs.readFile(convPath, 'utf8');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
    if (inputs.conversationLog) await writeFileSafe(convPath, inputs.conversationLog);
  }

  const cbPath = path.join(runDir, 'callbacks.md');
  try { await fs.access(cbPath); } catch { await writeFileSafe(cbPath, '# adaptive planning callbacks\n'); }

  const runIdEarly = inputs.runId ?? 0;
  const leadRole = 'lead_planner';
  const leadModel = panel.leadModel || inputs.planningBrainModel;
  const leadProvider = panel.leadProvider || inputs.planningBrainProvider;
  // Per-seat model/provider/effort after backup fallback. Model + provider always from the same slot.
  const seatModel = (i: number, fallback: string | undefined) =>
    panel.memberModels?.[i] || fallback;
  const seatProvider = (i: number, fallback: string | undefined) =>
    panel.memberProviders?.[i] || fallback;
  const seatEffort = (i: number): string | undefined =>
    panel.memberEfforts?.[i] || panel.defaultEffort;
  const leadEffort = seatEffort(0);

  // =========================================================================
  // STAGE 2 — skeleton dual-read gate
  // =========================================================================
  const skeletonBrief = briefWriter.generateLeadSkeletonBrief({
    batchId: `${batchId}-skeleton`,
    northStar: effectiveNorthStar,
    conversationLog: effectiveConversationLog,
    projectDir: effectiveProjectDir,
    callbacksFile: cbPath,
    runDir,
    canonicalArtifactRoot,
    adaptiveDir: path.join(runDir, 'adaptive'),
  });
  await artifacts.writeBrief(runDir, 'lead_planner-skeleton', skeletonBrief);
  recordStage(tel, 'skeleton', skeletonBrief);

  const skSpawn = await transport.spawn({
    role: leadRole,
    brief: bindDispatchNonce(skeletonBrief, createDispatchNonce()),
    runDir,
    batchId: `${batchId}-skeleton`,
    model: leadModel,
    provider: leadProvider,
    ...(leadEffort ? { effort: leadEffort } : {}),
    attemptId: 0,
    projectDir: effectiveProjectDir,
    ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}),
  });
  tel.spawn_count += 1;

  let skeleton = await waitForSkeleton(runDir, waitMs, fixture?.skeleton, effectiveNorthStar);
  skeleton = applyHeuristicAutoPromote(skeleton);
  await writeFileSafe(path.join(runDir, 'adaptive', 'skeleton.json'), JSON.stringify(skeleton, null, 2));
  try { await transport.reap(skSpawn.handle, 'skeleton-received'); } catch { /* */ }

  // ONE panelist challenges the CUT via closed Critique protocol
  const criticBrief = briefWriter.generateSkeletonCriticBrief({
    batchId: `${batchId}-sk-crit`,
    skeleton,
    projectDir: effectiveProjectDir,
    callbacksFile: cbPath,
    runDir,
    adaptiveDir: path.join(runDir, 'adaptive'),
  });
  await artifacts.writeBrief(runDir, 'skeleton-critic', criticBrief);
  recordStage(tel, 'skeleton_critique', criticBrief);

  const critSpawn = await transport.spawn({
    role: 'panelist',
    brief: bindDispatchNonce(criticBrief, createDispatchNonce()),
    runDir,
    batchId: `${batchId}-sk-crit`,
    model: seatModel(1, inputs.partnerModel),
    provider: seatProvider(1, inputs.partnerProvider),
    ...(seatEffort(1) ? { effort: seatEffort(1) } : {}),
    attemptId: 0,
    projectDir: effectiveProjectDir,
    ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}),
  });
  tel.spawn_count += 1;

  let skCritique = await waitForCritique(
    path.join(runDir, 'adaptive', 'critique-skeleton.json'),
    waitMs,
    fixture?.critique ?? (fake ? { verdict: 'ACCEPT', severity: 'soft', reasons: [] } : undefined),
  );
  try { await transport.reap(critSpawn.handle, 'skeleton-critique-received'); } catch { /* */ }

  // Re-cut on hard ESCALATE before the coverage gate (FIX 1: escalation includes re-cut)
  if (shouldEscalateTier(skCritique) && skCritique?.patch) {
    skeleton = applySkeletonPatch(skeleton, skCritique.patch);
    skeleton = applyHeuristicAutoPromote(skeleton);
    emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.TIER_ESCALATED, {
      from: 'skeleton',
      to: 'recut',
      reason: skCritique.reasons,
      stage: 'skeleton',
    }, batchId);
  } else if (skCritique?.verdict === 'AMEND' && skCritique.patch) {
    skeleton = applySkeletonPatch(skeleton, skCritique.patch);
  }

  const gate = evaluateSkeletonGate(skeleton);
  emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.SKELETON_GATE, {
    pass: gate.pass,
    coverage: gate.coverage,
    errors: gate.errors,
    uncoveredReqs: gate.uncoveredReqs,
    orphanDeps: gate.orphanDeps,
    task_count: skeleton.tasks.length,
    spawn_count: tel.spawn_count,
  }, batchId);

  if (!gate.pass) {
    emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.BLOCK, {
      stage: 'skeleton_gate',
      errors: gate.errors,
    }, batchId);
    throw new AdaptivePlanningBlockedError(
      `PLAN_SKELETON_GATE failed: ${gate.errors.join('; ')}`,
    );
  }

  await writeFileSafe(path.join(runDir, 'adaptive', 'skeleton.json'), JSON.stringify(skeleton, null, 2));

  // =========================================================================
  // STAGE 3 — batch-tier authoring (NEVER per-task spawns)
  // =========================================================================
  let partition = partitionByPlanDepth(skeleton.tasks);
  emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.TIER_ROUTED, {
    solo: partition.solo_set.map((t) => t.task_key),
    B: partition.B_set.map((t) => t.task_key),
    A: partition.A_set.map((t) => t.task_key),
    A_clusters: Object.fromEntries(
      Object.entries(partition.A_clusters).map(([k, v]) => [k, v.map((t) => t.task_key)]),
    ),
    histogram: {
      solo: partition.solo_set.length,
      pair: partition.B_set.length,
      panel: partition.A_set.length,
    },
  }, batchId);

  const authoredByKey = new Map<string, AuthoredTask>();

  // --- SOLO: lead authors the WHOLE solo_set in ONE pass + one cheap false-solo audit ---
  if (partition.solo_set.length > 0) {
    const soloBrief = briefWriter.generateTierAuthorBrief({
      batchId: `${batchId}-solo`,
      tier: 'solo',
      tasks: partition.solo_set,
      projectDir: effectiveProjectDir,
      callbacksFile: cbPath,
      runDir,
      adaptiveDir: path.join(runDir, 'adaptive'),
    });
    await artifacts.writeBrief(runDir, 'lead-solo', soloBrief);
    recordStage(tel, 'solo_author', soloBrief);
    const soloSpawn = await transport.spawn({
      role: leadRole,
      brief: bindDispatchNonce(soloBrief, createDispatchNonce()),
      runDir,
      batchId: `${batchId}-solo`,
      model: leadModel,
      provider: leadProvider,
      ...(leadEffort ? { effort: leadEffort } : {}),
      attemptId: 0,
      projectDir: effectiveProjectDir,
      ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}),
    });
    tel.spawn_count += 1;

    let soloAuthored = await waitForAuthoredSet(
      path.join(runDir, 'adaptive', 'authored-solo.json'),
      waitMs,
      partition.solo_set,
      // Synthesize authored rows only on fake path — real path waits or BLOCKs
      fake && fixture ? skeletonToAuthoredTasks(partition.solo_set) : undefined,
    );
    try { await transport.reap(soloSpawn.handle, 'solo-authored'); } catch { /* */ }

    // FIX 5 — one cheap binary audit over the solo_set only
    const auditBrief = briefWriter.generateSoloAuditBrief({
      batchId: `${batchId}-solo-audit`,
      tasks: partition.solo_set,
      authored: soloAuthored,
      projectDir: effectiveProjectDir,
      callbacksFile: cbPath,
      runDir,
      adaptiveDir: path.join(runDir, 'adaptive'),
    });
    await artifacts.writeBrief(runDir, 'solo-audit', auditBrief);
    recordStage(tel, 'solo_audit', auditBrief);
    const auditSpawn = await transport.spawn({
      role: 'panelist',
      brief: bindDispatchNonce(auditBrief, createDispatchNonce()),
      runDir,
      batchId: `${batchId}-solo-audit`,
      model: seatModel(1, inputs.partnerModel),
      provider: seatProvider(1, inputs.partnerProvider),
      ...(seatEffort(1) ? { effort: seatEffort(1) } : {}),
      attemptId: 0,
      projectDir: effectiveProjectDir,
      ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}),
    });
    tel.spawn_count += 1;
    const soloAudit = await waitForCritique(
      path.join(runDir, 'adaptive', 'critique-solo-audit.json'),
      waitMs,
      fixture?.soloAudit ?? (fake ? { verdict: 'ACCEPT', severity: 'soft', reasons: [] } : undefined),
    );
    try { await transport.reap(auditSpawn.handle, 'solo-audit-done'); } catch { /* */ }

    if (shouldEscalateTier(soloAudit)) {
      const keys = partition.solo_set.map((t) => t.task_key);
      const to = nextPlanDepth('solo', soloAudit);
      skeleton = {
        ...skeleton,
        tasks: escalateTaskDepths(skeleton.tasks, keys, to),
      };
      if (soloAudit?.patch) skeleton = applySkeletonPatch(skeleton, soloAudit.patch);
      emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.TIER_ESCALATED, {
        from: 'solo',
        to,
        reason: soloAudit?.reasons,
        task_keys: keys,
      }, batchId);
      // re-partition; escalated tasks leave solo for B/A authoring below
      partition = partitionByPlanDepth(skeleton.tasks);
      // drop solo authored for escalated keys — they will be re-authored at higher tier
      soloAuthored = soloAuthored.filter((t) =>
        partition.solo_set.some((s) => s.task_key === t.id),
      );
    }

    for (const t of soloAuthored) authoredByKey.set(t.id, t);
  }

  // --- B (pair): ONE pass — lead drafts whole B_set; one critic amends the set ---
  if (partition.B_set.length > 0) {
    const bBrief = briefWriter.generateTierAuthorBrief({
      batchId: `${batchId}-B`,
      tier: 'pair',
      tasks: partition.B_set,
      projectDir: effectiveProjectDir,
      callbacksFile: cbPath,
      runDir,
      adaptiveDir: path.join(runDir, 'adaptive'),
    });
    await artifacts.writeBrief(runDir, 'lead-B', bBrief);
    recordStage(tel, 'B_author', bBrief);
    const bSpawn = await transport.spawn({
      role: leadRole,
      brief: bindDispatchNonce(bBrief, createDispatchNonce()),
      runDir,
      batchId: `${batchId}-B`,
      model: leadModel,
      provider: leadProvider,
      ...(leadEffort ? { effort: leadEffort } : {}),
      attemptId: 0,
      projectDir: effectiveProjectDir,
      ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}),
    });
    tel.spawn_count += 1;

    let bAuthored = await waitForAuthoredSet(
      path.join(runDir, 'adaptive', 'authored-B.json'),
      waitMs,
      partition.B_set,
      // Synthesize authored rows only on fake path — real path waits or BLOCKs
      fake && fixture ? skeletonToAuthoredTasks(partition.B_set) : undefined,
    );
    try { await transport.reap(bSpawn.handle, 'B-drafted'); } catch { /* */ }

    const bCritBrief = briefWriter.generateTierCriticBrief({
      batchId: `${batchId}-B-crit`,
      tier: 'pair',
      tasks: partition.B_set,
      authored: bAuthored,
      projectDir: effectiveProjectDir,
      callbacksFile: cbPath,
      runDir,
      adaptiveDir: path.join(runDir, 'adaptive'),
    });
    await artifacts.writeBrief(runDir, 'B-critic', bCritBrief);
    recordStage(tel, 'B_critique', bCritBrief);
    const bCritSpawn = await transport.spawn({
      role: 'panelist',
      brief: bindDispatchNonce(bCritBrief, createDispatchNonce()),
      runDir,
      batchId: `${batchId}-B-crit`,
      model: seatModel(1, inputs.partnerModel),
      provider: seatProvider(1, inputs.partnerProvider),
      ...(seatEffort(1) ? { effort: seatEffort(1) } : {}),
      attemptId: 0,
      projectDir: effectiveProjectDir,
      ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}),
    });
    tel.spawn_count += 1;
    const bCritique = await waitForCritique(
      path.join(runDir, 'adaptive', 'critique-B.json'),
      waitMs,
      fixture?.bCritique ?? (fake ? { verdict: 'ACCEPT', severity: 'soft', reasons: [] } : undefined),
    );
    try { await transport.reap(bCritSpawn.handle, 'B-critique-done'); } catch { /* */ }

    if (bCritique?.verdict === 'AMEND' && bCritique.patch && Array.isArray((bCritique.patch as any).tasks)) {
      bAuthored = (bCritique.patch as any).tasks as AuthoredTask[];
    }

    if (shouldEscalateTier(bCritique)) {
      const keys = partition.B_set.map((t) => t.task_key);
      const to = nextPlanDepth('pair', bCritique);
      skeleton = {
        ...skeleton,
        tasks: escalateTaskDepths(skeleton.tasks, keys, to),
      };
      if (bCritique?.patch) skeleton = applySkeletonPatch(skeleton, bCritique.patch);
      emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.TIER_ESCALATED, {
        from: 'pair',
        to,
        reason: bCritique?.reasons,
        task_keys: keys,
      }, batchId);
      partition = partitionByPlanDepth(skeleton.tasks);
      bAuthored = bAuthored.filter((t) => partition.B_set.some((s) => s.task_key === t.id));
    }

    for (const t of bAuthored) authoredByKey.set(t.id, t);
  }

  // --- A (panel): ONE pass per affinity cluster — panel drafts INDEPENDENTLY in PARALLEL ---
  partition = partitionByPlanDepth(skeleton.tasks);
  for (const [affinity, cluster] of Object.entries(partition.A_clusters)) {
    if (cluster.length === 0) continue;
    const seats = Math.max(2, Math.min(panelSize, 3));
    const seatBriefs: string[] = [];
    const seatSpawns: Array<{ handle: string; role: string; seat: number }> = [];

    // PARALLEL seats (FIX 2: not sequential PanelService)
    const spawnPromises = [];
    for (let i = 0; i < seats; i++) {
      const aBrief = briefWriter.generateTierAuthorBrief({
        batchId: `${batchId}-A-${affinity}-${i}`,
        tier: 'panel',
        tasks: cluster,
        seat: i,
        projectDir: effectiveProjectDir,
        callbacksFile: cbPath,
        runDir,
        adaptiveDir: path.join(runDir, 'adaptive'),
      });
      seatBriefs.push(aBrief);
      await artifacts.writeBrief(runDir, `A-${affinity}-seat-${i}`, aBrief);
      recordStage(tel, `A_${affinity}_seat_${i}`, aBrief);
      spawnPromises.push(
        transport.spawn({
          role: i === 0 ? leadRole : 'panelist',
          brief: bindDispatchNonce(aBrief, createDispatchNonce()),
          runDir,
          batchId: `${batchId}-A-${affinity}-${i}`,
          model: seatModel(i, i === 0 ? leadModel : inputs.partnerModel),
          provider: seatProvider(i, i === 0 ? leadProvider : inputs.partnerProvider),
          ...(seatEffort(i) ? { effort: seatEffort(i) } : {}),
          attemptId: 0,
          projectDir: effectiveProjectDir,
          ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}),
        }).then((s) => {
          tel.spawn_count += 1;
          seatSpawns.push({ handle: s.handle, role: s.role, seat: i });
          return s;
        }),
      );
    }
    await Promise.all(spawnPromises); // parallel convene

    const drafts: AuthoredTask[][] = [];
    for (let i = 0; i < seats; i++) {
      // Explicit aDrafts always win (tests may inject conflicting seats on real path).
      // Skeleton→authored synthesis is fake-path only.
      const fixtureDraft = fixture?.aDrafts?.[i]
        ?? (fake && fixture ? skeletonToAuthoredTasks(cluster, `A-${affinity}`) : undefined);
      // If forceDeadlock, make seat drafts disagree on titles
      let forced = fixtureDraft;
      if (fixture?.forceDeadlock && fixtureDraft && i > 0) {
        forced = fixtureDraft.map((t) => ({ ...t, title: `${t.title} [seat-${i} alt]` }));
      }
      const draft = await waitForAuthoredSet(
        path.join(runDir, 'adaptive', `authored-A-${affinity}-seat-${i}.json`),
        waitMs,
        cluster,
        forced,
      );
      drafts.push(draft);
    }

    for (const s of seatSpawns) {
      try { await transport.reap(s.handle, `A-${affinity}-seat-done`); } catch { /* */ }
    }

    // Reconcile once
    let reconciled = fixture?.aReconcile;
    if (!reconciled) {
      const settlePairNames: [string, string] = [
        panel.leadModel || panel.memberModels?.[0] || 'planner_01',
        panel.memberModels?.[1] || inputs.partnerModel || 'planner_02',
      ];
      const needsJrom = !!fixture?.forceNeedsJrom;

      // Probe: consensus vs deadlock (no settle content yet)
      const probe = resolvePanelDeadlock({
        drafts,
        settlePairTasks: null,
        needsJrom,
        settlePairNames,
      });

      let settlePairTasks: AuthoredTask[] | null | undefined = fixture?.settleTasks;
      // Fake non-deadlock: accept first draft as consensus (seats write identical fixture slices)
      if (!settlePairTasks && fake && !fixture?.forceDeadlock && probe.action === 'settle') {
        settlePairTasks = drafts[0];
      }

      // REAL PATH: on A-cluster deadlock, spawn the NAMED settle-pair and wait for their artifact.
      // plancore still authors no prose — the settle-pair models write settled tasks.
      if (
        !settlePairTasks
        && !needsJrom
        && probe.action === 'block'
        && /deadlock/.test(probe.reason)
        && !fake
      ) {
        const settleOut = path.join(runDir, 'adaptive', `authored-A-${affinity}-settle.json`);
        const settleBrief = briefWriter.generateSettlePairBrief({
          batchId: `${batchId}-A-${affinity}-settle`,
          affinity,
          drafts,
          tasks: cluster,
          settlePairNames,
          projectDir: effectiveProjectDir,
          callbacksFile: cbPath,
          runDir,
          adaptiveDir: path.join(runDir, 'adaptive'),
          outFile: settleOut,
        });
        await artifacts.writeBrief(runDir, `A-${affinity}-settle-pair`, settleBrief);
        recordStage(tel, `A_${affinity}_settle`, settleBrief);

        const settleSpawns = await Promise.all(
          settlePairNames.map((model, i) =>
            transport.spawn({
              role: i === 0 ? leadRole : 'panelist',
              brief: bindDispatchNonce(settleBrief, createDispatchNonce()),
              runDir,
              batchId: `${batchId}-A-${affinity}-settle-${i}`,
              model,
              provider: seatProvider(i, i === 0 ? leadProvider : inputs.partnerProvider),
              ...(seatEffort(i) ? { effort: seatEffort(i) } : {}),
              attemptId: 0,
              projectDir: effectiveProjectDir,
              ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}),
            }).then((s) => {
              tel.spawn_count += 1;
              return s;
            }),
          ),
        );

        try {
          settlePairTasks = await waitForAuthoredSet(
            settleOut,
            waitMs,
            cluster,
            undefined,
          );
        } catch (err) {
          for (const s of settleSpawns) {
            try { await transport.reap(s.handle, `A-${affinity}-settle-failed`); } catch { /* */ }
          }
          emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.BLOCK, {
            stage: 'A_settle_pair',
            affinity,
            reason: err instanceof Error ? err.message : String(err),
            settle_pair: settlePairNames,
          }, batchId);
          throw err;
        }

        for (const s of settleSpawns) {
          try { await transport.reap(s.handle, `A-${affinity}-settle-done`); } catch { /* */ }
        }
      }

      const settle = resolvePanelDeadlock({
        drafts,
        settlePairTasks: settlePairTasks ?? null,
        needsJrom,
        settlePairNames,
      });

      if (settle.action === 'block') {
        emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.BLOCK, {
          stage: 'A_reconcile',
          affinity,
          reason: settle.reason,
        }, batchId);
        throw new AdaptivePlanningBlockedError(`PLAN_BLOCK: ${settle.reason}`);
      }

      if (settle.dissent) {
        emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.SETTLE, {
          affinity,
          dissent: settle.dissent,
          reason: settle.reason,
          settle_pair: settlePairNames,
        }, batchId);
      }
      reconciled = settle.settledTasks || drafts[0];
    }

    for (const t of reconciled) authoredByKey.set(t.id, t);
  }

  // Fill missing authored rows ONLY on fake/fixture path (USE_FAKE_TMUX test synthesis).
  // Real path: any task_key without an authored slice is HARD BLOCK — never invent prose.
  const missingAuthoredKeys: string[] = [];
  for (const t of skeleton.tasks) {
    if (!authoredByKey.has(t.task_key)) {
      if (fake) {
        authoredByKey.set(t.task_key, skeletonToAuthoredTasks([t])[0]);
      } else {
        missingAuthoredKeys.push(t.task_key);
      }
    }
  }
  if (missingAuthoredKeys.length > 0) {
    emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.BLOCK, {
      stage: 'authored_coverage',
      missing_task_keys: missingAuthoredKeys,
      reason: 'missing authored slices — plancore never synthesizes task prose',
    }, batchId);
    throw new AdaptivePlanningBlockedError(
      `PLAN_BLOCK: missing authored slices for task_keys: ${missingAuthoredKeys.join(', ')} (plancore never synthesizes task prose)`,
    );
  }

  const allAuthored = skeleton.tasks.map((t) => authoredByKey.get(t.task_key)!).filter(Boolean);

  // =========================================================================
  // STAGE 4 — lead INTEGRATOR + plancore STRUCTURAL gates only
  // =========================================================================
  const integBrief = briefWriter.generateIntegratorBrief({
    batchId: `${batchId}-integrate`,
    authored: allAuthored,
    requirements: skeleton.requirements,
    projectDir: effectiveProjectDir,
    callbacksFile: cbPath,
    runDir,
    canonicalArtifactRoot,
    adaptiveDir: path.join(runDir, 'adaptive'),
  });
  await artifacts.writeBrief(runDir, 'lead-integrator', integBrief);
  recordStage(tel, 'integrate', integBrief);
  const integSpawn = await transport.spawn({
    role: leadRole,
    brief: bindDispatchNonce(integBrief, createDispatchNonce()),
    runDir,
    batchId: `${batchId}-integrate`,
    model: leadModel,
    provider: leadProvider,
    ...(leadEffort ? { effort: leadEffort } : {}),
    attemptId: 0,
    projectDir: effectiveProjectDir,
    ...(inputs.strictReadAllow ? { strictReadAllow: inputs.strictReadAllow } : {}),
  });
  tel.spawn_count += 1;

  const planMdPath = path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.plan);
  const reqPath = path.join(canonicalArtifactRoot, CANONICAL_CYCLE_ARTIFACTS.requirements);

  // Lead (or fixture) writes the SAME schema plan.md + og-requirements.md
  let planMarkdown = fixture?.planMarkdown;
  let requirementsMarkdown = fixture?.requirementsMarkdown;
  if (!planMarkdown || !requirementsMarkdown) {
    // poll briefly for agent-authored files; then assemble (integrator role — lead, not plancore prose)
    const pollEnd = Date.now() + Math.min(waitMs, fake ? 80 : 30_000);
    while (Date.now() < pollEnd) {
      try {
        planMarkdown = await fs.readFile(planMdPath, 'utf8');
        requirementsMarkdown = await fs.readFile(reqPath, 'utf8');
        if (planMarkdown && requirementsMarkdown) break;
      } catch { /* keep polling */ }
      await sleep(fake ? 10 : 500);
    }
  }
  if (!planMarkdown) {
    planMarkdown = renderPlanMarkdown(allAuthored);
  }
  if (!requirementsMarkdown) {
    requirementsMarkdown = renderRequirementsMarkdown(skeleton.requirements, allAuthored);
  }
  await writeFileSafe(planMdPath, planMarkdown);
  await writeFileSafe(reqPath, requirementsMarkdown);
  try { await transport.reap(integSpawn.handle, 'integrated'); } catch { /* */ }

  // plancore STRUCTURAL gates only — never writes task prose, never settles content
  const structural = runStructuralGates(planMarkdown, requirementsMarkdown);
  if (!structural.pass) {
    emitEvent(artifacts, runIdEarly || inputs.runId, ADAPTIVE_PLAN_EVENTS.BLOCK, {
      stage: 'structural',
      errors: structural.errors,
    }, batchId);
    throw new AdaptivePlanningBlockedError(
      `structural gates failed: ${structural.errors.join('; ')}`,
    );
  }

  // Validate + normalize for return
  const validated = validateExecutionPlan(planMarkdown);
  if (!validated.ok) {
    throw new AdaptivePlanningBlockedError(`post-gate plan invalid: ${validated.errors.join('; ')}`);
  }
  const plan: Plan = { tasks: validated.normalizedTasks as unknown as PlannedTask[] };

  // Driver marker: PLAN-READY (plancore emits procedure callback only — no prose authoring)
  await fs.appendFile(
    cbPath,
    `[helm callback] ${brainRole} ${batchId} STATUS: PLAN-READY — adaptive tiered plan integrated; see og-requirements.md + plan.md\n`,
    'utf8',
  );

  await materializeCanonicalArtifactSet(canonicalArtifactRoot, runDir);
  const rid = inputs.runId ?? artifacts.createRun(inputs.projectId ?? null, batchId, nsPath);

  emitEvent(artifacts, rid, ADAPTIVE_PLAN_EVENTS.STAGE_TOKENS, {
    plan_tokens_by_stage: tel.plan_tokens_by_stage,
    spawn_count: tel.spawn_count,
    stages: tel.stages,
  }, batchId);

  const { createdTaskIds, keyToId } = await parser.ingestExecutionPlan(rid, planMarkdown, taskQueue, runDir);

  return {
    agreed: true,
    coPlannerUsed: 'deliberation', // adaptive always multi-read (panel path)
    northStarPath: nsPath,
    reqPath,
    planJsonPath: path.join(runDir, 'plan.json'),
    planMdPath,
    plan,
    createdTaskIds,
    keyToId,
    runId: rid,
  };
}

// ---------------------------------------------------------------------------
// Wait helpers (file-based closed protocol; fixture short-circuit under fake)
// ---------------------------------------------------------------------------

async function waitForSkeleton(
  runDir: string,
  waitMs: number,
  fixture: PlanSkeleton | undefined,
  northStar: string,
): Promise<PlanSkeleton> {
  if (fixture) return fixture;
  const p = path.join(runDir, 'adaptive', 'skeleton.json');
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    const data = await readJsonIfExists<PlanSkeleton>(p);
    if (data?.tasks?.length) return data;
    await sleep(isFakePath() ? 10 : 400);
  }
  // Fake/default synthesis so tests and smoke can complete without live agents
  if (isFakePath()) {
    return synthesizeSkeletonFromNorthStar(northStar);
  }
  throw new AdaptivePlanningBlockedError('lead_planner did not produce adaptive/skeleton.json');
}

async function waitForCritique(
  filePath: string,
  waitMs: number,
  fixture: Critique | undefined,
): Promise<Critique | null> {
  if (fixture) {
    await writeFileSafe(filePath, JSON.stringify(fixture, null, 2));
    return fixture;
  }
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    try {
      const raw = await fs.readFile(filePath, 'utf8');
      const c = parseCritique(raw);
      if (c) return c;
    } catch { /* */ }
    await sleep(isFakePath() ? 10 : 400);
  }
  if (isFakePath()) {
    const accept: Critique = { verdict: 'ACCEPT', severity: 'soft', reasons: [] };
    await writeFileSafe(filePath, JSON.stringify(accept, null, 2));
    return accept;
  }
  return null;
}

async function waitForAuthoredSet(
  filePath: string,
  waitMs: number,
  skeletonTasks: SkeletonTask[],
  fixture: AuthoredTask[] | undefined,
): Promise<AuthoredTask[]> {
  if (fixture) {
    await writeFileSafe(filePath, JSON.stringify(fixture, null, 2));
    return fixture;
  }
  const end = Date.now() + waitMs;
  while (Date.now() < end) {
    const data = await readJsonIfExists<AuthoredTask[]>(filePath);
    if (Array.isArray(data) && data.length) return data;
    await sleep(isFakePath() ? 10 : 400);
  }
  if (isFakePath()) {
    // Fake/fixture path only: synthesize so tests complete without live agents
    const tasks = skeletonToAuthoredTasks(skeletonTasks);
    await writeFileSafe(filePath, JSON.stringify(tasks, null, 2));
    return tasks;
  }
  // Real path: missing authored-output file is HARD BLOCK — never synthesize task prose
  const missing = skeletonTasks.map((t) => t.task_key);
  throw new AdaptivePlanningBlockedError(
    `PLAN_BLOCK: missing authored output for task_keys: ${missing.join(', ')} (plancore never synthesizes task prose)`,
  );
}

/** Deterministic fixture skeleton derived from north-star text (fake path only). */
export function synthesizeSkeletonFromNorthStar(northStar: string): PlanSkeleton {
  const requirements = ['R-01', 'R-02'];
  const isCross = /cross|schema|arch|ambiguous|security/i.test(northStar);
  const tasks: SkeletonTask[] = [
    {
      task_key: 'T01',
      intent: 'Scaffold module and types from north-star',
      plan_depth: 'solo',
      depth_vector: {
        cross_cutting: false, ambiguity: false, blast_radius: 'low', novelty: false,
      },
      complexity: 'med',
      deps: [],
      req_refs: ['R-01'],
    },
    {
      task_key: 'T02',
      intent: isCross
        ? 'Implement cross-cutting integration contract'
        : 'Implement core feature logic',
      plan_depth: isCross ? 'panel' : 'pair',
      depth_vector: {
        cross_cutting: isCross,
        ambiguity: isCross,
        blast_radius: isCross ? 'high' : 'med',
        novelty: false,
      },
      complexity: isCross ? 'high' : 'med',
      deps: ['T01'],
      req_refs: ['R-02'],
      affinity: isCross ? 'core' : undefined,
    },
  ];
  return { tasks, requirements };
}
