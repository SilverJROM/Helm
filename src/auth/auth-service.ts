import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
import { createHash, randomBytes } from 'node:crypto';

export interface SessionUser {
  id: number;
  telegramId: number;
  username: string | null;
  displayName: string | null;
  role: 'owner' | 'viewer';
}

export class AuthService {
  private readonly masterChatSecret: string;

  constructor(
    private readonly helmJwtSecret: string,
    private readonly agjDb?: Database.Database,
    masterChatSecret?: string,
    private readonly agjJwtSecret?: string
  ) {
    // HIGH red-team: separate in-memory secret for master-chat tokens (generated at boot in index.ts or here as fallback).
    // NEVER the jwtSecret (which lives in .env and is readable via C3 fence by masters). Boot-gen + re-issue at launch (H13) is sufficient.
    this.masterChatSecret = masterChatSecret || randomBytes(32).toString('hex');
  }

  verifyToken(token: string): SessionUser | null {
    if (!this.agjDb) {
      return this.verifyThinConstructionToken(token);
    }

    const helmPayload = this.verifyHelmToken(token);
    if (helmPayload) {
      return this.resolveActiveUser(helmPayload.sub);
    }

    const agjPayload = this.verifyAgjToken(token);
    if (!agjPayload || !this.hasActiveAgjSession(token, agjPayload)) {
      return null;
    }
    return this.resolveActiveUser(agjPayload.sub);
  }

  resolveActiveOwner(): SessionUser | null {
    if (!this.agjDb) return null;
    try {
      const rows = this.agjDb.prepare(
        "SELECT id, telegram_id, username, display_name, role FROM users WHERE role = 'owner' AND active = 1 ORDER BY id LIMIT 2"
      ).all() as any[];
      if (rows.length !== 1) return null;
      return this.toSessionUser(rows[0]);
    } catch {
      return null;
    }
  }

  issueOwnerToken(): { token: string; user: SessionUser } {
    const user = this.resolveActiveOwner();
    if (!user) {
      throw new Error('no unique active AGJAssist owner configured');
    }
    const payload = { sub: user.id, sid: `helm-${randomBytes(16).toString('hex')}`, tid: user.telegramId };
    const token = jwt.sign(payload, this.helmJwtSecret, {
      algorithm: 'HS256',
      expiresIn: '24h',
      issuer: 'helm',
      audience: 'helm'
    });
    return { token, user };
  }

  private verifyHelmToken(token: string): { sub: number; sid: string; tid: number } | null {
    try {
      const payload = jwt.verify(token, this.helmJwtSecret, {
        algorithms: ['HS256'],
        issuer: 'helm',
        audience: 'helm'
      }) as unknown as { sub: number; sid: string; tid: number };
      return this.isValidHumanPayload(payload) && payload.sid.startsWith('helm-') ? payload : null;
    } catch {
      return null;
    }
  }

  private verifyAgjToken(token: string): { sub: number; sid: string; tid: number } | null {
    if (!this.agjJwtSecret) return null;
    try {
      const payload = jwt.verify(token, this.agjJwtSecret, {
        algorithms: ['HS256']
      }) as unknown as { sub: number; sid: string; tid: number };
      return this.isValidHumanPayload(payload) ? payload : null;
    } catch {
      return null;
    }
  }

  private verifyThinConstructionToken(token: string): SessionUser | null {
    try {
      const payload = jwt.verify(token, this.helmJwtSecret, { algorithms: ['HS256'] }) as unknown as { sub: number; tid: number };
      if (!Number.isSafeInteger(payload.sub) || payload.sub <= 0) return null;
      return {
        id: payload.sub,
        telegramId: Number.isSafeInteger(payload.tid) ? payload.tid : 0,
        username: null,
        displayName: null,
        role: 'owner'
      };
    } catch {
      return null;
    }
  }

