/**
 * B02 C1 R3 — RealTransport binds create-time SessionStatusToken to spawn lifecycle handle,
 * not session name. Same-name B must not overwrite A; reap(A) must pass token A.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  RealTransport,
  formatLifecycleHandle,
  parseLifecycleHandle,
} from './real-transport.js';
import type { SessionStatusToken } from './lifecycle-cas.js';

describe('B02 C1 R3 RealTransport lifecycle-handle token binding', () => {
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

  it('reap(A-handle) after same-name B keeps B unreaped and passes token A to terminate', async () => {
    const terminates: Array<{ name: string; opts: any }> = [];
    const stubTmux = {
      async createSession() {
        return 'unused:0.0';
      },
      async terminateSession(name: string, opts?: any) {
        terminates.push({ name, opts: opts ? JSON.parse(JSON.stringify(opts)) : opts });
      },
      async clearContext() {
        /* no-op */
      },
      async sendCommand() {
        return { message: 'ok', blocked: false };
      },
    };

    const transport = new RealTransport({ tmux: stubTmux as any });
    const sessionName = 'helm-plancore-probe';
    const tokenA: SessionStatusToken = {
      id: 10,
      name: sessionName,
      owner: 'helm',
      expectedStatus: 'active',
      generation: 101,
    };
    const tokenB: SessionStatusToken = {
      id: 10,
      name: sessionName,
      owner: 'human',
      expectedStatus: 'active',
      generation: 202,
    };
    const spawnA = 'aaaaaaaa';
    const spawnB = 'bbbbbbbb';

    // Production map is keyed by spawnId (as spawn() does) — NOT by session name.
    const lifecycles = (transport as any).lifecycles as Map<
      string,
      { sessionName: string; token?: SessionStatusToken }
    >;
    lifecycles.set(spawnA, { sessionName, token: tokenA });
    lifecycles.set(spawnB, { sessionName, token: tokenB });

    const handleA = formatLifecycleHandle(sessionName, spawnA);
    await transport.reap(handleA, 'stale-a-cleanup');

    expect(terminates).toHaveLength(1);
    expect(terminates[0].name).toBe(sessionName);
    expect(terminates[0].opts.sessionToken).toMatchObject({
      generation: 101,
      owner: 'helm',
      id: 10,
    });
    // B's lifecycle entry untouched — name-keyed map would have deleted/reaped B.
    expect(lifecycles.has(spawnB)).toBe(true);
    expect(lifecycles.get(spawnB)!.token!.generation).toBe(202);
    expect(lifecycles.has(spawnA)).toBe(false);
  });

  it('name-only handle without spawnId is kill-only (no name-map token substitution)', async () => {
    const terminates: Array<{ name: string; opts: any }> = [];
    const stubTmux = {
      async terminateSession(name: string, opts?: any) {
        terminates.push({ name, opts: opts ? JSON.parse(JSON.stringify(opts)) : opts });
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
    expect(terminates[0].opts).toEqual({ noRegistryWrite: true });
    // Must not have looked up B by name.
    expect(terminates[0].opts.sessionToken).toBeUndefined();
    expect(lifecycles.has('only-b')).toBe(true);
  });
});
