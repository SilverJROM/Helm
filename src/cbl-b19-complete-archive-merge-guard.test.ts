/**
 * cycle-branch-lifecycle B19 — R4/R6 coupling (plan.md §3.3).
 *
 * `completeCycle`/`archiveCycle` refuse (409) to move the docs / flip status for a
 * persisted-identity cycle until its merge+cleanup has reached durable terminal state
 * (`git_merged_at` set AND `git_cleanup_pending` cleared). The stable `.worktrees` location means
 * the docs rename never touches the worktree, so there is no repair step. Legacy null-identity
 * cycles (`git_worktree_path IS NULL`, R4.4) have nothing to wait on and complete exactly as
 * before this slice — zero git commands.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { GitWorktreeService } from './services/git-worktree-service.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b19-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B19 Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-b19-${process.pid}.db`);
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

describe('B19 completeCycle/archiveCycle — R4/R6 merge/cleanup terminal guard', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    vi.restoreAllMocks();
  });

  async function setup(prefix: string, withGws = true) {
    const repoDir = await initRepo(`helm-b19-${prefix}-`);
    const t = tempDbPath(`helm-b19-${prefix}-db-`);
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const dbs = new DatabaseService(t.dbPath);
    cleanups.push(() => dbs.close());
    const projects = new ProjectService(dbs);
    const gws = withGws ? new GitWorktreeService(dbs) : undefined;
    const cycles = withGws ? new CycleService(dbs, projects, gws) : new CycleService(dbs, projects);
    const project = projects.createProject({ name: `b19-${prefix}-${Date.now()}`, directory: repoDir });

    return { repoDir, dbs, projects, gws, cycles, project };
  }

  /** Creates a worktree-backed cycle and commits one file on its branch (uncommitted to base). */
  async function makeCycleWithCommit(dbs: DatabaseService, cycles: CycleService, projectId: number, name: string) {
    const cycle = await cycles.createCycle(projectId, name);
    const worktreePath = cycle.git_worktree_path!;
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), `${name}\n`);
    await git(worktreePath, ['add', 'feature.txt']);
    await git(worktreePath, ['commit', '-m', `feature work: ${name}`]);
    return cycle;
  }

  it('(a) merge then cleanupCycleGit then complete: rename succeeds, worktree list clean, identity still resolves, docs present at completed path', async () => {
    const { repoDir, dbs, cycles, project } = await setup('happy-path');
    const cycle = await makeCycleWithCommit(dbs, cycles, project.id, 'Feature Alpha');
    const activeDir = cycles.getCycleDocDir(cycle.id);

    dbs.prepare('UPDATE cycles SET awaiting_merge = 1 WHERE id = ?').run(cycle.id);
    const merge = await cycles.mergeCycleBranch(cycle.id);
    expect(merge.merged).toBe(true);
    expect(merge.cleaned).toBe(true);

    // written AFTER the merge lands (a docs file inside the base checkout dirtying it BEFORE the
    // merge is the pre-existing, out-of-scope P8 gap owned by B6/B16 — not this slice's concern)
    fs.writeFileSync(path.join(activeDir, 'og_req.md'), '# original requirements\n', 'utf8');

    const completed = await cycles.completeCycle(cycle.id);
    expect(completed.status).toBe('completed');

    // rename succeeded
    expect(fs.existsSync(activeDir)).toBe(false);
    const completedDir = path.join(repoDir, 'cycle', 'completed', cycle.folder_name);
    expect(fs.existsSync(completedDir)).toBe(true);
    expect(fs.readFileSync(path.join(completedDir, 'og_req.md'), 'utf8')).toBe('# original requirements\n');

    // git worktree list clean, no stale entry — the docs move never touched the stable worktree root
    const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelain).not.toContain(cycle.git_branch!);
    expect(fs.existsSync(cycle.git_worktree_path!)).toBe(false);

    // persisted identity survives the move
    const row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.git_branch).toBe(cycle.git_branch);
    expect(row.git_worktree_path).toBe(cycle.git_worktree_path);
    expect(row.git_worktree_id).toBe(cycle.git_worktree_id);
    expect(row.git_merged_at).toBeTruthy();
    expect(row.git_cleanup_pending).toBe(0);
  });

  it('(b1) complete refuses 409 when the cycle has never been merged: no rename, worktree still functional', async () => {
    const { dbs, cycles, project } = await setup('never-merged');
    const cycle = await makeCycleWithCommit(dbs, cycles, project.id, 'Feature Beta');
    const activeDir = cycles.getCycleDocDir(cycle.id);

    let caught: any;
    try {
      await cycles.completeCycle(cycle.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('CONFLICT');
    expect(String(caught.message)).toMatch(/durable terminal state/);

    // no rename occurred
    expect(fs.existsSync(activeDir)).toBe(true);
    const row = dbs.prepare('SELECT status FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.status).not.toBe('completed');

    // worktree still functional — its commit path still works
    const porcelain = await git(project.directory, ['worktree', 'list', '--porcelain']);
    expect(porcelain).toContain(cycle.git_branch!);
    fs.writeFileSync(path.join(cycle.git_worktree_path!, 'more.txt'), 'still alive\n');
    await git(cycle.git_worktree_path!, ['add', 'more.txt']);
    await expect(git(cycle.git_worktree_path!, ['commit', '-m', 'still functional'])).resolves.toBeTruthy();
  });

  it('(b2) complete refuses 409 when merged but cleanup is still pending: no rename, worktree still functional', async () => {
    const { dbs, gws, cycles, project } = await setup('cleanup-pending');
    const cycle = await makeCycleWithCommit(dbs, cycles, project.id, 'Feature Gamma');
    const activeDir = cycles.getCycleDocDir(cycle.id);

    dbs.prepare('UPDATE cycles SET awaiting_merge = 1 WHERE id = ?').run(cycle.id);
    vi.spyOn(gws!, 'cleanupCycleGit').mockImplementationOnce(async () => {
      throw new Error('injected cleanup failure');
    });
    await expect(cycles.mergeCycleBranch(cycle.id)).rejects.toThrow(/injected cleanup failure/);

    let row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.git_merged_at).toBeTruthy();
    expect(row.git_cleanup_pending).toBe(1);

    let caught: any;
    try {
      await cycles.completeCycle(cycle.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('CONFLICT');
    expect(String(caught.message)).toMatch(/durable terminal state/);

    // no rename occurred
    expect(fs.existsSync(activeDir)).toBe(true);
    row = dbs.prepare('SELECT status FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.status).not.toBe('completed');

    // worktree still functional — its commit path still works (cleanup never ran)
    expect(fs.existsSync(cycle.git_worktree_path!)).toBe(true);
    fs.writeFileSync(path.join(cycle.git_worktree_path!, 'more.txt'), 'still alive\n');
    await git(cycle.git_worktree_path!, ['add', 'more.txt']);
    await expect(git(cycle.git_worktree_path!, ['commit', '-m', 'still functional'])).resolves.toBeTruthy();
  });

  it('(c) legacy null-identity cycle completes with zero git commands issued', async () => {
    const { repoDir, dbs, cycles, project } = await setup('legacy', /* withGws */ false);
    const cycle = await cycles.createCycle(project.id, 'Legacy Cycle');
    expect(cycle.git_worktree_path).toBeNull();

    const activeDir = cycles.getCycleDocDir(cycle.id);
    fs.writeFileSync(path.join(activeDir, 'og_req.md'), '# legacy requirements\n', 'utf8');

    const beforeWorktrees = await git(repoDir, ['worktree', 'list', '--porcelain']);
    const beforeBranches = await git(repoDir, ['branch', '-a']);
    const beforeHead = (await git(repoDir, ['rev-parse', 'HEAD'])).trim();

    const completed = await cycles.completeCycle(cycle.id);

    expect(completed.status).toBe('completed');
    expect(fs.existsSync(activeDir)).toBe(false);
    const completedDir = path.join(repoDir, 'cycle', 'completed', cycle.folder_name);
    expect(fs.existsSync(completedDir)).toBe(true);

    expect(await git(repoDir, ['worktree', 'list', '--porcelain'])).toBe(beforeWorktrees);
    expect(await git(repoDir, ['branch', '-a'])).toBe(beforeBranches);
    expect((await git(repoDir, ['rev-parse', 'HEAD'])).trim()).toBe(beforeHead);
  });

  it('archive: succeeds for a merge-terminal completed cycle (no regression)', async () => {
    const { dbs, cycles, project } = await setup('archive-happy');
    const cycle = await makeCycleWithCommit(dbs, cycles, project.id, 'Feature Delta');
    dbs.prepare('UPDATE cycles SET awaiting_merge = 1 WHERE id = ?').run(cycle.id);
    await cycles.mergeCycleBranch(cycle.id);
    await cycles.completeCycle(cycle.id);

    const archived = cycles.archiveCycle(cycle.id);
    expect(archived.status).toBe('archived');
  });

  it('archive: refuses 409 (defense-in-depth) when a completed row is not merge/cleanup terminal', async () => {
    const { dbs, cycles, project } = await setup('archive-guard');
    const cycle = await makeCycleWithCommit(dbs, cycles, project.id, 'Feature Epsilon');
    // Simulate a completed row whose merge never landed — unreachable through the normal
    // completeCycle path post-B19, but archiveCycle must not trust status alone.
    dbs.prepare(`UPDATE cycles SET status = 'completed' WHERE id = ?`).run(cycle.id);

    let caught: any;
    try {
      cycles.archiveCycle(cycle.id);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    expect(caught.code).toBe('CONFLICT');
    expect(String(caught.message)).toMatch(/durable terminal state/);

    const row = dbs.prepare('SELECT status FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.status).toBe('completed');
  });
});
