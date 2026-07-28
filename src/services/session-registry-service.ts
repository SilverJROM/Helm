import type { DatabaseService } from '../db/database.js';
import {
  allocateLifecycleGeneration,
  sessionStatusTokenFromRow,
  type SessionStatusCasResult,
  type SessionStatusToken,
} from './lifecycle-cas.js';

export type { SessionStatusCasResult, SessionStatusToken };
export { sessionStatusTokenFromRow };

// SL-R1/R2 (session-lifecycle): registry of EVERY tmux session Helm creates.
// Wired into the single TmuxService.createSession/terminateSession choke point (see src/index.ts),
// so a new session-creation path is captured automatically without instrumenting each caller.
// The janitor (SL-R3, WorkerService) reads this table and reaps done/orphan sessions under the
// SL-R4 guardrails (registry-only + helm- prefix + never an active run).

export type HelmSessionStatus = 'active' | 'idle' | 'reaped';

/** S04 / AC1: binary decision authority + closed legacy sentinel. Stored on helm_sessions.owner. */
export type SessionOwner = 'helm' | 'human' | 'legacy:unknown';

export interface HelmSessionRow {
  id: number;
  name: string;
  kind: string | null;
  project_id: number | null;
  run_id: number | null;
  /** S07 backfills pre-existing nulls; new registers must pass owner (S05 refuses create without it). */
  owner: SessionOwner | null;
  status: HelmSessionStatus;
  /** B01 / D01 / AC4: lifecycle nonce, allocated fresh on every insert and every upsert-conflict. */
  generation: number;
  created_at: string;
  last_used_at: string | null;
  ended_at: string | null;
  reason: string | null;
}

export interface RegisterOpts {
  /**
   * S04: storage contract. S05: required for direct register() — throw if missing/invalid.
   * Create paths already refuse pre-spawn in TmuxService.createSession (F2).
   */
  owner: SessionOwner;
  kind?: string;
  projectId?: number | null;
  runId?: number | null;
}

/** Late context fill — owner is set at register/create, not via enrich. */
export interface EnrichOpts {
  kind?: string;
  projectId?: number | null;
  runId?: number | null;
}

const VALID_OWNERS = new Set<SessionOwner>(['helm', 'human', 'legacy:unknown']);

function assertRegisterOwner(owner: unknown): asserts owner is SessionOwner {
  if (typeof owner !== 'string' || !VALID_OWNERS.has(owner as SessionOwner)) {
    throw new Error(
      `session owner required (helm|human|legacy:unknown); got ${owner === undefined || owner === null ? String(owner) : JSON.stringify(owner)}`
    );
  }
}

/**
 * Derive a session's kind from its name (SL-R1).
 * - helm-<batch>-<role>-*  → the role segment (implementer/validator/…)
 * - helm-plancore-* / helm-ibrain-* / helm-discovery-* → their canonical role
 * - helm-*-test            → 'test'
 * - anything else          → 'other'
 * Precedence: canonical phase-brain names plus -test are recognized before the generic batch-role parse.
 */
export function deriveSessionKind(name: string): string {
  const n = (name ?? '').trim();
  if (/^helm-plancore-/.test(n)) return 'plancore';
  if (/^helm-ibrain-/.test(n)) return 'ibrain';
  if (/^helm-discovery-/.test(n)) return 'discovery';
  if (/^helm-preflight-/.test(n)) return 'preflight';
  if (/^helm-.*-test(-|$)/.test(n) || /-test$/.test(n) && n.startsWith('helm-')) return 'test';
  // helm-<batch>-<role>-<suffix>: role is the segment after the batch id.
  // batch ids can themselves contain a dash (e.g. batch-A1), so match the KNOWN roles.
  const roleMatch = n.match(/^helm-.*?-(implementer|validator|plancore|ibrain|discovery|planner|red-team|deliberation|coord|panelist|routine-implementer|w)-/);
  if (roleMatch) return roleMatch[1] === 'w' ? 'worker' : roleMatch[1];
  // helm-w-<slug>-<id> (WorkerService) — worker sessions.
  if (/^helm-w-/.test(n)) return 'worker';
  return 'other';
}

/** Proven Helm seat kinds (S05 create paths + derived agent roles). Fail-safe: not in set ⇒ not helm via kind alone. */
const PROVEN_HELM_KINDS = new Set<string>([
  'plancore',
  'ibrain',
  'preflight',
  'implementer',
  'validator',
  'planner',
  'red-team',
  'deliberation',
  'coord',
  'panelist',
  'worker',
  'test',
  'routine-implementer',
]);

/**
 * S07 / AC5: fail-safe owner from name + optional kind context.
 * Only proven human or helm shapes get binary authority; every remainder is the closed
 * legacy sentinel `legacy:unknown` (never reaped by automatic paths — excluded at the query).
 * Prefer under-attribution: ambiguous names never become helm.
 */
