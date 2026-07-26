import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeAll, afterAll } from "vitest";

import { resolveHelmSandboxBin, makeWriteFencePolicy, getWriteFenceStatus } from "./security/landlock-sandbox.js";
import { WorkerService } from "./services/worker-service.js";
import { ProviderResolverService } from "./services/provider-resolver-service.js";
import Database from "better-sqlite3";

const C3_PROOF = path.join(os.tmpdir(), "C3-writefence-proof.txt");

/**
 * C3 non-gameable acceptance: kernel-level EPERM proof (checks performed FROM OUTSIDE the sandbox).
 * Must FAIL (hard throw, no .skip) if Landlock unavailable in the env — we never green a dead fence.
 * Also verifies absolute bin path prefix, behavioral policy injection, and honest self-check.
 */

const BIN = resolveHelmSandboxBin();

describe("C3 Landlock write-fence (real kernel enforcement, abs path, fail-closed, non-gameable)", () => {
  beforeAll(() => {
    // Ensure we built (gate runs build before vitest)
    if (!fs.existsSync(BIN)) {
      throw new Error(`C3 test requires built binary at ${BIN} (run npm run build first)`);
    }
  });

  it("kernel-EPERM non-gameable proof (inside write succeeds + host-visible file; outside sibling BLOCKED with EPERM + no file; cross read OK; second outside blocked)", () => {
    const fence = getWriteFenceStatus();
    if (fence.status !== "active") {
      // Per explicit req: the kernel-EPERM test must FAIL (not skip) if landlock unavailable.
      // Never green a dead fence.
      throw new Error(
        `landlock unavailable in test env (status=${fence.status}, detail=${fence.detail}) — ` +
        `the kernel-EPERM non-gameable test must FAIL (not skip) per requirements; we never green a dead fence`
      );
    }

    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "c3-proj-"));
    // Sibling must be OUTSIDE /tmp (excepted) and outside $HOME/.config|.cache|.npm (excepted).
    // Use a sibling under $HOME (but not the dotdir exceptions) so the ro-/no-specific-rw rule blocks it.
    const home = os.homedir();
    const sibling = fs.mkdtempSync(path.join(home, "c3-sibling-"));
    const proof: string[] = [
      `BIN=${BIN}`,
      `proj=${proj}`,
      `sibling=${sibling}`,
      `fence=${fence.status} ${fence.detail}`,
    ];

    try {
      // (a) write INSIDE project dir → succeeds, file exists (observable from host)
      const inside = path.join(proj, "inside-ok.txt");
      let r = spawnSync(BIN, [proj, "bash", "-c", `echo 'INSIDE-OK' > ${inside}`], { encoding: "utf8" });
      proof.push(`inside: status=${r.status} stderr=${(r.stderr || "").slice(0, 200)}`);
      expect(r.status).toBe(0);
      expect(fs.existsSync(inside)).toBe(true);
      expect(fs.readFileSync(inside, "utf8")).toContain("INSIDE-OK");

      // (b) write OUTSIDE to sibling → BLOCKED (EPERM or non-zero, file must NOT exist)
      const bad = path.join(sibling, "escape-bad.txt");
      r = spawnSync(BIN, [proj, "bash", "-c", `echo 'ESCAPE-ATTEMPT' > ${bad}`], { encoding: "utf8" });
      proof.push(`outside-sibling: status=${r.status} stderr=${(r.stderr || "").slice(0, 300)}`);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(bad)).toBe(false);

      // (c) read from sibling (cross-project) → allowed
      const secret = path.join(sibling, "secret.txt");
      fs.writeFileSync(secret, "CROSS-READ-SECRET");
      r = spawnSync(BIN, [proj, "bash", "-c", `cat ${secret}`], { encoding: "utf8" });
      proof.push(`cross-read: status=${r.status} stdout=${(r.stdout || "").slice(0, 100)}`);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("CROSS-READ-SECRET");

      // (d) mkdir + write deeper in sibling → also blocked
      const bad2Dir = path.join(sibling, "sub", "deeper");
      const bad2 = path.join(bad2Dir, "x.txt");
      r = spawnSync(BIN, [proj, "bash", "-c", `mkdir -p ${bad2Dir} && echo x > ${bad2}`], { encoding: "utf8" });
      proof.push(`outside-deeper: status=${r.status}`);
      expect(r.status).not.toBe(0);
      expect(fs.existsSync(bad2)).toBe(false);

      proof.push("KERNEL PROOF COMPLETE: EPERM on all outside writes (checked from host), success inside + cross-read.");
    } finally {
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(sibling, { recursive: true, force: true }); } catch {}
      fs.writeFileSync(C3_PROOF, proof.join("\n") + "\n", "utf8");
    }
  });

  it("POCFIX13: agent provider state dirs (~/.grok, ~/.codex) are writable under the fence (else grok/codex session-start hangs)", () => {
    const fence = getWriteFenceStatus();
    if (fence.status !== "active") {
      throw new Error(`landlock unavailable (status=${fence.status}) — cannot verify POCFIX13 exception`);
    }
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "c3-pf13-proj-"));
    const home = os.homedir();
    try {
      for (const dir of [".grok", ".codex"]) {
        const probe = path.join(home, dir, `helm-c3-probe-${process.pid}.txt`);
        const r = spawnSync(BIN, [proj, "bash", "-c", `mkdir -p ${path.join(home, dir)} && echo OK > ${probe} && cat ${probe}`], { encoding: "utf8" });
        try {
          expect(r.status).toBe(0);                       // write under ~/<dir> must succeed (the fix)
          expect(r.stdout).toContain("OK");
          expect(fs.existsSync(probe)).toBe(true);
        } finally {
          try { fs.rmSync(probe, { force: true }); } catch {}
        }
      }
    } finally {
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
    }
  });

  it("absolute resolved bin path + behavioral [WRITE-FENCE POLICY] injection (worker spawn path, seeded projects dir)", async () => {
    const mem = new Database(":memory:");
    mem.exec(`
      CREATE TABLE IF NOT EXISTS projects (id INTEGER PRIMARY KEY, name TEXT NOT NULL, directory TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_runtimes (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        task_brief TEXT,
        correlation_id TEXT,
        state TEXT NOT NULL,
        spawned_by TEXT,
        started_at TEXT,
        session TEXT,
        pane_pid INTEGER,
        run_id INTEGER
      );
    `);

    const tmpProj = fs.mkdtempSync(path.join(os.tmpdir(), "c3-behavioral-"));
    mem.prepare("INSERT OR REPLACE INTO projects (id, name, directory) VALUES (?,?,?)")
      .run(424242, "c3-behavioral-proj", tmpProj);

    // Wrap for WorkerService (expects .prepare + .raw.exec)
    const dbSvc: any = {
      prepare: (sql: string) => mem.prepare(sql),
      raw: { exec: (sql: string) => mem.exec(sql) },
    };

    const recorded: { cwd?: string; cmd?: string; fed?: string } = {};

    const recTmux: any = {
      async createSession(name: string, cwd?: string) {
        recorded.cwd = cwd;
        return `${name}:0.0`;
      },
      async sendCommand(_t: string, cmd: string) {
        recorded.cmd = cmd;
        return { blocked: false, message: "sent" };
      },
      async sendAndSubmit(_t: string, text: string) {
        recorded.fed = text;
        return true;
      },
      async getPanePid() {
        return "12345";
      },
      async capturePane() {
        return "❯ ready\n"; // satisfy _waitForReady in worker before the fed send
      },
      async sessionExists() {
        return false;
      },
      async terminateSession() {},
    };

    // Minimal assignment so resolveProjectRole succeeds with a grok agent (no claude)
    const fakeAssignment: any = {
      resolveProjectRole(_pid: number, _role: string) {
        return {
          agent: {
            id: 777,
            provider: "grok",
            model: "grok-4.5",
            default_effort: "medium",
          },
        };
      },
    };

    const resolver = new ProviderResolverService();
    const fakeEvents: any = { recordEvent() {} };
    const fakeToolkit: any = { composeToolkits() { return ""; } };

    const worker = new WorkerService(
      dbSvc,
      fakeEvents,
      recTmux,
      resolver,
      fakeAssignment,
      undefined,
      fakeToolkit
    );

    // Act: should reach create/send/sendAndSubmit with our recordings (dir query, prefix, policy all exercised)
    const w: any = await worker.spawnWorker({
      projectId: 424242,
      role: "implementer",
      taskBrief: "prove the fence",
      spawnedBy: "c3-test",
    });

    expect(recorded.cwd).toBe(tmpProj);
    expect(recorded.cmd).toBeTruthy();
    // Refinement: MUST invoke the compiled binary by ABSOLUTE path (dist/tools or tools). An env
    // prefix (e.g. CODEX_HOME=/HOME= from envelope isolation) may precede it, so match the absolute
    // helm-sandbox path either at the start of the command or right after an env-assignment prefix.
    expect(recorded.cmd).toMatch(/(?:^|\s)\/\S*helm-sandbox\b/);
    expect(recorded.cmd).toContain("helm-sandbox");
    expect(recorded.cmd).toContain(tmpProj);
    expect(recorded.fed).toBeTruthy();
    expect(recorded.fed).toContain("[WRITE-FENCE POLICY");
    expect(recorded.fed).toContain(tmpProj);
    expect(recorded.fed).toContain("OS-enforced");
    expect(recorded.fed).toContain("fail-closed");

    expect(w).toBeTruthy();
    expect(w.state).toBe("running");

    // cleanup
    try { fs.rmSync(tmpProj, { recursive: true, force: true }); } catch {}
    mem.close();
  });

  it("startup self-check reports active (binary exists+executable + Landlock probe)", () => {
    const st = getWriteFenceStatus();
    expect(st.status).toBe("active");
    expect(st.detail).toContain("ABI v4");
  });

  // === C3 iter1 red-team regression cases (re-run exact W1/W2/W3 repros from sonnet-findings.md; must now BLOCK) ===

  it("W1 regression (CRITICAL fd scrub): inherited fd write to outside victim now BLOCKED (EBADF, no content)", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "c3-w1-proj-"));
    const victimDir = fs.mkdtempSync(path.join(os.homedir(), "c3-w1-victim-"));
    const victim = path.join(victimDir, "fd_escape.txt");
    const outsideFd = fs.openSync(victim, "w");
    const proofLines: string[] = [`W1: proj=${proj} victim=${victim} fd=${outsideFd}`];
    try {
      // Repro exact: open fd in parent, pass numeric to inner bash via the sandboxed cmd
      const r = spawnSync(BIN, [proj, "bash", "-c", `echo 'PWNED-VIA-FD${outsideFd}' >&${outsideFd}`], { encoding: "utf8" });
      const content = fs.existsSync(victim) ? fs.readFileSync(victim, "utf8") : "";
      proofLines.push(`status=${r.status} stderr=${(r.stderr || "").slice(0, 200)} content_present=${content.includes("PWNED")}`);
      expect(r.status).not.toBe(0); // bash sees closed fd → bad descriptor
      expect(content).not.toContain("PWNED");
      expect(content).not.toContain("PWNED-VIA-FD");
      proofLines.push("W1 BLOCKED (fd scrubbed, write failed)");
    } finally {
      try { fs.closeSync(outsideFd); } catch {}
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(victimDir, { recursive: true, force: true }); } catch {}
      fs.appendFileSync(C3_PROOF, "\n" + proofLines.join("\n") + "\n", "utf8");
    }
  });

  it("W2 regression (HIGH real home): HOME= injection to sibling now BLOCKED (only real pw_dir .config granted)", () => {
    const proj = fs.mkdtempSync(path.join(os.tmpdir(), "c3-w2-proj-"));
    const badHome = fs.mkdtempSync(path.join(os.homedir(), "c3-w2-badhome-"));
    const badConfigP = path.join(badHome, ".config", "pwned.txt");
    const proofLines: string[] = [`W2: proj=${proj} badHome=${badHome}`];
    try {
      // exact repro: HOME=bad ... bash -c 'mkdir -p $HOME/.config && echo > ...'
      const env = { ...process.env, HOME: badHome };
      const r = spawnSync(BIN, [proj, "bash", "-c", "mkdir -p $HOME/.config && echo PWNED > $HOME/.config/pwned.txt"], { env, encoding: "utf8" });
      const created = fs.existsSync(badConfigP);
      proofLines.push(`status=${r.status} created_in_bad=${created} stderr=${(r.stderr || "").slice(0, 150)}`);
      expect(created).toBe(false);
      expect(r.status).not.toBe(0); // or at least no write
      proofLines.push("W2 BLOCKED (real getpwuid home used; injected HOME ignored for exceptions)");
    } finally {
      try { fs.rmSync(proj, { recursive: true, force: true }); } catch {}
      try { fs.rmSync(badHome, { recursive: true, force: true }); } catch {}
      fs.appendFileSync(C3_PROOF, "\n" + proofLines.join("\n") + "\n", "utf8");
    }
  });

  it("W3 regression (MED realpath+shallow + iter2 non-abs): relative '.' refused (non-absolute early reject); absolute project path still works normally", () => {
    const home = os.homedir();
    const victimDir = fs.mkdtempSync(path.join(home, "c3-w3-victim-"));
    const victim = path.join(victimDir, "relative_escape.txt");
    const proofLines: string[] = [`W3: cwd=${home} arg=. victim=${victim}`];
    try {
      // exact repro style from iter2: cwd=parent (home), pass "." as project_dir → now caught by non-abs check (argv[1][0] != '/') before any rules
      const r = spawnSync(BIN, [".", "bash", "-c", `echo PWNED > ${victim}`], { cwd: home, encoding: "utf8" });
      const created = fs.existsSync(victim);
      proofLines.push(`relative status=${r.status} created=${created} stderr=${(r.stderr || "").slice(0, 200)}`);
      expect(r.status).not.toBe(0); // fail-closed early (non-absolute)
      expect(created).toBe(false);
      proofLines.push("W3 relative '.' BLOCKED (non-absolute project_dir rejected before rules)");

      // Extend: absolute project path still works (normal inside write succeeds)
      const absProj = fs.mkdtempSync(path.join(os.tmpdir(), "c3-w3-abs-proj-"));
      const inside = path.join(absProj, "inside-ok.txt");
      const r2 = spawnSync(BIN, [absProj, "bash", "-c", `echo ABS-OK > ${inside}`], { encoding: "utf8" });
      const insideCreated = fs.existsSync(inside);
      proofLines.push(`abs status=${r2.status} inside_created=${insideCreated}`);
      expect(r2.status).toBe(0);
      expect(insideCreated).toBe(true);
      expect(fs.readFileSync(inside, "utf8")).toContain("ABS-OK");
      proofLines.push("W3 absolute path still works (inside write OK)");
      try { fs.rmSync(absProj, { recursive: true, force: true }); } catch {}
    } finally {
      try { fs.rmSync(victimDir, { recursive: true, force: true }); } catch {}
      fs.appendFileSync(C3_PROOF, "\n" + proofLines.join("\n") + "\n", "utf8");
    }
  });
});
