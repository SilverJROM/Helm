/**
 * A15 / R4.16–R4.17 — shared finalize writer for worker_runtimes.
 * Single choke for transitioning seats to a terminal state with non-NULL ended_at.
 * Idempotent: no-op when already done|failed|reaped.
 *
 * S02 + B02 AC6: on first successful terminal transition, assert helm_sessions idle via
 * injected CAS markIdle (SessionRegistryService.markIdle) so the janitor later sees ownership
 * truth. Capture is one-shot at the finalize boundary (id/name/owner/status/generation);
 * stale token must not be refreshed and retried.
 */

import {
  sessionStatusTokenFromRow,
  type SessionStatusToken,
} from './lifecycle-cas.js';

export type WorkerTerminalState = 'done' | 'failed' | 'reaped';

/** better-sqlite3-like prepare interface (raw Database or DatabaseService.raw). */
export type FinalizeDb = {
  prepare: (sql: string) => {
    run: (...args: any[]) => { changes?: number };
    all: (...args: any[]) => any[];
    get: (...args: any[]) => any;
  };
  /** Optional better-sqlite3 transaction for SD1 co-commit of runtime + registry. */
  transaction?: <T>(fn: () => T) => () => T;
};

/** Injected registry-idle assertion — B02: full CAS token, not name-only. */
export type FinalizeMarkIdle = (token: SessionStatusToken, reason?: string) => void;

let markIdleHook: FinalizeMarkIdle | null = null;

/**
 * Wire production/test markIdle into the shared finalizer.
 * Pass `{ markIdle: null }` (or omit) to clear — used by tests for isolation.
 */
export function configureWorkerRuntimeFinalize(opts: { markIdle?: FinalizeMarkIdle | null } = {}): void {
  markIdleHook = opts.markIdle ?? null;
}

/** Test/introspection helper. */
export function getWorkerRuntimeFinalizeMarkIdle(): FinalizeMarkIdle | null {
  return markIdleHook;
}

function assertRegistryIdle(db: FinalizeDb, id: number, reason: string): void {
  if (!markIdleHook) return;
  try {
    // Capture session token at the finalize decision boundary (one shot — no refresh/retry).
    const row = db
      .prepare(
        `SELECT s.id AS id, s.name AS name, s.owner AS owner, s.status AS status, s.generation AS generation
         FROM worker_runtimes wr
         JOIN helm_sessions s ON s.name = wr.session
         WHERE wr.id = ?`
      )
      .get(id) as
      | { id: number; name: string; owner: string | null; status: string; generation: number }
      | undefined;
    if (!row?.name) return;
    const token = sessionStatusTokenFromRow(row);
    markIdleHook(token, reason);
  } catch {
    /* best-effort: never fail the worker_runtimes terminal write */
  }
}

/**
 * Finalize one worker_runtimes row. Returns true if the row was transitioned.
 * On first successful transition, propagates markIdle(session, reason) when configured.
 */
export function finalizeWorkerRuntimeRow(
  db: FinalizeDb,
  id: number,
  state: WorkerTerminalState,
  reason: string
): boolean {
  if (id == null || !Number.isFinite(Number(id))) return false;
  const exitReason = reason || 'finalized';

  const apply = (): boolean => {
    const r = db
      .prepare(
        `UPDATE worker_runtimes SET state=?, exit_reason=?, ended_at=datetime('now')
         WHERE id=? AND state NOT IN ('done','failed','reaped')`
      )
      .run(state, exitReason, id);
    const changed = Number(r?.changes || 0) === 1;
    if (changed) {
      assertRegistryIdle(db, id, exitReason);
    }
    return changed;
  };

  try {
    if (typeof db.transaction === 'function') {
      return db.transaction(apply)();
    }
    return apply();
  } catch {
    return false;
  }
}

/**
 * Finalize every non-terminal worker_runtimes row for a run.
 * Optionally reaps the tmux session first (best-effort). Returns count of rows transitioned.
 *
 * @param expectedGeneration B04 / AC8: when supplied, the pre-reap SELECT additionally requires
 *   `runs.generation` (for `run_id`) to still equal this captured value — a stale caller holding a
 *   recycled/deleted-and-reused `runId` selects zero rows instead of reaping the new occupant's live
 *   workers. Omitted preserves the pre-B04 unguarded selection for callers with no captured token.
 */
export async function finalizeRunWorkerRuntimes(
  db: FinalizeDb,
  runId: number,
  reason: string,
  reapSession?: (session: string) => void | Promise<void>,
  expectedGeneration?: number
): Promise<number> {
  if (runId == null || !Number.isFinite(Number(runId))) return 0;
  const gated = expectedGeneration != null && Number.isFinite(Number(expectedGeneration));
  let rows: any[] = [];
  try {
    rows = gated
      ? (db
          .prepare(
            `SELECT id, session FROM worker_runtimes
             WHERE run_id = ? AND state NOT IN ('done','failed','reaped')
               AND EXISTS (
                 SELECT 1 FROM runs r WHERE r.id = worker_runtimes.run_id AND r.generation = ?
               )`
          )
          .all(runId, expectedGeneration) as any[])
      : (db
          .prepare(
            `SELECT id, session FROM worker_runtimes
             WHERE run_id = ? AND state NOT IN ('done','failed','reaped')`
          )
          .all(runId) as any[]);
  } catch {
    return 0;
  }
  let n = 0;
  for (const r of rows) {
    if (r.session && reapSession) {
      try {
        await reapSession(String(r.session));
      } catch {
        /* best-effort */
      }
    }
    if (finalizeWorkerRuntimeRow(db, Number(r.id), 'reaped', reason)) n += 1;
  }
  return n;
}

