/**
 * B7 (R4.1/R4.3) — cycle-scoped git capability compiled-binary probes.
 *
 * `tools/helm-sandbox.c` gains four new classes threaded via HELM_SANDBOX_GIT_RO / _ADMIN /
 * _REF_RW / _OBJ (see the file-header doc comment there for the full design). These probes run
 * against the REAL compiled binary and a REAL disposable git repo (never Helm's own checkout —
 * see plan/cycle-branch-lifecycle/plan.md §4), mirroring sandbox-scaffold-fence.test.ts /
 * c3-writefence.test.ts / b22b-governed-fence.test.ts.
 *
 * Fixtures live directly under $HOME (NOT /tmp, NOT any $HOME dot-dir tooling exception:
 * .config .cache .npm .claude .grok .codex .local/state .local/share) — /tmp gets a blanket rw
 * grant in the default profile that would silently mask the very GIT_ADMIN/GIT_REF_RW/GIT_OBJ
 * enforcement under test here. This is the exact mistake the OBJ-mask derivation caught on the
 * first (tainted, /tmp-based) attempt; see
 * plan/cycle-branch-lifecycle/validation/B7-impl-a1/obj-mask-derivation.md for the full account.
 */
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { resolveHelmSandboxBin, getWriteFenceStatus } from "./security/landlock-sandbox.js";

const BIN = resolveHelmSandboxBin();

