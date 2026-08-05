/**
 * cycle-branch-lifecycle B20 — R7.1 discovery-time sequencing: survey (B4/B5) -> JROM's live base
 * choice -> ONLY THEN B6. This is the exactly-one cycle-start call site into B6 (replaces B10's
 * provisional default-base call site rather than adding a second one). Synthetic DB + temp git
 * repo fixtures only.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseService } from '../db/database.js';
import { surveyCycleBranches, establishCycleBranch } from './cycle-branch-onboarding-service.js';

const execFileAsync = promisify(execFile);
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b20-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B20 Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-b20-${process.pid}.db`);
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

function insertProject(db: DatabaseService, directory: string): number {
  const row = db
    .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
    .get(`helm-b20-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`, directory) as any;
  return Number(row.id);
}

function insertCycle(
  db: DatabaseService,
  projectId: number,
  opts: { name: string; folderName: string; gitBranch?: string | null; status?: string }
): number {
  const row = db
    .prepare(
      `INSERT INTO cycles (project_id, name, folder_name, autonomy, status, git_branch, git_base_branch)
       VALUES (?, ?, ?, 'autonomous_after_discovery', ?, ?, ?)
       RETURNING id`
    )
    .get(
      projectId,
      opts.name,
      opts.folderName,
      opts.status ?? 'active',
      opts.gitBranch ?? null,
      opts.gitBranch ? 'main' : null
    ) as any;
  return Number(row.id);
}

describe('cycle-branch-lifecycle B20: survey -> JROM live choice -> ONLY THEN B6 (R7.1, R4.2, R3.2)', () => {
  const cleanups: Array<() => void> = [];
  const prevJanitor = process.env.HELM_SESSION_JANITOR;

  beforeEach(() => {
    process.env.HELM_SESSION_JANITOR = '0';
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
    if (prevJanitor === undefined) delete process.env.HELM_SESSION_JANITOR;
    else process.env.HELM_SESSION_JANITOR = prevJanitor;
  });

  it('survey of a repo with a stale branch and a merged branch lists both with correct merged/stale facts', async () => {
    const repoDir = await initRepo('helm-b20-survey-');
    const t = tempDbPath('helm-b20-survey-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    await git(repoDir, ['checkout', '-b', 'merged-branch']);
    fs.writeFileSync(path.join(repoDir, 'merged.txt'), 'merged work\n');
    await git(repoDir, ['add', 'merged.txt']);
    await git(repoDir, ['commit', '-m', 'merged commit']);
    await git(repoDir, ['checkout', 'main']);
    await git(repoDir, ['merge', '--no-ff', '-m', 'merge it', 'merged-branch']);

    await git(repoDir, ['checkout', '-b', 'stale-branch']);
    fs.writeFileSync(path.join(repoDir, 'stale.txt'), 'stale work\n');
    await git(repoDir, ['add', 'stale.txt']);
    await git(repoDir, ['commit', '-m', 'stale commit']);
    await git(repoDir, ['checkout', 'main']);

    const db = new DatabaseService(t.dbPath);
    const projectId = insertProject(db, repoDir);
    // Sibling cycles own the pre-existing branches; the surveyed cycle is a fresh one with no
    // git identity yet — exactly the shape a real cycle-start survey runs against.
    insertCycle(db, projectId, { name: 'merged work', folderName: 'merged-work_0101', gitBranch: 'merged-branch', status: 'completed' });
    insertCycle(db, projectId, { name: 'stale work', folderName: 'stale-work_0102', gitBranch: 'stale-branch', status: 'active' });
    const newCycleId = insertCycle(db, projectId, { name: 'new task', folderName: 'new-task_0103' });

    const survey = await surveyCycleBranches(newCycleId, db);

    expect(survey.degraded).toBe(false);
    expect(survey.branches).toHaveLength(2);

    const merged = survey.branches.find((b) => b.branch === 'merged-branch');
    const stale = survey.branches.find((b) => b.branch === 'stale-branch');
    expect(merged).toBeTruthy();
    expect(stale).toBeTruthy();
    expect(merged!.report.facts.exists).toBe(true);
    expect(merged!.report.facts.mergedInto).toContain('main');
    expect(stale!.report.facts.exists).toBe(true);
    expect(stale!.report.facts.mergedInto).toEqual([]);
    // facts-only — no decision/verdict/allow field leaks through the survey (R3.1).
    expect(merged!.report).not.toHaveProperty('decision');

    db.close();
  });

  it('no branch or worktree exists before the choice is recorded, and an OVERRIDE base is honored (not main) once establishCycleBranch runs', async () => {
    const repoDir = await initRepo('helm-b20-override-');
    const t = tempDbPath('helm-b20-override-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    await git(repoDir, ['checkout', '-b', 'release']);
    fs.writeFileSync(path.join(repoDir, 'release.txt'), 'release work\n');
    await git(repoDir, ['add', 'release.txt']);
    await git(repoDir, ['commit', '-m', 'release commit']);
    await git(repoDir, ['checkout', 'main']);

    const mainSha = (await git(repoDir, ['rev-parse', 'main'])).trim();
    const releaseSha = (await git(repoDir, ['rev-parse', 'release'])).trim();
    expect(releaseSha).not.toBe(mainSha);

    const db = new DatabaseService(t.dbPath);
    const projectId = insertProject(db, repoDir);
    const cycleId = insertCycle(db, projectId, { name: 'needs override base', folderName: 'needs-override-base_0104' });

    // Cycle start has happened (row exists) but the choice has not been recorded yet — no branch,
    // no worktree.
    const branchesBefore = (await git(repoDir, ['branch', '--list', `helm/cycle/${cycleId}/*`])).trim();
    expect(branchesBefore).toBe('');
    const worktreesBefore = await git(repoDir, ['worktree', 'list', '--porcelain']);
    expect(worktreesBefore).not.toContain(`helm/cycle/${cycleId}/`);

    const identity = await establishCycleBranch({ cycleId, db, chosenBase: 'release' });

    expect(identity.baseBranch).toBe('release');
    expect(identity.baseSha).toBe(releaseSha);
    expect(identity.baseSha).not.toBe(mainSha);
    const branchSha = (await git(repoDir, ['rev-parse', identity.branch])).trim();
    expect(branchSha).toBe(releaseSha);

    db.close();
  });

  it('a default (unspecified) choice bases the branch on main', async () => {
    const repoDir = await initRepo('helm-b20-default-');
    const t = tempDbPath('helm-b20-default-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const mainSha = (await git(repoDir, ['rev-parse', 'main'])).trim();

    const db = new DatabaseService(t.dbPath);
    const projectId = insertProject(db, repoDir);
    const cycleId = insertCycle(db, projectId, { name: 'default base', folderName: 'default-base_0105' });

    const identity = await establishCycleBranch({ cycleId, db });

    expect(identity.baseBranch).toBe('main');
    expect(identity.baseSha).toBe(mainSha);

    db.close();
  });

  it('survey failure (unknown cycle) degrades non-blocking rather than throwing/blocking cycle start', async () => {
    const t = tempDbPath('helm-b20-degrade-db-');
    cleanups.push(t.cleanup);
    const db = new DatabaseService(t.dbPath);

    const survey = await surveyCycleBranches(999999, db);

    expect(survey.degraded).toBe(true);
    expect(survey.branches).toEqual([]);

    db.close();
  });

  it('grep proves exactly one cycle-start call site to B6 (`.createCycleWorktree(`)', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
          files.push(full);
        }
      }
    };
    walk(SRC_DIR);

    const callPattern = /\.createCycleWorktree\s*\(/;
    const callSites = files.filter((f) => callPattern.test(fs.readFileSync(f, 'utf8')));

    expect(callSites).toHaveLength(1);
    expect(callSites[0]).toBe(path.join(SRC_DIR, 'services', 'cycle-branch-onboarding-service.ts'));
  });
});
