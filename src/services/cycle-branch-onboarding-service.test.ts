/**
 * cycle-branch-lifecycle B20 — R7.1 cycle-start sequencing: survey (B4/B5) -> JROM's live base
 * choice -> ONLY THEN B6. Drives the PRODUCTION path end-to-end: the same
 * `startCycleWithBranchOnboarding` that `POST /api/projects/:id/cycles` calls, the real
 * CycleService, and the real route module registered by src/index.ts via app.inject() — no
 * re-declared handlers and no stand-in for the code under test. Synthetic DB + temp git repos only.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseService } from '../db/database.js';
import { ProjectService } from './project-service.js';
import { CycleService } from './cycle-service.js';
import { createRequireOwner } from '../auth/auth-middleware.js';
import { createRequireLocalLaunch } from '../guardrails.js';
import { registerCycleBranchOnboardingRoutes } from '../api/routes/cycle-branch-onboarding-routes.js';
import {
  surveyCycleBranches,
  establishCycleBranch,
  startCycleWithBranchOnboarding
} from './cycle-branch-onboarding-service.js';

const execFileAsync = promisify(execFile);
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_TS = path.join(SRC_DIR, 'index.ts');

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

function insertSiblingCycle(
  db: DatabaseService,
  projectId: number,
  opts: { name: string; folderName: string; gitBranch: string; status?: string }
): number {
  const row = db
    .prepare(
      `INSERT INTO cycles (project_id, name, folder_name, autonomy, status, git_branch, git_base_branch)
       VALUES (?, ?, ?, 'autonomous_after_discovery', ?, ?, 'main')
       RETURNING id`
    )
    .get(projectId, opts.name, opts.folderName, opts.status ?? 'active', opts.gitBranch) as any;
  return Number(row.id);
}

function ownerAuth(req: any, _reply: any, done?: () => void) {
  req.user = { role: 'owner' };
  done?.();
}

/** The real route module, wired exactly as src/index.ts wires it. */
async function buildApp(db: DatabaseService) {
  const app = Fastify({ logger: false });
  registerCycleBranchOnboardingRoutes(app, {
    db,
    authMiddleware: ownerAuth,
    requireOwnerPre: createRequireOwner(),
    requireLocalLaunchPre: createRequireLocalLaunch()
  });
  await app.ready();
  return app;
}

