import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 15_000;
const GIT_MAX_BUFFER = 1024 * 256;

// R4.2/D3: branch is namespaced `helm/cycle/<id>/<slug>` and the slug also feeds the worktree
// path segment indirectly via the branch name — keep it a safe git-ref + filesystem component
// (path-escape fail-closed guard). No dots-only segments, no leading '-' (git ref-safety), no '/'.
const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface CycleGitIdentity {
  cycleId: number;
  baseBranch: string;
  baseSha: string;
  branch: string;
  worktreePath: string;
  worktreeId: string;
}

export interface CreateCycleWorktreeParams {
  /** Repo root / project directory. The cycle's docs (`cycle/<folder_name>`) live under here too. */
  projectDir: string;
  cycleId: number;
  slug: string;
  /** Already-chosen base (branch name, tag, or SHA) — this service never picks it (B20 does). */
  baseRef: string;
}

/** Structural subset of DatabaseService used here — lets tests inject a failing persister. */
export interface DbLike {
  prepare(sql: string): { run(...params: unknown[]): { changes: number } };
}

/**
 * R4.1/R4.2 (D3): creates the per-cycle branch + `git worktree add`, at a STABLE path
 * (`<project>/cycle/.worktrees/<id>`) that never moves when the docs folder does. Verifies the
 * worktree via `git worktree list --porcelain` before persisting identity, and compensates
 * (removes the worktree + branch) if persistence fails or verification fails — no half-built
 * identity survives a failure. Fails closed on non-repo, missing base, collision, or path escape,
 * always BEFORE any git mutation, so a refused call leaves zero partial state.
 */
export class GitWorktreeService {
  constructor(private readonly db: DbLike) {}

  async createCycleWorktree(params: CreateCycleWorktreeParams): Promise<CycleGitIdentity> {
    const { projectDir, cycleId, slug, baseRef } = params;

    if (!Number.isInteger(cycleId) || cycleId <= 0) {
      throw new Error(`invalid cycleId: ${String(cycleId)}`);
    }
    if (!SLUG_PATTERN.test(slug)) {
      throw new Error(`invalid slug (path-escape guard): ${String(slug)}`);
    }
    const trimmedBaseRef = String(baseRef || '').trim();
    if (!trimmedBaseRef) {
      throw new Error('baseRef is required');
    }

    const repoRoot = await this.resolveRepoRoot(projectDir);
    const gitCommonDir = await this.resolveGitCommonDir(projectDir);
    const baseSha = await this.resolveBase(projectDir, trimmedBaseRef);

    const branch = `helm/cycle/${cycleId}/${slug}`;
    const worktreePath = path.join(repoRoot, 'cycle', '.worktrees', String(cycleId));

    await this.assertNoCollision(projectDir, branch, worktreePath);

    // B7/B8 (later slices): the Landlock sandbox grants GIT_REF_RW on paths that must ALREADY
    // exist — no ensure_dir capability there. Pre-create deterministically rather than relying on
    // git's own (config-dependent) lazy reflog creation.
    const reflogDir = path.join(gitCommonDir, 'logs', 'refs', 'heads', 'helm', 'cycle', String(cycleId));
    await fs.mkdir(reflogDir, { recursive: true });

    const adminDirsBefore = await this.listWorktreeAdminDirs(gitCommonDir);

    try {
      await this.git(projectDir, ['worktree', 'add', '-b', branch, worktreePath, baseSha]);
    } catch (e) {
      await this.compensate(projectDir, branch, worktreePath);
      throw e;
    }

    let worktreeId: string;
    try {
      worktreeId = await this.resolveNewWorktreeId(gitCommonDir, adminDirsBefore);
      await this.verifyWorktreeRegistered(projectDir, worktreePath, branch, baseSha);
      await this.writeExcludeEntry(repoRoot, gitCommonDir, worktreePath);
    } catch (e) {
      await this.compensate(projectDir, branch, worktreePath);
      throw e;
    }

    const identity: CycleGitIdentity = {
      cycleId,
      baseBranch: trimmedBaseRef,
      baseSha,
      branch,
      worktreePath,
      worktreeId
    };

    try {
      const result = this.db.prepare(
        `UPDATE cycles SET git_base_branch = ?, git_branch = ?, git_worktree_path = ?, git_worktree_id = ? WHERE id = ?`
      ).run(identity.baseBranch, identity.branch, identity.worktreePath, identity.worktreeId, identity.cycleId);
      if (!result || result.changes !== 1) {
        throw new Error(`identity persist affected ${result?.changes ?? 0} rows for cycle ${cycleId}`);
      }
    } catch (e) {
      await this.compensate(projectDir, branch, worktreePath);
      throw e;
    }

    return identity;
  }

  private async resolveRepoRoot(projectDir: string): Promise<string> {
    try {
      const { stdout } = await this.git(projectDir, ['rev-parse', '--show-toplevel']);
      return stdout.trim();
    } catch {
      throw new Error(`not a git repository: ${projectDir}`);
    }
  }

