/**
 * B14a / R3.13, R3.15, I6 — lateral AVAILABILITY resolve (escalation pipeline step 1).
 * B15a / R3.14, I6 — DIFFICULTY vertical climb (pipeline step 2, post quality-fail only).
 * B15b / R3.14, I7.2 — validator COUPLING when impl DIFFICULTY verticals.
 * B15c / R3.15 — resolve_id + seq chain shape for Reading B telemetry (M2+M5).
 *
 * Lateral: primary → same-tier backup; NO_SEAT is terminal for step 1 (never climbs).
 * Vertical: L1→L2 / L2→L3 with cause=DIFFICULTY; L3 has no higher tier → terminal
 * (DIFFICULTY stamp retained; stall via assertDifficultyClimbable in resolve-time-invariants).
 * Coupling: when impl verticals, validator re-resolves its seat at the same landed tier;
 * always stamped cause=COUPLING (never AS_INTENDED/AVAILABILITY) so B15c's R3.15/M5 bucketing
 * never counts a coupled validator seat as impl DIFFICULTY work.
 * Every resolve emits exactly one stamp so the record never conflates AVAIL with DIFFICULTY (I6).
 * Chain shape: N ordered records share resolve_id with monotonic seq (beginResolve groups them).
 */
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../db/database.js';
import { RoleTierService, type RoleTierRole, type RoleTierLevel } from './role-tier-service.js';

export type AvailabilitySignal = 'AS_INTENDED' | 'LATERAL_FAILOVER' | 'NO_SEAT';
export type ResolveCause = 'AS_INTENDED' | 'AVAILABILITY' | 'DIFFICULTY' | 'COUPLING';
export type DifficultySignal = 'VERTICAL_CLIMB' | 'L3_EXHAUSTED';

export interface InvocationStamp {
  /** Shared across ordered records in one resolve chain (B15c / Reading B). */
  resolve_id: string;
  /** 0-based order within resolve_id chain. */
  seq: number;
  role: RoleTierRole;
  /** Tier of the seat this stamp concerns (lateral: the tier; vertical: to_tier, or from_tier when L3 terminal). */
  tier: RoleTierLevel;
  signal_availability?: AvailabilitySignal;
  cause: ResolveCause;
  from_tier?: RoleTierLevel;
  to_tier?: RoleTierLevel | null;
  signal_difficulty?: DifficultySignal;
  /** Seat filled: primary|backup — R3.15 seat column (not the cause bucket). */
  resolved_source: 'primary' | 'backup' | null;
  resolved_slug: string | null;
  primary_slug: string | null;
  backup_slug: string | null;
  ts: string;
}

export interface TierResolution {
  role: RoleTierRole;
  tier: RoleTierLevel;
  resolved_slug: string | null;
  resolved_source: 'primary' | 'backup' | null;
  signal_availability: AvailabilitySignal;
}

export interface VerticalResolution {
  role: RoleTierRole;
  from_tier: RoleTierLevel;
  to_tier: RoleTierLevel | null;
  cause: 'DIFFICULTY';
  terminal: boolean;
  signal_difficulty: DifficultySignal;
  resolved_slug: string | null;
  resolved_source: 'primary' | 'backup' | null;
}

export type AvailabilityChecker = (slug: string) => boolean | Promise<boolean>;
export type InvocationListener = (stamp: InvocationStamp) => void;

const NEXT_TIER: Record<RoleTierLevel, RoleTierLevel | null> = {
  L1: 'L2',
  L2: 'L3',
  L3: null,
};

function causeFromAvailability(signal: AvailabilitySignal): ResolveCause {
  if (signal === 'AS_INTENDED') return 'AS_INTENDED';
  return 'AVAILABILITY';
}

export class TierResolutionService {
  private readonly roleTiers: RoleTierService;
  private readonly listeners = new Set<InvocationListener>();
  private readonly invocations: InvocationStamp[] = [];
  /** Active multi-record chain (B15c). null ⇒ each emit auto-gens its own resolve_id @ seq=0. */
  private activeResolveId: string | null = null;
  private activeSeq = 0;

  constructor(
    db: DatabaseService,
    private readonly isAvailable: AvailabilityChecker = () => true
  ) {
    this.roleTiers = new RoleTierService(db);
  }

