/**
 * B20 / R5.23 — Intended vs actual team record.
 *
 * Intended = B19 freeze snapshot (cycle_topology_freezes).
 * Actual = resolve-path invocation stamps (B14a–B15b).
 * Every actual≠intended delta carries a structural reason (DB NOT NULL + CHECK).
 * Multi-cause: N ordered rows share resolve_id with monotonic seq (e.g. DIFFICULTY + COUPLING).
 * M3: COUPLING rows come from real resolveCoupledValidator stamps, never invented here.
 *
 * B20-fix1: deviation detection is comparison-driven (freeze intended vs resolved actual),
 * not cause-gated. cause=AS_INTENDED with actual≠intended → reason=SEAT_CHANGED.
 */
import { DatabaseService } from '../db/database.js';
import {
  TopologyFreezeService,
  type CycleTopologyFreeze,
} from './topology-freeze-service.js';
import type { InvocationStamp, ResolveCause } from './tier-resolution-service.js';
import type { RoleTierLevel, RoleTierRole } from './role-tier-service.js';

export type DeltaReason = 'AVAILABILITY' | 'DIFFICULTY' | 'COUPLING' | 'SEAT_CHANGED';

export interface CycleTeamDelta {
  id: number;
  cycle_id: number;
  resolve_id: string;
  seq: number;
  role: RoleTierRole;
  intended_tier: RoleTierLevel;
  actual_tier: RoleTierLevel;
  intended_slug: string | null;
  actual_slug: string | null;
  reason: DeltaReason;
  created_at: string;
}

export interface CycleTeamDeltaDraft {
  resolve_id: string;
  seq: number;
  role: RoleTierRole;
  intended_tier: RoleTierLevel;
  actual_tier: RoleTierLevel;
  intended_slug: string | null;
  actual_slug: string | null;
  reason: DeltaReason;
}

/** Causes that map 1:1 to delta reasons (resolve-path labelled). */
const CAUSE_DELTA_REASONS = new Set<string>(['AVAILABILITY', 'DIFFICULTY', 'COUPLING']);

const DELTA_REASONS = new Set<string>(['AVAILABILITY', 'DIFFICULTY', 'COUPLING', 'SEAT_CHANGED']);

function isDeltaReason(reason: ResolveCause | string | null | undefined): reason is DeltaReason {
  return typeof reason === 'string' && DELTA_REASONS.has(reason);
}

function requireReason(reason: unknown): DeltaReason {
  if (reason == null || reason === '') {
    const err: any = new Error('reason required for intended≠actual delta');
    err.code = 'REASON_REQUIRED';
    throw err;
  }
  if (!isDeltaReason(String(reason))) {
    const err: any = new Error(`invalid delta reason: ${reason}`);
    err.code = 'REASON_REQUIRED';
    throw err;
  }
  return reason as DeltaReason;
}

/**
 * Map stamp cause → structural delta reason.
 * AVAILABILITY|DIFFICULTY|COUPLING keep their cause; any other non-delta cause
 * on a real deviation (e.g. AS_INTENDED after post-freeze seat re-point) → SEAT_CHANGED.
 */
function reasonFromStamp(cause: ResolveCause | string | null | undefined): DeltaReason {
  if (typeof cause === 'string' && CAUSE_DELTA_REASONS.has(cause)) {
    return cause as DeltaReason;
  }
  return 'SEAT_CHANGED';
}

function rowToDelta(row: any): CycleTeamDelta {
  return {
    id: Number(row.id),
    cycle_id: Number(row.cycle_id),
    resolve_id: String(row.resolve_id),
    seq: Number(row.seq),
    role: String(row.role) as RoleTierRole,
    intended_tier: String(row.intended_tier) as RoleTierLevel,
    actual_tier: String(row.actual_tier) as RoleTierLevel,
    intended_slug: row.intended_slug == null ? null : String(row.intended_slug),
    actual_slug: row.actual_slug == null ? null : String(row.actual_slug),
    reason: String(row.reason) as DeltaReason,
    created_at: String(row.created_at),
  };
}

function freezePrimarySlug(
  freeze: CycleTopologyFreeze,
  role: RoleTierRole,
  tier: RoleTierLevel
): string | null {
  const seat = freeze.snapshot.role_tiers.find((r) => r.role === role && r.tier === tier);
  if (!seat) return null;
  return seat.primary_model_slug != null ? String(seat.primary_model_slug) : null;
}

export class IntendedActualService {
  private readonly freezes: TopologyFreezeService;

  constructor(private readonly db: DatabaseService) {
    this.freezes = new TopologyFreezeService(db);
  }

