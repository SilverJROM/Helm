import { DatabaseService } from '../db/database.js';
import { AgentAssignmentService, type AgentDefinition } from './agent-assignment-service.js';
import {
  BranchSafetyService,
  type BranchSafetyFacts,
  type TiedCycleResolver
} from './branch-safety-service.js';

/**
 * R5 / R3.2 — the single call-site entry point serving delete-preflight (B13), the merge-conflict
 * path (B17), and the discovery-time hygiene survey (B20). Composes B4's deterministic facts with
 * an optional B3 house-agent narrative. Never adds a decision/verdict/allow field — that judgment
 * stays with the house agent's own prose (when present) or JROM, never a field on this report.
 */
export interface BranchSafetyReport {
  facts: BranchSafetyFacts;
  narrative: string | null;
}

/**
 * Real narrative generation (a live house-agent dispatch + response) has no synchronous invocation
 * path in this codebase yet (house agents run via tmux session + async callback). This hook lets a
 * caller that DOES have one wire it in; omitted (or throwing/failing), the report degrades to
 * facts-only — it must never block or throw on the caller's behalf (R3.1).
 */
export type NarrativeDispatcher = (
  agent: AgentDefinition,
  facts: BranchSafetyFacts,
  context: { cycleId: number; branch: string; projectDir: string }
) => Promise<string | null>;

export interface BranchSafetyReportOptions {
  dispatchNarrative?: NarrativeDispatcher;
}

/**
 * R5 call-site wiring. Resolves the cycle's project directory + branch, runs B4's fact collector
 * (with a real DB-backed tied-active-cycle resolver — B4 itself has zero DB dependency), then
 * optionally attempts a B3 house-agent narrative. The house-agent lookup goes through
 * AgentAssignmentService's unguarded reads (listRoleDefaults) — never through
 * resolveProjectRole/resolveProjectRoleBindings/setRoleBindings/setRoleDefault, which enforce the
 * B07b `assertProjectRunDispatchable` project-run fence (agent-assignment-service.ts:307) that a
 * house-kind agent must trip. This path is not a project run, so it must not trip it either.
 */
export async function branchSafetyReport(
  cycleId: number,
  db: DatabaseService,
  opts: BranchSafetyReportOptions = {}
): Promise<BranchSafetyReport> {
  const cycleRow = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
  if (!cycleRow) {
    const err: any = new Error('unknown cycle');
    err.code = 'NOT_FOUND';
    throw err;
  }
  const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(cycleRow.project_id) as any;
  if (!projectRow) {
    const err: any = new Error('unknown project');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const projectDir = String(projectRow.directory);
  const branch = cycleRow.git_branch != null ? String(cycleRow.git_branch) : null;

  if (!branch) {
    // No git identity assigned to this cycle yet (pre-R4 cycle, or branch not yet created) —
    // nothing to inspect; report an honest empty-facts shape rather than guessing a branch name.
    return {
      facts: {
        exists: false,
        mergedInto: [],
        tiedToActiveCycleId: null,
        lastCommitAt: null,
        ageDays: null,
        aheadBehind: null,
        uncommittedInWorktree: false,
        worktreePath: null
      },
      narrative: null
    };
  }

  const projectId = Number(cycleRow.project_id);
  const resolveTiedCycle: TiedCycleResolver = async (_projectDir, targetBranch) => {
    const row = db
      .prepare(
        `SELECT id, git_base_branch FROM cycles WHERE project_id = ? AND git_branch = ? AND status = 'active' LIMIT 1`
      )
      .get(projectId, targetBranch) as any;
    if (!row) return null;
    return {
      cycleId: Number(row.id),
      baseBranch: row.git_base_branch != null ? String(row.git_base_branch) : null
    };
  };

  const facts = await new BranchSafetyService(resolveTiedCycle).collectFacts(projectDir, branch);
  const narrative = await tryDispatchNarrative(db, facts, { cycleId, branch, projectDir }, opts.dispatchNarrative);

  return { facts, narrative };
}

/**
 * Never throws: an unavailable/in-development agent, a missing dispatcher, or a dispatcher that
 * itself throws all degrade to facts-only (null narrative) per R3.1.
 */
async function tryDispatchNarrative(
  db: DatabaseService,
  facts: BranchSafetyFacts,
  context: { cycleId: number; branch: string; projectDir: string },
  dispatchNarrative: NarrativeDispatcher | undefined
): Promise<string | null> {
  if (!dispatchNarrative) return null;
  try {
    const assignment = new AgentAssignmentService(db);
    const roleDefault = assignment.listRoleDefaults().find((d) => d.role === 'branch-safety');
    const agent = roleDefault?.agent ?? null;
    if (!agent || agent.in_development) return null;
    const narrative = await dispatchNarrative(agent, facts, context);
    return narrative ?? null;
  } catch {
    return null;
  }
}
