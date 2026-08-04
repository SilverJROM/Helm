import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { GitWorktreeService, type DbLike } from './git-worktree-service.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b6-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B6 Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

function fakeDb(run: (sql: string, params: unknown[]) => { changes: number }): DbLike {
  return {
    prepare(sql: string) {
      return { run: (...params: unknown[]) => run(sql, params) };
    }
  };
}

function passingDb(): DbLike {
  return fakeDb(() => ({ changes: 1 }));
}

function throwingDb(message: string): DbLike {
  return fakeDb(() => {
    throw new Error(message);
  });
}

async function listWorktreeBlocks(dir: string): Promise<string[]> {
  const stdout = await git(dir, ['worktree', 'list', '--porcelain']);
  return stdout.split('\n\n').map((b) => b.trim()).filter(Boolean);
}

describe('B6 GitWorktreeService: cycle branch + worktree creation (R4.1, R4.2)', () => {
  it('creates helm/cycle/<id>/<slug> at a stable worktree path, HEAD on the supplied base SHA, and persists identity', async () => {
    const dir = await initRepo('helm-b6-happy-');
    try {
      const baseSha = (await git(dir, ['rev-parse', 'main'])).trim();
      const persisted: Record<string, unknown>[] = [];
      const db = fakeDb((sql, params) => {
        persisted.push({ sql, params });
        return { changes: 1 };
      });

      const service = new GitWorktreeService(db);
      const identity = await service.createCycleWorktree({
        projectDir: dir,
        cycleId: 42,
        slug: 'feature-x',
        baseRef: 'main'
      });

      expect(identity.branch).toBe('helm/cycle/42/feature-x');
      expect(identity.baseSha).toBe(baseSha);
      expect(identity.worktreePath).toBe(path.join(fs.realpathSync(dir), 'cycle', '.worktrees', '42'));

      const blocks = await listWorktreeBlocks(dir);
      const mine = blocks.find((b) => b.includes('helm/cycle/42/feature-x'));
      expect(mine).toBeTruthy();
      expect(mine).toContain(`HEAD ${baseSha}`);
      expect(mine).toContain('branch refs/heads/helm/cycle/42/feature-x');

      // identity is persisted (UPDATE issued with the created identity's fields)
      expect(persisted).toHaveLength(1);
      expect(String(persisted[0].sql)).toMatch(/UPDATE cycles SET/);
      expect(persisted[0].params).toEqual(['main', 'helm/cycle/42/feature-x', identity.worktreePath, identity.worktreeId, 42]);

      // reflog dir pre-created deterministically (R4.1/B7 gate precondition)
      const gitCommonDir = (await git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
      const reflogDir = path.join(gitCommonDir, 'logs', 'refs', 'heads', 'helm', 'cycle', '42');
      expect(fs.existsSync(reflogDir)).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the worktree root is repo-local-excluded: `git check-ignore -v` exits 0', async () => {
    const dir = await initRepo('helm-b6-ignore-');
    try {
      const service = new GitWorktreeService(passingDb());
      const identity = await service.createCycleWorktree({
        projectDir: dir,
        cycleId: 7,
        slug: 'ignore-me',
        baseRef: 'main'
      });

      await expect(
        execFileAsync('git', ['check-ignore', '-v', identity.worktreePath], { cwd: dir })
      ).resolves.toBeTruthy();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('an injected DB-write failure leaves NO worktree and NO branch behind', async () => {
    const dir = await initRepo('helm-b6-dbfail-');
    try {
      const service = new GitWorktreeService(throwingDb('simulated DB outage'));

      await expect(
        service.createCycleWorktree({ projectDir: dir, cycleId: 9, slug: 'rollback-me', baseRef: 'main' })
      ).rejects.toThrow('simulated DB outage');

      const worktreeOutput = await git(dir, ['worktree', 'list', '--porcelain']);
      expect(worktreeOutput).not.toContain('helm/cycle/9/rollback-me');
      const branches = await git(dir, ['branch', '--list', 'helm/cycle/9/*']);
      expect(branches.trim()).toBe('');
      expect(fs.existsSync(path.join(dir, 'cycle', '.worktrees', '9'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses on a non-repo directory with no partial state', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b6-nonrepo-'));
    try {
      const service = new GitWorktreeService(passingDb());
      await expect(
        service.createCycleWorktree({ projectDir: dir, cycleId: 1, slug: 'no-repo', baseRef: 'main' })
      ).rejects.toThrow(/not a git repository/);
      expect(fs.readdirSync(dir)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses on an unknown base ref with no partial state', async () => {
    const dir = await initRepo('helm-b6-unknownbase-');
    try {
      const service = new GitWorktreeService(passingDb());
      await expect(
        service.createCycleWorktree({ projectDir: dir, cycleId: 2, slug: 'phantom-base', baseRef: 'does-not-exist' })
      ).rejects.toThrow(/unknown base/);

      const worktreeOutput = await git(dir, ['worktree', 'list', '--porcelain']);
      expect(worktreeOutput.trim().split('\n\n')).toHaveLength(1); // only the main worktree entry
      expect(fs.existsSync(path.join(dir, 'cycle'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses on branch collision with no additional partial state', async () => {
    const dir = await initRepo('helm-b6-collision-');
    try {
      const service = new GitWorktreeService(passingDb());
      await service.createCycleWorktree({ projectDir: dir, cycleId: 3, slug: 'dup', baseRef: 'main' });

      await expect(
        service.createCycleWorktree({ projectDir: dir, cycleId: 3, slug: 'dup', baseRef: 'main' })
      ).rejects.toThrow(/already exists|already registered/);

      const worktreeOutput = await git(dir, ['worktree', 'list', '--porcelain']);
      const occurrences = worktreeOutput.split('helm/cycle/3/dup').length - 1;
      expect(occurrences).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a path-escape slug with no partial state', async () => {
    const dir = await initRepo('helm-b6-escape-');
    try {
      const service = new GitWorktreeService(passingDb());
      await expect(
        service.createCycleWorktree({ projectDir: dir, cycleId: 4, slug: '../../etc', baseRef: 'main' })
      ).rejects.toThrow(/path-escape guard/);

      expect(fs.existsSync(path.join(dir, 'cycle'))).toBe(false);
      const worktreeOutput = await git(dir, ['worktree', 'list', '--porcelain']);
      expect(worktreeOutput.trim().split('\n\n')).toHaveLength(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