type RunResult = { status: number | null; stdout: string; stderr: string };

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function runFenced(proj: string, cmd: string[], extraEnv: Record<string, string>): RunResult {
  const r = spawnSync(BIN, [proj, ...cmd], {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function sh(proj: string, script: string, extraEnv: Record<string, string>): RunResult {
  return runFenced(proj, ["bash", "-c", script], extraEnv);
}

interface Fixture {
  root: string;
  repo: string;
  common: string;
  target: string;
  peerwt: string;
  baseSha: string;
  gitRo: string;
  gitAdmin: string;
  gitRefRw: string;
  gitObj: string;
  peerAdminIndexPath: string;
  peerAdminIndexBefore: Buffer;
  looseObjectPath: string;
  looseObjectBefore: Buffer;
  mainRefPath: string;
  peerRefPath: string;
}

function findFirstLooseObject(common: string): string {
  const objDir = path.join(common, "objects");
  for (const prefix of fs.readdirSync(objDir).sort()) {
    if (prefix === "pack" || prefix === "info") continue;
    const sub = path.join(objDir, prefix);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const name of fs.readdirSync(sub)) {
      return path.join(sub, name);
    }
  }
  throw new Error("no pre-existing loose object found in fixture repo");
}

/** Base repo (main, one commit) + peer cycle branch (no worktree) + peer LINKED worktree + the
 * target worktree the fenced seat operates in — exactly the AC's required fixture shape. */
function makeFixture(label: string): Fixture {
  const root = fs.mkdtempSync(path.join(os.homedir(), `helm-b7-git-fence-${label}-`));
  const repo = path.join(root, "repo");
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q", "-b", "main"]);
  git(repo, ["config", "user.email", "t@t.com"]);
  git(repo, ["config", "user.name", "t"]);
  fs.writeFileSync(path.join(repo, "f.txt"), "hello\n");
  git(repo, ["add", "f.txt"]);
  git(repo, ["commit", "-q", "-m", "init"]);
  const baseSha = git(repo, ["rev-parse", "HEAD"]);

  git(repo, ["branch", "helm/cycle/99/peer"]);
  const peerwt = path.join(root, "peerwt");
  git(repo, ["worktree", "add", "-q", "-b", "helm/cycle/2/peerwt", peerwt, "main"]);
  const target = path.join(root, "target");
  git(repo, ["worktree", "add", "-q", "-b", "helm/cycle/1/target", target, "main"]);

  const common = git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);

  const gitRo = common;
  const gitAdmin = path.join(common, "worktrees", "target");
  const gitRefRw = [
    path.join(common, "refs", "heads", "helm", "cycle", "1"),
    path.join(common, "logs", "refs", "heads", "helm", "cycle", "1"),
  ].join(":");
  const gitObj = path.join(common, "objects");

  const peerAdminIndexPath = path.join(common, "worktrees", "peerwt", "index");
  const peerAdminIndexBefore = fs.readFileSync(peerAdminIndexPath);

  const looseObjectPath = findFirstLooseObject(common);
  const looseObjectBefore = fs.readFileSync(looseObjectPath);

  const mainRefPath = path.join(common, "refs", "heads", "main");
  const peerRefPath = path.join(common, "refs", "heads", "helm", "cycle", "99", "peer");

  return {
    root, repo, common, target, peerwt, baseSha,
    gitRo, gitAdmin, gitRefRw, gitObj,
    peerAdminIndexPath, peerAdminIndexBefore,
    looseObjectPath, looseObjectBefore,
    mainRefPath, peerRefPath,
  };
}

function envFor(f: Fixture): Record<string, string> {
  return {
    HELM_SANDBOX_GIT_RO: f.gitRo,
    HELM_SANDBOX_GIT_ADMIN: f.gitAdmin,
    HELM_SANDBOX_GIT_REF_RW: f.gitRefRw,
    HELM_SANDBOX_GIT_OBJ: f.gitObj,
  };
}

function cleanup(f: Fixture) {
  try { fs.rmSync(f.root, { recursive: true, force: true }); } catch { /* best effort */ }
}

function requireActiveFence() {
  const fence = getWriteFenceStatus();
  if (fence.status !== "active") {
    throw new Error(
      `landlock unavailable in test env (status=${fence.status}, detail=${fence.detail}) — ` +
        `the cycle-git-fence probes must FAIL (not skip); we never green a dead fence`
    );
  }
}

beforeAll(() => {
  if (!fs.existsSync(BIN)) {
    throw new Error(`cycle-git-fence suite requires the built binary at ${BIN} (run npm run build first)`);
  }
  requireActiveFence();
});

// ---------------------------------------------------------------------------------------------
describe("B7 positive + negatives: commit succeeds, peer admin/objects/refs stay protected", () => {
  let f: Fixture;
  beforeAll(() => { f = makeFixture("main"); });
  afterAll(() => { cleanup(f); });

  it("real `git add`+`git commit` in the target worktree succeeds with the recorded minimum OBJ mask", () => {
    const r = sh(
      f.target,
      `cd '${f.target}' && echo new-content > new.txt && git add new.txt && ` +
        `git -c user.email=t@t.com -c user.name=t commit -q -m probe && echo COMMIT_OK`,
      envFor(f)
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("COMMIT_OK");
    const log = git(f.repo, ["log", "--oneline", "helm/cycle/1/target"]);
    expect(log.split("\n").length).toBe(2); // init + probe
  });

  it("the PEER worktree's admin dir is unwritable and its index is byte-identical after the target commit", () => {
    const r = sh(f.target, `echo PWNED >> '${f.peerAdminIndexPath}'`, envFor(f));
    expect(r.status).not.toBe(0);
    const after = fs.readFileSync(f.peerAdminIndexPath);
    expect(after.equals(f.peerAdminIndexBefore)).toBe(true);
  });

  it("a pre-existing loose object reachable from base is byte-identical after, and unlink on it is DENIED", () => {
    const rUnlink = sh(f.target, `rm '${f.looseObjectPath}'`, envFor(f));
    expect(rUnlink.status).not.toBe(0);
    const rTrunc = sh(f.target, `: > '${f.looseObjectPath}'`, envFor(f));
    expect(rTrunc.status).not.toBe(0);
    const after = fs.readFileSync(f.looseObjectPath);
    expect(after.equals(f.looseObjectBefore)).toBe(true);
    expect(fs.existsSync(f.looseObjectPath)).toBe(true);
  });

  it("direct write against refs/heads/main and the peer ref is DENIED, SHAs byte-identical", () => {
    const mainBefore = fs.readFileSync(f.mainRefPath, "utf8");
    const peerBefore = fs.readFileSync(f.peerRefPath, "utf8");

    const rMain = sh(f.target, `echo deadbeefdeadbeefdeadbeefdeadbeefdeadbeef > '${f.mainRefPath}'`, envFor(f));
    expect(rMain.status).not.toBe(0);
    const rPeer = sh(f.target, `echo deadbeefdeadbeefdeadbeefdeadbeefdeadbeef > '${f.peerRefPath}'`, envFor(f));
    expect(rPeer.status).not.toBe(0);

    expect(fs.readFileSync(f.mainRefPath, "utf8")).toBe(mainBefore);
    expect(fs.readFileSync(f.peerRefPath, "utf8")).toBe(peerBefore);
  });

  it("`git update-ref` against refs/heads/main and the peer ref is DENIED, SHAs byte-identical", () => {
    const mainBefore = fs.readFileSync(f.mainRefPath, "utf8").trim();
    const peerBefore = fs.readFileSync(f.peerRefPath, "utf8").trim();
    const newSha = git(f.repo, ["rev-parse", "helm/cycle/1/target"]); // the just-created probe commit

    const rMain = runFenced(f.target, ["git", "-C", f.repo, "update-ref", "refs/heads/main", newSha], envFor(f));
    expect(rMain.status).not.toBe(0);
    const rPeer = runFenced(
      f.target,
      ["git", "-C", f.repo, "update-ref", "refs/heads/helm/cycle/99/peer", newSha],
      envFor(f)
    );
    expect(rPeer.status).not.toBe(0);

    expect(git(f.repo, ["rev-parse", "main"])).toBe(mainBefore);
    expect(git(f.repo, ["rev-parse", "helm/cycle/99/peer"])).toBe(peerBefore);
  });
});

// ---------------------------------------------------------------------------------------------
describe("B7 fail-closed launch refusals: nonzero exit, no partial rule set applied", () => {
  let f: Fixture;
  beforeAll(() => { f = makeFixture("refuse"); });
  afterAll(() => { cleanup(f); });

  it("GIT_ADMIN naming <common>/worktrees itself refuses the launch nonzero", () => {
    const r = sh(f.target, `echo SHOULD-NOT-RUN`, {
      HELM_SANDBOX_GIT_RO: f.gitRo,
      HELM_SANDBOX_GIT_ADMIN: path.join(f.common, "worktrees"),
      HELM_SANDBOX_GIT_REF_RW: f.gitRefRw,
      HELM_SANDBOX_GIT_OBJ: f.gitObj,
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(r.stderr).toMatch(/worktrees itself/i);
  });

  it("GIT_ADMIN naming a non-direct-child of <common>/worktrees refuses the launch nonzero", () => {
    const nested = path.join(f.common, "worktrees", "target", "nested-not-allowed");
    fs.mkdirSync(nested, { recursive: true });
    const r = sh(f.target, `echo SHOULD-NOT-RUN`, {
      HELM_SANDBOX_GIT_RO: f.gitRo,
      HELM_SANDBOX_GIT_ADMIN: nested,
      HELM_SANDBOX_GIT_REF_RW: f.gitRefRw,
      HELM_SANDBOX_GIT_OBJ: f.gitObj,
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(r.stderr).toMatch(/DIRECT child/i);
  });

  it("a GIT_* entry outside GIT_RO refuses the launch nonzero", () => {
    const outside = fs.mkdtempSync(path.join(os.homedir(), "helm-b7-git-fence-outside-"));
    try {
      const r = sh(f.target, `echo SHOULD-NOT-RUN`, {
        HELM_SANDBOX_GIT_RO: f.gitRo,
        HELM_SANDBOX_GIT_ADMIN: outside, // outside the common dir entirely
        HELM_SANDBOX_GIT_REF_RW: f.gitRefRw,
        HELM_SANDBOX_GIT_OBJ: f.gitObj,
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
      expect(r.stderr).toMatch(/strict descendant/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("a GIT_* entry naming the common-dir root itself refuses the launch nonzero", () => {
    const r = sh(f.target, `echo SHOULD-NOT-RUN`, {
      HELM_SANDBOX_GIT_RO: f.gitRo,
      HELM_SANDBOX_GIT_ADMIN: f.gitAdmin,
      HELM_SANDBOX_GIT_REF_RW: f.gitRefRw,
      HELM_SANDBOX_GIT_OBJ: f.gitRo, // GIT_OBJ = the common-dir root itself
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(r.stderr).toMatch(/strict descendant/i);
  });

  it("a GIT_REF_RW entry outside GIT_RO refuses the launch nonzero (list-entry validation, not just the whole var)", () => {
    const outside = fs.mkdtempSync(path.join(os.homedir(), "helm-b7-git-fence-outside2-"));
    try {
      const r = sh(f.target, `echo SHOULD-NOT-RUN`, {
        HELM_SANDBOX_GIT_RO: f.gitRo,
        HELM_SANDBOX_GIT_ADMIN: f.gitAdmin,
        HELM_SANDBOX_GIT_REF_RW: `${f.gitRefRw.split(":")[0]}:${outside}`,
        HELM_SANDBOX_GIT_OBJ: f.gitObj,
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
      expect(r.stderr).toMatch(/strict descendant/i);
    } finally {
      fs.rmSync(outside, { recursive: true, force: true });
    }
  });

  it("HELM_SANDBOX_GIT_ADMIN set without HELM_SANDBOX_GIT_RO refuses the launch nonzero (partial set is a caller bug)", () => {
    const r = sh(f.target, `echo SHOULD-NOT-RUN`, {
      HELM_SANDBOX_GIT_ADMIN: f.gitAdmin,
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(r.stderr).toMatch(/travel together/i);
  });

  it("a relative HELM_SANDBOX_GIT_RO refuses the launch nonzero", () => {
    const r = sh(f.target, `echo SHOULD-NOT-RUN`, {
      HELM_SANDBOX_GIT_RO: "relative/path",
      HELM_SANDBOX_GIT_ADMIN: f.gitAdmin,
      HELM_SANDBOX_GIT_REF_RW: f.gitRefRw,
      HELM_SANDBOX_GIT_OBJ: f.gitObj,
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(r.stderr).toMatch(/absolute path/i);
  });

  it("a non-canonical HELM_SANDBOX_GIT_OBJ (trailing slash) refuses the launch nonzero", () => {
    const r = sh(f.target, `echo SHOULD-NOT-RUN`, {
      HELM_SANDBOX_GIT_RO: f.gitRo,
      HELM_SANDBOX_GIT_ADMIN: f.gitAdmin,
      HELM_SANDBOX_GIT_REF_RW: f.gitRefRw,
      HELM_SANDBOX_GIT_OBJ: `${f.gitObj}/`,
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(r.stderr).toMatch(/not canonical/i);
  });

  it("a symlinked HELM_SANDBOX_GIT_OBJ refuses the launch nonzero", () => {
    const linkPath = path.join(f.root, "objects-symlink");
    fs.symlinkSync(f.gitObj, linkPath);
    try {
      const r = sh(f.target, `echo SHOULD-NOT-RUN`, {
        HELM_SANDBOX_GIT_RO: f.gitRo,
        HELM_SANDBOX_GIT_ADMIN: f.gitAdmin,
        HELM_SANDBOX_GIT_REF_RW: f.gitRefRw,
        HELM_SANDBOX_GIT_OBJ: linkPath,
      });
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
      expect(r.stderr).toMatch(/not canonical/i);
    } finally {
      fs.rmSync(linkPath, { force: true });
    }
  });

  it("a nonexistent HELM_SANDBOX_GIT_ADMIN entry refuses the launch nonzero (no ensure_dir)", () => {
    const r = sh(f.target, `echo SHOULD-NOT-RUN`, {
      HELM_SANDBOX_GIT_RO: f.gitRo,
      HELM_SANDBOX_GIT_ADMIN: path.join(f.common, "worktrees", "does-not-exist"),
      HELM_SANDBOX_GIT_REF_RW: f.gitRefRw,
      HELM_SANDBOX_GIT_OBJ: f.gitObj,
    });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN");
    expect(fs.existsSync(path.join(f.common, "worktrees", "does-not-exist"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
describe("B7 no-op baseline: absent HELM_SANDBOX_GIT_RO is byte-identical to every existing caller", () => {
  it("a launch with no GIT_* env vars behaves exactly like the pre-B7 binary (git write outside the project dir still denied by the plain project fence)", () => {
    const f = makeFixture("noop");
    try {
      const r = sh(f.target, `cd '${f.target}' && echo x > new.txt && git add new.txt && git -c user.email=t@t.com -c user.name=t commit -q -m probe`, {});
      // no GIT_OBJ/ADMIN/REF_RW granted -> commit must fail (git-common-dir writes are outside the plain project fence)
      expect(r.status).not.toBe(0);
    } finally {
      cleanup(f);
    }
  });
});
