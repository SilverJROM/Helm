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

/** Structural subset of DatabaseService used here — lets tests inject a failing persister.
 * `get` is optional so pre-B12 test doubles (which only ever exercised `run`) keep compiling —
 * `cleanupCycleGit` is the only method that reads via `get`. */
export interface DbLike {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get?(...params: unknown[]): any;
  };
}

export interface CleanupCycleGitResult {
  cycleId: number;
  branch: string | null;
  worktreePath: string | null;
  /** false when the cycle had no persisted git identity (R4.4 legacy/never-provisioned) — no-op. */
  cleaned: boolean;
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

  /**
   * B10b (R4.1/R4.2): revalidate a PERSISTED cycle git identity before any caller trusts it as the
   * effective build root — strict canonical containment under the registered root AND live
   * membership + branch match in `git worktree list --porcelain`. Never repairs and never infers a
   * substitute — throws with a precise, distinct reason on any mismatch (removed/stale worktree,
   * branch drift, fence-escape) so the caller can fail closed with that reason recorded.
   */
  async verifyPersistedWorktree(
    projectDir: string,
    identity: { worktreePath: string; branch: string }
  ): Promise<string> {
    const canonRoot = await fs.realpath(projectDir);
    let canonWorktree: string;
    try {
      canonWorktree = await fs.realpath(identity.worktreePath);
    } catch (e: any) {
      throw new Error(`persisted worktree does not resolve: ${identity.worktreePath} (${e?.message || e})`);
    }
    const rel = path.relative(canonRoot, canonWorktree);
    if (canonWorktree === canonRoot || rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`persisted worktree ${canonWorktree} is not a strict descendant of registered root ${canonRoot} (fence-escape guard)`);
    }
    const st = await fs.stat(canonWorktree);
    if (!st.isDirectory()) {
      throw new Error(`persisted worktree path is not a directory: ${canonWorktree}`);
    }

