/**
 * B13 / R3.16 — Save-time role_tiers invariants (fail-closed).
 * - opus never implements (primary or backup on implementer)
 * - backup_rule: a tier's implementer backup ≠ that tier's validator model (same-tier only)
 *
 * Pure prepare-based helpers: usable from RoleTierService and applyB12bRoleTierSeeds
 * without circular imports (schema ↔ services).
 */

/** Minimal DB surface shared by better-sqlite3 Database and DatabaseService. */
export type RoleTierInvariantDb = {
  prepare: (sql: string) => {
    get: (...params: any[]) => any;
    all: (...params: any[]) => any[];
  };
};

/** B04-canonical opus slug — the only opus registered for studio routing. */
export const OPUS_NEVER_IMPLEMENTS_SLUG = 'opus5';

export type RoleTierInvariantInput = {
  role: string;
  tier: string;
  primary_model_id: number | null;
  backup_model_id: number | null;
};

/** Peer seat shape used by backup_rule (same-tier implementer ↔ validator). */
export type RoleTierPeerSeat = {
  primary_model_id: number | null;
  backup_model_id: number | null;
};

/**
 * Optional hooks for project-effective peer topology (B18-fix1).
 * Default: peer seats are read from Studio `role_tiers` (B13 studio path).
 */
export type RoleTierInvariantOpts = {
  peerSeat?: (
    role: 'implementer' | 'validator',
    tier: string
  ) => RoleTierPeerSeat | null;
};

function slugForModelId(db: RoleTierInvariantDb, id: number | null): string | null {
  if (id == null) return null;
  const row = db.prepare('SELECT slug FROM models WHERE id = ?').get(id) as { slug?: string } | undefined;
  return row?.slug != null ? String(row.slug) : null;
}

function studioPeerSeat(
  db: RoleTierInvariantDb,
  role: 'implementer' | 'validator',
  tier: string
): RoleTierPeerSeat | null {
  const row = db
    .prepare('SELECT primary_model_id, backup_model_id FROM role_tiers WHERE role = ? AND tier = ?')
    .get(role, tier) as
    | { primary_model_id: number | null; backup_model_id: number | null }
    | undefined;
  if (!row) return null;
  return {
    primary_model_id: row.primary_model_id != null ? Number(row.primary_model_id) : null,
    backup_model_id: row.backup_model_id != null ? Number(row.backup_model_id) : null,
  };
}

/**
 * Assert R3.16 save-time invariants for a pending role_tier binding.
 * Throws Error with a clear message (mapped to HTTP 400 by API layer).
 *
 * Peer rows: when the peer seat is missing, backup_rule is N/A for that side.
 * When asserting an existing row via assertAll*, the peer is read from the table
 * (so full-seed reval sees both sides).
 *
 * B18-fix1: pass `opts.peerSeat` to validate against project-effective peers
 * instead of Studio-only seats.
 */
export function assertRoleTierSaveInvariants(
  db: RoleTierInvariantDb,
  input: RoleTierInvariantInput,
  opts?: RoleTierInvariantOpts
): void {
  const role = String(input.role || '').trim();
  const tier = String(input.tier || '').trim();
  const primaryId = input.primary_model_id != null ? Number(input.primary_model_id) : null;
  const backupId = input.backup_model_id != null ? Number(input.backup_model_id) : null;
  const resolvePeer =
    opts?.peerSeat ??
    ((r: 'implementer' | 'validator', t: string) => studioPeerSeat(db, r, t));

  // --- opus never implements ---
  if (role === 'implementer') {
    for (const [field, id] of [
      ['primary_model_id', primaryId],
      ['backup_model_id', backupId],
    ] as const) {
      if (id == null) continue;
      const slug = slugForModelId(db, id);
      if (slug === OPUS_NEVER_IMPLEMENTS_SLUG) {
        throw new Error(
          `role_tier invariant: opus never implements (${field} is ${OPUS_NEVER_IMPLEMENTS_SLUG} on implementer/${tier})`
        );
      }
    }
  }

  // --- backup_rule (same-tier only) ---
  // "A tier's backup is never that tier's validator model."
  if (role === 'implementer' && backupId != null) {
    const val = resolvePeer('validator', tier);
    if (val) {
      if (val.primary_model_id != null && backupId === val.primary_model_id) {
        const slug = slugForModelId(db, backupId) ?? String(backupId);
        throw new Error(
          `role_tier invariant: backup must not equal same-tier validator model (implementer/${tier} backup=${slug})`
        );
      }
      if (val.backup_model_id != null && backupId === val.backup_model_id) {
        const slug = slugForModelId(db, backupId) ?? String(backupId);
        throw new Error(
          `role_tier invariant: backup must not equal same-tier validator model (implementer/${tier} backup=${slug})`
        );
      }
    }
  }

  // Mirror: saving validator primary/backup that collides with implementer backup
  if (role === 'validator') {
    const impl = resolvePeer('implementer', tier);
    if (impl?.backup_model_id != null) {
      const implBackup = impl.backup_model_id;
      for (const [field, id] of [
        ['primary_model_id', primaryId],
        ['backup_model_id', backupId],
      ] as const) {
        if (id != null && id === implBackup) {
          const slug = slugForModelId(db, id) ?? String(id);
          throw new Error(
            `role_tier invariant: backup must not equal same-tier validator model (validator/${tier} ${field}=${slug} collides with implementer backup)`
          );
        }
      }
    }
  }
}

/**
 * B19 / R5.22 — fail-closed walk of a composed **effective** topology (Studio→Project, or any other
 * resolved set), used as a postcondition after project mutations (`clearProjectRoleTier`) and as the
 * freeze-time backstop before a cycle-start snapshot. Each row is checked against its same-tier peer
 * *within the same effective set* — catches compositions no single mutation-site check can see (e.g.
 * clearing an override reverts a seat to Studio's value, which may collide with a peer that is still
 * project-overridden).
 */
export function assertEffectiveRoleTiersInvariants(
  db: RoleTierInvariantDb,
  effective: RoleTierInvariantInput[]
): void {
  const bySeat = new Map<string, RoleTierPeerSeat>();
  for (const row of effective) {
    bySeat.set(`${row.role}:${row.tier}`, {
      primary_model_id: row.primary_model_id,
      backup_model_id: row.backup_model_id,
    });
  }
  const peerSeat = (role: 'implementer' | 'validator', tier: string): RoleTierPeerSeat | null =>
    bySeat.get(`${role}:${tier}`) ?? null;
  for (const row of effective) {
    assertRoleTierSaveInvariants(db, row, { peerSeat });
  }
}

/**
 * Fail-closed walk of every role_tiers row (B12b seed reval + full-table hygiene).
 * Throws on first violation.
 */
export function assertAllRoleTiersInvariants(db: RoleTierInvariantDb): void {
  const rows = db
    .prepare('SELECT role, tier, primary_model_id, backup_model_id FROM role_tiers')
    .all() as Array<{
    role: string;
    tier: string;
    primary_model_id: number | null;
    backup_model_id: number | null;
  }>;
  for (const row of rows) {
    assertRoleTierSaveInvariants(db, {
      role: row.role,
      tier: row.tier,
      primary_model_id: row.primary_model_id != null ? Number(row.primary_model_id) : null,
      backup_model_id: row.backup_model_id != null ? Number(row.backup_model_id) : null,
    });
  }
}
