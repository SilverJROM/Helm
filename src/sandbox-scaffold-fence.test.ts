/**
 * sandbox-scaffold-fence — sol decision-4 conditional-root write fence for tools/helm-sandbox.c.
 *
 * grant_project_rw_excluding_root_governed() now has TWO launch-time modes, selected once by whether
 * a literal `north-star.md` entry exists directly in the canonical project root:
 *   - PROTECTED-ROOT MODE (root north-star.md present — regular file OR symlink): the historical
 *     R7.26/B22b policy. north-star.md write/delete stays kernel-DENIED, and brand-new top-level
 *     creation stays DENIED (a directory-scope rule on the root would re-cover north-star.md);
 *     existing children keep their recursive rw.
 *   - SCAFFOLD MODE (no root north-star.md at launch — the Helm CC-cycle layout, where north-star.md
 *     lives nested under cycle/<cycle>/): ONE write-only PATH_BENEATH rule is added on the root fd,
 *     so a from-scratch project CAN create src/, package.json, etc., write within them, and
 *     rename/delete top-level entries. The rule carries WRITE-side bits ONLY
 *     (WRITE_FILE|TRUNCATE|MAKE_REG|MAKE_DIR|REMOVE_FILE|REMOVE_DIR|MAKE_SYM|REFER) — no read/exec.
 *
 * These are kernel-backed probes against the real compiled dist/tools/helm-sandbox binary (mirrors
 * c3-writefence.test.ts / b22b-governed-fence.test.ts). Fixtures live under $HOME (NOT /tmp, NOT the
 * $HOME dot-dir tooling exceptions) so a real EACCES cannot be masked by a documented write exception.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { resolveHelmSandboxBin, getWriteFenceStatus } from "./security/landlock-sandbox.js";

const BIN = resolveHelmSandboxBin();
const CYCLE = "c99-scaffold-cycle";
// System paths bash + coreutils genuinely need for read+exec under the strict profile.
const SYS_ALLOW = ["/usr", "/lib", "/lib64", "/bin", "/etc"].filter((p) => fs.existsSync(p));

type RunResult = { status: number | null; stdout: string; stderr: string };

function runFenced(
  proj: string,
  cmd: string[],
  extraEnv?: Record<string, string | undefined>
): RunResult {
  const r = spawnSync(BIN, [proj, ...cmd], {
    encoding: "utf8",
    timeout: 15000,
    env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function strictEnv(allow: string[]): Record<string, string> {
  return { HELM_SANDBOX_RO_PROFILE: "strict", HELM_SANDBOX_RO_ALLOW: allow.join(":") };
}

/** Helm CC-cycle from-scratch shape: only pre-created Helm dirs + a NESTED north-star.md under
 *  cycle/<cycle>/, and (deliberately) NO north-star.md at the project ROOT. */
function makeScaffoldProject(): string {
  const proj = fs.mkdtempSync(path.join(os.homedir(), "helm-scaffold-proj-"));
  fs.mkdirSync(path.join(proj, "cycle", CYCLE), { recursive: true });
  fs.mkdirSync(path.join(proj, "helm_docs"), { recursive: true });
  fs.mkdirSync(path.join(proj, "helm_tasks"), { recursive: true });
  // the authoritative north-star lives nested (CC-cycle layout) — NOT at the root.
  fs.writeFileSync(path.join(proj, "cycle", CYCLE, "north-star.md"), "NESTED north-star v1\n");
  // a writable existing child used by the shared escape probes.
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "src", "f.txt"), "INSIDE-OK\n");
  return proj;
}

/** Classic protected-root shape: a root-level north-star.md (regular file) + an existing child dir
 *  and an existing top-level regular file (the FIX1 real-repo shape). */
function makeProtectedProject(): string {
  const proj = fs.mkdtempSync(path.join(os.homedir(), "helm-protected-proj-"));
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "north-star.md"), "GOVERNED north-star v1\n");
  fs.writeFileSync(path.join(proj, "package.json"), '{"name":"protected-fixture"}\n');
  fs.writeFileSync(path.join(proj, "src", "f.txt"), "INSIDE-OK\n");
  return proj;
}

/** Protected-root via a SYMLINK north-star.md (dangling, points outside): proves AT_SYMLINK_NOFOLLOW
 *  counts the symlink as present and selects protected mode (never scaffold). */
function makeSymlinkProtectedProject(): string {
  const proj = fs.mkdtempSync(path.join(os.homedir(), "helm-symlink-proj-"));
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.symlinkSync("/nonexistent-north-star-target-xyz", path.join(proj, "north-star.md"));
  fs.writeFileSync(path.join(proj, "src", "f.txt"), "INSIDE-OK\n");
  return proj;
}

