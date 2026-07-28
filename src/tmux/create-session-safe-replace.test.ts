/**
 * B08 / F-03 AC9–11 — createSession fail-closed same-name replace.
 *
 * - Live human / untagged → refuse, zero kill-session
 * - Forced staged new-session failure → old live + registry preserved
 * - Eligible completed Helm (idle + @helm_child) → terminateSession CAS + one new generation
 *
 * Fake-exec only (same child_process promisify.custom mock as tmux-helm-child-tag.test.ts).
 * No live tmux. HELM_SESSION_JANITOR stays 0.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import {
  SessionRegistryService,
  sessionStatusTokenFromRow,
} from '../services/session-registry-service.js';

const cpMock = {
  calls: [] as Array<{ cmd: string; args: string[] }>,
  impl: async (_cmd: string, _args: string[]): Promise<{ stdout: string; stderr: string }> => ({
    stdout: '',
    stderr: '',
  }),
};

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  const execFile: any = (...a: any[]) => {
    const cb = a[a.length - 1];
    cpMock.impl(a[0], a[1]).then((r) => cb(null, r.stdout, r.stderr), (e: any) => cb(e));
    return {};
  };
  execFile[promisify.custom] = (cmd: string, args: string[]) => {
    cpMock.calls.push({ cmd, args });
    return cpMock.impl(cmd, args);
  };
  return { ...actual, execFile };
});

import {
  TmuxService,
  SessionNameCollisionError,
} from './tmux-service.js';

function makeTempDb(): { db: DatabaseService; cleanup: () => void } {
  const dbPath = path.join(
    os.tmpdir(),
    `helm-b08-replace-${Date.now()}-${Math.random().toString(36).slice(2)}.db`
  );
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

function killSessionCalls(): Array<{ cmd: string; args: string[] }> {
  return cpMock.calls.filter((c) => c.args[0] === 'kill-session');
}

function newSessionCalls(): Array<{ cmd: string; args: string[] }> {
  return cpMock.calls.filter((c) => c.args[0] === 'new-session');
}

function renameSessionCalls(): Array<{ cmd: string; args: string[] }> {
  return cpMock.calls.filter((c) => c.args[0] === 'rename-session');
}

/** Live session: has-session succeeds; @helm_child show-options returns tag when asked. */
function liveTaggedImpl(opts?: { failNewSession?: boolean; helmChild?: string | null }) {
  const helmChild = opts?.helmChild === undefined ? '1' : opts.helmChild;
  return async (_cmd: string, args: string[]) => {
    const sub = args[0];
    if (sub === 'has-session') {
      // Staging names are not pre-existing; final name is live until kill.
      const target = args[args.indexOf('-t') + 1];
      if (typeof target === 'string' && target.includes('-stg-')) {
        const e: any = new Error(`can't find session: ${target}`);
        e.code = 1;
        e.stderr = `can't find session: ${target}`;
        throw e;
      }
      return { stdout: '', stderr: '' };
    }
    if (sub === 'show-options' && args.includes('@helm_child')) {
      if (helmChild === null) {
        const e: any = new Error('unknown option');
        e.code = 1;
        e.stderr = 'unknown option: @helm_child';
        throw e;
      }
      return { stdout: `${helmChild}\n`, stderr: '' };
    }
    if (sub === 'new-session') {
      if (opts?.failNewSession) {
        throw new Error('forced staged new-session failure');
      }
      return { stdout: '', stderr: '' };
    }
    // set-option, kill-session, rename-session
    return { stdout: '', stderr: '' };
  };
}

