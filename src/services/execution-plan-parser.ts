/**
 * B3-T04: Parse execution_plan.md fenced JSON task array (helm-algo machine contract).
 * Standalone from PlanParserService (B9 run plan.json schema).
 *
 * sol send-back #3 (2026-07-17): this module is now the SINGLE shared validation pipeline. `validateExecutionPlan`
 * runs EVERY check ingestion requires (structural + semantic + cross-task + cycle + canonical machine-plan schema)
 * as a PURE function (no DB, no queue) and returns the fully-normalized tasks. Both the UI gate (parseExecutionPlan
 * → execDoc.valid) and ingestion (PlanParserService.ingestExecutionPlan) consume it, so `execDoc.valid === true`
 * ⟺ `ingestExecutionPlan` succeeds BY CONSTRUCTION — no check lives in ingest that isn't in the validator, and no
 * coercion/normalization lives in the validator that ingest doesn't honor (ingest uses the same normalizedTasks).
 */
import { validateMachinePlan, MACHINE_TASK_TYPES, type MachinePlanTask } from './plan-schema.js';

export interface ExecutionPlanTask {
  id: string;
  batch: string;
  title: string;
  req_refs: string[];
  assignee: string;
  validator_lane?: string;
  effort: string;
  type: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Leg D (batch barrier) — batch as first-class durable ordering state.
//
// `execution-plan-parser` OWNS batch validity + order-compatibility. The three helpers below are the
// single source of truth consumed by BOTH the shared validator (validateExecutionPlan, canonical path)
// AND ingestion (PlanParserService.ingestPlan, canonical + legacy machine-plan.json paths):
//   • compareBatchLabels — the deterministic numeric-aware natural-order comparator (never plan-array,
//     never task-key). B2 < B10; case-folded non-digit runs; full-string tie-break.
//   • resolveTaskBatches — all-labeled → trimmed labels; all-unlabeled → synthetic 'default' (legacy
//     single-queue behavior); MIXED (some labeled, some not) → REJECT (barrier-bypass risk).
//   • validateBatchDependencies — reject an explicit dep from an EARLIER batch onto a LATER batch
//     (same-batch and later-onto-earlier deps stay valid).
// ---------------------------------------------------------------------------

/** The synthetic single batch every task of an all-unlabeled legacy plan resolves to. */
export const DEFAULT_BATCH = 'default';

/**
 * Deterministic numeric-aware natural-order comparator for batch labels (Leg D §2). NEVER plan-array
 * order, NEVER task-key order. Returns <0 if a is earlier, >0 if later, 0 if equal.
 *   1. trim; 2. split into alternating digit / non-digit runs; 3. compare digit runs by INTEGER
 *   magnitude (so B2 < B10, overflow-safe via zero-stripped length-then-lex), non-digit runs by
 *   case-folded code-point order; 4. natural tokens equal → tie-break on the full normalized string.
 * When one run is a digit run and the other is a non-digit run at the same position, a digit run
 * sorts before a non-digit run (deterministic; edge case — planners use ordinal B1/B2/… when sequence
 * matters). A shorter token stream sorts before a longer one that shares its prefix.
 */
export function compareBatchLabels(a: string, b: string): number {
  const na = String(a ?? '').trim();
  const nb = String(b ?? '').trim();
  const ta = na.match(/\d+|\D+/g) ?? [];
  const tb = nb.match(/\d+|\D+/g) ?? [];
  const len = Math.max(ta.length, tb.length);
  for (let i = 0; i < len; i++) {
    const xa = ta[i];
    const xb = tb[i];
    if (xa === undefined) return -1; // a exhausted first → shorter sorts first
    if (xb === undefined) return 1;
    const da = /^\d/.test(xa);
    const db = /^\d/.test(xb);
    if (da && db) {
      // integer magnitude, overflow-safe: strip leading zeros, compare by length then lexically.
      const ia = xa.replace(/^0+(?=\d)/, '');
      const ib = xb.replace(/^0+(?=\d)/, '');
      if (ia.length !== ib.length) return ia.length < ib.length ? -1 : 1;
      if (ia !== ib) return ia < ib ? -1 : 1;
    } else if (!da && !db) {
      const la = xa.toLowerCase();
      const lb = xb.toLowerCase();
      if (la !== lb) return la < lb ? -1 : 1;
    } else {
      // mixed run types at the same position: digit run before non-digit run.
      return da ? -1 : 1;
    }
  }
  // Natural tokens compare equal → deterministic tie-break on the full normalized string.
  if (na !== nb) return na < nb ? -1 : 1;
  return 0;
}

export type BatchResolution =
  | { ok: true; batches: string[] }        // index-aligned resolved batch per task
  | { ok: false; error: string };

/**
 * Resolve a durable batch for every task (Leg D §2). Index-aligned with the input.
 *   • ALL tasks carry a non-empty (trimmed) batch → use those trimmed labels.
 *   • NONE carry a batch → every task resolves to the synthetic '${DEFAULT_BATCH}' batch (legacy
 *     single-queue behavior; no barrier beyond explicit deps).
 *   • MIXED (some labeled, some not) → REJECT: a silently-unlabeled task would bypass the barrier.
 */
export function resolveTaskBatches(tasks: ReadonlyArray<Record<string, unknown>>): BatchResolution {
  const raw = tasks.map((t) => {
    const b = (t as any)?.batch;
    if (b === null || b === undefined) return null;
    const s = String(b).trim();
    return s === '' ? null : s;
  });
  const labeled = raw.filter((b) => b !== null).length;
  if (labeled === 0) return { ok: true, batches: raw.map(() => DEFAULT_BATCH) };
  if (labeled === tasks.length) return { ok: true, batches: raw as string[] };
  return {
    ok: false,
    error: `mixed batch labeling: ${labeled}/${tasks.length} tasks carry a batch label — a plan must label ALL tasks or NONE (a silently-unlabeled task would bypass the batch barrier)`,
  };
}

/**
 * Reject an explicit dependency from an EARLIER batch onto a LATER batch (Leg D §2). Same-batch deps
 * and later-onto-earlier deps stay valid. `batchByKey` maps each task_key/id to its resolved batch.
 * Returns the list of violation messages (empty = OK). Unknown-batch deps are skipped here (dangling
 * refs are caught by the id/dep validator).
 */
export function validateBatchDependencies(
  tasks: ReadonlyArray<Record<string, unknown>>,
  batchByKey: Record<string, string>,
): string[] {
  const errors: string[] = [];
  for (const t of tasks) {
    const key = String((t as any)?.task_key ?? (t as any)?.id ?? '');
    const tb = batchByKey[key];
    if (tb == null) continue;
    const deps = Array.isArray((t as any)?.deps) ? (t as any).deps : [];
    for (const d of deps) {
      const dk = String(d);
      const db = batchByKey[dk];
      if (db == null) continue;
      // task is in an EARLIER batch than its dependency (dep in a LATER batch) → invalid.
      if (compareBatchLabels(tb, db) < 0) {
        errors.push(
          `task '${key}' (batch ${tb}) declares a dependency on '${dk}' (batch ${db}) — an earlier-batch task cannot depend on a later-batch task (batch barrier direction)`,
        );
      }
    }
  }
  return errors;
}

export const EXECUTION_PLAN_REQUIRED_FIELDS = [
  'id',
  'batch',
  'title',
  'req_refs',
  'assignee',
  'validator_lane',
  'effort',
  'type'
] as const;

export type ExecutionPlanRequiredField = (typeof EXECUTION_PLAN_REQUIRED_FIELDS)[number];

export type NormalizedEffort = 'low' | 'med' | 'high' | 'xhigh';

/**
 * SINGLE SOURCE OF TRUTH for the execution-plan `effort` enum, shared by BOTH the schema validator
 * (parseExecutionPlan → drives the UI `execDoc.valid` gate) AND ingestion (PlanParserService._normEffort).
 * Returns the canonical enum value or {ok:false}. Because both callers use this, `execDoc.valid === true`
 * GUARANTEES ingestion accepts the same effort — the button and ingest can never diverge on effort.
 * Accepts case-aware T-shirt sizes (XS/S→low, M→med, L→high, XL→xhigh; lowercase legacy `l`→low preserved)
 * and the common word/lane aliases; everything else is a hard reject.
 */
export function normalizeEffort(v: unknown): { ok: true; value: NormalizedEffort } | { ok: false } {
  // Exact UPPERCASE T-shirt tokens resolved on the RAW value BEFORE lowercasing, so uppercase `L` (Large→high)
  // is distinguished from legacy lowercase `l` (→low). ONLY exact uppercase tokens qualify.
  const rawTs = String(v ?? '').trim();
  if (rawTs === 'XS' || rawTs === 'S') return { ok: true, value: 'low' };
  if (rawTs === 'M') return { ok: true, value: 'med' };
  if (rawTs === 'L') return { ok: true, value: 'high' };
  if (rawTs === 'XL') return { ok: true, value: 'xhigh' };
  const s = String(v ?? '').toLowerCase().trim();
  if (/^l1\b/.test(s) || s === 'routine' || s === 'simple' || s === 'easy' || s === 'small' || s === 'tiny') return { ok: true, value: 'low' };
  if (/^l2\b/.test(s) || s === 'hard' || s === 'complex') return { ok: true, value: 'high' };
  if (/^l[34]\b/.test(s)) return { ok: true, value: 'xhigh' };
  if (s === 'medium' || s === 'mid' || s === 'moderate' || s === 'normal') return { ok: true, value: 'med' };
  if (s === 'l') return { ok: true, value: 'low' };
  if (s === 'h') return { ok: true, value: 'high' };
  if (s === 'xh' || s === 'extra-high' || s === 'very-high' || s === 'highest') return { ok: true, value: 'xhigh' };
  if (s === 'xs' || s === 's' || s === 'x-small' || s === 'extra-small') return { ok: true, value: 'low' };
  if (s === 'xl' || s === 'x-large' || s === 'extra-large') return { ok: true, value: 'xhigh' };
  if (s === 'low' || s === 'med' || s === 'high' || s === 'xhigh') return { ok: true, value: s as NormalizedEffort };
  return { ok: false };
}

/** Shared `type` domain — feature|issue (MACHINE_TASK_TYPES). Reject anything else instead of silently → feature. */
export function normalizeType(v: unknown): { ok: true; value: 'feature' | 'issue' } | { ok: false } {
  const s = String(v ?? '').toLowerCase().trim();
  return (MACHINE_TASK_TYPES as readonly string[]).includes(s) ? { ok: true, value: s as 'feature' | 'issue' } : { ok: false };
}

// Role/lane labels that are REJECTED as an execution-plan assignee/validator_lane (shakedown-5). The planning
// brief tells the planner to use L1|L2|L3|L4 (or a model slug); a role label has no rung and no model, so the
// normalized execution-task schema cannot persist it → accepting it would drop the assignment. We reject them
// EXPLICITLY (before the model-slug fallback, which would otherwise read "validator" as a model). This list is
// execution-plan-specific and disambiguates role-words from launchable model slugs.
export const EXECUTION_PLAN_ROLE_LABELS = [
  'plancore', 'ibrain', 'co-planner', 'coplanner', 'planner',
  'implementer', 'routine-implementer', 'routine implementer',
  'validator', 'reviewer', 'qa', 'tester',
  'redteam', 'red-team', 'panelist',
  'coord', 'coordinator', 'lead', 'dev', 'developer', 'arch', 'sysarch',
] as const;
const ROLE_LABEL_SET = new Set<string>(EXECUTION_PLAN_ROLE_LABELS);

export type AssigneeClass =
  | { ok: true; kind: 'rung'; rung: 0 | 1 | 2 | 3 }
  | { ok: true; kind: 'model'; model: string }
  | { ok: false };

/**
 * Execution-plan `assignee` / `validator_lane` domain classifier. TERMINAL invariant (shakedown-5): every
 * ACCEPTED result is FULLY REPRESENTABLE + PERSISTED — exactly one of:
 *   - kind 'rung'  → a lane rung (L1→0, L2→1, L3→2, L4→3), the ONLY accepted lane forms, or
 *   - kind 'model' → a launchable model slug (recognized family, or a general slug that STARTS WITH A LETTER).
 * There is NO third "accepted" kind, so there is no accept-branch that can be dropped at ingest. Everything else
 * is REJECTED, including: an out-of-range lane `Ln` (L0/L5/L12/… — no rung to represent it), a **role/lane label**
 * (implementer/validator/reviewer/… — the brief says use L1|L2|L3|L4; a label has no rung and no model, so the
 * execution-task schema cannot persist it — don't accept what you can't persist), a bare-numeric string ("2"),
 * the empty string, and junk. Ingestion consumes this classification verbatim, so the button and ingest agree.
 */
export function classifyAssignee(v: unknown): AssigneeClass {
  const raw = String(v ?? '').trim();
  if (raw === '') return { ok: false };
  const s = raw.toLowerCase();
  // Lanes — L1/L2/L3/L4 (each → a representable rung). B6a/AC-9: L4 → rung 3 (optional at runtime).
  if (/^l1(?:[-_\s].*)?$/.test(s)) return { ok: true, kind: 'rung', rung: 0 };
  if (/^l2(?:[-_\s].*)?$/.test(s)) return { ok: true, kind: 'rung', rung: 1 };
  if (/^l3(?:[-_\s].*)?$/.test(s)) return { ok: true, kind: 'rung', rung: 2 };
  if (/^l4(?:[-_\s].*)?$/.test(s)) return { ok: true, kind: 'rung', rung: 3 };
  // Lane-shaped but NOT L1–L4 (L0/L5/L12/…): no rung to represent it → REJECT.
  if (/^l\d/.test(s)) return { ok: false };
  // Role/lane labels are NOT representable in the execution-task schema → REJECT (before the model-slug fallback,
  // which would otherwise read "validator" as a model). shakedown-5: no binding accept-branch.
  if (ROLE_LABEL_SET.has(s)) return { ok: false };
  // Recognized model families, then a general launchable model slug (MUST start with a letter → a bare-numeric
  // "2"/"10" is rejected, not read as a model).
  if (s === 'sonnet' || /^claude-sonnet(?:[-_\s].*)?$/.test(s)) return { ok: true, kind: 'model', model: 'claude-sonnet' };
  if (s === 'opus' || /^claude-opus(?:[-_\s].*)?$/.test(s)) return { ok: true, kind: 'model', model: 'claude-opus' };
  if (s === 'grok') return { ok: true, kind: 'model', model: 'grok-4.5' };
  if (s === 'grok-composer' || s === 'grok-composer-2.5-fast') return { ok: true, kind: 'model', model: 'grok-composer-2.5-fast' };
  if (/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/i.test(raw)) return { ok: true, kind: 'model', model: raw };
  return { ok: false };
}

/** The fully-normalized task ingestion consumes (identical field shape to PlannedTask's relevant fields). */
export interface NormalizedExecutionTask {
  task_key: string;
  atomic_work: string;
  req_refs: string[];
  complexity: NormalizedEffort;
  effort: NormalizedEffort;
  needs_more_info: boolean;
  task_type: 'feature' | 'issue';
  validation_criteria: string;
  deps: string[];
  user_critical: boolean;
  recommended_model?: string;
  recommended_rung?: 0 | 1 | 2 | 3;
  validator_rung?: 0 | 1 | 2 | 3;
  validator_model?: string;
  batch?: string;
  [key: string]: unknown;
}

export type ParseExecutionPlanResult =
  | { ok: true; tasks: ExecutionPlanTask[] }
  | { ok: false; errors: string[] };

function taskLabel(index: number, task: unknown): string {
  if (task && typeof task === 'object' && typeof (task as ExecutionPlanTask).id === 'string') {
    return `task[${index}] (${(task as ExecutionPlanTask).id})`;
  }
  return `task[${index}]`;
}

function validateTask(task: unknown, index: number, errors: string[]): void {
  const label = taskLabel(index, task);
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    errors.push(`${label}: must be an object`);
    return;
  }
  const row = task as Record<string, unknown>;
  for (const field of EXECUTION_PLAN_REQUIRED_FIELDS) {
    if (!(field in row) || row[field] === null || row[field] === undefined) {
      errors.push(`${label}: missing required field '${field}'`);
      continue;
    }
    if (field === 'req_refs') {
      // Light-model type-variance (2026-07-17): a single requirement emitted as a bare string ("R-1")
      // instead of a 1-element array (["R-1"]). Coerce the unambiguous scalar-string form to [string]
      // IN PLACE so the plan validates and ingest carries a string[]. A number, object, or mixed/non-string
      // array stays a hard reject.
      if (typeof row.req_refs === 'string' && row.req_refs.trim() !== '') {
        row.req_refs = [row.req_refs];
      }
      if (!Array.isArray(row.req_refs)) {
        errors.push(`${label}: field 'req_refs' must be an array of strings (or a single string)`);
      } else if (!row.req_refs.every((r) => typeof r === 'string')) {
        errors.push(`${label}: field 'req_refs' must be an array of strings`);
      }
      continue;
    }
    // Numeric→string coercion is restricted to an EXPLICIT ALLOWLIST — ONLY `batch`, the one field the
    // planner legitimately emits as a number ("batch": 1). Coerce a FINITE number IN PLACE → String(n) so the
    // plan validates AND downstream carries a string. Every OTHER scalar field is NOT coerced from a number:
    // a numeric id/effort/type/assignee/validator_lane stays a number → the non-string check below rejects it.
    // (Rationale: coercing them created UI↔ingest divergence — numeric effort passed validation then threw at
    // ingest; numeric assignee/type were silently reinterpreted to a DIFFERENT meaning. sol send-back #2.)
    if (field === 'batch' && typeof row.batch === 'number' && Number.isFinite(row.batch)) {
      row.batch = String(row.batch);
    }
    // Non-empty AFTER trim (Finding 1): a whitespace-only id/title/etc previously passed validation then threw
    // at ingest's canonical machine-plan schema (`.trim()` there). Trim-check HERE so validation matches ingest.
    if (typeof row[field] !== 'string' || (row[field] as string).trim() === '') {
      errors.push(`${label}: field '${field}' must be a non-empty string`);
      continue;
    }
    // SEMANTIC domain validation unified with ingestion (Finding 2) via the SHARED normalizers ingestion also
    // uses — so `execDoc.valid` matches the ingest outcome (no valid-but-ingest-throws / valid-but-reinterpret):
    // • effort must resolve to the enum (normalizeEffort — same fn as ingest's _normEffort);
    // • type must be feature|issue (not silently coerced to feature);
    // • assignee/validator_lane must be an in-domain lane (L1|L2|L3|L4) or model slug (rejects role labels, bare-numeric "2", out-of-range Ln, etc).
    if (field === 'effort' && !normalizeEffort(row.effort).ok) {
      errors.push(`${label}: invalid effort '${String(row.effort)}' (must be low|med|high|xhigh or a recognized alias)`);
    }
    if (field === 'type' && !normalizeType(row.type).ok) {
      errors.push(`${label}: invalid type '${String(row.type)}' (must be feature|issue)`);
    }
    if ((field === 'assignee' || field === 'validator_lane') && !classifyAssignee(row[field]).ok) {
      errors.push(`${label}: invalid ${field} '${String(row[field])}' (must be a lane L1|L2|L3|L4 or a model slug)`);
    }
  }
}

