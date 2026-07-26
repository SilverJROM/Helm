import { DatabaseService } from '../db/database.js';
import { loadConfig } from '../config/config.js';

function requireText(v: string | undefined, name: string): string {
  if (!v || typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}

export interface Toolkit {
  id: number;
  name: string;
  description: string | null;
  body_md: string;
  created_at: string;
  updated_at: string;
}

export class ToolkitService {
  constructor(private readonly db: DatabaseService) {}

  private get bodyMax(): number {
    return (loadConfig() as any).TOOLKIT_BODY_MAX || 50000;
  }
  private get composeMax(): number {
    return (loadConfig() as any).TOOLKIT_COMPOSE_MAX || 200000;
  }

  // toolkit = prompt fragment, not a callable tool. LEAN sidecar for JIT manifest attachment only (H2).
  listToolkits(): Toolkit[] {
    return this.db.prepare('SELECT * FROM toolkits ORDER BY name').all() as Toolkit[];
  }

  getToolkit(id: number): Toolkit | null {
    const row = this.db.prepare('SELECT * FROM toolkits WHERE id = ?').get(id) as any;
    return row ? this.rowToToolkit(row) : null;
  }

  createToolkit(input: { name: string; description?: string | null; body_md: string }): Toolkit {
    const name = requireText(input.name, 'name');
    const description = input.description ?? null;
    const body_md = input.body_md || '';
    if (body_md.length > this.bodyMax) {
      throw new Error(`body_md too long (max ${this.bodyMax})`);
    }
    try {
      const row = this.db.prepare(
        `INSERT INTO toolkits (name, description, body_md) VALUES (?,?,?) RETURNING *`
      ).get(name, description, body_md) as any;
      return this.rowToToolkit(row);
    } catch (e: any) {
      if (String(e.message || e).includes('UNIQUE') || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new Error(`toolkit name must be unique: ${name}`);
      }
      throw e;
    }
  }

  updateToolkit(id: number, input: { name?: string; description?: string | null; body_md?: string }): Toolkit {
    const existing = this.getToolkit(id);
    if (!existing) throw new Error('unknown toolkit');
    const sets: string[] = [];
    const vals: any[] = [];
    if (input.name !== undefined) {
      const name = requireText(input.name, 'name');
      const dup = this.db.prepare('SELECT id FROM toolkits WHERE name = ? AND id != ?').get(name, id);
      if (dup) throw new Error(`toolkit name must be unique: ${name}`);
      sets.push('name=?');
      vals.push(name);
    }
    if ('description' in input) {
      sets.push('description=?');
      vals.push(input.description ?? null);
    }
    if (input.body_md !== undefined) {
      const body = input.body_md || '';
      if (body.length > this.bodyMax) {
        throw new Error(`body_md too long (max ${this.bodyMax})`);
      }
      sets.push('body_md=?');
      vals.push(body);
    }
    if (sets.length === 0) return existing;
    sets.push("updated_at=datetime('now')");
    this.db.prepare(`UPDATE toolkits SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    const updated = this.getToolkit(id);
    if (!updated) throw new Error('toolkit not found after update');
    return updated;
  }

  deleteToolkit(id: number): void {
    const attached = this.db.prepare(`
      SELECT a.id, a.name FROM agent_toolkits at 
      JOIN agents a ON a.id = at.agent_id 
      WHERE at.toolkit_id = ?
    `).all(id) as any[];
    if (attached.length > 0) {
      const names = attached.map((r: any) => r.name).join(', ');
      throw new Error(`toolkit is attached to agents: ${names}`);
    }
    this.db.prepare('DELETE FROM toolkits WHERE id = ?').run(id);
  }

  attachToolkit(agentId: number, toolkitId: number, position?: number): void {
    let pos = position;
    if (pos == null) {
      const maxr = this.db.prepare('SELECT MAX(position) as m FROM agent_toolkits WHERE agent_id = ?').get(agentId) as any;
      pos = (maxr && typeof maxr.m === 'number' ? maxr.m : -1) + 1;
    }
    this.db.prepare(
      `INSERT INTO agent_toolkits (agent_id, toolkit_id, position) VALUES (?,?,?)`
    ).run(agentId, toolkitId, pos);
  }

  detachToolkit(agentId: number, toolkitId: number): void {
    this.db.prepare(
      `DELETE FROM agent_toolkits WHERE agent_id = ? AND toolkit_id = ?`
    ).run(agentId, toolkitId);
  }

  listAgentToolkits(agentId: number): Toolkit[] {
    const rows = this.db.prepare(`
      SELECT t.* FROM agent_toolkits at 
      JOIN toolkits t ON t.id = at.toolkit_id 
      WHERE at.agent_id = ? 
      ORDER BY at.position ASC, t.name ASC
    `).all(agentId) as any[];
    return rows.map((r) => this.rowToToolkit(r));
  }

  composeToolkitBodies(rows: Array<{ name: string; body_md: string }>): string {
    if (!rows.length) return '';
    let out = '';
    for (const r of rows) {
      out += `--- toolkit: ${r.name} ---\n${r.body_md}\n`;
    }
    if (out.length > this.composeMax) {
      throw new Error(`toolkit aggregate size exceeds limit (${this.composeMax})`);
    }
    return out.trim();
  }

  composeToolkits(agentId: number | null | undefined): string {
    if (!agentId) return '';
    const rows = this.db.prepare(`
      SELECT t.name, t.body_md FROM agent_toolkits at 
      JOIN toolkits t ON t.id = at.toolkit_id 
      WHERE at.agent_id = ? 
      ORDER BY at.position ASC, t.name ASC
    `).all(agentId) as { name: string; body_md: string }[];
    return this.composeToolkitBodies(rows);
  }

  private rowToToolkit(row: any): Toolkit {
    return {
      id: Number(row.id),
      name: String(row.name),
      description: row.description ?? null,
      body_md: String(row.body_md),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at)
    };
  }
}
