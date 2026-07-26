export const MACHINE_COMPLEXITIES = ['low', 'med', 'high', 'xhigh'] as const;
export const MACHINE_TASK_TYPES = ['feature', 'issue'] as const;
// #54: 'plan-defect' and 'requirements-gap' added 2026-07-20 after the retest-run-24 post-mortem.
// The vocabulary previously offered only rung-attempt-limit | validator-failure | external-blocker, so a
// brain facing a genuine PLAN defect had no truthful label available. On run 24 ibrain correctly reasoned
// "root cause is plan defect, NOT implementer or validator failure", was forced to pick the nearest fit
// ('external-blocker'), and the edge_class<->action guard then rejected the decision — silently discarding
// a CORRECT re-plan and deferring the task instead. The model was more semantically precise than the schema.
//   plan-defect      = the TASK/plan slice is impossible, contradictory, or self-inconsistent as written.
//   requirements-gap = the requirement the task depends on is MISSING or underspecified upstream.
// Both route naturally to re-plan; requirements-gap is the one that may legitimately terminate at JROM
// when the missing decision is arbitrary product behaviour rather than a derivable domain rule.
export const BRAIN_EDGE_CLASSES = [
  'rung-attempt-limit',
  'validator-failure',
  'external-blocker',
  'plan-defect',
  'requirements-gap',
] as const;
export const BRAIN_ROUTE_TO = [
  'bump-rung',
  'validator-handholding',
  're-brief',
  'deliberation',
  'escalate-to-JROM',
  're-plan',
  'escalate-validator',
] as const;
export const BRAIN_BLOCKER_OWNERS = ['dispatcher', 'validator', 'brain', 'JROM'] as const;
export const CONVERGENCE_ON_BURN = ['pull_in_coplanner_then_north'] as const;

export interface ConvergenceBudgetInput {
  max_fix_cycles?: number;
  max_redteam_iterations?: number;
  max_wallclock_min?: number;
  token_budget?: number | null;
  new_class_rounds_to_stall?: number;
  on_burn?: (typeof CONVERGENCE_ON_BURN)[number];
}

const CONVERGENCE_BUDGET_KEYS = new Set<keyof ConvergenceBudgetInput>([
  'max_fix_cycles', 'max_redteam_iterations', 'max_wallclock_min', 'token_budget',
  'new_class_rounds_to_stall', 'on_burn',
]);

/** Validates an optional per-batch budget object without silently accepting garbage. */
export function validateConvergenceBudget(value: unknown): ConvergenceBudgetInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('convergence_budget must be an object');
  }
  const budget = value as Record<string, unknown>;
  for (const key of Object.keys(budget)) {
    if (!CONVERGENCE_BUDGET_KEYS.has(key as keyof ConvergenceBudgetInput)) {
      throw new Error(`convergence_budget.${key} is not allowed`);
    }
  }
  for (const key of ['max_fix_cycles', 'max_redteam_iterations', 'max_wallclock_min', 'new_class_rounds_to_stall'] as const) {
    if (budget[key] !== undefined && (!Number.isInteger(budget[key]) || Number(budget[key]) <= 0)) {
      throw new Error(`convergence_budget.${key} must be a positive integer`);
    }
  }
  if (budget.token_budget !== undefined && budget.token_budget !== null
    && (!Number.isInteger(budget.token_budget) || Number(budget.token_budget) <= 0)) {
    throw new Error('convergence_budget.token_budget must be null or a positive integer');
  }
  if (budget.on_burn !== undefined && !CONVERGENCE_ON_BURN.includes(budget.on_burn as any)) {
    throw new Error(`convergence_budget.on_burn invalid (${CONVERGENCE_ON_BURN.join(', ')})`);
  }
  return budget as ConvergenceBudgetInput;
}

