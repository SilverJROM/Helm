/**
 * B15x / I7 — Resolve-time verifier≠fixer guard (val + redteam), early backstop.
 * Pure, DB-free — mirrors role-tier-invariants.ts's shape so it is directly unit-testable.
 *
 * Val half: resolved_impl_model === resolved_val_model -> stall.
 * Redteam half (M1): strip impl from the resolved redteam panel; count < 3 -> stall.
 * Both halves are evaluated on every call (no skip on an already-clean resolve).
 *
 * B14b / R3.17, I7 — seat-exhaustion half. Role-agnostic: takes a TierResolutionService
 * NO_SEAT signal (B14a) for ANY role/tier and stalls. Deliberately does not accept a
 * fallback slug from another role — there is nothing here to climb onto.
 *
 * B15a / R3.14, I6 — L3 DIFFICULTY exhaustion. Vertical climb past L3 does not exist;
 * resolveVertical returns terminal + DIFFICULTY stamp retained; this guard stalls+JROM.
 */

export type I7StallReason =
  | 'val-collision'
  | 'redteam-strip-count'
  | 'seat-exhaustion'
  | 'difficulty-exhaustion';

export class ResolveStallError extends Error {
  reason: I7StallReason;
  constructor(reason: I7StallReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface I7ResolveGuardInput {
  implModel?: string | null;
  valModel?: string | null;
  redTeamAgents: Array<{ model?: string | null }>;
}

/** Val half: resolved_impl_model === resolved_val_model -> stall. */
export function assertNoValCollision(implModel?: string | null, valModel?: string | null): void {
  if (implModel && valModel && implModel === valModel) {
    throw new ResolveStallError(
      'val-collision',
      `I7: resolved_impl_model === resolved_val_model (${implModel}) — verifier≠fixer violated, stall + flag JROM`
    );
  }
}

/** Redteam half (M1): strip impl from the resolved panel; count < 3 -> stall. */
export function assertRedteamPanelSize(
  implModel: string | null | undefined,
  redTeamAgents: Array<{ model?: string | null }>
): void {
  const panel = redTeamAgents.filter((a) => !(implModel && a.model === implModel));
  if (panel.length < 3) {
    throw new ResolveStallError(
      'redteam-strip-count',
      `I7 M1: redteam panel after stripping resolved_impl_model (${implModel ?? 'none'}) has ${panel.length} member(s) (<3) — never silent self-review, stall + flag JROM`
    );
  }
}

/**
 * Throws ResolveStallError when resolved_impl_model collides with the validator or leaves
 * the redteam panel under 3 members after stripping impl. No-op (returns) when clean.
 * Both halves evaluated unconditionally (I7.1: "always runs on happy resolve too").
 */
export function assertI7ResolveGuard(input: I7ResolveGuardInput): void {
  assertNoValCollision(input.implModel, input.valModel);
  assertRedteamPanelSize(input.implModel, input.redTeamAgents);
}

/**
 * R3.17 — a tier's primary and backup both unavailable (TierResolutionService NO_SEAT,
 * B14a) -> stall + flag JROM. Role-agnostic by construction: `role` is carried only for the
 * message, never branched on. Takes just the resolved signal, so there is no seam here for
 * a caller to pass another role's slug in as a substitute — the guard has nothing to climb.
 */
export function assertSeatAvailable(
  role: string,
  resolution: { signal_availability: string }
): void {
  if (resolution.signal_availability === 'NO_SEAT') {
    throw new ResolveStallError(
      'seat-exhaustion',
      `I7 R3.17: ${role} primary and backup both unavailable — stall + flag JROM, no cross-role climb`
    );
  }
}

/**
 * R3.14 / I6 — L3 DIFFICULTY with no higher tier → stall + flag JROM.
 * Caller must have already emitted the DIFFICULTY stamp (resolveVertical retains it);
 * this guard only enforces the terminal stop. No-op on non-terminal vertical climbs (L1/L2).
 */
export function assertDifficultyClimbable(resolution: {
  terminal?: boolean;
  signal_difficulty?: string;
  from_tier?: string;
}): void {
  if (resolution.terminal === true || resolution.signal_difficulty === 'L3_EXHAUSTED') {
    throw new ResolveStallError(
      'difficulty-exhaustion',
      `I6 R3.14: L3 DIFFICULTY with no higher tier (from_tier=${resolution.from_tier ?? 'L3'}) — stall + flag JROM; DIFFICULTY stamp retained; no L4 / no lateral-as-difficulty`
    );
  }
}
