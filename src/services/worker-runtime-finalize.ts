/**
 * A15 / R4.16–R4.17 — shared finalize writer for worker_runtimes.
 * Single choke for transitioning seats to a terminal state with non-NULL ended_at.
 * Idempotent: no-op when already done|failed|reaped.
 *
 * S02: on first successful terminal transition, assert helm_sessions idle via injected
 * markIdle (SessionRegistryService.markIdle) so the janitor later sees ownership truth.
 */

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

/** Injected registry-idle assertion (reuse SessionRegistryService.markIdle — no SQL dup). */
export type FinalizeMarkIdle = (session: string, reason?: string) => void;

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
    const row = db.prepare(`SELECT session FROM worker_runtimes WHERE id=?`).get(id) as
      | { session?: string | null }
      | undefined;
    const session = String(row?.session ?? '').trim();
    if (!session) return;
    markIdleHook(session, reason);
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
 */
export async function finalizeRunWorkerRuntimes(
  db: FinalizeDb,
  runId: number,
  reason: string,
  reapSession?: (session: string) => void | Promise<void>
): Promise<number> {
  if (runId == null || !Number.isFinite(Number(runId))) return 0;
  let rows: any[] = [];
  try {
    rows = db
      .prepare(
        `SELECT id, session FROM worker_runtimes
         WHERE run_id = ? AND state NOT IN ('done','failed','reaped')`
      )
      .all(runId) as any[];
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
