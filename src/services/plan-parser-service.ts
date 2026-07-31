import fs from 'node:fs/promises';
import path from 'node:path';
import { RunArtifactService } from './run-artifact-service.js';
import { TaskQueueService } from './task-queue-service.js';
import { validateExecutionPlan, resolveTaskBatches, validateBatchDependencies } from './execution-plan-parser.js';
import { MACHINE_COMPLEXITIES, validateMachinePlan, type MachinePlan, type MachinePlanTask } from './plan-schema.js';

/**
 * B9 PLN2: Machine-readable plan (plan.json or fenced block in plan.md).
 * Ingests ALL required fields into run_tasks (reuse B1) + TaskQueue (B6) with deps resolved.
 * Records the plan as artifact for later metadata lookup (recommended_model/complexity for B8 plan-summon).
 * Round-trippable: plan(N tasks + deps) -> N run_tasks + queue order + fields preserved.
 * No schema changes to run_tasks; task_key + label + plan.json artifact hold the data.
 */

export interface PlannedTask extends MachinePlanTask {
  task_key: string;
  atomic_work: string;
  complexity: 'low' | 'med' | 'high' | 'xhigh';
  model?: string;  // C6: alias for recommended_model (per-task base)
  recommended_model?: string;
  recommended_rung?: 0 | 1 | 2 | 3;
  validator_rung?: 0 | 1 | 2 | 3;
  validator_model?: string;
  effort?: 'low' | 'med' | 'high' | 'xhigh';
  needs_more_info?: boolean;
  task_type: 'feature' | 'issue';
  validation_criteria: string | string[];
  deps?: string[];
  user_critical?: boolean;
}

export interface Plan extends MachinePlan { tasks: PlannedTask[]; }

export class PlanParserService {
  private ingestValidator?: (runId: number, plan: Plan) => void;

  constructor(private readonly artifacts: RunArtifactService) {}

  setIngestValidator(validator: (runId: number, plan: Plan) => void): void {
    this.ingestValidator = validator;
  }

  /**
   * Parse from raw JSON string (preferred machine format).
   * Strict: requires the 8 fields per guardrail (1).
   */
  parsePlanFromJson(json: string): Plan {
    let raw: unknown;
    try {
      raw = JSON.parse(json);
    } catch (e) {
      throw new Error(`Invalid plan JSON: ${(e as Error).message}`);
    }
    const p = raw as Partial<Plan>;
    if (!p || !Array.isArray(p.tasks) || p.tasks.length === 0) {
      throw new Error('Invalid plan: "tasks" must be non-empty array');
    }
    for (const [i, t] of p.tasks.entries()) {
      if (!t || typeof t !== 'object') throw new Error(`tasks[${i}] not object`);
      const pt = t as PlannedTask;
      if (!pt.task_key || typeof pt.task_key !== 'string') throw new Error(`tasks[${i}].task_key required`);
      if (!pt.atomic_work || typeof pt.atomic_work !== 'string') throw new Error(`tasks[${i}].atomic_work required`);
      // Robustness (2026-06-30, outer-projcore Fault #5): light models commonly emit "medium" for the "med"
      // enum (and synonyms). Without normalization a trivial enum-string variance makes parsePlanFromJson throw,
      // which loops the post-agreement plan.json poll for the FULL 10-min planning timeout then BLOCKS an
      // otherwise-correct plan. Normalize first so the pipeline is robust to enum drift.
      const _normEnum = (v: any): any => {
        const s = String(v ?? '').toLowerCase().trim();
        if (s === 'medium' || s === 'mid' || s === 'moderate' || s === 'normal') return 'med';
        if (s === 'l') return 'low';
        if (s === 'h') return 'high';
        if (s === 'xh' || s === 'extra-high' || s === 'very-high' || s === 'highest') return 'xhigh';
        return s;
      };
      (pt as any).complexity = _normEnum(pt.complexity);
      if ((pt as any).effort != null && (pt as any).effort !== '') (pt as any).effort = _normEnum((pt as any).effort);
      if (!pt.complexity || !MACHINE_COMPLEXITIES.includes(pt.complexity)) {
        throw new Error(`tasks[${i}].complexity invalid (low/med/high/xhigh)`);
      }
      // Robustness (Fault #5): only 'issue' triggers the repro-first path; everything else
      // (feature/test/chore/refactor/…) takes the standard build path. Light models commonly emit 'test'
      // for test tasks — normalize instead of hard-rejecting (which would hang+block the run).
      {
        const _tt = String(pt.task_type ?? '').toLowerCase().trim();
        (pt as any).task_type = _tt === 'issue' ? 'issue' : 'feature';
      }
      // POCFIX9 (A): accept validation_criteria as string (legacy) OR string[] (real projcore output for multi-criteria tasks).
      // Normalize array -> single string (joined for clean downstream use in briefs/artifacts/Validation sections + keep all existing string expectations working).
      // Type updated to union; guard relaxed; normalization ensures internal shape remains string for ingest + run-orchestrator/orchestrator-loop consumers.
      if (!pt.validation_criteria || (typeof pt.validation_criteria !== 'string' && !(Array.isArray(pt.validation_criteria) && pt.validation_criteria.every((s: any) => typeof s === 'string')))) {
        throw new Error(`tasks[${i}].validation_criteria required (string or string[])`);
      }
      if (Array.isArray(pt.validation_criteria)) {
        (pt as any).validation_criteria = (pt.validation_criteria as string[]).join('\n- ');
      }
      // C6: accept `model` (or `recommended_model`) + effort per-task (optional); normalize model alias
      if ((pt as any).model && !(pt as any).recommended_model) {
        (pt as any).recommended_model = (pt as any).model;
      }
      if ((pt as any).recommended_rung != null) {
        const n = Number((pt as any).recommended_rung);
        if (![0, 1, 2, 3].includes(n)) throw new Error(`tasks[${i}].recommended_rung invalid (0/1/2/3)`);
        (pt as any).recommended_rung = n;
      }
      if ((pt as any).validator_rung != null) {
        const n = Number((pt as any).validator_rung);
        if (![0, 1, 2, 3].includes(n)) throw new Error(`tasks[${i}].validator_rung invalid (0/1/2/3)`);
        (pt as any).validator_rung = n;
      }
      // optional fields accepted as-is (recommended_model/effort drive per-task base)
    }
    return validateMachinePlan({ tasks: p.tasks as PlannedTask[], meta: p.meta }) as Plan;
  }

