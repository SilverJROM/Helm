/**
 * S08 — Durable Discovery→Planning handoff / CAS repository.
 *
 * Stores hashed one-use credentials only (never raw). One live handoff per cycle
 * (pending|starting). Compare-and-swap state transitions.
 */
import { createHash, timingSafeEqual, randomBytes } from 'node:crypto';
import type { DatabaseService } from '../db/database.js';

export type HandoffState =
  | 'pending'
  | 'declined'
  | 'starting'
  | 'started'
  | 'quarantined'
  | 'failed';

export const LIVE_HANDOFF_STATES: readonly HandoffState[] = ['pending', 'starting'] as const;

export interface DiscoveryHandoffRow {
  id: number;
  project_id: number;
  cycle_id: number;
  chat_session_id: string | null;
  agent_id: number | null;
  credential_hash: string;
  credential_consumed_at: string | null;
  callback_role: string | null;
  callback_status: string | null;
  state: HandoffState;
  manifest_json: string | null;
  manifest_digest: string | null;
  planning_run_id: number | null;
  reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface CreatePendingInput {
  projectId: number;
  cycleId: number;
  chatSessionId?: string | null;
  agentId?: number | null;
  /** Raw one-use credential — hashed before insert; never stored. */
  rawCredential: string;
  callbackRole?: string | null;
  callbackStatus?: string | null;
  manifestJson?: string | null;
  manifestDigest?: string | null;
}

export function hashHandoffCredential(raw: string): string {
  return createHash('sha256').update(String(raw), 'utf8').digest('hex');
}

/** Issue a high-entropy raw credential for S09 to inject into the sidecar. */
export function mintHandoffCredential(): string {
  return randomBytes(32).toString('base64url');
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

export class DiscoveryHandoffConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscoveryHandoffConflictError';
  }
}

export class DiscoveryHandoffService {
  constructor(private readonly db: DatabaseService) {}

  getById(id: number): DiscoveryHandoffRow | null {
    const row = this.db
      .prepare('SELECT * FROM discovery_handoffs WHERE id = ?')
      .get(id) as DiscoveryHandoffRow | undefined;
    return row ?? null;
  }

