/**
 * S10 / AC16–18, AC21 surviving trigger, AC26 anomaly trigger.
 *
 * Residual-path **observation** helper: idleness may trigger investigation only.
 * Never a kill/reap verdict. Pure facts in → KEEP | INVESTIGATE out. No tmux, no DB, no writes.
 *
 * Effective activity = max(last_used_at, tmux #{session_activity}).
 * Attached sessions are excluded. Missing facts and run_id IS NULL are never abandonment evidence.
 */

/** Investigation trigger only — kill/reap is intentionally not in this union (S11 owns that). */
export type ObservationAction = 'KEEP' | 'INVESTIGATE';
/**
 * Hours-scale investigation threshold (AC21 surviving trigger — not a reap TTL).
 * Default 4h matches the former interactive floor and JROM's "hours idle" framing.
 */
export const DEFAULT_IDLE_THRESHOLD_MS = 4 * 60 * 60 * 1000;

export interface SessionObservationFacts {
  /** Registry last_used_at (SQLite datetime / ISO). Null = unknown. */
  lastUsedAt: string | null;
  /**
   * tmux #{session_activity} as unix epoch **seconds** (S08 reader), or null = unknown.
   * Pass the raw number from TmuxService.sessionActivity.
   */
  sessionActivity: number | null;
  /** tmux #{session_attached}: true / false / null = unknown (fail-safe KEEP). */
  sessionAttached: boolean | null;
  /**
   * Registry run_id. Null is normal for chat seats (AC18) and is **never** abandonment
   * evidence by itself — only a positive idle signal may INVESTIGATE.
   */
  runId: number | null;
  /** Optional created_at fallback when last_used_at is null (same as legacy TTL path). */
  createdAt?: string | null;
  /** Injectable clock for tests. */
  nowMs?: number;
  /** Injectable threshold; defaults to DEFAULT_IDLE_THRESHOLD_MS. */
  idleThresholdMs?: number;
}

export interface SessionObservationResult {
  action: ObservationAction;
  reason: string;
  /** max of known activity timestamps in ms epoch, or null when none usable. */
  effectiveActivityMs: number | null;
  /** now - effectiveActivity when both known; null when not computable. */
  idleAgeMs: number | null;
}

/**
 * Parse a registry datetime string (SQLite `datetime('now')` or ISO) to ms epoch.
 * Returns null on missing/unparseable input (fail-safe: not treated as epoch 0).
 */
export function parseRegistryTimestampMs(raw: string | null | undefined): number | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  // SQLite default is "YYYY-MM-DD HH:MM:SS" (space). Date.parse needs T or Z for UTC-ish parse.
  // Prefer treating space form as UTC by substituting T and appending Z when no zone present.
  let candidate = s;
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s) && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(s)) {
    candidate = s.replace(' ', 'T') + 'Z';
  }
  const ms = Date.parse(candidate);
  if (!Number.isFinite(ms)) return null;
  return ms;
}

/**
 * Normalize S08 session_activity (unix seconds) to ms. Reject non-finite / negative.
 */
export function sessionActivityToMs(sessionActivity: number | null | undefined): number | null {
  if (sessionActivity == null) return null;
  if (!Number.isFinite(sessionActivity) || sessionActivity < 0) return null;
  // Heuristic: values that already look like ms (> year ~2001 in seconds*1000 scale) stay as ms;
  // S08 contracts seconds, so treat finite non-negative as seconds.
  return Math.floor(sessionActivity * 1000);
}

/**
 * Effective activity = max of known last_used_at (or created_at) and session_activity.
 * Missing sides are ignored, never coerced to 0 (would fabricate ancient idle).
 */
export function effectiveActivityMs(facts: {
  lastUsedAt: string | null;
  createdAt?: string | null;
  sessionActivity: number | null;
}): number | null {
  const dbMs =
    parseRegistryTimestampMs(facts.lastUsedAt) ??
    parseRegistryTimestampMs(facts.createdAt ?? null);
  const tmuxMs = sessionActivityToMs(facts.sessionActivity);
  if (dbMs == null && tmuxMs == null) return null;
  if (dbMs == null) return tmuxMs;
  if (tmuxMs == null) return dbMs;
  return Math.max(dbMs, tmuxMs);
}

/**
 * Observe whether a seat is hours-idle enough to **investigate** (never reap).
 *
 * Priority:
 * 1. attached=true → KEEP (AC17)
 * 2. attached=null → KEEP fail-safe (unknown is not idle evidence)
 * 3. no usable activity → KEEP (missing facts ≠ abandonment)
 * 4. idleAge < threshold → KEEP (covers stale-DB/recent-tmux and inverse via max)
 * 5. hours-idle positive → INVESTIGATE (AC21/26); run_id null does not block or alone trigger
 */
export function observeSessionIdleness(facts: SessionObservationFacts): SessionObservationResult {
  const nowMs = facts.nowMs ?? Date.now();
  const threshold = facts.idleThresholdMs ?? DEFAULT_IDLE_THRESHOLD_MS;
  const effective = effectiveActivityMs({
    lastUsedAt: facts.lastUsedAt,
    createdAt: facts.createdAt ?? null,
    sessionActivity: facts.sessionActivity,
  });
  const idleAgeMs = effective == null ? null : Math.max(0, nowMs - effective);

  if (facts.sessionAttached === true) {
    return {
      action: 'KEEP',
      reason: 'attached_excluded',
      effectiveActivityMs: effective,
      idleAgeMs,
    };
  }

  if (facts.sessionAttached == null) {
    return {
      action: 'KEEP',
      reason: 'attached_unknown',
      effectiveActivityMs: effective,
      idleAgeMs,
    };
  }

  // sessionAttached === false from here
  if (effective == null || idleAgeMs == null) {
    return {
      action: 'KEEP',
      reason: 'missing_activity_facts',
      effectiveActivityMs: null,
      idleAgeMs: null,
    };
  }

  if (idleAgeMs < threshold) {
    return {
      action: 'KEEP',
      reason: 'within_idle_threshold',
      effectiveActivityMs: effective,
      idleAgeMs,
    };
  }

  // Positive idle signal only — runId is intentionally unused as authority (AC18).
  // Presence or absence of run_id neither forces KEEP nor invents INVESTIGATE.
  void facts.runId;

  return {
    action: 'INVESTIGATE',
    reason: 'hours_idle_anomaly',
    effectiveActivityMs: effective,
    idleAgeMs,
  };
}