  private async resolveGitCommonDir(projectDir: string): Promise<string> {
    try {
      const { stdout } = await this.git(projectDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      return stdout.trim();
    } catch {
      throw new Error(`not a git repository: ${projectDir}`);
    }
  }

  private async resolveBase(projectDir: string, baseRef: string): Promise<string> {
    try {
      const { stdout } = await this.git(projectDir, ['rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`]);
      const sha = stdout.trim();
      if (!sha) throw new Error('empty');
      return sha;
    } catch {
      throw new Error(`unknown base: ${baseRef}`);
    }
  }

  private async assertNoCollision(projectDir: string, branch: string, worktreePath: string): Promise<void> {
    if (await this.refExists(projectDir, `refs/heads/${branch}`)) {
      throw new Error(`branch already exists: ${branch}`);
    }
    if (fsSync.existsSync(worktreePath)) {
      throw new Error(`worktree path already exists: ${worktreePath}`);
    }
    if (await this.isPathRegisteredWorktree(projectDir, worktreePath)) {
      throw new Error(`worktree path already registered: ${worktreePath}`);
    }
  }

  private async refExists(projectDir: string, ref: string): Promise<boolean> {
    try {
      await this.git(projectDir, ['show-ref', '--verify', '--quiet', ref]);
      return true;
    } catch {
      return false;
    }
  }

  private async isPathRegisteredWorktree(projectDir: string, worktreePath: string): Promise<boolean> {
    const target = path.resolve(worktreePath);
    for (const block of await this.listWorktrees(projectDir)) {
      if (path.resolve(block.worktree) === target) return true;
    }
    return false;
  }

  private async listWorktreeAdminDirs(gitCommonDir: string): Promise<Set<string>> {
    try {
      return new Set(await fs.readdir(path.join(gitCommonDir, 'worktrees')));
    } catch {
      return new Set();
    }
  }

  private async resolveNewWorktreeId(gitCommonDir: string, before: Set<string>): Promise<string> {
    const after = await this.listWorktreeAdminDirs(gitCommonDir);
    const added = [...after].filter((name) => !before.has(name));
    if (added.length !== 1) {
      throw new Error(`expected exactly one new worktree admin dir, found ${added.length}: [${added.join(', ')}]`);
    }
    return added[0];
  }

  private async verifyWorktreeRegistered(
    projectDir: string,
    worktreePath: string,
    branch: string,
    baseSha: string
  ): Promise<void> {
    const realTarget = await fs.realpath(worktreePath);
    const targetRef = `refs/heads/${branch}`;
    for (const block of await this.listWorktrees(projectDir)) {
      let blockPath: string;
      try {
        blockPath = await fs.realpath(block.worktree);
      } catch {
        continue;
      }
      if (blockPath !== realTarget) continue;
      if (block.branch !== targetRef) {
        throw new Error(`worktree registered on unexpected branch: ${block.branch ?? '(detached)'}`);
      }
      if (block.head !== baseSha) {
        throw new Error(`worktree HEAD ${block.head ?? '(none)'} does not match supplied base ${baseSha}`);
      }
      return;
    }
    throw new Error(`worktree not found in 'git worktree list --porcelain': ${worktreePath}`);
  }

  private async listWorktrees(
    projectDir: string
  ): Promise<Array<{ worktree: string; head: string | null; branch: string | null }>> {
    const { stdout } = await this.git(projectDir, ['worktree', 'list', '--porcelain']);
    const blocks: Array<{ worktree: string; head: string | null; branch: string | null }> = [];
    let current: { worktree: string; head: string | null; branch: string | null } | null = null;
    for (const line of stdout.split('\n')) {
      if (line.startsWith('worktree ')) {
        current = { worktree: line.slice('worktree '.length).trim(), head: null, branch: null };
        blocks.push(current);
      } else if (line.startsWith('HEAD ') && current) {
        current.head = line.slice('HEAD '.length).trim();
      } else if (line.startsWith('branch ') && current) {
        current.branch = line.slice('branch '.length).trim();
      }
    }
    return blocks;
  }

  private async writeExcludeEntry(repoRoot: string, gitCommonDir: string, worktreePath: string): Promise<void> {
    const rel = path.relative(repoRoot, worktreePath).split(path.sep).join('/');
    const line = `/${rel}/`;
    const excludePath = path.join(gitCommonDir, 'info', 'exclude');

    await fs.mkdir(path.dirname(excludePath), { recursive: true });
    let existing = '';
    try {
      existing = await fs.readFile(excludePath, 'utf8');
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    if (existing.split('\n').includes(line)) return;

    const sep = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
    await fs.appendFile(excludePath, `${sep}${line}\n`);
  }

  /** Removes whatever git side effects got created before the failure — leaves no partial state. */
  private async compensate(projectDir: string, branch: string, worktreePath: string): Promise<void> {
    try {
      await this.git(projectDir, ['worktree', 'remove', '--force', worktreePath]);
    } catch {
      // worktree add may have failed before registration — fall through to manual cleanup.
    }
    try {
      if (fsSync.existsSync(worktreePath)) {
        await fs.rm(worktreePath, { recursive: true, force: true });
        await this.git(projectDir, ['worktree', 'prune']);
      }
    } catch {
      // best-effort
    }
    try {
      await this.git(projectDir, ['branch', '-D', branch]);
    } catch {
      // branch may never have been created
    }
  }

  private git(cwd: string, args: string[]) {
    return execFileAsync('git', ['-C', cwd, ...args], { timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER });
  }
}