/**
 * Cross-task validation of ids + deps (Finding 2). ids are non-empty strings (already enforced per-task);
 * `deps`, when present, MUST be an array of STRINGS each referencing a KNOWN task id in the plan. A numeric
 * dep, a non-string dep, or a dangling dep (unknown id) is REJECTED here — never silently dropped at ingest
 * (which would let a task execute without its declared predecessor). Validate together so the whole graph is
 * reference-consistent before the plan is accepted.
 */
function validateIdsAndDeps(tasks: unknown[], errors: string[]): void {
  // Collect known ids AND reject DUPLICATES (Finding 3): two tasks with the same id ingest as two rows but the
  // keyToId map collapses to one, orphaning the first — reject before any dep/ingest work.
  const knownIds = new Set<string>();
  const dupIds = new Set<string>();
  for (const t of tasks) {
    const id = t && typeof t === 'object' ? (t as Record<string, unknown>).id : undefined;
    if (typeof id === 'string' && id.trim() !== '') {
      if (knownIds.has(id)) dupIds.add(id);
      knownIds.add(id);
    }
  }
  for (const d of dupIds) errors.push(`duplicate task id '${d}' — task ids must be unique across the plan`);
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i];
    if (!t || typeof t !== 'object') continue;
    const row = t as Record<string, unknown>;
    if (!('deps' in row) || row.deps === null || row.deps === undefined) continue;
    const label = taskLabel(i, row);
    if (!Array.isArray(row.deps)) {
      errors.push(`${label}: field 'deps' must be an array of task-id strings`);
      continue;
    }
    for (const d of row.deps) {
      if (typeof d !== 'string' || d.trim() === '') {
        errors.push(`${label}: dep ${JSON.stringify(d)} must be a task-id string`);
      } else if (!knownIds.has(d)) {
        errors.push(`${label}: dep '${d}' references an unknown task id (dangling — declare the predecessor or remove it)`);
      }
    }
  }
}