function requireActiveFence() {
  const fence = getWriteFenceStatus();
  if (fence.status !== "active") {
    // Never green a dead fence — a kernel-backed suite must FAIL (not skip) if Landlock is absent.
    throw new Error(
      `landlock unavailable in test env (status=${fence.status}, detail=${fence.detail}) — ` +
        `the conditional-root write-fence probes must FAIL (not skip); we never green a dead fence`
    );
  }
}

beforeAll(() => {
  if (!fs.existsSync(BIN)) {
    throw new Error(`scaffold-fence suite requires the built binary at ${BIN} (run npm run build first)`);
  }
  requireActiveFence();
});

// ---------------------------------------------------------------------------------------------
describe("scaffold mode: root north-star.md ABSENT → from-scratch top-level creation is granted", () => {
  let proj = "";
  beforeAll(() => { proj = makeScaffoldProject(); });
  afterAll(() => { try { fs.rmSync(proj, { recursive: true, force: true }); } catch {} });

  it("CAN create top-level dirs (src/ test/ public/) and a top-level regular file, and write within them", () => {
    const r = runFenced(proj, [
      "bash",
      "-c",
      `mkdir "${proj}/src2" "${proj}/test" "${proj}/public" && ` +
        `echo TOP-FILE > "${proj}/package.json" && ` +
        `echo A > "${proj}/src2/a.ts" && echo B > "${proj}/test/b.spec.ts" && echo C > "${proj}/public/c.html" && ` +
        `echo OK`,
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/OK/);
    expect(fs.existsSync(path.join(proj, "src2", "a.ts"))).toBe(true);
    expect(fs.existsSync(path.join(proj, "test", "b.spec.ts"))).toBe(true);
    expect(fs.existsSync(path.join(proj, "public", "c.html"))).toBe(true);
    expect(fs.readFileSync(path.join(proj, "package.json"), "utf8")).toMatch(/TOP-FILE/);
  });

  it("CAN rename and delete top-level entries", () => {
    fs.writeFileSync(path.join(proj, "to-rename.txt"), "R\n");
    fs.writeFileSync(path.join(proj, "to-delete.txt"), "D\n");
    fs.mkdirSync(path.join(proj, "dir-to-remove"), { recursive: true });

    const rMv = runFenced(proj, ["bash", "-c", `mv "${proj}/to-rename.txt" "${proj}/renamed.txt" && echo OK`]);
    expect(rMv.status).toBe(0);
    expect(fs.existsSync(path.join(proj, "renamed.txt"))).toBe(true);
    expect(fs.existsSync(path.join(proj, "to-rename.txt"))).toBe(false);

    const rRmFile = runFenced(proj, ["bash", "-c", `rm "${proj}/to-delete.txt" && echo OK`]);
    expect(rRmFile.status).toBe(0);
    expect(fs.existsSync(path.join(proj, "to-delete.txt"))).toBe(false);

    const rRmDir = runFenced(proj, ["bash", "-c", `rmdir "${proj}/dir-to-remove" && echo OK`]);
    expect(rRmDir.status).toBe(0);
    expect(fs.existsSync(path.join(proj, "dir-to-remove"))).toBe(false);
  });

  it("the nested cycle/<cycle>/north-star.md does NOT trigger root protection (mode keys on the ROOT entry only)", () => {
    // Presence of the nested north-star is irrelevant to mode selection; scaffolding still works.
    expect(fs.existsSync(path.join(proj, "cycle", CYCLE, "north-star.md"))).toBe(true);
    const r = runFenced(proj, ["bash", "-c", `mkdir "${proj}/scaffold-marker" && echo OK`]);
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(proj, "scaffold-marker"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("protected-root mode: root north-star.md PRESENT (regular file) → historical B22b denials hold", () => {
  let proj = "";
  beforeAll(() => { proj = makeProtectedProject(); });
  afterAll(() => { try { fs.rmSync(proj, { recursive: true, force: true }); } catch {} });

  it("north-star.md write is kernel-DENIED", () => {
    const r = runFenced(proj, ["bash", "-c", `echo pwned >> "${proj}/north-star.md"`]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/permission denied/i);
    expect(fs.readFileSync(path.join(proj, "north-star.md"), "utf8")).toBe("GOVERNED north-star v1\n");
  });

  it("north-star.md delete is kernel-DENIED", () => {
    const r = runFenced(proj, ["bash", "-c", `rm "${proj}/north-star.md"`]);
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(proj, "north-star.md"))).toBe(true);
  });

  it("brand-new top-level creation is DENIED (a root dir-rule would re-cover north-star.md)", () => {
    const rFile = runFenced(proj, ["bash", "-c", `echo probe > "${proj}/new-top.txt"`]);
    expect(rFile.status).not.toBe(0);
    expect(fs.existsSync(path.join(proj, "new-top.txt"))).toBe(false);

    const rDir = runFenced(proj, ["bash", "-c", `mkdir "${proj}/new-top-dir"`]);
    expect(rDir.status).not.toBe(0);
    expect(fs.existsSync(path.join(proj, "new-top-dir"))).toBe(false);
  });

  it("existing-child behavior is unchanged: src/** writable, top-level package.json writable, but NOT deletable", () => {
    const rSrc = runFenced(proj, ["bash", "-c", `echo appended >> "${proj}/src/f.txt" && echo OK`]);
    expect(rSrc.status).toBe(0);
    expect(fs.readFileSync(path.join(proj, "src", "f.txt"), "utf8")).toMatch(/appended/);

    const rPkg = runFenced(proj, ["bash", "-c", `echo appended >> "${proj}/package.json" && echo OK`]);
    expect(rPkg.status).toBe(0);
    expect(fs.readFileSync(path.join(proj, "package.json"), "utf8")).toMatch(/appended/);

    const rDel = runFenced(proj, ["bash", "-c", `rm "${proj}/package.json"`]);
    expect(rDel.status).not.toBe(0);
    expect(fs.existsSync(path.join(proj, "package.json"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
describe("protected-root mode: root north-star.md is a SYMLINK → AT_SYMLINK_NOFOLLOW selects protected mode", () => {
  let proj = "";
  beforeAll(() => { proj = makeSymlinkProtectedProject(); });
  afterAll(() => { try { fs.rmSync(proj, { recursive: true, force: true }); } catch {} });

  it("a symlink north-star.md counts as present: brand-new top-level creation stays DENIED (not scaffold mode)", () => {
    const r = runFenced(proj, ["bash", "-c", `mkdir "${proj}/should-not-exist"`]);
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(proj, "should-not-exist"))).toBe(false);
  });

  it("the north-star.md symlink itself cannot be removed from the root (REMOVE_FILE on root not granted)", () => {
    const r = runFenced(proj, ["bash", "-c", `rm "${proj}/north-star.md"`]);
    expect(r.status).not.toBe(0);
    expect(fs.lstatSync(path.join(proj, "north-star.md")).isSymbolicLink()).toBe(true);
  });

  it("existing child dir under the symlink-protected root is still writable (protected-mode child behavior)", () => {
    const r = runFenced(proj, ["bash", "-c", `echo appended >> "${proj}/src/f.txt" && echo OK`]);
    expect(r.status).toBe(0);
    expect(fs.readFileSync(path.join(proj, "src", "f.txt"), "utf8")).toMatch(/appended/);
  });
});

// ---------------------------------------------------------------------------------------------
// SECURITY (the exact gap an independent kernel review found): a top-level symlink present in the
// project root AT LAUNCH, pointing OUTSIDE the project, must receive NO rule. The pre-fix protected
// loop did stat(path) (follows the link → the OUTSIDE dir) then add_rule(path)→open_path(path) (no
// O_NOFOLLOW → opens the OUTSIDE dir) and granted recursive rw on the outside target — a real escape
// (write outside, delete an outside victim). Scaffold mode's new MAKE_SYM-on-root lets a worker PLANT
// such a symlink before a protected relaunch. The no-follow, fd-pinned enumeration SKIPS symlink
// children, so the target is never granted.
describe("protected mode SECURITY: a launch-time top-level symlink → OUTSIDE is skipped, never granted", () => {
  let proj = "";
  let outside = "";
  beforeAll(() => {
    outside = fs.mkdtempSync(path.join(os.homedir(), "helm-evil-target-"));
    fs.writeFileSync(path.join(outside, "victim.txt"), "OUTSIDE-VICTIM\n");
    fs.writeFileSync(path.join(outside, "secret.txt"), "OUTSIDE-SECRET\n");

    proj = fs.mkdtempSync(path.join(os.homedir(), "helm-symlink-escape-proj-"));
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.writeFileSync(path.join(proj, "north-star.md"), "GOVERNED north-star v1\n");
    fs.writeFileSync(path.join(proj, "package.json"), '{"name":"escape-fixture"}\n');
    fs.writeFileSync(path.join(proj, "src", "f.txt"), "INSIDE-OK\n");
    // THE ATTACK: a top-level symlink present AT LAUNCH pointing at an outside directory.
    fs.symlinkSync(outside, path.join(proj, "evil"));
  });
  afterAll(() => {
    try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
  });

  it("write to the outside target THROUGH the launch-time top-level symlink is DENIED (symlink child got no write rule)", () => {
    const r = runFenced(proj, ["bash", "-c", `echo PWNED > "${proj}/evil/pwned.txt"`]);
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(outside, "pwned.txt"))).toBe(false);
  });

  it("delete of an outside victim THROUGH the launch-time top-level symlink is DENIED", () => {
    const r = runFenced(proj, ["bash", "-c", `rm "${proj}/evil/victim.txt"`]);
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(outside, "victim.txt"))).toBe(true);
  });

  it("CONTROL (no symlink): the same outside dir is unwritable directly too — proving outside has no write grant in either shape", () => {
    // A second protected project with NO top-level symlink: a direct write to the same outside dir
    // is denied. Isolates that the escape vector is the followed symlink, not a general reachability.
    const proj2 = makeProtectedProject();
    try {
      const bad = path.join(outside, "direct.txt");
      const r = runFenced(proj2, ["bash", "-c", `echo NOPE > "${bad}"`]);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(bad)).toBe(false);
    } finally {
      try { fs.rmSync(proj2, { recursive: true, force: true }); } catch {}
    }
  });

  it("the symlink is skipped for WRITE only: its target is still READABLE via the ro rule (default profile)", () => {
    // 'skip' means 'no write rule', not 'unreadable' — the root-ro rule still covers the outside
    // target for reads. This documents the exact semantics of the S_ISLNK skip.
    const r = runFenced(proj, ["bash", "-c", `cat "${proj}/evil/secret.txt"`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("OUTSIDE-SECRET");
  });

  it("enumeration is otherwise unchanged: existing dir/file children writable, north-star.md still DENIED", () => {
    const rSrc = runFenced(proj, ["bash", "-c", `echo appended >> "${proj}/src/f.txt" && echo OK`]);
    expect(rSrc.status).toBe(0);
    expect(fs.readFileSync(path.join(proj, "src", "f.txt"), "utf8")).toMatch(/appended/);

    const rPkg = runFenced(proj, ["bash", "-c", `echo appended >> "${proj}/package.json" && echo OK`]);
    expect(rPkg.status).toBe(0);
    expect(fs.readFileSync(path.join(proj, "package.json"), "utf8")).toMatch(/appended/);

    const rNs = runFenced(proj, ["bash", "-c", `echo pwned >> "${proj}/north-star.md"`]);
    expect(rNs.status).not.toBe(0);
    expect(fs.readFileSync(path.join(proj, "north-star.md"), "utf8")).toBe("GOVERNED north-star v1\n");
  });
});

// ---------------------------------------------------------------------------------------------
// Escape probes must hold in BOTH modes: the write grant is scoped to the project inode hierarchy
// and NEVER reaches outside, links, cross-boundary renames, or the root's own parent.
function runEscapeProbes(makeProj: () => string, label: string) {
  describe(`escape probes (${label})`, () => {
    let proj = "";
    let outside = "";
    beforeAll(() => {
      proj = makeProj();
      outside = fs.mkdtempSync(path.join(os.homedir(), "helm-escape-outside-"));
      fs.writeFileSync(path.join(outside, "victim.txt"), "OUTSIDE\n");
    });
    afterAll(() => {
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
    });

    it("outside-sibling write is DENIED", () => {
      const bad = path.join(outside, "escape.txt");
      const r = runFenced(proj, ["bash", "-c", `echo ESCAPE > "${bad}"`]);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(bad)).toBe(false);
    });

    it("write THROUGH a project symlink that targets outside is DENIED", () => {
      // The symlink lands inside the project (allowed in scaffold mode; inside src/ in protected mode);
      // writing through it follows to the outside target, which has no write grant → denied.
      const linkPath = path.join(proj, "src", "outlink");
      const target = path.join(outside, "via-symlink.txt");
      const r = runFenced(proj, [
        "bash",
        "-c",
        `ln -s "${target}" "${linkPath}" && echo VIA-LINK > "${linkPath}"`,
      ]);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(target)).toBe(false);
    });

    it("cross-boundary rename (project → outside) is DENIED", () => {
      const r = runFenced(proj, ["bash", "-c", `mv "${proj}/src/f.txt" "${outside}/stolen.txt"`]);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(path.join(outside, "stolen.txt"))).toBe(false);
      expect(fs.existsSync(path.join(proj, "src", "f.txt"))).toBe(true);
    });

    it("cross-boundary hard-link (project → outside) is DENIED", () => {
      const r = runFenced(proj, ["bash", "-c", `ln "${proj}/src/f.txt" "${outside}/hardlink.txt"`]);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(path.join(outside, "hardlink.txt"))).toBe(false);
    });

    it("the project root itself cannot be renamed or deleted (no write grant on the parent)", () => {
      const rMv = runFenced(proj, ["bash", "-c", `mv "${proj}" "${proj}.hijack"`]);
      expect(rMv.status).not.toBe(0);
      expect(fs.existsSync(proj)).toBe(true);
      expect(fs.existsSync(`${proj}.hijack`)).toBe(false);

      const rRm = runFenced(proj, ["bash", "-c", `rm -rf "${proj}" 2>/dev/null; rmdir "${proj}"`]);
      expect(rRm.status).not.toBe(0);
      expect(fs.existsSync(proj)).toBe(true);
    });
  });
}
runEscapeProbes(makeScaffoldProject, "scaffold mode");
runEscapeProbes(makeProtectedProject, "protected mode");

// ---------------------------------------------------------------------------------------------
describe("strict read profile is unchanged under scaffold mode (write-only root rule carries no read bits)", () => {
  let proj = "";
  let outside = "";
  beforeAll(() => {
    proj = makeScaffoldProject();
    outside = fs.mkdtempSync(path.join(os.homedir(), "helm-strict-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "CARDS-SECRET\n");
  });
  afterAll(() => {
    try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
  });

  it("outside/excluded reads are DENIED under strict (scaffold write rule adds no read reach)", () => {
    const r = runFenced(proj, ["bash", "-c", `cat "${outside}/secret.txt"`], strictEnv(SYS_ALLOW));
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("CARDS-SECRET");
    expect(r.stderr).toMatch(/permission denied/i);
  });

  it("project reads still work under strict (project-ro rule, not the write-only scaffold rule)", () => {
    const r = runFenced(
      proj,
      ["bash", "-c", `cat "${proj}/src/f.txt" && cat "${proj}/cycle/${CYCLE}/north-star.md" && ls "${proj}"`],
      strictEnv(SYS_ALLOW)
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("INSIDE-OK");
    expect(r.stdout).toContain("NESTED north-star v1");
    expect(r.stdout).toContain("cycle");
  });

  it("scaffold top-level creation still works under strict (write bits are granted; reads come only from project-ro)", () => {
    const r = runFenced(proj, ["bash", "-c", `mkdir "${proj}/strict-scaffold" && echo X > "${proj}/strict-top.txt" && echo OK`], strictEnv(SYS_ALLOW));
    expect(r.status).toBe(0);
    expect(fs.existsSync(path.join(proj, "strict-scaffold"))).toBe(true);
    expect(fs.readFileSync(path.join(proj, "strict-top.txt"), "utf8")).toMatch(/X/);
  });
});

// ---------------------------------------------------------------------------------------------
describe("fail-closed: a non-ENOENT root inspection error NEVER execs the command and names the failing op", () => {
  it("fstatat(root, north-star.md) failing with EACCES (unsearchable root) refuses fail-closed, naming fstatat", () => {
    // A project root with no search (x) permission: O_PATH open of the root still succeeds, but the
    // fstatat("north-star.md") lookup requires search on the dir → EACCES (NOT ENOENT). The binary must
    // fail() naming the op and never exec the command unfenced (absence is never inferred from EACCES).
    const proj = fs.mkdtempSync(path.join(os.homedir(), "helm-failclosed-proj-"));
    fs.mkdirSync(path.join(proj, "cycle"), { recursive: true });
    try {
      fs.chmodSync(proj, 0o000); // owner loses search → fstatat lookup EACCES
      const r = runFenced(proj, ["bash", "-c", "echo SHOULD-NOT-RUN"]);
      expect(r.status).not.toBe(0);
      expect(r.stdout).not.toContain("SHOULD-NOT-RUN"); // command never executed
      // names the failing root-inspection op (fstatat lookup, or the O_PATH root open if it trips first)
      expect(r.stderr).toMatch(/fstatat|open canonical project root/i);
      expect(r.stderr).toMatch(/fail-closed/i);
      expect(r.stderr).toMatch(/permission denied/i);
    } finally {
      try { fs.chmodSync(proj, 0o755); } catch {}
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
    }
  });
});
