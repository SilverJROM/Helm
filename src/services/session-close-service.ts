// S14a — targeted human manual close (AC9/10/11 replacement mechanism).
// owner='human' only. Pre-terminate recheck AFTER @helm_child await, immediately before claim/terminate.
// V2: atomic tryClaimHumanClose so concurrent closes yield exactly one terminate.
// HARD SAFETY: callers must inject fake tmux in tests; never target live sessions from tests.

import type { SessionRegistryService } from './session-registry-service.js';

/** Minimal tmux surface used by human close (inject fake in tests). */
export interface SessionCloseTmux {
  terminateSession(name: string): Promise<void>;
  sessionHasHelmChildTag(name: string): Promise<boolean>;
}

export type SessionCloseRefuseReason =
  | 'invalid_name'
  | 'non_helm_name'
  | 'missing'
  | 'not_human'
  | 'tag_failed';

export type SessionCloseResult =
  | { ok: true; closed: string; alreadyReaped?: boolean }
  | { ok: false; reason: SessionCloseRefuseReason; error: string };

const VALID_NAME = /^[a-zA-Z0-9_.-]+$/;

function isValidSessionName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && VALID_NAME.test(name);
}

/**
 * Close a human-owned Helm session: targeted terminate + idempotent registry converge.
 * Refuse helm/legacy/null/missing/tag-failed/non-helm/invalid. Already-reaped is idempotent success.
 *
 * Concurrency: per-name in-flight map + atomic tryClaimHumanClose so two concurrent callers
 * produce exactly one terminate.
 */
export class SessionCloseService {
  /** In-flight closes keyed by session name (serialize concurrent double-close). */
  private readonly inFlight = new Map<string, Promise<SessionCloseResult>>();

  constructor(
    private readonly registry: SessionRegistryService,
    private readonly tmux: SessionCloseTmux
  ) {}

  async closeHumanSession(rawName: string): Promise<SessionCloseResult> {
    const name = typeof rawName === 'string' ? rawName.trim() : '';

    if (!isValidSessionName(name)) {
      return { ok: false, reason: 'invalid_name', error: 'invalid session name' };
    }
    if (!name.startsWith('helm-')) {
      return { ok: false, reason: 'non_helm_name', error: 'session name must start with helm-' };
    }

    const existing = this.inFlight.get(name);
    if (existing) return existing;

    const run = this.closeHumanSessionOnce(name).finally(() => {
      this.inFlight.delete(name);
    });
    this.inFlight.set(name, run);
    return run;
  }

  private async closeHumanSessionOnce(name: string): Promise<SessionCloseResult> {
    const row = this.registry.get(name);
    if (!row) {
      return { ok: false, reason: 'missing', error: 'session not found in registry' };
    }
    if (row.owner !== 'human') {
      return {
        ok: false,
        reason: 'not_human',
        error: `only human-owned sessions may be closed manually (owner=${row.owner ?? 'null'})`,
      };
    }

    // Idempotent: already closed → success with zero terminate.
    if (row.status === 'reaped') {
      return { ok: true, closed: name, alreadyReaped: true };
    }

    // Tag probe is the await window (real tmux show-options). Fail-safe on error.
    let helmTagged = false;
    try {
      helmTagged = await this.tmux.sessionHasHelmChildTag(name);
    } catch (err) {
      helmTagged = false;
      console.warn('[session-close] @helm_child probe failed → treating as NOT-Helm (fail-safe)', {
        name,
        err: String(err),
      });
    }
    if (!helmTagged) {
      return {
        ok: false,
        reason: 'tag_failed',
        error: 'session missing positive @helm_child tag; refuse close',
      };
    }

    // V1: re-check registry AFTER tag await, immediately before claim/terminate.
    // Re-assert present + helm- prefix + owner=human + not reaped.
    const fresh = this.registry.get(name);
    if (!fresh) {
      return { ok: false, reason: 'missing', error: 'session not found in registry' };
    }
    if (!String(fresh.name).startsWith('helm-')) {
      return { ok: false, reason: 'non_helm_name', error: 'session name must start with helm-' };
    }
    if (fresh.owner !== 'human') {
      return {
        ok: false,
        reason: 'not_human',
        error: `only human-owned sessions may be closed manually (owner=${fresh.owner ?? 'null'})`,
      };
    }
    if (fresh.status === 'reaped') {
      return { ok: true, closed: name, alreadyReaped: true };
    }

    // V2: atomic claim — only one concurrent closer wins; losers re-read.
    const claimed = this.registry.tryClaimHumanClose(name, 'human-close');
    if (!claimed) {
      const after = this.registry.get(name);
      if (after?.status === 'reaped') {
        return { ok: true, closed: name, alreadyReaped: true };
      }
      if (!after) {
        return { ok: false, reason: 'missing', error: 'session not found in registry' };
      }
      if (after.owner !== 'human') {
        return {
          ok: false,
          reason: 'not_human',
          error: `only human-owned sessions may be closed manually (owner=${after.owner ?? 'null'})`,
        };
      }
      // Unexpected active human without claim — fail closed without terminate.
      return {
        ok: false,
        reason: 'not_human',
        error: 'close claim lost; refuse terminate',
      };
    }

    // Claim won: targeted terminate (fake tmux in tests). Best-effort — row already converged.
    try {
      await this.tmux.terminateSession(name);
    } catch (err) {
      console.warn('[session-close] terminateSession failed after claim (registry already reaped)', {
        name,
        err: String(err),
      });
    }
    return { ok: true, closed: name };
  }
}

/** Project GET /api/sessions rows with owner + status for the S14a surface. */
export function projectSessionListRow(s: {
  name: string;
  kind: string | null;
  status: string;
  owner: string | null;
  project_id: number | null;
  run_id: number | null;
  created_at: string;
  ended_at: string | null;
}) {
  return {
    name: s.name,
    kind: s.kind,
    status: s.status,
    owner: s.owner,
    project_id: s.project_id,
    run_id: s.run_id,
    created_at: s.created_at,
    ended_at: s.ended_at,
  };
}

/** HTTP status for a refuse reason (route helper). */
export function sessionCloseHttpStatus(reason: SessionCloseRefuseReason): number {
  switch (reason) {
    case 'missing':
      return 404;
    case 'invalid_name':
    case 'non_helm_name':
      return 400;
    case 'not_human':
    case 'tag_failed':
      return 403;
    default:
      return 403;
  }
}