describe('B08 AC9–11 createSession safe same-name replace', () => {
  let db: DatabaseService;
  let cleanup: () => void;
  let reg: SessionRegistryService;
  let tmux: TmuxService;
  let createdNames: string[];

  beforeEach(() => {
    const t = makeTempDb();
    db = t.db;
    cleanup = t.cleanup;
    reg = new SessionRegistryService(db);
    createdNames = [];
    cpMock.calls.length = 0;
    cpMock.impl = async () => ({ stdout: '', stderr: '' });

    tmux = new TmuxService({
      onCreate: (n, opts) => {
        createdNames.push(n);
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
      onLookup: (n) => reg.get(n) ?? undefined,
    });
  });

  afterEach(() => cleanup());

  it('T1a: live human collision → refused, zero kill-session, registry untouched', async () => {
    const name = 'helm-chat-b08-human';
    const row = reg.register(name, { owner: 'human', kind: 'discovery' })!;
    expect(row.status).toBe('active');
    const genBefore = row.generation;

    cpMock.impl = liveTaggedImpl();

    await expect(tmux.createSession(name, undefined, { owner: 'helm' })).rejects.toMatchObject({
      name: 'SessionNameCollisionError',
      code: 'SESSION_NAME_COLLISION',
      reason: 'human',
    });

    expect(killSessionCalls()).toEqual([]);
    expect(newSessionCalls()).toEqual([]);
    const after = reg.get(name)!;
    expect(after.owner).toBe('human');
    expect(after.status).toBe('active');
    expect(after.generation).toBe(genBefore);
    expect(createdNames).toEqual([]);
  });

  it('T1b: live untagged collision → refused, zero kill-session', async () => {
    const name = 'helm-w-b08-untagged';
    reg.register(name, { owner: 'helm', kind: 'worker' });
    // Mark idle so owner/status would otherwise be eligible — only the tag fails.
    const tok = sessionStatusTokenFromRow(reg.get(name)!);
    reg.markIdle(tok, 'done-for-test');
    expect(reg.get(name)!.status).toBe('idle');

    cpMock.impl = liveTaggedImpl({ helmChild: null });

    await expect(tmux.createSession(name, undefined, { owner: 'helm' })).rejects.toMatchObject({
      name: 'SessionNameCollisionError',
      reason: 'untagged',
    });

    expect(killSessionCalls()).toEqual([]);
    expect(newSessionCalls()).toEqual([]);
    expect(reg.get(name)!.status).toBe('idle');
    expect(createdNames).toEqual([]);
  });

  it('T1c: live active-without-completion Helm → refused (unasserted), zero kill', async () => {
    const name = 'helm-w-b08-active';
    reg.register(name, { owner: 'helm', kind: 'worker' });
    expect(reg.get(name)!.status).toBe('active');

    cpMock.impl = liveTaggedImpl();

    await expect(tmux.createSession(name, undefined, { owner: 'helm' })).rejects.toMatchObject({
      reason: 'unasserted',
    });
    expect(killSessionCalls()).toEqual([]);
    expect(reg.get(name)!.status).toBe('active');
  });

  it('T2: forced staged new-session failure → old live session + registry preserved (AC11)', async () => {
    const name = 'helm-w-b08-stagefail';
    const row = reg.register(name, { owner: 'helm', kind: 'worker' })!;
    const tok = sessionStatusTokenFromRow(row);
    reg.markIdle(tok, 'completed');
    const before = reg.get(name)!;
    expect(before.status).toBe('idle');
    const genBefore = before.generation;
    const idBefore = before.id;

    cpMock.impl = liveTaggedImpl({ failNewSession: true });

    await expect(tmux.createSession(name, '/tmp', { owner: 'helm' })).rejects.toThrow(
      /forced staged new-session failure/
    );

    // AC11 structural: staging failed BEFORE terminate — zero kill of the final name.
    const killsOfFinal = killSessionCalls().filter((c) => {
      const ti = c.args.indexOf('-t');
      return ti >= 0 && c.args[ti + 1] === name;
    });
    expect(killsOfFinal).toEqual([]);
    expect(killSessionCalls()).toEqual([]);

    const after = reg.get(name)!;
    expect(after.id).toBe(idBefore);
    expect(after.status).toBe('idle');
    expect(after.generation).toBe(genBefore);
    expect(after.owner).toBe('helm');
    // onCreate must not have published a replacement under the final name.
    expect(createdNames).toEqual([]);
  });

  it('T3: eligible completed Helm → terminateSession CAS + rename + one new generation', async () => {
    const name = 'helm-w-b08-eligible';
    const row = reg.register(name, { owner: 'helm', kind: 'worker' })!;
    const genA = row.generation;
    const tokA = sessionStatusTokenFromRow(row);
    reg.markIdle(tokA, 'worker-done');
    expect(reg.get(name)!.status).toBe('idle');

    cpMock.impl = liveTaggedImpl();

    const tokenOut: { token?: any } = {};
    const ret = await tmux.createSession(name, '/tmp/proj', {
      owner: 'helm',
      kind: 'worker',
      projectId: 9,
      runId: 42,
      sessionTokenOut: tokenOut,
    });
    expect(ret).toBe(`${name}:0.0`);

    // Stage new-session (staging name), not a pre-kill under final name.
    const news = newSessionCalls();
    expect(news.length).toBe(1);
    expect(news[0].args).toContain('-s');
    const staged = news[0].args[news[0].args.indexOf('-s') + 1];
    expect(staged).toMatch(new RegExp(`^${name}-stg-`));
    expect(staged).not.toBe(name);

    // AC10: kill goes through terminateSession → kill-session of the FINAL old name (not pre-create raw kill).
    const kills = killSessionCalls();
    expect(kills.length).toBeGreaterThanOrEqual(1);
    const killTargets = kills.map((c) => c.args[c.args.indexOf('-t') + 1]);
    expect(killTargets).toContain(name);

    // rename staging → final
    const renames = renameSessionCalls();
    expect(renames.length).toBe(1);
    expect(renames[0].args).toEqual(['rename-session', '-t', staged, name]);

    // Registry: old reaped semantics then re-register under final name with new generation.
    const after = reg.get(name)!;
    expect(after.status).toBe('active');
    expect(after.owner).toBe('helm');
    expect(after.generation).toBeGreaterThan(genA);
    expect(after.project_id).toBe(9);
    expect(after.run_id).toBe(42);
    expect(createdNames).toEqual([name]); // published under FINAL name only
    expect(tokenOut.token?.generation).toBe(after.generation);
    expect(tokenOut.token?.name).toBe(name);
  });

  it('provably-absent session still creates under final name (no kill, no staging)', async () => {
    const name = 'helm-w-b08-fresh';
    cpMock.impl = async (_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') {
        const e: any = new Error(`can't find session: ${args[2]}`);
        e.code = 1;
        e.stderr = `can't find session: ${args[2]}`;
        throw e;
      }
      return { stdout: '', stderr: '' };
    };

    await expect(tmux.createSession(name, undefined, { owner: 'helm' })).resolves.toBe(`${name}:0.0`);
    const news = newSessionCalls();
    expect(news.length).toBe(1);
    expect(news[0].args[news[0].args.indexOf('-s') + 1]).toBe(name);
    expect(killSessionCalls()).toEqual([]);
    expect(renameSessionCalls()).toEqual([]);
    expect(reg.get(name)?.status).toBe('active');
  });

  it('existence unknown (tri-state null) refuses with zero kill', async () => {
    const name = 'helm-w-b08-unknown';
    reg.register(name, { owner: 'helm' });
    cpMock.impl = async () => {
      const e: any = new Error('Command failed: tmux has-session');
      e.code = 1;
      e.stderr = 'error connecting (Permission denied)';
      throw e;
    };

    await expect(tmux.createSession(name, undefined, { owner: 'helm' })).rejects.toBeInstanceOf(
      SessionNameCollisionError
    );
    await expect(tmux.createSession(name, undefined, { owner: 'helm' })).rejects.toMatchObject({
      reason: 'exists_unknown',
    });
    // Clear double-call bookkeeping: both should have zero kills.
    expect(killSessionCalls()).toEqual([]);
  });
});