  onInvocation(listener: InvocationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Shared emit path's read surface for this batch; B15c wires persistence/UI. */
  listInvocations(): InvocationStamp[] {
    return this.invocations.slice();
  }

  /** Drop in-memory stamps (fixture reset / tests). Does not end an open beginResolve chain. */
  clearInvocations(): void {
    this.invocations.length = 0;
  }

  /**
   * B15c — open a multi-record resolve_id chain. Subsequent emits share id with seq 0,1,2…
   * until endResolve(). Returns the resolve_id in use.
   */
  beginResolve(resolveId?: string): string {
    const id = resolveId && resolveId.length > 0 ? resolveId : randomUUID();
    this.activeResolveId = id;
    this.activeSeq = 0;
    return id;
  }

  /** Close the active chain so the next lone emit gets a fresh auto resolve_id. */
  endResolve(): void {
    this.activeResolveId = null;
    this.activeSeq = 0;
  }

  /**
   * Pipeline step 1 — AVAILABILITY lateral. Never climbs tiers / never calls EscalationService.
   */
  async resolveLateral(role: RoleTierRole, tier: RoleTierLevel): Promise<TierResolution> {
    const seat = await this.pickSeat(role, tier);
    const signal = seat.signal;

    this.emit({
      role,
      tier,
      signal_availability: signal,
      cause: causeFromAvailability(signal),
      resolved_source: seat.resolved_source,
      resolved_slug: seat.resolved_slug,
      primary_slug: seat.primary_slug,
      backup_slug: seat.backup_slug,
      ts: new Date().toISOString(),
    });

    return {
      role,
      tier,
      resolved_slug: seat.resolved_slug,
      resolved_source: seat.resolved_source,
      signal_availability: signal,
    };
  }

  /**
   * Pipeline step 2 — DIFFICULTY vertical (post quality/task fail only).
   * L1→L2 / L2→L3 land on the next tier's seat (primary, else backup). L3 has no higher
   * tier: emit DIFFICULTY stamp retained, return terminal=true (caller stalls via
   * assertDifficultyClimbable). Low-budget/depleted must not call this path.
   */
  async resolveVertical(role: RoleTierRole, fromTier: RoleTierLevel): Promise<VerticalResolution> {
    const toTier = NEXT_TIER[fromTier];

    // L3 DIFFICULTY exhaustion: no L4, no lateral-as-difficulty. Stamp retained.
    if (toTier == null) {
      const row = this.roleTiers.getRoleTier(role, fromTier);
      this.emit({
        role,
        tier: fromTier,
        cause: 'DIFFICULTY',
        from_tier: fromTier,
        to_tier: null,
        signal_difficulty: 'L3_EXHAUSTED',
        resolved_source: null,
        resolved_slug: null,
        primary_slug: row?.primary_model_slug ?? null,
        backup_slug: row?.backup_model_slug ?? null,
        ts: new Date().toISOString(),
      });
      return {
        role,
        from_tier: fromTier,
        to_tier: null,
        cause: 'DIFFICULTY',
        terminal: true,
        signal_difficulty: 'L3_EXHAUSTED',
        resolved_slug: null,
        resolved_source: null,
      };
    }

    const seat = await this.pickSeat(role, toTier);
    this.emit({
      role,
      tier: toTier,
      cause: 'DIFFICULTY',
      from_tier: fromTier,
      to_tier: toTier,
      signal_difficulty: 'VERTICAL_CLIMB',
      resolved_source: seat.resolved_source,
      resolved_slug: seat.resolved_slug,
      primary_slug: seat.primary_slug,
      backup_slug: seat.backup_slug,
      ts: new Date().toISOString(),
    });

    return {
      role,
      from_tier: fromTier,
      to_tier: toTier,
      cause: 'DIFFICULTY',
      terminal: false,
      signal_difficulty: 'VERTICAL_CLIMB',
      resolved_slug: seat.resolved_slug,
      resolved_source: seat.resolved_source,
    };
  }

  /**
   * B15b / R3.14, I7.2 — validator COUPLING. Re-resolves the validator seat at `toTier`
   * (the tier the implementer just landed on via resolveVertical) and stamps cause=COUPLING
   * unconditionally — a coupled val seat is never AS_INTENDED/AVAILABILITY, regardless of
   * whether its own primary/backup pick happened to be a plain hit. `fromTier` is the
   * validator's own prior tier (lineage only; does not affect the seat pick). Validator seats
   * are backup-less (B12b), so a NO_SEAT here still surfaces via signal_availability and is
   * still enforceable by B14b's assertSeatAvailable — coupling does not bypass R3.17.
   */
  async resolveCoupledValidator(fromTier: RoleTierLevel, toTier: RoleTierLevel): Promise<TierResolution> {
    const seat = await this.pickSeat('validator', toTier);

    this.emit({
      role: 'validator',
      tier: toTier,
      signal_availability: seat.signal,
      cause: 'COUPLING',
      from_tier: fromTier,
      to_tier: toTier,
      resolved_source: seat.resolved_source,
      resolved_slug: seat.resolved_slug,
      primary_slug: seat.primary_slug,
      backup_slug: seat.backup_slug,
      ts: new Date().toISOString(),
    });

    return {
      role: 'validator',
      tier: toTier,
      resolved_slug: seat.resolved_slug,
      resolved_source: seat.resolved_source,
      signal_availability: seat.signal,
    };
  }

  /** Seat pick at a single tier — no emit (callers own the stamp / cause). */
  private async pickSeat(
    role: RoleTierRole,
    tier: RoleTierLevel
  ): Promise<{
    signal: AvailabilitySignal;
    resolved_slug: string | null;
    resolved_source: 'primary' | 'backup' | null;
    primary_slug: string | null;
    backup_slug: string | null;
  }> {
    const row = this.roleTiers.getRoleTier(role, tier);
    const primarySlug = row?.primary_model_slug ?? null;
    const backupSlug = row?.backup_model_slug ?? null;

    if (primarySlug && (await this.isAvailable(primarySlug))) {
      return {
        signal: 'AS_INTENDED',
        resolved_slug: primarySlug,
        resolved_source: 'primary',
        primary_slug: primarySlug,
        backup_slug: backupSlug,
      };
    }
    if (backupSlug && (await this.isAvailable(backupSlug))) {
      return {
        signal: 'LATERAL_FAILOVER',
        resolved_slug: backupSlug,
        resolved_source: 'backup',
        primary_slug: primarySlug,
        backup_slug: backupSlug,
      };
    }
    return {
      signal: 'NO_SEAT',
      resolved_slug: null,
      resolved_source: null,
      primary_slug: primarySlug,
      backup_slug: backupSlug,
    };
  }

  private emit(partial: Omit<InvocationStamp, 'resolve_id' | 'seq'>): void {
    let resolve_id: string;
    let seq: number;
    if (this.activeResolveId != null) {
      resolve_id = this.activeResolveId;
      seq = this.activeSeq;
      this.activeSeq += 1;
    } else {
      resolve_id = randomUUID();
      seq = 0;
    }
    const stamp: InvocationStamp = { resolve_id, seq, ...partial };
    this.invocations.push(stamp);
    for (const listener of this.listeners) listener(stamp);
  }
}
