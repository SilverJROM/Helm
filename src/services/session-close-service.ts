// S14a — targeted human manual close (AC9/10/11 replacement mechanism).
// owner='human' only. Pre-terminate recheck: registry row + helm- prefix + @helm_child.
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
 */
export class SessionCloseService {
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

    // Immediate pre-terminate recheck (TOCTOU belt).
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

    let helmTagged = false;
    try {
      helmTagged = await this.tmux.sessionHasHelmChildTag(name);
    } catch {
      helmTagged = false;
    }
    if (!helmTagged) {
      return {
        ok: false,
        reason: 'tag_failed',
        error: 'session missing positive @helm_child tag; refuse close',
      };
    }

    // Targeted terminate (fake tmux only in tests). Then converge registry.
    await this.tmux.terminateSession(name);
    try {
      this.registry.markReaped(name, 'human-close');
    } catch {
      /* best-effort; real TmuxService may also fire onTerminate → markReaped */
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
