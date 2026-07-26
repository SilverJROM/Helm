import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { ProjectService, type Project } from './project-service.js';
import { TmuxService } from '../tmux/tmux-service.js';

const execFileAsync = promisify(execFile);

export interface ProjectStatus {
  state: 'active' | 'idle';
  active: boolean;
  last_activity_at: string | null;
  git_branch: string | null;
}

type GitBranchResolver = (directory: string) => Promise<string | null>;

export class ProjectStatusService {
  constructor(
    private readonly projectService: ProjectService,
    private readonly tmuxService: TmuxService,
    private readonly resolveGitBranch: GitBranchResolver = defaultResolveGitBranch
  ) {}

  async getProjectStatus(projectId: number): Promise<ProjectStatus | null> {
    const project = this.projectService.getProject(projectId);
    if (!project) return null;

    const [tmuxAlive, plancoreAlive, gitBranch] = await Promise.all([
      this.sessionAlive(project.tmux_session),
      this.sessionAlive(project.plancore_session),
      this.resolveGitBranch(project.directory)
    ]);
    const active = tmuxAlive || plancoreAlive;

    return {
      state: active ? 'active' : 'idle',
      active,
      last_activity_at: project.updated_at || null,
      git_branch: gitBranch
    };
  }

  private async sessionAlive(session: Project['tmux_session']): Promise<boolean> {
    if (!session) return false;
    try {
      return await this.tmuxService.sessionExists(session);
    } catch {
      return false;
    }
  }
}

export async function defaultResolveGitBranch(directory: string): Promise<string | null> {
  if (!directory) return null;
  let realDir: string;
  try {
    const st = await fs.stat(directory);
    if (!st.isDirectory()) return null;
    realDir = await fs.realpath(directory);
  } catch {
    return null;
  }

  try {
    const { stdout } = await execFileAsync('git', ['-C', realDir, 'rev-parse', '--abbrev-ref', 'HEAD'], {
      timeout: 3000,
      maxBuffer: 1024 * 32
    });
    const branch = stdout.trim();
    return branch ? branch : null;
  } catch {
    return null;
  }
}
