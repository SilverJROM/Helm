/**
 * cycle-branch-lifecycle B17 — conflict path (R6.3).
 *
 * A real merge conflict must never leave the base half-merged: `CycleService.mergeCycleBranch`
 * catches `GitWorktreeService`'s `MergeConflictError`, which has already run `git merge --abort`
 * to restore base HEAD/index/worktree exactly as they were, then persists a conflict report
 * (conflicted paths + refs + the single B5 `branchSafetyReport` facts/narrative) next to the
 * cycle's docs. Never auto-resolves — the cycle stays parked (awaiting_merge=1), and its branch
 * and worktree survive untouched.
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
import * as BranchSafetyReportService from './services/branch-safety-report-service.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b17-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B17 Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-b17-${process.pid}.db`);
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

describe('B17 mergeCycleBranch — conflict path (R6.3)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    vi.restoreAllMocks();
  });

  async function setup(prefix: string) {
    const repoDir = await initRepo(`helm-b17-${prefix}-`);
    const t = tempDbPath(`helm-b17-${prefix}-db-`);
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const dbs = new DatabaseService(t.dbPath);
    cleanups.push(() => dbs.close());
    const projects = new ProjectService(dbs);
    const gws = new GitWorktreeService(dbs);
    const cycles = new CycleService(dbs, projects, gws);
    const project = projects.createProject({ name: `b17-${prefix}-${Date.now()}`, directory: repoDir });

    return { repoDir, dbs, projects, gws, cycles, project };
  }

  it(
    'a real conflict aborts, restores the base, persists a report naming the conflicted paths, ' +
      'invokes R3 exactly once, and never resolves or deletes',
    async () => {
      const { repoDir, dbs, cycles, project } = await setup('conflict');

      const cycle = await cycles.createCycle(project.id, 'Feature Conflict');
      const worktreePath = cycle.git_worktree_path!;

      // cycle branch adds feature.txt with its own content...
      fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'cycle version\n');
      await git(worktreePath, ['add', 'feature.txt']);
      await git(worktreePath, ['commit', '-m', 'cycle: add feature.txt']);

      // ...while base independently adds the SAME path with different content — base "moved on"
      // since the cycle's branch was cut (R6.3's trigger condition).
      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base version\n');
      await git(repoDir, ['add', 'feature.txt']);
      await git(repoDir, ['commit', '-m', 'base: add feature.txt']);

      dbs.prepare('UPDATE cycles SET awaiting_merge = 1 WHERE id = ?').run(cycle.id);

      const safetySpy = vi.spyOn(BranchSafetyReportService, 'branchSafetyReport');
      const baseShaBefore = (await git(repoDir, ['rev-parse', 'HEAD'])).trim();
      const statusBefore = await git(repoDir, ['status', '--porcelain']);
      expect(statusBefore.trim()).toBe('');

      await expect(cycles.mergeCycleBranch(cycle.id)).rejects.toThrow(/conflict/i);

      // base HEAD, index and worktree restored — no half-merged state, no MERGE_HEAD. Repo-wide,
      // NOT scoped to the conflicted path: "restores the base" has to mean the whole checkout is
      // as the attempt found it, including the report the attempt itself just wrote next to the
      // cycle's docs (see the retry test below for what a leftover costs).
      const baseShaAfter = (await git(repoDir, ['rev-parse', 'HEAD'])).trim();
      expect(baseShaAfter).toBe(baseShaBefore);
      expect(await git(repoDir, ['status', '--porcelain'])).toBe(statusBefore);
      const unmergedEntries = await git(repoDir, ['ls-files', '-u']);
      expect(unmergedEntries.trim()).toBe('');
      expect(fs.existsSync(path.join(repoDir, '.git', 'MERGE_HEAD'))).toBe(false);
      expect(fs.readFileSync(path.join(repoDir, 'feature.txt'), 'utf8')).toBe('base version\n');

      // cycle branch and worktree still present — never auto-deleted.
      expect(fs.existsSync(worktreePath)).toBe(true);
      const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
      expect(porcelain).toContain(cycle.git_branch!);
      const branches = await git(repoDir, ['branch', '--list', `helm/cycle/${cycle.id}/*`]);
      expect(branches.trim()).not.toBe('');

      // parked and retryable, not silently dropped.
      const row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
      expect(row.awaiting_merge).toBe(1);
      expect(row.git_merged_at).toBeNull();
      expect(row.git_cleanup_pending).toBe(0);

      // report persisted, names the conflicted path.
      const reportPath = path.join(cycles.getCycleDocDir(cycle.id), 'merge-conflict-report.json');
      expect(fs.existsSync(reportPath)).toBe(true);
      const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
      expect(report.conflictedPaths).toEqual(['feature.txt']);
      expect(report.baseShaBefore).toBe(baseShaBefore);
      expect(report.cycleBranchSha).toBeTruthy();
      expect(report.safety?.facts).toBeTruthy();

      // exactly ONE R3 (single B5 house-agent entry point) invocation.
      expect(safetySpy).toHaveBeenCalledTimes(1);
    }
  );

  it(
    'the report leaves the base checkout clean, so the retry AFTER the conflict is resolved merges',
    async () => {
      const { repoDir, dbs, cycles, project } = await setup('retry-after-resolve');

      const cycle = await cycles.createCycle(project.id, 'Feature Retry');
      const worktreePath = cycle.git_worktree_path!;

      fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'cycle version\n');
      await git(worktreePath, ['add', 'feature.txt']);
      await git(worktreePath, ['commit', '-m', 'cycle: add feature.txt']);
      fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'base version\n');
      await git(repoDir, ['add', 'feature.txt']);
      await git(repoDir, ['commit', '-m', 'base: add feature.txt']);

      dbs.prepare('UPDATE cycles SET awaiting_merge = 1 WHERE id = ?').run(cycle.id);

      const statusBefore = await git(repoDir, ['status', '--porcelain']);
      expect(statusBefore.trim()).toBe('');

      await expect(cycles.mergeCycleBranch(cycle.id)).rejects.toThrow(/conflict/i);

      // the report IS on disk, inside the base checkout, next to the cycle's docs...
      const reportPath = path.join(cycles.getCycleDocDir(cycle.id), 'merge-conflict-report.json');
      expect(fs.existsSync(reportPath)).toBe(true);
      expect(reportPath.startsWith(repoDir + path.sep)).toBe(true);
      // ...and the base checkout is still byte-for-byte as clean as before the attempt.
      expect(await git(repoDir, ['status', '--porcelain'])).toBe(statusBefore);
      // ...because git is excluding it, not because status happened to miss it: git names the rule.
      const rel = path.relative(repoDir, reportPath).split(path.sep).join('/');
      const ignoredBy = await git(repoDir, ['check-ignore', '-v', rel]);
      expect(ignoredBy).toContain('info/exclude');
      expect(ignoredBy).toContain('merge-conflict-report.json');

      // JROM does what the park exists for: resolves the conflict himself, on the cycle branch.
      await expect(git(worktreePath, ['merge', 'main'])).rejects.toThrow();
      fs.writeFileSync(path.join(worktreePath, 'feature.txt'), 'resolved by hand\n');
      await git(worktreePath, ['add', 'feature.txt']);
      await git(worktreePath, ['commit', '--no-edit']);

      // the retry then merges — it is not wedged on a bare 'not clean' by B17's own report.
      const result = await cycles.mergeCycleBranch(cycle.id);
      expect(result.merged).toBe(true);
      expect(result.cleaned).toBe(true);
      expect(fs.readFileSync(path.join(repoDir, 'feature.txt'), 'utf8')).toBe('resolved by hand\n');

      const row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
      expect(row.git_merged_at).not.toBeNull();
      expect(row.awaiting_merge).toBe(0);
      expect(row.git_cleanup_pending).toBe(0);

      // the report survives the merge for the record, and still isn't dirt.
      expect(fs.existsSync(reportPath)).toBe(true);
      expect((await git(repoDir, ['status', '--porcelain'])).trim()).toBe('');
    }
  );

  it('a non-conflict merge refusal is rethrown as-is — nothing to abort, no report, no R3 call', async () => {
    const { repoDir, dbs, cycles, project } = await setup('non-conflict-refusal');

    const cycle = await cycles.createCycle(project.id, 'Feature Dirty Base');
    fs.writeFileSync(path.join(cycle.git_worktree_path!, 'feature.txt'), 'cycle version\n');
    await git(cycle.git_worktree_path!, ['add', 'feature.txt']);
    await git(cycle.git_worktree_path!, ['commit', '-m', 'cycle: add feature.txt']);
    dbs.prepare('UPDATE cycles SET awaiting_merge = 1 WHERE id = ?').run(cycle.id);

    // dirty (not conflicting) base checkout — B16's pre-check refuses before any `git merge` runs,
    // so no MergeConflictError is ever thrown and there's nothing for B17's path to react to.
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'uncommitted\n');

    const safetySpy = vi.spyOn(BranchSafetyReportService, 'branchSafetyReport');

    await expect(cycles.mergeCycleBranch(cycle.id)).rejects.toThrow(/not clean/);

    const reportPath = path.join(cycles.getCycleDocDir(cycle.id), 'merge-conflict-report.json');
    expect(fs.existsSync(reportPath)).toBe(false);
    expect(safetySpy).not.toHaveBeenCalled();
  });
});
