import { DatabaseService } from '../db/database.js';
import { slugifyModelName } from '../db/schema.js';

export type Provider = 'claude' | 'codex' | 'grok' | 'kloo';

export type ValidationStatus = 'untested' | 'valid' | 'invalid';

export interface Model {
  id: number;
  name: string;
  provider: Provider;
  model_id: string;
  /** Launch CLI binary/family (claude|codex|grok|kloo). Required on create (B03b / R1.2). */
  cli: string;
  /** Helm-canonical unique id for topology/briefs (B03a/B03b / R1.3). */
  slug: string;
  /** UI label; dropdown shows this (B03a/B03b / R1.3). */
  display_name: string;
  effort: string;
  approval: string;
  flags: string | null;
  approval_policy: string | null;
  sandbox_mode: string | null;
  permission_mode: string | null;
  bypass: number;
  route: string | null;
  validation_status: ValidationStatus;
  validated_at: string | null;
  validation_detail: string | null;
  created_at: string;
  updated_at: string;
}

function requireText(v: string | undefined | null, name: string): string {
  if (!v || typeof v !== 'string' || !v.trim()) throw new Error(`${name} is required`);
  return v.trim();
}

function requireProvider(p: string): Provider {
  if (!['claude', 'codex', 'grok', 'kloo'].includes(p)) throw new Error(`invalid provider: ${p}`);
  return p as Provider;
}

function rowToModel(row: any): Model {
  return {
    id: Number(row.id),
    name: String(row.name),
    provider: row.provider,
    model_id: String(row.model_id),
    cli: String(row.cli ?? ''),
    slug: String(row.slug ?? ''),
    display_name: String(row.display_name ?? row.name ?? ''),
    effort: String(row.effort),
    approval: String(row.approval),
    flags: row.flags ?? null,
    approval_policy: row.approval_policy ?? null,
    sandbox_mode: row.sandbox_mode ?? null,
    permission_mode: row.permission_mode ?? null,
    bypass: Number(row.bypass ?? 0),
    route: row.route ?? null,
    validation_status: (row.validation_status ?? 'untested') as ValidationStatus,
    validated_at: row.validated_at ?? null,
    validation_detail: row.validation_detail ?? null,
    created_at: String(row.created_at),
    updated_at: String(row.updated_at)
  };
}

export type ModelListFilter = {
  /** When set, only models with this cli (trim-equal). */
  cli?: string;
  /** When set, only models with this provider (trim-equal). */
  provider?: string;
};

