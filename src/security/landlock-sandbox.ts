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

/**
 * R2.6 fix (found live, cycle 13 run 36, 2026-08-03 07:45 PHT): strict mode (add_strict_allow_rules
 * in tools/helm-sandbox.c) grants READ+EXEC on ONLY the caller-supplied HELM_SANDBOX_RO_ALLOW entries
 * plus the project subtree — no blanket root-ro rule, and nothing about the agent CLI's own binary or
 * shared libraries is implied. Every strict-mode launch this deployment had exercised before tonight
 * was the B-ISO1 opt-in path with an UNSET HELM_STRICT_READ_ALLOW (this env is empty in .env), so it
 * always fell back to read-all and this gap was never hit. Round-1 blind-draft seats (R2/D2) are the
 * first caller that forces strict mode unconditionally — without this baseline, `execvp(claude)`
 * (or codex/grok) fails closed with "Permission denied" the instant the sandbox restricts itself,
 * before the seat ever gets a chance to run.
 *
 * Returns the subset of {standard shared-library dirs, this user's known CLI install trees} that
 * actually exist on THIS machine — the C binary realpath()s every entry and fails closed on any that
 * don't resolve, so a hardcoded-but-absent path would break the launch worse than omitting it.
 *
 * `/proc`, `/etc`, `/run`, and each provider's own credential dir were added after direct manual
 * repro (bypassing the seat-spawn machinery entirely, running the sandboxed launch command by hand
 * with a REAL `--print`/`exec` prompt, not just `--version`):
 *   - without `/proc`: claude's compiled Node/V8 binary hits a fatal internal error during its own
 *     startup and SIGABRTs ("Aborted (core dumped)") rather than a catchable error;
 *   - without `/etc`: codex's Node runtime fails cleanly (exit 13) on `fopen(/etc/ssl/openssl.cnf)`;
 *   - without `/run`: both hang/ETIMEOUT reaching their API — `/etc/resolv.conf` on this box is a
 *     symlink to `/run/systemd/resolve/stub-resolv.conf` (systemd-resolved), so DNS resolution needs
 *     `/run` readable too;
 *   - without `~/.claude` / `~/.codex`: each CLI reports "not logged in" — that's where its OAuth/API
 *     credentials live (`~/.claude/.credentials.json`, `~/.codex/auth.json`).
 * `claude --print "..."` and `codex exec "..."` both confirmed a genuine round-trip (real model
 * reply) through the strict sandbox with exactly this baseline before wiring it in here.
 *
 * gpt-5.6-sol review (consulted live, 2026-08-03 08:1x PHT, per JROM's ask to bring in a second
 * opinion on this sandbox work): the FIRST version of this function granted every seat all three
 * providers' credential dirs regardless of which provider it actually runs — broader than "strict"
 * should mean, and unnecessary (a claude seat never needs to read `~/.codex/auth.json`). Fixed:
 * `provider` scopes the credential grant to only the one this seat actually launches as. Sol also
 * caught the real remaining gap: `~/.claude.json` (a FILE, sibling to the `~/.claude/` directory —
 * NOT inside it, so the directory grant above never covered it) is where claude keeps
 * `hasCompletedOnboarding` / `theme`; without READ on the exact file the sandboxed TUI can't see
 * that onboarding was already completed and shows the first-run theme-picker wizard instead of the
 * ready composer. `RealTransport.ensureClaudeTrust()` already writes the prepared trust/onboarding
 * state into that file OUTSIDE the sandbox before launch — the seat only needs to read it back, so
 * this is READ-only, not added to the write-fence.
 *
 * `~/.cache/helm-agent-homes/<codex|grok>` (found live, run 41, 2026-08-03 08:2x PHT): per
 * `agent-home-isolation.ts` (JROM directive 2026-07-06), Helm-dispatched codex/grok launches do NOT
 * use the real `~/.codex` / `~/.grok` as their working home — `envelope-isolation.ts` points
 * `CODEX_HOME` (codex) / `HOME` (grok) at an isolated blank-slate dir under `~/.cache/helm-agent-
 * homes/` that read-only-symlinks in just auth+config (never the operator's skills/agents), so the
 * CLI writes its session/sqlite state there instead of polluting the real home. Granting only
 * `~/.codex` (as the first version of this function did) misses this entirely: codex reported a
 * generic "local database appears to be damaged" — actually a Landlock EACCES on
 * `~/.cache/helm-agent-homes/codex/state_N.sqlite` misreported by codex's own error handling. WRITE
 * is already covered (the C sandbox's hardcoded `$HOME/.cache` tooling exception survives strict
 * mode per `helm-sandbox.c`'s own comment); only READ was missing. Confirmed via manual repro with
 * the exact real dispatch env (`CODEX_HOME` set, full RO allowlist) before wiring in.
 */
