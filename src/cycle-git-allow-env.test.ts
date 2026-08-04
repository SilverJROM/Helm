/**
 * B8 (R4.1/R4.3) — makeCycleGitAllowEnv: node-side composition of HELM_SANDBOX_GIT_RO /
 * _ADMIN / _REF_RW / _OBJ from the persisted, revalidated cycle identity only.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, afterEach } from "vitest";

import { makeCycleGitAllowEnv } from "./security/landlock-sandbox.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

interface Fixture {
  root: string;
  projectDir: string;
  common: string;
  worktreePath: string;
  worktreeId: string;
  cycleId: number;
  peerWorktreePath: string;
  peerWorktreeId: string;
}

const fixtures: string[] = [];

function makeFixture(label: string, cycleId = 7): Fixture {
  // Under $HOME (not required for pure env composition, but keeps parity with B7 fixtures).
  const root = fs.mkdtempSync(path.join(os.homedir(), `helm-b8-git-allow-${label}-`));
  fixtures.push(root);

  const projectDir = path.join(root, "proj");
  fs.mkdirSync(projectDir, { recursive: true });
  git(projectDir, ["init", "-q", "-b", "main"]);
  git(projectDir, ["config", "user.email", "b8@test"]);
  git(projectDir, ["config", "user.name", "b8"]);
  fs.writeFileSync(path.join(projectDir, "f.txt"), "hello\n");
  git(projectDir, ["add", "f.txt"]);
  git(projectDir, ["commit", "-q", "-m", "init"]);

  const worktreePath = path.join(projectDir, "cycle", ".worktrees", String(cycleId));
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  git(projectDir, ["worktree", "add", "-q", "-b", `helm/cycle/${cycleId}/feat`, worktreePath, "main"]);

  const peerWorktreePath = path.join(projectDir, "cycle", ".worktrees", "99");
  git(projectDir, ["worktree", "add", "-q", "-b", "helm/cycle/99/peer", peerWorktreePath, "main"]);

  const common = git(projectDir, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

  // Resolve worktree admin ids from the .git pointer (same source makeCycleGitAllowEnv uses).
  const readId = (wt: string): string => {
    const content = fs.readFileSync(path.join(wt, ".git"), "utf8");
    const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
    if (!m) throw new Error(`no gitdir in ${wt}`);
    return path.basename(m[1].trim());
  };
  const worktreeId = readId(worktreePath);
  const peerWorktreeId = readId(peerWorktreePath);

  // B6 pre-creates the namespaced reflog dir; refs dir exists from worktree add.
  // Ensure both REF_RW targets exist (logs may lag depending on git version/config).
  const refDir = path.join(common, "refs", "heads", "helm", "cycle", String(cycleId));
  const logDir = path.join(common, "logs", "refs", "heads", "helm", "cycle", String(cycleId));
  fs.mkdirSync(refDir, { recursive: true });
  fs.mkdirSync(logDir, { recursive: true });

  return {
    root,
    projectDir: fs.realpathSync(projectDir),
    common: fs.realpathSync(common),
    worktreePath: fs.realpathSync(worktreePath),
    worktreeId,
    cycleId,
    peerWorktreePath: fs.realpathSync(peerWorktreePath),
    peerWorktreeId,
  };
}

afterEach(() => {
  while (fixtures.length) {
    const d = fixtures.pop()!;
    try {
      fs.rmSync(d, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

/** Parse the four GIT_* values out of the composed shell-prefix env string. */
function parseGitEnv(prefix: string): {
  ro: string;
  admin: string;
  refRw: string[];
  obj: string;
} {
  const r = execFileSync("bash", ["-c", `${prefix}bash -c 'printf "%s\\n" "$HELM_SANDBOX_GIT_RO"; printf "%s\\n" "$HELM_SANDBOX_GIT_ADMIN"; printf "%s\\n" "$HELM_SANDBOX_GIT_REF_RW"; printf "%s\\n" "$HELM_SANDBOX_GIT_OBJ"'`], {
    encoding: "utf8",
  });
  const lines = r.split("\n");
  return {
    ro: lines[0],
    admin: lines[1],
    refRw: lines[2].split(":").filter(Boolean),
    obj: lines[3],
  };
}