  getLive(cycleId: number): DiscoveryHandoffRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM discovery_handoffs
         WHERE cycle_id = ? AND state IN ('pending', 'starting')
         ORDER BY id DESC LIMIT 1`
      )
      .get(cycleId) as DiscoveryHandoffRow | undefined;
    return row ?? null;
  }

  listByCycle(cycleId: number): DiscoveryHandoffRow[] {
    return this.db
      .prepare('SELECT * FROM discovery_handoffs WHERE cycle_id = ? ORDER BY id ASC')
      .all(cycleId) as DiscoveryHandoffRow[];
  }

  /**
   * Create a pending handoff. Fails if a live (pending|starting) row already exists for the cycle.
   * Returns the inserted row (credential_hash only — no raw token field exists).
   */
  createPending(input: CreatePendingInput): DiscoveryHandoffRow {
    const raw = String(input.rawCredential || '');
    if (!raw) throw new Error('rawCredential is required');
    const credential_hash = hashHandoffCredential(raw);

    if (this.getLive(input.cycleId)) {
      throw new DiscoveryHandoffConflictError(
        `live discovery handoff already exists for cycle ${input.cycleId}`
      );
    }

    try {
      const info = this.db
        .prepare(
          `INSERT INTO discovery_handoffs (
             project_id, cycle_id, chat_session_id, agent_id,
             credential_hash, callback_role, callback_status, state,
             manifest_json, manifest_digest
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`
        )
        .run(
          input.projectId,
          input.cycleId,
          input.chatSessionId ?? null,
          input.agentId ?? null,
          credential_hash,
          input.callbackRole ?? null,
          input.callbackStatus ?? null,
          input.manifestJson ?? null,
          input.manifestDigest ?? null
        );
      const row = this.getById(Number(info.lastInsertRowid));
      if (!row) throw new Error('failed to load inserted handoff');
      return row;
    } catch (e: any) {
      if (String(e?.message || e).includes('UNIQUE') || String(e?.code) === 'SQLITE_CONSTRAINT_UNIQUE') {
        throw new DiscoveryHandoffConflictError(
          `live discovery handoff already exists for cycle ${input.cycleId}`
        );
      }
      throw e;
    }
  }

  /**
   * Compare-and-swap state transition. Returns number of rows changed (0 = CAS lose).
   */
  casTransition(
    id: number,
    fromState: HandoffState,
    toState: HandoffState,
    patch?: {
      planningRunId?: number | null;
      reason?: string | null;
      manifestJson?: string | null;
      manifestDigest?: string | null;
    }
  ): number {
    const sets = [
      'state = ?',
      "updated_at = datetime('now')",
    ];
    const args: any[] = [toState];
    if (patch && 'planningRunId' in patch) {
      sets.push('planning_run_id = ?');
      args.push(patch.planningRunId ?? null);
    }
    if (patch && 'reason' in patch) {
      sets.push('reason = ?');
      args.push(patch.reason ?? null);
    }
    if (patch && 'manifestJson' in patch) {
      sets.push('manifest_json = ?');
      args.push(patch.manifestJson ?? null);
    }
    if (patch && 'manifestDigest' in patch) {
      sets.push('manifest_digest = ?');
      args.push(patch.manifestDigest ?? null);
    }
    args.push(id, fromState);
    const info = this.db
      .prepare(
        `UPDATE discovery_handoffs SET ${sets.join(', ')} WHERE id = ? AND state = ?`
      )
      .run(...args);
    return Number(info.changes || 0);
  }

  /**
   * One-use credential consume: hash-compare then mark consumed once.
   * Returns true if accepted and newly consumed (or already consumed for same hash path after mark).
   */
  consumeCredential(id: number, rawCredential: string): boolean {
    const row = this.getById(id);
    if (!row) return false;
    if (row.credential_consumed_at) return false;
    const hash = hashHandoffCredential(rawCredential);
    if (!safeEqualHex(hash, row.credential_hash)) return false;
    const info = this.db
      .prepare(
        `UPDATE discovery_handoffs
         SET credential_consumed_at = datetime('now'), updated_at = datetime('now')
         WHERE id = ? AND credential_consumed_at IS NULL`
      )
      .run(id);
    return Number(info.changes || 0) === 1;
  }

  decline(id: number, reason: string): number {
    return this.casTransition(id, 'pending', 'declined', {
      reason,
      planningRunId: null,
    });
  }

  quarantine(opts: {
    projectId: number;
    cycleId: number;
    chatSessionId?: string | null;
    agentId?: number | null;
    callbackRole?: string | null;
    callbackStatus?: string | null;
    reason: string;
    /** Optional hash of a rejected token (never raw). */
    credentialHash?: string | null;
  }): DiscoveryHandoffRow {
    // Quarantine is audit-only: does not create a live pending. Use a disposable hash placeholder
    // when no token was presented so NOT NULL is satisfied.
    const credential_hash =
      opts.credentialHash ||
      hashHandoffCredential(`quarantine:${opts.cycleId}:${Date.now()}:${randomBytes(8).toString('hex')}`);
    const info = this.db
      .prepare(
        `INSERT INTO discovery_handoffs (
           project_id, cycle_id, chat_session_id, agent_id,
           credential_hash, callback_role, callback_status, state,
           planning_run_id, reason
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'quarantined', NULL, ?)`
      )
      .run(
        opts.projectId,
        opts.cycleId,
        opts.chatSessionId ?? null,
        opts.agentId ?? null,
        credential_hash,
        opts.callbackRole ?? null,
        opts.callbackStatus ?? null,
        opts.reason
      );
    const row = this.getById(Number(info.lastInsertRowid));
    if (!row) throw new Error('failed to load quarantined handoff');
    return row;
  }

  fail(id: number, reason: string, fromState: HandoffState = 'starting'): number {
    return this.casTransition(id, fromState, 'failed', { reason, planningRunId: null });
  }
}
