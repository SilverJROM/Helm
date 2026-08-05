/**
 * cycle-branch-lifecycle B13 — Delete API (R2.1, R2.4, R3.2).
 *
 * DELETE /api/cycles/:id restricted to status IN ('completed','archived') with 409 otherwise;
 * GET /api/cycles/:id/delete-preflight returns the B5 branchSafetyReport facts.
 *
 * Focused acceptance:
 *   - delete from Active returns 409 and nothing is removed
 *   - delete from Completed and from Archived both succeed
 *   - preflight returns the safety report facts for a merged and an unmerged branch
 */
import { describe, it, expect, afterEach } from 'vitest';
import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { GitWorktreeService } from './services/git-worktree-service.js';
import { createRequireOwner } from './auth/auth-middleware.js';
import { registerCycleDeleteRoutes } from './api/routes/cycle-delete-routes.js';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b13-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B13 Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-b13-${process.pid}.db`);
  return {
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  };
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

describe('B13 cycle delete API (R2.1, R2.4, R3.2)', () => {
  const cleanups: Array<() => void> = [];

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  async function setup(prefix: string) {
    const repoDir = await initRepo(`helm-b13-${prefix}-`);
    const t = tempDbPath(`helm-b13-${prefix}-db-`);
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const dbs = new DatabaseService(t.dbPath);
    cleanups.push(() => dbs.close());
    const projects = new ProjectService(dbs);
    const gws = new GitWorktreeService(dbs);
    const cycles = new CycleService(dbs, projects, gws);
    const project = projects.createProject({ name: `b13-${prefix}-${Date.now()}`, directory: repoDir });

    const app = Fastify({ logger: false });
    const requireOwnerPre = createRequireOwner();
    registerCycleDeleteRoutes(app, {
      db: dbs,
      cycleService: cycles,
      authMiddleware: ownerAuth,
      requireOwnerPre
    });
    await app.ready();
    cleanups.push(() => {
      void app.close();
    });

    return { repoDir, dbs, cycles, project, app };
  }

  /** Move docs under cycle/completed/ and flip status so getCycleDocDir + R2.1 gate agree. */
  function markTerminal(
    dbs: DatabaseService,
    cycles: CycleService,
    projectDir: string,
    cycleId: number,
    status: 'completed' | 'archived'
  ): string {
    const row = dbs.prepare('SELECT folder_name FROM cycles WHERE id = ?').get(cycleId) as {
      folder_name: string;
    };
    const source = path.join(projectDir, 'cycle', row.folder_name);
    const target = path.join(projectDir, 'cycle', 'completed', row.folder_name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(source)) {
      fs.renameSync(source, target);
    } else {
      fs.mkdirSync(target, { recursive: true });
    }
    dbs.prepare(`UPDATE cycles SET status = ?, phase = 'complete' WHERE id = ?`).run(status, cycleId);
    return cycles.getCycleDocDir(cycleId);
  }

  it('DELETE from Active returns 409 and nothing is removed', async () => {
    const { repoDir, dbs, cycles, project, app } = await setup('active-409');

    const cycle = await cycles.createCycle(project.id, 'Still Active');
    expect(cycle.status).toBe('active');
    const docDir = cycles.getCycleDocDir(cycle.id);
    const marker = path.join(docDir, 'north-star.md');
    fs.writeFileSync(marker, '# keep\n');
    const branchBefore = cycle.git_branch!;
    const worktreeBefore = cycle.git_worktree_path!;

    const res = await app.inject({
      method: 'DELETE',
      url: `/api/cycles/${cycle.id}`,
      remoteAddress: '127.0.0.1'
    });
    expect(res.statusCode).toBe(409);
    expect(String(res.json().error || '')).toMatch(/active|completed or archived/i);

    // nothing removed: docs, worktree, branch, DB row
    expect(fs.existsSync(marker)).toBe(true);
    expect(fs.readFileSync(marker, 'utf8')).toBe('# keep\n');
    expect(fs.existsSync(worktreeBefore)).toBe(true);
    const porcelain = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelain).toContain(branchBefore);
    const branches = await git(repoDir, ['branch', '--list', branchBefore]);
    expect(branches.trim().length).toBeGreaterThan(0);
    const row = dbs.prepare('SELECT id, status FROM cycles WHERE id = ?').get(cycle.id) as any;
    expect(row).toBeTruthy();
    expect(row.status).toBe('active');
  });

  it('DELETE from Completed and from Archived both succeed (worktree+branch+docs gone; DB history stays)', async () => {
    const { repoDir, dbs, cycles, project, app } = await setup('terminal-ok');

    // --- Completed ---
    const completed = await cycles.createCycle(project.id, 'Done Cycle');
    const completedDoc = markTerminal(dbs, cycles, project.directory, completed.id, 'completed');
    fs.writeFileSync(path.join(completedDoc, 'og-requirements.md'), '# done\n');
    const completedBranch = completed.git_branch!;
    const completedWt = completed.git_worktree_path!;
    const completedRun = dbs
      .prepare(`INSERT INTO runs (project_id, cycle_id, status) VALUES (?, ?, 'complete') RETURNING id`)
      .get(project.id, completed.id) as { id: number };

    const completedRes = await app.inject({
      method: 'DELETE',
      url: `/api/cycles/${completed.id}`,
      remoteAddress: '127.0.0.1'
    });
    expect(completedRes.statusCode).toBe(200);
    expect(completedRes.json().cycle.id).toBe(completed.id);

    expect(fs.existsSync(completedDoc)).toBe(false);
    expect(fs.existsSync(completedWt)).toBe(false);
    const porcelainDone = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelainDone).not.toContain(completedBranch);
    const branchesDone = await git(repoDir, ['branch', '--list', completedBranch]);
    expect(branchesDone.trim()).toBe('');
    // DB history + cycles row survive (R2.2(d) / B12)
    expect(dbs.prepare('SELECT id FROM cycles WHERE id = ?').get(completed.id)).toBeTruthy();
    expect(
      (dbs.prepare('SELECT COUNT(*) AS c FROM runs WHERE cycle_id = ?').get(completed.id) as any).c
    ).toBe(1);
    expect(dbs.prepare('SELECT id FROM runs WHERE id = ?').get(completedRun.id)).toBeTruthy();

    // --- Archived ---
    const archived = await cycles.createCycle(project.id, 'Archived Cycle');
    const archivedDoc = markTerminal(dbs, cycles, project.directory, archived.id, 'archived');
    fs.writeFileSync(path.join(archivedDoc, 'north-star.md'), '# archived\n');
    const archivedBranch = archived.git_branch!;
    const archivedWt = archived.git_worktree_path!;

    const archivedRes = await app.inject({
      method: 'DELETE',
      url: `/api/cycles/${archived.id}`,
      remoteAddress: '127.0.0.1'
    });
    expect(archivedRes.statusCode).toBe(200);
    expect(archivedRes.json().cycle.id).toBe(archived.id);

    expect(fs.existsSync(archivedDoc)).toBe(false);
    expect(fs.existsSync(archivedWt)).toBe(false);
    const porcelainArch = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelainArch).not.toContain(archivedBranch);
    const branchesArch = await git(repoDir, ['branch', '--list', archivedBranch]);
    expect(branchesArch.trim()).toBe('');
    expect(dbs.prepare('SELECT id FROM cycles WHERE id = ?').get(archived.id)).toBeTruthy();
  });

  it('GET delete-preflight returns B5 safety report facts for a merged and an unmerged branch', async () => {
    const { repoDir, dbs, cycles, project, app } = await setup('preflight-facts');

    // Unmerged: cycle branch with unique commits not ancestor-merged into main
    const unmerged = await cycles.createCycle(project.id, 'Unmerged Branch');
    expect(unmerged.git_branch).toBeTruthy();
    expect(unmerged.git_worktree_path).toBeTruthy();
    fs.writeFileSync(path.join(unmerged.git_worktree_path!, 'unmerged.txt'), 'unique work\n');
    await git(unmerged.git_worktree_path!, ['add', 'unmerged.txt']);
    await git(unmerged.git_worktree_path!, ['commit', '-m', 'unmerged commit']);

    const unmergedRes = await app.inject({
      method: 'GET',
      url: `/api/cycles/${unmerged.id}/delete-preflight`,
      remoteAddress: '127.0.0.1'
    });
    expect(unmergedRes.statusCode).toBe(200);
    const unmergedBody = unmergedRes.json();
    expect(unmergedBody.report).toBeTruthy();
    expect(Object.keys(unmergedBody.report).sort()).toEqual(['facts', 'narrative']);
    expect(unmergedBody.report).not.toHaveProperty('decision');
    expect(unmergedBody.report).not.toHaveProperty('verdict');
    expect(unmergedBody.report).not.toHaveProperty('allow');
    expect(unmergedBody.report.facts.exists).toBe(true);
    expect(unmergedBody.report.facts.mergedInto).not.toContain('main');
    expect(unmergedBody.report.facts.worktreePath).toBeTruthy();

    // Merged: another cycle branch whose tip is ancestor of main after a real merge
    const merged = await cycles.createCycle(project.id, 'Merged Branch');
    fs.writeFileSync(path.join(merged.git_worktree_path!, 'merged.txt'), 'will merge\n');
    await git(merged.git_worktree_path!, ['add', 'merged.txt']);
    await git(merged.git_worktree_path!, ['commit', '-m', 'merged commit']);
    // merge into main from the project root (primary worktree)
    await git(repoDir, ['merge', '--no-ff', '-m', 'merge cycle branch', merged.git_branch!]);

    const mergedRes = await app.inject({
      method: 'GET',
      url: `/api/cycles/${merged.id}/delete-preflight`,
      remoteAddress: '127.0.0.1'
    });
    expect(mergedRes.statusCode).toBe(200);
    const mergedBody = mergedRes.json();
    expect(mergedBody.report).toBeTruthy();
    expect(Object.keys(mergedBody.report).sort()).toEqual(['facts', 'narrative']);
    expect(mergedBody.report.facts.exists).toBe(true);
    expect(mergedBody.report.facts.mergedInto).toContain('main');

    // unknown cycle → 404
    const missing = await app.inject({
      method: 'GET',
      url: `/api/cycles/999999/delete-preflight`,
      remoteAddress: '127.0.0.1'
    });
    expect(missing.statusCode).toBe(404);

    // silence unused if any static analysis path
    expect(dbs).toBeTruthy();
  });
});
