import { DatabaseService } from '../db/database.js';

export interface TrackingReadOptions {
  projectId?: number;
  limit?: number;
}

/** A read-only, transactionally consistent view of Helm's native run substrate. */
export class TrackingReadService {
  constructor(private readonly db: DatabaseService) {}

  snapshot(options: TrackingReadOptions = {}) {
    const projectId = options.projectId == null ? null : Number(options.projectId);
    const limit = Math.max(1, Math.min(100, Number.isFinite(options.limit) ? Math.floor(options.limit!) : 50));
    if (projectId != null && (!Number.isInteger(projectId) || projectId < 1)) {
      throw new Error('project_id must be a positive integer');
    }

    return this.db.raw.transaction(() => {
      const projects = this.db.raw.prepare(`
        SELECT id, name, directory, status, active, created_at, updated_at
        FROM projects
        WHERE (? IS NULL OR id = ?)
        ORDER BY id
      `).all(projectId, projectId) as any[];
      const projectIds = projects.map((p) => p.id);
      if (projectIds.length === 0) return { projects: [], runs: [], orphan_sessions: [], limit };

      const marks = projectIds.map(() => '?').join(',');
      const runs = this.db.raw.prepare(`
        SELECT r.*, p.name AS project_name
        FROM runs r JOIN projects p ON p.id = r.project_id
        WHERE r.project_id IN (${marks})
        ORDER BY COALESCE(r.ended_at, r.started_at) DESC, r.id DESC
        LIMIT ?
      `).all(...projectIds, limit) as any[];
      const runIds = runs.map((r) => r.id);
      const runMarks = runIds.length ? runIds.map(() => '?').join(',') : 'NULL';
      const taskCounts = new Map<number, any>((this.db.raw.prepare(`
        SELECT run_id,
          COUNT(*) AS total,
          SUM(CASE WHEN status = 'complete' THEN 1 ELSE 0 END) AS done,
          SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'deferred' THEN 1 ELSE 0 END) AS parked,
          MAX(updated_at) AS last_progress_at
        FROM run_tasks WHERE run_id IN (${runMarks}) GROUP BY run_id
      `).all(...runIds) as any[]).map((r) => [r.run_id, r]));
      const workers = this.db.raw.prepare(`
        SELECT id, run_id, project_id, role, provider, model, session, state, started_at, ended_at, ts
        FROM worker_runtimes
        WHERE run_id IN (${runMarks}) AND state IN ('launching', 'running')
        ORDER BY id
      `).all(...runIds) as any[];
      const sessions = this.db.raw.prepare(`
        SELECT id, name, kind, project_id, run_id, status, created_at, last_used_at, ended_at, reason
        FROM helm_sessions
        WHERE run_id IN (${runMarks}) AND status IN ('active', 'idle')
        ORDER BY id
      `).all(...runIds) as any[];
      const orphanSessions = this.db.raw.prepare(`
        SELECT s.id, s.name, s.kind, s.project_id, s.run_id, s.status, s.created_at, s.last_used_at, s.ended_at, s.reason,
          'orphaned' AS state
        FROM helm_sessions s
        LEFT JOIN runs r ON r.id = s.run_id
        WHERE s.project_id IN (${marks}) AND s.status IN ('active', 'idle')
          AND (s.run_id IS NULL OR r.id IS NULL)
        ORDER BY s.id
      `).all(...projectIds) as any[];

      const workersByRun = new Map<number, any[]>();
      const sessionsByRun = new Map<number, any[]>();
      for (const worker of workers) workersByRun.set(worker.run_id, [...(workersByRun.get(worker.run_id) ?? []), worker]);
      for (const session of sessions) sessionsByRun.set(session.run_id, [...(sessionsByRun.get(session.run_id) ?? []), session]);
      const terminal = (run: any) => ['complete', 'failed', 'blocked'].includes(run.phase) || ['complete', 'failed'].includes(run.status);
      const newest = (...values: Array<string | null | undefined>) => values.filter(Boolean).sort().at(-1) ?? null;

      const trackedRuns = runs.map((run) => {
        const counts = taskCounts.get(run.id) ?? { total: 0, done: 0, failed: 0, parked: 0, last_progress_at: null };
        const active_workers = workersByRun.get(run.id) ?? [];
        const active_sessions = sessionsByRun.get(run.id) ?? [];
        const hasActiveChildren = active_workers.length > 0 || active_sessions.length > 0;
        const state = terminal(run)
          ? (hasActiveChildren ? 'terminal_with_active_children' : 'terminal')
          : Number(counts.total) === 0 ? 'empty' : 'active';
        return {
          project: { id: run.project_id, name: run.project_name },
          identity: { id: run.id, external_run_id: run.external_run_id, generation: run.generation, batch_id: run.batch_id, source: run.source },
          phase: run.phase,
          status: run.status,
          state,
          progress: { done: Number(counts.done), failed: Number(counts.failed), parked: Number(counts.parked), total: Number(counts.total) },
          active_workers,
          active_sessions,
          last_progress_at: newest(run.ended_at, counts.last_progress_at, ...active_workers.map((w) => w.ts), ...active_sessions.map((s) => s.last_used_at ?? s.created_at), run.started_at),
        };
      });
      return { projects, runs: trackedRuns, orphan_sessions: orphanSessions, limit };
    })();
  }
}
