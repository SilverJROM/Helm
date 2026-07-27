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
    const ret = await tmux.createSession('helm-w-tagtest');
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
    await expect(tmux.createSession('helm-w-tagfail')).resolves.toBe('helm-w-tagfail:0.0');
  });

  // A2 (R4.16): createSession forwards projectId/runId into the registry onCreate choke point.
  it('A2: createSession passes projectId+runId to registry onCreate', async () => {
    cpMock.impl = async (_cmd: string, args: string[]) => {
      if (args[0] === 'has-session') throw new Error('no such session');
      return { stdout: '', stderr: '' };
    };
    const seen: Array<{ name: string; opts?: any }> = [];
    const tmux: any = new TmuxService({
      onCreate: (name: string, opts?: any) => { seen.push({ name, opts }); },
      onTerminate: () => {},
      onUse: () => {},
    });
    await tmux.createSession('helm-batch-A2-plancore-x1', '/tmp/proj', { projectId: 7, runId: 88 });
    expect(seen).toEqual([{ name: 'helm-batch-A2-plancore-x1', opts: { projectId: 7, runId: 88 } }]);
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
});
