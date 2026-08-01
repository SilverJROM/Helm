/**
 * Pure proposer/signer role designation (D3 / R3.9, R3.12).
 *
 * On round-1 draft hash mismatch the engine designates one seat the
 * proposer for round 2 by a deterministic, artifact-reproducible rule:
 * lower full sha256 of the two round-1 drafts wins; equal hashes break
 * ties by lexicographically lower seatId. Later rounds alternate.
 *
 * No I/O — pure functions only. Round loop (R3/R4) consumes these.
 */

/** Rule name written into auditable proposer logs (R3.9). */
export const PROPOSER_DESIGNATE_RULE = 'lower-sha256-of-round1-drafts' as const;

export type DesignateRound2Input = {
  seatA: string;
  /** Full lowercase hex SHA-256 of seat A's round-1 draft (not short12). */
  shaA: string;
  seatB: string;
  /** Full lowercase hex SHA-256 of seat B's round-1 draft (not short12). */
  shaB: string;
};

export type RoundRoles = {
  proposer: string;
  signer: string;
};

/**
 * Designate the round-2 proposer from the two round-1 draft hashes.
 *
 * Rule `lower-sha256-of-round1-drafts` (R3.9):
 * - Compare full sha256 hex strings lexicographically (not short12).
 * - Lower full hash wins proposer for round 2.
 * - Equal hashes → lexicographically lower seatId wins (documented tie-break).
 *
 * Deterministic and reproducible from artifacts alone; no slot-order bias
 * (swapping which seat is labeled A vs B yields the same proposer).
 */
export function designateRound2Proposer(input: DesignateRound2Input): string {
  const { seatA, shaA, seatB, shaB } = input;
  if (typeof seatA !== 'string' || seatA === '') {
    throw new Error('designateRound2Proposer: seatA must be a non-empty string');
  }
  if (typeof seatB !== 'string' || seatB === '') {
    throw new Error('designateRound2Proposer: seatB must be a non-empty string');
  }
  if (seatA === seatB) {
    throw new Error('designateRound2Proposer: seatA and seatB must be distinct');
  }
  if (typeof shaA !== 'string' || typeof shaB !== 'string') {
    throw new Error('designateRound2Proposer: shaA and shaB must be strings');
  }

  // Full sha256 comparison (never short12). Lexicographic on hex is total order.
  if (shaA < shaB) return seatA;
  if (shaB < shaA) return seatB;
  // Tie on full hash → lower seatId
  return seatA < seatB ? seatA : seatB;
}

/**
 * Roles for a given reconcile/signature round (R3.12 alternation).
 *
 * - Round 2: proposer = round2ProposerSeat (from designateRound2Proposer); other signs.
 * - Round 3: swaps (other proposes; designated signs).
 * - Round 4: swaps again (back to designated as proposer).
 * - Round n (n >= 2): proposerIndex = (n - 2) % 2 relative to designated.
 *
 * Round 1 is blind dual-draft and has no proposer/signer roles — rejected.
 */
export function rolesForRound(
  round: number,
  round2ProposerSeat: string,
  seatA: string,
  seatB: string,
): RoundRoles {
  if (!Number.isInteger(round) || round < 2) {
    throw new Error(
      `rolesForRound: round must be an integer >= 2 (got ${String(round)}); ` +
        'round 1 is blind dual-draft with no proposer/signer roles',
    );
  }
  if (round2ProposerSeat !== seatA && round2ProposerSeat !== seatB) {
    throw new Error(
      `rolesForRound: round2ProposerSeat '${round2ProposerSeat}' is neither seatA nor seatB`,
    );
  }
  if (seatA === seatB) {
    throw new Error('rolesForRound: seatA and seatB must be distinct');
  }

  const other = round2ProposerSeat === seatA ? seatB : seatA;
  // (round - 2) % 2 === 0 → designated proposes; else swaps.
  const designatedProposes = (round - 2) % 2 === 0;
  if (designatedProposes) {
    return { proposer: round2ProposerSeat, signer: other };
  }
  return { proposer: other, signer: round2ProposerSeat };
}

/**
 * Auditable one-line log for proposer designation (R3.9).
 * Includes both full draft shas, both seat ids, the assigned proposer,
 * and the rule name `lower-sha256-of-round1-drafts`.
 */
export function formatProposerLog(input: DesignateRound2Input & { proposer: string }): string {
  const { seatA, shaA, seatB, shaB, proposer } = input;
  return (
    `proposer-designate rule=${PROPOSER_DESIGNATE_RULE}` +
    ` seatA=${seatA} shaA=${shaA}` +
    ` seatB=${seatB} shaB=${shaB}` +
    ` proposer=${proposer}`
  );
}
