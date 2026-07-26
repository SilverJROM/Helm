import { DatabaseService } from '../db/database.js';
import {
  assertOwnerDecisionAuthority,
  type DecisionActor,
} from './decision-authority.js';

export interface MemoryRow {
  id: number;
  scope: 'app' | 'project' | 'agent';
  project_id: number | null;
  agent_id: number | null;
  title: string;
  description: string | null;
  type: 'user' | 'feedback' | 'project' | 'reference';
  body: string | null;
  status: 'proposed' | 'approved';
  horizon: 'long' | 'short';
  created_at: string;
  updated_at: string;
}

/**
 * E1 MemoryService (M1 + M2-backend).
 * App (global, project_id=NULL) + per-project scopes.
 * JIT queryMemory: only APPROVED app + this-project (ranked by simple title/desc/body match).
 * propose→approve: agent (token) creates app-global as 'proposed'; owner creates app as 'approved' direct;
 *   project-scope always 'approved' on create (no gate). Writes siloed (project_id fixed at create via claim).
 * Cross-project write rejected (enforce via claimProjectId or route pre-check). Cross read allowed (owner list other pid; query always scopes to claim).
 * Follows TaskService/ProjectService patterns (prepare, now ISO, interfaces, errors mappable to 400/404/403).
 */
export class MemoryService {
  constructor(private readonly db: DatabaseService) {}

  listMemories(opts: { scope?: 'app' | 'project' | 'agent'; project_id?: number; agent_id?: number; status?: 'proposed' | 'approved'; horizon?: 'long' | 'short' } = {}): MemoryRow[] {
    let sql = 'SELECT * FROM memories';
    const where: string[] = [];
    const params: any[] = [];
    if (opts.scope) {
      where.push('scope = ?');
      params.push(opts.scope);
    }
    if (opts.project_id != null) {
      where.push('project_id = ?');
      params.push(opts.project_id);
    }
    if (opts.agent_id != null) {
      where.push('agent_id = ?');
      params.push(opts.agent_id);
    }
    if (opts.status) {
      where.push('status = ?');
      params.push(opts.status);
    }
    if (opts.horizon) {
      where.push('horizon = ?');
      params.push(opts.horizon);
    }
    if (where.length > 0) {
      sql += ' WHERE ' + where.join(' AND ');
    }
    sql += ' ORDER BY updated_at DESC, id DESC';
    return this.db.prepare(sql).all(...params) as MemoryRow[];
  }

  getMemory(id: number): MemoryRow | null {
    return this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as MemoryRow | null;
  }

  createMemory(
    data: {
      scope: 'app' | 'project' | 'agent';
      project_id?: number | null;
      agent_id?: number | null;
      title: string;
      description?: string | null;
      type?: MemoryRow['type'];
      body?: string | null;
    },
    opts: { approved?: boolean; claimProjectId?: number; actor?: DecisionActor | null } = {}
  ): MemoryRow | null {
    const now = new Date().toISOString();
    const title = (data.title || '').trim();
    if (!title) throw new Error('title is required');
    if (!data.scope || !['app', 'project', 'agent'].includes(data.scope)) {
      throw new Error('scope must be app, project, or agent');
    }
    if (data.scope === 'agent') {
      if (data.agent_id == null) throw new Error('agent_id is required for agent scope');
    }

    let status: 'proposed' | 'approved' = 'approved';
    if (data.scope === 'project' || data.scope === 'agent') {
      status = 'approved';
    } else if (opts && opts.approved === false) {
      status = 'proposed';
    } else if (opts && opts.approved === true) {
      status = 'approved';
    } else {
      status = 'proposed'; // default for app (agent propose path)
    }

    // B10b/R2.10 AS-C2: owner-equivalent create (approved app-global) is an owner gate.
    // Agent project-scope create (status approved without actor) remains allowed (AS-D2).
    if (status === 'approved' && data.scope === 'app') {
      assertOwnerDecisionAuthority(opts?.actor);
    }

    const pid = data.scope === 'project' ? (data.project_id ?? null) : null;
    const aid = data.scope === 'agent' ? (data.agent_id ?? null) : null;

    // Enforce silo for agent paths (claimProjectId from token): cross-project write rejected here (also enforced in route)
    if (opts && opts.claimProjectId != null && data.scope === 'project' && pid != null && pid !== opts.claimProjectId) {
      const e: any = new Error('cross-project write rejected');
      e.code = 'CROSS_PROJECT';
      throw e;
    }

    const type = data.type || 'reference';
    const desc = data.description ?? null;
    const body = data.body ?? null;
    const horizon = (data as any).horizon === 'short' ? 'short' : 'long';

    const id = this.db
      .prepare(
        `INSERT INTO memories (scope, project_id, agent_id, title, description, type, body, status, horizon, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(data.scope, pid, aid, title, desc, type, body, status, horizon, now, now).lastInsertRowid;

    return this.getMemory(Number(id));
  }

  updateMemory(
    id: number,
    patch: Partial<Pick<MemoryRow, 'title' | 'description' | 'type' | 'body' | 'status' | 'horizon'>>,
    opts?: { actor?: DecisionActor | null }
  ): MemoryRow | null {
    const existing = this.getMemory(id);
    if (!existing) return null;
    // B10b/R2.10 AS-A3: setting status=approved is an owner gate.
    if (patch.status === 'approved') {
      assertOwnerDecisionAuthority(opts?.actor);
    }
    const now = new Date().toISOString();
    const title = patch.title !== undefined ? patch.title.trim() : existing.title;
    if (!title) throw new Error('title is required');
    const h = patch.horizon !== undefined ? patch.horizon : existing.horizon;
    this.db
      .prepare(
        `UPDATE memories SET title = ?, description = ?, type = ?, body = ?, status = ?, horizon = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        title,
        patch.description !== undefined ? patch.description : existing.description,
        patch.type !== undefined ? patch.type : existing.type,
        patch.body !== undefined ? patch.body : existing.body,
        patch.status !== undefined ? patch.status : existing.status,
        h,
        now,
        id
      );
    return this.getMemory(id);
  }

