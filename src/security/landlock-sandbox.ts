import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import os from "node:os";
import { loadConfig } from "../config/config.js";

/**
 * C3: resolve absolute path to the compiled helm-sandbox binary.
 * Prefers explicit config override, then the post-build dist/tools location (absolute <repo>/dist/tools/helm-sandbox),
 * then the tools/ at cwd. Always returns absolute path. Self-check will verify exists+executable.
 */
export function resolveHelmSandboxBin(): string {
  const cfg: any = loadConfig();
  if (cfg.HELM_SANDBOX_BIN && cfg.HELM_SANDBOX_BIN.trim()) {
    return path.resolve(cfg.HELM_SANDBOX_BIN.trim());
  }
  // Refinement: absolute resolved path to the *compiled* binary (dist/tools after build).
  // This ensures the tmux shell pane always finds it even if PATH is minimal.
  const distBin = path.resolve(process.cwd(), "dist/tools/helm-sandbox");
  if (fs.existsSync(distBin)) {
    return distBin;
  }
  // Fallback (dev/tsx or pre-cp): the tools/ tree binary produced by the build step.
  return path.resolve(process.cwd(), "tools/helm-sandbox");
}

/**
 * B-ISO1 (2026-07-16 cheat-isolation agreement): compose the env prefix that opts ONE fenced
 * launch into the sandbox binary's strict READ profile
 * (HELM_SANDBOX_RO_PROFILE=strict + HELM_SANDBOX_RO_ALLOW=<colon-separated ro allowlist>).
 * The returned string ends with a trailing space so callers prepend it directly:
 *   `${strictEnv}${envPrefix}${sandboxBin} ${projectDir} ${launchCmd}`.
 * Validation is fail-closed and mirrors the binary's own checks: non-empty list, absolute
 * entries, no ':' (the list separator) and no control characters. The value is single-quoted
 * shell-safe (embedded single quotes escaped with the '\'' idiom). Existence of each path is
 * deliberately NOT checked here — the binary realpath()s every entry and refuses the launch
 * fail-closed at exec time (the authoritative check, immune to TOCTOU between compose and launch).
 */
