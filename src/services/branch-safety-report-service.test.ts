/**
 * cycle-branch-lifecycle B5 — branchSafetyReport(cycleId) call-site wiring (R3.2, R5).
 * Composes B4's deterministic facts with an optional B3 house-agent narrative; never a
 * decision/verdict/allow field. Synthetic DB + temp git repo fixtures only.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseService } from '../db/database.js';
import { AgentAssignmentService } from './agent-assignment-service.js';
import { branchSafetyReport } from './branch-safety-report-service.js';

const execFileAsync = promisify(execFile);
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b5-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B5 Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

function tempDbPath(prefix: string): { dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const dbPath = path.join(dir, `helm-b5-${process.pid}.db`);
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

function insertProjectAndCycle(
  db: DatabaseService,
  projectDir: string,
  branch: string,
  cycleStatus = 'completed'
): number {
  const project = db
    .prepare(`INSERT INTO projects (name, directory) VALUES (?, ?) RETURNING id`)
    .get(`helm-b5-proj-${Date.now()}-${Math.random().toString(36).slice(2)}`, projectDir) as any;
  const cycle = db
    .prepare(
      `INSERT INTO cycles (project_id, name, folder_name, autonomy, status, git_branch, git_base_branch)
       VALUES (?, 'cycle', 'cycle-folder', 'autonomous_after_discovery', ?, ?, 'main')
       RETURNING id`
    )
    .get(Number(project.id), cycleStatus, branch) as any;
  return Number(cycle.id);
}

describe('cycle-branch-lifecycle B5: branchSafetyReport(cycleId)', () => {
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

  it('report shape is facts + narrative only, with no decision/verdict/allow key', async () => {
    const repoDir = await initRepo('helm-b5-shape-');
    const t = tempDbPath('helm-b5-shape-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    await git(repoDir, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');
    await git(repoDir, ['add', 'feature.txt']);
    await git(repoDir, ['commit', '-m', 'feature commit']);
    await git(repoDir, ['checkout', 'main']);

    const db = new DatabaseService(t.dbPath);
    const cycleId = insertProjectAndCycle(db, repoDir, 'feature');

    const report = await branchSafetyReport(cycleId, db);

    expect(Object.keys(report).sort()).toEqual(['facts', 'narrative']);
    expect(report).not.toHaveProperty('decision');
    expect(report).not.toHaveProperty('verdict');
    expect(report).not.toHaveProperty('allow');
    expect(report.facts.exists).toBe(true);
    expect(report.narrative).toBeNull();

    db.close();
  });

  it('a house-agent dispatch through this path resolves without throwing the B07b project-run fence', async () => {
    const repoDir = await initRepo('helm-b5-dispatch-');
    const t = tempDbPath('helm-b5-dispatch-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    await git(repoDir, ['checkout', '-b', 'feature']);
    fs.writeFileSync(path.join(repoDir, 'feature.txt'), 'work\n');
    await git(repoDir, ['add', 'feature.txt']);
    await git(repoDir, ['commit', '-m', 'feature commit']);
    await git(repoDir, ['checkout', 'main']);

    const db = new DatabaseService(t.dbPath);
    const cycleId = insertProjectAndCycle(db, repoDir, 'feature');

    let capturedAgentId: number | null = null;
    let capturedAgentKind: string | null = null;

    const report = await branchSafetyReport(cycleId, db, {
      dispatchNarrative: async (agent) => {
        capturedAgentId = agent.id;
        capturedAgentKind = agent.kind;
        return 'branch feature looks stale but unmerged';
      }
    });

    expect(capturedAgentKind).toBe('house');
    expect(report.narrative).toBe('branch feature looks stale but unmerged');

    // Contrast: the SAME house agent DOES trip the B07b fence through a project-run-dispatch path
    // (agent-assignment-service.ts:307 assertProjectRunDispatchable) — proving branchSafetyReport's
    // route to this agent is genuinely a different, non-project-run path, not a coincidence.
    const assignment = new AgentAssignmentService(db);
    expect(() => assignment.setRoleDefault('branch-safety', capturedAgentId!)).toThrow(
      /house-kind agent cannot be dispatched into a project run/
    );

    db.close();
  });

  it('dispatcher failure degrades to facts-only without throwing', async () => {
    const repoDir = await initRepo('helm-b5-dispatch-fail-');
    const t = tempDbPath('helm-b5-dispatch-fail-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const db = new DatabaseService(t.dbPath);
    const cycleId = insertProjectAndCycle(db, repoDir, 'main');

    const report = await branchSafetyReport(cycleId, db, {
      dispatchNarrative: async () => {
        throw new Error('narrative backend unreachable');
      }
    });

    expect(report.narrative).toBeNull();
    expect(report.facts.exists).toBe(true);

    db.close();
  });

  it('agent unavailable (no branch-safety role default bound) degrades to facts-only without throwing', async () => {
    const repoDir = await initRepo('helm-b5-unavailable-');
    const t = tempDbPath('helm-b5-unavailable-db-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));
    cleanups.push(t.cleanup);

    const db = new DatabaseService(t.dbPath);
    db.prepare(`DELETE FROM role_defaults WHERE role = 'branch-safety'`).run();
    const cycleId = insertProjectAndCycle(db, repoDir, 'main');

    let dispatchCalled = false;
    const report = await branchSafetyReport(cycleId, db, {
      dispatchNarrative: async () => {
        dispatchCalled = true;
        return 'should never be reached';
      }
    });

    expect(dispatchCalled).toBe(false);
    expect(report.narrative).toBeNull();
    expect(report.facts.exists).toBe(true);

    db.close();
  });

  it('grep proves exactly one branchSafetyReport implementation in src/ (single entry point for B13/B17/B20)', () => {
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

    const defPattern = /export\s+(?:async\s+)?function\s+branchSafetyReport\s*\(/;
    const implementations = files.filter((f) => defPattern.test(fs.readFileSync(f, 'utf8')));

    expect(implementations).toHaveLength(1);
    expect(implementations[0]).toBe(path.join(SRC_DIR, 'services', 'branch-safety-report-service.ts'));
  });
});