  /** B10b/R2.10 AS-B2: memory delete/reject is an owner authority surface. */
  deleteMemory(id: number, opts?: { actor?: DecisionActor | null }): void {
    assertOwnerDecisionAuthority(opts?.actor);
    this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
  }

  /** B10b/R2.10 AS-A3 */
  approveMemory(id: number, opts?: { actor?: DecisionActor | null }): MemoryRow | null {
    return this.updateMemory(id, { status: 'approved' }, opts);
  }

  rejectMemory(id: number, opts?: { actor?: DecisionActor | null }): MemoryRow | null {
    const existing = this.getMemory(id);
    if (!existing) return null;
    this.deleteMemory(id, opts);
    return existing;
  }

  /**
   * JIT scope-ranked retrieval for agents (from master-chat token claim).
   * Returns ONLY status='approved' AND (app scope OR this project).
   * If q: filter + rank by simple match score (title 3 + desc 2 + body 1), then updated desc.
   * Proposals never served. Cross-project never served (silo enforced at caller via claim).
   */
  queryMemory({ project_id, q = '' }: { project_id: number; q?: string }): MemoryRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memories
         WHERE status = 'approved'
           AND (scope = 'app' OR (scope = 'project' AND project_id = ?))
         ORDER BY updated_at DESC, id DESC`
      )
      .all(project_id) as MemoryRow[];

    if (!q || !q.trim()) return rows;

    const ql = q.toLowerCase().trim();
    const scored = rows
      .map((r) => {
        const t = (r.title || '').toLowerCase();
        const d = (r.description || '').toLowerCase();
        const b = (r.body || '').toLowerCase();
        let sc = 0;
        if (t.includes(ql)) sc += 3;
        else if (d.includes(ql)) sc += 2;
        else if (b.includes(ql)) sc += 1;
        return { r, sc };
      })
      .filter((s) => s.sc > 0)
      .sort((a, b) => b.sc - a.sc || (b.r.updated_at > a.r.updated_at ? 1 : -1));
    return scored.map((s) => s.r);
  }

  // B11 UI3: promote short-term keepers to long-term (curator proposal + JROM approve via status/horizon).
  // Clear rest for the scope (purge short after review).
  // B10b/R2.10 AS-A4: sets status='approved' — owner gate.
  promoteToLong(ids: number[], opts?: { actor?: DecisionActor | null }): void {
    assertOwnerDecisionAuthority(opts?.actor);
    if (!ids || ids.length === 0) return;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`UPDATE memories SET horizon = 'long', status = 'approved', updated_at = ? WHERE id = ?`);
    for (const id of ids) {
      try { stmt.run(now, id); } catch {}
    }
  }

  clearShort(opts: { scope?: 'app' | 'project'; project_id?: number } = {}): void {
    let sql = `DELETE FROM memories WHERE horizon = 'short'`;
    const params: any[] = [];
    if (opts.scope) {
      sql += ' AND scope = ?';
      params.push(opts.scope);
    }
    if (opts.project_id != null) {
      sql += ' AND project_id = ?';
      params.push(opts.project_id);
    }
    this.db.prepare(sql).run(...params);
  }

  // E-b2: explicit per-project short/long split query (read-only review on Projects page).
  listProjectMemoriesByHorizon(projectId: number): { shortTerm: MemoryRow[]; longTerm: MemoryRow[] } {
    const shortTerm = this.listMemories({ scope: 'project', project_id: projectId, horizon: 'short' });
    const longTerm = this.listMemories({ scope: 'project', project_id: projectId, horizon: 'long' });
    return { shortTerm, longTerm };
  }
}
