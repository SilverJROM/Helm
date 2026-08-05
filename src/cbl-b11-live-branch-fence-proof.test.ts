/**
 * cycle-branch-lifecycle B11 (R4.1/R4.3) — GATE-ATOMIC LIVE PROOF, full production chain.
 *
 * B6/B7/B8/B9/B10a each proved one link of the chain in isolation (hand-built fixtures for the
 * binary probe, unit-level env composition, seat-role threading). This is the first proof that
 * chains all of them together exactly as a real cycle would: CycleService.createCycle -> B10a's
 * GitWorktreeService wire -> the PERSISTED cycle row -> makeCycleGitAllowEnv (the real production
 * composer) -> the real compiled tools/helm-sandbox binary -> a real `git add`+`git commit`. Also
 * covers the one thing no prior slice exercised live: the strict-read profile actually landing a
 * commit, not just being unit-tested for env composition (B9).
 *
 * Env composition matches production exactly: makeCycleGitAllowEnv / makeStrictReadProfileEnv
 * return shell-quoted `VAR='val' ` fragments meant to be prepended literally to the sandbox binary
 * invocation (see real-transport.ts's fencedLaunch compose and tmux's literal send-keys) — so, like
 * production, this spec runs them through `bash -c "<env-prefix><bin> <dir> <cmd>"` rather than
 * re-parsing them into a JS env object.
 *
 * Fixtures live directly under $HOME (NOT /tmp, NOT any $HOME dot-dir tooling exception) — /tmp
 * gets a blanket rw grant in the default profile that would silently mask the very GIT_ADMIN/
 * GIT_REF_RW/GIT_OBJ enforcement under test (the exact mistake B7's own OBJ-mask derivation caught
 * on its first attempt; see plan/cycle-branch-lifecycle/validation/B7-impl-a1/obj-mask-derivation.md).
 *
 * A companion LIVE run against the real running helm-harness server + a purpose-registered scratch
 * project (`helm-b11-scratch`, Helm project id 5) is the actual GATE-ATOMIC proof plan.md asks for
 * ("purpose-registered SCRATCH project, not memory_mcp"); its evidence lives under
 * plan/cycle-branch-lifecycle/validation/B11-impl-a1/ (gitignored run-state, per plan.md's own
 * convention — see b11-live-proof.mjs there for the driver and the recorded transcripts/summary).
 * This spec is the durable, re-runnable, committed form of the same proof so a future change to
 * any link in the chain gets caught by `npm test`, not only by a manual live run.
 *
 * Known, accepted, documented finding (mirrors b11-live-proof.mjs's BENIGN_TMP_OBJ_UNLINK comment):
 * this git/filesystem combination writes loose objects via link()+unlink() (create tmp, hardlink
 * into the final <sha> name, unlink the tmp) rather than a single rename. The tmp-file self-unlink
 * is a REMOVE_FILE op inside objects/, deliberately NOT granted by GIT_OBJ (B7: a pre-existing
 * object must be neither truncatable nor unlinkable by this seat — Landlock is path-scoped and
 * cannot distinguish "unlink my own tmp file" from "unlink a real object"). Git demotes the failed
 * cleanup to a non-fatal warning and the commit still lands correctly; this is recorded as
 * informational (same class as the B7 probe's X5 in-place-overwrite note), not treated as a
 * functional EPERM/EACCES failure of the commit itself.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { DatabaseService } from './db/database.js';
import { ProjectService } from './services/project-service.js';
import { CycleService } from './services/cycle-service.js';
import { GitWorktreeService } from './services/git-worktree-service.js';
import {
  makeCycleGitAllowEnv,
  makeStrictReadProfileEnv,
  resolveHelmSandboxBin,
  resolveCycleGitReadPaths,
} from './security/landlock-sandbox.js';

const BIN = resolveHelmSandboxBin();

type RunResult = { status: number | null; stdout: string; stderr: string };

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

/** Runs `<envPrefix><BIN> '<worktree>' bash -c '<script>'` as one literal shell line — exactly how
 * RealTransport.spawn()'s fencedLaunch is sent to a real seat's shell (tmux send-keys -l). */
