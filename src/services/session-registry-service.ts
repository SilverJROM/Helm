import type { DatabaseService } from '../db/database.js';

// SL-R1/R2 (session-lifecycle): registry of EVERY tmux session Helm creates.
// Wired into the single TmuxService.createSession/terminateSession choke point (see src/index.ts),
// so a new session-creation path is captured automatically without instrumenting each caller.
// The janitor (SL-R3, WorkerService) reads this table and reaps done/orphan sessions under the
// SL-R4 guardrails (registry-only + helm- prefix + never an active run).

export type HelmSessionStatus = 'active' | 'idle' | 'reaped';

export interface HelmSessionRow {
  id: number;
  name: string;
  kind: string | null;
  project_id: number | null;
  run_id: number | null;
  status: HelmSessionStatus;
  created_at: string;
  last_used_at: string | null;
  ended_at: string | null;
  reason: string | null;
}

export interface RegisterOpts {
  kind?: string;
  projectId?: number | null;
  runId?: number | null;
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
  if (/^helm-.*-test(-|$)/.test(n) || /-test$/.test(n) && n.startsWith('helm-')) return 'test';
  // helm-<batch>-<role>-<suffix>: role is the segment after the batch id.
  // batch ids can themselves contain a dash (e.g. batch-A1), so match the KNOWN roles.
  const roleMatch = n.match(/^helm-.*?-(implementer|validator|plancore|ibrain|discovery|planner|red-team|deliberation|coord|panelist|routine-implementer|w)-/);
  if (roleMatch) return roleMatch[1] === 'w' ? 'worker' : roleMatch[1];
  // helm-w-<slug>-<id> (WorkerService) — worker sessions.
  if (/^helm-w-/.test(n)) return 'worker';
  return 'other';
}

export class SessionRegistryService {
  constructor(private readonly db: DatabaseService) {}

  /** SL-R1: upsert an active row for a session on create (last-wins on name). */
  register(name: string, opts: RegisterOpts = {}): void {
    if (!name) return;
    const kind = opts.kind ?? deriveSessionKind(name);
    const projectId = opts.projectId ?? null;
    const runId = opts.runId ?? null;
    // Upsert: a re-created session name resets to active + refreshes context/created_at.
    this.db.prepare(`
INSERT INTO helm_sessions (name, kind, project_id, run_id, status, created_at, last_used_at, ended_at, reason)
VALUES (?, ?, ?, ?, 'active', datetime('now'), datetime('now'), NULL, NULL)
ON CONFLICT(name) DO UPDATE SET
  kind = COALESCE(excluded.kind, helm_sessions.kind),
  project_id = COALESCE(excluded.project_id, helm_sessions.project_id),
  run_id = COALESCE(excluded.run_id, helm_sessions.run_id),
  status = 'active',
  created_at = datetime('now'),
  last_used_at = datetime('now'),
  ended_at = NULL,
  reason = NULL
`).run(name, kind, projectId, runId);
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

  /** SL-R2: work done, awaiting cleanup (janitor's target). No-op if row absent. */
  markIdle(name: string, reason?: string): void {
    if (!name) return;
    this.db.prepare(`
UPDATE helm_sessions SET status = 'idle', last_used_at = datetime('now'), reason = ?
WHERE name = ? AND status != 'reaped'
`).run(reason ?? null, name);
  }

  /** SL-R2: session terminated/closed. Sets ended_at. No-op if row absent. */
  markReaped(name: string, reason?: string): void {
    if (!name) return;
    this.db.prepare(`
UPDATE helm_sessions SET status = 'reaped', ended_at = datetime('now'), reason = COALESCE(?, reason)
WHERE name = ?
`).run(reason ?? null, name);
  }

  /** SL-R2: enrich a row with late-known context (run_id/project_id/kind). Only fills nulls / overrides given. */
  enrich(name: string, opts: RegisterOpts = {}): void {
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

  get(name: string): HelmSessionRow | undefined {
    return this.db.prepare(`SELECT * FROM helm_sessions WHERE name = ?`).get(name) as HelmSessionRow | undefined;
  }
}