export function deriveSessionOwner(name: string, kind?: string | null): SessionOwner {
  const n = (name ?? '').trim();
  const k = (kind ?? '').trim() || null;

  // Human first — chat/discovery seats must never be over-attributed as helm.
  if (/^helm-discovery-/.test(n) || /^helm-chat-/.test(n)) return 'human';
  if (k === 'discovery') return 'human';

  // Proven helm by name shape (mirrors S05 product create paths + deriveSessionKind agent seats).
  if (/^helm-plancore-/.test(n)) return 'helm';
  if (/^helm-ibrain-/.test(n)) return 'helm';
  if (/^helm-preflight-/.test(n)) return 'helm';
  if (/^helm-w-/.test(n)) return 'helm';
  if (/^helm-.*-test(-|$)/.test(n) || (/-test$/.test(n) && n.startsWith('helm-'))) return 'helm';
  const roleMatch = n.match(
    /^helm-.*?-(implementer|validator|plancore|ibrain|discovery|planner|red-team|deliberation|coord|panelist|routine-implementer|w)-/
  );
  if (roleMatch) {
    if (roleMatch[1] === 'discovery') return 'human';
    return 'helm';
  }

  // Context assist: proven kind already stored + helm- prefix (never invent authority for non-helm names).
  if (n.startsWith('helm-') && k && PROVEN_HELM_KINDS.has(k)) return 'helm';

  return 'legacy:unknown';
}

export class SessionRegistryService {
  constructor(private readonly db: DatabaseService) {}

  /**
   * SL-R1: upsert an active row for a session on create (last-wins on name).
   * B01 / D01 / AC4: allocates a fresh lifecycle generation from the shared non-cascading
   * `lifecycle_seq` counter on BOTH the insert branch and the upsert-conflict branch, so a
   * re-registration of the same name is always distinguishable from the row it replaces. Returns
   * the captured row identity — callers that need a CAS token for a later mutation must read it
   * from this return value, never re-fetch it, since a re-fetch after this call could already be
   * observing a subsequent register().
   */
  register(name: string, opts: RegisterOpts): HelmSessionRow | undefined {
    if (!name) return undefined;
    // S05: defensive refuse — direct callers without owner throw. Create-path refusal is pre-spawn
    // in TmuxService.createSession (onCreate after new-session is try/caught and too late — F2).
    assertRegisterOwner(opts?.owner);
    const kind = opts.kind ?? deriveSessionKind(name);
    const projectId = opts.projectId ?? null;
    const runId = opts.runId ?? null;
    const owner = opts.owner;
    const registerTxn = this.db.transaction((): HelmSessionRow => {
      const generation = allocateLifecycleGeneration(this.db);
      // Upsert: a re-created session name resets to active + refreshes context/created_at.
      // S04: owner uses COALESCE so recreated names never silently drop decision authority.
      return this.db.prepare(`
INSERT INTO helm_sessions (name, kind, project_id, run_id, owner, status, generation, created_at, last_used_at, ended_at, reason)
VALUES (?, ?, ?, ?, ?, 'active', ?, datetime('now'), datetime('now'), NULL, NULL)
ON CONFLICT(name) DO UPDATE SET
  kind = COALESCE(excluded.kind, helm_sessions.kind),
  project_id = COALESCE(excluded.project_id, helm_sessions.project_id),
  run_id = COALESCE(excluded.run_id, helm_sessions.run_id),
  owner = COALESCE(excluded.owner, helm_sessions.owner),
  status = 'active',
  generation = excluded.generation,
  created_at = datetime('now'),
  last_used_at = datetime('now'),
  ended_at = NULL,
  reason = NULL
RETURNING *
`).get(name, kind, projectId, runId, owner, generation) as HelmSessionRow;
    });
    return registerTxn();
  }

  /**
   * SL-R2/R4: mark a session as freshly USED — refreshes last_used_at so the janitor's TTL means
   * "idle for TTL", not "alive for TTL". Fired on active input (TmuxService.sendKeys → onUse). This is
   * what keeps an actively-used standalone session (project chat / persistent phase-brain sessions, both
   * status='active' + run_id=null + no worker_runtime) from being reaped while in use. No-op if the
   * row is absent or already reaped (a reaped session is closed; never resurrect it).
   */
  touch(name: string): void {
    if (!name) return;
    this.db.prepare(`
UPDATE helm_sessions SET last_used_at = datetime('now')
WHERE name = ? AND status != 'reaped'
`).run(name);
  }

