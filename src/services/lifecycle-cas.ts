import type Database from "better-sqlite3";

// B01 / D01 (janitor-audit-remediation): the shared lifecycle-generation mechanism behind
// AC4-AC8. One durable, monotonic, never-reset `lifecycle_seq` counter allocates the nonce for
// both `runs.generation` and `helm_sessions.generation`. Any allocator derived from the table it
// protects resets exactly at the moment it matters (a cascading DELETE); this counter lives
// outside both tables so it never does (D01 Fact 3).

/**
 * Captured identity of a row governed by the shared generation allocator. A caller records this
 * at the authoritative read/dispatch boundary and requires it, unchanged, at the mutation
 * boundary — `changes === 0` means the world moved and the caller must not retry with a freshly
 * re-read token (see plan.md "Shared CAS keystone").
 */
export interface LifecycleToken {
  id: number;
  generation: number;
}

/** Session status values that participate in CAS status writers (AC6 / B02). */
export type SessionCasStatus = 'active' | 'idle' | 'reaped';

/** Decision authority values stored on helm_sessions.owner (S04). */
export type SessionCasOwner = 'helm' | 'human' | 'legacy:unknown';

/**
 * B02 / AC6: full session status CAS token. Captured at the authoritative read/dispatch
 * boundary; required unchanged at every status-mutating write. Name-only status writes are a
 * defect. A rejected write (`applied: false`) must not be retried with a freshly re-read token.
 */
export interface SessionStatusToken extends LifecycleToken {
  name: string;
  owner: SessionCasOwner;
  expectedStatus: SessionCasStatus;
}

/**
 * Result of a session status CAS write. `stale` means zero rows matched the full predicate
 * set — the world moved; the caller must abort/KEEP, not refresh the token and retry.
 */
export type SessionStatusCasResult =
  | { applied: true }
  | { applied: false; stale: true };

const VALID_CAS_OWNERS = new Set<SessionCasOwner>(['helm', 'human', 'legacy:unknown']);
const VALID_CAS_STATUSES = new Set<SessionCasStatus>(['active', 'idle', 'reaped']);

/**
 * Build a SessionStatusToken from a registry row (or equivalent SELECT). Throws if owner/status
 * are missing or outside the closed sets — callers must not invent authority.
 */
export function sessionStatusTokenFromRow(row: {
  id: number;
  name: string;
  owner: string | null | undefined;
  status: string;
  generation: number;
}): SessionStatusToken {
  const owner = row.owner as SessionCasOwner;
  const expectedStatus = row.status as SessionCasStatus;
  if (typeof row.id !== 'number' || !Number.isFinite(row.id)) {
    throw new Error(`sessionStatusTokenFromRow: invalid id ${String(row.id)}`);
  }
  if (typeof row.name !== 'string' || !row.name) {
    throw new Error('sessionStatusTokenFromRow: name required');
  }
  if (!VALID_CAS_OWNERS.has(owner)) {
    throw new Error(
      `sessionStatusTokenFromRow: invalid owner ${row.owner === undefined || row.owner === null ? String(row.owner) : JSON.stringify(row.owner)}`
    );
  }
  if (!VALID_CAS_STATUSES.has(expectedStatus)) {
    throw new Error(`sessionStatusTokenFromRow: invalid status ${JSON.stringify(row.status)}`);
  }
  if (typeof row.generation !== 'number' || !Number.isFinite(row.generation) || row.generation < 0) {
    throw new Error(`sessionStatusTokenFromRow: invalid generation ${String(row.generation)}`);
  }
  return {
    id: row.id,
    name: row.name,
    owner,
    expectedStatus,
    generation: row.generation,
  };
}

/**
 * Structural rather than nominal on purpose: both the raw better-sqlite3 handle and the
 * `DatabaseService` wrapper satisfy this (the wrapper delegates `prepare`/`transaction` to its own
 * raw handle), so this allocates correctly whichever one a caller happens to hold. Narrowed to what
 * this module actually calls (better-sqlite3's `prepare()`/`transaction()` are generic over bind
 * parameters in a way a fixed wrapper method can't structurally satisfy).
 */
interface LifecycleDb {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
  };
  transaction<T>(fn: () => T): () => T;
}

/**
 * Bump-and-return the shared `lifecycle_seq` counter inside one transaction. Strictly increasing,
 * never reused. The defensive seed-insert makes this safe to call against any DB that has run the
 * B01 migration/fresh-schema, even if some future caller constructs a `lifecycle_seq` row lazily.
 */
export function allocateLifecycleGeneration(db: LifecycleDb): number {
  const allocate = db.transaction((): number => {
    db.prepare(
      `INSERT INTO lifecycle_seq (name, next) VALUES ('global', 1) ON CONFLICT(name) DO NOTHING`
    ).run();
    const row = db
      .prepare(
        `UPDATE lifecycle_seq SET next = next + 1 WHERE name = 'global' RETURNING next - 1 AS allocated`
      )
      .get() as { allocated: number };
    return row.allocated;
  });
  return allocate();
}

/**
 * B03 / B01 residual C1: after an ingest row lands with a caller-supplied generation, raise the
 * shared counter so a later native `allocateLifecycleGeneration` cannot re-issue that value (or
 * any lower one). Does not rewrite ingest identity — only advances `lifecycle_seq.next` to
 * `max(next, minNext)`. Safe inside an outer transaction (better-sqlite3 nested savepoint).
 */
export function advanceLifecycleSeqAtLeast(db: LifecycleDb, minNext: number): void {
  if (!Number.isFinite(minNext) || minNext < 1) return;
  const floor = Math.floor(minNext);
  const advance = db.transaction((): void => {
    db.prepare(
      `INSERT INTO lifecycle_seq (name, next) VALUES ('global', 1) ON CONFLICT(name) DO NOTHING`
    ).run();
    db.prepare(
      `UPDATE lifecycle_seq SET next = MAX(next, ?) WHERE name = 'global'`
    ).run(floor);
  });
  advance();
}
