/**
 * B15c / R3.15 — implementer-only L3 invocation telemetry (Reading B, M2+M5).
 *
 * M2 denominator: COUNT(DISTINCT resolve_id) where role=implementer and final tier=L3.
 * M5 bucket: tier-entry cause (vertical record from_tier≠to_tier); else seq=0 cause.
 * seat: final record's resolved_source — separate column, never the cause bucket.
 * Coupled validator rows (cause=COUPLING) are out of scope and never inflate buckets.
 */
import type { InvocationStamp, ResolveCause } from './tier-resolution-service.js';

export type TelemetrySeat = 'primary' | 'backup' | null;

export interface ImplL3Invocation {
  resolve_id: string;
  /** Tier-entry cause (M5) — answers "why is this at L3?" */
  cause: ResolveCause;
  /** Final seat at L3 (M5 seat column) — answers "did it run on backup?" */
  seat: TelemetrySeat;
  resolved_slug: string | null;
  /** Max seq in the chain (for debug / UI). */
  final_seq: number;
  record_count: number;
}

export interface ImplL3TelemetryView {
  /** M2: unique implementer resolve_ids whose final tier is L3. */
  denominator: number;
  buckets: {
    AS_INTENDED: number;
    AVAILABILITY: number;
    DIFFICULTY: number;
    /** COUPLING should stay 0 for impl-scoped view; retained for honesty. */
    COUPLING: number;
  };
  invocations: ImplL3Invocation[];
}

function isVerticalEntry(s: InvocationStamp): boolean {
  if (s.from_tier == null || s.to_tier == null) return false;
  return s.from_tier !== s.to_tier;
}

/**
 * Pure M2+M5 aggregator over invocation stamp chains.
 * Does not mutate input. Only role=implementer; final stamp tier must be L3.
 */
export function aggregateImplL3Invocations(stamps: InvocationStamp[]): ImplL3TelemetryView {
  const byResolve = new Map<string, InvocationStamp[]>();
  for (const s of stamps) {
    if (s.role !== 'implementer') continue;
    const list = byResolve.get(s.resolve_id) || [];
    list.push(s);
    byResolve.set(s.resolve_id, list);
  }

  const invocations: ImplL3Invocation[] = [];

  for (const [resolve_id, chain] of byResolve) {
    const ordered = chain.slice().sort((a, b) => a.seq - b.seq);
    const final = ordered[ordered.length - 1];
    if (!final || final.tier !== 'L3') continue;

    const vertical = ordered.find(isVerticalEntry);
    const entry = vertical ?? ordered.find((s) => s.seq === 0) ?? ordered[0];
    const cause = entry.cause;

    invocations.push({
      resolve_id,
      cause,
      seat: final.resolved_source,
      resolved_slug: final.resolved_slug,
      final_seq: final.seq,
      record_count: ordered.length,
    });
  }

  // Stable order for UI/tests
  invocations.sort((a, b) => a.resolve_id.localeCompare(b.resolve_id));

  const buckets = {
    AS_INTENDED: 0,
    AVAILABILITY: 0,
    DIFFICULTY: 0,
    COUPLING: 0,
  };
  for (const inv of invocations) {
    if (inv.cause in buckets) {
      buckets[inv.cause as keyof typeof buckets] += 1;
    }
  }

  return {
    denominator: invocations.length,
    buckets,
    invocations,
  };
}
