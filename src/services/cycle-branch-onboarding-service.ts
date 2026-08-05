import { DatabaseService } from '../db/database.js';
import { branchSafetyReport, type BranchSafetyReport } from './branch-safety-report-service.js';
import { GitWorktreeService, type CycleGitIdentity } from './git-worktree-service.js';
import type { Cycle } from './cycle-service.js';

const DEFAULT_BASE_BRANCH = 'main';

export interface CycleBranchSurveyEntry {
  cycleId: number;
  cycleName: string;
  branch: string;
  report: BranchSafetyReport;
}

export interface CycleBranchSurvey {
  branches: CycleBranchSurveyEntry[];
  /** true when the survey itself could not run (bad cycle, DB error, ...) — never thrown upward. */
  degraded: boolean;
}

/**
 * R7.1/D5 — discovery TRIGGERS this at cycle start, before the task interview; it never judges.
 * Surveys the project's OTHER cycle branches (the only branches Helm itself creates, per R4.1)
 * through B4/B5's existing facts-only `branchSafetyReport` — one entry per sibling branch, JROM
 * decides live what (if anything) to do about what's flagged (D5). Never blocks cycle start: a
 * failure resolving the cycle/project, or in an individual sibling's report, is swallowed into a
 * degraded/partial result rather than thrown (R7.3).
 */
export async function surveyCycleBranches(cycleId: number, db: DatabaseService): Promise<CycleBranchSurvey> {
  try {
    const cycleRow = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycleRow) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const siblings = db
      .prepare(
        `SELECT id, name, git_branch FROM cycles WHERE project_id = ? AND id != ? AND git_branch IS NOT NULL`
      )
      .all(cycleRow.project_id, cycleId) as any[];

    const branches: CycleBranchSurveyEntry[] = [];
    for (const sibling of siblings) {
      try {
        const report = await branchSafetyReport(Number(sibling.id), db);
        branches.push({
          cycleId: Number(sibling.id),
          cycleName: String(sibling.name),
          branch: String(sibling.git_branch),
          report
        });
      } catch {
        // one sibling's report failing must not drop the rest of the survey (R7.3 non-blocking).
      }
    }

    return { branches, degraded: false };
  } catch {
    return { branches: [], degraded: true };
  }
}

export interface EstablishCycleBranchParams {
  cycleId: number;
  db: DatabaseService;
  /** JROM's already-confirmed live choice (R7.1) — this function never picks it. Empty/omitted -> `main`. */
  chosenBase?: string | null;
}

/**
 * R7.1/R4.2 — the ONE cycle-start call site into B6 (plan.md §1: replaces B10's provisional
 * default-base call site rather than adding a second one; a grep test asserts this file is the
 * only `.createCycleWorktree(` caller in src/). Runs only after the caller has already recorded
 * JROM's live base choice (surveyCycleBranches + presenting it happen first, in B21's discovery
 * sidecar) — this function itself never surveys, presents, or judges; it only sequences the call.
 */
export async function establishCycleBranch(params: EstablishCycleBranchParams): Promise<CycleGitIdentity> {
  const { cycleId, db } = params;

  const cycleRow = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
  if (!cycleRow) {
    const err: any = new Error('unknown cycle');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (cycleRow.git_branch != null) {
    const err: any = new Error(`cycle ${cycleId} already has a git identity (branch ${cycleRow.git_branch})`);
    err.code = 'CONFLICT';
    throw err;
  }

  const projectRow = db.prepare('SELECT * FROM projects WHERE id = ?').get(cycleRow.project_id) as any;
  if (!projectRow) {
    const err: any = new Error('unknown project');
    err.code = 'NOT_FOUND';
    throw err;
  }

  const baseRef = String(params.chosenBase || '').trim() || DEFAULT_BASE_BRANCH;
  // Same slug the cycle's folder_name was built from at cycle-service.createCycle (folder_name =
  // `${slug}_${MMDD}`) — reused rather than re-slugified so the branch and the on-disk folder never
  // diverge from a single source of truth.
  const slug = String(cycleRow.folder_name).replace(/_\d{4}$/, '');

  return new GitWorktreeService(db).createCycleWorktree({
    projectDir: String(projectRow.directory),
    cycleId,
    slug,
    baseRef
  });
}

/** Structural subset of CycleService used at cycle start — keeps this module free of a service cycle. */
export interface CycleCreator {
  createCycle(
    projectId: number,
    name: string,
    autonomyInput?: unknown,
    finalTestsInput?: unknown
  ): Promise<Cycle>;
}

export interface CycleStartOnboarding {
  cycle: Cycle;
  survey: CycleBranchSurvey;
  /** Always true here: cycle start deliberately stops before B6 until JROM's choice is recorded. */
  awaitingBaseChoice: boolean;
  /** What `recordCycleBaseChoice` will use if JROM does not override it (R4.2). */
  defaultBase: string;
}

/**
 * R7.1 — THE production cycle-start entry (`POST /api/projects/:id/cycles` calls this, not
 * `cycleService.createCycle` directly): create the cycle, then IMMEDIATELY — before the task
 * interview — run the B4/B5 branch survey so discovery has it to present (B21 injects it as the
 * first discovery exchange). Deliberately does NOT create the branch or worktree: that waits for
 * JROM's live base choice via `recordCycleBaseChoice` (R4.2). The survey is non-blocking (R7.3):
 * a survey failure degrades to an empty/degraded result and the cycle is still created.
 */
export async function startCycleWithBranchOnboarding(params: {
  cycleService: CycleCreator;
  db: DatabaseService;
  projectId: number;
  name: string;
  autonomy?: unknown;
  finalTests?: unknown;
}): Promise<CycleStartOnboarding> {
  const { cycleService, db, projectId, name } = params;

  const cycle = await cycleService.createCycle(projectId, name, params.autonomy, params.finalTests);

  let survey: CycleBranchSurvey;
  try {
    survey = await surveyCycleBranches(cycle.id, db);
  } catch {
    // surveyCycleBranches already swallows its own failures; this is the belt-and-suspenders half
    // of R7.3 — nothing about the hygiene survey may fail a cycle start.
    survey = { branches: [], degraded: true };
  }

  return { cycle, survey, awaitingBaseChoice: true, defaultBase: DEFAULT_BASE_BRANCH };
}

export interface CycleBaseChoiceResult {
  cycle: any;
  identity: CycleGitIdentity;
  /** The base actually used — JROM's override, or `main` when he took the default. */
  base: string;
}

/**
 * R7.1/R4.2 — JROM's live base choice, recorded. This is the production step that finally invokes
 * B6 (`POST /api/cycles/:id/branch-base` calls this): it runs ONLY after cycle start has presented
 * the survey, and it never picks the base itself — an absent/blank choice means he took the
 * offered default (`main`), not that this code decided.
 */
export async function recordCycleBaseChoice(params: {
  cycleId: number;
  db: DatabaseService;
  chosenBase?: string | null;
}): Promise<CycleBaseChoiceResult> {
  const { cycleId, db } = params;
  const identity = await establishCycleBranch({ cycleId, db, chosenBase: params.chosenBase });
  const cycle = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
  return { cycle, identity, base: identity.baseBranch };
}
