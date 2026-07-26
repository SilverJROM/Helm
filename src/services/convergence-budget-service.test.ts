import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseService } from '../db/database.js';
import { validateMachinePlan } from './plan-schema.js';
import { CONVERGENCE_BUDGET_SAFETY_FLOOR, ConvergenceBudgetService } from './convergence-budget-service.js';

describe('B01.s2 convergence budget service', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

  function service(): { db: DatabaseService; budgets: ConvergenceBudgetService } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b01-s2-'));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    const db = new DatabaseService(path.join(dir, 'helm-test.db'));
    return { db, budgets: new ConvergenceBudgetService(db) };
  }

  it('parses a complete per-batch convergence budget without a floor event', () => {
    const { db, budgets } = service();
    const plan = validateMachinePlan({ tasks: [{
      task_key: 'B01.s2', atomic_work: 'budget parser', complexity: 'med', task_type: 'feature', validation_criteria: 'budget resolves',
      convergence_budget: { max_fix_cycles: 4, max_redteam_iterations: 5, max_wallclock_min: 30, token_budget: 1200, new_class_rounds_to_stall: 1, on_burn: 'pull_in_coplanner_then_north' },
    }] });
    expect(budgets.resolveBudget({ run_id: 'run-b01-s2', batch_id: 'B01.s2', convergence_budget: plan.tasks[0].convergence_budget }))
      .toEqual({ max_fix_cycles: 4, max_redteam_iterations: 5, max_wallclock_min: 30, token_budget: 1200, new_class_rounds_to_stall: 1, on_burn: 'pull_in_coplanner_then_north' });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toMatchObject({ count: 0 });
    db.close();
  });

  it('uses the safety floor for an unstamped budget and appends an audit event', () => {
    const { db, budgets } = service();
    expect(budgets.resolveBudget({ run_id: 'run-b01-s2', batch_id: 'B01.s2' }))
      .toEqual(CONVERGENCE_BUDGET_SAFETY_FLOOR);
    const event = db.raw.prepare('SELECT batch_id, event_type, payload_json FROM run_events').get() as any;
    expect(event.batch_id).toBe('B01.s2');
    expect(event.event_type).toBe('CONVERGENCE_BUDGET_FLOOR');
    expect(JSON.parse(event.payload_json)).toMatchObject({ batch_id: 'B01.s2', resolved_budget: CONVERGENCE_BUDGET_SAFETY_FLOOR });
    expect(budgets.resolveBudget({
      run_id: 'run-b01-s2', batch_id: 'B01.s2-partial', convergence_budget: { max_fix_cycles: 4 },
    })).toEqual({ ...CONVERGENCE_BUDGET_SAFETY_FLOOR, max_fix_cycles: 4 });
    expect(db.raw.prepare('SELECT COUNT(*) AS count FROM run_events').get()).toMatchObject({ count: 2 });
    db.close();
  });

  it('rejects invalid convergence budget fields fail-closed', () => {
    expect(() => validateMachinePlan({ tasks: [{
      task_key: 'B01.s2', atomic_work: 'budget parser', complexity: 'med', task_type: 'feature', validation_criteria: 'reject garbage',
      convergence_budget: { max_fix_cycles: 0, on_burn: 'ignore_it' },
    }] })).toThrow(/convergence_budget/i);
  });
});
