/**
 * S11 / AC14, AC18, AC25, AC26 (+ AC6/8 surviving invariants).
 *
 * Pure reconcile **decision**: registry row + deterministic facts → REAP | CONVERGE | KEEP
 * with a stable reason. No tmux I/O, no DB, no writes. Janitor wiring is S12.
 *
 * Authority (north-star): a session is reaped because its owner **asserted** the work is
 * done — never because it looked quiet, and never because run_id is null (F3 deleted).
 *
 * Priority (keep-biased):
 * 1. already reaped → KEEP
 * 2. non-helm owner (human | legacy:unknown | null | unknown) → KEEP
 * 3. session provably gone → CONVERGE (AC14; record only, no kill)
 * 4. session existence unknown → KEEP
 * 5. no completion assertion (status !== idle) → KEEP (AC8/26)
 * 6. helm + idle assertion + live → REAP (AC25)
 *
 * Non-authorities: run_id (null or set), wall-clock idleness, run terminal status.
 */

import type { HelmSessionStatus, SessionOwner } from './session-registry-service.js';

/** Decision actions. CONVERGE = mark registry closed without terminate. */
export type ReconcileAction = 'REAP' | 'CONVERGE' | 'KEEP';

/** Completion assertion = registry status idle (markIdle from S02/S03). */
export type ReconcileRow = {
  owner: SessionOwner | null | undefined;
  status: HelmSessionStatus | string | null | undefined;
  /**
   * Present only so callers/tests can prove non-authority (AC18).
   * Must never change the decision.
   */
  run_id?: number | null;
  name?: string | null;
};

export type ReconcileFacts = {
  /**
   * Live tmux existence from a prior fail-safe probe (S08-style):
   * true = live, false = provably gone, null = unknown (probe fail / not checked).
   * This module never probes — facts are injected.
   */
  sessionExists: boolean | null;
};

export type ReconcileDecision = {
  action: ReconcileAction;
  reason: string;
};

/**
 * Pure decision: row + facts → REAP | CONVERGE | KEEP.
 * Deterministic; no side effects.
 */
export function decideSessionReconcile(
  row: ReconcileRow,
  facts: ReconcileFacts
): ReconcileDecision {
  // run_id is intentionally non-authoritative (AC18 / F3 delete).
  void row.run_id;

  const status = row.status == null ? null : String(row.status);
  const owner = row.owner == null ? null : String(row.owner);

  if (status === 'reaped') {
    return { action: 'KEEP', reason: 'already_reaped' };
  }

  // Human / legacy / null / unknown owners never enter automatic REAP/CONVERGE authority.
  // Manual close (S14) owns human seats. Legacy/unknown are structurally out of scope.
  if (owner !== 'helm') {
    return { action: 'KEEP', reason: 'owner_not_helm' };
  }

  // AC14: provably gone → converge registry without kill (before any REAP path).
  if (facts.sessionExists === false) {
    return { action: 'CONVERGE', reason: 'session_gone' };
  }

  if (facts.sessionExists == null) {
    return { action: 'KEEP', reason: 'session_unknown' };
  }

  // sessionExists === true from here
  // AC8/26: absent completion assertion is KEEP — idleness never reaps.
  if (status !== 'idle') {
    return { action: 'KEEP', reason: 'unasserted' };
  }

  // AC25: Helm-owned + completion assertion + live session → REAP.
  return { action: 'REAP', reason: 'asserted_complete_live' };
}
