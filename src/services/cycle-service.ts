import { DatabaseService } from '../db/database.js';
import { ProjectService, AutonomyDefault, normalizeAutonomyDefault } from './project-service.js';
import {
  assertOwnerDecisionAuthority,
  type DecisionActor,
} from './decision-authority.js';
import {
  InheritanceService,
  type EffectiveTopology,
} from './inheritance-service.js';
import { TopologyFreezeService } from './topology-freeze-service.js';
import type { GitWorktreeService } from './git-worktree-service.js';
import fs from 'node:fs/promises';
import path from 'node:path';

export type CycleStatus = 'pending' | 'active' | 'completed' | 'archived';

const CYCLE_PHASES = ['discovery', 'planning', 'implementation', 'final_tests', 'complete'] as const;

// B19-fix2 / R5.22: any target phase at/after 'implementation' must be frozen before it becomes
// observable — a direct jump (e.g. planning->final_tests) skips 'implementation' but still needs
// the stamp.
const FREEZE_ON_OR_AFTER: readonly string[] = ['implementation', 'final_tests', 'complete'];

export interface Cycle {
  id: number;
  project_id: number;
  name: string;
  folder_name: string;
  phase: string;
  autonomy: AutonomyDefault;
  status: CycleStatus | string;
  awaiting_approval: boolean;
  final_tests_enabled: boolean;
  // B1 (cycle-branch-lifecycle) / v113: nullable server-owned git identity (R4.2). Null on
  // legacy cycles created before this model existed — never inferred or backfilled (R4.4).
  git_base_branch: string | null;
  git_branch: string | null;
  git_worktree_path: string | null;
  git_worktree_id: string | null;
  git_merged_at: string | null;
  // R6.1: parked post-implementation, awaiting the explicit merge action. Distinct from
  // awaiting_approval (the planning-only gate) — never overloaded.
  awaiting_merge: boolean;
  git_cleanup_pending: boolean;
  created_at: string;
  // augmented at creation for callers (not stored in DB row)
  folder_path?: string;
}

/** B16 (R6.2): result of an owner-gated merge attempt / cleanup retry / idempotent no-op. */
export interface MergeCycleBranchResult {
  cycleId: number;
  merged: boolean;
  cleaned: boolean;
  mergedAt: string | null;
  /** true when this call was a no-op because the cycle was already merged+cleaned before it ran. */
  alreadyMerged?: boolean;
}