  /**
   * Pure compare: freeze vs resolve stamps → delta drafts (no write).
   * Comparison-driven: emit when actual_slug ≠ intended_slug OR actual_tier ≠ intended_tier.
   * Reason from cause when cause is AVAILABILITY|DIFFICULTY|COUPLING; else SEAT_CHANGED.
   * Happy path (no deviation) → zero rows, even if cause is AS_INTENDED.
   */
  diff(freeze: CycleTopologyFreeze, stamps: InvocationStamp[]): CycleTeamDeltaDraft[] {
    const out: CycleTeamDeltaDraft[] = [];
    for (const s of stamps) {
      const intended_tier = (s.from_tier ?? s.tier) as RoleTierLevel;
      const actual_tier = (s.to_tier ?? s.tier) as RoleTierLevel;
      // Freeze-only intended — never backfill from live primary_slug (papers over drift).
      const intended_slug = freezePrimarySlug(freeze, s.role, intended_tier);
      const actual_slug = s.resolved_slug ?? null;

      const slugDiffers = intended_slug !== actual_slug;
      const tierDiffers = intended_tier !== actual_tier;
      if (!slugDiffers && !tierDiffers) continue;

      out.push({
        resolve_id: s.resolve_id,
        seq: s.seq,
        role: s.role,
        intended_tier,
        actual_tier,
        intended_slug,
        actual_slug,
        reason: reasonFromStamp(s.cause),
      });
    }
    return out;
  }

  listDeltas(cycleId: number): CycleTeamDelta[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM cycle_team_deltas WHERE cycle_id = ? ORDER BY resolve_id ASC, seq ASC, id ASC`
      )
      .all(cycleId) as any[];
    return rows.map(rowToDelta);
  }

  /**
   * Derive + persist deltas from real resolve stamps vs freeze.
   * Throws NO_FREEZE if cycle has no freeze; REASON_REQUIRED if reason empty/invalid.
   * Replaces any prior deltas for this cycle (fixture-friendly idempotent rewrite).
   */
  recordFromStamps(cycleId: number, stamps: InvocationStamp[]): CycleTeamDelta[] {
    const freeze = this.freezes.getFreeze(cycleId);
    if (!freeze) {
      const err: any = new Error(`cycle ${cycleId} has no topology freeze (intended team unknown)`);
      err.code = 'NO_FREEZE';
      throw err;
    }

    const drafts = this.diff(freeze, stamps);
    for (const d of drafts) {
      requireReason(d.reason);
    }

    const apply = this.db.raw.transaction(() => {
      this.db.prepare(`DELETE FROM cycle_team_deltas WHERE cycle_id = ?`).run(cycleId);
      const insert = this.db.prepare(
        `INSERT INTO cycle_team_deltas
          (cycle_id, resolve_id, seq, role, intended_tier, actual_tier, intended_slug, actual_slug, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );
      for (const d of drafts) {
        const reason = requireReason(d.reason);
        insert.run(
          cycleId,
          d.resolve_id,
          d.seq,
          d.role,
          d.intended_tier,
          d.actual_tier,
          d.intended_slug,
          d.actual_slug,
          reason
        );
      }
    });
    apply();
    return this.listDeltas(cycleId);
  }

  /**
   * App-layer reject-without-reason (also enforced by schema NOT NULL).
   * Used by tests and any manual write path.
   */
  insertDelta(
    cycleId: number,
    draft: Partial<CycleTeamDeltaDraft> & {
      resolve_id?: string;
      seq?: number;
      role?: string;
      intended_tier?: string;
      actual_tier?: string;
    }
  ): CycleTeamDelta {
    const reason = requireReason(draft.reason);
    if (!draft.resolve_id || draft.seq == null || !draft.role || !draft.intended_tier || !draft.actual_tier) {
      const err: any = new Error('incomplete delta draft');
      err.code = 'INVALID_DELTA';
      throw err;
    }
    const row = this.db
      .prepare(
        `INSERT INTO cycle_team_deltas
          (cycle_id, resolve_id, seq, role, intended_tier, actual_tier, intended_slug, actual_slug, reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
      )
      .get(
        cycleId,
        draft.resolve_id,
        draft.seq,
        draft.role,
        draft.intended_tier,
        draft.actual_tier,
        draft.intended_slug ?? null,
        draft.actual_slug ?? null,
        reason
      ) as any;
    return rowToDelta(row);
  }

  /** Group deltas by resolve_id for multi-cause UI. */
  multiCauseChains(deltas: CycleTeamDelta[]): Array<{
    resolve_id: string;
    reasons: DeltaReason[];
    distinct_reason_count: number;
    rows: CycleTeamDelta[];
  }> {
    const by = new Map<string, CycleTeamDelta[]>();
    for (const d of deltas) {
      const list = by.get(d.resolve_id) || [];
      list.push(d);
      by.set(d.resolve_id, list);
    }
    return [...by.entries()]
      .map(([resolve_id, rows]) => {
        const ordered = rows.slice().sort((a, b) => a.seq - b.seq);
        const reasons = ordered.map((r) => r.reason);
        return {
          resolve_id,
          reasons,
          distinct_reason_count: new Set(reasons).size,
          rows: ordered,
        };
      })
      .sort((a, b) => a.resolve_id.localeCompare(b.resolve_id));
  }
}