  /**
   * Discover machine plan in runDir: prefer plan.json, fallback to fenced block in plan.md.
   */
  async loadPlanFromRunDir(runDir: string): Promise<Plan> {
    const jsonPath = path.join(runDir, 'plan.json');
    try {
      const raw = await fs.readFile(jsonPath, 'utf8');
      return this.parsePlanFromJson(raw);
    } catch {
      // fallback fenced
    }
    const mdPath = path.join(runDir, 'plan.md');
    try {
      const md = await fs.readFile(mdPath, 'utf8');
      const fenceMatch = /```(?:json|yaml)?\s*([\s\S]*?)```/m.exec(md);
      if (fenceMatch && fenceMatch[1]) {
        return this.parsePlanFromJson(fenceMatch[1].trim());
      }
    } catch {}
    throw new Error(`No plan.json or fenced plan block found in ${runDir}`);
  }

  /**
   * Ingest plan into durable run_tasks + enqueue with resolved deps.
   * Returns created ids + key->id map (for callers/tests).
   * Also records plan.json as artifact (so queued driver + rehydrate can read fields for B8 summon).
   */
  async ingestPlan(
    runId: number,
    plan: Plan,
    queue: TaskQueueService,
    runDir?: string
  ): Promise<{ createdTaskIds: number[]; keyToId: Record<string, number> }> {
    // C10: normalize + validate the ENTIRE accepted plan before any DB write.
    plan = validateMachinePlan(plan) as Plan;
    this.ingestValidator?.(runId, plan);

    // Leg D (batch barrier): resolve + validate the durable batch for every task BEFORE persistence.
    // all-labeled → trimmed labels; all-unlabeled → synthetic 'default' (legacy single-queue); MIXED →
    // reject (barrier bypass). Then reject any earlier→later batch dependency. The resolved batch is
    // written back onto the plan tasks so the emitted plan.json carries it (drainDispatch + rehydrate).
    const batchRes = resolveTaskBatches(plan.tasks);
    if (!batchRes.ok) throw new Error(`Invalid plan batch labeling: ${batchRes.error}`);
    const resolvedBatches = batchRes.batches;
    const batchByKey: Record<string, string> = {};
    plan.tasks.forEach((t, i) => {
      batchByKey[t.task_key] = resolvedBatches[i];
      (t as any).batch = resolvedBatches[i];
    });
    const depErrs = validateBatchDependencies(plan.tasks, batchByKey);
    if (depErrs.length) throw new Error(`Invalid plan batch dependencies: ${depErrs.join('; ')}`);

    // C10: task rows + the plan artifact row + the queue admission all land as ONE unit — either
    // every task/artifact row commits AND every task is enqueued, or none of it happens. `enqueue` is
    // in-memory-only (no DB I/O), so it runs INSIDE the same synchronous better-sqlite3 transaction
    // callback: a throw from any step (recordTask, recordArtifact, or enqueue) propagates out of the
    // callback, which makes better-sqlite3 roll back every DB write made during this call before
    // rethrowing. That undoes the DB side, but not JS-side mutations `enqueue` already made to the
    // in-memory queue for earlier tasks in this same loop — so the outer catch compensates by wiping
    // this run's queue state via `queue.clearRun(runId)` before rethrowing, leaving zero rows and zero
    // queue entries on any failure.
    const keyToId: Record<string, number> = {};
    const created: number[] = [];
    const runTx = this.artifacts['db'].raw.transaction(() => {
      // Create all tasks first (ids needed for dep resolution); persist the resolved batch.
      plan.tasks.forEach((t, i) => {
        const tid = this.artifacts.recordTask(runId, t.task_key, t.atomic_work, resolvedBatches[i]);
        keyToId[t.task_key] = tid;
        created.push(tid);
      });

      // Record the canonical plan artifact row (enables metadata lookup without extra columns).
      if (runDir) {
        this.artifacts.recordArtifact(runId, 'plan', 'plan.json');
      }

      // Enqueue respecting deps (after all keys have ids); pass the resolved batch so the queue
      // admission barrier can order by it (never plan-array, never task-key).
      plan.tasks.forEach((t, i) => {
        const tid = keyToId[t.task_key];
        const depIds = (t.deps || [])
          .map((d) => keyToId[d])
          .filter((id): id is number => typeof id === 'number');
        queue.enqueue(runId, tid, depIds, false, resolvedBatches[i]);
      });
    });
    try {
      runTx();
    } catch (err) {
      queue.clearRun(runId);
      throw err;
    }

    // FS snapshot write is advisory (in production the planning phase already writes plan.json to
    // runDir before ingest; this is a defensive write for callers/tests that ingest directly) —
    // best-effort, AFTER the transaction has committed, so a write failure here cannot roll back
    // already-committed DB rows or queue state.
    if (runDir) {
      try {
        const planPath = path.join(runDir, 'plan.json');
        await fs.mkdir(path.dirname(planPath), { recursive: true }).catch(() => {});
        await fs.writeFile(planPath, JSON.stringify(plan, null, 2), 'utf8');
      } catch {
        // non-fatal for tests that don't care about FS artifact
      }
    }

    return { createdTaskIds: created, keyToId };
  }