export function normalizeFinalTestsEnabled(value: unknown, fallback = true): boolean {
  if (value == null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  const n = Number(value);
  if (n === 0) return false;
  if (n === 1) return true;
  const s = String(value).toLowerCase();
  if (s === 'false' || s === 'off' || s === '0') return false;
  if (s === 'true' || s === 'on' || s === '1') return true;
  throw new Error(`invalid final_tests_enabled: ${value}`);
}

/** B6-T03: gate-mode cycle at planning-done awaiting JROM approval (R-E3). */
export function isAwaitingApproval(cycle: Pick<Cycle, 'autonomy' | 'awaiting_approval'>): boolean {
  return cycle.autonomy === 'pause_after_planning' && Boolean(cycle.awaiting_approval);
}

export interface CycleOverviewRow {
  id: number;
  project_id: number;
  project_name: string;
  name: string;
  phase: string;
  autonomy: AutonomyDefault;
  status: CycleStatus;
  awaiting_approval: boolean;
  folder_name: string;
  created_at: string;
  // B13-T01b: latest-run task progress (R-B5). null when the cycle has no run yet (honest, not 0/0).
  progress: { done: number; total: number } | null;
  // B13-T01b: true when the latest run has any failed/deferred run_tasks (R-B5).
  blocked: boolean;
  // B10b (R4.4): true when this cycle has no persisted git identity — legacy workspace, drives the
  // UI's "legacy workspace — no branch" marker. Never inferred/repaired; a straight read of the column.
  legacyWorkspace: boolean;
}

export interface CyclesOverview {
  counts: { pending: number; active: number; completed: number; archived: number };
  pending: CycleOverviewRow[];
  active: CycleOverviewRow[];
  completed: CycleOverviewRow[];
  // B22 (cycle-branch-lifecycle R1.1): fourth overview bucket — status-only archive, no disk move.
  archived: CycleOverviewRow[];
}

function rowToCycleOverviewRow(row: any, progressByCycle: Map<number, { done: number; total: number; blocked: boolean }>): CycleOverviewRow {
  const prog = progressByCycle.get(Number(row.id));
  return {
    id: Number(row.id),
    project_id: Number(row.project_id),
    project_name: String(row.project_name),
    name: String(row.name),
    phase: String(row.phase),
    autonomy: normalizeAutonomyDefault(row.autonomy),
    status: String(row.status) as CycleStatus,
    awaiting_approval: Boolean(Number(row.awaiting_approval)),
    folder_name: String(row.folder_name),
    created_at: String(row.created_at),
    progress: prog ? { done: prog.done, total: prog.total } : null,
    blocked: Boolean(prog?.blocked),
    legacyWorkspace: row.git_worktree_path == null
  };
}

function slugifyName(name: string): string {
  return String(name || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function formatMMDD(d: Date): string {
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${month}${day}`;
}

function rowToCycle(row: any): Cycle {
  return {
    id: Number(row.id),
    project_id: Number(row.project_id),
    name: String(row.name),
    folder_name: String(row.folder_name),
    phase: String(row.phase),
    autonomy: normalizeAutonomyDefault(row.autonomy),
    status: String(row.status),
    awaiting_approval: Boolean(Number(row.awaiting_approval)),
    final_tests_enabled: normalizeFinalTestsEnabled(row.final_tests_enabled),
    git_base_branch: row.git_base_branch != null ? String(row.git_base_branch) : null,
    git_branch: row.git_branch != null ? String(row.git_branch) : null,
    git_worktree_path: row.git_worktree_path != null ? String(row.git_worktree_path) : null,
    git_worktree_id: row.git_worktree_id != null ? String(row.git_worktree_id) : null,
    git_merged_at: row.git_merged_at != null ? String(row.git_merged_at) : null,
    awaiting_merge: Boolean(Number(row.awaiting_merge)),
    git_cleanup_pending: Boolean(Number(row.git_cleanup_pending)),
    created_at: String(row.created_at)
  };
}

export class CycleService {
  private readonly inheritance: InheritanceService;
  private readonly topologyFreeze: TopologyFreezeService;

  constructor(
    private readonly db: DatabaseService,
    private readonly projectService: ProjectService,
    // B10a (R4.1/R4.2): optional — when wired, a freshly created cycle immediately gets its own
    // branch + worktree (default base `main`). Absent (most unit tests) => cycles stay
    // null-identity (R4.4 legacy), zero git commands. B20's survey→live-base path passes
    // skipGitWorktree so create stays null until recordCycleBaseChoice (R7.1).
    private readonly gitWorktreeService?: GitWorktreeService
  ) {
    this.inheritance = new InheritanceService(db);
    this.topologyFreeze = new TopologyFreezeService(db);
  }

  /**
   * B19 / R5.21–R5.22: frozen snapshot once the cycle has started; else the live
   * Studio→Project→Cycle read (pre-freeze).
   */
  getEffectiveTopology(cycleId: number): EffectiveTopology {
    return this.topologyFreeze.getEffectiveTopology(cycleId);
  }

  /**
   * B19 / R5.22 — single cycle-start writer, called from every path that transitions a cycle into
   * `implementation` (setCyclePhase and approveCycle both route through this). Idempotent: a no-op
   * when a freeze row already exists for this cycle (B19-fix1 — keyed on freeze-row presence, not a
   * previous-phase heuristic, so a walk-back-then-re-enter cycle doesn't re-attempt a freeze that's
   * already stamped). Throws (blocking the phase transition) if the composed project-effective
   * topology violates R3.16 — the caller must not flip phase on failure.
   */
  private freezeTopologyOnCycleStart(cycleId: number): void {
    if (this.topologyFreeze.getFreeze(cycleId)) return;
    this.topologyFreeze.freezeForCycle(cycleId);
  }

  /**
   * Create cycle row + on-disk folder under project.directory/cycle/<slug>_<MMDD>/
   * autonomy: omitted -> inherit project.autonomy_default (R-E2); provided -> use override.
   * finalTestsInput: omitted -> inherit project.final_tests_default (R-G1); provided -> use override.
   * clock/getNow: injectable at API boundary for test determinism (no Date.now() deep in impl).
   * options.skipGitWorktree: B20 onboarding sets this so survey→live base choice remains the sole
   * production B6 path (R7.1); B10a's provisional create→B6 only runs when the service is wired
   * and this flag is absent.
   */
  async createCycle(
    projectId: number,
    name: string,
    autonomyInput?: unknown,
    finalTestsInput?: unknown,
    getNow: () => Date = () => new Date(),
    options?: { skipGitWorktree?: boolean }
  ): Promise<Cycle> {
    const project = this.projectService.getProject(projectId);
    if (!project) {
      throw new Error('unknown project');
    }
    const trimmed = (name || '').trim();
    if (!trimmed) {
      throw new Error('name is required');
    }
    const slug = slugifyName(trimmed);
    if (!slug) {
      throw new Error('name is required');
    }

    const autonomy = autonomyInput != null
      ? normalizeAutonomyDefault(autonomyInput)
      : project.autonomy_default;

    const final_tests_enabled = finalTestsInput != null
      ? normalizeFinalTestsEnabled(finalTestsInput)
      : project.final_tests_default;

    const now = getNow();
    const mmdd = formatMMDD(now);
    const folder_name = `${slug}_${mmdd}`;

    // deterministic dup handling: 409 on same project + folder_name (name+date)
    const exists = this.db.prepare(
      'SELECT 1 FROM cycles WHERE project_id = ? AND folder_name = ?'
    ).get(projectId, folder_name);
    if (exists) {
      const err: any = new Error(`cycle with folder ${folder_name} already exists for this project`);
      err.code = 'CONFLICT';
      throw err;
    }

    let row = this.db.prepare(
      `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status, final_tests_enabled)
       VALUES (?, ?, ?, 'discovery', ?, 'active', ?) RETURNING *`
    ).get(projectId, trimmed, folder_name, autonomy, final_tests_enabled ? 1 : 0) as any;

    const cycleRoot = path.join(project.directory, 'cycle');
    const folderPath = path.join(cycleRoot, folder_name);
    // fence: always under project.directory
    await fs.mkdir(folderPath, { recursive: true });

    // B10a (R4.1/R4.2): provisional cycle-start call to B6 with default base `main`. B6 itself
    // verifies then persists git_* and compensates (removes worktree + branch) if persist fails —
    // no half-built identity. Soft-skip on failure: R4.4 forbids inferring/repairing an identity,
    // so a refused create is indistinguishable from a pre-existing null-identity legacy cycle.
    // B20 passes skipGitWorktree so production survey→choice remains the single live B6 path.
    if (this.gitWorktreeService && !options?.skipGitWorktree) {
      try {
        await this.gitWorktreeService.createCycleWorktree({
          projectDir: project.directory,
          cycleId: Number(row.id),
          slug,
          baseRef: 'main'
        });
        row = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(row.id) as any;
      } catch (e: any) {
        console.warn(
          `[CycleService] cycle ${row.id} worktree-at-start skipped (legacy null-identity path): ${e?.message || e}`
        );
      }
    }

    return {
      ...rowToCycle(row),
      folder_path: folderPath
    };
  }

  /** B3-T01 / B11-T05: resolve on-disk cycle doc root (R-G3 reviewability after completion). */
  getCycleDocDir(cycleId: number): string {
    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycle) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const project = this.projectService.getProject(Number(cycle.project_id));
    if (!project) {
      const err: any = new Error('unknown project');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const cycleRoot = path.join(project.directory, 'cycle');
    // completed AND archived both live under cycle/completed/ — archive is status-only (B22/R1.3),
    // so there is never a second folder move into an archived/ path.
    const status = String(cycle.status);
    if (status === 'completed' || status === 'archived') {
      return path.join(cycleRoot, 'completed', String(cycle.folder_name));
    }
    return path.join(cycleRoot, String(cycle.folder_name));
  }

  /**
   * B7 (R6.27): resolve the cycle's chat-file scratch dir — <project.directory>/tmp/<folder_name>.
   * Deliberately flat (no completed/ mirror like getCycleDocDir): these are ephemeral chat paste
   * artifacts, not an archived cycle deliverable. Never OS /tmp (a reboot wiped /tmp/helm-harness
   * and crash-looped Helm 1.38M times) — always rooted under the project's own directory.
   */
  getCycleTmpDir(cycleId: number): string {
    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycle) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const project = this.projectService.getProject(Number(cycle.project_id));
    if (!project) {
      const err: any = new Error('unknown project');
      err.code = 'NOT_FOUND';
      throw err;
    }
    return path.join(project.directory, 'tmp', String(cycle.folder_name));
  }

  /** B11-T05: true when cycle-linked runs have launching/running worker_runtimes (orphan-guard). */
  hasActiveWorkersForCycle(cycleId: number): boolean {
    const row = this.db.prepare(
      `SELECT COUNT(*) AS c
       FROM worker_runtimes wr
       INNER JOIN runs r ON r.id = wr.run_id
       WHERE r.cycle_id = ? AND wr.state IN ('launching', 'running')`
    ).get(cycleId) as { c: number };
    return Number(row?.c ?? 0) > 0;
  }

  /**
   * B13-T01b: latest-run task progress per cycle (R-B5), 2 grouped queries (no N+1) — latest run
   * id per cycle_id, then task counts per run_id. Cycles with no run are simply absent from the map.
   */
  private getProgressByCycle(): Map<number, { done: number; total: number; blocked: boolean }> {
    const latestRuns = this.db.prepare(
      `SELECT r.cycle_id AS cycle_id, r.id AS run_id
       FROM runs r
       INNER JOIN (SELECT cycle_id, MAX(id) AS max_id FROM runs WHERE cycle_id IS NOT NULL GROUP BY cycle_id) latest
         ON latest.cycle_id = r.cycle_id AND latest.max_id = r.id`
    ).all() as Array<{ cycle_id: number; run_id: number }>;
    if (latestRuns.length === 0) return new Map();

    const counts = this.db.prepare(
      `SELECT run_id,
              SUM(status = 'complete') AS done,
              COUNT(*) AS total,
              SUM(status IN ('failed', 'deferred')) AS blocked
       FROM run_tasks
       GROUP BY run_id`
    ).all() as Array<{ run_id: number; done: number; total: number; blocked: number }>;
    const countsByRun = new Map(counts.map((c) => [Number(c.run_id), c]));

    const result = new Map<number, { done: number; total: number; blocked: boolean }>();
    for (const { cycle_id, run_id } of latestRuns) {
      const c = countsByRun.get(Number(run_id));
      result.set(Number(cycle_id), {
        done: Number(c?.done || 0),
        total: Number(c?.total || 0),
        blocked: Number(c?.blocked || 0) > 0
      });
    }
    return result;
  }

  /** B2-T02: cross-project cycle listing grouped by status for Overview board (R-A2).
   * B22 / R1.1: fourth bucket `archived` (status-only; docs stay under cycle/completed/). */
  listCyclesOverview(): CyclesOverview {
    const rows = this.db.prepare(
      `SELECT c.id, c.project_id, p.name AS project_name, c.name, c.phase, c.autonomy,
              c.status, c.awaiting_approval, c.folder_name, c.created_at, c.git_worktree_path
       FROM cycles c
       JOIN projects p ON p.id = c.project_id
       ORDER BY c.created_at DESC`
    ).all() as any[];

    const progressByCycle = this.getProgressByCycle();
    const pending: CycleOverviewRow[] = [];
    const active: CycleOverviewRow[] = [];
    const completed: CycleOverviewRow[] = [];
    const archived: CycleOverviewRow[] = [];

    for (const row of rows) {
      const item = rowToCycleOverviewRow(row, progressByCycle);
      switch (item.status) {
        case 'pending':
          pending.push(item);
          break;
        case 'completed':
          completed.push(item);
          break;
        case 'archived':
          archived.push(item);
          break;
        case 'active':
        default:
          active.push(item);
          break;
      }
    }

    return {
      counts: {
        pending: pending.length,
        active: active.length,
        completed: completed.length,
        archived: archived.length
      },
      pending,
      active,
      completed,
      archived
    };
  }

  /**
   * B2-T03: set cycle phase with one-implementation-per-project guard (R-B3).
   * Blocks phase→implementation when another non-completed cycle in the same project
   * is already phase=implementation. Discovery/planning overlap allowed.
   */
  setCyclePhase(cycleId: number, phase: string): Cycle {
    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycle) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const normalized = String(phase || '').trim();
    if (!CYCLE_PHASES.includes(normalized as (typeof CYCLE_PHASES)[number])) {
      throw new Error(`invalid phase: ${phase}`);
    }

    if (normalized === 'implementation') {
      const blocker = this.db.prepare(
        `SELECT id, name FROM cycles
         WHERE project_id = ? AND phase = 'implementation' AND status != 'completed' AND id != ?`
      ).get(cycle.project_id, cycleId) as any;
      if (blocker) {
        const err: any = new Error(
          `project already has cycle ${blocker.id} (${blocker.name}) in implementation`
        );
        err.code = 'CONFLICT';
        throw err;
      }
    }
    // B19-fix2 / R5.22: freeze on entry into ANY post-planning phase that requires a stamp, not
    // just 'implementation' — a direct planning->final_tests (or ->complete) jump must not reach
    // a running/observable state unfrozen. Throws (blocks the transition) on an R3.16-violating
    // composed topology. No-ops if already frozen (B19-fix1 freeze-row-keyed idempotency).
    if (FREEZE_ON_OR_AFTER.includes(normalized)) {
      this.freezeTopologyOnCycleStart(cycleId);
    }

    const row = this.db.prepare(
      'UPDATE cycles SET phase = ? WHERE id = ? RETURNING *'
    ).get(normalized, cycleId) as any;

    return rowToCycle(row);
  }

  /**
   * B6-T03: planning complete — gate-mode cycles enter awaiting-approval; autonomous cycles
   * auto-proceed to implementation (R-E3). B10 run-orchestrator will call this at planning-done.
   */
  finishPlanning(cycleId: number): Cycle {
    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycle) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const phase = String(cycle.phase);
    if (phase !== 'planning') {
      const err: any = new Error(`cycle ${cycleId} is not in planning phase (phase: ${phase})`);
      err.code = 'CONFLICT';
      throw err;
    }

    const autonomy = normalizeAutonomyDefault(cycle.autonomy);
    if (autonomy === 'pause_after_planning') {
      const row = this.db.prepare(
        'UPDATE cycles SET awaiting_approval = 1 WHERE id = ? RETURNING *'
      ).get(cycleId) as any;
      return rowToCycle(row);
    }

    return this.setCyclePhase(cycleId, 'implementation');
  }

  /**
   * B6-T03: JROM approves a gated cycle — awaiting-approval → implementation (R-E3).
   * Guarded: only valid for gate-mode cycles actually awaiting approval.
   * B10b/R2.10: jkage L0 (or any agent actor) cannot exercise this owner gate.
   */
  approveCycle(cycleId: number, opts?: { actor?: DecisionActor | null }): Cycle {
    assertOwnerDecisionAuthority(opts?.actor);
    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycle) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const current = rowToCycle(cycle);
    if (!isAwaitingApproval(current)) {
      const err: any = new Error(`cycle ${cycleId} is not awaiting approval`);
      err.code = 'CONFLICT';
      throw err;
    }

    const blocker = this.db.prepare(
      `SELECT id, name FROM cycles
       WHERE project_id = ? AND phase = 'implementation' AND status != 'completed' AND id != ?`
    ).get(cycle.project_id, cycleId) as any;
    if (blocker) {
      const err: any = new Error(
        `project already has cycle ${blocker.id} (${blocker.name}) in implementation`
      );
      err.code = 'CONFLICT';
      throw err;
    }

    // B19 / R5.22: this path flips phase directly (not via setCyclePhase) — must route through
    // the same freeze call site so gate-mode cycles don't launch unfrozen.
    this.freezeTopologyOnCycleStart(cycleId);

    const row = this.db.prepare(
      `UPDATE cycles SET phase = 'implementation', awaiting_approval = 0 WHERE id = ? RETURNING *`
    ).get(cycleId) as any;

    return rowToCycle(row);
  }

  /**
   * B6-T02: update a cycle's autonomy while it is still pre-implementation (R-E2/E3).
   * Locked (409) once phase is implementation/final_tests/complete — server-side guard,
   * defense in depth alongside the UI disable.
   */
  setCycleAutonomy(cycleId: number, autonomyInput: unknown): Cycle {
    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycle) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const LOCKED_PHASES = ['implementation', 'final_tests', 'complete'];
    if (LOCKED_PHASES.includes(String(cycle.phase))) {
      const err: any = new Error(
        `cycle ${cycleId} autonomy is locked — implementation has started (phase: ${cycle.phase})`
      );
      err.code = 'CONFLICT';
      throw err;
    }

    const autonomy = normalizeAutonomyDefault(autonomyInput);

    const row = this.db.prepare(
      'UPDATE cycles SET autonomy = ? WHERE id = ? RETURNING *'
    ).get(autonomy, cycleId) as any;

    return rowToCycle(row);
  }

  /**
   * B11-T01: update a cycle's Final Tests policy while still pre-implementation (R-G1).
   * Locked (409) once phase is implementation/final_tests/complete — same guard as setCycleAutonomy.
   */
  setCycleFinalTests(cycleId: number, enabledInput: unknown): Cycle {
    const cycle = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycle) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const LOCKED_PHASES = ['implementation', 'final_tests', 'complete'];
    if (LOCKED_PHASES.includes(String(cycle.phase))) {
      const err: any = new Error(
        `cycle ${cycleId} final tests policy is locked — implementation has started (phase: ${cycle.phase})`
      );
      err.code = 'CONFLICT';
      throw err;
    }

    const final_tests_enabled = normalizeFinalTestsEnabled(enabledInput);

    const row = this.db.prepare(
      'UPDATE cycles SET final_tests_enabled = ? WHERE id = ? RETURNING *'
    ).get(final_tests_enabled ? 1 : 0, cycleId) as any;

    return rowToCycle(row);
  }

  /**
   * B2-T04: complete a cycle by moving its on-disk folder to completed/ and setting status='completed' (R-B2, R-G3).
   * Move (fs.rename) happens first; status only updated on success. Rollback move on post-move failure.
   * Creates cycle/completed/ if missing. 409 on destination collision (no suffix/overwrite).
   * Both source and target paths are fenced under project.directory.
   */
  async completeCycle(cycleId: number): Promise<Cycle> {
    const cycleRow = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycleRow) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const project = this.projectService.getProject(cycleRow.project_id);
    if (!project) {
      const err: any = new Error('unknown project');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const cycleRoot = path.join(project.directory, 'cycle');
    const source = path.join(cycleRoot, cycleRow.folder_name);
    const completedRoot = path.join(cycleRoot, 'completed');
    const target = path.join(completedRoot, cycleRow.folder_name);

    // fence: both paths must be under project.directory
    const resolve = (p: string) => path.resolve(p);
    const base = resolve(project.directory);
    if (!resolve(source).startsWith(base) || !resolve(target).startsWith(base)) {
      const err: any = new Error('path escape detected');
      err.code = 'FORBIDDEN';
      throw err;
    }

    // ensure source exists and is a directory
    try {
      const st = await fs.stat(source);
      if (!st.isDirectory()) {
        const err: any = new Error('cycle folder is not a directory');
        err.code = 'NOT_FOUND';
        throw err;
      }
    } catch (e: any) {
      if (e.code === 'ENOENT') {
        const err: any = new Error('cycle folder not found');
        err.code = 'NOT_FOUND';
        throw err;
      }
      throw e;
    }

    // collision check: do not overwrite
    try {
      await fs.stat(target);
      const err: any = new Error(`destination cycle folder ${cycleRow.folder_name} already exists in completed`);
      err.code = 'CONFLICT';
      throw err;
    } catch (e: any) {
      if (e.code !== 'ENOENT') {
        throw e;
      }
    }

    // B11-T05: orphan-guard — never move while cycle-linked agents are launching/running
    if (this.hasActiveWorkersForCycle(cycleId)) {
      const err: any = new Error('cannot complete: active agents or open handles for this cycle');
      err.code = 'CONFLICT';
      throw err;
    }

    await fs.mkdir(completedRoot, { recursive: true });

    // MOVE FIRST (atomic intent on same FS)
    await fs.rename(source, target);

    // only now update status
    let updated: any;
    try {
      updated = this.db.prepare(
        `UPDATE cycles SET status = 'completed' WHERE id = ? RETURNING *`
      ).get(cycleId) as any;
    } catch (e) {
      // rollback the move if status update failed
      try {
        await fs.rename(target, source);
      } catch {}
      throw e;
    }

    const result = rowToCycle(updated);
    return {
      ...result,
      folder_path: target
    };
  }

  /**
   * B22 / R1.2–R1.3: archive a completed cycle (status-only).
   * Allowed only from status='completed' (409 otherwise). Does NOT move the on-disk folder,
   * delete docs, or touch DB history (runs/run_tasks stay). Folder remains under cycle/completed/.
   */
  archiveCycle(cycleId: number): Cycle {
    const cycleRow = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycleRow) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const status = String(cycleRow.status);
    if (status !== 'completed') {
      const err: any = new Error(
        `cannot archive: cycle ${cycleId} status is '${status}' (only completed cycles may be archived)`
      );
      err.code = 'CONFLICT';
      throw err;
    }

    const updated = this.db.prepare(
      `UPDATE cycles SET status = 'archived' WHERE id = ? RETURNING *`
    ).get(cycleId) as any;

    const result = rowToCycle(updated);
    return {
      ...result,
      folder_path: this.getCycleDocDir(cycleId)
    };
  }

  /**
   * B22 / R1.3: un-archive — restore an archived cycle to status='completed'.
   * Status-only: no folder move, nothing deleted. 409 unless currently archived.
   */
  unarchiveCycle(cycleId: number): Cycle {
    const cycleRow = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycleRow) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const status = String(cycleRow.status);
    if (status !== 'archived') {
      const err: any = new Error(
        `cannot unarchive: cycle ${cycleId} status is '${status}' (only archived cycles may be unarchived)`
      );
      err.code = 'CONFLICT';
      throw err;
    }

    const updated = this.db.prepare(
      `UPDATE cycles SET status = 'completed' WHERE id = ? RETURNING *`
    ).get(cycleId) as any;

    const result = rowToCycle(updated);
    return {
      ...result,
      folder_path: this.getCycleDocDir(cycleId)
    };
  }

  /**
   * B12 (R2.2/R2.3): deletes a cycle's on-disk artifacts — composes the GIT-ONLY
   * `cleanupCycleGit` primitive (worktree + branch, refuses on base/wrong-namespace) with removal
   * of the cycle's docs folder. Per R2.2(d) this is artifact retirement, not a DB purge: the
   * `cycles` row and all DB history (`runs`, `run_tasks`, `planning_provenance`,
   * `worker_runtimes`) are left completely untouched. Refuses (409) while agents/workers are still
   * open on this cycle — checked here directly so the refusal holds even in the (test-only)
   * unwired-GitWorktreeService path. Confirm-step / autonomy gating (R2.3) is a caller concern
   * (B13/B14), not this primitive's.
   */
  async deleteCycle(cycleId: number): Promise<Cycle> {
    const cycleRow = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycleRow) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }

    const project = this.projectService.getProject(Number(cycleRow.project_id));
    if (!project) {
      const err: any = new Error('unknown project');
      err.code = 'NOT_FOUND';
      throw err;
    }

    if (this.hasActiveWorkersForCycle(cycleId)) {
      const err: any = new Error('cannot delete: active agents or open handles for this cycle');
      err.code = 'CONFLICT';
      throw err;
    }

    if (this.gitWorktreeService) {
      await this.gitWorktreeService.cleanupCycleGit(project.directory, cycleId);
    }

    const docDir = this.getCycleDocDir(cycleId);
    const base = path.resolve(project.directory);
    if (!path.resolve(docDir).startsWith(base)) {
      const err: any = new Error('path escape detected');
      err.code = 'FORBIDDEN';
      throw err;
    }
    await fs.rm(docDir, { recursive: true, force: true });

    return {
      ...rowToCycle(cycleRow),
      folder_path: docDir
    };
  }

  /**
   * B16 (R6.2): owner-gated merge — CAS/idempotent. Revalidates (no active workers, persisted
   * identity matches `git worktree list`, cycle branch clean, base ref exists and its checkout is
   * clean and unambiguous), merges `--no-ff` into the persisted base, then calls the GIT-ONLY
   * `cleanupCycleGit` primitive so the cycle's docs survive for the Completed bucket (B19). A
   * cleanup failure AFTER the merge has landed sets `git_cleanup_pending`; a later call retries
   * ONLY the cleanup — the landed merge is never replayed or rolled back. A failure BEFORE the
   * merge lands (dirty base, lost CAS race) restores `awaiting_merge=1` so the cycle stays
   * retryable and no merge ever ran. A repeat call after a full merge+cleanup is a no-op.
   */
  async mergeCycleBranch(cycleId: number): Promise<MergeCycleBranchResult> {
    const cycleRow = this.db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
    if (!cycleRow) {
      const err: any = new Error('unknown cycle');
      err.code = 'NOT_FOUND';
      throw err;
    }
    const project = this.projectService.getProject(Number(cycleRow.project_id));
    if (!project) {
      const err: any = new Error('unknown project');
      err.code = 'NOT_FOUND';
      throw err;
    }
    if (!this.gitWorktreeService) {
      throw new Error('git worktree service not wired — cannot merge');
    }

    if (Number(cycleRow.git_cleanup_pending) === 1) {
      return this.retryMergeCleanup(project.directory, cycleId, cycleRow);
    }

    if (cycleRow.git_merged_at != null) {
      return {
        cycleId,
        merged: true,
        cleaned: true,
        mergedAt: String(cycleRow.git_merged_at),
        alreadyMerged: true
      };
    }

    if (!Number(cycleRow.awaiting_merge)) {
      const err: any = new Error(`cycle ${cycleId} is not awaiting merge`);
      err.code = 'CONFLICT';
      throw err;
    }

    const branch = cycleRow.git_branch as string | null;
    const baseBranch = cycleRow.git_base_branch as string | null;
    const worktreePath = cycleRow.git_worktree_path as string | null;
    const worktreeId = cycleRow.git_worktree_id as string | null;
    if (!branch || !baseBranch || !worktreePath || !worktreeId) {
      throw new Error(`cycle ${cycleId} has no persisted git identity to merge`);
    }

    if (this.hasActiveWorkersForCycle(cycleId)) {
      const err: any = new Error(`cannot merge: active agents or open handles for cycle ${cycleId}`);
      err.code = 'CONFLICT';
      throw err;
    }

    // R6.2: trust nothing — revalidate the persisted identity against live git state before any
    // mutation, same fail-closed posture as B10b's verifyPersistedWorktree callers.
    await this.gitWorktreeService.verifyPersistedWorktree(project.directory, { worktreePath, branch });

    // CAS claim: the sole gate between revalidation and the actual merge. A concurrent second call
    // that reaches this UPDATE after the first has already flipped awaiting_merge loses the race
    // (changes !== 1) and refuses here — no merge, no double submit.
    const claim = this.db.prepare(
      `UPDATE cycles SET awaiting_merge = 0
       WHERE id = ? AND awaiting_merge = 1 AND git_merged_at IS NULL AND git_cleanup_pending = 0`
    ).run(cycleId);
    if (claim.changes !== 1) {
      const err: any = new Error(`cycle ${cycleId} merge already claimed by a concurrent call`);
      err.code = 'CONFLICT';
      throw err;
    }

    try {
      await this.gitWorktreeService.mergeCycleIntoBase(project.directory, {
        cycleId,
        cycleBranch: branch,
        baseBranch,
        cycleWorktreePath: worktreePath
      });
    } catch (e) {
      // No merge landed — release the claim so the cycle stays retryable (e.g. after the base
      // checkout is cleaned up).
      this.db.prepare('UPDATE cycles SET awaiting_merge = 1 WHERE id = ?').run(cycleId);
      throw e;
    }

    // The merge is durable from here on — git_merged_at is never cleared or replayed by this
    // method again, regardless of what happens to cleanup below.
    const mergedAt = new Date().toISOString();
    this.db.prepare('UPDATE cycles SET git_merged_at = ? WHERE id = ?').run(mergedAt, cycleId);

    try {
      await this.gitWorktreeService.cleanupCycleGit(project.directory, cycleId);
    } catch (e) {
      this.db.prepare('UPDATE cycles SET git_cleanup_pending = 1 WHERE id = ?').run(cycleId);
      throw e;
    }

    return { cycleId, merged: true, cleaned: true, mergedAt };
  }

  /** B16: cleanup-only retry path for a cycle whose merge already landed but cleanup failed. */
  private async retryMergeCleanup(
    projectDir: string,
    cycleId: number,
    cycleRow: any
  ): Promise<MergeCycleBranchResult> {
    if (this.hasActiveWorkersForCycle(cycleId)) {
      const err: any = new Error(`cannot retry cleanup: active agents or open handles for cycle ${cycleId}`);
      err.code = 'CONFLICT';
      throw err;
    }
    await this.gitWorktreeService!.cleanupCycleGit(projectDir, cycleId);
    this.db.prepare('UPDATE cycles SET git_cleanup_pending = 0 WHERE id = ?').run(cycleId);
    return {
      cycleId,
      merged: true,
      cleaned: true,
      mergedAt: cycleRow.git_merged_at != null ? String(cycleRow.git_merged_at) : null
    };
  }
}
