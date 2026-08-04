import { describe, it, expect } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BranchSafetyService } from './branch-safety-service.js';

const execFileAsync = promisify(execFile);

const FORBIDDEN_KEYS = ['decision', 'verdict', 'allow'];
const EXPECTED_KEYS = [
  'ageDays', 'aheadBehind', 'exists', 'lastCommitAt',
  'mergedInto', 'tiedToActiveCycleId', 'uncommittedInWorktree', 'worktreePath'
].sort();

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd });
  return stdout;
}

async function initRepo(prefix: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  await git(dir, ['init', '-b', 'main']);
  await git(dir, ['config', 'user.email', 'helm-b4-test@example.test']);
  await git(dir, ['config', 'user.name', 'Helm B4 Test']);
  fs.writeFileSync(path.join(dir, 'README.md'), '# fixture\n');
  await git(dir, ['add', 'README.md']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

// Proves the "no mutating git subcommand" AC by comparing ref SHAs + working-tree status
// byte-for-byte before/after the collector runs, rather than mocking git — a real repo either
// changed or it didn't.
async function captureRepoState(dir: string, refs: string[]) {
  const shas: Record<string, string> = {};
  for (const ref of refs) {
    shas[ref] = (await git(dir, ['rev-parse', ref])).trim();
  }
  const status = (await git(dir, ['status', '--porcelain'])).trim();
  return { shas, status };
}

function assertFactsShape(facts: Record<string, unknown>) {
  expect(Object.keys(facts).sort()).toEqual(EXPECTED_KEYS);
  for (const key of FORBIDDEN_KEYS) {
    expect(facts).not.toHaveProperty(key);
  }
}

describe('B4 BranchSafetyService: deterministic fact collector', () => {
  it('merged branch reports mergedInto containing base, with no repo mutation and no decision key', async () => {
    const dir = await initRepo('helm-b4-merged-');
    try {
      await git(dir, ['checkout', '-b', 'merged-feature']);
      fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature work\n');
      await git(dir, ['add', 'feature.txt']);
      await git(dir, ['commit', '-m', 'feature commit']);
      await git(dir, ['checkout', 'main']);
      await git(dir, ['merge', '--no-ff', '-m', 'merge feature', 'merged-feature']);

      const before = await captureRepoState(dir, ['main', 'merged-feature']);
      const service = new BranchSafetyService();
      const facts = await service.collectFacts(dir, 'merged-feature');
      const after = await captureRepoState(dir, ['main', 'merged-feature']);

      expect(facts.exists).toBe(true);
      expect(facts.mergedInto).toContain('main');
      assertFactsShape(facts);
      expect(after).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('unmerged branch reports mergedInto empty, with no repo mutation and no decision key', async () => {
    const dir = await initRepo('helm-b4-unmerged-');
    try {
      await git(dir, ['checkout', '-b', 'unmerged-feature']);
      fs.writeFileSync(path.join(dir, 'other.txt'), 'other work\n');
      await git(dir, ['add', 'other.txt']);
      await git(dir, ['commit', '-m', 'other commit']);
      await git(dir, ['checkout', 'main']);

      const before = await captureRepoState(dir, ['main', 'unmerged-feature']);
      const service = new BranchSafetyService();
      const facts = await service.collectFacts(dir, 'unmerged-feature');
      const after = await captureRepoState(dir, ['main', 'unmerged-feature']);

      expect(facts.exists).toBe(true);
      expect(facts.mergedInto).toEqual([]);
      assertFactsShape(facts);
      expect(after).toEqual(before);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a dirty worktree reports uncommittedInWorktree=true, with no repo mutation and no decision key', async () => {
    const dir = await initRepo('helm-b4-worktree-');
    const wtParent = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-b4-worktree-checkout-'));
    const wtDir = path.join(wtParent, 'checkout');
    try {
      await git(dir, ['branch', 'worktree-branch']);
      await git(dir, ['worktree', 'add', wtDir, 'worktree-branch']);
      fs.writeFileSync(path.join(wtDir, 'scratch.txt'), 'uncommitted change\n');

      const beforeRepo = await captureRepoState(dir, ['main', 'worktree-branch']);
      const beforeWtStatus = (await git(wtDir, ['status', '--porcelain'])).trim();

      const service = new BranchSafetyService();
      const facts = await service.collectFacts(dir, 'worktree-branch');

      const afterRepo = await captureRepoState(dir, ['main', 'worktree-branch']);
      const afterWtStatus = (await git(wtDir, ['status', '--porcelain'])).trim();

      expect(facts.exists).toBe(true);
      expect(facts.worktreePath).toBe(fs.realpathSync(wtDir));
      expect(facts.uncommittedInWorktree).toBe(true);
      assertFactsShape(facts);
      expect(afterRepo).toEqual(beforeRepo);
      expect(afterWtStatus).toBe(beforeWtStatus);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(wtParent, { recursive: true, force: true });
    }
  });
});
