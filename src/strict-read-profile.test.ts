/**
 * B-ISO1 — opt-in strict READ profile for tools/helm-sandbox.c
 * (2026-07-16 cheat-isolation AGREEMENT, Option B hybrid: mechanism in Helm proper, policy caller-side).
 *
 * Contract under test (binary-level kernel evidence is the core; TS helper + master pass-through follow):
 *  - DEFAULT (HELM_SANDBOX_RO_PROFILE absent or empty ONLY):
 *    byte-identical to the pre-existing behavior — reads OUTSIDE the project still work (root-ro).
 *    Any non-empty value other than exactly "strict" is fail-closed (REFUSE), not read-all.
 *  - STRICT (HELM_SANDBOX_RO_PROFILE=strict + HELM_SANDBOX_RO_ALLOW=<p1:p2:...>):
 *    reads/execs work ONLY inside the enumerated allowlist + the project dir; reads outside fail
 *    with EACCES. The WRITE fence is unchanged in both directions (project rw works, outside writes
 *    blocked); the broad tooling rw exceptions (/tmp, $HOME dot-dirs) stay WRITABLE for scratch/state
 *    but become UNREADABLE unless explicitly allowlisted (the sol indirect-leak finding: broad runtime
 *    grants must not silently re-open what the allowlist excludes).
 *  - STRICT fail-closed: missing/empty/zero-entry/relative/nonexistent allowlist → refuse to exec
 *    (nonzero exit, clear stderr naming the problem; the requested command NEVER runs).
 *
 * Mirrors the c3-writefence.test.ts / b22b-governed-fence.test.ts patterns: exec the compiled
 * dist/tools/helm-sandbox directly; fixtures under $HOME (NOT /tmp — /tmp is a tooling exception
 * in the default profile, and in strict mode it is deliberately probed separately).
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import {
  resolveHelmSandboxBin,
  makeStrictReadProfileEnv,
  makeWriteFencePolicy,
  resolveDeploymentStrictReadAllow,
} from "./security/landlock-sandbox.js";
import { DatabaseService } from "./db/database.js";
import { AgentEventsService } from "./services/agent-events-service.js";
import { ProviderResolverService } from "./services/provider-resolver-service.js";
import { MasterModelService } from "./services/master-model-service.js";
import { MasterRuntimeService } from "./services/master-runtime-service.js";
import { WorkerService } from "./services/worker-service.js";
import { AgentAssignmentService } from "./services/agent-assignment-service.js";
import { RealTransport } from "./services/real-transport.js";

const BIN = resolveHelmSandboxBin();

// System paths the launched cmd (bash + coreutils) genuinely needs for read+exec. On merged-usr
// boxes /bin,/lib,/lib64 are symlinks into /usr (realpath-canonicalized by the binary); filter to
// what exists so the suite is portable.
const SYS_ALLOW = ["/usr", "/lib", "/lib64", "/bin", "/etc"].filter((p) => fs.existsSync(p));

type RunResult = { status: number | null; stdout: string; stderr: string };

function runSandbox(
  args: string[],
  extraEnv?: Record<string, string | undefined>,
  cwd?: string
): RunResult {
  const r = spawnSync(BIN, args, {
    encoding: "utf8",
    timeout: 15000,
    env: { ...process.env, ...extraEnv },
    cwd,
  });
  return { status: r.status, stdout: r.stdout || "", stderr: r.stderr || "" };
}

function strictEnv(allow: string[]): Record<string, string> {
  return { HELM_SANDBOX_RO_PROFILE: "strict", HELM_SANDBOX_RO_ALLOW: allow.join(":") };
}

function makeProj(): string {
  const proj = fs.mkdtempSync(path.join(os.homedir(), "strict-ro-proj-"));
  fs.mkdirSync(path.join(proj, "src"), { recursive: true });
  fs.writeFileSync(path.join(proj, "north-star.md"), "GOVERNED north-star v1\n");
  fs.writeFileSync(path.join(proj, "package.json"), '{"name":"strict-fixture"}\n');
  fs.writeFileSync(path.join(proj, "src", "readable.txt"), "PROJ-READ-OK\n");
  return proj;
}

describe("B-ISO1 binary: default profile stays byte-identical (regression guard)", () => {
  let proj = "";
  let outside = "";

  beforeAll(() => {
    if (!fs.existsSync(BIN)) {
      throw new Error(`strict-read-profile test requires built binary at ${BIN} (run npm run build first)`);
    }
    proj = makeProj();
    outside = fs.mkdtempSync(path.join(os.homedir(), "strict-ro-outside-"));
    fs.writeFileSync(path.join(outside, "secret.txt"), "DEFAULT-CROSS-READ-SECRET\n");
  });

  afterAll(() => {
    try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
    try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
  });

  it("no profile env: a read OUTSIDE the project still works (root-ro unchanged)", () => {
    const r = runSandbox([proj, "bash", "-c", `cat ${outside}/secret.txt`]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DEFAULT-CROSS-READ-SECRET");
  });

  it("HELM_SANDBOX_RO_PROFILE='' (empty) → legacy default behavior (outside read works)", () => {
    const r = runSandbox([proj, "bash", "-c", `cat ${outside}/secret.txt`], {
      HELM_SANDBOX_RO_PROFILE: "",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DEFAULT-CROSS-READ-SECRET");
  });

  it("HELM_SANDBOX_RO_ALLOW alone (profile absent) is inert — default behavior", () => {
    const r = runSandbox([proj, "bash", "-c", `cat ${outside}/secret.txt`], {
      HELM_SANDBOX_RO_ALLOW: "/usr",
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DEFAULT-CROSS-READ-SECRET");
  });
});

describe("B-ISO1 binary: strict profile (kernel-level read fence)", () => {
  let proj = "";
  let allowedDir = "";
  let fileGrainDir = "";
  let outsideHome = ""; // stands in for websites/cards — must be EACCES from a strict seat
  let outsideTmp = "";  // stands in for an old /tmp helm-run-* artifact dir
  const tmpScratch = path.join("/tmp", `strict-ro-scratch-${process.pid}.txt`);
  const codexProbe = path.join(os.homedir(), ".codex", `strict-ro-probe-${process.pid}.txt`);
  const shmSecret = path.join("/dev/shm", `strict-ro-shm-${process.pid}.txt`);

  beforeAll(() => {
    proj = makeProj();

    allowedDir = fs.mkdtempSync(path.join(os.homedir(), "strict-ro-allowed-"));
    fs.writeFileSync(path.join(allowedDir, "allowed.txt"), "ALLOWED-READ-OK\n");
    fs.writeFileSync(path.join(allowedDir, "script.sh"), "#!/bin/bash\necho SCRIPT-EXEC-OK\n");
    fs.chmodSync(path.join(allowedDir, "script.sh"), 0o755);

    fileGrainDir = fs.mkdtempSync(path.join(os.homedir(), "strict-ro-filegrain-"));
    fs.writeFileSync(path.join(fileGrainDir, "file-a.txt"), "FILE-A-OK\n");
    fs.writeFileSync(path.join(fileGrainDir, "file-b.txt"), "FILE-B-SECRET\n");

    outsideHome = fs.mkdtempSync(path.join(os.homedir(), "strict-ro-cards-standin-"));
    fs.writeFileSync(path.join(outsideHome, "secret.txt"), "CARDS-STANDIN-SECRET\n");

    outsideTmp = fs.mkdtempSync(path.join("/tmp", "strict-ro-old-artifact-"));
    fs.writeFileSync(path.join(outsideTmp, "old-artifact.txt"), "OLD-TMP-ARTIFACT-SECRET\n");
  });

  afterAll(() => {
    for (const d of [proj, allowedDir, fileGrainDir, outsideHome, outsideTmp]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
    }
    try { fs.rmSync(tmpScratch, { force: true }); } catch {}
    try { fs.rmSync(codexProbe, { force: true }); } catch {}
    try { fs.rmSync(shmSecret, { force: true }); } catch {}
  });

  // sol review REQUIRED #1: the /dev char-device rules must NOT parent-widen to /dev under strict
  // (that would re-open the whole /dev subtree, incl. the /dev/shm tmpfs, for READ — a real cheat
  // vector to stash+read cards material). Host creates the /dev/shm file (outside the sandbox);
  // a strict seat must get EACCES reading it back, while the EXACT devices still work.
  it("/dev/shm is UNREADABLE under strict (no /dev parent-widen), yet exact devices (/dev/null,/dev/urandom) still work", () => {
    if (!fs.existsSync("/dev/shm")) return; // no tmpfs on this box — nothing to prove
    fs.writeFileSync(shmSecret, "SHM-STASHED-SECRET\n");

    const rLeak = runSandbox([proj, "bash", "-c", `cat ${shmSecret}`], strictEnv(SYS_ALLOW), proj);
    expect(rLeak.status).not.toBe(0);
    expect(rLeak.stdout).not.toContain("SHM-STASHED-SECRET");
    expect(rLeak.stderr).toMatch(/[Pp]ermission denied/);

    // a directory listing of /dev/shm is likewise denied (no READ_DIR on /dev)
    const rLs = runSandbox([proj, "bash", "-c", "ls /dev/shm"], strictEnv(SYS_ALLOW), proj);
    expect(rLs.status).not.toBe(0);

    // exact allowlisted-by-mechanism devices remain usable under strict
    const rDev = runSandbox(
      [proj, "bash", "-c", "echo hi > /dev/null && head -c 8 /dev/urandom | wc -c"],
      strictEnv(SYS_ALLOW),
      proj
    );
    expect(rDev.status).toBe(0);
    expect(rDev.stdout.trim()).toBe("8");
  });

  it("read + exec inside an allowlisted dir works", () => {
    const r = runSandbox(
      [proj, "bash", "-c", `cat ${allowedDir}/allowed.txt && ${allowedDir}/script.sh`],
      strictEnv([...SYS_ALLOW, allowedDir]),
      proj
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("ALLOWED-READ-OK");
    expect(r.stdout).toContain("SCRIPT-EXEC-OK");
  });

  it("read OUTSIDE the allowlist (cards stand-in under $HOME) fails with EACCES", () => {
    const r = runSandbox(
      [proj, "bash", "-c", `cat ${outsideHome}/secret.txt`],
      strictEnv([...SYS_ALLOW, allowedDir]),
      proj
    );
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("CARDS-STANDIN-SECRET");
    expect(r.stderr).toMatch(/[Pp]ermission denied/);
  });

  it("old /tmp artifacts are UNREADABLE under strict (broad /tmp grant must not re-open reads)", () => {
    const rFile = runSandbox(
      [proj, "bash", "-c", `cat ${outsideTmp}/old-artifact.txt`],
      strictEnv([...SYS_ALLOW, allowedDir]),
      proj
    );
    expect(rFile.status).not.toBe(0);
    expect(rFile.stdout).not.toContain("OLD-TMP-ARTIFACT-SECRET");
    expect(rFile.stderr).toMatch(/[Pp]ermission denied/);

    const rDir = runSandbox([proj, "bash", "-c", "ls /tmp"], strictEnv([...SYS_ALLOW, allowedDir]), proj);
    expect(rDir.status).not.toBe(0); // READ_DIR on /tmp denied
  });

  it("reads inside projectDir work (subdir file, north-star.md, root dir listing)", () => {
    const r = runSandbox(
      [
        proj,
        "bash",
        "-c",
        `cat ${proj}/src/readable.txt && cat ${proj}/north-star.md && ls ${proj}`,
      ],
      strictEnv(SYS_ALLOW),
      proj
    );
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PROJ-READ-OK");
    expect(r.stdout).toContain("GOVERNED north-star v1");
    expect(r.stdout).toContain("package.json");
  });

  it("write inside projectDir works; north-star.md write STILL blocked (B22b fence unchanged)", () => {
    const inside = path.join(proj, "src", "strict-write-ok.txt");
    const rIn = runSandbox(
      [proj, "bash", "-c", `echo STRICT-INSIDE-WRITE > ${inside}`],
      strictEnv(SYS_ALLOW),
      proj
    );
    expect(rIn.status).toBe(0);
    expect(fs.readFileSync(inside, "utf8")).toContain("STRICT-INSIDE-WRITE");

    const rNs = runSandbox(
      [proj, "bash", "-c", `echo TAMPER >> ${proj}/north-star.md`],
      strictEnv(SYS_ALLOW),
      proj
    );
    expect(rNs.status).not.toBe(0);
    expect(fs.readFileSync(path.join(proj, "north-star.md"), "utf8")).not.toContain("TAMPER");
  });

  it("write OUTSIDE the project is still blocked under strict (write fence unchanged)", () => {
    const bad = path.join(outsideHome, "escape.txt");
    const r = runSandbox(
      [proj, "bash", "-c", `echo ESCAPE > ${bad}`],
      strictEnv([...SYS_ALLOW, allowedDir]),
      proj
    );
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(bad)).toBe(false);
  });

  it("/tmp scratch stays WRITABLE under strict but is UNREADABLE back (write-side kept, read-side narrowed)", () => {
    const rWrite = runSandbox(
      [proj, "bash", "-c", `echo TMP-SCRATCH-OK > ${tmpScratch}`],
      strictEnv(SYS_ALLOW),
      proj
    );
    expect(rWrite.status).toBe(0);
    expect(fs.readFileSync(tmpScratch, "utf8")).toContain("TMP-SCRATCH-OK"); // host-visible proof

    const rRead = runSandbox([proj, "bash", "-c", `cat ${tmpScratch}`], strictEnv(SYS_ALLOW), proj);
    expect(rRead.status).not.toBe(0);
    expect(rRead.stdout).not.toContain("TMP-SCRATCH-OK");
  });

  it("$HOME dot-dir state (~/.codex) stays WRITABLE under strict but is UNREADABLE (operator session history protected)", () => {
    const codexDir = path.dirname(codexProbe);
    const rWrite = runSandbox(
      [proj, "bash", "-c", `mkdir -p ${codexDir} && echo CODEX-STATE-OK > ${codexProbe}`],
      strictEnv(SYS_ALLOW),
      proj
    );
    expect(rWrite.status).toBe(0);
    expect(fs.readFileSync(codexProbe, "utf8")).toContain("CODEX-STATE-OK");

    const rRead = runSandbox([proj, "bash", "-c", `cat ${codexProbe}`], strictEnv(SYS_ALLOW), proj);
    expect(rRead.status).not.toBe(0);
    expect(rRead.stdout).not.toContain("CODEX-STATE-OK");
  });

  it("PATH-resolved exec of the launched cmd works under strict when its bin dir is allowlisted", () => {
    const r = runSandbox([proj, "bash", "-c", "echo PATH-EXEC-OK"], {
      ...strictEnv(SYS_ALLOW),
      PATH: `/nonexistent-strict-dir:/usr/bin:/bin`,
    }, proj);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("PATH-EXEC-OK");
  });

  it("a FILE allowlist entry grants exactly that file, never its siblings (no parent widening)", () => {
    const r = runSandbox(
      [
        proj,
        "bash",
        "-c",
        `cat ${fileGrainDir}/file-a.txt; echo "RC-A=$?"; cat ${fileGrainDir}/file-b.txt; echo "RC-B=$?"`,
      ],
      strictEnv([...SYS_ALLOW, path.join(fileGrainDir, "file-a.txt")]),
      proj
    );
    expect(r.stdout).toContain("FILE-A-OK");
    expect(r.stdout).toContain("RC-A=0");
    expect(r.stdout).not.toContain("FILE-B-SECRET");
    expect(r.stdout).not.toContain("RC-B=0");
  });
});

describe("B-ISO1 binary: strict profile fail-closed refusals", () => {
  let proj = "";

  beforeAll(() => {
    proj = makeProj();
  });

  afterAll(() => {
    try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
  });

  function expectRefused(r: RunResult, stderrNeedle: string | RegExp) {
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain("SHOULD-NOT-RUN"); // the requested command NEVER executed
    if (typeof stderrNeedle === "string") expect(r.stderr).toContain(stderrNeedle);
    else expect(r.stderr).toMatch(stderrNeedle);
    expect(r.stderr).toMatch(/fail-closed/i);
  }

  it("strict + HELM_SANDBOX_RO_ALLOW unset → refuses (nonzero, clear stderr)", () => {
    const r = runSandbox([proj, "bash", "-c", "echo SHOULD-NOT-RUN"], {
      HELM_SANDBOX_RO_PROFILE: "strict",
      HELM_SANDBOX_RO_ALLOW: undefined,
    });
    expectRefused(r, "HELM_SANDBOX_RO_ALLOW");
  });

  it("strict + empty HELM_SANDBOX_RO_ALLOW → refuses", () => {
    const r = runSandbox([proj, "bash", "-c", "echo SHOULD-NOT-RUN"], strictEnv([]));
    expectRefused(r, "HELM_SANDBOX_RO_ALLOW");
  });

  it("strict + separators-only allowlist ('::') → refuses (zero entries)", () => {
    const r = runSandbox([proj, "bash", "-c", "echo SHOULD-NOT-RUN"], {
      HELM_SANDBOX_RO_PROFILE: "strict",
      HELM_SANDBOX_RO_ALLOW: "::",
    });
    expectRefused(r, /zero entries|HELM_SANDBOX_RO_ALLOW/);
  });

  it("strict + nonexistent allowlist path → refuses, naming the entry (never skipped silently)", () => {
    const ghost = "/definitely/does/not/exist-strict-ro";
    const r = runSandbox([proj, "bash", "-c", "echo SHOULD-NOT-RUN"], strictEnv(["/usr", ghost]));
    expectRefused(r, ghost);
  });

  it("strict + relative allowlist entry → refuses, naming the entry", () => {
    const r = runSandbox([proj, "bash", "-c", "echo SHOULD-NOT-RUN"], {
      HELM_SANDBOX_RO_PROFILE: "strict",
      HELM_SANDBOX_RO_ALLOW: "/usr:usr/local",
    });
    expectRefused(r, "usr/local");
  });

  // sol review REQUIRED #2: strtok_r collapses empty tokens; each of these has an empty entry
  // (repeated / leading / trailing separator) and MUST fail closed, naming the bad value.
  it.each([
    ["repeated '::' — /usr::/etc", "/usr::/etc"],
    ["leading ':' — :/usr", ":/usr"],
    ["trailing ':' — /usr:", "/usr:"],
  ])("strict + empty allowlist entry (%s) → refuses", (_label, allow) => {
    const r = runSandbox([proj, "bash", "-c", "echo SHOULD-NOT-RUN"], {
      HELM_SANDBOX_RO_PROFILE: "strict",
      HELM_SANDBOX_RO_ALLOW: allow,
    });
    expectRefused(r, "empty entry");
    expect(r.stderr).toContain(allow); // names the offending value
  });

  // sol review REQUIRED #3: fail-closed security state machine — a non-empty non-'strict' profile
  // value must REFUSE, never silently select read-all (a typo must not become a security bypass).
  it.each([["stict"], ["readall"], ["off"], ["Strict"], ["STRICT"]])(
    "unknown profile value '%s' → refuses (nonzero, clear error), never read-all",
    (val) => {
      const outside = fs.mkdtempSync(path.join(os.homedir(), "strict-unknown-outside-"));
      try {
        fs.writeFileSync(path.join(outside, "secret.txt"), "MUST-NOT-LEAK\n");
        const r = runSandbox([proj, "bash", "-c", `cat ${outside}/secret.txt || echo SHOULD-NOT-RUN`], {
          HELM_SANDBOX_RO_PROFILE: val,
          HELM_SANDBOX_RO_ALLOW: "/usr", // present, but irrelevant — the profile value itself is rejected
        });
        expect(r.status).not.toBe(0);
        expect(r.stdout).not.toContain("MUST-NOT-LEAK"); // did NOT fall through to read-all
        expect(r.stdout).not.toContain("SHOULD-NOT-RUN"); // the command never ran at all
        expect(r.stderr).toContain("HELM_SANDBOX_RO_PROFILE");
        expect(r.stderr).toContain(val);
        expect(r.stderr).toMatch(/fail-closed/i);
      } finally {
        try { fs.rmSync(outside, { recursive: true, force: true }); } catch {}
      }
    }
  );
});

describe("B-ISO1 TS: makeStrictReadProfileEnv (quoting + validation)", () => {
  it("composes the exact env prefix with a trailing space", () => {
    expect(makeStrictReadProfileEnv(["/a", "/b c"])).toBe(
      "HELM_SANDBOX_RO_PROFILE=strict HELM_SANDBOX_RO_ALLOW='/a:/b c' "
    );
  });

  it("is shell-safe end-to-end, including single quotes and spaces (bash round-trip)", () => {
    const paths = ["/a b", "/weird'quote", "/plain"];
    const prefix = makeStrictReadProfileEnv(paths);
    // The prefix applies to exactly ONE command — same shape as the real fenced launch
    // (`${strictEnv}${envPrefix}${sandboxBin} ...`). env(1) prints the whole environment.
    const r = spawnSync("bash", ["-c", `${prefix}env`], { encoding: "utf8", timeout: 5000 });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("HELM_SANDBOX_RO_ALLOW=/a b:/weird'quote:/plain\n");
    expect(r.stdout).toContain("HELM_SANDBOX_RO_PROFILE=strict\n");
  });

  it("throws on an empty list (the sandbox fails closed on an empty allowlist)", () => {
    expect(() => makeStrictReadProfileEnv([])).toThrow(/non-empty/);
  });

  it("throws on relative / empty / non-string entries", () => {
    expect(() => makeStrictReadProfileEnv(["relative/path"])).toThrow(/absolute/);
    expect(() => makeStrictReadProfileEnv([""])).toThrow(/non-empty/);
    expect(() => makeStrictReadProfileEnv(["   "])).toThrow(/non-empty/);
    expect(() => makeStrictReadProfileEnv(["/ok", 42 as unknown as string])).toThrow(/non-empty|string/);
  });

  it("throws on entries containing the ':' separator or control characters", () => {
    expect(() => makeStrictReadProfileEnv(["/a:b"])).toThrow(/separator|':'/);
    expect(() => makeStrictReadProfileEnv(["/a\nb"])).toThrow(/control/);
  });
});

describe("B-ISO1 TS: makeWriteFencePolicy strict-read variant", () => {
  it("default call (no allowlist) is byte-identical to the pre-existing policy text", () => {
    const p = makeWriteFencePolicy("/some/project");
    expect(p).toContain("You MAY read files anywhere on the filesystem (cross-project reads allowed).");
    expect(p).not.toContain("strict read profile");
  });

  it("with an allowlist, the read line states the strict restriction instead", () => {
    const p = makeWriteFencePolicy("/some/project", ["/usr", "/opt/run-x"]);
    expect(p).not.toContain("You MAY read files anywhere");
    expect(p).toContain("strict read profile");
    expect(p).toContain("/opt/run-x");
    expect(p).toContain("/some/project");
  });
});

describe("B-ISO1 TS: master launch opt-in pass-through", () => {
  const prevFake = process.env.USE_FAKE_TMUX;

  beforeAll(() => {
    process.env.USE_FAKE_TMUX = "1";
  });

  afterAll(() => {
    if (prevFake === undefined) delete process.env.USE_FAKE_TMUX;
    else process.env.USE_FAKE_TMUX = prevFake;
  });

  function makeCaptureTmux() {
    const fake: any = {
      commands: [] as string[],
      created: [] as string[],
      fed: [] as string[],
      createSession: async (name: string) => {
        fake.created.push(name);
        return `${name}:0.0`;
      },
      sendCommand: async (_t: string, cmd: string) => {
        fake.commands.push(cmd);
        return { message: "sent", blocked: false };
      },
      waitForReady: async () => true,
      sendEnter: async () => ({}),
      sendKeys: async () => ({}),
      sendAndSubmit: async (_t: string, text: string) => {
        fake.fed.push(text);
        return true;
      },
      verifyMarkerPresent: async () => true,
      terminateSession: async () => {},
      clearContext: async () => ({}),
      capturePane: async () => "bypass permissions on (shift+tab to cycle)\n❯ > ready\n",
      sessionExists: async () => false,
      getPanePid: async () => "12345",
      composerHoldsText: async () => false,
      resubmitIfComposerHeld: async () => false,
    };
    return fake;
  }

  function makeMasterFixture() {
    const helmDbPath = `/tmp/helm-strictro-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const helmDb = new DatabaseService(helmDbPath);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-strictro-proj-"));
    helmDb.raw
      .prepare("INSERT OR REPLACE INTO projects (id, name, directory) VALUES (?,?,?)")
      .run(1, "strictro-coverage", projectDir);
    const events = new AgentEventsService(helmDb);
    const resolver = new ProviderResolverService();
    const masterModels = new MasterModelService(helmDb);
    masterModels.setChain(1, [{ provider: "grok", model: "grok-4.5" }]);
    const fakeTmux = makeCaptureTmux();
    const runtime = new MasterRuntimeService(helmDb, events, fakeTmux as any, resolver, masterModels);
    const cleanup = () => {
      try { helmDb.close(); } catch {}
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(helmDbPath + suffix); } catch {}
      }
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    };
    return { runtime, fakeTmux, projectDir, cleanup };
  }

  it("absent strictReadAllow → fencedCmd unchanged (no strict env in the launch command)", async () => {
    const { runtime, fakeTmux, cleanup } = makeMasterFixture();
    try {
      await runtime.launchMaster(1, { provider: "claude", model: "claude-sonnet-4-6" });
      const cmd = fakeTmux.commands.find((c: string) => c.includes("claude --model")) ?? "";
      expect(cmd).toBeTruthy();
      expect(cmd).toContain("helm-sandbox");
      expect(cmd).not.toContain("HELM_SANDBOX_RO_PROFILE");
      expect(cmd).not.toContain("HELM_SANDBOX_RO_ALLOW");
      // default behavioral policy unchanged: fed prompt keeps the read-anywhere line
      const fed = fakeTmux.fed.join("\n");
      expect(fed).toContain("You MAY read files anywhere");
      expect(fed).not.toContain("strict read profile");
    } finally {
      cleanup();
    }
  });

  it("strictReadAllow present → strict env prefix precedes the sandbox bin in fencedCmd", async () => {
    const { runtime, fakeTmux, cleanup } = makeMasterFixture();
    try {
      await runtime.launchMaster(1, {
        provider: "claude",
        model: "claude-sonnet-4-6",
        strictReadAllow: ["/usr", "/opt/strict-x"],
      });
      const cmd = fakeTmux.commands.find((c: string) => c.includes("claude --model")) ?? "";
      expect(cmd).toContain("HELM_SANDBOX_RO_PROFILE=strict HELM_SANDBOX_RO_ALLOW='/usr:/opt/strict-x'");
      const strictIdx = cmd.indexOf("HELM_SANDBOX_RO_PROFILE=strict");
      const binIdx = cmd.search(/\/\S*helm-sandbox\b/);
      expect(strictIdx).toBeGreaterThanOrEqual(0);
      expect(binIdx).toBeGreaterThan(strictIdx);
      // the strict launch's fed behavioral policy must not claim read-anywhere
      const fed = fakeTmux.fed.join("\n");
      expect(fed).toBeTruthy();
      expect(fed).not.toContain("You MAY read files anywhere");
      expect(fed).toContain("strict read profile");
    } finally {
      cleanup();
    }
  });

  it("strictReadAllow: [] → launch refused fail-closed BEFORE any tmux side effect", async () => {
    const { runtime, fakeTmux, cleanup } = makeMasterFixture();
    try {
      await expect(
        runtime.launchMaster(1, { provider: "claude", model: "claude-sonnet-4-6", strictReadAllow: [] })
      ).rejects.toThrow(/non-empty/);
      expect(fakeTmux.created.length).toBe(0);
      expect(fakeTmux.commands.length).toBe(0);
    } finally {
      cleanup();
    }
  });

  it("strictReadAllow with a relative entry → launch refused fail-closed", async () => {
    const { runtime, fakeTmux, cleanup } = makeMasterFixture();
    try {
      await expect(
        runtime.launchMaster(1, {
          provider: "claude",
          model: "claude-sonnet-4-6",
          strictReadAllow: ["relative/path"],
        })
      ).rejects.toThrow(/absolute/);
      expect(fakeTmux.created.length).toBe(0);
      expect(fakeTmux.commands.length).toBe(0);
    } finally {
      cleanup();
    }
  });
});

// ============================================================================
// B-ISO1 Phase-3 blocker #1 (sol Phase-1 review, Caveat 1): the strict read fence must SURVIVE the
// supervisor auto-respawn AND the model-swap paths. Both call launchMaster WITHOUT strictReadAllow,
// so a recovered/swapped master used to revert to read-all — the fence silently dropped mid-run.
// Fix: the run's allowlist is persisted on the master_runtimes.strict_read_allow column at launch and
// re-read + re-applied on every respawn and swap. These tests assert the RE-COMPOSED launch command
// still carries HELM_SANDBOX_RO_PROFILE=strict + the SAME allowlist (and a non-strict master stays
// non-strict). Binary-level kernel enforcement is proven by the earlier binary describes; these lock
// the persistence + re-threading seam with the fake capture-tmux.
// ============================================================================
describe("B-ISO1 TS: strict profile survives supervisor respawn + model swap (blocker #1)", () => {
  const prevFake = process.env.USE_FAKE_TMUX;
  const STRICT_ALLOW = ["/usr", "/opt/strict-x"];
  const EXPECTED_ENV = "HELM_SANDBOX_RO_PROFILE=strict HELM_SANDBOX_RO_ALLOW='/usr:/opt/strict-x'";

  beforeAll(() => {
    process.env.USE_FAKE_TMUX = "1";
  });
  afterAll(() => {
    if (prevFake === undefined) delete process.env.USE_FAKE_TMUX;
    else process.env.USE_FAKE_TMUX = prevFake;
  });

  function assertStrictPrefixesBin(cmd: string, allowJoined: string) {
    expect(cmd).toContain(`HELM_SANDBOX_RO_PROFILE=strict HELM_SANDBOX_RO_ALLOW='${allowJoined}'`);
    const strictIdx = cmd.indexOf("HELM_SANDBOX_RO_PROFILE=strict");
    const binIdx = cmd.search(/\/\S*helm-sandbox\b/);
    expect(strictIdx).toBeGreaterThanOrEqual(0);
    expect(binIdx).toBeGreaterThan(strictIdx); // strict env precedes the sandbox bin
  }

  // Capture tmux whose capturePane ALSO echoes a corr-tagged RESUME_ACK for any resume feed it saw,
  // so switchModel's waitForResumeAck succeeds on the first poll (no 18s timeout). getPanePid='0' so
  // park's pid-verify loop breaks immediately (no 5s spin). sessionExists=false so a respawn tick sees
  // the master as dead and relaunches it.
  function makeSwapAwareTmux() {
    const fake: any = {
      commands: [] as string[],
      created: [] as string[],
      fed: [] as string[],
      createSession: async (name: string) => {
        fake.created.push(name);
        return `${name}:0.0`;
      },
      sendCommand: async (_t: string, cmd: string) => {
        fake.commands.push(cmd);
        return { message: "sent", blocked: false };
      },
      waitForReady: async () => true,
      sendEnter: async () => ({}),
      sendKeys: async () => ({}),
      forceKillPane: async () => ({}),
      sendAndSubmit: async (_t: string, text: string) => {
        fake.fed.push(text);
        return true;
      },
      verifyMarkerPresent: async () => true,
      terminateSession: async () => {},
      clearContext: async () => ({}),
      capturePane: async () => {
        // echo an ack for the swap correlation carried in the resume feed marker (drives
        // waitForResumeAck to succeed immediately instead of polling to its 18s timeout).
        const m = fake.fed.join("\n").match(/HELM-FEED-MARKER:(\S+)/);
        const ack = m ? `\nHELM-FEED-MARKER:${m[1]}\nHELM_RESUME_ACK:${m[1]}\n` : "";
        return `bypass permissions on (shift+tab to cycle)\n❯ > ready${ack}`;
      },
      sessionExists: async () => false,
      getPanePid: async () => "0",
      composerHoldsText: async () => false,
      resubmitIfComposerHeld: async () => false,
    };
    return fake;
  }

  // chainProvider drives what the OPT-LESS respawn (launchMaster(pid) with no override) launches, so
  // both the initial strict launch AND the recovered launch are the same ready-quick provider.
  function makeFixture(chain: Array<{ provider: string; model: string }>) {
    const helmDbPath = `/tmp/helm-strictro-b1-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const helmDb = new DatabaseService(helmDbPath);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-strictro-b1-proj-"));
    helmDb.raw
      .prepare("INSERT OR REPLACE INTO projects (id, name, directory) VALUES (?,?,?)")
      .run(1, "strictro-b1", projectDir);
    const events = new AgentEventsService(helmDb);
    const resolver = new ProviderResolverService();
    const masterModels = new MasterModelService(helmDb);
    masterModels.setChain(1, chain);
    const fakeTmux = makeSwapAwareTmux();
    const runtime = new MasterRuntimeService(helmDb, events, fakeTmux as any, resolver, masterModels);
    const cleanup = () => {
      try { helmDb.close(); } catch {}
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(helmDbPath + suffix); } catch {}
      }
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    };
    return { runtime, fakeTmux, helmDb, cleanup };
  }

  // Provider-agnostic: the re-launched fenced command (the sandbox bin invocation) regardless of the
  // provider the chain-default respawn picks. The prior `echo HELM_LAUNCH_<run>` marker has no sandbox bin.
  function findFencedLaunch(fake: any): string {
    return fake.commands.find((c: string) => c.includes("helm-sandbox")) ?? "";
  }

  // grok is the persistent-master provider (claude is rejected by MasterModelService.setChain); its
  // readyProbe signal '❯' is present in the fake pane, so both the initial launch and the chain-default
  // respawn come up ready immediately.
  const GROK_CHAIN = [{ provider: "grok", model: "grok-4.5" }];

  it("supervisor respawn of a STRICT master re-applies the same strict env (fence survives recovery)", async () => {
    const { runtime, fakeTmux, helmDb, cleanup } = makeFixture(GROK_CHAIN);
    try {
      await runtime.launchMaster(1, { strictReadAllow: STRICT_ALLOW });
      // the run's allowlist is persisted on the singleton row (the respawn/swap seam)
      const row: any = helmDb.raw.prepare("SELECT strict_read_allow FROM master_runtimes WHERE project_id = 1").get();
      expect(row.strict_read_allow).toBe(JSON.stringify(STRICT_ALLOW));

      fakeTmux.commands.length = 0; // isolate the respawn's launch command
      await runtime.superviseTick(); // sessionExists=false → recovery → launchMaster(1) with NO opts

      const respawnCmd = findFencedLaunch(fakeTmux);
      expect(respawnCmd).toBeTruthy();
      assertStrictPrefixesBin(respawnCmd, "/usr:/opt/strict-x");
      // and the persisted profile is intact for the NEXT respawn too
      const row2: any = helmDb.raw.prepare("SELECT strict_read_allow FROM master_runtimes WHERE project_id = 1").get();
      expect(row2.strict_read_allow).toBe(JSON.stringify(STRICT_ALLOW));
    } finally {
      cleanup();
    }
  }, 20000);

  it("supervisor respawn of a NON-strict master stays non-strict (no strict env, byte-identical default)", async () => {
    const { runtime, fakeTmux, helmDb, cleanup } = makeFixture(GROK_CHAIN);
    try {
      await runtime.launchMaster(1); // no strictReadAllow
      const row: any = helmDb.raw.prepare("SELECT strict_read_allow FROM master_runtimes WHERE project_id = 1").get();
      expect(row.strict_read_allow).toBeNull();

      fakeTmux.commands.length = 0;
      await runtime.superviseTick();

      const respawnCmd = findFencedLaunch(fakeTmux);
      expect(respawnCmd).toBeTruthy();
      expect(respawnCmd).toContain("helm-sandbox");
      expect(respawnCmd).not.toContain("HELM_SANDBOX_RO_PROFILE");
      expect(respawnCmd).not.toContain("HELM_SANDBOX_RO_ALLOW");
    } finally {
      cleanup();
    }
  }, 20000);

  it("model swap of a STRICT master re-applies the same strict env behind the NEW model", async () => {
    const { runtime, fakeTmux, cleanup } = makeFixture(GROK_CHAIN);
    let digestPath: string | undefined;
    try {
      await runtime.launchMaster(1, { strictReadAllow: STRICT_ALLOW });

      fakeTmux.commands.length = 0; // isolate the swap's re-launch command
      // self-swap (grok→grok, like p1-6b) exercises the exact launchMaster override the swap takes.
      const res = await runtime.switchModel(1, "grok", "grok-4.5", "manual");
      expect(res.ok).toBe(true);
      digestPath = res.digestPath;

      const swapCmd = findFencedLaunch(fakeTmux);
      expect(swapCmd).toBeTruthy();
      assertStrictPrefixesBin(swapCmd, "/usr:/opt/strict-x");
    } finally {
      if (digestPath) { try { fs.unlinkSync(digestPath); } catch {} }
      cleanup();
    }
  }, 30000);

  it("model swap of a NON-strict master stays non-strict (no strict env on the re-launch)", async () => {
    const { runtime, fakeTmux, cleanup } = makeFixture(GROK_CHAIN);
    let digestPath: string | undefined;
    try {
      await runtime.launchMaster(1);
      fakeTmux.commands.length = 0;
      const res = await runtime.switchModel(1, "grok", "grok-4.5", "manual");
      expect(res.ok).toBe(true);
      digestPath = res.digestPath;

      const swapCmd = findFencedLaunch(fakeTmux);
      expect(swapCmd).toBeTruthy();
      expect(swapCmd).not.toContain("HELM_SANDBOX_RO_PROFILE");
      expect(swapCmd).not.toContain("HELM_SANDBOX_RO_ALLOW");
    } finally {
      if (digestPath) { try { fs.unlinkSync(digestPath); } catch {} }
      cleanup();
    }
  }, 30000);

  // sol wiring review fix #2: the STORAGE CONTRACT is "only NULL means read-all". An empty non-null
  // strict_read_allow ('') must fail closed (throw), NOT be treated as non-strict — else a truncated /
  // half-written column would silently unfence a master. Exercised through the public reader that the
  // dead-master manual-relaunch route (index.ts) uses to re-thread the profile.
  it("getPersistedStrictReadAllow: NULL → undefined; '' → THROWS (fail-closed); valid JSON → array; corrupt → throws", () => {
    const { runtime, helmDb, cleanup } = makeFixture(GROK_CHAIN);
    try {
      const seed = (val: string | null) =>
        helmDb.raw
          .prepare(
            "INSERT OR REPLACE INTO master_runtimes (project_id, master_run_id, tmux_session, provider, model, state, strict_read_allow) VALUES (1,'r','helm-x','grok','grok-4.5','running',?)"
          )
          .run(val);

      seed(null);
      expect(runtime.getPersistedStrictReadAllow(1)).toBeUndefined(); // only NULL is read-all

      seed(""); // empty NON-null — the fail-open bug being closed
      expect(() => runtime.getPersistedStrictReadAllow(1)).toThrow(/empty|read-all fallback/i);

      seed(JSON.stringify(["/usr", "/opt/run-x"]));
      expect(runtime.getPersistedStrictReadAllow(1)).toEqual(["/usr", "/opt/run-x"]);

      seed("not-json"); // corrupt
      expect(() => runtime.getPersistedStrictReadAllow(1)).toThrow(/corrupt|read-all fallback/i);

      seed("[]"); // valid JSON but empty array — not a non-empty string[]
      expect(() => runtime.getPersistedStrictReadAllow(1)).toThrow(/read-all fallback/i);
    } finally {
      cleanup();
    }
  });

  // sol wiring review fix #3: switchModel must parse+validate the persisted profile BEFORE the
  // destructive park/digest/kill — a corrupt value fails the swap WITHOUT tearing down the healthy
  // fenced master (no park, no kill, no lock row; the master stays 'running').
  it("model swap with CORRUPT strict metadata fails closed BEFORE any park/kill (healthy master untorn)", async () => {
    const { runtime, fakeTmux, helmDb, cleanup } = makeFixture(GROK_CHAIN);
    try {
      await runtime.launchMaster(1, { strictReadAllow: STRICT_ALLOW }); // healthy strict master, state='running'
      // Corrupt the persisted profile out-of-band (stands in for a truncated/tampered column).
      helmDb.raw.prepare("UPDATE master_runtimes SET strict_read_allow = 'not-json' WHERE project_id = 1").run();

      fakeTmux.commands.length = 0;
      fakeTmux.fed.length = 0;
      (fakeTmux as any).forceKillPane = async () => { throw new Error("forceKillPane MUST NOT be called on corrupt-swap"); };

      await expect(runtime.switchModel(1, "grok", "grok-4.5", "manual")).rejects.toThrow(/corrupt|read-all fallback/i);

      // healthy master NOT torn down: still 'running', no re-launch command, no yield/park feed,
      // and NO swap lock row was left behind (validation threw before the CAS insert).
      const row: any = helmDb.raw.prepare("SELECT state FROM master_runtimes WHERE project_id = 1").get();
      expect(row.state).toBe("running");
      expect(findFencedLaunch(fakeTmux)).toBe(""); // no re-launch composed
      expect(fakeTmux.fed.join("\n")).not.toContain("HELM PARK"); // park never sent a yield
      const lock: any = helmDb.raw.prepare("SELECT COUNT(*) AS c FROM master_switches WHERE project_id = 1").get();
      expect(lock.c).toBe(0);
    } finally {
      cleanup();
    }
  }, 20000);
});

// ============================================================================
// B-ISO1 Phase-3 blocker #2 (sol Phase-1 review, Caveat 3): WORKERS are what actually build cards2,
// so the WorkerService + RealTransport seat-launch paths must be strict-fenceable — not just the
// master. These lock the opt-in threading: the strict env prefixes the sandbox bin when the run
// configures it, and the launch command is byte-identical to today when it does not.
// ============================================================================
describe("B-ISO1 TS: worker + real-transport strict opt-in (blocker #2)", () => {
  const STRICT_ALLOW = ["/usr", "/opt/strict-x"];

  function assertStrictPrefixesBin(cmd: string) {
    expect(cmd).toContain("HELM_SANDBOX_RO_PROFILE=strict HELM_SANDBOX_RO_ALLOW='/usr:/opt/strict-x'");
    const strictIdx = cmd.indexOf("HELM_SANDBOX_RO_PROFILE=strict");
    const binIdx = cmd.search(/\/\S*helm-sandbox\b/);
    expect(strictIdx).toBeGreaterThanOrEqual(0);
    expect(binIdx).toBeGreaterThan(strictIdx);
  }

  function makeCaptureTmux() {
    const fake: any = {
      commands: [] as string[],
      created: [] as string[],
      fed: [] as string[],
      createSession: async (name: string) => {
        fake.created.push(name);
        return `${name}:0.0`;
      },
      sendCommand: async (_t: string, cmd: string) => {
        fake.commands.push(cmd);
        return { message: "sent", blocked: false };
      },
      waitForReady: async () => true,
      sendEnter: async () => ({}),
      sendKeys: async () => ({}),
      sendAndSubmit: async (_t: string, text: string) => {
        fake.fed.push(text);
        return true;
      },
      verifyMarkerPresent: async () => true,
      terminateSession: async () => {},
      clearContext: async () => ({}),
      capturePane: async () => "bypass permissions on (shift+tab to cycle)\n❯ > ready\n",
      sessionExists: async () => false,
      getPanePid: async () => "12345",
      composerHoldsText: async () => false,
      resubmitIfComposerHeld: async () => false,
    };
    return fake;
  }

  function makeWorkerFixture() {
    const helmDbPath = `/tmp/helm-strictro-b2w-${Date.now()}-${Math.random().toString(36).slice(2)}.db`;
    const helmDb = new DatabaseService(helmDbPath);
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-strictro-b2w-proj-"));
    helmDb.raw
      .prepare("INSERT OR REPLACE INTO projects (id, name, directory) VALUES (?,?,?)")
      .run(1, "strictro-b2w", projectDir);
    const events = new AgentEventsService(helmDb);
    const resolver = new ProviderResolverService();
    const assignment = new AgentAssignmentService(helmDb);
    const claude = assignment.createAgent({
      name: `strictro-worker-${Math.random().toString(36).slice(2)}`,
      provider: "claude",
      model: "claude-sonnet-4-6",
    });
    assignment.setRoleDefault("validator", claude.id);
    const fakeTmux = makeCaptureTmux();
    const worker = new WorkerService(helmDb, events, fakeTmux as any, resolver, assignment);
    const cleanup = () => {
      try { helmDb.close(); } catch {}
      for (const suffix of ["", "-wal", "-shm"]) {
        try { fs.unlinkSync(helmDbPath + suffix); } catch {}
      }
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    };
    return { worker, fakeTmux, cleanup };
  }

  function findClaudeLaunch(fake: any): string {
    return fake.commands.find((c: string) => c.includes("claude --model")) ?? "";
  }

  describe("WorkerService (USE_FAKE_TMUX)", () => {
    const prevFake = process.env.USE_FAKE_TMUX;
    beforeAll(() => { process.env.USE_FAKE_TMUX = "1"; });
    afterAll(() => {
      if (prevFake === undefined) delete process.env.USE_FAKE_TMUX;
      else process.env.USE_FAKE_TMUX = prevFake;
    });

    it("worker spawn composes the strict env prefix (before the sandbox bin) when configured", async () => {
      const { worker, fakeTmux, cleanup } = makeWorkerFixture();
      try {
        await worker.spawnWorker({
          projectId: 1,
          role: "validator",
          taskBrief: "strict worker brief",
          strictReadAllow: STRICT_ALLOW,
        });
        const cmd = findClaudeLaunch(fakeTmux);
        expect(cmd).toBeTruthy();
        assertStrictPrefixesBin(cmd);
        // the fed behavioral policy must state the strict restriction, not read-anywhere
        const fed = fakeTmux.fed.join("\n");
        expect(fed).toContain("strict read profile");
        expect(fed).not.toContain("You MAY read files anywhere");
      } finally {
        cleanup();
      }
    });

    it("worker spawn is byte-identical (no strict env) when NOT configured", async () => {
      const { worker, fakeTmux, cleanup } = makeWorkerFixture();
      try {
        await worker.spawnWorker({ projectId: 1, role: "validator", taskBrief: "default worker brief" });
        const cmd = findClaudeLaunch(fakeTmux);
        expect(cmd).toBeTruthy();
        expect(cmd).toContain("helm-sandbox");
        expect(cmd).not.toContain("HELM_SANDBOX_RO_PROFILE");
        expect(cmd).not.toContain("HELM_SANDBOX_RO_ALLOW");
        const fed = fakeTmux.fed.join("\n");
        expect(fed).toContain("You MAY read files anywhere");
        expect(fed).not.toContain("strict read profile");
      } finally {
        cleanup();
      }
    });

    it("worker spawn with strictReadAllow: [] is refused fail-closed BEFORE any worker row / tmux side effect", async () => {
      const { worker, fakeTmux, cleanup } = makeWorkerFixture();
      try {
        await expect(
          worker.spawnWorker({ projectId: 1, role: "validator", taskBrief: "x", strictReadAllow: [] })
        ).rejects.toThrow(/non-empty/);
        expect(fakeTmux.created.length).toBe(0);
        expect(fakeTmux.commands.length).toBe(0);
      } finally {
        cleanup();
      }
    });
  });

  describe("RealTransport (real tmux path — USE_FAKE_TMUX cleared)", () => {
    async function buildRealTransport(strictReadAllow?: string[]) {
      const prevFake = process.env.USE_FAKE_TMUX;
      delete process.env.USE_FAKE_TMUX;
      const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-strictro-b2rt-run-"));
      const fenceDir = fs.mkdtempSync(path.join(os.tmpdir(), "helm-strictro-b2rt-fence-"));
      const fakeTmux = makeCaptureTmux();
      const transport = new RealTransport({
        tmux: fakeTmux as any,
        artifacts: { recordDispatch: () => 0 } as any,
        resolver: new ProviderResolverService(),
      });
      try {
        await transport.spawn({
          role: "implementer",
          brief: "strict-transport brief",
          runDir,
          batchId: "strictro-b2rt",
          provider: "claude",
          model: "claude-sonnet-4-6",
          projectDir: fenceDir,
          ...(strictReadAllow !== undefined ? { strictReadAllow } : {}),
        });
      } catch {
        // dispatch.start may reject after the fenced launch is sent; we only need the launch command.
      }
      const cmd = fakeTmux.commands.find((c: string) => c.includes("claude --model")) ?? "";
      const cleanup = () => {
        try { fs.rmSync(runDir, { recursive: true, force: true }); } catch {}
        try { fs.rmSync(fenceDir, { recursive: true, force: true }); } catch {}
        if (prevFake === undefined) delete process.env.USE_FAKE_TMUX;
        else process.env.USE_FAKE_TMUX = prevFake;
      };
      return { cmd, cleanup };
    }

    it("real-transport spawn composes the strict env prefix (before the sandbox bin) when configured", async () => {
      const { cmd, cleanup } = await buildRealTransport(STRICT_ALLOW);
      try {
        expect(cmd).toBeTruthy();
        assertStrictPrefixesBin(cmd);
      } finally {
        cleanup();
      }
    });

    it("real-transport spawn is byte-identical (no strict env) when NOT configured", async () => {
      const { cmd, cleanup } = await buildRealTransport(undefined);
      try {
        expect(cmd).toBeTruthy();
        expect(cmd).toContain("helm-sandbox");
        expect(cmd).not.toContain("HELM_SANDBOX_RO_PROFILE");
        expect(cmd).not.toContain("HELM_SANDBOX_RO_ALLOW");
      } finally {
        cleanup();
      }
    });
  });
});

// B-ISO1 (harness activation): the DEPLOYMENT-LEVEL default read fence resolved from
// HELM_STRICT_READ_ALLOW. This is the seam that lets the cards2 harness :3110 instance fence EVERY
// run (incl. UI-created projects) with no per-run caller change. Contract mirrors the parseStrictReadAllow
// fail-closed rules: unset/empty => read-all (byte-identical default); set-but-malformed => THROW.
describe("B-ISO1 TS: resolveDeploymentStrictReadAllow (deployment env default)", () => {
  it("returns undefined when unset (read-all default, byte-identical)", () => {
    expect(resolveDeploymentStrictReadAllow(undefined)).toBeUndefined();
  });

  it("returns undefined for empty / whitespace-only (unset === empty === read-all)", () => {
    expect(resolveDeploymentStrictReadAllow("")).toBeUndefined();
    expect(resolveDeploymentStrictReadAllow("   ")).toBeUndefined();
    expect(resolveDeploymentStrictReadAllow("\t \n")).toBeUndefined();
  });

  it("parses a colon-separated absolute-path list", () => {
    expect(resolveDeploymentStrictReadAllow("/usr:/etc:/tmp/helm-harness")).toEqual([
      "/usr",
      "/etc",
      "/tmp/helm-harness",
    ]);
  });

  it("tolerates surrounding whitespace and stray leading/trailing/repeated ':' in the colon form", () => {
    // cleaned before the sandbox ever sees it (the binary itself rejects empty tokens)
    expect(resolveDeploymentStrictReadAllow(" /usr : /etc :: /home/agjrom/.npm-global : ")).toEqual([
      "/usr",
      "/etc",
      "/home/agjrom/.npm-global",
    ]);
  });

  it("parses a JSON array of absolute paths", () => {
    expect(
      resolveDeploymentStrictReadAllow('["/usr","/etc","/home/agjrom/websites/Helm/data/harness-auth"]')
    ).toEqual(["/usr", "/etc", "/home/agjrom/websites/Helm/data/harness-auth"]);
  });

  it("reads process.env.HELM_STRICT_READ_ALLOW by default", () => {
    const prev = process.env.HELM_STRICT_READ_ALLOW;
    try {
      process.env.HELM_STRICT_READ_ALLOW = "/usr:/proc";
      expect(resolveDeploymentStrictReadAllow()).toEqual(["/usr", "/proc"]);
      delete process.env.HELM_STRICT_READ_ALLOW;
      expect(resolveDeploymentStrictReadAllow()).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.HELM_STRICT_READ_ALLOW;
      else process.env.HELM_STRICT_READ_ALLOW = prev;
    }
  });

  it("THROWS on set-but-malformed JSON (never silently falls back to read-all)", () => {
    expect(() => resolveDeploymentStrictReadAllow("[not json")).toThrow(/HELM_STRICT_READ_ALLOW/);
  });

  it("THROWS on a JSON object (not an allowlist array) — fail-closed, never read-all", () => {
    // '{...}' does not start with '[', so it takes the colon-separated branch and fails the
    // absolute-path content check — still a throw (fail-closed), just a different message.
    expect(() => resolveDeploymentStrictReadAllow('{"a":1}')).toThrow(/absolute|HELM_STRICT_READ_ALLOW/);
  });

  it("THROWS on a relative-path entry (fail-closed content validation)", () => {
    expect(() => resolveDeploymentStrictReadAllow("/usr:etc")).toThrow(/absolute/);
  });

  it("THROWS when set but resolves to zero paths", () => {
    expect(() => resolveDeploymentStrictReadAllow(":::")).toThrow(/zero paths|non-empty/);
  });
});
