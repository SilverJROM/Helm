import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 1024 * 256;

/**
 * B5 (call-site wiring) supplies the real DB-backed lookup; B4 has zero DB dependency (plan.md
 * deps: none) and defaults to "no tie known" so this file never touches the cycles table itself.
 */
export interface TiedCycleInfo {
  cycleId: number;
  baseBranch: string | null;
}
export type TiedCycleResolver = (projectDir: string, branch: string) => Promise<TiedCycleInfo | null>;

export interface BranchAheadBehind {
  ahead: number;
  behind: number;
}

// R3.1: facts only — this shape must never grow a decision/verdict/allow field. Judgment belongs
// to the house safety-check agent (B3) or JROM, never this collector (decisions/D2, D5).
export interface BranchSafetyFacts {
  exists: boolean;
  mergedInto: string[];
  tiedToActiveCycleId: number | null;
  lastCommitAt: string | null;
  ageDays: number | null;
  aheadBehind: BranchAheadBehind | null;
  uncommittedInWorktree: boolean;
  worktreePath: string | null;
}

const defaultResolveTiedCycle: TiedCycleResolver = async () => null;

export class BranchSafetyService {
  constructor(private readonly resolveTiedCycle: TiedCycleResolver = defaultResolveTiedCycle) {}

  async collectFacts(projectDir: string, branch: string): Promise<BranchSafetyFacts> {
    const [exists, tied, worktreePath] = await Promise.all([
      this.branchExists(projectDir, branch),
      this.resolveTiedCycle(projectDir, branch),
      this.findLinkedWorktree(projectDir, branch)
    ]);

    const [mergedInto, lastCommitAt, uncommittedInWorktree] = await Promise.all([
      exists ? this.findMergedInto(projectDir, branch) : Promise.resolve([]),
      exists ? this.readLastCommitAt(projectDir, branch) : Promise.resolve(null),
      worktreePath ? this.hasUncommittedChanges(worktreePath) : Promise.resolve(false)
    ]);

    const aheadBehind = exists && tied?.baseBranch
      ? await this.readAheadBehind(projectDir, tied.baseBranch, branch)
      : null;

    return {
      exists,
      mergedInto,
      tiedToActiveCycleId: tied ? tied.cycleId : null,
      lastCommitAt,
      ageDays: lastCommitAt ? daysSince(lastCommitAt) : null,
      aheadBehind,
      uncommittedInWorktree,
      worktreePath
    };
  }

  private async branchExists(projectDir: string, branch: string): Promise<boolean> {
    try {
      await this.git(projectDir, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  private async findMergedInto(projectDir: string, branch: string): Promise<string[]> {
    const { stdout } = await this.git(projectDir, ['for-each-ref', '--format=%(refname:short)', 'refs/heads/']);
    const candidates = stdout.split('\n').map((s) => s.trim()).filter((s) => s && s !== branch);
    const merged: string[] = [];
    for (const candidate of candidates) {
      try {
        await this.git(projectDir, ['merge-base', '--is-ancestor', branch, candidate]);
        merged.push(candidate);
      } catch {
        // exit 1 from --is-ancestor means "not an ancestor" — not merged into this candidate.
      }
    }
    return merged;
  }

  private async readLastCommitAt(projectDir: string, branch: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(projectDir, ['log', '-1', '--format=%cI', branch, '--']);
      const value = stdout.trim();
      return value || null;
    } catch {
      return null;
    }
  }

  private async readAheadBehind(projectDir: string, base: string, branch: string): Promise<BranchAheadBehind | null> {
    try {
      const { stdout } = await this.git(projectDir, ['rev-list', '--left-right', '--count', `${base}...${branch}`]);
      const [behindRaw, aheadRaw] = stdout.trim().split(/\s+/);
      const behind = Number(behindRaw);
      const ahead = Number(aheadRaw);
      if (!Number.isFinite(behind) || !Number.isFinite(ahead)) return null;
      return { ahead, behind };
    } catch {
      return null;
    }
  }

  private async findLinkedWorktree(projectDir: string, branch: string): Promise<string | null> {
    try {
      const { stdout } = await this.git(projectDir, ['worktree', 'list', '--porcelain']);
      const targetRef = `refs/heads/${branch}`;
      let currentPath: string | null = null;
      for (const line of stdout.split('\n')) {
        if (line.startsWith('worktree ')) {
          currentPath = line.slice('worktree '.length).trim();
        } else if (line.startsWith('branch ') && line.slice('branch '.length).trim() === targetRef) {
          return currentPath;
        } else if (line === '') {
          currentPath = null;
        }
      }
      return null;
    } catch {
      return null;
    }
  }

  private async hasUncommittedChanges(worktreePath: string): Promise<boolean> {
    try {
      const { stdout } = await this.git(worktreePath, ['status', '--porcelain']);
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private git(cwd: string, args: string[]) {
    return execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
  }
}

function daysSince(isoTimestamp: string): number | null {
  const then = new Date(isoTimestamp).getTime();
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86_400_000));
}