/** Map one already-validated raw task to the normalized shape ingestion consumes (was PlanParserService.mapExecutionPlanTask). */
function toNormalizedTask(t: ExecutionPlanTask): NormalizedExecutionTask {
  const eff = normalizeEffort(t.effort);
  const effort: NormalizedEffort = eff.ok ? eff.value : 'med'; // ok guaranteed (validated upstream); defensive default
  const ty = normalizeType((t as any).type);
  const taskType: 'feature' | 'issue' = ty.ok ? ty.value : 'feature';
  const reqs: string[] = Array.isArray(t.req_refs) ? t.req_refs : [];
  const exc = (t as any).exception_handling ? String((t as any).exception_handling) : '';
  const validation = [...reqs, exc].filter(Boolean).join('\n- ') || t.title;
  const deps: string[] = Array.isArray((t as any).deps) ? (t as any).deps.filter((d: any) => typeof d === 'string') : [];
  const a = classifyAssignee(t.assignee);
  const validatorLane = (t as any).validator_lane ?? (t as any).validator_rung ?? (t as any).validator_assignee ?? (t as any).validator;
  const vv = classifyAssignee(validatorLane);

  const planned: NormalizedExecutionTask = {
    task_key: t.id,
    atomic_work: t.title,
    req_refs: reqs,
    complexity: effort,
    effort,
    needs_more_info: false,
    task_type: taskType,
    validation_criteria: validation,
    deps,
    user_critical: Boolean((t as any).user_critical ?? (t as any).critical ?? false),
  };
  if (a.ok && a.kind === 'model') planned.recommended_model = a.model;
  if (a.ok && a.kind === 'rung') planned.recommended_rung = a.rung;
  if (vv.ok && vv.kind === 'rung') planned.validator_rung = vv.rung;
  else if (vv.ok && vv.kind === 'model') planned.validator_model = vv.model;
  if ((t as any).batch != null && String((t as any).batch) !== '') planned.batch = String((t as any).batch);
  return planned;
}

