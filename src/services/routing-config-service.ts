import { DatabaseService } from '../db/database.js';

/**
 * A3: RoutingConfigService — read/write access to the routing_rules table (data model only).
 * This service is inert data plumbing: OrchestratorLoop does NOT consult it yet (that is batch A4).
 * The 9 core rows (is_core=1) are seeded VERBATIM from OrchestratorLoop's current hardcoded FSM.
 */

export interface RoutingRuleRow {
  id: number;
  emitter_role: string;
  when_status: string;
  handler_role: string;
  action: string;
  is_core: number; // 0 | 1 — 1 = protected core transition (seeded)
  enabled: number; // 0 | 1
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface RoutingResolution {
  handler_role: string;
  action: string;
}

export interface UpsertRoutingRuleInput {
  id?: number;
  emitter_role: string;
  when_status: string;
  handler_role: string;
  action: string;
  is_core?: number;
  enabled?: number;
  note?: string | null;
}

export interface ValidateConfigResult {
  ok: boolean;
  problems: string[];
}

/** A6: thrown by editRule when a caller tries to change handler_role/action of a protected (is_core=1) rule. */
export class RoutingCoreProtectedError extends Error {}

/** A6: thrown when a mutation would leave the config invalid (no-route or conflict) — never persisted. */
export class RoutingValidationError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`routing config validation failed: ${problems.join('; ')}`);
    this.problems = problems;
  }
}

export interface EditRoutingRuleInput {
  handler_role?: string;
  action?: string;
  note?: string | null;
  enabled?: boolean;
}

export interface AddRoutingRuleInput {
  emitter_role: string;
  when_status: string;
  handler_role: string;
  action: string;
  note?: string | null;
}

function rowToRule(r: any): RoutingRuleRow {
  return {
    id: Number(r.id),
    emitter_role: String(r.emitter_role),
    when_status: String(r.when_status),
    handler_role: String(r.handler_role),
    action: String(r.action),
    is_core: Number(r.is_core),
    enabled: Number(r.enabled),
    note: r.note ?? null,
    created_at: String(r.created_at),
    updated_at: String(r.updated_at)
  };
}

export class RoutingConfigService {
  constructor(private readonly db: DatabaseService) {}

  listRules(): RoutingRuleRow[] {
    return (this.db.prepare('SELECT * FROM routing_rules ORDER BY id').all() as any[]).map(rowToRule);
  }

  getById(id: number): RoutingRuleRow | null {
    const row = this.db.prepare('SELECT * FROM routing_rules WHERE id = ?').get(id);
    return row ? rowToRule(row) : null;
  }

  /**
   * Resolve the handler_role + action for an emitter_role/status (or algo-condition) pair.
   * Only considers enabled rows. Returns null on no match — callers (A4+) must treat null as
   * "no route configured", never as an implicit no-op.
   */
  resolve(emitterRole: string, status: string): RoutingResolution | null {
    const row = this.db.prepare(`
      SELECT handler_role, action FROM routing_rules
      WHERE emitter_role = ? AND when_status = ? AND enabled = 1
      ORDER BY id
      LIMIT 1
    `).get(emitterRole, status) as { handler_role: string; action: string } | undefined;
    return row ? { handler_role: row.handler_role, action: row.action } : null;
  }

  /**
   * Config-level sanity check, run against the live table (not just the seed):
   *  1. Every core (is_core=1) condition must still resolve to an enabled route — a disabled/deleted
   *     core row is a problem, not a silent pass.
   *  2. No (emitter_role, when_status) pair may have two enabled rows that disagree on the route
   *     (conflicting handler_role/action).
   */
  validateConfig(): ValidateConfigResult {
    const problems: string[] = [];
    const allRules = this.listRules();

    const coreRules = allRules.filter(r => r.is_core === 1);
    for (const cr of coreRules) {
      const resolved = this.resolve(cr.emitter_role, cr.when_status);
      if (!resolved) {
        problems.push(`no enabled route for core condition: emitter_role='${cr.emitter_role}' when_status='${cr.when_status}'`);
      }
    }

    const groups = new Map<string, RoutingRuleRow[]>();
    for (const r of allRules) {
      const key = `${r.emitter_role}::${r.when_status}`;
      const group = groups.get(key) ?? [];
      group.push(r);
      groups.set(key, group);
    }
    for (const [key, group] of groups) {
      const enabledGroup = group.filter(r => r.enabled === 1);
      if (enabledGroup.length > 1) {
        const distinctRoutes = new Set(enabledGroup.map(r => `${r.handler_role}->${r.action}`));
        if (distinctRoutes.size > 1) {
          problems.push(`conflicting enabled routes for ${key}: ${[...distinctRoutes].join(' vs ')}`);
        }
      }
    }

    return { ok: problems.length === 0, problems };
  }