export class ModelService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * List models, optionally filtered for cascade UI (B05 / R1.1):
   * CLI constrains providers; CLI+provider constrains models.
   */
  listModels(filter?: ModelListFilter): Model[] {
    const clauses: string[] = [];
    const vals: any[] = [];
    if (filter?.cli !== undefined && String(filter.cli).trim()) {
      clauses.push('cli = ?');
      vals.push(String(filter.cli).trim());
    }
    if (filter?.provider !== undefined && String(filter.provider).trim()) {
      clauses.push('provider = ?');
      vals.push(String(filter.provider).trim());
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(`SELECT * FROM models ${where} ORDER BY name`).all(...vals) as any[];
    return rows.map(rowToModel);
  }

  /** Distinct CLIs present in the registry (sorted). B05 cascade step 1. */
  listClis(): string[] {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT cli FROM models
         WHERE cli IS NOT NULL AND TRIM(cli) != ''
         ORDER BY cli`
      )
      .all() as Array<{ cli: string }>;
    return rows.map((r) => String(r.cli));
  }

  /**
   * Distinct providers, optionally constrained by CLI (B05 cascade step 2).
   * When cli is omitted/empty, returns all providers in the registry.
   */
  listProviders(cli?: string | null): string[] {
    const trimmed = cli != null && String(cli).trim() ? String(cli).trim() : null;
    if (trimmed) {
      const rows = this.db
        .prepare(
          `SELECT DISTINCT provider FROM models
           WHERE cli = ? AND provider IS NOT NULL AND TRIM(provider) != ''
           ORDER BY provider`
        )
        .all(trimmed) as Array<{ provider: string }>;
      return rows.map((r) => String(r.provider));
    }
    const rows = this.db
      .prepare(
        `SELECT DISTINCT provider FROM models
         WHERE provider IS NOT NULL AND TRIM(provider) != ''
         ORDER BY provider`
      )
      .all() as Array<{ provider: string }>;
    return rows.map((r) => String(r.provider));
  }

  getModel(id: number): Model | null {
    const row = this.db.prepare('SELECT * FROM models WHERE id = ?').get(id) as any;
    return row ? rowToModel(row) : null;
  }

  findByModelId(modelId: string): Model | null {
    const row = this.db.prepare('SELECT * FROM models WHERE model_id = ? LIMIT 1').get(modelId) as any;
    return row ? rowToModel(row) : null;
  }

  /** Allocate a UNIQUE slug: base from name (or override), append -2/-3… on collision. */
  private allocateSlug(baseName: string, preferred?: string | null, excludeId?: number): string {
    const base = preferred && preferred.trim()
      ? slugifyModelName(preferred.trim())
      : slugifyModelName(baseName);
    let candidate = base;
    let n = 2;
    for (;;) {
      const row = excludeId != null
        ? this.db.prepare('SELECT id FROM models WHERE slug = ? AND id != ?').get(candidate, excludeId)
        : this.db.prepare('SELECT id FROM models WHERE slug = ?').get(candidate);
      if (!row) return candidate;
      candidate = `${base}-${n}`;
      n += 1;
      if (n > 10_000) throw new Error(`unable to allocate unique slug from: ${base}`);
    }
  }

  createModel(input: {
    name: string;
    provider: string;
    model_id: string;
    /** Required (B03b / R1.2). Empty/missing → throw (routes map to 400). */
    cli: string;
    slug?: string | null;
    display_name?: string | null;
    effort?: string;
    approval?: string;
    flags?: string | null;
    approval_policy?: string | null;
    sandbox_mode?: string | null;
    permission_mode?: string | null;
    bypass?: number;
    route?: string | null;
  }): Model {
    const name = requireText(input.name, 'name');
    const provider = requireProvider(input.provider);
    const model_id = requireText(input.model_id, 'model_id');
    // B03b R1.2: CLI is required at service layer — never invent/default.
    const cli = requireText(input.cli, 'cli');
    const display_name = (input.display_name && String(input.display_name).trim())
      ? String(input.display_name).trim()
      : name;
    const slug = this.allocateSlug(name, input.slug ?? null);
    const effort = (input.effort || 'medium').trim() || 'medium';
    const approval = (input.approval || 'auto').trim() || 'auto';
    const flags = input.flags ?? null;
    const apol = input.approval_policy ?? null;
    const sm = input.sandbox_mode ?? null;
    const pm = input.permission_mode ?? null;
    const by = input.bypass ?? 0;
    const route = input.route ?? null;
    try {
      const row = this.db.prepare(
        `INSERT INTO models (name, provider, model_id, cli, slug, display_name, effort, approval, flags, approval_policy, sandbox_mode, permission_mode, bypass, route)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING *`
      ).get(name, provider, model_id, cli, slug, display_name, effort, approval, flags, apol, sm, pm, by, route) as any;
      return rowToModel(row);
    } catch (e: any) {
      const msg = String(e.message || e);
      if (msg.includes('UNIQUE') || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        if (msg.includes('slug') || msg.includes('idx_models_slug')) {
          throw new Error(`model slug must be unique: ${slug}`);
        }
        throw new Error(`model name must be unique: ${name}`);
      }
      throw e;
    }
  }

  updateModel(id: number, input: {
    name?: string;
    provider?: string;
    model_id?: string;
    cli?: string;
    slug?: string | null;
    display_name?: string | null;
    effort?: string;
    approval?: string;
    flags?: string | null;
    approval_policy?: string | null;
    sandbox_mode?: string | null;
    permission_mode?: string | null;
    bypass?: number;
    route?: string | null;
  }): Model {
    const existing = this.getModel(id);
    if (!existing) throw new Error('unknown model');
    const sets: string[] = [];
    const vals: any[] = [];
    if (input.name !== undefined) {
      const name = requireText(input.name, 'name');
      const dup = this.db.prepare('SELECT id FROM models WHERE name = ? AND id != ?').get(name, id);
      if (dup) throw new Error(`model name must be unique: ${name}`);
      sets.push('name=?');
      vals.push(name);
    }
    if (input.provider !== undefined) {
      const provider = requireProvider(input.provider);
      sets.push('provider=?');
      vals.push(provider);
    }
    if (input.model_id !== undefined) {
      const model_id = requireText(input.model_id, 'model_id');
      sets.push('model_id=?');
      vals.push(model_id);
    }
    // B03b: cli required when present on update (empty string rejected).
    if (input.cli !== undefined) {
      const cli = requireText(input.cli, 'cli');
      sets.push('cli=?');
      vals.push(cli);
    }
    if (input.display_name !== undefined) {
      const display_name = requireText(input.display_name, 'display_name');
      sets.push('display_name=?');
      vals.push(display_name);
    }
    if (input.slug !== undefined) {
      const slug = this.allocateSlug(
        (input.name !== undefined ? requireText(input.name, 'name') : existing.name),
        input.slug,
        id
      );
      sets.push('slug=?');
      vals.push(slug);
    }
    if (input.effort !== undefined) {
      const effort = (input.effort || 'medium').trim() || 'medium';
      sets.push('effort=?');
      vals.push(effort);
    }
    if (input.approval !== undefined) {
      const approval = (input.approval || 'auto').trim() || 'auto';
      sets.push('approval=?');
      vals.push(approval);
    }
    if ('flags' in input) {
      sets.push('flags=?');
      vals.push(input.flags ?? null);
    }
    if (input.approval_policy !== undefined) {
      sets.push('approval_policy=?');
      vals.push(input.approval_policy ?? null);
    }
    if (input.sandbox_mode !== undefined) {
      sets.push('sandbox_mode=?');
      vals.push(input.sandbox_mode ?? null);
    }
    if (input.permission_mode !== undefined) {
      sets.push('permission_mode=?');
      vals.push(input.permission_mode ?? null);
    }
    if (input.bypass !== undefined) {
      sets.push('bypass=?');
      vals.push(input.bypass ?? 0);
    }
    if ('route' in input) {
      sets.push('route=?');
      vals.push(input.route ?? null);
    }
    if (sets.length === 0) return existing;
    sets.push("updated_at=datetime('now')");
    try {
      this.db.prepare(`UPDATE models SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    } catch (e: any) {
      const msg = String(e.message || e);
      if (msg.includes('UNIQUE') || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
        if (msg.includes('slug') || msg.includes('idx_models_slug')) {
          throw new Error(`model slug must be unique`);
        }
        throw new Error(`model name must be unique`);
      }
      throw e;
    }
    const updated = this.getModel(id);
    if (!updated) throw new Error('model not found after update');
    return updated;
  }

  deleteModel(id: number): void {
    // B3/B9a MDL5: extended ref-guard (agents default/backup + agent/project escalation ladders + project model/backup overrides + project_master_models).
    // Throw → 409-mappable. Preserves data-safety on live (additive).
    const refAgents = this.db.prepare('SELECT COUNT(*) as c FROM agents WHERE default_model_id = ? OR backup_model_id = ?').get(id, id) as { c: number };
    const refEsc = this.db.prepare('SELECT COUNT(*) as c FROM agent_escalations WHERE model_id = ?').get(id) as { c: number };
    const refProjAgents = this.db.prepare('SELECT COUNT(*) as c FROM project_agents WHERE model_id = ? OR backup_model_id = ?').get(id, id) as { c: number };
    const refProjEsc = this.db.prepare('SELECT COUNT(*) as c FROM project_agent_escalations WHERE model_id = ?').get(id) as { c: number };
    const refMaster = this.db.prepare('SELECT COUNT(*) as c FROM project_master_models WHERE model = (SELECT model_id FROM models WHERE id = ?)').get(id) as { c: number };
    const refTeamMembers = this.db.prepare('SELECT COUNT(*) as c FROM team_members WHERE model_id = ?').get(id) as { c: number };
    if (refAgents.c > 0 || refEsc.c > 0 || refProjAgents.c > 0 || refProjEsc.c > 0 || refMaster.c > 0 || refTeamMembers.c > 0) {
      const refs: string[] = [];
      if (refAgents.c > 0) refs.push('agents');
      if (refEsc.c > 0) refs.push('agent_escalations');
      if (refProjAgents.c > 0) refs.push('project_agents');
      if (refProjEsc.c > 0) refs.push('project_agent_escalations');
      if (refMaster.c > 0) refs.push('project_master_models');
      if (refTeamMembers.c > 0) refs.push('team_members');
      throw new Error(`model in use by ${refs.join('+')}`);
    }
    this.db.prepare('DELETE FROM models WHERE id = ?').run(id);
  }

  /**
   * B3 MDL4: per-provider refresh.
   * - grok: shells `grok models` (live) + reconcile (best-effort; escape valve if headless/CLI infeasible).
   * - codex/claude: re-apply maintained list (structured seeds).
   * Non-fatal; schema apply + providers registry are the source for initial + validation.
   */
  refreshProviderModels(provider: Provider): void {
    if (provider === 'grok') {
      try {
        const { execSync } = require('node:child_process');
        // live enumeration; ignore output for B3 (escape valve), ensure core maintained via upsert below
        execSync('grok models', { encoding: 'utf8', timeout: 6000, stdio: ['ignore', 'pipe', 'ignore'] });
      } catch {
        // infeasible (no bin, timeout, headless) — fall back to maintained (ensured below)
      }
    }
    // Ensure maintained for the provider (structured + flags rendered). Full list seeded at init; this keeps runtime refresh additive.
    // B03b: INSERT must include cli/slug/display_name (NOT NULL since v61).
    const ensure = (name: string, model_id: string, effort: string, approval: string, flags: string | null, apol: string | null, sm: string | null, pm: string | null, by: number) => {
      try {
        const cli = provider; // pre-B04: cli mirrors provider
        const slug = this.allocateSlug(name);
        const display_name = name;
        this.db.prepare(
          `INSERT OR IGNORE INTO models (name, provider, model_id, cli, slug, display_name, effort, approval, flags, approval_policy, sandbox_mode, permission_mode, bypass) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(name, provider, model_id, cli, slug, display_name, effort, approval, flags, apol, sm, pm, by);
        this.db.prepare(
          `UPDATE models SET approval_policy=?, sandbox_mode=?, permission_mode=?, bypass=?, flags=?, updated_at=datetime('now') WHERE name=? AND provider=?`
        ).run(apol, sm, pm, by, flags, name, provider);
      } catch {}
    };
    if (provider === 'grok') {
      ensure('grok-4.5', 'grok-4.5', 'medium', 'always-approve', '--always-approve', 'always-approve', null, null, 1);
      ensure('grok-composer-2.5-fast', 'grok-composer-2.5-fast', 'low', 'auto', null, 'auto', null, null, 0);
    } else if (provider === 'codex') {
      ensure('codex-5.5', 'gpt-5.5', 'medium', 'bypass-sandbox', '--dangerously-bypass-approvals-and-sandbox', 'bypass', null, null, 1);
      ensure('spark', 'gpt-5.3-codex-spark', 'dynamic', 'bypass', '--dangerously-bypass-approvals-and-sandbox', 'bypass', null, null, 1);
    } else if (provider === 'claude') {
      ensure('claude-opus', 'claude-opus-5', 'high', 'bypassPermissions', '--permission-mode bypassPermissions --dangerously-skip-permissions', 'bypassPermissions', null, 'bypassPermissions', 1);
      ensure('claude-sonnet', 'claude-sonnet-4-6', 'dynamic', 'auto', null, 'auto', null, null, 0);
    }
  }
}