    const targetRef = `refs/heads/${identity.branch}`;
    for (const block of await this.listWorktrees(projectDir)) {
      let blockPath: string;
      try {
        blockPath = await fs.realpath(block.worktree);
      } catch {
        continue;
      }
      if (blockPath !== canonWorktree) continue;
      if (block.branch !== targetRef) {
        throw new Error(`persisted worktree is registered on unexpected branch: ${block.branch ?? '(detached)'} (expected ${targetRef})`);
      }
      return canonWorktree;
    }
    throw new Error(`persisted worktree not found in 'git worktree list --porcelain': ${canonWorktree}`);
  }

  /**
   * B12 (R2.2/R4.1): GIT-ONLY cleanup primitive shared by delete (B12's `deleteCycle`) and merge
   * (B16) — `git worktree remove --force` + `git worktree prune` + `git branch -D`. Touches no
   * filesystem docs and writes nothing to the DB; the only DB use is the read needed to resolve
   * the persisted identity and to refuse while agents/workers are still open on this cycle.
   * Refuses (fails closed, no git mutation) unless the persisted branch is namespaced under
   * `helm/cycle/<cycleId>/` and differs from the cycle's own base branch — a corrupted or
   * mismatched persisted branch must never reach `branch -D`. A cycle with no persisted git
   * identity (R4.4 legacy/never-provisioned) is a no-op, not a refusal.
   */
  async cleanupCycleGit(projectDir: string, cycleId: number): Promise<CleanupCycleGitResult> {
    if (!Number.isInteger(cycleId) || cycleId <= 0) {
      throw new Error(`invalid cycleId: ${String(cycleId)}`);
    }

    const cycleRow = this.readCycleGitIdentity(cycleId);
    if (!cycleRow) {
      throw new Error(`unknown cycle: ${cycleId}`);
    }

    if (this.hasActiveWorkers(cycleId)) {
      const err: any = new Error(
        `refusing git cleanup for cycle ${cycleId}: active agents or open handles for this cycle`
      );
      err.code = 'CONFLICT';
      throw err;
    }

    const { git_branch: branch, git_base_branch: baseBranch, git_worktree_path: worktreePath } = cycleRow;

    if (!branch && !worktreePath) {
      return { cycleId, branch: null, worktreePath: null, cleaned: false };
    }
    if (!branch || !worktreePath) {
      throw new Error(
        `cycle ${cycleId} has a partial git identity (branch=${branch ?? 'null'}, worktreePath=${worktreePath ?? 'null'}) — refusing cleanup`
      );
    }

    const expectedPrefix = `helm/cycle/${cycleId}/`;
    if (!branch.startsWith(expectedPrefix)) {
      const err: any = new Error(
        `refusing cleanup: persisted branch '${branch}' for cycle ${cycleId} is outside the ${expectedPrefix} namespace`
      );
      err.code = 'FORBIDDEN';
      throw err;
    }
    if (branch === baseBranch) {
      const err: any = new Error(
        `refusing cleanup: persisted branch for cycle ${cycleId} equals its own base branch (${branch})`
      );
      err.code = 'FORBIDDEN';
      throw err;
    }

    await this.git(projectDir, ['worktree', 'remove', '--force', worktreePath]);
    await this.git(projectDir, ['worktree', 'prune']);
    await this.git(projectDir, ['branch', '-D', branch]);

    return { cycleId, branch, worktreePath, cleaned: true };
  }

  /**
   * B16 (R6.2): GIT-ONLY merge primitive. Refuses (no mutation) unless the cycle's own worktree is
   * clean, the persisted base ref exists, AND that base branch is checked out in EXACTLY one
   * worktree (unambiguous) whose status is clean — only then merges `--no-ff` into that checkout.
   * Writes nothing to the DB and never touches docs; the caller (CycleService.mergeCycleBranch)
   * owns the CAS claim, the `git_merged_at`/`git_cleanup_pending` flags, and the call into
   * `cleanupCycleGit`.
   */
  async mergeCycleIntoBase(
    projectDir: string,
    params: { cycleId: number; cycleBranch: string; baseBranch: string; cycleWorktreePath: string }
  ): Promise<{ baseWorktreePath: string }> {
    const { cycleId, cycleBranch, baseBranch, cycleWorktreePath } = params;

    await this.assertWorktreeClean(cycleWorktreePath, `cycle ${cycleId} branch '${cycleBranch}'`);

    if (!(await this.refExists(projectDir, `refs/heads/${baseBranch}`))) {
      throw new Error(`base ref does not exist: ${baseBranch}`);
    }
    const baseMatches = (await this.listWorktrees(projectDir)).filter(
      (w) => w.branch === `refs/heads/${baseBranch}`
    );
    if (baseMatches.length === 0) {
      throw new Error(`base branch '${baseBranch}' is not checked out in any worktree — refusing merge`);
    }
    if (baseMatches.length > 1) {
      throw new Error(`base branch '${baseBranch}' is checked out in ${baseMatches.length} worktrees — ambiguous`);
    }
    const baseWorktreePath = baseMatches[0].worktree;
    await this.assertWorktreeClean(baseWorktreePath, `base branch '${baseBranch}' checkout`);

    await this.git(baseWorktreePath, [
      'merge', '--no-ff', cycleBranch,
      '-m', `Merge cycle ${cycleId} (${cycleBranch}) into ${baseBranch}`
    ]);

    return { baseWorktreePath };
  }

  private async assertWorktreeClean(worktreePath: string, label: string): Promise<void> {
    const { stdout } = await this.git(worktreePath, ['status', '--porcelain']);
    if (stdout.trim() !== '') {
      throw new Error(`${label} is not clean — refusing merge`);
    }
  }

  private readCycleGitIdentity(
    cycleId: number
  ): { git_branch: string | null; git_base_branch: string | null; git_worktree_path: string | null } | undefined {
    const stmt = this.db.prepare('SELECT git_branch, git_base_branch, git_worktree_path FROM cycles WHERE id = ?');
    if (typeof stmt.get !== 'function') {
      throw new Error('DbLike.get is required for cleanupCycleGit');
    }
    return stmt.get(cycleId);
  }

  private hasActiveWorkers(cycleId: number): boolean {
    const stmt = this.db.prepare(
      `SELECT COUNT(*) AS c
       FROM worker_runtimes wr
       INNER JOIN runs r ON r.id = wr.run_id
       WHERE r.cycle_id = ? AND wr.state IN ('launching', 'running')`
    );
    if (typeof stmt.get !== 'function') {
      throw new Error('DbLike.get is required for cleanupCycleGit');
    }
    const row = stmt.get(cycleId) as { c: number } | undefined;
    return Number(row?.c ?? 0) > 0;
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