  /**
   * B10-T01: Ingest execution_plan.md (the new canonical for helm-algo / cycles).
   *
   * sol send-back #3: this path and the UI `execDoc.valid` gate now share ONE validator. We call the pure
   * `validateExecutionPlan` FIRST and refuse to ingest if `!ok` — and we ingest using the SAME `normalizedTasks`
   * it produced, applying NO additional acceptance/normalization of our own. So `execDoc.valid === true`
   * ⟺ this method succeeds, by construction (every structural/semantic/cross-task/cycle/canonical-schema check
   * lives in the shared validator; nothing extra lives here).
   */
  async ingestExecutionPlan(
    runId: number,
    markdown: string,
    queue: TaskQueueService,
    runDir?: string
  ): Promise<{ createdTaskIds: number[]; keyToId: Record<string, number> }> {
    const result = validateExecutionPlan(markdown);
    if (!result.ok) {
      throw new Error(`Invalid execution_plan.md: ${result.errors.join('; ')}`);
    }

    // Consume the validator's normalized tasks verbatim (no re-map, no re-normalize, no extra check).
    const plan = { tasks: result.normalizedTasks as unknown as PlannedTask[] } as Plan;

    // C10: ingestPlan owns the transactional plan-snapshot write (FS) + artifact row (DB) — don't
    // duplicate either here (the prior duplicate write produced two `artifacts` rows per ingest).
    return this.ingestPlan(runId, plan, queue, runDir);
  }
}
