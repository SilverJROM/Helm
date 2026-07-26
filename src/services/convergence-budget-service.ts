import { DatabaseService } from '../db/database.js';
import { validateConvergenceBudget, type ConvergenceBudgetInput } from './plan-schema.js';

export interface ConvergenceBudget {
  max_fix_cycles: number;
  max_redteam_iterations: number;
  max_wallclock_min: number;
  token_budget: number | null;
  new_class_rounds_to_stall: number;
  on_burn: 'pull_in_coplanner_then_north';
}

export const CONVERGENCE_BUDGET_SAFETY_FLOOR: Readonly<ConvergenceBudget> = {
  max_fix_cycles: 3,
  max_redteam_iterations: 3,
  max_wallclock_min: 90,
  token_budget: null,
  new_class_rounds_to_stall: 2,
  on_burn: 'pull_in_coplanner_then_north',
};

export interface ResolveConvergenceBudgetInput {
  run_id: string;
  batch_id?: string | null;
  convergence_budget?: ConvergenceBudgetInput | null;
}

/**
 * Plan-ingestion integration point: resolve each parsed batch before it enters
 * dispatch/queue processing. Unstamped or partial budgets are audit-recorded.
 */
export class ConvergenceBudgetService {
  constructor(private readonly db: DatabaseService) {}

  resolveBudget(input: ResolveConvergenceBudgetInput): ConvergenceBudget {
    if (!input.run_id.trim()) throw new Error('run_id is required to resolve convergence_budget');
    const parsed = input.convergence_budget == null
      ? {}
      : validateConvergenceBudget(input.convergence_budget);
    const provided = Object.fromEntries(
      Object.entries(parsed).filter(([, value]) => value !== undefined)
    ) as ConvergenceBudgetInput;
    const resolved: ConvergenceBudget = { ...CONVERGENCE_BUDGET_SAFETY_FLOOR, ...provided };
    const missingFields = Object.keys(CONVERGENCE_BUDGET_SAFETY_FLOOR)
      .filter((field) => !(field in provided));
    if (missingFields.length > 0) {
      this.db.prepare(
        'INSERT INTO run_events (run_id, batch_id, event_type, payload_json) VALUES (?, ?, ?, ?)'
      ).run(
        input.run_id,
        input.batch_id ?? null,
        'CONVERGENCE_BUDGET_FLOOR',
        JSON.stringify({ batch_id: input.batch_id ?? null, missing_fields: missingFields, resolved_budget: resolved })
      );
    }
    return resolved;
  }
}
