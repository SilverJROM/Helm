import { parseExecutionPlan } from './execution-plan-parser.js';
import { normalizeAutonomyDefault } from './project-service.js';
import { CANONICAL_CYCLE_ARTIFACTS, readCycleArtifact } from './cycle-artifact-paths.js';

/**
 * IS-R3 (impl-start): server-side autonomous auto-start of a cycle's implementation run.
 *
 * Called on a VALID save of a cycle's execution_plan.md (the docs PUT route already validated it
 * before this point). For an `autonomous_after_discovery` cycle with a valid plan and NO active run,
 * it kicks off the cycle-plan implementation-only run (no click) — so implementation starts even with
 * nobody watching. For `pause_after_planning` it is a no-op (manual Start button + Approve gate only).
 *
 * IDEMPOTENT: the guard `rs.hasRun && rs.runActive` (getCycleRunState) means a re-save while a run is
 * active never starts a second concurrent run. startRunDetached creates the run row synchronously, so
 * the very next save sees runActive=true and no-ops.
 *
 * Structural deps (no service import cycle) — the caller passes the real services.
 */
export interface CycleAutoStartDeps {
  db: { prepare(sql: string): { get(...args: any[]): any } };
  cycleService: { getCycleDocDir(cycleId: number): string; setCyclePhase?(cycleId: number, phase: string): unknown };
  runArtifacts: { getCycleRunState(cycleId: number): { hasRun: boolean; runActive?: boolean } };
  orchestrator: { startRunDetached(input: any): { runId: number; batchId: string } };
}

export interface CycleAutoStartResult {
  started: boolean;
  reason?: string;
  runId?: number;
}

/**
 * Shared body: never a second concurrent run for the cycle (IS-R3/IS-R4 idempotency guard),
 * ingest + validate the cycle's own plan.md (defense-in-depth; callers already validated on
 * save / gated on approval), then start the cyclePlan implementation-only run. Callers own the
 * precondition check for WHY implementation is allowed to start now (autonomy vs. approval).
 */
async function startCycleImplementationRun(
  deps: CycleAutoStartDeps,
  cycleId: number,
  projectId: number
): Promise<CycleAutoStartResult> {
  let rs: { hasRun: boolean; runActive?: boolean };
  try { rs = deps.runArtifacts.getCycleRunState(cycleId); } catch { rs = { hasRun: false }; }
  if (rs.hasRun && rs.runActive) return { started: false, reason: 'run already active' };

  let md: string;
  try {
    const artifact = await readCycleArtifact(deps.cycleService.getCycleDocDir(cycleId), CANONICAL_CYCLE_ARTIFACTS.plan);
    md = artifact.content;
    if (artifact.warning) console.warn(`[cycle-plan] ${artifact.warning}`);
  } catch {
    return { started: false, reason: 'no plan.md' };
  }
  if (!parseExecutionPlan(md).ok) return { started: false, reason: 'invalid plan.md' };

  const { runId } = deps.orchestrator.startRunDetached({
    projectId,
    cycleId,
    prompt: `implement cycle ${cycleId} from plan.md`,
    cyclePlan: true,
  });
  // Best-effort phase reflection (mirrors the manual endpoint); the run linkage is the contract.
  try { deps.cycleService.setCyclePhase?.(cycleId, 'implementation'); } catch { /* cosmetic */ }
  return { started: true, runId };
}

export async function maybeAutoStartCycleImplementation(
  deps: CycleAutoStartDeps,
  cycleId: number
): Promise<CycleAutoStartResult> {
  const cycle: any = deps.db.prepare('SELECT id, project_id, autonomy FROM cycles WHERE id = ?').get(cycleId);
  if (!cycle) return { started: false, reason: 'unknown cycle' };

  // Only autonomous cycles auto-start; pause_after_planning stays manual (IS-R2 button + Approve gate).
  if (normalizeAutonomyDefault(cycle.autonomy) !== 'autonomous_after_discovery') {
    return { started: false, reason: 'not autonomous_after_discovery' };
  }

  return startCycleImplementationRun(deps, cycleId, Number(cycle.project_id));
}

/**
 * A6 / R3.14: JROM has just approved a gate-mode cycle (cycleService.approveCycle already flipped
 * awaiting_approval → phase=implementation + froze the topology). The run-orchestrator parked the
 * planning run without dispatching (pause_after_planning gate) specifically so this starts the
 * queue for real — same ingestion path as the manual Start Implementation button (IS-R1), just
 * triggered by approval instead of a click.
 */
export async function startCycleImplementationAfterApproval(
  deps: CycleAutoStartDeps,
  cycleId: number
): Promise<CycleAutoStartResult> {
  const cycle: any = deps.db.prepare('SELECT id, project_id FROM cycles WHERE id = ?').get(cycleId);
  if (!cycle) return { started: false, reason: 'unknown cycle' };
  return startCycleImplementationRun(deps, cycleId, Number(cycle.project_id));
}