  /**
   * Thin upsert for the later Studio-edit batch. Update path (id given) only touches the editable
   * route fields (emitter_role/when_status/handler_role/action/note) — is_core/enabled are protected
   * via dedicated paths (is_core is seed-only; enabled goes through setEnabled).
   */
  upsertRule(input: UpsertRoutingRuleInput): RoutingRuleRow {
    if (input.id != null) {
      const existing = this.getById(input.id);
      if (!existing) throw new Error(`unknown routing rule id ${input.id}`);
      this.db.prepare(`
        UPDATE routing_rules
        SET emitter_role = ?, when_status = ?, handler_role = ?, action = ?, note = ?, updated_at = datetime('now')
        WHERE id = ?
      `).run(input.emitter_role, input.when_status, input.handler_role, input.action, input.note ?? null, input.id);
      return this.getById(input.id)!;
    }
    const result = this.db.prepare(`
      INSERT INTO routing_rules (emitter_role, when_status, handler_role, action, is_core, enabled, note)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.emitter_role,
      input.when_status,
      input.handler_role,
      input.action,
      input.is_core ?? 0,
      input.enabled ?? 1,
      input.note ?? null
    );
    return this.getById(Number(result.lastInsertRowid))!;
  }

  setEnabled(id: number, enabled: boolean): RoutingRuleRow {
    const existing = this.getById(id);
    if (!existing) throw new Error(`unknown routing rule id ${id}`);
    this.db.prepare(`UPDATE routing_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?`).run(enabled ? 1 : 0, id);
    return this.getById(id)!;
  }

  /**
   * A6: validate-or-rollback wrapper. Runs `mutate` inside a DB transaction, then re-checks
   * validateConfig() — if the mutation left the config invalid (unrouted core condition or
   * conflicting enabled routes), the transaction is rolled back and RoutingValidationError is
   * thrown instead of persisting the broken config ("no-route = error, not silent-hang").
   */
  private withValidatedTransaction<T>(mutate: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = mutate();
      const validation = this.validateConfig();
      if (!validation.ok) {
        throw new RoutingValidationError(validation.problems);
      }
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* best-effort */ }
      throw e;
    }
  }

  /** A6: add a new custom rule. Always is_core=0 — core rows are seed-only, never created via this path. */
  addRule(input: AddRoutingRuleInput): RoutingRuleRow {
    return this.withValidatedTransaction(() =>
      this.upsertRule({
        emitter_role: input.emitter_role,
        when_status: input.when_status,
        handler_role: input.handler_role,
        action: input.action,
        is_core: 0,
        enabled: 1,
        note: input.note ?? null
      })
    );
  }

  /**
   * A6: edit an existing rule. Core rules (is_core=1) may only have `enabled`/`note` changed —
   * a handler_role/action change on a core row throws RoutingCoreProtectedError before any mutation
   * is attempted. Every edit (including a bare enable/disable) is re-validated: disabling a core
   * rule that would leave its transition unrouted is rolled back via RoutingValidationError.
   */
  editRule(id: number, patch: EditRoutingRuleInput): RoutingRuleRow {
    const existing = this.getById(id);
    if (!existing) throw new Error(`unknown routing rule id ${id}`);

    const changingHandlerOrAction =
      (patch.handler_role !== undefined && patch.handler_role !== existing.handler_role) ||
      (patch.action !== undefined && patch.action !== existing.action);
    if (existing.is_core === 1 && changingHandlerOrAction) {
      throw new RoutingCoreProtectedError(
        `routing rule ${id} is a protected core rule — only enabled/note may be edited, not handler_role/action`
      );
    }

    return this.withValidatedTransaction(() => {
      if (patch.enabled !== undefined) {
        this.setEnabled(id, patch.enabled);
      }
      if (patch.handler_role !== undefined || patch.action !== undefined || patch.note !== undefined) {
        const cur = this.getById(id)!;
        this.upsertRule({
          id,
          emitter_role: cur.emitter_role,
          when_status: cur.when_status,
          handler_role: patch.handler_role ?? cur.handler_role,
          action: patch.action ?? cur.action,
          note: patch.note !== undefined ? patch.note : cur.note
        });
      }
      return this.getById(id)!;
    });
  }
}