/** Real services — the production objects the API boundary holds. */
function realServices(dbPath: string, projectDir: string) {
  const db = new DatabaseService(dbPath);
  const projectService = new ProjectService(db);
  const cycleService = new CycleService(db, projectService);
  const project = projectService.createProject({
    name: `helm-b20-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    directory: projectDir
  }) as any;
  return { db, projectService, cycleService, projectId: Number(project.id) };
}

async function cycleBranchesOnDisk(repoDir: string, cycleId: number): Promise<string> {
  return (await git(repoDir, ['branch', '--list', `helm/cycle/${cycleId}/*`])).trim();
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

  it('production cycle start surveys a stale + a merged branch with correct facts, and creates NO branch or worktree yet', async () => {
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

    const { db, cycleService, projectId } = realServices(t.dbPath, repoDir);
    cleanups.push(() => db.close());
    insertSiblingCycle(db, projectId, {
      name: 'merged work',
      folderName: 'merged-work_0101',
      gitBranch: 'merged-branch',
      status: 'completed'
    });
    insertSiblingCycle(db, projectId, {
      name: 'stale work',
      folderName: 'stale-work_0102',
      gitBranch: 'stale-branch'
    });

    // THE production cycle-start entry (src/index.ts POST /api/projects/:id/cycles calls this).
    const started = await startCycleWithBranchOnboarding({
      cycleService,
      db,
      projectId,
      name: 'new task'
    });

    expect(started.cycle.id).toBeGreaterThan(0);
    expect(started.survey.degraded).toBe(false);
    expect(started.survey.branches).toHaveLength(2);

    const merged = started.survey.branches.find((b) => b.branch === 'merged-branch');
    const stale = started.survey.branches.find((b) => b.branch === 'stale-branch');
    expect(merged).toBeTruthy();
    expect(stale).toBeTruthy();
    expect(merged!.report.facts.exists).toBe(true);
    expect(merged!.report.facts.mergedInto).toContain('main');
    expect(stale!.report.facts.exists).toBe(true);
    expect(stale!.report.facts.mergedInto).toEqual([]);
    expect(stale!.report.facts.tiedToActiveCycleId).toBeTruthy();
    // facts-only — no decision/verdict/allow field leaks through the survey (R3.1).
    expect(merged!.report).not.toHaveProperty('decision');

    // R7.1 sequencing: the survey happened, the choice has NOT — so B6 must not have run.
    expect(started.awaitingBaseChoice).toBe(true);
    expect(started.defaultBase).toBe('main');
    const row = db.prepare('SELECT * FROM cycles WHERE id = ?').get(started.cycle.id) as any;
    expect(row.git_branch).toBeNull();
    expect(row.git_worktree_path).toBeNull();
    expect(await cycleBranchesOnDisk(repoDir, started.cycle.id)).toBe('');
    expect(await git(repoDir, ['worktree', 'list', '--porcelain'])).not.toContain(
      `helm/cycle/${started.cycle.id}/`
    );
    expect(fs.existsSync(path.join(repoDir, 'cycle', '.worktrees', String(started.cycle.id)))).toBe(false);
  });

  it('GET /api/cycles/:id/branch-survey (real route) serves discovery the same facts', async () => {
    const repoDir = await initRepo('helm-b20-route-survey-');
    const t = tempDbPath('helm-b20-route-survey-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    await git(repoDir, ['checkout', '-b', 'sibling-branch']);
    fs.writeFileSync(path.join(repoDir, 'sibling.txt'), 'sibling work\n');
    await git(repoDir, ['add', 'sibling.txt']);
    await git(repoDir, ['commit', '-m', 'sibling commit']);
    await git(repoDir, ['checkout', 'main']);

    const { db, cycleService, projectId } = realServices(t.dbPath, repoDir);
    cleanups.push(() => db.close());
    insertSiblingCycle(db, projectId, {
      name: 'sibling work',
      folderName: 'sibling-work_0201',
      gitBranch: 'sibling-branch'
    });
    const started = await startCycleWithBranchOnboarding({ cycleService, db, projectId, name: 'route survey' });

    const app = await buildApp(db);
    try {
      const res = await app.inject({
        method: 'GET',
        url: `/api/cycles/${started.cycle.id}/branch-survey`,
        remoteAddress: '127.0.0.1'
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.survey.degraded).toBe(false);
      expect(body.survey.branches).toHaveLength(1);
      expect(body.survey.branches[0].branch).toBe('sibling-branch');
      expect(body.survey.branches[0].report.facts.exists).toBe(true);
      expect(body.survey.branches[0].report).not.toHaveProperty('decision');
    } finally {
      await app.close();
    }
  });

  it('POST /api/cycles/:id/branch-base (real route) with an OVERRIDE base: B6 runs only after the choice and the cycle branch equals the override SHA, not main', async () => {
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

    const { db, cycleService, projectId } = realServices(t.dbPath, repoDir);
    cleanups.push(() => db.close());
    const started = await startCycleWithBranchOnboarding({
      cycleService,
      db,
      projectId,
      name: 'needs override base'
    });
    const cycleId = started.cycle.id;

    // Nothing git-side exists yet: cycle start stopped at the survey.
    expect(await cycleBranchesOnDisk(repoDir, cycleId)).toBe('');
    expect(await git(repoDir, ['worktree', 'list', '--porcelain'])).not.toContain(`helm/cycle/${cycleId}/`);

    const app = await buildApp(db);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/branch-base`,
        payload: { base: 'release' },
        remoteAddress: '127.0.0.1'
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.base).toBe('release');
      expect(body.git_identity.baseBranch).toBe('release');
      expect(body.git_identity.baseSha).toBe(releaseSha);
      expect(body.git_identity.baseSha).not.toBe(mainSha);

      // R4.2 on real git state, not just the response.
      const branch = String(body.git_identity.branch);
      expect(branch).toBe(`helm/cycle/${cycleId}/needs-override-base`);
      expect((await git(repoDir, ['rev-parse', branch])).trim()).toBe(releaseSha);
      expect((await git(repoDir, ['rev-parse', branch])).trim()).not.toBe(mainSha);
      expect(await git(repoDir, ['worktree', 'list', '--porcelain'])).toContain(`branch refs/heads/${branch}`);

      // identity persisted by the same call
      expect(body.cycle.git_branch).toBe(branch);
      expect(body.cycle.git_base_branch).toBe('release');
      const row = db.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
      expect(row.git_branch).toBe(branch);
      expect(fs.existsSync(String(row.git_worktree_path))).toBe(true);

      // a second choice cannot open a second B6 call site for the same cycle
      const again = await app.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/branch-base`,
        payload: { base: 'main' },
        remoteAddress: '127.0.0.1'
      });
      expect(again.statusCode).toBe(409);
      expect((db.prepare('SELECT git_branch FROM cycles WHERE id = ?').get(cycleId) as any).git_branch).toBe(branch);
    } finally {
      await app.close();
      // detach the worktree before the temp repo is removed
      try { await git(repoDir, ['worktree', 'remove', '--force', path.join(repoDir, 'cycle', '.worktrees', String(cycleId))]); } catch { /* ignore */ }
    }
  });

  it('POST /api/cycles/:id/branch-base with no base recorded: JROM took the offered default, branch is cut from main', async () => {
    const repoDir = await initRepo('helm-b20-default-');
    const t = tempDbPath('helm-b20-default-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const mainSha = (await git(repoDir, ['rev-parse', 'main'])).trim();

    const { db, cycleService, projectId } = realServices(t.dbPath, repoDir);
    cleanups.push(() => db.close());
    const started = await startCycleWithBranchOnboarding({ cycleService, db, projectId, name: 'default base' });
    const cycleId = started.cycle.id;

    const app = await buildApp(db);
    try {
      const res = await app.inject({
        method: 'POST',
        url: `/api/cycles/${cycleId}/branch-base`,
        payload: {},
        remoteAddress: '127.0.0.1'
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.base).toBe('main');
      expect(body.git_identity.baseSha).toBe(mainSha);
      expect((await git(repoDir, ['rev-parse', String(body.git_identity.branch)])).trim()).toBe(mainSha);
    } finally {
      await app.close();
      try { await git(repoDir, ['worktree', 'remove', '--force', path.join(repoDir, 'cycle', '.worktrees', String(cycleId))]); } catch { /* ignore */ }
    }
  });

  it('a failing survey degrades non-blocking: the cycle is still started (row + folder on disk) and the choice step still works', async () => {
    const repoDir = await initRepo('helm-b20-degrade-');
    const t = tempDbPath('helm-b20-degrade-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const { db, cycleService, projectId } = realServices(t.dbPath, repoDir);
    cleanups.push(() => db.close());

    // Real fault injection on the DB the survey reads through — the cycle-start code under test is
    // untouched. Everything else (CycleService, the real DB) stays real.
    const surveyBroken = new Proxy(db, {
      get(target, prop, receiver) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (/FROM cycles WHERE id = \?/.test(sql)) throw new Error('injected survey DB failure');
            return (target as any).prepare(sql);
          };
        }
        return Reflect.get(target as any, prop, receiver);
      }
    }) as DatabaseService;

    const started = await startCycleWithBranchOnboarding({
      cycleService,
      db: surveyBroken,
      projectId,
      name: 'survey blows up'
    });

    expect(started.survey.degraded).toBe(true);
    expect(started.survey.branches).toEqual([]);
    // cycle start itself completed anyway (R7.3)
    const row = db.prepare('SELECT * FROM cycles WHERE id = ?').get(started.cycle.id) as any;
    expect(row).toBeTruthy();
    expect(fs.existsSync(path.join(repoDir, 'cycle', String(row.folder_name)))).toBe(true);
    expect(row.git_branch).toBeNull();

    // and the interview/choice step is not blocked by the degraded survey
    const identity = await establishCycleBranch({ cycleId: started.cycle.id, db });
    cleanups.push(() => {
      try { fs.rmSync(identity.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    });
    expect(identity.baseBranch).toBe('main');

    // the survey primitive itself never throws upward either (unknown cycle)
    const unknown = await surveyCycleBranches(999999, db);
    expect(unknown.degraded).toBe(true);
    expect(unknown.branches).toEqual([]);

    // ...and the route surfaces that as a 200 degraded survey, never a 5xx that blocks discovery
    const app = await buildApp(db);
    try {
      const res = await app.inject({
        method: 'GET',
        url: '/api/cycles/999999/branch-survey',
        remoteAddress: '127.0.0.1'
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().survey.degraded).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('grep proves cycle-start B6 call sites are only onboarding + B10a provisional create', () => {
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
    const callSites = files
      .filter((f) => callPattern.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC_DIR, f))
      .sort();

    // B10a: CycleService.createCycle (provisional default main; skipped by onboarding via
    // skipGitWorktree). B20: establishCycleBranch after live base choice (the live production path).
    expect(callSites).toEqual([
      'services/cycle-branch-onboarding-service.ts',
      'services/cycle-service.ts',
    ]);
  });

  it('src/index.ts wires production cycle start into survey -> choice -> B6 (no bypass call site)', () => {
    const index = fs.readFileSync(INDEX_TS, 'utf8');

    // the cycle-start route and the two follow-on routes are both registered from production code
    expect(index).toMatch(
      /import\s*\{[^}]*\bstartCycleWithBranchOnboarding\b[^}]*\}\s*from\s*"\.\/services\/cycle-branch-onboarding-service\.js"/
    );
    expect(index).toContain('registerCycleBranchOnboardingRoutes(app, {');

    // POST /api/projects/:id/cycles goes through the onboarding entry, and no longer creates a
    // cycle behind the survey's back.
    const routeStart = index.indexOf("app.post('/api/projects/:id/cycles'");
    expect(routeStart).toBeGreaterThan(-1);
    const routeEnd = index.indexOf("app.get('/api/cycles/overview'", routeStart);
    expect(routeEnd).toBeGreaterThan(routeStart);
    const handler = index.slice(routeStart, routeEnd);
    expect(handler).toContain('startCycleWithBranchOnboarding({');
    expect(handler).toContain('branch_survey');
    expect(handler).not.toMatch(/cycleService\.createCycle\s*\(/);
  });
});
