/**
 * cycle-branch-lifecycle B15 — R6.1 park.
 *
 * terminalizeCycleAtRunEnd (run-orchestrator-service.ts): a cycle with a PERSISTED git identity
 * no longer reaches the terminal `complete` phase here. It parks instead — awaiting_merge=1, a
 * pure DB flag flip with zero git calls — until B16's owner-gated merge runs. A legacy
 * null-identity cycle is untouched: setCyclePhase('complete') exactly as before this slice.
 * awaiting_merge is a distinct durable state, never a reuse of awaiting_approval (planning-only).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DatabaseService } from './db/database.js';
import { RunArtifactService } from './services/run-artifact-service.js';
import { PlanParserService } from './services/plan-parser-service.js';
import { PlanningPhaseService } from './services/planning-phase-service.js';
import { TaskQueueService } from './services/task-queue-service.js';
import { FakeTransport } from './services/fake-transport.js';
import { ProjectService } from './services/project-service.js';
import { AgentAssignmentService } from './services/agent-assignment-service.js';
import { CycleService } from './services/cycle-service.js';
import { RunOrchestratorService } from './services/run-orchestrator-service.js';

const execFileAsync = promisify(execFile);
const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b15-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B15 Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

describe('cycle-branch-lifecycle B15: terminalizeCycleAtRunEnd parks persisted-identity cycles (R6.1)', () => {
  const cleanups: Array<() => void> = [];

  beforeEach(() => {
    process.env.USE_FAKE_TMUX = '1';
    process.env.NODE_ENV = 'test';
  });

  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  function makeHarness() {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b15-db-'));
    const dbPath = path.join(dbDir, 't.db');
    const db = new DatabaseService(dbPath);
    const artifacts = new RunArtifactService(db);
    const parser = new PlanParserService(artifacts);
    const queue = new TaskQueueService(artifacts);
    const fakeT = new FakeTransport();
    const projectSvc = new ProjectService(db);
    const assignSvc = new AgentAssignmentService(db);
    const planning = new PlanningPhaseService(fakeT, artifacts, queue);
    const cycles = new CycleService(db, projectSvc);
    const orch = new RunOrchestratorService({
      artifacts,
      planning,
      parser,
      queue,
      transport: fakeT,
      projectService: projectSvc,
      assignmentService: assignSvc,
      cycleService: cycles as any,
    });
    cleanups.push(() => {
      try { db.close(); } catch { /* ignore */ }
      try { fs.rmSync(dbDir, { recursive: true, force: true }); } catch { /* ignore */ }
    });
    return { db, projectSvc, cycles, orch };
  }

  function cycleRow(db: DatabaseService, cycleId: number): any {
    return db.raw.prepare('SELECT * FROM cycles WHERE id = ?').get(cycleId) as any;
  }

  it('worktree-backed cycle: run end leaves awaiting_merge=1, does not terminalize, and issues zero git calls', async () => {
    const { db, projectSvc, cycles, orch } = makeHarness();
    const repoDir = await initRepo('helm-b15-repo-');
    cleanups.push(() => fs.rmSync(repoDir, { recursive: true, force: true }));

    const project = projectSvc.createProject({ name: `b15-worktree-${Date.now()}`, directory: repoDir });
    const cycle = await cycles.createCycle(project.id, 'B15 Worktree Cycle');
    // Simulate a persisted, worktree-backed identity (B6/B20 territory) without actually creating
    // a worktree — B15's scope is purely the terminalizeCycleAtRunEnd branch, not identity creation.
    db.raw.prepare(
      `UPDATE cycles SET git_base_branch = 'main', git_branch = ?, git_worktree_path = ?, git_worktree_id = 'wt-b15' WHERE id = ?`
    ).run(`helm/cycle/${cycle.id}/b15-worktree-cycle`, path.join(repoDir, '.worktrees', String(cycle.id)), cycle.id);

    const before = cycleRow(db, cycle.id);
    expect(before.awaiting_merge).toBe(0);
    expect(before.phase).toBe('discovery');
    const gitLogBefore = await git(repoDir, ['log', '--oneline', 'main']);

    const setPhaseSpy = vi.spyOn(cycles, 'setCyclePhase');

    (orch as any).terminalizeCycleAtRunEnd({ cycleId: cycle.id });

    const after = cycleRow(db, cycle.id);
    expect(after.awaiting_merge).toBe(1);
    // parked, not terminalized: phase is untouched by this call.
    expect(after.phase).toBe('discovery');
    expect(setPhaseSpy).not.toHaveBeenCalled();

    const gitLogAfter = await git(repoDir, ['log', '--oneline', 'main']);
    expect(gitLogAfter).toBe(gitLogBefore);
  });

  it('legacy null-identity cycle: run end behaves exactly as today (setCyclePhase complete, awaiting_merge stays 0)', async () => {
    const { db, projectSvc, cycles, orch } = makeHarness();
    const projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b15-legacy-'));
    cleanups.push(() => fs.rmSync(projDir, { recursive: true, force: true }));

    const project = projectSvc.createProject({ name: `b15-legacy-${Date.now()}`, directory: projDir });
    const cycle = await cycles.createCycle(project.id, 'B15 Legacy Cycle');

    const before = cycleRow(db, cycle.id);
    expect(before.git_worktree_path).toBeNull();
    expect(before.git_worktree_id).toBeNull();

    const setPhaseSpy = vi.spyOn(cycles, 'setCyclePhase');

    (orch as any).terminalizeCycleAtRunEnd({ cycleId: cycle.id });

    expect(setPhaseSpy).toHaveBeenCalledTimes(1);
    expect(setPhaseSpy).toHaveBeenCalledWith(cycle.id, 'complete');

    const after = cycleRow(db, cycle.id);
    expect(after.phase).toBe('complete');
    expect(after.awaiting_merge).toBe(0);
  });

  it('grep proves no autonomous caller of the B16 merge entry point (mergeCycleBranch) anywhere in src/', () => {
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

    const callPattern = /\bmergeCycleBranch\s*\(/;
    const callSites = files
      .filter((f) => callPattern.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(SRC_DIR, f))
      .sort();

    // B16 (R6.2) has not landed yet — terminalizeCycleAtRunEnd (this slice) parks instead of
    // merging, so there must be zero call sites anywhere in src/ until B16's owner-gated entry
    // point exists. Re-run after B16 lands to prove it stays out of every autonomous path.
    expect(callSites).toEqual([]);
  });
});