  /**
   * SL-R2 / B02 AC6: work done, awaiting cleanup (janitor's target).
   * Full CAS predicates — id, name, owner, expected status, generation. Zero rows ⇒ stale.
   * Legal source status is **active only** (C2: idle→idle same-token replay is stale).
   * Callers must not refresh a rejected token and retry.
   */
  markIdle(token: SessionStatusToken, reason?: string): SessionStatusCasResult {
    if (!token?.name) return { applied: false, stale: true };
    // C2: only active→idle is a real transition. idle/reaped tokens do not re-apply.
    if (token.expectedStatus !== 'active') return { applied: false, stale: true };
    const info = this.db.prepare(`
UPDATE helm_sessions SET status = 'idle', last_used_at = datetime('now'), reason = ?
WHERE id = ? AND name = ? AND owner = ? AND status = ? AND generation = ?
  AND status = 'active'
`).run(reason ?? null, token.id, token.name, token.owner, token.expectedStatus, token.generation);
    return Number(info.changes) === 1 ? { applied: true } : { applied: false, stale: true };
  }

  /**
   * SL-R2 / B02 AC6: session terminated/closed. Sets ended_at.
   * Identity CAS: id + name + owner + generation (replacement re-register bumps generation).
   * Status may progress active→idle within the same lifecycle before reap (create-time token
   * retained through cleanup); legal sources are active|idle only.
   * C2: reaped→reaped same-token replay is stale (no reason rewrite).
   */
  markReaped(token: SessionStatusToken, reason?: string): SessionStatusCasResult {
    if (!token?.name) return { applied: false, stale: true };
    // C2: already-reaped tokens must not re-apply or rewrite reason indefinitely.
    if (token.expectedStatus === 'reaped') return { applied: false, stale: true };
    if (token.expectedStatus !== 'active' && token.expectedStatus !== 'idle') {
      return { applied: false, stale: true };
    }
    // Same lifecycle may be active or idle at kill time; generation+id fence replacement.
    const info = this.db.prepare(`
UPDATE helm_sessions SET status = 'reaped', ended_at = datetime('now'), reason = COALESCE(?, reason)
WHERE id = ? AND name = ? AND owner = ? AND generation = ?
  AND status IN ('active', 'idle')
`).run(reason ?? null, token.id, token.name, token.owner, token.generation);
    return Number(info.changes) === 1 ? { applied: true } : { applied: false, stale: true };
  }

  /**
   * S14a / V2 + B02 AC6: atomic claim for human manual close.
   * Marks reaped only when the full captured token still matches (incl. owner=human at capture).
   * Returns true iff this caller won the claim (changes === 1). Losers must not refresh-and-retry
   * the same logical close with a freshly read token to force success.
   */
  tryClaimHumanClose(token: SessionStatusToken, reason?: string): boolean {
    if (!token?.name) return false;
    // Owner must be human at capture; still predicate on token.owner so a forged token cannot widen.
    if (token.owner !== 'human') return false;
    if (token.expectedStatus === 'reaped') return false;
    const info = this.db.prepare(`
UPDATE helm_sessions
SET status = 'reaped', ended_at = datetime('now'), reason = COALESCE(?, reason)
WHERE id = ? AND name = ? AND owner = ? AND status = ? AND generation = ?
`).run(reason ?? null, token.id, token.name, token.owner, token.expectedStatus, token.generation);
    return Number(info.changes) === 1;
  }

  /** SL-R2: enrich a row with late-known context (run_id/project_id/kind). Only fills nulls / overrides given. */
  enrich(name: string, opts: EnrichOpts = {}): void {
    if (!name) return;
    this.db.prepare(`
UPDATE helm_sessions SET
  project_id = COALESCE(?, project_id),
  run_id = COALESCE(?, run_id),
  kind = COALESCE(?, kind),
  last_used_at = datetime('now')
WHERE name = ?
`).run(opts.projectId ?? null, opts.runId ?? null, opts.kind ?? null, name);
  }

  list(): HelmSessionRow[] {
    return this.db.prepare(`SELECT * FROM helm_sessions ORDER BY id DESC`).all() as HelmSessionRow[];
  }

  /**
   * S07 / AC5: query-level Helm-owned candidate selection.
   * SQL filter only — never returns human, legacy:unknown, or null owner rows.
   * Downstream janitor/housekeeper paths must use this (or equivalent owner='helm' SQL), not JS post-filter.
   */
  listHelmOwnedCandidates(): HelmSessionRow[] {
    return this.db.prepare(
      `SELECT * FROM helm_sessions WHERE owner = 'helm' ORDER BY id DESC`
    ).all() as HelmSessionRow[];
  }

  /** S18a: investigation candidates are Helm-owned and still active at the SQL boundary. */
  listHelmOwnedActiveCandidates(): HelmSessionRow[] {
    return this.db.prepare(
      `SELECT * FROM helm_sessions WHERE owner = 'helm' AND status = 'active' ORDER BY id DESC`
    ).all() as HelmSessionRow[];
  }

  get(name: string): HelmSessionRow | undefined {
    return this.db.prepare(`SELECT * FROM helm_sessions WHERE name = ?`).get(name) as HelmSessionRow | undefined;
  }
}