/**
 * THE single shared validation pipeline (sol send-back #3). Pure — no DB, no queue. Runs EVERY check ingestion
 * requires and returns the fully-normalized tasks. Accepts a fenced-json markdown string OR an already-parsed
 * task array. Both the UI gate (parseExecutionPlan) and ingestion consume this, so `ok === true` ⟺ ingestible.
 * Checks: fenced-json/array shape → per-task structural (trim-aware) + coercions (batch#→str, req_refs bare→[])
 * + per-task semantic domains (effort/type/assignee/validator_lane via shared normalizers) → cross-task ids
 * (duplicates) + deps (known string refs) → dependency cycles → canonical machine-plan schema on normalized tasks.
 */
export function validateExecutionPlan(
  input: string | unknown[]
):
  | { ok: true; tasks: ExecutionPlanTask[]; normalizedTasks: NormalizedExecutionTask[] }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];

  let parsed: unknown[];
  if (typeof input === 'string') {
    const fenceMatch = /```json\s*([\s\S]*?)```/im.exec(String(input ?? ''));
    if (!fenceMatch || !fenceMatch[1]?.trim()) return { ok: false, errors: ['no fenced ```json block found'] };
    let j: unknown;
    try {
      j = JSON.parse(fenceMatch[1].trim());
    } catch (e) {
      return { ok: false, errors: [`invalid JSON in fenced block: ${(e as Error).message}`] };
    }
    if (!Array.isArray(j)) return { ok: false, errors: ['fenced JSON must be an array of task objects'] };
    parsed = j;
  } else if (Array.isArray(input)) {
    parsed = input;
  } else {
    return { ok: false, errors: ['execution plan must be a fenced ```json array or a task array'] };
  }

  if (parsed.length === 0) return { ok: false, errors: ['task array must not be empty'] };

  for (let i = 0; i < parsed.length; i++) validateTask(parsed[i], i, errors);

  // Cross-task id (duplicates, Finding 3) + dep-reference validation (Finding 2).
  validateIdsAndDeps(parsed, errors);

  // Dependency cycle detection (Finding 4) — the SAME check ingest applied, now INSIDE the validator so a cyclic
  // plan is `ok:false` (button disabled) not valid-but-ingest-throws. Only meaningful once refs are clean.
  if (errors.length === 0) {
    const cycleMsg = detectDependencyCycles(parsed as ExecutionPlanTask[]);
    if (cycleMsg) errors.push(cycleMsg);
  }

  // Leg D batch-barrier direction: reject an explicit dep from an EARLIER batch onto a LATER batch.
  // Canonical execution_plan requires `batch` on every task (missing/empty is already a per-task error
  // above), so by here every task carries a non-empty batch; resolve + check dependency direction so a
  // barrier-violating plan is `ok:false` (button disabled), not valid-but-ingest-throws.
  if (errors.length === 0) {
    const batchByKey: Record<string, string> = {};
    for (const t of parsed as ExecutionPlanTask[]) {
      batchByKey[String((t as any).id)] = String((t as any).batch ?? '').trim();
    }
    for (const e of validateBatchDependencies(parsed as any[], batchByKey)) errors.push(e);
  }

  if (errors.length > 0) return { ok: false, errors };

  // All checks passed → build normalized tasks and run the canonical machine-plan schema (the thing that threw
  // `tasks[N] violates canonical machine-plan schema` at ingest) so THAT gate is in the validator too.
  const normalizedTasks = (parsed as ExecutionPlanTask[]).map(toNormalizedTask);
  try {
    validateMachinePlan({ tasks: normalizedTasks as unknown as MachinePlanTask[] });
  } catch (e) {
    return { ok: false, errors: [`canonical machine-plan schema: ${(e as Error).message}`] };
  }

  return { ok: true, tasks: parsed as ExecutionPlanTask[], normalizedTasks };
}

