import { DatabaseService } from '../db/database.js';

export type IdentitySource = 'helm' | 'none';
export type IdentityState = 'resolved' | 'missing' | 'inactive' | 'error';

export interface HelmProjectIdentity {
  id: number;
  name: string;
  directory: string;
  directory_name: string;
  status: 'active' | 'archived';
  active: number;
}

export interface HelmUserIdentity {
  id: number;
  telegramId: number;
  username: string | null;
  displayName: string | null;
  role: 'owner' | 'viewer';
  active: number;
}

export interface ProjectIdentityResolution {
  source: IdentitySource;
  state: IdentityState;
  readiness: boolean;
  project: HelmProjectIdentity | null;
}

export interface UserIdentityResolution {
  source: IdentitySource;
  state: IdentityState;
  parity: 'not-applicable';
  readiness: boolean;
  user: HelmUserIdentity | null;
}

/**
 * The ONE native identity reader. O7.2 (RELEASE-ATOMIC native-only cutover): identity is
 * established exclusively from native Helm rows — there is no external/legacy (AGJAssist) db
 * handle and no compatibility fallback of any kind. A native active row resolves; anything
 * missing/inactive/erroring fails closed with `project: null` so every launch-path caller
 * refuses BEFORE any mutation. (The one-time pre-cutover native↔legacy parity comparison lives
 * in `OvmCutoverReadinessChecker`, a migration tool that owns its own read-only legacy handle —
 * never here in the runtime boundary.)
 */
export class HelmIdentityService {
  constructor(private readonly db: DatabaseService) {}

  resolveProject(projectId: number): ProjectIdentityResolution {
    let row: any;
    try {
      row = this.db.prepare(
        'SELECT id, name, directory, directory_name, status, active FROM projects WHERE id = ?'
      ).get(projectId);
    } catch {
      return { source: 'none', state: 'error', readiness: false, project: null };
    }

    if (!row) {
      return { source: 'none', state: 'missing', readiness: false, project: null };
    }
    if (row.status !== 'active' || Number(row.active) !== 1) {
      return { source: 'none', state: 'inactive', readiness: false, project: null };
    }

    const project: HelmProjectIdentity = {
      id: Number(row.id),
      name: String(row.name),
      directory: String(row.directory),
      directory_name: String(row.directory_name),
      status: 'active',
      active: 1,
    };

    return { source: 'helm', state: 'resolved', readiness: true, project };
  }

  resolveUser(userId: number): UserIdentityResolution {
    let row: any;
    try {
      row = this.db.prepare(
        'SELECT id, telegram_id, username, display_name, role, active FROM users WHERE id = ?'
      ).get(userId);
    } catch {
      return { source: 'none', state: 'error', parity: 'not-applicable', readiness: false, user: null };
    }

    if (!row) {
      return { source: 'none', state: 'missing', parity: 'not-applicable', readiness: false, user: null };
    }
    if (Number(row.active) !== 1) {
      return { source: 'none', state: 'inactive', parity: 'not-applicable', readiness: false, user: null };
    }

    return {
      source: 'helm',
      state: 'resolved',
      parity: 'not-applicable',
      readiness: true,
      user: {
        id: Number(row.id),
        telegramId: Number(row.telegram_id),
        username: row.username ?? null,
        displayName: row.display_name ?? null,
        role: row.role === 'owner' ? 'owner' : 'viewer',
        active: 1,
      },
    };
  }

  /**
   * O4.3 — owner identity comes from exactly one durable native row (the partial unique index
   * on `role = 'owner' AND active = 1` guarantees at most one match). Used by AuthService owner
   * issuance and the Telegram login-challenge chat destination; never a hardcoded fallback.
   */
  resolveActiveOwner(): UserIdentityResolution {
    let row: any;
    try {
      row = this.db.prepare(
        "SELECT id, telegram_id, username, display_name, role, active FROM users WHERE role = 'owner' AND active = 1 LIMIT 1"
      ).get();
    } catch {
      return { source: 'none', state: 'error', parity: 'not-applicable', readiness: false, user: null };
    }

    if (!row) {
      return { source: 'none', state: 'missing', parity: 'not-applicable', readiness: false, user: null };
    }

    return {
      source: 'helm',
      state: 'resolved',
      parity: 'not-applicable',
      readiness: true,
      user: {
        id: Number(row.id),
        telegramId: Number(row.telegram_id),
        username: row.username ?? null,
        displayName: row.display_name ?? null,
        role: 'owner',
        active: 1,
      },
    };
  }
}

/**
 * O4.1 AC3 / O7.2 — the launch routes' active-project gate. `switch-model` and
 * `launch-master` MUST NOT read any legacy db directly (a direct numeric-ID read);
 * they consult this ONE native identity boundary instead.
 * Returns the native active project (resolved purely from native rows — there is
 * no legacy db in play) or a 400-worthy rejection. Mirrors the launch-path
 * services' `!project` gate so route and service agree on identity (and, because
 * a legacy numeric id is never readable at all, can never launch an ID-collision ghost).
 */
export function requireActiveNativeProject(
  identity: HelmIdentityService,
  projectId: number
): { ok: true; project: HelmProjectIdentity } | { ok: false; error: string } {
  const resolution = identity.resolveProject(projectId);
  if (!resolution.project) {
    return { ok: false, error: 'unknown or inactive OVM project' };
  }
  return { ok: true, project: resolution.project };
}