export function resolveAgentExecBaselineAllow(provider?: string): string[] {
  const home = os.homedir();
  const agentHomesBase = path.join(home, ".cache", "helm-agent-homes");
  const candidates = [
    "/lib",
    "/lib64",
    "/usr/lib",
    "/usr/bin",
    "/proc",
    "/etc",
    "/run",
    path.join(home, ".local"), // claude + grok native launchers (~/.local/bin, ~/.local/share/claude/...)
    path.join(home, ".npm-global"), // codex (npm -g install prefix)
  ];
  if (provider === "claude") {
    candidates.push(path.join(home, ".claude")); // OAuth/API credentials + config
    candidates.push(path.join(home, ".claude.json")); // hasCompletedOnboarding/theme (sibling FILE, not under ~/.claude/)
  } else if (provider === "codex") {
    candidates.push(path.join(home, ".codex")); // auth.json + config.toml (symlink targets for the isolated home below)
    candidates.push(path.join(agentHomesBase, "codex")); // isolated CODEX_HOME — actual working dir + sqlite state
  } else if (provider === "grok") {
    candidates.push(path.join(home, ".grok")); // config/credentials (symlink targets for the isolated home below)
    candidates.push(path.join(agentHomesBase, "grok")); // ensureBlankGrokHome() overrides grok's entire $HOME to here
    // grok's shell tools may read the operator's git identity (ensureBlankGrokHome symlinks it in).
    if (fs.existsSync(path.join(home, ".gitconfig"))) candidates.push(path.join(home, ".gitconfig"));
    // Not itself live-verified tonight — grok isn't in this project's round-1 co-planner roster.
  } else {
    // Unknown/absent provider: keep the pre-scoping behavior (grant all three) rather than guess wrong.
    candidates.push(
      path.join(home, ".claude"), path.join(home, ".claude.json"),
      path.join(home, ".codex"), path.join(agentHomesBase, "codex"),
      path.join(home, ".grok"), path.join(agentHomesBase, "grok")
    );
  }
  return candidates.filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });
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
 * B1 (R2.12/F6) — send-back CRITICAL fix (redteam): grant ONLY the calling seat's OWN run directory,
 * never the shared HELM_RUN_ROOT itself. The original version turned bare HELM_RUN_ROOT into the
 * grant, which — because Landlock PATH_BENEATH is recursive — let ANY fenced seat write into ANY
 * sibling `helm-run-*` directory under that shared root, including another active run's
 * `callbacks.md` (a forge/corruption vector on a DIFFERENT run's callback stream). A durable
 * HELM_RUN_ROOT outside /tmp is still required (worker seats append to <run>/callbacks.md under the
 * fence — the Helm-native callback contract — and /tmp is the only run-root location covered by a
 * hardcoded write exception in tools/helm-sandbox.c), but the grant must be scoped to the ONE run
 * directory this seat actually belongs to.
 *
 * `runDir` is the caller's own concrete run directory (e.g. RealTransport.spawn's `params.runDir`).
 * Callers with NO run-directory concept (worker-service.ts's ad-hoc worker spawn, master-runtime-
 * service.ts's phase-brain launch — neither ever touches a run-scoped path) must NOT call this at
 * all; passing no `runDir` returns '' rather than falling back to granting the shared root.
 *
 * Absent/empty HELM_RUN_ROOT, absent runDir, or a runDir that isn't actually contained under
 * HELM_RUN_ROOT (e.g. the default os.tmpdir()-based root, already covered by the /tmp exception) ->
 * '' (byte-identical / no grant — never widens to the root as a fallback). A SET-but-non-absolute
 * HELM_RUN_ROOT -> THROWS (fail-closed; mirrors the "ABSOLUTE HELM_RUN_ROOT" contract) rather than
 * silently granting nothing while HELM_RUN_ROOT is honoured code-side elsewhere. The returned string
 * ends with a trailing space so callers prepend it directly.
 */
export function makeRunRootWriteAllowEnv(
  runDir: string | undefined,
  runRootOverride: string | undefined = process.env.HELM_RUN_ROOT
): string {
  const root = (runRootOverride || "").trim();
  if (!root || !runDir) return ""; // no durable run root configured, or this seat has no run directory
  if (!path.isAbsolute(root)) {
    throw new Error(`HELM_RUN_ROOT must be an absolute path (got '${root}')`);
  }
  if (root.includes(":")) {
    throw new Error(`HELM_RUN_ROOT must not contain ':' (the HELM_SANDBOX_WRITE_ALLOW separator): '${root}'`);
  }
  const resolvedRoot = path.resolve(root);
  const resolvedRunDir = path.resolve(runDir);
  const rel = path.relative(resolvedRoot, resolvedRunDir);
  const contained = resolvedRunDir !== resolvedRoot && rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  if (!contained) return ""; // runDir isn't under HELM_RUN_ROOT — nothing to grant here (never widen to root)
  return `HELM_SANDBOX_WRITE_ALLOW='${resolvedRunDir.replace(/'/g, `'\\''`)}' `;
}

/**
 * B8 (R4.1/R4.3): compose the four cycle-scoped git capability env vars that B7's C binary
 * enforces (`HELM_SANDBOX_GIT_RO` / `_ADMIN` / `_REF_RW` / `_OBJ`). Paths come ONLY from the
 * persisted, revalidated cycle identity — never a brief field, task field, free-floating caller
 * path, or ambient env. The admin path is derived as
 * `<common>/worktrees/<persisted git_worktree_id>` (never scanned or guessed from the worktrees
 * directory). Objects go in the OBJ class only, never REF_RW or ADMIN. Returns '' when the cycle
 * has no worktree (byte-identical no-op for legacy / pre-B6 cycles). Node-side validation mirrors
 * the C fail-closed checks: absolute, no ':', no control chars, strict-descendant-of-RO, ADMIN is
 * a DIRECT child of `<common>/worktrees` (not worktrees itself), and the identity belongs to the
 * registered project.
 *
 * `projectDir` is the project's registered directory (ownership boundary for revalidation) — it is
 * not itself emitted as a grant.
 */
export type CycleGitAllowCycle = {
  id: number;
  git_worktree_path: string | null;
  git_worktree_id: string | null;
  /** Absolute registered project.directory — revalidation boundary only, never a grant source. */
  projectDir: string;
};

function isStrictPathDescendant(anchor: string, candidate: string): boolean {
  const a = path.resolve(anchor);
  const c = path.resolve(candidate);
  if (a === c) return false;
  const rel = path.relative(a, c);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** Fail-closed path shape for a GIT_* entry (mirrors resolve_git_entry in tools/helm-sandbox.c). */
function assertGitAllowPath(label: string, raw: string): string {
  if (typeof raw !== "string" || raw === "") {
    throw new Error(`cycle git allow: ${label} must be a non-empty string`);
  }
  // Deliberately no trim — C compares the raw value to realpath(); whitespace is invalid.
  if (!path.isAbsolute(raw)) {
    throw new Error(`cycle git allow: ${label} must be an absolute path (got '${raw}')`);
  }
  if (raw.includes(":")) {
    throw new Error(
      `cycle git allow: ${label} must not contain ':' (the HELM_SANDBOX_GIT_REF_RW separator): '${raw}'`
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(raw)) {
    throw new Error(`cycle git allow: ${label} must not contain control characters`);
  }
  let rp: string;
  try {
    rp = fs.realpathSync(raw);
  } catch (e: any) {
    throw new Error(
      `cycle git allow: ${label} does not resolve (must already exist; no ensure_dir): '${raw}' (${e?.message || e})`
    );
  }
  // Canonical: raw must equal its own realpath (rejects trailing slash, relative components, symlinks).
  if (raw !== rp) {
    throw new Error(
      `cycle git allow: ${label} is not canonical (relative components, trailing slash, or symlink): '${raw}' != realpath '${rp}'`
    );
  }
  return rp;
}

function shellSingleQuote(value: string): string {
  return value.replace(/'/g, `'\\''`);
}

/**
 * Resolve the git common dir and the worktree admin dir from the worktree's `.git` pointer file
 * and its `commondir` sibling — no ambient env, no directory scan of `worktrees/`.
 */
function resolveCommonAndAdminFromWorktree(
  worktreePath: string,
  persistedWorktreeId: string
): { common: string; admin: string } {
  const gitFile = path.join(worktreePath, ".git");
  let content: string;
  try {
    content = fs.readFileSync(gitFile, "utf8");
  } catch (e: any) {
    throw new Error(
      `cycle git allow: cannot read worktree gitdir pointer at '${gitFile}': ${e?.message || e}`
    );
  }
  const m = content.match(/^gitdir:\s*(.+?)\s*$/m);
  if (!m) {
    throw new Error(
      `cycle git allow: worktree '${worktreePath}' .git is not a gitdir pointer (linked worktree required)`
    );
  }
  const gitdirRaw = m[1];
  if (!path.isAbsolute(gitdirRaw)) {
    throw new Error(`cycle git allow: worktree gitdir must be absolute (got '${gitdirRaw}')`);
  }
  if (gitdirRaw.includes(":")) {
    throw new Error(`cycle git allow: worktree gitdir must not contain ':': '${gitdirRaw}'`);
  }
  const admin = assertGitAllowPath("GIT_ADMIN (from worktree gitdir)", gitdirRaw);

  // Admin path must be exactly <common>/worktrees/<persisted id> — refuse worktrees itself and
  // any peer id. Derived from the persisted id for the grant; the gitdir must agree.
  if (path.basename(admin) !== persistedWorktreeId) {
    throw new Error(
      `cycle git allow: GIT_ADMIN resolves to another cycle's id (gitdir basename '${path.basename(admin)}' != persisted git_worktree_id '${persistedWorktreeId}')`
    );
  }
  if (path.basename(path.dirname(admin)) !== "worktrees") {
    throw new Error(
      `cycle git allow: GIT_ADMIN must be a DIRECT child of <common>/worktrees (got '${admin}')`
    );
  }

  const commondirFile = path.join(admin, "commondir");
  let common: string;
  try {
    const rel = fs.readFileSync(commondirFile, "utf8").trim();
    if (!rel) throw new Error("empty commondir");
    // commondir is typically relative ("../.."); resolve against the admin dir.
    const candidate = path.isAbsolute(rel) ? rel : path.resolve(admin, rel);
    common = assertGitAllowPath("GIT_RO (git common dir)", candidate);
  } catch (e: any) {
    throw new Error(
      `cycle git allow: cannot resolve git common dir from '${commondirFile}': ${e?.message || e}`
    );
  }

  // Fail-closed: the worktree's gitdir admin must already sit under the resolved common (RO).
  // Checked before the derived-equality gate so a gitdir planted outside common is refused with
  // an explicit "not under RO" (mirrors C is_strict_descendant), not a secondary mismatch message.
  if (!isStrictPathDescendant(common, admin)) {
    throw new Error(
      `cycle git allow: GIT_ADMIN path is not under RO ('${admin}' not under '${common}')`
    );
  }

  // Re-derive admin from common + persisted id (never scan worktrees/) and demand equality.
  const derivedAdmin = path.join(common, "worktrees", persistedWorktreeId);
  if (derivedAdmin.includes(":")) {
    throw new Error(`cycle git allow: derived GIT_ADMIN contains ':': '${derivedAdmin}'`);
  }
  if (derivedAdmin === path.join(common, "worktrees")) {
    throw new Error("cycle git allow: GIT_ADMIN must not name <common>/worktrees itself");
  }
  if (derivedAdmin !== admin) {
    throw new Error(
      `cycle git allow: derived GIT_ADMIN '${derivedAdmin}' != worktree gitdir '${admin}'`
    );
  }

  return { common, admin };
}

/** Resolved absolute paths for the four git capability classes, pre-formatting. */
type ResolvedCycleGitAllowPaths = {
  ro: string;
  adminPath: string;
  refPath: string;
  logPath: string;
  objPath: string;
};

/**
 * B9 (R4.1/R4.3): shared resolution/validation core, factored out of `makeCycleGitAllowEnv` so
 * `resolveCycleGitReadPaths` (below) can fold the same RO anchor into a strict-profile
 * HELM_SANDBOX_RO_ALLOW list without a second, independently-drifting implementation of these
 * checks. Returns null for a no-worktree (legacy) cycle — byte-identical no-op — and throws on
 * every fail-closed condition `makeCycleGitAllowEnv` always has.
 */
function resolveCycleGitAllowPaths(cycle: CycleGitAllowCycle): ResolvedCycleGitAllowPaths | null {
  if (!cycle || typeof cycle !== "object") {
    throw new Error("cycle git allow: cycle is required");
  }

  const wtPath = cycle.git_worktree_path;
  const wtId = cycle.git_worktree_id;

  // No worktree → byte-identical no-op (legacy null-identity cycles).
  if ((wtPath == null || wtPath === "") && (wtId == null || wtId === "")) {
    return null;
  }
  // Partial identity is a caller/persist bug — fail closed, never half-grant.
  if (wtPath == null || wtPath === "" || wtId == null || wtId === "") {
    throw new Error(
      "cycle git allow: partial git identity (both git_worktree_path and git_worktree_id are required once either is set)"
    );
  }

  if (typeof cycle.id !== "number" || !Number.isInteger(cycle.id) || cycle.id <= 0) {
    throw new Error(`cycle git allow: invalid cycle id: ${String(cycle.id)}`);
  }

  if (typeof cycle.projectDir !== "string" || cycle.projectDir === "") {
    throw new Error("cycle git allow: registered projectDir is required");
  }
  if (!path.isAbsolute(cycle.projectDir)) {
    throw new Error(
      `cycle git allow: registered projectDir must be an absolute path (got '${cycle.projectDir}')`
    );
  }
  if (cycle.projectDir.includes(":")) {
    throw new Error(
      `cycle git allow: registered projectDir must not contain ':': '${cycle.projectDir}'`
    );
  }

  // Persisted worktree id is a single path segment — never a scanned/guessed path, never '../x'.
  if (typeof wtId !== "string" || wtId === "") {
    throw new Error("cycle git allow: git_worktree_id must be a non-empty string");
  }
  if (wtId.includes("/") || wtId.includes("\\") || wtId.includes("\0")) {
    throw new Error(
      `cycle git allow: git_worktree_id must be a single path segment (got '${wtId}')`
    );
  }
  if (wtId.includes(":")) {
    throw new Error(
      `cycle git allow: git_worktree_id must not contain ':' (got '${wtId}')`
    );
  }
  if (wtId === "." || wtId === ".." || wtId.includes("..")) {
    // Empty segment after join would collapse ADMIN onto <common>/worktrees itself.
    throw new Error(
      `cycle git allow: GIT_ADMIN would resolve to <common>/worktrees itself or escape (git_worktree_id='${wtId}')`
    );
  }

  // Worktree path shape (absolute / no colon) before existence — so relative/colon tests throw
  // cleanly without a realpath ENOENT masking the cause.
  if (typeof wtPath !== "string" || wtPath === "") {
    throw new Error("cycle git allow: git_worktree_path must be a non-empty string");
  }
  if (!path.isAbsolute(wtPath)) {
    throw new Error(
      `cycle git allow: git_worktree_path must be an absolute path (got '${wtPath}')`
    );
  }
  if (wtPath.includes(":")) {
    throw new Error(
      `cycle git allow: git_worktree_path must not contain ':' (got '${wtPath}')`
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(wtPath)) {
    throw new Error("cycle git allow: git_worktree_path must not contain control characters");
  }

  let worktreePath: string;
  try {
    worktreePath = fs.realpathSync(wtPath);
  } catch (e: any) {
    throw new Error(
      `cycle git allow: git_worktree_path does not resolve: '${wtPath}' (${e?.message || e})`
    );
  }
  if (wtPath !== worktreePath) {
    throw new Error(
      `cycle git allow: git_worktree_path is not canonical: '${wtPath}' != realpath '${worktreePath}'`
    );
  }

  // Identity must belong to the registered project (strict descendant of projectDir).
  let projectReal: string;
  try {
    projectReal = fs.realpathSync(cycle.projectDir);
  } catch (e: any) {
    throw new Error(
      `cycle git allow: registered projectDir does not resolve: '${cycle.projectDir}' (${e?.message || e})`
    );
  }
  if (!isStrictPathDescendant(projectReal, worktreePath)) {
    throw new Error(
      `cycle git allow: identity does not belong to the registered project (worktree '${worktreePath}' is not under '${projectReal}')`
    );
  }

  const { common, admin } = resolveCommonAndAdminFromWorktree(worktreePath, wtId);

  // REF_RW: namespaced ref dir + reflog mirror for THIS cycle id only.
  const refDir = path.join(common, "refs", "heads", "helm", "cycle", String(cycle.id));
  const logDir = path.join(common, "logs", "refs", "heads", "helm", "cycle", String(cycle.id));
  // OBJ: object store — its own class, never REF_RW or ADMIN.
  const objDir = path.join(common, "objects");

  const ro = assertGitAllowPath("GIT_RO", common);
  const adminPath = assertGitAllowPath("GIT_ADMIN", admin);
  const refPath = assertGitAllowPath("GIT_REF_RW refs", refDir);
  const logPath = assertGitAllowPath("GIT_REF_RW logs", logDir);
  const objPath = assertGitAllowPath("GIT_OBJ", objDir);

  for (const [label, p] of [
    ["GIT_ADMIN", adminPath],
    ["GIT_REF_RW refs", refPath],
    ["GIT_REF_RW logs", logPath],
    ["GIT_OBJ", objPath],
  ] as const) {
    if (!isStrictPathDescendant(ro, p)) {
      throw new Error(`cycle git allow: ${label} path is not under RO ('${p}' not under '${ro}')`);
    }
  }

  // Refuse bare common-dir root on any write class (C also refuses common-dir ROOT grants).
  for (const [label, p] of [
    ["GIT_ADMIN", adminPath],
    ["GIT_REF_RW refs", refPath],
    ["GIT_REF_RW logs", logPath],
    ["GIT_OBJ", objPath],
  ] as const) {
    if (p === ro) {
      throw new Error(`cycle git allow: ${label} must not name the bare git common dir ('${ro}')`);
    }
  }

  // ADMIN must remain a direct child of <common>/worktrees and end with the persisted id.
  const worktreesDir = path.join(ro, "worktrees");
  if (adminPath === worktreesDir) {
    throw new Error("cycle git allow: GIT_ADMIN must not name <common>/worktrees itself");
  }
  if (path.dirname(adminPath) !== worktreesDir || path.basename(adminPath) !== wtId) {
    throw new Error(
      `cycle git allow: GIT_ADMIN must be <common>/worktrees/<persisted git_worktree_id> (got '${adminPath}')`
    );
  }

  // Structural class separation: objects go in OBJ only — never as a REF_RW or ADMIN entry.
  if (objPath === adminPath || objPath === refPath || objPath === logPath) {
    throw new Error("cycle git allow: objects must go in the OBJ class only");
  }
  if (path.basename(objPath) !== "objects") {
    throw new Error(`cycle git allow: GIT_OBJ must be the objects dir (got '${objPath}')`);
  }

  return { ro, adminPath, refPath, logPath, objPath };
}

export function makeCycleGitAllowEnv(cycle: CycleGitAllowCycle): string {
  const resolved = resolveCycleGitAllowPaths(cycle);
  if (!resolved) return "";
  const { ro, adminPath, refPath, logPath, objPath } = resolved;
  // REF_RW is a colon-separated list; each entry was already validated free of ':'.
  const refRw = `${refPath}:${logPath}`;
  return (
    `HELM_SANDBOX_GIT_RO='${shellSingleQuote(ro)}' ` +
    `HELM_SANDBOX_GIT_ADMIN='${shellSingleQuote(adminPath)}' ` +
    `HELM_SANDBOX_GIT_REF_RW='${shellSingleQuote(refRw)}' ` +
    `HELM_SANDBOX_GIT_OBJ='${shellSingleQuote(objPath)}' `
  );
}

/**
 * B9 (R4.1/R4.3): the git-common READ anchor alone (the same path `makeCycleGitAllowEnv` emits as
 * HELM_SANDBOX_GIT_RO), for callers that must fold it into HELM_SANDBOX_RO_ALLOW under the strict
 * read profile. Write bits (ADMIN/REF_RW/OBJ) without a matching READ grant leave git unable to
 * open its own config/HEAD/packed-refs/index — the capability would be write-only and broken.
 * Returns [] for a no-worktree (legacy) cycle — byte-identical no-op; throws on the same
 * fail-closed terms as `makeCycleGitAllowEnv` for a stale/malformed identity.
 */
export function resolveCycleGitReadPaths(cycle: CycleGitAllowCycle): string[] {
  const resolved = resolveCycleGitAllowPaths(cycle);
  return resolved ? [resolved.ro] : [];
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