export interface MachinePlanTask {
  task_key: string;
  atomic_work: string;
  complexity: (typeof MACHINE_COMPLEXITIES)[number];
  task_type: (typeof MACHINE_TASK_TYPES)[number];
  validation_criteria: string | string[];
  deps?: string[];
  convergence_budget?: ConvergenceBudgetInput;
  [key: string]: unknown;
}
export interface MachinePlan { tasks: MachinePlanTask[]; meta?: Record<string, unknown>; }
export function validateMachinePlan(value: unknown): MachinePlan {
  const plan = value as Partial<MachinePlan>;
  if (!plan || !Array.isArray(plan.tasks) || plan.tasks.length === 0) throw new Error('Invalid plan: "tasks" must be non-empty array');
  for (const [index, task] of plan.tasks.entries()) {
    if (!task || typeof task !== 'object' || typeof task.task_key !== 'string' || !task.task_key.trim() || typeof task.atomic_work !== 'string' || !task.atomic_work.trim() || !MACHINE_COMPLEXITIES.includes(task.complexity) || !MACHINE_TASK_TYPES.includes(task.task_type) || (typeof task.validation_criteria === 'string' ? !task.validation_criteria.trim() : !(Array.isArray(task.validation_criteria) && task.validation_criteria.length > 0 && task.validation_criteria.every((v) => typeof v === 'string' && v.trim()))) || (task.deps !== undefined && (!Array.isArray(task.deps) || !task.deps.every((v) => typeof v === 'string' && v.trim())))) throw new Error(`tasks[${index}] violates canonical machine-plan schema`);
    if (task.convergence_budget !== undefined) validateConvergenceBudget(task.convergence_budget);
  }
  return plan as MachinePlan;
}

export interface BrainVerdict { edge_class: (typeof BRAIN_EDGE_CLASSES)[number]; route_to: (typeof BRAIN_ROUTE_TO)[number]; blocker_owner: (typeof BRAIN_BLOCKER_OWNERS)[number]; reason: string; }
export function parseBrainVerdict(value: unknown): BrainVerdict | null {
  const v = value as Record<string, unknown>;
  return v && BRAIN_EDGE_CLASSES.includes(v.edge_class as any) && BRAIN_ROUTE_TO.includes(v.route_to as any) && BRAIN_BLOCKER_OWNERS.includes(v.blocker_owner as any) && typeof v.reason === 'string' && v.reason.trim() ? v as unknown as BrainVerdict : null;
}

/**
 * Mid-run re-plan may revise ONLY content fields: atomic_work, validation_criteria, req_refs.
 * task_key/type/batch/deps/complexity are immutable (enforced by the apply path).
 * Returns the validated content slice or throws (fail-closed).
 */
export interface RevisedTaskContent {
  atomic_work: string;
  validation_criteria: string | string[];
  /** Present only when the revision explicitly supplies req_refs (including []). */
  req_refs?: string[];
}

export function validateRevisedTaskContent(value: unknown): RevisedTaskContent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('revised task must be a non-null object');
  }
  const task = value as Record<string, unknown>;

  if (typeof task.atomic_work !== 'string' || !task.atomic_work.trim()) {
    throw new Error('revised task.atomic_work must be a non-empty string');
  }

  const criteria = task.validation_criteria;
  if (typeof criteria === 'string') {
    if (!criteria.trim()) throw new Error('revised task.validation_criteria must be non-empty');
  } else if (Array.isArray(criteria)) {
    if (
      criteria.length === 0 ||
      !criteria.every((v) => typeof v === 'string' && v.trim())
    ) {
      throw new Error('revised task.validation_criteria must be a non-empty string[] of non-empty strings');
    }
  } else {
    // Reject object-coerced / null / number / missing criteria
    throw new Error('revised task.validation_criteria must be a non-empty string or string[]');
  }

  let req_refs: string[] | undefined;
  if (Object.prototype.hasOwnProperty.call(task, 'req_refs')) {
    if (!Array.isArray(task.req_refs) || !task.req_refs.every((v) => typeof v === 'string' && v.trim())) {
      throw new Error('revised task.req_refs must be a string[] of non-empty strings when provided');
    }
    req_refs = (task.req_refs as string[]).map((r) => r.trim());
  }

  return {
    atomic_work: task.atomic_work.trim(),
    validation_criteria:
      typeof criteria === 'string' ? criteria : (criteria as string[]),
    ...(req_refs !== undefined ? { req_refs } : {}),
  };
}
