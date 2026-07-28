/**
 * B02 C1 R3/R4 — RealTransport binds create-time SessionStatusToken to spawn lifecycle handle;
 * reap(A) after same-name B must not kill B (CAS-before-kill inside terminateSession).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  RealTransport,
  formatLifecycleHandle,
  parseLifecycleHandle,
} from './real-transport.js';
import type { SessionStatusToken } from './lifecycle-cas.js';
import { DatabaseService } from '../db/database.js';
import {
  SessionRegistryService,
  sessionStatusTokenFromRow,
} from './session-registry-service.js';
import { TmuxService } from '../tmux/tmux-service.js';

class TrackKillTmux extends TmuxService {
  kills: string[] = [];
  clearCalls: string[] = [];
  protected async killSessionRaw(sessionName: string): Promise<void> {
    this.kills.push(sessionName);
  }
  async clearContext(target: string, _provider?: string): Promise<{ issued: boolean; verified: boolean; postCapture: string }> {
    this.clearCalls.push(target);
    return { issued: true, verified: true, postCapture: '' };
  }
}

describe('B02 C1 R3/R4 RealTransport lifecycle-handle + CAS-before-kill', () => {
  let savedFake: string | undefined;

  beforeEach(() => {
    savedFake = process.env.USE_FAKE_TMUX;
    delete process.env.USE_FAKE_TMUX;
  });
  afterEach(() => {
    if (savedFake !== undefined) process.env.USE_FAKE_TMUX = savedFake;
    else delete process.env.USE_FAKE_TMUX;
  });

  it('parseLifecycleHandle strips spawnId for tmux target', () => {
    expect(parseLifecycleHandle('helm-x:0.0#abc123')).toEqual({
      sessionName: 'helm-x',
      tmuxTarget: 'helm-x:0.0',
      spawnId: 'abc123',
    });
    expect(parseLifecycleHandle('helm-x:0.0')).toEqual({
      sessionName: 'helm-x',
      tmuxTarget: 'helm-x:0.0',
      spawnId: null,
    });
  });

  it('fix1 / AC19: constructor rejects a missing tmux dep — no silent unhooked fallback', () => {
    expect(() => new RealTransport({} as any)).toThrow(/requires an explicit hooked TmuxService/);
    expect(() => new RealTransport(undefined as any)).toThrow(/requires an explicit hooked TmuxService/);
  });

  it('reap(A) after same-name B: zero kill-session, B stays active (CAS stale aborts kill)', async () => {
    const dbPath = path.join(
      os.tmpdir(),
      `helm-rt-cas-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
    );
    const db = new DatabaseService(dbPath);
    const reg = new SessionRegistryService(db);
    const tmux = new TrackKillTmux({
      onCreate: (n, opts) => {
        const row = reg.register(n, {
          owner: (opts?.owner as any) || 'helm',
        });
        return row ? sessionStatusTokenFromRow(row) : undefined;
      },
      onTerminate: (_n, token) => {
        if (!token) return false;
        return reg.markReaped(token).applied === true;
      },
      onUse: () => {},
    });

    const transport = new RealTransport({ tmux });
    const sessionName = 'helm-plancore-probe';

    const first = reg.register(sessionName, { owner: 'helm' })!;
    const tokenA = sessionStatusTokenFromRow(first);
    const second = reg.register(sessionName, { owner: 'human' })!;
    expect(second.generation).toBeGreaterThan(tokenA.generation);

    const spawnA = 'aaaaaaaa';
    const spawnB = 'bbbbbbbb';
    const lifecycles = (transport as any).lifecycles as Map<
      string,
      { sessionName: string; token?: SessionStatusToken }
    >;
    lifecycles.set(spawnA, { sessionName, token: tokenA });
    lifecycles.set(spawnB, {
      sessionName,
      token: sessionStatusTokenFromRow(second),
    });

    // Guard for B (would be wrongly stopped if A cleanup always stopped by name).
    let guardStopped = false;
    (transport as any).governedDocGuards.set(sessionName, {
      stop: () => {
        guardStopped = true;
      },
    });

    await transport.reap(formatLifecycleHandle(sessionName, spawnA), 'stale-a-cleanup');

    // CRITICAL R4: no physical kill of B's name.
    expect(tmux.kills).toEqual([]);
    expect(tmux.clearCalls).toEqual([]); // no clearContext on stale path
    expect(guardStopped).toBe(false);

    const row = reg.get(sessionName)!;
    expect(row.status).toBe('active');
    expect(row.owner).toBe('human');
    expect(row.generation).toBe(second.generation);

    expect(lifecycles.has(spawnB)).toBe(true);
    expect(lifecycles.has(spawnA)).toBe(false);

    try {
      db.close();
    } catch {}
    for (const suf of ['', '-wal', '-shm']) {
      try {
        fs.unlinkSync(dbPath + suf);
      } catch {}
    }
  });

  it('name-only handle without spawnId is kill-only (no name-map token substitution)', async () => {
    const kills: string[] = [];
    const stubTmux = {
      async terminateSession(name: string, opts?: any) {
        // kill-only path should still kill
        if (opts?.noRegistryWrite || !opts?.sessionToken) {
          kills.push(name);
          return true;
        }
        return false;
      },
      async clearContext() {},
    };
    const transport = new RealTransport({ tmux: stubTmux as any });
    const sessionName = 'helm-plancore-probe';
    const lifecycles = (transport as any).lifecycles as Map<string, any>;
    lifecycles.set('only-b', {
      sessionName,
      token: {
        id: 1,
        name: sessionName,
        owner: 'human',
        expectedStatus: 'active',
        generation: 999,
      },
    });

    await transport.reap(`${sessionName}:0.0`, 'legacy-name-only');
    expect(kills).toEqual([sessionName]);
    expect(lifecycles.has('only-b')).toBe(true);
  });
});
