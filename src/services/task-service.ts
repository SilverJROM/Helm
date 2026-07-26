import { DatabaseService } from '../db/database.js';

export interface TaskRow {
  id: number;
  project_id: number;
  task_key: string | null;
  label: string;
  status: 'completed' | 'working' | 'pending';
  agent: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface RosterEntry {
  name: string;
  model: string;
  state: 'working' | 'idle' | 'not-spawned';
}

export interface CompletedArchive {
  projectId: number;
  projectName: string;
  count: number;
  latestAt: string;
  tasks: TaskRow[];
}

/**
 * D3 TaskService: app-owned tasks for per-project tasklist (C3r OVM replacement).
 * Coordinator-updated exclusively via /ingest/task-update (token claim provides project_id).
 * Roster derived live from master_runtimes + worker_runtimes (no extra state).
 */
export class TaskService {
  constructor(private readonly db: DatabaseService) {}

  listTasks(projectId: number): TaskRow[] {
    return this.db
      .prepare(
        'SELECT * FROM tasks WHERE project_id = ? ORDER BY position ASC, updated_at DESC, id DESC'
      )
      .all(projectId) as TaskRow[];
  }

  upsertTask(
    projectId: number,
    t: {
      task_key?: string | null;
      label: string;
      status?: 'completed' | 'working' | 'pending';
      agent?: string | null;
      position?: number;
    }
  ): TaskRow | null {
    const now = new Date().toISOString();
    const key = t.task_key ?? null;
    const status = t.status || 'pending';
    const agent = t.agent ?? null;
    const pos = t.position ?? 0;

    if (key != null) {
      const existing = this.db
        .prepare('SELECT id FROM tasks WHERE project_id = ? AND task_key = ?')
        .get(projectId, key) as { id: number } | undefined;
      if (existing) {
        this.db
          .prepare(
            `UPDATE tasks SET label = ?, status = COALESCE(?, status), agent = ?, position = COALESCE(?, position), updated_at = ? WHERE id = ?`
          )
          .run(t.label, status, agent, pos, now, existing.id);
        return this.getTask(existing.id);
      }
    }

    const id = this.db
      .prepare(
        `INSERT INTO tasks (project_id, task_key, label, status, agent, position, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`
      )
      .run(projectId, key, t.label, status, agent, pos, now, now).lastInsertRowid;

    return this.getTask(Number(id));
  }

  getTask(id: number): TaskRow | null {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | null;
  }

  /**
   * Roster for Command Center Tasks tab (D3).
   * Master (coordinator) row (if any) + all worker_runtimes for the project.
   * State mapping from runtime:
   *   launching | running => 'working'
   *   parked | failed | done | reaped => 'idle'
   *   no row for master => 'not-spawned' (workers list only present rows)
   */
  getRoster(projectId: number): RosterEntry[] {
    const m = this.db
      .prepare(
        "SELECT provider, model, state FROM master_runtimes WHERE project_id = ? ORDER BY updated_at DESC LIMIT 1"
      )
      .get(projectId) as { provider: string; model: string; state: string } | undefined;

    let master: RosterEntry;
    if (m) {
      const isWorking = m.state === 'running' || m.state === 'launching';
      const isIdle = m.state === 'parked' || m.state === 'failed';
      master = {
        name: 'coordinator',
        model: m.model,
        state: isWorking ? 'working' : isIdle ? 'idle' : 'working'
      };
    } else {
      master = { name: 'coordinator', model: '—', state: 'not-spawned' };
    }

    const ws = this.db
      .prepare(
        "SELECT role, provider, model, state FROM worker_runtimes WHERE project_id = ? ORDER BY id DESC"
      )
      .all(projectId) as Array<{ role: string; provider: string; model: string; state: string }>;

    const workers: RosterEntry[] = ws.map((w) => {
      const isWorking = w.state === 'running' || w.state === 'launching';
      const isIdle = w.state === 'reaped' || w.state === 'failed' || w.state === 'done';
      return {
        name: w.role,
        model: w.model,
        state: isWorking ? 'working' : isIdle ? 'idle' : 'working'
      };
    });

    return [master, ...workers];
  }

  /**
   * D4: Completed archives (C4r). Groups ONLY tasks with status='completed', by project.
   * Returns per-project archive entries with count of completed, latest updated_at, and the completed TaskRows.
   * (If task_key prefixes form sub-lists in future, grouping could key on prefix+project; default per-project per spec.)
   */
  listCompletedArchives(projectId?: number): CompletedArchive[] {
    const where = projectId != null
      ? 'WHERE t.project_id = ? AND t.status = \'completed\''
      : 'WHERE t.status = \'completed\'';
    const params: any[] = projectId != null ? [projectId] : [];
    const rows = this.db
      .prepare(
        `SELECT t.*, p.name as project_name
         FROM tasks t
         JOIN projects p ON p.id = t.project_id
         ${where}
         ORDER BY t.project_id, t.updated_at DESC, t.id DESC`
      )
      .all(...params) as Array<any>;

    const byProj: Record<number, CompletedArchive> = {};
    for (const r of rows) {
      const pid = r.project_id;
      if (!byProj[pid]) {
        byProj[pid] = {
          projectId: pid,
          projectName: r.project_name || `project-${pid}`,
          count: 0,
          latestAt: r.updated_at,
          tasks: []
        };
      }
      byProj[pid].count += 1;
      if (r.updated_at > byProj[pid].latestAt) byProj[pid].latestAt = r.updated_at;
      byProj[pid].tasks.push({
        id: r.id,
        project_id: r.project_id,
        task_key: r.task_key,
        label: r.label,
        status: r.status,
        agent: r.agent,
        position: r.position,
        created_at: r.created_at,
        updated_at: r.updated_at
      } as TaskRow);
    }
    return Object.values(byProj);
  }
}