function runFenced(worktree: string, envPrefix: string, script: string): RunResult {
  const fullCmd = `${envPrefix}${BIN} '${worktree}' bash -c '${script.replace(/'/g, `'\\''`)}'`;
  const r = spawnSync('bash', ['-c', fullCmd], { encoding: 'utf8', timeout: 15000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

// Git creates and then unlinks several of its OWN transient files directly inside objects/ as part
// of a normal commit — the new object's tmp_obj_* staging file (see file header) AND, on this git
// version, an opportunistic `objects/maintenance.lock` probe for background auto-maintenance. Both
// are REMOVE_FILE ops inside objects/, both deliberately blocked by the same GIT_OBJ mask omission,
// both non-fatal (git warns and moves on). Match by location (inside objects/) rather than by the
// specific filename, since it is the "unlink something git itself just created in objects/" pattern
// that is understood and accepted, not one particular file name.
const BENIGN_OBJECTS_CLEANUP_UNLINK = /warning: unable to unlink '[^']*\/objects\/[^']*': Permission denied\n?/gi;
function residualDenialNoise(text: string): string {
  return text.replace(BENIGN_OBJECTS_CLEANUP_UNLINK, '');
}
function looksLikeDenial(text: string): boolean {
  return /permission denied|eacces|eperm|operation not permitted/i.test(text);
}

async function buildFixture(label: string) {
  const root = fs.mkdtempSync(path.join(os.homedir(), `helm-b11-live-${label}-`));
  const repoDir = path.join(root, 'repo');
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main']);
  git(repoDir, ['config', 'user.email', 'helm-b11-test@example.test']);
  git(repoDir, ['config', 'user.name', 'Helm B11 Test']);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# fixture\n');
  git(repoDir, ['add', 'README.md']);
  git(repoDir, ['commit', '-q', '-m', 'init']);

  const dbPath = path.join(root, `helm-b11-${label}.db`);
  const dbs = new DatabaseService(dbPath);
  const projects = new ProjectService(dbs);
  const gws = new GitWorktreeService(dbs);
  const cycles = new CycleService(dbs, projects, gws);
  const project = projects.createProject({ name: `b11-${label}-${Date.now()}`, directory: repoDir });

  // Two real cycles off the SAME production create-cycle chain: target (the fenced seat under
  // test) and peer (must remain byte-identical throughout — mirrors the AC's peer-cycle-ref check).
  const target = await cycles.createCycle(project.id, 'B11 Target');
  const peer = await cycles.createCycle(project.id, 'B11 Peer');
  expect(target.git_branch).toBeTruthy();
  expect(peer.git_branch).toBeTruthy();

  const identity = {
    id: target.id,
    git_worktree_path: target.git_worktree_path,
    git_worktree_id: target.git_worktree_id,
    projectDir: project.directory,
  };
  const commonDir = git(repoDir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);

  return {
    root,
    repoDir,
    dbs,
    target,
    peer,
    identity,
    mainRefFile: path.join(commonDir, 'refs/heads/main'),
    peerRefFile: path.join(commonDir, 'refs/heads', peer.git_branch as string),
  };
}

describe('B11 live-proof: full production chain — createCycle -> worktree -> fenced commit (R4.1/R4.3)', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    while (cleanups.length) cleanups.pop()!();
  });

  it('AC1/AC2/AC3/AC4 — worktree list shows the cycle branch; fenced git add+commit lands; base+peer refs stay untouched; positive path is denial-free', async () => {
    const f = await buildFixture('default');
    cleanups.push(() => fs.rmSync(f.root, { recursive: true, force: true }));
    cleanups.push(() => f.dbs.close());

    // AC1 — git worktree list --porcelain shows the cycle workspace on helm/cycle/<id>/<slug>.
    const porcelain = git(f.repoDir, ['worktree', 'list', '--porcelain']);
    expect(porcelain).toContain(`branch refs/heads/${f.target.git_branch}`);
    expect(porcelain).toContain(`branch refs/heads/${f.peer.git_branch}`);

    const mainShaBefore = git(f.repoDir, ['rev-parse', 'main']);
    const peerShaBefore = git(f.repoDir, ['rev-parse', f.peer.git_branch as string]);

    const gitEnv = makeCycleGitAllowEnv(f.identity);
    expect(gitEnv).toContain('HELM_SANDBOX_GIT_RO=');
    const worktree = f.identity.git_worktree_path as string;

    // AC2 — a real git add+commit BY the fenced seat advances the cycle branch.
    const positive = runFenced(
      worktree,
      gitEnv,
      `cd '${worktree}' && echo hi > b11.txt && git add b11.txt && ` +
        `git -c user.email=b11@helm.local -c user.name=b11 commit -q -m fenced && echo COMMIT_OK`
    );
    const positiveCombined = positive.stdout + positive.stderr;
    expect(positive.status).toBe(0);
    expect(positiveCombined).toContain('COMMIT_OK');
    // AC4 — zero Landlock EPERM/denial signature on the legitimate path (beyond the documented,
    // accepted tmp_obj self-unlink noise — see file header).
    expect(looksLikeDenial(residualDenialNoise(positiveCombined))).toBe(false);
    const branchLog = git(f.repoDir, ['log', '--oneline', f.target.git_branch as string]);
    expect(branchLog.split('\n')).toHaveLength(2);

    // AC3 — seat-side update-ref and direct-write attempts against base and peer refs are DENIED.
    const attacks = [
      `echo deadbeef > '${f.mainRefFile}'`,
      `echo deadbeef > '${f.peerRefFile}'`,
      `cd '${worktree}' && git update-ref refs/heads/main 0000000000000000000000000000000000000000`,
      `cd '${worktree}' && git update-ref refs/heads/${f.peer.git_branch} 0000000000000000000000000000000000000000`,
    ];
    for (const script of attacks) {
      const r = runFenced(worktree, gitEnv, script);
      expect(r.status).not.toBe(0);
    }

    expect(git(f.repoDir, ['rev-parse', 'main'])).toBe(mainShaBefore);
    expect(git(f.repoDir, ['rev-parse', f.peer.git_branch as string])).toBe(peerShaBefore);
  });

  it('AC5 — the successful fenced commit repeats under the strict-read profile', async () => {
    const f = await buildFixture('strict');
    cleanups.push(() => fs.rmSync(f.root, { recursive: true, force: true }));
    cleanups.push(() => f.dbs.close());

    const mainShaBefore = git(f.repoDir, ['rev-parse', 'main']);
    const peerShaBefore = git(f.repoDir, ['rev-parse', f.peer.git_branch as string]);
    const worktree = f.identity.git_worktree_path as string;

    const gitEnv = makeCycleGitAllowEnv(f.identity);
    const sysAllow = ['/usr', '/lib', '/lib64', '/bin', '/etc'].filter((p) => fs.existsSync(p));
    const strictAllow = [...sysAllow, ...resolveCycleGitReadPaths(f.identity)];
    const strictEnv = makeStrictReadProfileEnv(strictAllow);

    // Strict profile has no blanket root-ro rule, so an unenumerated $HOME read (git always probes
    // ~/.gitconfig / ~/.config/git/ignore at startup) is denied and git fails before reaching the
    // worktree. Point HOME at the (already fully granted) worktree itself so those lookups resolve
    // to nonexistent paths there — skipped silently (ENOENT), not denied (EACCES). Caller-side
    // responsibility, not a Landlock/Helm-source change (mirrors b11-live-proof.mjs's live run).
    const homeEnv = `HOME='${worktree}' `;

    const positive = runFenced(
      worktree,
      `${strictEnv}${gitEnv}${homeEnv}`,
      `cd '${worktree}' && echo hi > b11-strict.txt && git add b11-strict.txt && ` +
        `git -c user.email=b11@helm.local -c user.name=b11 commit -q -m fenced-strict && echo COMMIT_OK`
    );
    const combined = positive.stdout + positive.stderr;
    expect(positive.status).toBe(0);
    expect(combined).toContain('COMMIT_OK');
    expect(looksLikeDenial(residualDenialNoise(combined))).toBe(false);

    const branchLog = git(f.repoDir, ['log', '--oneline', f.target.git_branch as string]);
    expect(branchLog.split('\n')).toHaveLength(2);

    expect(git(f.repoDir, ['rev-parse', 'main'])).toBe(mainShaBefore);
    expect(git(f.repoDir, ['rev-parse', f.peer.git_branch as string])).toBe(peerShaBefore);
  });
});