  private hasActiveAgjSession(token: string, payload: { sub: number; sid: string }): boolean {
    if (!this.agjDb) return false;
    try {
      const tokenHash = createHash('sha256').update(token).digest('hex');
      const session = this.agjDb.prepare(
        "SELECT id FROM sessions WHERE id = ? AND user_id = ? AND token_hash = ? AND datetime(expires_at) > datetime('now')"
      ).get(payload.sid, payload.sub, tokenHash);
      return !!session;
    } catch {
      return false;
    }
  }

  private resolveActiveUser(userId: number): SessionUser | null {
    if (!this.agjDb || !Number.isSafeInteger(userId) || userId <= 0) return null;
    try {
      const row = this.agjDb.prepare(
        'SELECT id, telegram_id, username, display_name, role FROM users WHERE id = ? AND active = 1'
      ).get(userId) as any;
      return row ? this.toSessionUser(row) : null;
    } catch {
      return null;
    }
  }

  private toSessionUser(row: any): SessionUser | null {
    if (!row || !Number.isSafeInteger(Number(row.id)) || !Number.isSafeInteger(Number(row.telegram_id))) return null;
    if (row.role !== 'owner' && row.role !== 'viewer') return null;
    return {
      id: Number(row.id),
      telegramId: Number(row.telegram_id),
      username: row.username ?? null,
      displayName: row.display_name ?? null,
      role: row.role
    };
  }

  private isValidHumanPayload(payload: any): payload is { sub: number; sid: string; tid: number } {
    return !!payload
      && Number.isSafeInteger(payload.sub)
      && payload.sub > 0
      && typeof payload.sid === 'string'
      && payload.sid.length > 0;
  }

  // D1: per-launch scoped JWT for master clean-chat replies. project_id claim is the ONLY source of truth for /ingest/chat-reply (security).
  // Never trust body for project_id. Short expiry; issued fresh on each launchMaster (incl. swaps/respawns).
  // Uses SEPARATE in-memory boot secret (not jwtSecret) per HIGH red-team.
  issueMasterChatToken(projectId: number): string {
    const payload = { project_id: projectId, typ: 'master-chat' };
    return jwt.sign(payload, this.masterChatSecret, { expiresIn: '6h' });
  }

  verifyMasterChatToken(token: string): { projectId: number } | null {
    try {
      const p: any = jwt.verify(token, this.masterChatSecret);
      // MED: require integer >0 to kill phantom chat-1.9 / negative / float batches
      if (p && Number.isInteger(p.project_id) && p.project_id > 0 && p.typ === 'master-chat') {
        return { projectId: p.project_id };
      }
      return null;
    } catch {
      return null;
    }
  }

  // B7 SEC1: scoped run/role/task token (reuse exact master-chat jwt + secret + claim pattern).
  // Issued per dispatch/attempt for worker callbacks/artifact updates.
  // Verify enforces typ + claims; cross-scope (wrong run/batch/role) rejected by caller (403).
  issueScopedAgentToken(claims: { projectId: number; runId: string | number; batchId: string; role: string; taskId?: number; attemptId?: number }): string {
    const payload = {
      project_id: claims.projectId,
      run_id: claims.runId,
      batch_id: claims.batchId,
      role: claims.role,
      task_id: claims.taskId ?? null,
      attempt_id: claims.attemptId ?? null,
      typ: 'agent-scoped'
    };
    return jwt.sign(payload, this.masterChatSecret, { expiresIn: '2h' });
  }

  verifyScopedAgentToken(token: string): { projectId: number; runId: string | number; batchId: string; role: string; taskId?: number | null; attemptId?: number | null } | null {
    try {
      const p: any = jwt.verify(token, this.masterChatSecret);
      if (p && p.typ === 'agent-scoped' && Number.isInteger(p.project_id) && p.project_id > 0 && p.batch_id && p.role) {
        return {
          projectId: p.project_id,
          runId: p.run_id,
          batchId: p.batch_id,
          role: p.role,
          taskId: p.task_id ?? null,
          attemptId: p.attempt_id ?? null
        };
      }
      return null;
    } catch {
      return null;
    }
  }
}
