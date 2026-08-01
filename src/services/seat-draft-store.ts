/**
 * Seat-scoped draft / candidate path helpers + atomic publish (D1 / R2.5, R2.7).
 *
 * Round-1 co-planners write only seat-private draft paths; the engine later
 * promotes a signed candidate to canonical plan.md / og-requirements.md (P2).
 * This module intentionally has no canonical-path writers.
 *
 * hashDraft always recomputes from disk via readPlanRevision — never trusts a
 * callback's claimed hash (R2.7).
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readPlanRevision, type PlanRevision } from './plan-revision.js';

/** Seat plan draft: `<runDir>/draft-<seatId>.md` (R2.5). */
export function draftPlanPath(runDir: string, seatId: string): string {
  return path.join(runDir, `draft-${seatId}.md`);
}

/** Seat requirements draft: `<runDir>/draft-<seatId>-req.md` (R2.5). */
export function draftReqPath(runDir: string, seatId: string): string {
  return path.join(runDir, `draft-${seatId}-req.md`);
}

/** Shared plan candidate path (proposer output; not seat-scoped). */
export function candidatePlanPath(runDir: string): string {
  return path.join(runDir, 'candidate-plan.md');
}

/** Shared requirements candidate path (promoted with plan in P2). */
export function candidateReqPath(runDir: string): string {
  return path.join(runDir, 'candidate-req.md');
}

/**
 * Atomic publish: write a temp sibling in the same directory, then rename
 * into place (R2.7). Parent directories are created if missing.
 */
export function atomicWriteFile(filePath: string, bytes: Buffer | string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  const base = path.basename(filePath);
  const tmpName = `.${base}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  try {
    fs.writeFileSync(tmpPath, bytes);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      /* best-effort cleanup of orphaned temp */
    }
    throw err;
  }
}

/**
 * Engine-side rehash of a committed draft/candidate path.
 * Delegates to readPlanRevision — returns null if absent/unreadable.
 * Callers must not treat a callback-claimed hash as authoritative.
 */
export function hashDraft(draftPath: string): PlanRevision | null {
  return readPlanRevision(draftPath);
}
