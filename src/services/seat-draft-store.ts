/**
 * Seat-scoped draft / candidate path helpers + atomic publish + blind isolation (D1/D2).
 *
 * Round-1 co-planners write only seat-private draft paths under
 * `planning-drafts/<seatId>/` (isolation unit for Landlock PATH_BENEATH);
 * the engine later promotes a signed candidate to canonical plan.md /
 * og-requirements.md (P2). This module intentionally has no canonical-path writers.
 *
 * hashDraft always recomputes from disk via readPlanRevision — never trusts a
 * callback's claimed hash (R2.7).
 *
 * R2.6: composeSeatDraftReadAllow builds the per-seat strictReadAllow list
 * (own draft dir + context inputs only); peer seat dirs are rejected
 * fail-closed (typed SEAT-DRAFT-ISOLATION) before any tmux side effect.
 * publishDraft is the engine-side (unsandboxed) rehash after commit.
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readPlanRevision, type PlanRevision } from './plan-revision.js';

/** Typed isolation failure — refuse spawn / cross-seat access fail-closed (R2.6). */
export const SEAT_DRAFT_ISOLATION = 'SEAT-DRAFT-ISOLATION' as const;

export class SeatDraftIsolationError extends Error {
  readonly code = SEAT_DRAFT_ISOLATION;
  constructor(message: string) {
    super(message);
    this.name = 'SeatDraftIsolationError';
  }
}

/**
 * Sanitize seatId for use as a single path segment (no traversal, no separators).
 * Empty / unsafe ids throw fail-closed rather than invent a fallback name.
 */
export function sanitizeSeatId(seatId: string): string {
  if (typeof seatId !== 'string' || seatId.trim() === '') {
    throw new SeatDraftIsolationError('seatId must be a non-empty string');
  }
  const t = seatId.trim();
  if (t === '.' || t === '..' || t.includes('/') || t.includes('\\') || t.includes('\0')) {
    throw new SeatDraftIsolationError(
      `seatId is not a safe path segment (got ${JSON.stringify(seatId)})`,
    );
  }
  return t;
}

/**
 * Isolation unit for a drafting seat (R2.6):
 * `<runDir>/planning-drafts/<seatId>/`
 *
 * Nested one level so Landlock PATH_BENEATH can grant ONE seat's dir without
 * granting peer seats sharing a flat runDir listing.
 */
export function seatDraftDir(runDir: string, seatId: string): string {
  return path.join(path.resolve(runDir), 'planning-drafts', sanitizeSeatId(seatId));
}

/** Seat plan draft: `<runDir>/planning-drafts/<seatId>/draft-<seatId>.md` (R2.5 name, R2.6 nest). */
export function draftPlanPath(runDir: string, seatId: string): string {
  const id = sanitizeSeatId(seatId);
  return path.join(seatDraftDir(runDir, id), `draft-${id}.md`);
}

/** Seat requirements draft: `<runDir>/planning-drafts/<seatId>/draft-<seatId>-req.md`. */
export function draftReqPath(runDir: string, seatId: string): string {
  const id = sanitizeSeatId(seatId);
  return path.join(seatDraftDir(runDir, id), `draft-${id}-req.md`);
}

/** Shared plan candidate path (proposer output; not seat-scoped). */
export function candidatePlanPath(runDir: string): string {
  return path.join(path.resolve(runDir), 'candidate-plan.md');
}

