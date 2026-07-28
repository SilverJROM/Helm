// ST-R1 / ST-R2 tmux-boundary tests for the @helm_child ownership tag.
//
// tmux-service.ts captures `const execFileAsync = promisify(execFile)` at import time, so a late
// vi.spyOn(child_process, 'execFile') can NOT intercept it (the promisified reference is already
// bound) — it would shell out to REAL tmux. We therefore replace the module with vi.mock and give
// the mock execFile a `util.promisify.custom` implementation (that is exactly what the real
// child_process.execFile has, and what promisify uses), routing every tmux invocation through a
// hoisted, per-test-controllable handler. Isolated to this file so no other suite is affected.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promisify } from 'node:util';

// Shared, per-test-controllable state: `impl` decides what each tmux call resolves/rejects to;
// `calls` records args. NOTE: the closures below reference `cpMock` LAZILY (only when a tmux call
// actually runs, i.e. at test time) — never at factory-eval time. This matters because ESM hoists
// the `import { TmuxService }` below above this const, so the vi.mock factory runs BEFORE this line;
// a snapshot taken inside the factory would capture `undefined`.
const cpMock = {
  calls: [] as Array<{ cmd: string; args: string[] }>,
  impl: async (_cmd: string, _args: string[]): Promise<{ stdout: string; stderr: string }> => ({ stdout: '', stderr: '' }),
};

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  // Callback-form fallback (unused by tmux-service, which goes through promisify.custom).
  const execFile: any = (...a: any[]) => {
    const cb = a[a.length - 1];
    cpMock.impl(a[0], a[1]).then((r) => cb(null, r.stdout, r.stderr), (e: any) => cb(e));
    return {};
  };
  // THIS is what promisify(execFile) actually uses (real child_process.execFile ships the same symbol,
  // which is why the promisified form resolves to { stdout, stderr }).
  execFile[promisify.custom] = (cmd: string, args: string[]) => {
    cpMock.calls.push({ cmd, args });
    return cpMock.impl(cmd, args);
  };
  return { ...actual, execFile };
});

import { TmuxService } from './tmux-service.js';