/**
 * S03 — assert completion for a named brain session that may not already have a
 * worker_runtimes row (ibrain/master path). Register-if-needed, then finalize via the
 * shared chokepoint so S02 markIdle propagates.
 *
 * Does NOT reap/terminate tmux — preserves D-a3 keep-alive / close-confirm.
 * Call only at true run/phase terminals, never intermediate yields.
 */
export function finalizeBrainSessionRow(
  db: FinalizeDb,
  opts: {
    projectId: number;
    runId: number;
    session: string;
    reason: string;
    role?: string;
    state?: WorkerTerminalState;
    provider?: string;
    model?: string;
    /**
     * B04 / AC8: captured runs.generation for `runId`. When supplied, a mismatch (row deleted or
     * recycled by a new occupant since capture) makes this whole call a no-op before any
     * worker_runtimes row is read or written — the brain/session-finalization leg of the detached
     * failure CAS chain.
     */
    expectedGeneration?: number;
  }
): boolean {
  const session = String(opts.session ?? '').trim();
  if (!session) return false;
  if (opts.projectId == null || !Number.isFinite(Number(opts.projectId))) return false;
  if (opts.runId == null || !Number.isFinite(Number(opts.runId))) return false;

  if (opts.expectedGeneration != null && Number.isFinite(Number(opts.expectedGeneration))) {
    try {
      const runRow = db.prepare('SELECT generation FROM runs WHERE id = ?').get(opts.runId) as
        | { generation: number }
        | undefined;
      if (!runRow || Number(runRow.generation) !== Number(opts.expectedGeneration)) {
        return false;
      }
    } catch {
      return false;
    }
  }

  const role = (opts.role && String(opts.role).trim()) || 'ibrain';
  const state: WorkerTerminalState = opts.state ?? 'done';
  const reason = opts.reason || 'brain-phase-complete';
  const provider = opts.provider || 'unknown';
  const model = opts.model || 'unknown';

  try {
    // Prefer an existing non-terminal ledger row for this run+session.
    const existing = db
      .prepare(
        `SELECT id FROM worker_runtimes
         WHERE run_id = ? AND session = ? AND state NOT IN ('done','failed','reaped')
         ORDER BY id DESC LIMIT 1`
      )
      .get(opts.runId, session) as { id?: number } | undefined;

    let id = existing?.id != null ? Number(existing.id) : null;

    // Already terminal for this run+session → idempotent no-op (do not insert a second ledger row).
    if (id == null || !Number.isFinite(id)) {
      const prior = db
        .prepare(
          `SELECT id FROM worker_runtimes
           WHERE run_id = ? AND session = ? AND state IN ('done','failed','reaped')
           ORDER BY id DESC LIMIT 1`
        )
        .get(opts.runId, session) as { id?: number } | undefined;
      if (prior?.id != null) return false;
    }

    // Register-if-needed only when no ledger row exists for this run+session.
    if (id == null || !Number.isFinite(id)) {
      const info = db
        .prepare(
          `INSERT INTO worker_runtimes
             (project_id, role, provider, model, session, correlation_id, state, spawned_by, run_id, started_at)
           VALUES (?,?,?,?,?,?,'running','brain-phase-end',?, datetime('now'))`
        )
        .run(
          opts.projectId,
          role,
          provider,
          model,
          session,
          `brain:${role}:${opts.runId}`,
          opts.runId
        );
      id = Number((info as { lastInsertRowid?: number | bigint }).lastInsertRowid);
    }
    if (id == null || !Number.isFinite(id)) return false;
    return finalizeWorkerRuntimeRow(db, id, state, reason);
  } catch {
    return false;
  }
}

/**
 * A15 session-gone pass: any launching|running row whose session is missing from tmux
 * is finalized to reaped/session-gone. Returns count finalized.
 */
export async function finalizeSessionGoneWorkers(
  db: FinalizeDb,
  sessionExists: (name: string) => boolean | Promise<boolean>
): Promise<number> {
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, session FROM worker_runtimes
         WHERE state IN ('launching','running') AND session IS NOT NULL AND TRIM(session) != ''`
      )
      .all() as any[];
  } catch {
    return 0;
  }
  let n = 0;
  for (const r of rows) {
    const sess = String(r.session || '').trim();
    if (!sess) continue;
    let alive = true;
    try {
      alive = !!(await sessionExists(sess));
    } catch {
      // Probe failure: do not finalize (fail-safe keep).
      continue;
    }
    if (!alive) {
      if (finalizeWorkerRuntimeRow(db, Number(r.id), 'reaped', 'session-gone')) n += 1;
    }
  }
  return n;
}