export function makeStrictReadProfileEnv(allowPaths: string[]): string {
  if (!Array.isArray(allowPaths) || allowPaths.length === 0) {
    throw new Error(
      "strict read profile: allowlist must be a non-empty array of absolute paths " +
        "(the sandbox binary fails closed on an empty HELM_SANDBOX_RO_ALLOW)"
    );
  }
  const cleaned = allowPaths.map((p) => {
    if (typeof p !== "string" || p.trim() === "") {
      throw new Error("strict read profile: allowlist entries must be non-empty strings");
    }
    const t = p.trim();
    if (!path.isAbsolute(t)) {
      throw new Error(`strict read profile: allowlist entries must be absolute paths (got '${p}')`);
    }
    if (t.includes(":")) {
      throw new Error(
        `strict read profile: ':' is the HELM_SANDBOX_RO_ALLOW separator and cannot appear in an entry (got '${p}')`
      );
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(t)) {
      throw new Error(
        `strict read profile: control characters are not allowed in an allowlist entry (got ${JSON.stringify(p)})`
      );
    }
    return path.normalize(t);
  });
  const value = cleaned.join(":").replace(/'/g, `'\\''`);
  return `HELM_SANDBOX_RO_PROFILE=strict HELM_SANDBOX_RO_ALLOW='${value}' `;
}

/**
 * B-ISO1 (2026-07-16 cheat-isolation, harness ACTIVATION seam): resolve the DEPLOYMENT-LEVEL
 * default strict read allowlist from HELM_STRICT_READ_ALLOW. This is how the cards2 harness :3110
 * instance (and any confidentiality-by-default deployment) turns the fence ON without any per-run
 * or per-project caller change: `startRunInner` uses this as the DEFAULT `runStrictAllow` whenever
 * the run itself did not pass an explicit `strictReadAllow`. So EVERY run on such an instance —
 * including a project a user creates entirely through the UI — launches fenced.
 *
 * Accepted forms (either is fine — pick whichever is convenient in the deployment .env):
 *   - a colon-separated list of absolute paths, identical in shape to the sandbox binary's own
 *     HELM_SANDBOX_RO_ALLOW, e.g. `/usr:/etc:/tmp/helm-harness`; or
 *   - a JSON array of absolute path strings, e.g. `["/usr","/etc","/tmp/helm-harness"]`.
 *
 * Fail-closed, mirroring master-runtime-service's `parseStrictReadAllow` contract:
 *   - UNSET, or empty / whitespace-only  => `undefined` (read-all default; byte-identical to a
 *     deployment with no fence configured — every existing instance and every existing test);
 *   - SET but malformed (bad JSON, a non-array JSON value, or a list that resolves to zero paths)
 *     => THROWS. A configured-but-broken fence NEVER silently downgrades to read-all.
 *
 * The resolved array is validated through `makeStrictReadProfileEnv` (absolute paths, no ':' inside
 * an entry, no control chars) so a bad deployment policy is rejected up-front rather than surfacing
 * as a per-seat spawn throw mid-run.
 */
export function resolveDeploymentStrictReadAllow(
  raw: string | undefined = process.env.HELM_STRICT_READ_ALLOW
): string[] | undefined {
  if (raw == null) return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined; // unset/empty => read-all (byte-identical default)

  let list: string[];
  if (trimmed.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(
        `HELM_STRICT_READ_ALLOW: set but not valid JSON; refusing to silently fall back to read-all: ${trimmed}`
      );
    }
    if (!Array.isArray(parsed)) {
      throw new Error(
        "HELM_STRICT_READ_ALLOW: the JSON form must be an array of absolute path strings"
      );
    }
    list = parsed as string[];
  } else {
    // colon-separated (sandbox HELM_SANDBOX_RO_ALLOW shape); tolerate stray whitespace and
    // leading/trailing/repeated separators (they are dropped before the sandbox ever sees the value).
    list = trimmed
      .split(":")
      .map((s) => (typeof s === "string" ? s.trim() : s))
      .filter((s) => s !== "");
  }

  if (list.length === 0) {
    throw new Error(
      "HELM_STRICT_READ_ALLOW: set but resolves to zero paths; refusing read-all fallback"
    );
  }
  // Fail-closed content validation (absolute, no embedded ':', no control chars); throws on malformed.
  makeStrictReadProfileEnv(list);
  return list;
}

// B-ISO1: optional strictReadAllow swaps ONLY the read line of the behavioral policy — a strict
// seat told "you MAY read anywhere" would fight the kernel fence (confused retries + misleading
// self-reports during the harness negative probes). Absent (every existing caller) the output is
// byte-identical to the pre-existing policy text.
export function makeWriteFencePolicy(projectDir: string, strictReadAllow?: string[]): string {
  const readLine =
    strictReadAllow && strictReadAllow.length
      ? `- READ access is restricted to an explicit allowlist (strict read profile): ${strictReadAllow.join(" , ")} plus the project directory ${projectDir}. Reads or directory listings outside these paths fail with EACCES at the syscall level; do not retry them.`
      : `- You MAY read files anywhere on the filesystem (cross-project reads allowed).`;
  return `[WRITE-FENCE POLICY — OS-enforced (Landlock ABI v4)]
You are strictly bound to write ONLY inside the project directory: ${projectDir}
${readLine}
- You MUST NEVER write, create, truncate, mkdir, unlink, rename or otherwise modify files or directories outside ${projectDir} (sibling projects, parents, system paths, etc.).
- Kernel enforcement via Landlock LSM (ABI v4): attempts outside will fail with EPERM at the syscall level; the process tree cannot bypass.
- Documented tooling exceptions (still strictly scoped by the same ruleset): /tmp , $HOME/.config , $HOME/.cache , $HOME/.npm (and their subdirectories). These are NOT a project-write hole.
- Refuse + report any tool attempt at out-of-bound write; continue only with allowed paths.
- This is real fail-closed enforcement (the launcher binary exits non-zero rather than exec'ing you unfenced) + behavioral backstop. It augments your role and other instructions.
--- END WRITE-FENCE POLICY ---`;
}

/**
 * B1 (R2.12/F6): compose the env prefix that grants the sandbox binary's extra WRITE-fence exception
 * for a durable HELM_RUN_ROOT outside /tmp — worker seats append to <run>/callbacks.md under the
 * fence (the Helm-native callback contract), and /tmp is the only run-root location covered by a
 * hardcoded write exception today (tools/helm-sandbox.c). Absent/empty HELM_RUN_ROOT -> '' (byte-
 * identical to every existing caller/test — the default os.tmpdir() root is already covered by /tmp).
 * SET but non-absolute -> THROWS (fail-closed; mirrors the "ABSOLUTE HELM_RUN_ROOT" contract) rather
 * than silently granting nothing while HELM_RUN_ROOT is honoured code-side (the exact false-PASS F6
 * warns about). The returned string ends with a trailing space so callers prepend it directly.
 */
export function makeRunRootWriteAllowEnv(runRootOverride: string | undefined = process.env.HELM_RUN_ROOT): string {
  const value = (runRootOverride || "").trim();
  if (!value) return ""; // unset/empty -> default os.tmpdir() root, already covered by the /tmp exception
  if (!path.isAbsolute(value)) {
    throw new Error(`HELM_RUN_ROOT must be an absolute path (got '${value}')`);
  }
  if (value.includes(":")) {
    throw new Error(`HELM_RUN_ROOT must not contain ':' (the HELM_SANDBOX_WRITE_ALLOW separator): '${value}'`);
  }
  return `HELM_SANDBOX_WRITE_ALLOW='${value.replace(/'/g, `'\\''`)}' `;
}

/**
 * Startup self-check (honest): verifies the binary exists + is executable, then runs a quick landlock probe
 * (temp project dir + /bin/true). Returns 'active' only on full success. Never lies about enforcement.
 */
export function getWriteFenceStatus(): { status: "active" | "UNAVAILABLE"; detail: string } {
  const bin = resolveHelmSandboxBin();
  if (!fs.existsSync(bin)) {
    return { status: "UNAVAILABLE", detail: `binary missing at ${bin} (build not run or cp failed)` };
  }
  try {
    const stats = fs.statSync(bin);
    if (!stats.isFile() || !(stats.mode & fs.constants.S_IXUSR)) {
      return { status: "UNAVAILABLE", detail: "binary not executable (check build permissions)" };
    }
  } catch (e: any) {
    return { status: "UNAVAILABLE", detail: `stat failed: ${String(e?.message || e)}` };
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "helm-sandbox-probe-"));
  try {
    const r = spawnSync(bin, [tmp, "/bin/true"], { encoding: "utf8", timeout: 5000 });
    if (r.error || r.status !== 0 || /landlock setup failed/i.test(r.stderr || "")) {
      return { status: "UNAVAILABLE", detail: `probe failed (status=${r.status}): ${(r.stderr || "").slice(0, 150)}` };
    }
    return { status: "active", detail: "Landlock ABI v4 (project-bound master/worker launches only)" };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
}