describe('ST-R1/R2 @helm_child tmux ownership tag', () => {
  beforeEach(() => {
    cpMock.calls.length = 0;
    cpMock.impl = async () => ({ stdout: '', stderr: '' });
  });

  it('ST-R1: createSession issues `set-option -t <name> @helm_child 1` right after new-session', async () => {
    // has-session must REJECT (session absent) so createSession proceeds to new-session (not the
    // idempotent kill path); every other tmux call resolves empty.
    cpMock.impl = async (_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') throw new Error('no such session');
      return { stdout: '', stderr: '' };
    };
    const tmux: any = new TmuxService();
    const ret = await tmux.createSession('helm-w-tagtest', undefined, { owner: 'helm' });
    expect(ret).toBe('helm-w-tagtest:0.0');

    const newSessionIdx = cpMock.calls.findIndex((c) => c.args[0] === 'new-session');
    const setOptIdx = cpMock.calls.findIndex(
      (c: any) => c.args[0] === 'set-option' && c.args.includes('@helm_child')
    );
    expect(newSessionIdx).toBeGreaterThanOrEqual(0);
    // The tag is set AFTER the session is created.
    expect(setOptIdx).toBeGreaterThan(newSessionIdx);
    expect(cpMock.calls[setOptIdx].args).toEqual([
      'set-option', '-t', 'helm-w-tagtest', '@helm_child', '1',
    ]);
  });

  it('ST-R1: a failing set-option is swallowed — createSession still succeeds (best-effort)', async () => {
    cpMock.impl = async (_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') throw new Error('no such session');
      if (args[0] === 'set-option') throw new Error('set-option boom');
      return { stdout: '', stderr: '' };
    };
    const tmux: any = new TmuxService();
    await expect(tmux.createSession('helm-w-tagfail', undefined, { owner: 'helm' })).resolves.toBe('helm-w-tagfail:0.0');
  });

  // A2 (R4.16) + S05: createSession forwards projectId/runId/owner into the registry onCreate choke point.
  it('A2: createSession passes projectId+runId+owner to registry onCreate', async () => {
    cpMock.impl = async (_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') throw new Error('no such session');
      return { stdout: '', stderr: '' };
    };
    const seen: Array<{ name: string; opts?: any }> = [];
    const tmux: any = new TmuxService({
      onCreate: (name: string, opts?: any) => { seen.push({ name, opts }); },
      onTerminate: () => false,
      onUse: () => {},
    });
    await tmux.createSession('helm-batch-A2-plancore-x1', '/tmp/proj', { projectId: 7, runId: 88, owner: 'helm' });
    expect(seen).toEqual([{ name: 'helm-batch-A2-plancore-x1', opts: { projectId: 7, runId: 88, owner: 'helm' } }]);
  });

  // S05 / AC2: pre-spawn owner refuse — zero tmux mutations when owner missing/invalid.
  it('S05: missing owner rejects before any tmux command', async () => {
    const tmux: any = new TmuxService();
    await expect(tmux.createSession('helm-w-no-owner')).rejects.toThrow(/owner required/);
    await expect(tmux.createSession('helm-w-no-owner2', '/tmp', {} as any)).rejects.toThrow(/owner required/);
    expect(cpMock.calls).toEqual([]);
  });

  it('S05: invalid owner rejects before any tmux command', async () => {
    const tmux: any = new TmuxService();
    await expect(tmux.createSession('helm-w-bad', undefined, { owner: 'robot' as any })).rejects.toThrow(/owner required/);
    expect(cpMock.calls).toEqual([]);
  });

  it('S05: valid helm owner reaches new-session (register still receives owner)', async () => {
    cpMock.impl = async (_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') throw new Error('no such session');
      return { stdout: '', stderr: '' };
    };
    const seen: any[] = [];
    const tmux: any = new TmuxService({
      onCreate: (name: string, opts?: any) => { seen.push({ name, opts }); },
      onTerminate: () => false,
      onUse: () => {},
    });
    await tmux.createSession('helm-w-ok', '/tmp', { owner: 'helm', kind: 'worker' });
    expect(cpMock.calls.some((c) => c.args[0] === 'new-session')).toBe(true);
    expect(seen[0]).toEqual({ name: 'helm-w-ok', opts: { owner: 'helm', kind: 'worker' } });
  });

  it('S05: valid human owner reaches new-session', async () => {
    cpMock.impl = async (_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') throw new Error('no such session');
      return { stdout: '', stderr: '' };
    };
    const tmux: any = new TmuxService();
    await expect(tmux.createSession('helm-chat-ok', undefined, { owner: 'human' })).resolves.toBe('helm-chat-ok:0.0');
    expect(cpMock.calls.some((c) => c.args[0] === 'new-session')).toBe(true);
  });

  it('ST-R2: sessionHasHelmChildTag returns true ONLY when the option is exactly "1"', async () => {
    const tmux: any = new TmuxService();
    cpMock.impl = async () => ({ stdout: '1\n', stderr: '' });
    await expect(tmux.sessionHasHelmChildTag('helm-x')).resolves.toBe(true);
    cpMock.impl = async () => ({ stdout: '0\n', stderr: '' });
    await expect(tmux.sessionHasHelmChildTag('helm-x')).resolves.toBe(false);
    cpMock.impl = async () => ({ stdout: '', stderr: '' });
    await expect(tmux.sessionHasHelmChildTag('helm-x')).resolves.toBe(false);
  });

  it('ST-R2: sessionHasHelmChildTag returns FALSE on any tmux error (fail-safe: unknown = NOT ours)', async () => {
    cpMock.impl = async () => { throw new Error('tmux: no such session'); };
    const tmux: any = new TmuxService();
    await expect(tmux.sessionHasHelmChildTag('helm-gone')).resolves.toBe(false);
  });

  it('ST-R2: sessionHasHelmChildTag issues the show-options probe against @helm_child', async () => {
    cpMock.impl = async () => ({ stdout: '1\n', stderr: '' });
    const tmux: any = new TmuxService();
    await tmux.sessionHasHelmChildTag('helm-probe');
    const probe = cpMock.calls.find((c) => c.args[0] === 'show-options');
    expect(probe).toBeTruthy();
    expect(probe!.args).toContain('@helm_child');
    expect(probe!.args).toContain('helm-probe');
  });

  it('S08: sessionActivity reads display-message session_activity and parses integer activity', async () => {
    cpMock.calls.length = 0;
    cpMock.impl = async (_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') throw new Error('no such session');
      if (args[0] === 'display-message') return { stdout: '1732713600\n', stderr: '' };
      return { stdout: '', stderr: '' };
    };
    const tmux: any = new TmuxService();
    await expect(tmux.sessionActivity('helm-activity-ok')).resolves.toBe(1732713600);
    const probe = cpMock.calls.find((c) => c.args[0] === 'display-message');
    expect(probe).toBeTruthy();
    expect(probe!.args).toEqual(['display-message', '-p', '-t', 'helm-activity-ok', '#{session_activity}']);
  });

  it('S08: sessionActivity returns null on malformed output', async () => {
    cpMock.impl = async () => ({ stdout: 'n/a', stderr: '' });
    const tmux: any = new TmuxService();
    await expect(tmux.sessionActivity('helm-activity-bad')).resolves.toBeNull();
  });

  it('S08: sessionActivity returns null when tmux has-session probe error (missing/gone)', async () => {
    cpMock.impl = async () => { throw new Error('tmux: no such session'); };
    const tmux: any = new TmuxService();
    await expect(tmux.sessionActivity('helm-missing')).resolves.toBeNull();
  });

  it('S08: sessionAttached reads display-message session_attached and parses 1/0', async () => {
    cpMock.calls.length = 0;
    cpMock.impl = async () => ({ stdout: '1\n', stderr: '' });
    const tmux: any = new TmuxService();
    await expect(tmux.sessionAttached('helm-attached-ok')).resolves.toBe(true);
    cpMock.impl = async () => ({ stdout: '0\n', stderr: '' });
    await expect(tmux.sessionAttached('helm-attached-no')).resolves.toBe(false);
    const probes = cpMock.calls.filter((c) => c.args[0] === 'display-message');
    expect(probes).toHaveLength(2);
    expect(probes.every((c) => c.args.includes('#{session_attached}'))).toBe(true);
  });
  it('S08: sessionAttached returns null on malformed output', async () => {
    cpMock.impl = async () => ({ stdout: 'true', stderr: '' });
    const tmux: any = new TmuxService();
    await expect(tmux.sessionAttached('helm-attached-bad')).resolves.toBeNull();
  });

  it('S08: sessionActivity/Attached use display-message only (no mutating tmux calls)', async () => {
    cpMock.calls.length = 0;
    cpMock.impl = async () => ({ stdout: '0\n', stderr: '' });
    const tmux: any = new TmuxService();
    await tmux.sessionActivity('helm-safe');
    await tmux.sessionAttached('helm-safe');
    expect(cpMock.calls.every((c) => c.args[0] === 'display-message')).toBe(true);
    expect(cpMock.calls.find((c) => c.args[0] === 'new-session')).toBeFalsy();
    expect(cpMock.calls.find((c) => c.args[0] === 'kill-session')).toBeFalsy();
    expect(cpMock.calls.find((c) => c.args[0] === 'send-keys')).toBeFalsy();
  });

  it('S08: invalid session name returns null before tmux call for activity/attached readers', async () => {
    const tmux: any = new TmuxService();
    await expect(tmux.sessionActivity('helm bad')).resolves.toBeNull();
    await expect(tmux.sessionAttached('helm bad')).resolves.toBeNull();
    expect(cpMock.calls).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // S12-V3 — sessionExistsTriState: only explicit gone messages → false; exit 1 alone → null
  // ---------------------------------------------------------------------------

  it('S12-V3: live has-session → true', async () => {
    cpMock.impl = async () => ({ stdout: '', stderr: '' });
    const tmux: any = new TmuxService();
    await expect(tmux.sessionExistsTriState('helm-live')).resolves.toBe(true);
  });

  it('S12-V3: explicit no such session → false (provably gone)', async () => {
    cpMock.impl = async () => {
      const e: any = new Error("can't find session: helm-gone");
      e.code = 1;
      e.stderr = "can't find session: helm-gone";
      throw e;
    };
    const tmux: any = new TmuxService();
    await expect(tmux.sessionExistsTriState('helm-gone')).resolves.toBe(false);
  });

  it('S12-V3: explicit no server running → false', async () => {
    cpMock.impl = async () => {
      const e: any = new Error('no server running on /tmp/tmux-1000/default');
      e.code = 1;
      e.stderr = 'no server running on /tmp/tmux-1000/default';
      throw e;
    };
    const tmux: any = new TmuxService();
    await expect(tmux.sessionExistsTriState('helm-noserver')).resolves.toBe(false);
  });

  it('S12-V3: generic exit code 1 without gone message → null (unknown, not false)', async () => {
    cpMock.impl = async () => {
      const e: any = new Error('Command failed: tmux has-session');
      e.code = 1;
      e.stderr = 'error connecting to /tmp/tmux-1000/default (Permission denied)';
      throw e;
    };
    const tmux: any = new TmuxService();
    await expect(tmux.sessionExistsTriState('helm-perm')).resolves.toBeNull();
  });

  it('S12-V3: bare exit 1 empty message → null (must not over-CONVERGE)', async () => {
    cpMock.impl = async () => {
      const e: any = new Error('');
      e.code = 1;
      e.stderr = '';
      throw e;
    };
    const tmux: any = new TmuxService();
    await expect(tmux.sessionExistsTriState('helm-exit1')).resolves.toBeNull();
  });

  // ---------------------------------------------------------------------------
  // S09 / AC19 — last_used_at on agent output (prior-pane-snapshot delta only)
  // ---------------------------------------------------------------------------

  it('S09: identical capture polls do not touch (no polling inflation)', async () => {
    const uses: string[] = [];
    const tmux: any = new TmuxService({
      onCreate: () => {},
      onTerminate: () => false,
      onUse: (n: string) => { uses.push(n); },
    });
    cpMock.impl = async () => ({ stdout: '❯ idle prompt\n', stderr: '' });
    await tmux.capturePane('helm-chat-s09a:0.0');
    await tmux.capturePane('helm-chat-s09a:0.0');
    await tmux.capturePane('helm-chat-s09a:0.0');
    // First capture baselines; two identical polls must not manufacture activity.
    expect(uses).toEqual([]);
  });

  it('S09: real output delta touches once; subsequent identical polls do not', async () => {
    const uses: string[] = [];
    const tmux: any = new TmuxService({
      onCreate: () => {},
      onTerminate: () => false,
      onUse: (n: string) => { uses.push(n); },
    });
    let frame = 'frame-A\n';
    cpMock.impl = async () => ({ stdout: frame, stderr: '' });
    await tmux.capturePane('helm-chat-s09b'); // baseline A → no touch
    frame = 'frame-B\n';
    await tmux.capturePane('helm-chat-s09b'); // A→B → touch once
    await tmux.capturePane('helm-chat-s09b'); // B→B → no touch
    expect(uses).toEqual(['helm-chat-s09b']);
  });

  it('S09: successive distinct outputs each touch once (A→B→C → 2 onUse)', async () => {
    const uses: string[] = [];
    const tmux: any = new TmuxService({
      onCreate: () => {},
      onTerminate: () => false,
      onUse: (n: string) => { uses.push(n); },
    });
    let frame = 'A\n';
    cpMock.impl = async () => ({ stdout: frame, stderr: '' });
    await tmux.capturePane('helm-w-s09c:0.0');
    frame = 'B\n';
    await tmux.capturePane('helm-w-s09c:0.0');
    frame = 'C\n';
    await tmux.capturePane('helm-w-s09c:0.0');
    expect(uses).toEqual(['helm-w-s09c', 'helm-w-s09c']);
  });

  it('S09: ANSI-only flicker is not treated as agent output (stripped compare)', async () => {
    const uses: string[] = [];
    const tmux: any = new TmuxService({
      onCreate: () => {},
      onTerminate: () => false,
      onUse: (n: string) => { uses.push(n); },
    });
    let frame = 'hello world\n';
    cpMock.impl = async () => ({ stdout: frame, stderr: '' });
    await tmux.capturePane('helm-chat-s09ansi');
    // Same text, different colour codes — must not touch.
    frame = '\x1b[32mhello world\x1b[0m\n';
    await tmux.capturePane('helm-chat-s09ansi');
    await tmux.capturePane('helm-chat-s09ansi');
    expect(uses).toEqual([]);
  });

  it('S09: Helm active-input still touches (send path independent of capture)', async () => {
    const uses: string[] = [];
    const tmux: any = new TmuxService({
      onCreate: () => {},
      onTerminate: () => false,
      onUse: (n: string) => { uses.push(n); },
    });
    // touchSession is what sendAndSubmit/sendCommand/sendEnter/sendKeys call.
    tmux.touchSession('helm-chat-input:0.0');
    expect(uses).toEqual(['helm-chat-input']);
  });

  it('S09: empty/failed capture does not invent activity or re-baseline', async () => {
    const uses: string[] = [];
    const tmux: any = new TmuxService({
      onCreate: () => {},
      onTerminate: () => false,
      onUse: (n: string) => { uses.push(n); },
    });
    let frame = 'stable\n';
    cpMock.impl = async () => ({ stdout: frame, stderr: '' });
    await tmux.capturePane('helm-chat-s09empty'); // baseline
    frame = 'changed\n';
    await tmux.capturePane('helm-chat-s09empty'); // delta → 1 touch
    expect(uses).toEqual(['helm-chat-s09empty']);
    // Failed capture returns "" — must not touch and must not erase prior.
    cpMock.impl = async () => { throw new Error('tmux: no such pane'); };
    await expect(tmux.capturePane('helm-chat-s09empty')).resolves.toBe('');
    expect(uses).toEqual(['helm-chat-s09empty']);
    // Same content as last good snapshot still no extra touch after failed capture.
    frame = 'changed\n';
    cpMock.impl = async () => ({ stdout: frame, stderr: '' });
    await tmux.capturePane('helm-chat-s09empty');
    expect(uses).toEqual(['helm-chat-s09empty']);
  });

  it('S09: output delta via onUse→touch does not resurrect a reaped registry row', async () => {
    // Synthetic DB only — mirrors index.ts onUse → sessionRegistry.touch wiring.
    const Database = (await import('better-sqlite3')).default;
    const { SessionRegistryService } = await import('../services/session-registry-service.js');
    const db = new Database(':memory:');
    db.exec(`
      CREATE TABLE helm_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        kind TEXT,
        project_id INTEGER,
        run_id INTEGER,
        owner TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        generation INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        last_used_at TEXT,
        ended_at TEXT,
        reason TEXT
      );
      CREATE TABLE lifecycle_seq (
        name TEXT PRIMARY KEY,
        next INTEGER NOT NULL
      );
      INSERT INTO lifecycle_seq (name, next) VALUES ('global', 1);
    `);
    const reg = new SessionRegistryService(db as any);
    reg.register('helm-chat-s09reap', { owner: 'human', kind: 'discovery' });
    const { sessionStatusTokenFromRow } = await import('../services/session-registry-service.js');
    reg.markReaped(sessionStatusTokenFromRow(reg.get('helm-chat-s09reap')!), 'test-reap');
    expect(reg.get('helm-chat-s09reap')!.status).toBe('reaped');
    const endedAt = reg.get('helm-chat-s09reap')!.ended_at;
    const lastUsed = reg.get('helm-chat-s09reap')!.last_used_at;

    const tmux: any = new TmuxService({
      onCreate: (n: string) => {
        const row = reg.register(n, { owner: 'helm' });
        return row ? sessionStatusTokenFromRow(row) : undefined;
      },
      // B02 C1: no get(name) fallback — token required for registry mutation.
      onTerminate: (_n: string, token?: any) => {
        if (!token) return false;
        return reg.markReaped(token).applied === true;
      },
      onUse: (n: string) => reg.touch(n),
    });
    let frame = 'before\n';
    cpMock.impl = async () => ({ stdout: frame, stderr: '' });
    await tmux.capturePane('helm-chat-s09reap'); // baseline
    frame = 'after-agent-output\n';
    await tmux.capturePane('helm-chat-s09reap'); // would touch if not reaped

    const row = reg.get('helm-chat-s09reap')!;
    expect(row.status).toBe('reaped');
    expect(row.ended_at).toBe(endedAt);
    // touch is a no-op on reaped — last_used_at must not advance / resurrect.
    expect(row.last_used_at).toBe(lastUsed);
    db.close();
  });
});
