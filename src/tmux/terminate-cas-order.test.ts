/**
 * B02 C1 R4 — terminateSession must CAS-claim before kill-session.
 * Stale token after same-name re-register → zero kill-session (replacement B survives).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import {
  SessionRegistryService,
  sessionStatusTokenFromRow,
} from '../services/session-registry-service.js';
import { TmuxService } from './tmux-service.js';

class TrackKillTmux extends TmuxService {
  kills: string[] = [];
  protected async killSessionRaw(sessionName: string): Promise<void> {
    this.kills.push(sessionName);
  }
}

function makeTempDb(): { db: DatabaseService; cleanup: () => void } {
  const dbPath = path.join(os.tmpdir(), `helm-cas-order-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new DatabaseService(dbPath);
  return {
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {}
      for (const suf of ['', '-wal', '-shm']) {
        try {
          fs.unlinkSync(dbPath + suf);
        } catch {}
      }
    },
  };
}

describe('B02 C1 R4 terminateSession CAS-before-kill', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;
  let tmux: TrackKillTmux;

  beforeEach(() => {
    const t = makeTempDb();
    db = t.db;
    cleanup = t.cleanup;
    reg = new SessionRegistryService(db);
    tmux = new TrackKillTmux({
      onCreate: (n, opts) => {
        const row = reg.register(n, {
          owner: (opts?.owner as any) || 'helm',
          kind: opts?.kind,
          projectId: opts?.projectId,
          runId: opts?.runId,
        });
        return row ? sessionStatusTokenFromRow(row) : undefined;
      },
      onTerminate: (_n, token) => {
        if (!token) return false;
        return reg.markReaped(token).applied === true;
      },
      onUse: () => {},
    });
  });
  afterEach(() => cleanup());

  it('stale token after re-register → kill-session NOT issued; B stays active', async () => {
    const first = reg.register('helm-cas-order', { owner: 'helm' })!;
    const tokenA = sessionStatusTokenFromRow(first);

    // Replacement lifecycle B (same name, new generation, human).
    const second = reg.register('helm-cas-order', { owner: 'human' })!;
    expect(second.generation).toBeGreaterThan(tokenA.generation);
    expect(second.owner).toBe('human');

    const killed = await tmux.terminateSession('helm-cas-order', { sessionToken: tokenA });
    expect(killed).toBe(false);
    expect(tmux.kills).toEqual([]); // CRITICAL: no kill-session against B

    const row = reg.get('helm-cas-order')!;
    expect(row.status).toBe('active');
    expect(row.owner).toBe('human');
    expect(row.generation).toBe(second.generation);
    expect(row.reason).toBeNull();
  });

  it('current token → CAS applies then kill-session once', async () => {
    const row = reg.register('helm-cas-kill', { owner: 'helm' })!;
    const token = sessionStatusTokenFromRow(row);

    const killed = await tmux.terminateSession('helm-cas-kill', { sessionToken: token });
    expect(killed).toBe(true);
    expect(tmux.kills).toEqual(['helm-cas-kill']);
    expect(reg.get('helm-cas-kill')!.status).toBe('reaped');
  });

  it('noRegistryWrite → kill without registry claim', async () => {
    reg.register('helm-cas-killonly', { owner: 'helm' });
    const killed = await tmux.terminateSession('helm-cas-killonly', { noRegistryWrite: true });
    expect(killed).toBe(true);
    expect(tmux.kills).toEqual(['helm-cas-killonly']);
    expect(reg.get('helm-cas-killonly')!.status).toBe('active'); // registry untouched
  });
});
