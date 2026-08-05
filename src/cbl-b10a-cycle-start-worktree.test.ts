/**
 * cycle-branch-lifecycle B10a — cycle-start worktree wire (R4.1, R4.2, R4.4).
 *
 * Inject GitWorktreeService into CycleService; on createCycle (when wired, not skipped)
 * call B6 with default base `main`, persist git_* identity; B6 compensates on persist
 * failure. Null-identity path (service not injected) issues zero git commands.
 * Does NOT cover run-orchestrator docs/build split (B10b).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { GitWorktreeService, type DbLike } from './services/git-worktree-service.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b10a-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B10a Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-b10a-${process.pid}.db`);
  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    },
  };
}

function throwingPersistDb(message: string): DbLike {
  return {
    prepare(_sql: string) {
      return {
        run: (..._params: unknown[]) => {
          throw new Error(message);
        },
      };
    },
  };
}

describe('B10a CycleService cycle-start worktree wire (R4.1, R4.2, R4.4)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('fresh cycle gets worktree on helm/cycle/<id>/* from main and identity columns set', async () => {
    const repoDir = await initRepo('helm-b10a-happy-');
    const t = tempDbPath('helm-b10a-happy-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const baseSha = (await git(repoDir, ['rev-parse', 'main'])).trim();
    const dbs = new DatabaseService(t.dbPath);
    cleanups.push(() => dbs.close());
    const projects = new ProjectService(dbs);
    const gws = new GitWorktreeService(dbs);
    const cycles = new CycleService(dbs, projects, gws);
    const project = projects.createProject({
      name: `b10a-happy-${Date.now()}`,
      directory: repoDir,
    });

    const cycle = await cycles.createCycle(project.id, 'Feature Alpha');

    expect(cycle.git_base_branch).toBe('main');
    expect(cycle.git_branch).toMatch(new RegExp(`^helm/cycle/${cycle.id}/`));
    expect(cycle.git_worktree_path).toBe(
      path.join(fs.realpathSync(repoDir), 'cycle', '.worktrees', String(cycle.id))
    );
    expect(cycle.git_worktree_id).toBeTruthy();

    const row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.git_base_branch).toBe('main');
    expect(row.git_branch).toBe(cycle.git_branch);
    expect(row.git_worktree_path).toBe(cycle.git_worktree_path);
    expect(row.git_worktree_id).toBe(cycle.git_worktree_id);

    const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelain).toContain(cycle.git_branch!);
    expect(porcelain).toContain(`HEAD ${baseSha}`);
    expect(porcelain).toContain(`branch refs/heads/${cycle.git_branch}`);

    const head = (await git(repoDir, ['rev-parse', cycle.git_branch!])).trim();
    expect(head).toBe(baseSha);
  });

  it('DB persist failure rolls back worktree and leaves null identity (B6 compensation)', async () => {
    const repoDir = await initRepo('helm-b10a-dbfail-');
    const t = tempDbPath('helm-b10a-dbfail-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const dbs = new DatabaseService(t.dbPath);
    cleanups.push(() => dbs.close());
    const projects = new ProjectService(dbs);
    // Real CycleService DB for INSERT; GWS gets a failing persister so createCycleWorktree
    // compensates the git side effects and throws — createCycle soft-skips to null identity.
    const gws = new GitWorktreeService(throwingPersistDb('simulated DB outage'));
    const cycles = new CycleService(dbs, projects, gws);
    const project = projects.createProject({
      name: `b10a-dbfail-${Date.now()}`,
      directory: repoDir,
    });

    const cycle = await cycles.createCycle(project.id, 'Rollback Me');

    expect(cycle.git_base_branch).toBeNull();
    expect(cycle.git_branch).toBeNull();
    expect(cycle.git_worktree_path).toBeNull();
    expect(cycle.git_worktree_id).toBeNull();

    const worktreeOutput = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(worktreeOutput).not.toContain(`helm/cycle/${cycle.id}/`);
    const branches = await git(repoDir, ['branch', '--list', `helm/cycle/${cycle.id}/*`]);
    expect(branches.trim()).toBe('');
    expect(fs.existsSync(path.join(repoDir, 'cycle', '.worktrees', String(cycle.id)))).toBe(false);
  });

  it('branch/worktree collision refuses without leaving additional partial state', async () => {
    const repoDir = await initRepo('helm-b10a-collision-');
    const t = tempDbPath('helm-b10a-collision-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const dbs = new DatabaseService(t.dbPath);
    cleanups.push(() => dbs.close());
    const projects = new ProjectService(dbs);
    const gws = new GitWorktreeService(dbs);
    const cycles = new CycleService(dbs, projects, gws);
    const project = projects.createProject({
      name: `b10a-coll-${Date.now()}`,
      directory: repoDir,
    });

    const first = await cycles.createCycle(project.id, 'Dup Feature');
    expect(first.git_branch).toBeTruthy();

    // Force a second createCycleWorktree for the same cycle id + slug (B6 collision path).
    // createCycle itself always allocates a new id, so we hit the service directly after a
    // successful create to prove compensation / refuse-closed on collision at the wire.
    await expect(
      gws.createCycleWorktree({
        projectDir: repoDir,
        cycleId: first.id,
        slug: 'dup-feature',
        baseRef: 'main',
      })
    ).rejects.toThrow(/already exists|already registered/);

    const worktreeOutput = await git(repoDir, ['worktree', 'list', '--porcelain']);
    const occurrences = worktreeOutput.split(first.git_branch!).length - 1;
    expect(occurrences).toBe(1);
  });

  it('null-identity create path (no GitWorktreeService) issues zero git commands (R4.4)', async () => {
    // Real git repo as project dir — if createCycle so much as touched git, worktree list /
    // branch list / HEAD would change. No GWS injected ⇒ structural zero-git path (R4.4).
    const repoDir = await initRepo('helm-b10a-legacy-');
    const t = tempDbPath('helm-b10a-legacy-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const dbs = new DatabaseService(t.dbPath);
    cleanups.push(() => dbs.close());
    const projects = new ProjectService(dbs);
    // No GWS — R4.4 null-identity path; byte-identical to pre-B10a create.
    const cycles = new CycleService(dbs, projects);
    const project = projects.createProject({
      name: `b10a-legacy-${Date.now()}`,
      directory: repoDir,
    });

    const beforeWorktrees = await git(repoDir, ['worktree', 'list', '--porcelain']);
    const beforeBranches = await git(repoDir, ['branch', '-a']);
    const beforeHead = (await git(repoDir, ['rev-parse', 'HEAD'])).trim();
    // Stamp a marker file under .git; any git write (reflog, worktree admin, exclude) would
    // land nearby — we only assert the public git surface (refs/worktrees/HEAD) is identical.
    const beforeExclude = fs.existsSync(path.join(repoDir, '.git', 'info', 'exclude'))
      ? fs.readFileSync(path.join(repoDir, '.git', 'info', 'exclude'), 'utf8')
      : null;

    const cycle = await cycles.createCycle(project.id, 'Legacy Cycle');

    expect(cycle.git_base_branch).toBeNull();
    expect(cycle.git_branch).toBeNull();
    expect(cycle.git_worktree_path).toBeNull();
    expect(cycle.git_worktree_id).toBeNull();

    expect(await git(repoDir, ['worktree', 'list', '--porcelain'])).toBe(beforeWorktrees);
    expect(await git(repoDir, ['branch', '-a'])).toBe(beforeBranches);
    expect((await git(repoDir, ['rev-parse', 'HEAD'])).trim()).toBe(beforeHead);
    const afterExclude = fs.existsSync(path.join(repoDir, '.git', 'info', 'exclude'))
      ? fs.readFileSync(path.join(repoDir, '.git', 'info', 'exclude'), 'utf8')
      : null;
    expect(afterExclude).toBe(beforeExclude);
    expect(fs.existsSync(path.join(repoDir, 'cycle', '.worktrees'))).toBe(false);
  });

  it('skipGitWorktree (B20 onboarding) leaves null identity even when GWS is wired', async () => {
    const repoDir = await initRepo('helm-b10a-skip-');
    const t = tempDbPath('helm-b10a-skip-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const dbs = new DatabaseService(t.dbPath);
    cleanups.push(() => dbs.close());
    const projects = new ProjectService(dbs);
    const gws = new GitWorktreeService(dbs);
    const cycles = new CycleService(dbs, projects, gws);
    const project = projects.createProject({
      name: `b10a-skip-${Date.now()}`,
      directory: repoDir,
    });

    const cycle = await cycles.createCycle(
      project.id,
      'Awaiting Choice',
      undefined,
      undefined,
      () => new Date(),
      { skipGitWorktree: true }
    );

    expect(cycle.git_branch).toBeNull();
    expect(cycle.git_worktree_path).toBeNull();
    expect(await git(repoDir, ['branch', '--list', `helm/cycle/${cycle.id}/*`])).toBe('');
    expect(fs.existsSync(path.join(repoDir, 'cycle', '.worktrees', String(cycle.id)))).toBe(false);
  });
});
