/**
 * Pure plan.md revision hashing (B1 / AC6 foundation).
 *
 * Agreement must bind partner verdicts to the exact plan.md bytes reviewed.
 * This module is intentionally pure and has no production importers yet —
 * later slices (B2 brief, B3 grammar, B5 gate) consume { sha256, short12 }.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

/** Full SHA-256 hex of plan bytes + first-12 short form used in callback grammar. */
export interface PlanRevision {
  /** Full lowercase hex SHA-256 (64 chars). */
  sha256: string;
  /** First 12 hex chars of sha256 — used as plan=<short12> in verdict lines. */
  short12: string;
}

/**
 * Hash exact plan bytes (or utf8 string) into a revision.
 * Deterministic: same bytes → same { sha256, short12 }.
 */
export function planRevision(bytes: Buffer | string): PlanRevision {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    sha256,
    short12: sha256.slice(0, 12),
  };
}

/**
 * Read plan.md (or any path) from disk and return its revision.
 * Returns null when the path is absent or unreadable — never throws.
 */
export function readPlanRevision(planPath: string): PlanRevision | null {
  try {
    const bytes = fs.readFileSync(planPath);
    return planRevision(bytes);
  } catch {
    return null;
  }
}