/** Shared requirements candidate path (promoted with plan in P2). */
export function candidateReqPath(runDir: string): string {
  return path.join(path.resolve(runDir), 'candidate-req.md');
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

/** True if `ancestor` is the same path as `child` or a strict parent of it. */
function pathIsAncestorOrEqual(ancestor: string, child: string): boolean {
  const a = path.resolve(ancestor);
  const c = path.resolve(child);
  if (a === c) return true;
  const rel = path.relative(a, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * True if grantPath would give read access to targetPath under Landlock PATH_BENEATH
 * (grant is target, or ancestor of target, or target is ancestor of grant — i.e. any overlap).
 */
function grantOverlapsTarget(grantPath: string, targetPath: string): boolean {
  return pathIsAncestorOrEqual(grantPath, targetPath) || pathIsAncestorOrEqual(targetPath, grantPath);
}

/**
 * Fail-closed: reject an allowlist entry that would expose any peer seat draft dir.
 * Used by composeSeatDraftReadAllow and by callers that build allowlists ad-hoc.
 */
export function assertNoPeerDraftAccess(
  allowPaths: string[],
  runDir: string,
  seatId: string,
  peerSeatIds: string[],
): void {
  const ownId = sanitizeSeatId(seatId);
  const peers = peerSeatIds.map((p) => sanitizeSeatId(p)).filter((p) => p !== ownId);
  const peerDirs = peers.map((p) => seatDraftDir(runDir, p));
  // Also treat the shared planning-drafts parent as a widening hazard when peers exist.
  const draftsRoot = path.join(path.resolve(runDir), 'planning-drafts');
  const runResolved = path.resolve(runDir);

  for (const raw of allowPaths) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new SeatDraftIsolationError(
        `${SEAT_DRAFT_ISOLATION}: allowlist entries must be non-empty absolute paths`,
      );
    }
    const grant = path.resolve(raw.trim());
    for (const peerDir of peerDirs) {
      if (grantOverlapsTarget(grant, peerDir)) {
        throw new SeatDraftIsolationError(
          `${SEAT_DRAFT_ISOLATION}: allowlist entry '${grant}' overlaps peer seat draft dir '${peerDir}' ` +
            `(seat '${ownId}' must not read/list peer drafts during blind round-1)`,
        );
      }
    }
    // Widening: granting runDir or planning-drafts/ would cover every peer dir via PATH_BENEATH.
    if (peers.length > 0) {
      if (grant === runResolved || grant === draftsRoot || pathIsAncestorOrEqual(grant, draftsRoot)) {
        // Only flag if the grant is runDir / draftsRoot / ancestor — not own nested dir under draftsRoot.
        if (grant === runResolved || grant === draftsRoot || !pathIsAncestorOrEqual(draftsRoot, grant)) {
          throw new SeatDraftIsolationError(
            `${SEAT_DRAFT_ISOLATION}: allowlist entry '${grant}' widens past seat-private draft dir ` +
              `(would expose peer seats under ${draftsRoot})`,
          );
        }
      }
    }
  }
}

export interface ComposeSeatDraftReadAllowOpts {
  runDir: string;
  seatId: string;
  /** Other co-drafting seats whose dirs must stay outside this seat's fence. */
  peerSeatIds: string[];
  /** Read-only context inputs (north-star.md, conversation-log.md, decisions/, …). Absolute paths. */
  contextInputs?: string[];
  /** Optional deployment-level system paths (/usr, /etc, …) merged in. */
  deploymentAllow?: string[];
}

/**
 * Compose the strict read allowlist for a round-1 drafting seat (R2.6).
 *
 * Includes: own seat draft dir + context inputs + optional deployment allow.
 * Never includes peer seat draft dirs. Overlap/widen → typed SEAT-DRAFT-ISOLATION
 * BEFORE any tmux side effect (call this, then pass result as strictReadAllow).
 *
 * The returned array is validated for absolute paths / no ':' (via makeStrictReadProfileEnv
 * contract shape) so RealTransport.spawn can compose the env fail-closed.
 */
export function composeSeatDraftReadAllow(opts: ComposeSeatDraftReadAllowOpts): string[] {
  const ownId = sanitizeSeatId(opts.seatId);
  const ownDir = seatDraftDir(opts.runDir, ownId);
  const context = (opts.contextInputs ?? []).map((p) => {
    if (typeof p !== 'string' || p.trim() === '') {
      throw new SeatDraftIsolationError(
        `${SEAT_DRAFT_ISOLATION}: contextInputs entries must be non-empty strings`,
      );
    }
    const t = p.trim();
    if (!path.isAbsolute(t)) {
      throw new SeatDraftIsolationError(
        `${SEAT_DRAFT_ISOLATION}: contextInputs must be absolute paths (got '${p}')`,
      );
    }
    return path.resolve(t);
  });
  const deployment = (opts.deploymentAllow ?? []).map((p) => {
    if (typeof p !== 'string' || p.trim() === '') {
      throw new SeatDraftIsolationError(
        `${SEAT_DRAFT_ISOLATION}: deploymentAllow entries must be non-empty strings`,
      );
    }
    const t = p.trim();
    if (!path.isAbsolute(t)) {
      throw new SeatDraftIsolationError(
        `${SEAT_DRAFT_ISOLATION}: deploymentAllow must be absolute paths (got '${p}')`,
      );
    }
    return path.resolve(t);
  });

  // Deduplicate while preserving order: own dir first, then context, then deployment.
  const seen = new Set<string>();
  const allow: string[] = [];
  for (const p of [ownDir, ...context, ...deployment]) {
    if (seen.has(p)) continue;
    seen.add(p);
    allow.push(p);
  }

  assertNoPeerDraftAccess(allow, opts.runDir, ownId, opts.peerSeatIds ?? []);

  // Fail-closed content shape matching makeStrictReadProfileEnv (absolute, no ':', no controls).
  for (const p of allow) {
    if (p.includes(':')) {
      throw new SeatDraftIsolationError(
        `${SEAT_DRAFT_ISOLATION}: ':' is the HELM_SANDBOX_RO_ALLOW separator and cannot appear in an entry (got '${p}')`,
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(p)) {
      throw new SeatDraftIsolationError(
        `${SEAT_DRAFT_ISOLATION}: control characters are not allowed in an allowlist entry`,
      );
    }
  }

  if (allow.length === 0) {
    throw new SeatDraftIsolationError(
      `${SEAT_DRAFT_ISOLATION}: composed allowlist is empty (refusing read-all fallback)`,
    );
  }

  return allow;
}

export interface PublishedDraft {
  seatId: string;
  planPath: string;
  reqPath: string;
  plan: PlanRevision | null;
  req: PlanRevision | null;
}

/**
 * Engine-side (outside any seat sandbox) publication rehash after a seat commits
 * its round-1 drafts (R2.6 / R2.7). Never trusts a callback-claimed hash — always
 * re-reads disk via hashDraft/readPlanRevision.
 *
 * Does not move bytes; atomicWriteFile is the seat-side commit. This is the
 * engine's authoritative read of both plan + req drafts for a seat.
 */
export function publishDraft(runDir: string, seatId: string): PublishedDraft {
  const id = sanitizeSeatId(seatId);
  const planPath = draftPlanPath(runDir, id);
  const reqPath = draftReqPath(runDir, id);
  return {
    seatId: id,
    planPath,
    reqPath,
    plan: hashDraft(planPath),
    req: hashDraft(reqPath),
  };
}