/**
 * The UI `execDoc.valid` gate. Thin delegate over the shared `validateExecutionPlan` so it can NEVER diverge from
 * ingestion. Returns the raw (coerced) tasks for existing `.tasks` consumers; `.ok` is the unified verdict.
 */
export function parseExecutionPlan(markdown: string): ParseExecutionPlanResult {
  const r = validateExecutionPlan(markdown);
  return r.ok ? { ok: true, tasks: r.tasks } : { ok: false, errors: r.errors };
}

/**
 * B10-T02: Fail-fast topological cycle detection on the declared dep graph.
 * Returns a clear reason string if a cycle (A→B→A or longer) exists, else null.
 * Used at ingest time so bad plans never enter the dispatch queue.
 */
export function detectDependencyCycles(tasks: ExecutionPlanTask[]): string | null {
  if (!Array.isArray(tasks) || tasks.length === 0) return null;

  const ids = tasks.map((t) => t.id);
  const idSet = new Set(ids);
  const graph: Record<string, string[]> = {};
  for (const t of tasks) {
    const ds = Array.isArray((t as any).deps) ? (t as any).deps.filter((d: any) => typeof d === 'string' && idSet.has(d)) : [];
    graph[t.id] = ds;
  }

  // Kahn's algorithm
  const inDegree: Record<string, number> = {};
  ids.forEach((id) => { inDegree[id] = 0; });
  for (const id of ids) {
    for (const d of graph[id]) {
      inDegree[id] = (inDegree[id] || 0) + 1;
    }
  }

  const queue: string[] = ids.filter((id) => (inDegree[id] || 0) === 0);
  let processed = 0;
  const tempDegree = { ...inDegree };

  while (queue.length > 0) {
    const cur = queue.shift()!;
    processed++;
    // decrement dependents
    for (const tid of ids) {
      if (graph[tid].includes(cur)) {
        tempDegree[tid] = (tempDegree[tid] || 0) - 1;
        if (tempDegree[tid] === 0) queue.push(tid);
      }
    }
  }

  if (processed === ids.length) return null;

  // Report the unresolved set as evidence of cycle (or unsatisfiable circular group)
  const unresolved = ids.filter((id) => (tempDegree[id] || 0) > 0);
  return `dependency cycle detected: ${unresolved.join(' → ') || 'circular deps among tasks'}`;
}
