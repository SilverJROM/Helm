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

/**
 * Structural rather than nominal on purpose: both the raw better-sqlite3 handle and the
 * `DatabaseService` wrapper satisfy this (the wrapper delegates `prepare`/`transaction` to its own
 * raw handle), so this allocates correctly whichever one a caller happens to hold. Narrowed to what
 * this module actually calls (better-sqlite3's `prepare()`/`transaction()` are generic over bind
 * parameters in a way a fixed wrapper method can't structurally satisfy).
 */
interface LifecycleDb {
  prepare(sql: string): { run(): unknown; get(): unknown };
  transaction(fn: () => number): () => number;
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
