/**
 * cycle-branch-lifecycle B16 — owner-gated merge (R6.2).
 *
 * `CycleService.mergeCycleBranch(cycleId)`: CAS/idempotent. Revalidates (no active workers,
 * persisted identity matches `git worktree list`, cycle branch clean, base ref exists and its
 * checkout is clean and unambiguous), merges `--no-ff` into the persisted base, then calls the
 * GIT-ONLY `cleanupCycleGit` primitive (B12) so the cycle's docs survive. A cleanup failure AFTER
 * a durable merge sets `git_cleanup_pending` and a later call retries ONLY the cleanup — the
 * landed merge is never replayed or rolled back.
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
  await git(dir, ['config', 'user.email', 'helm-b16-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B16 Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-b16-${process.pid}.db`);
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

describe('B16 mergeCycleBranch — owner-gated merge (R6.2)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    vi.restoreAllMocks();
  });

  async function setup(prefix: string) {
    const repoDir = await initRepo(`helm-b16-${prefix}-`);
    const t = tempDbPath(`helm-b16-${prefix}-db-`);
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const dbs = new DatabaseService(t.dbPath);
    cleanups.push(() => dbs.close());
    const projects = new ProjectService(dbs);
    const gws = new GitWorktreeService(dbs);
    const cycles = new CycleService(dbs, projects, gws);
    const project = projects.createProject({ name: `b16-${prefix}-${Date.now()}`, directory: repoDir });

    return { repoDir, dbs, projects, gws, cycles, project };
  }

  /** Creates a worktree-backed cycle, commits one file on its branch, and parks it (R6.1 sim). */
  async function makeParkedCycle(dbs: DatabaseService, cycles: CycleService, projectId: number, name: string) {
    const cycle = await cycles.createCycle(projectId, name);
    const worktreePath = cycle.git_worktree_path!;
    fs.writeFileSync(path.join(worktreePath, 'feature.txt'), `${name}\n`);
    await git(worktreePath, ['add', 'feature.txt']);
    await git(worktreePath, ['commit', '-m', `feature work: ${name}`]);
    dbs.prepare('UPDATE cycles SET awaiting_merge = 1 WHERE id = ?').run(cycle.id);
    return cycle;
  }

  it('clean merge lands the cycle commits on base, worktree+branch are gone, docs folder still present', async () => {
    const { repoDir, dbs, cycles, project } = await setup('clean-merge');
    const cycle = await makeParkedCycle(dbs, cycles, project.id, 'Feature Alpha');
    const docDir = cycles.getCycleDocDir(cycle.id);

    const result = await cycles.mergeCycleBranch(cycle.id);
    expect(result.merged).toBe(true);
    expect(result.cleaned).toBe(true);
    expect(result.mergedAt).toBeTruthy();

    const log = await git(repoDir, ['log', '--oneline', 'main']);
    expect(log).toContain('feature work: Feature Alpha');

    const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelain).not.toContain(cycle.git_branch!);
    const branches = await git(repoDir, ['branch', '--list', `helm/cycle/${cycle.id}/*`]);
    expect(branches.trim()).toBe('');
    expect(fs.existsSync(cycle.git_worktree_path!)).toBe(false);

    expect(fs.existsSync(docDir)).toBe(true);

    const row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.awaiting_merge).toBe(0);
    expect(row.git_merged_at).toBeTruthy();
    expect(row.git_cleanup_pending).toBe(0);
  });

  it('a double submit cannot merge twice', async () => {
    const { repoDir, dbs, cycles, project } = await setup('double-submit');
    const cycle = await makeParkedCycle(dbs, cycles, project.id, 'Feature Beta');

    const first = await cycles.mergeCycleBranch(cycle.id);
    expect(first.merged).toBe(true);
    expect(first.cleaned).toBe(true);
    const logAfterFirst = await git(repoDir, ['log', '--oneline', 'main']);

    const second = await cycles.mergeCycleBranch(cycle.id);
    expect(second.alreadyMerged).toBe(true);
    expect(second.mergedAt).toBe(first.mergedAt);

    const logAfterSecond = await git(repoDir, ['log', '--oneline', 'main']);
    expect(logAfterSecond).toBe(logAfterFirst);
    const mergeCommitCount = logAfterSecond
      .split('\n')
      .filter((l) => l.includes('Merge cycle'))
      .length;
    expect(mergeCommitCount).toBe(1);
  });

  it('dirty base checkout refuses without merging', async () => {
    const { repoDir, dbs, cycles, project } = await setup('dirty-base');
    const cycle = await makeParkedCycle(dbs, cycles, project.id, 'Feature Gamma');

    // dirty the base checkout (repoDir is the main worktree, on `main`) — uncommitted, untracked
    fs.writeFileSync(path.join(repoDir, 'dirty.txt'), 'uncommitted\n');

    const logBefore = await git(repoDir, ['log', '--oneline', 'main']);

    await expect(cycles.mergeCycleBranch(cycle.id)).rejects.toThrow(/not clean/);

    const logAfter = await git(repoDir, ['log', '--oneline', 'main']);
    expect(logAfter).toBe(logBefore);

    const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelain).toContain(cycle.git_branch!);
    const branches = await git(repoDir, ['branch', '--list', `helm/cycle/${cycle.id}/*`]);
    expect(branches.trim()).not.toBe('');

    const row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.awaiting_merge).toBe(1);
    expect(row.git_merged_at).toBeNull();
  });

  /** Opens a run on the cycle in `status`, with ZERO worker_runtimes rows (between-tasks shape). */
  function openRun(dbs: DatabaseService, projectId: number, cycleId: number, status: string): number {
    const row = dbs
      .prepare(`INSERT INTO runs (project_id, cycle_id, status, phase) VALUES (?, ?, ?, 'executing') RETURNING id`)
      .get(projectId, cycleId, status) as { id: number };
    const live = dbs
      .prepare(
        `SELECT COUNT(*) AS c FROM worker_runtimes wr INNER JOIN runs r ON r.id = wr.run_id
         WHERE r.cycle_id = ? AND wr.state IN ('launching','running')`
      )
      .get(cycleId) as { c: number };
    // the whole point of these cases: the worker-level guard sees nothing to block on
    expect(live.c).toBe(0);
    return row.id;
  }

  // R6.2 revalidates "no active run OR workers". Worker rows finalize to done|failed|reaped between
  // tasks, so a live run presents zero launching/running workers — the run row is the only signal.
  it.each(['pending', 'active', 'paused'])(
    'a %s run with zero live workers refuses the merge (no commits land, worktree survives)',
    async (status) => {
      const { repoDir, dbs, cycles, project } = await setup(`run-${status}`);
      const cycle = await makeParkedCycle(dbs, cycles, project.id, `Feature Run ${status}`);
      openRun(dbs, project.id, cycle.id, status);

      const logBefore = await git(repoDir, ['log', '--oneline', 'main']);

      await expect(cycles.mergeCycleBranch(cycle.id)).rejects.toThrow(/run that is not terminal/);

      const logAfter = await git(repoDir, ['log', '--oneline', 'main']);
      expect(logAfter).toBe(logBefore);
      expect(logAfter).not.toContain('Merge cycle');

      // the running cycle's working directory must still be there
      expect(fs.existsSync(cycle.git_worktree_path!)).toBe(true);
      const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
      expect(porcelain).toContain(cycle.git_branch!);
      const branches = await git(repoDir, ['branch', '--list', `helm/cycle/${cycle.id}/*`]);
      expect(branches.trim()).not.toBe('');

      // refusal happens before the CAS claim — the cycle stays parked and retryable
      const row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
      expect(row.awaiting_merge).toBe(1);
      expect(row.git_merged_at).toBeNull();
      expect(row.git_cleanup_pending).toBe(0);
    }
  );

  it.each(['complete', 'failed'])(
    'a %s run does not block the merge (terminal runs are exactly what park-then-merge leaves behind)',
    async (status) => {
      const { repoDir, dbs, cycles, project } = await setup(`run-${status}`);
      const cycle = await makeParkedCycle(dbs, cycles, project.id, `Feature Run ${status}`);
      openRun(dbs, project.id, cycle.id, status);

      const result = await cycles.mergeCycleBranch(cycle.id);
      expect(result.merged).toBe(true);
      expect(result.cleaned).toBe(true);

      const log = await git(repoDir, ['log', '--oneline', 'main']);
      expect(log).toContain(`feature work: Feature Run ${status}`);
      expect(fs.existsSync(cycle.git_worktree_path!)).toBe(false);
    }
  );

  it('the cleanup-only retry also refuses under a non-terminal run, and succeeds once it is terminal', async () => {
    const { repoDir, dbs, gws, cycles, project } = await setup('retry-active-run');
    const cycle = await makeParkedCycle(dbs, cycles, project.id, 'Feature Epsilon');

    vi.spyOn(gws, 'cleanupCycleGit').mockImplementationOnce(async () => {
      throw new Error('injected cleanup failure');
    });
    await expect(cycles.mergeCycleBranch(cycle.id)).rejects.toThrow(/injected cleanup failure/);
    let row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.git_merged_at).toBeTruthy();
    expect(row.git_cleanup_pending).toBe(1);
    const mergedAt = row.git_merged_at;

    // a new run opens on the cycle before the operator retries cleanup
    const runId = openRun(dbs, project.id, cycle.id, 'active');
    await expect(cycles.mergeCycleBranch(cycle.id)).rejects.toThrow(/run that is not terminal/);
    expect(fs.existsSync(cycle.git_worktree_path!)).toBe(true);
    row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.git_cleanup_pending).toBe(1); // still retryable, merge untouched
    expect(row.git_merged_at).toBe(mergedAt);

    dbs.prepare(`UPDATE runs SET status = 'complete' WHERE id = ?`).run(runId);
    const retry = await cycles.mergeCycleBranch(cycle.id);
    expect(retry.cleaned).toBe(true);
    expect(retry.mergedAt).toBe(mergedAt);
    expect(fs.existsSync(cycle.git_worktree_path!)).toBe(false);

    const log = await git(repoDir, ['log', '--oneline', 'main']);
    expect(log.split('\n').filter((l) => l.includes('Merge cycle')).length).toBe(1);
  });

  it('an injected post-merge cleanup failure sets git_cleanup_pending, and the retry produces no second merge commit', async () => {
    const { repoDir, dbs, gws, cycles, project } = await setup('cleanup-retry');
    const cycle = await makeParkedCycle(dbs, cycles, project.id, 'Feature Delta');

    const cleanupSpy = vi
      .spyOn(gws, 'cleanupCycleGit')
      .mockImplementationOnce(async () => {
        throw new Error('injected cleanup failure');
      });

    await expect(cycles.mergeCycleBranch(cycle.id)).rejects.toThrow(/injected cleanup failure/);

    let row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.git_merged_at).toBeTruthy();
    expect(row.git_cleanup_pending).toBe(1);
    const mergedAtAfterFailure = row.git_merged_at;

    // merge already landed — worktree/branch are still present because cleanup never ran
    const porcelainAfterFailure = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelainAfterFailure).toContain(cycle.git_branch!);
    const logAfterFailure = await git(repoDir, ['log', '--oneline', 'main']);
    expect(logAfterFailure).toContain('feature work: Feature Delta');
    const mergeCommitCountAfterFailure = logAfterFailure
      .split('\n')
      .filter((l) => l.includes('Merge cycle'))
      .length;
    expect(mergeCommitCountAfterFailure).toBe(1);

    // retry: cleanupSpy's mockImplementationOnce is spent, so this call falls through to the real
    // cleanupCycleGit implementation — no second `git merge` is ever invoked on this path.
    const retryResult = await cycles.mergeCycleBranch(cycle.id);
    expect(retryResult.merged).toBe(true);
    expect(retryResult.cleaned).toBe(true);
    expect(retryResult.mergedAt).toBe(mergedAtAfterFailure);
    expect(cleanupSpy).toHaveBeenCalledTimes(2);

    row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.git_cleanup_pending).toBe(0);
    expect(row.git_merged_at).toBe(mergedAtAfterFailure);

    const porcelainAfterRetry = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelainAfterRetry).not.toContain(cycle.git_branch!);
    expect(fs.existsSync(cycle.git_worktree_path!)).toBe(false);

    const logAfterRetry = await git(repoDir, ['log', '--oneline', 'main']);
    const mergeCommitCountAfterRetry = logAfterRetry
      .split('\n')
      .filter((l) => l.includes('Merge cycle'))
      .length;
    expect(mergeCommitCountAfterRetry).toBe(1);

    expect(fs.existsSync(cycles.getCycleDocDir(cycle.id))).toBe(true);
  });
});
