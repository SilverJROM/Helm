/**
 * cycle-branch-lifecycle B12 — cleanupCycleGit (GIT-ONLY primitive) + deleteCycle (R2.2, R2.3).
 *
 * cleanupCycleGit(projectDir, cycleId): `git worktree remove --force` + `git worktree prune` +
 * `git branch -D`, refusing unless the persisted branch is namespaced under helm/cycle/<id>/ and
 * differs from the cycle's own base branch. Touches no docs.
 * deleteCycle(cycleId): composes cleanupCycleGit with removal of the cycle's docs folder. DB
 * history (runs/run_tasks/planning_provenance/worker_runtimes) — and the cycles row itself —
 * survive untouched. Both refuse while active workers exist for the cycle.
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
import { GitWorktreeService } from './services/git-worktree-service.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b12-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B12 Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-b12-${process.pid}.db`);
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

describe('B12 cleanupCycleGit + deleteCycle (R2.2, R2.3)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function setup(prefix: string) {
    const repoDir = await initRepo(`helm-b12-${prefix}-`);
    const t = tempDbPath(`helm-b12-${prefix}-db-`);
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const dbs = new DatabaseService(t.dbPath);
    cleanups.push(() => dbs.close());
    const projects = new ProjectService(dbs);
    const gws = new GitWorktreeService(dbs);
    const cycles = new CycleService(dbs, projects, gws);
    const project = projects.createProject({ name: `b12-${prefix}-${Date.now()}`, directory: repoDir });

    return { repoDir, dbs, projects, gws, cycles, project };
  }

  it("cleanupCycleGit removes the worktree + branch and leaves the cycle's docs folder present and intact", async () => {
    const { repoDir, dbs, gws, cycles, project } = await setup('happy');

    const cycle = await cycles.createCycle(project.id, 'Feature Alpha');
    const docDir = cycles.getCycleDocDir(cycle.id);
    const markerPath = path.join(docDir, 'north-star.md');
    fs.writeFileSync(markerPath, '# marker\n');

    const result = await gws.cleanupCycleGit(repoDir, cycle.id);
    expect(result.cleaned).toBe(true);
    expect(result.branch).toBe(cycle.git_branch);

    const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelain).not.toContain(cycle.git_branch!);
    const branches = await git(repoDir, ['branch', '--list', `helm/cycle/${cycle.id}/*`]);
    expect(branches.trim()).toBe('');
    expect(fs.existsSync(cycle.git_worktree_path!)).toBe(false);

    expect(fs.existsSync(docDir)).toBe(true);
    expect(fs.readFileSync(markerPath, 'utf8')).toBe('# marker\n');

    // cycles row itself untouched by the git-only primitive
    const row = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row.git_branch).toBe(cycle.git_branch);
  });

  it('deleteCycle removes both the worktree+branch and the docs folder', async () => {
    const { repoDir, cycles, project } = await setup('delete-both');

    const cycle = await cycles.createCycle(project.id, 'Feature Beta');
    const docDir = cycles.getCycleDocDir(cycle.id);
    expect(fs.existsSync(docDir)).toBe(true);

    await cycles.deleteCycle(cycle.id);

    const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelain).not.toContain(cycle.git_branch!);
    const branches = await git(repoDir, ['branch', '--list', `helm/cycle/${cycle.id}/*`]);
    expect(branches.trim()).toBe('');
    expect(fs.existsSync(docDir)).toBe(false);
  });

  it("never touches main or a peer cycle's branch/worktree — byte-identical after cleanupCycleGit and after deleteCycle", async () => {
    const { repoDir, gws, cycles, project } = await setup('peer-safe');

    const mainShaBefore = (await git(repoDir, ['rev-parse', 'main'])).trim();
    const peer = await cycles.createCycle(project.id, 'Peer Cycle');
    const target = await cycles.createCycle(project.id, 'Target Cycle A');
    const peerShaBefore = (await git(repoDir, ['rev-parse', peer.git_branch!])).trim();

    await gws.cleanupCycleGit(repoDir, target.id);

    expect((await git(repoDir, ['rev-parse', 'main'])).trim()).toBe(mainShaBefore);
    expect((await git(repoDir, ['rev-parse', peer.git_branch!])).trim()).toBe(peerShaBefore);
    const porcelainAfterCleanup = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelainAfterCleanup).toContain(peer.git_branch!);

    const target2 = await cycles.createCycle(project.id, 'Target Cycle B');
    await cycles.deleteCycle(target2.id);

    expect((await git(repoDir, ['rev-parse', 'main'])).trim()).toBe(mainShaBefore);
    expect((await git(repoDir, ['rev-parse', peer.git_branch!])).trim()).toBe(peerShaBefore);
    const porcelainAfterDelete = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelainAfterDelete).toContain(peer.git_branch!);
  });

  it('both refuse when the persisted branch equals its own base branch (fail closed, no mutation)', async () => {
    const { repoDir, dbs, gws, cycles, project } = await setup('base-guard');

    // Corrupt git_base_branch to equal the (still correctly namespaced) real cycle branch, so the
    // namespace check passes and the distinct base-equality guard is what actually fires.
    const cycleA = await cycles.createCycle(project.id, 'Corrupted A');
    dbs.prepare('UPDATE cycles SET git_base_branch = git_branch WHERE id = ?').run(cycleA.id);
    await expect(gws.cleanupCycleGit(repoDir, cycleA.id)).rejects.toThrow(/base branch/);
    // a rejected call must never run `branch -D` — the real worktree/branch stays registered
    const porcelainA = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelainA).toContain(cycleA.git_worktree_path!);

    const cycleB = await cycles.createCycle(project.id, 'Corrupted B');
    dbs.prepare('UPDATE cycles SET git_base_branch = git_branch WHERE id = ?').run(cycleB.id);
    await expect(cycles.deleteCycle(cycleB.id)).rejects.toThrow(/base branch/);
    expect(fs.existsSync(cycles.getCycleDocDir(cycleB.id))).toBe(true);
  });

  it('both refuse when the persisted branch is outside the helm/cycle/<id>/ namespace (fail closed, no mutation)', async () => {
    const { dbs, gws, cycles, project, repoDir } = await setup('namespace-guard');

    const cycleA = await cycles.createCycle(project.id, 'Mismatch A');
    dbs.prepare('UPDATE cycles SET git_branch = ? WHERE id = ?').run(`helm/cycle/999999/other`, cycleA.id);
    await expect(gws.cleanupCycleGit(repoDir, cycleA.id)).rejects.toThrow(/namespace/);
    // the real (still-correct) worktree for cycleA must remain registered — refusal is total
    const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelain).toContain(cycleA.git_worktree_path!);

    const cycleB = await cycles.createCycle(project.id, 'Mismatch B');
    dbs.prepare('UPDATE cycles SET git_branch = ? WHERE id = ?').run(`not-namespaced-at-all`, cycleB.id);
    await expect(cycles.deleteCycle(cycleB.id)).rejects.toThrow(/namespace/);
    expect(fs.existsSync(cycles.getCycleDocDir(cycleB.id))).toBe(true);
  });

  it('both refuse while active workers exist for the cycle, leaving worktree/branch/docs untouched', async () => {
    const { dbs, gws, cycles, project, repoDir } = await setup('active-workers');

    const cycle = await cycles.createCycle(project.id, 'Busy Cycle');
    const run = dbs
      .prepare(`INSERT INTO runs (project_id, cycle_id, status) VALUES (?, ?, 'active') RETURNING id`)
      .get(project.id, cycle.id) as any;
    dbs
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, state, run_id) VALUES (?, 'dev', 'anthropic', 'test-model', 'running', ?)`
      )
      .run(project.id, run.id);

    await expect(gws.cleanupCycleGit(repoDir, cycle.id)).rejects.toThrow(/active agents|open handles/);
    await expect(cycles.deleteCycle(cycle.id)).rejects.toThrow(/active agents|open handles/);

    const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelain).toContain(cycle.git_branch!);
    expect(fs.existsSync(cycles.getCycleDocDir(cycle.id))).toBe(true);
  });

  it('sqlite3 proves runs/run_tasks/planning_provenance/worker_runtimes rows — and the cycles row itself — survive delete', async () => {
    const { dbs, cycles, project } = await setup('db-survives');

    const cycle = await cycles.createCycle(project.id, 'Audited Cycle');
    const run = dbs
      .prepare(`INSERT INTO runs (project_id, cycle_id, status) VALUES (?, ?, 'complete') RETURNING id`)
      .get(project.id, cycle.id) as any;
    dbs.prepare(`INSERT INTO run_tasks (run_id, label, status) VALUES (?, 'task one', 'complete')`).run(run.id);
    dbs
      .prepare(
        `INSERT INTO worker_runtimes (project_id, role, provider, model, state, run_id) VALUES (?, 'dev', 'anthropic', 'test-model', 'done', ?)`
      )
      .run(project.id, run.id);
    dbs
      .prepare(
        `INSERT INTO planning_provenance (project_id, cycle_id, planning_run_id, manifest_digest, plan_sha256) VALUES (?, ?, ?, 'digest-abc', 'sha-abc')`
      )
      .run(project.id, cycle.id, run.id);

    const before = {
      runs: (dbs.prepare('SELECT COUNT(*) AS c FROM runs WHERE cycle_id = ?').get(cycle.id) as any).c,
      run_tasks: (dbs.prepare('SELECT COUNT(*) AS c FROM run_tasks WHERE run_id = ?').get(run.id) as any).c,
      worker_runtimes: (dbs.prepare('SELECT COUNT(*) AS c FROM worker_runtimes WHERE run_id = ?').get(run.id) as any)
        .c,
      planning_provenance: (
        dbs.prepare('SELECT COUNT(*) AS c FROM planning_provenance WHERE cycle_id = ?').get(cycle.id) as any
      ).c,
    };
    expect(before).toEqual({ runs: 1, run_tasks: 1, worker_runtimes: 1, planning_provenance: 1 });

    await cycles.deleteCycle(cycle.id);

    const after = {
      runs: (dbs.prepare('SELECT COUNT(*) AS c FROM runs WHERE cycle_id = ?').get(cycle.id) as any).c,
      run_tasks: (dbs.prepare('SELECT COUNT(*) AS c FROM run_tasks WHERE run_id = ?').get(run.id) as any).c,
      worker_runtimes: (dbs.prepare('SELECT COUNT(*) AS c FROM worker_runtimes WHERE run_id = ?').get(run.id) as any)
        .c,
      planning_provenance: (
        dbs.prepare('SELECT COUNT(*) AS c FROM planning_provenance WHERE cycle_id = ?').get(cycle.id) as any
      ).c,
    };
    expect(after).toEqual(before);

    const cycleRow = dbs.prepare('SELECT * FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(cycleRow).toBeTruthy();
    expect(cycleRow.id).toBe(cycle.id);
  });
});
