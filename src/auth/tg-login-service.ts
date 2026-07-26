import type Database from 'better-sqlite3';
import { randomInt, randomUUID } from 'node:crypto';

export type TgLoginStatus = 'pending' | 'pass' | 'fail' | 'expired';

export interface TgLoginChallenge {
  challengeId: string;
  displayNumber: number;
  buttons: number[];
}

interface TgChallengeRow {
  id: string;
  display_number: number;
  buttons_json: string;
  status: TgLoginStatus;
  created_at: string;
  expires_at: string;
  consumed_at: string | null;
}

export class TgLoginService {
  private readonly ttlMs = 2 * 60 * 1000;

  constructor(
    private readonly db: Database.Database,
    private readonly now: () => Date = () => new Date()
  ) {}

  generateChallenge(): TgLoginChallenge {
    const displayNumber = randomInt(10, 100);
    const decoys = new Set<number>();
    while (decoys.size < 2) {
      const n = randomInt(10, 100);
      if (n !== displayNumber) decoys.add(n);
    }
    const buttons = this.shuffle([displayNumber, ...decoys]);
    const createdAt = this.now();
    const expiresAt = new Date(createdAt.getTime() + this.ttlMs);
    const challengeId = randomUUID();

    this.db.prepare(`
      INSERT INTO tg_login_challenges (id, display_number, buttons_json, status, created_at, expires_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
    `).run(challengeId, displayNumber, JSON.stringify(buttons), createdAt.toISOString(), expiresAt.toISOString());

    return { challengeId, displayNumber, buttons };
  }

  markResult(challengeId: string, result: 'pass' | 'fail'): void {
    const row = this.getRow(challengeId);
    if (!row || row.status !== 'pending' || this.isExpired(row)) {
      if (row && row.status === 'pending' && this.isExpired(row)) {
        this.markExpired(challengeId);
      }
      return;
    }
    this.db.prepare(`
      UPDATE tg_login_challenges
      SET status = ?, consumed_at = CASE WHEN ? = 'fail' THEN ? ELSE consumed_at END
      WHERE id = ? AND status = 'pending'
    `).run(result, result, this.now().toISOString(), challengeId);
  }

  getStatus(challengeId: string): TgLoginStatus {
    const row = this.getRow(challengeId);
    if (!row) return 'expired';
    if (row.status === 'pending' && this.isExpired(row)) {
      this.markExpired(challengeId);
      return 'expired';
    }
    return row.status;
  }

  consumePassForToken(challengeId: string): boolean {
    const row = this.getRow(challengeId);
    if (!row || row.status !== 'pass' || row.consumed_at || this.isExpired(row)) return false;
    const result = this.db.prepare(`
      UPDATE tg_login_challenges
      SET consumed_at = ?
      WHERE id = ? AND status = 'pass' AND consumed_at IS NULL
    `).run(this.now().toISOString(), challengeId);
    return result.changes === 1;
  }

  private getRow(challengeId: string): TgChallengeRow | undefined {
    return this.db.prepare('SELECT * FROM tg_login_challenges WHERE id = ?').get(challengeId) as TgChallengeRow | undefined;
  }

  private isExpired(row: TgChallengeRow): boolean {
    return new Date(row.expires_at).getTime() <= this.now().getTime();
  }

  private markExpired(challengeId: string): void {
    this.db.prepare(`
      UPDATE tg_login_challenges
      SET status = 'expired', consumed_at = COALESCE(consumed_at, ?)
      WHERE id = ? AND status = 'pending'
    `).run(this.now().toISOString(), challengeId);
  }

  private shuffle(values: number[]): number[] {
    const out = [...values];
    for (let i = out.length - 1; i > 0; i--) {
      const j = randomInt(0, i + 1);
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
}
