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
import fs from 'node:fs/promises';
import path from 'node:path';

export type CycleStatus = 'pending' | 'active' | 'completed';

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
  created_at: string;
  // augmented at creation for callers (not stored in DB row)
  folder_path?: string;
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
}

export interface CyclesOverview {
  counts: { pending: number; active: number; completed: number };
  pending: CycleOverviewRow[];
  active: CycleOverviewRow[];
  completed: CycleOverviewRow[];
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
    blocked: Boolean(prog?.blocked)
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
    created_at: String(row.created_at)
  };
}

export class CycleService {
  private readonly inheritance: InheritanceService;
  private readonly topologyFreeze: TopologyFreezeService;

  constructor(
    private readonly db: DatabaseService,
    private readonly projectService: ProjectService
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
   */
  async createCycle(
    projectId: number,
    name: string,
    autonomyInput?: unknown,
    finalTestsInput?: unknown,
    getNow: () => Date = () => new Date()
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

    const row = this.db.prepare(
      `INSERT INTO cycles (project_id, name, folder_name, phase, autonomy, status, final_tests_enabled)
       VALUES (?, ?, ?, 'discovery', ?, 'active', ?) RETURNING *`
    ).get(projectId, trimmed, folder_name, autonomy, final_tests_enabled ? 1 : 0) as any;

    const cycleRoot = path.join(project.directory, 'cycle');
    const folderPath = path.join(cycleRoot, folder_name);
    // fence: always under project.directory
    await fs.mkdir(folderPath, { recursive: true });

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
      created_at: String(row.created_at),
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
    if (String(cycle.status) === 'completed') {
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

  /** B2-T02: cross-project cycle listing grouped by status for Overview board (R-A2). */
  listCyclesOverview(): CyclesOverview {
    const rows = this.db.prepare(
      `SELECT c.id, c.project_id, p.name AS project_name, c.name, c.phase, c.autonomy,
              c.status, c.awaiting_approval, c.folder_name, c.created_at
       FROM cycles c
       JOIN projects p ON p.id = c.project_id
       ORDER BY c.created_at DESC`
    ).all() as any[];

    const progressByCycle = this.getProgressByCycle();
    const pending: CycleOverviewRow[] = [];
    const active: CycleOverviewRow[] = [];
    const completed: CycleOverviewRow[] = [];

    for (const row of rows) {
      const item = rowToCycleOverviewRow(row, progressByCycle);
      switch (item.status) {
        case 'pending':
          pending.push(item);
          break;
        case 'completed':
          completed.push(item);
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
        completed: completed.length
      },
      pending,
      active,
      completed
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
}