describe("B8 makeCycleGitAllowEnv (R4.1/R4.3)", () => {
  it("no-worktree cycle returns '' (byte-identical no-op)", () => {
    expect(
      makeCycleGitAllowEnv({
        id: 1,
        git_worktree_path: null,
        git_worktree_id: null,
        projectDir: "/tmp/whatever",
      })
    ).toBe("");
    expect(
      makeCycleGitAllowEnv({
        id: 1,
        git_worktree_path: "",
        git_worktree_id: "",
        projectDir: "/tmp/whatever",
      })
    ).toBe("");
  });

  it("a relative path throws", () => {
    expect(() =>
      makeCycleGitAllowEnv({
        id: 1,
        git_worktree_path: "relative/worktree",
        git_worktree_id: "wt",
        projectDir: "/tmp/proj",
      })
    ).toThrow(/absolute path/);
  });

  it("a path containing ':' throws", () => {
    expect(() =>
      makeCycleGitAllowEnv({
        id: 1,
        git_worktree_path: "/tmp/has:colon/worktree",
        git_worktree_id: "wt",
        projectDir: "/tmp/proj",
      })
    ).toThrow(/':'|colon/i);
  });

  it("a path not under RO throws", () => {
    const f = makeFixture("not-under-ro");
    // Plant a gitdir OUTSIDE the real common, with commondir pointing back at the real common.
    // ADMIN then fails the strict-descendant-of-RO check.
    const outsideRoot = path.join(f.root, "outside-common");
    const outsideAdmin = path.join(outsideRoot, "worktrees", f.worktreeId);
    fs.mkdirSync(outsideAdmin, { recursive: true });
    fs.writeFileSync(path.join(outsideAdmin, "commondir"), f.common + "\n");
    fs.writeFileSync(path.join(outsideAdmin, "gitdir"), path.join(f.worktreePath, ".git") + "\n");
    // Point the worktree at the outside admin (canonical absolute gitdir).
    fs.writeFileSync(path.join(f.worktreePath, ".git"), `gitdir: ${outsideAdmin}\n`);

    expect(() =>
      makeCycleGitAllowEnv({
        id: f.cycleId,
        git_worktree_path: f.worktreePath,
        git_worktree_id: f.worktreeId,
        projectDir: f.projectDir,
      })
    ).toThrow(/not under RO/);
  });

  it("an identity not belonging to the registered project throws", () => {
    const f = makeFixture("foreign-project");
    const otherProj = fs.mkdtempSync(path.join(f.root, "other-proj-"));
    expect(() =>
      makeCycleGitAllowEnv({
        id: f.cycleId,
        git_worktree_path: f.worktreePath,
        git_worktree_id: f.worktreeId,
        projectDir: otherProj,
      })
    ).toThrow(/does not belong to the registered project/);
  });

  it("a GIT_ADMIN resolving to <common>/worktrees itself throws", () => {
    const f = makeFixture("admin-worktrees-itself");
    // git_worktree_id of '.' would collapse path.join(common,'worktrees','.') → worktrees.
    expect(() =>
      makeCycleGitAllowEnv({
        id: f.cycleId,
        git_worktree_path: f.worktreePath,
        git_worktree_id: ".",
        projectDir: f.projectDir,
      })
    ).toThrow(/worktrees itself|escape|single path segment|\./i);

    // Empty id with path set is partial identity (would also collapse onto worktrees).
    expect(() =>
      makeCycleGitAllowEnv({
        id: f.cycleId,
        git_worktree_path: f.worktreePath,
        git_worktree_id: "",
        projectDir: f.projectDir,
      })
    ).toThrow(/partial git identity/);
  });

  it("a GIT_ADMIN resolving to another cycle's id throws", () => {
    const f = makeFixture("peer-admin-id");
    expect(f.peerWorktreeId).not.toBe(f.worktreeId);
    expect(() =>
      makeCycleGitAllowEnv({
        id: f.cycleId,
        git_worktree_path: f.worktreePath,
        // Peer id while pointing at THIS cycle's worktree path.
        git_worktree_id: f.peerWorktreeId,
        projectDir: f.projectDir,
      })
    ).toThrow(/another cycle's id/);
  });

  it("happy path emits exactly 1 RO, 1 ADMIN, 2 REF_RW and 1 OBJ; ADMIN ends with persisted id; objects never in REF_RW/ADMIN; bare <project>/.git never a write class", () => {
    const f = makeFixture("happy");
    const env = makeCycleGitAllowEnv({
      id: f.cycleId,
      git_worktree_path: f.worktreePath,
      git_worktree_id: f.worktreeId,
      projectDir: f.projectDir,
    });

    expect(env.endsWith(" ")).toBe(true);
    expect(env).toMatch(/^HELM_SANDBOX_GIT_RO='/);
    expect(env).toContain("HELM_SANDBOX_GIT_ADMIN=");
    expect(env).toContain("HELM_SANDBOX_GIT_REF_RW=");
    expect(env).toContain("HELM_SANDBOX_GIT_OBJ=");

    const parsed = parseGitEnv(env);

    // Exactly 1 RO, 1 ADMIN, 2 REF_RW, 1 OBJ.
    expect(parsed.ro).toBe(f.common);
    expect(parsed.admin).toBe(path.join(f.common, "worktrees", f.worktreeId));
    expect(parsed.refRw).toHaveLength(2);
    expect(parsed.obj).toBe(path.join(f.common, "objects"));

    // ADMIN ends with the persisted worktree id.
    expect(parsed.admin.endsWith(path.sep + f.worktreeId)).toBe(true);
    expect(path.basename(parsed.admin)).toBe(f.worktreeId);

    // REF_RW is the namespaced ref dir + reflog mirror for THIS cycle.
    expect(parsed.refRw[0]).toBe(
      path.join(f.common, "refs", "heads", "helm", "cycle", String(f.cycleId))
    );
    expect(parsed.refRw[1]).toBe(
      path.join(f.common, "logs", "refs", "heads", "helm", "cycle", String(f.cycleId))
    );

    // objects never appears in REF_RW or ADMIN.
    expect(parsed.admin.includes(`${path.sep}objects`)).toBe(false);
    for (const p of parsed.refRw) {
      expect(p.includes(`${path.sep}objects`)).toBe(false);
      expect(path.basename(p)).not.toBe("objects");
    }
    expect(path.basename(parsed.obj)).toBe("objects");

    // bare <project>/.git (the common dir) never appears as a write-class path.
    const bareGit = f.common;
    expect(parsed.admin).not.toBe(bareGit);
    expect(parsed.obj).not.toBe(bareGit);
    for (const p of parsed.refRw) {
      expect(p).not.toBe(bareGit);
    }
    // RO is the common dir (often <project>/.git) — that is intentional and read-only.
    expect(parsed.ro).toBe(bareGit);
  });
});
