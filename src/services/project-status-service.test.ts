import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseService } from '../db/database.js';
import { ProjectService } from './project-service.js';
import { ProjectStatusService, defaultResolveGitBranch } from './project-status-service.js';

function makeTempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b3-status-'));
  const dbPath = path.join(dir, 'test.db');
  return {
    dbPath,
    cleanup: () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
  };
}

describe('B3 ProjectStatusService: live read-only project health', () => {
  let cleanup: () => void;
  let dbs: DatabaseService;
  let ps: ProjectService;

  beforeEach(() => {
    const t = makeTempDb();
    cleanup = t.cleanup;
    dbs = new DatabaseService(t.dbPath);
    ps = new ProjectService(dbs);
  });

  afterEach(() => {
    cleanup();
  });

  it('reports active iff tmux_session or plancore_session exists, using updated_at as last activity', async () => {
    dbs.raw.prepare("INSERT INTO projects (name, directory, tmux_session, plancore_session, updated_at) VALUES (?,?,?,?,?)")
      .run('status-active', '/tmp/status-active', 'dead-session', 'live-session', '2026-06-24T12:34:56.000Z');
    const project = dbs.raw.prepare("SELECT id FROM projects WHERE name = ?").get('status-active') as any;
    const tmux = {
      sessionExists: async (name: string) => name === 'live-session'
    };
    const svc = new ProjectStatusService(ps, tmux as any, async () => 'feature/status');

    const status = await svc.getProjectStatus(project.id);

    expect(status).toEqual({
      state: 'active',
      active: true,
      last_activity_at: '2026-06-24T12:34:56.000Z',
      git_branch: 'feature/status'
    });
  });

  it('v90 exposes only the canonical planning-session path', async () => {
    const columns = dbs.raw.prepare('PRAGMA table_info(projects)').all().map((column: any) => column.name);
    expect(columns).not.toContain('projcore_session');
    dbs.raw.prepare("INSERT INTO projects (name, directory, plancore_session) VALUES (?,?,?)")
      .run('status-plancore', '/tmp/status-plancore', 'planning-live-session');
    const project = dbs.raw.prepare("SELECT id FROM projects WHERE name = ?").get('status-plancore') as any;
    const svc = new ProjectStatusService(ps, { sessionExists: async (name: string) => name === 'planning-live-session' } as any, async () => null);
    await expect(svc.getProjectStatus(project.id)).resolves.toMatchObject({ state: 'active', active: true });
  });

  it('falls back to idle and null branch when sessions fail and git branch cannot resolve', async () => {
    dbs.raw.prepare("INSERT INTO projects (name, directory, tmux_session, plancore_session) VALUES (?,?,?,?)")
      .run('status-idle', '/tmp/status-idle', 'bad session', 'also-missing');
    const project = dbs.raw.prepare("SELECT id, updated_at FROM projects WHERE name = ?").get('status-idle') as any;
    const tmux = {
      sessionExists: async () => {
        throw new Error('invalid target');
      }
    };
    const svc = new ProjectStatusService(ps, tmux as any, async () => null);

    const status = await svc.getProjectStatus(project.id);

    expect(status?.state).toBe('idle');
    expect(status?.active).toBe(false);
    expect(status?.last_activity_at).toBe(project.updated_at);
    expect(status?.git_branch).toBeNull();
  });

  it('returns null for unknown projects', async () => {
    const svc = new ProjectStatusService(ps, { sessionExists: async () => true } as any, async () => 'main');
    await expect(svc.getProjectStatus(9999)).resolves.toBeNull();
  });

  it('defaultResolveGitBranch returns branch for git repos and null for missing/non-git directories', async () => {
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b3-git-'));
    const nonGitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b3-nongit-'));
    try {
      await execGit(repoDir, ['init']);
      await execGit(repoDir, ['config', 'user.email', 'helm-test@example.test']);
      await execGit(repoDir, ['config', 'user.name', 'Helm Test']);
      await execGit(repoDir, ['checkout', '-b', 'batch-3-health']);
      fs.writeFileSync(path.join(repoDir, 'README.md'), '# test\n');
      await execGit(repoDir, ['add', 'README.md']);
      await execGit(repoDir, ['commit', '-m', 'test branch']);

      await expect(defaultResolveGitBranch(repoDir)).resolves.toBe('batch-3-health');
      await expect(defaultResolveGitBranch(nonGitDir)).resolves.toBeNull();
      await expect(defaultResolveGitBranch(path.join(nonGitDir, 'missing'))).resolves.toBeNull();
    } finally {
      try { fs.rmSync(repoDir, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(nonGitDir, { recursive: true, force: true }); } catch {}
    }
  });
});

async function execGit(cwd: string, args: string[]): Promise<void> {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const execFileAsync = promisify(execFile);
  await execFileAsync('git', args, { cwd });
}
