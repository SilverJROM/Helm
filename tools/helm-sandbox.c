/* tools/helm-sandbox.c — Landlock ABI v4 write-fence (C3)
 * Takes: <project_dir> <cmd> [args...]
 * Grants (default profile):
 *   - rw (all writes incl truncate/mkdir/unlink/rename + REFER): project_dir subtree + /tmp + $HOME/.config + $HOME/.cache + $HOME/.npm
 *   - ro (read + execute): /
 * Then execvp(cmd, ...).
 * On ANY landlock setup / prctl / open / restrict failure (or missing ABI support): write to stderr and exit non-zero.
 * NEVER exec the requested command unfenced (fail-closed).
 *
 * B-ISO1 (2026-07-16 cheat-isolation agreement, Option B hybrid): OPT-IN strict READ profile.
 *   HELM_SANDBOX_RO_PROFILE=strict (exact value) replaces the blanket root-ro rule with an
 *   enumerated ro allowlist. Profile selector is fail-closed: absent/empty -> default profile
 *   (read-all, byte-identical); exactly "strict" -> strict; ANY other non-empty value -> REFUSE
 *   execution (a typo never silently selects read-all). Allowlist form:
 *   HELM_SANDBOX_RO_ALLOW=<abs1>:<abs2>:... (colon-separated absolute paths, read+exec).
 *   Strict narrows READS only: the project-dir write fence, north-star.md exclusion and the
 *   write-side tooling exceptions are IDENTICAL in both profiles. Fail-closed on a missing/empty
 *   allowlist and on any relative/nonexistent/unrulable entry (never skipped silently).
 *   Policy (which paths a given run may read) stays caller-side; this mechanism is generic.
 *
 * B1 (2026-07-27, R2.12/F6): opt-in extra WRITE-fence exception.
 *   HELM_SANDBOX_WRITE_ALLOW=<abs1>:<abs2>:... (colon-separated absolute paths) grants the SAME
 *   write-side bits as the hardcoded /tmp + $HOME dot-dir tooling exceptions below (documented,
 *   narrow, additive — NOT project-write). Exists so a durable HELM_RUN_ROOT outside /tmp still
 *   lets a worker append to <run>/callbacks.md under the fence. Absent/empty -> no-op, byte-identical
 *   to every existing deployment/test. Set but malformed (relative path, empty entry) -> fail-closed.
 *
 * B7 (2026-08-04, R4.1/R4.3): cycle-scoped git capability, FOUR distinct classes threaded by a later
 * slice (B8's makeCycleGitAllowEnv) through HELM_SANDBOX_GIT_RO / _ADMIN / _REF_RW / _OBJ. A worktree's
 * commit machinery writes OUTSIDE the worktree fence, into the repo's git common dir (`<common>` —
 * `<project>/.git` for a normal checkout), so this is a second, narrower fence layered on top of the
 * project write fence, scoped to exactly the paths one cycle's commits touch:
 *   - GIT_RO      (one abs path)  — `<common>` itself, read+exec. Every other class must already exist
 *     as a strict descendant of this path; it is both a real grant (config/HEAD/packed-refs/index
 *     reads) and the validation anchor for the other three.
 *   - GIT_ADMIN   (one abs path)  — exactly `<common>/worktrees/<git_worktree_id>`, this cycle's
 *     private worktree admin dir (`index`, `index.lock`, `HEAD`, `ORIG_HEAD`, `COMMIT_EDITMSG`,
 *     `logs/HEAD`). `git add` creates `index.lock` here and renames it over `index`, so without this
 *     class no commit is possible at all. Full write class. Refuses `<common>/worktrees` itself and
 *     any path that is not a DIRECT child of it — the whole point is ONE cycle's admin state, never
 *     every peer cycle's.
 *   - GIT_REF_RW  (colon-separated abs paths) — the namespaced ref dir (`refs/heads/helm/cycle/<id>`)
 *     and its reflog mirror (`logs/refs/heads/helm/cycle/<id>`). `git commit` creates `<branch>.lock`
 *     inside the ref's directory, so the grant must be the directory, not the ref file. `refs/heads/
 *     main` and every peer cycle's namespace sit outside this subtree.
 *   - GIT_OBJ     (one abs path)  — `<common>/objects`, under a NARROWER mask than the other three:
 *     create only (MAKE_REG|MAKE_DIR|WRITE_FILE), with REFER, TRUNCATE, REMOVE_FILE, REMOVE_DIR
 *     and MAKE_SYM all omitted — empirically the minimum that lets `git add`+`git commit` write new
 *     loose objects (probed by adding one bit at a time from zero against a real repo, fixtures
 *     deliberately OUTSIDE /tmp and the $HOME tooling exceptions so no other grant could mask the
 *     result under test; REFER's omission is itself a checked finding — 5/5 stable passes without
 *     it — not an oversight; see
 *     plan/cycle-branch-lifecycle/validation/B7-impl-a1/obj-mask-derivation.md). This means a
 *     pre-existing object reachable from base or a peer branch can be neither truncated nor unlinked
 *     by this seat. Reads of the object store come from the GIT_RO ancestor grant, not from this class.
 * Every entry: must already exist (no ensure_dir — B6 pre-creates the reflog dir; git itself creates
 * the rest at worktree-add time), must be absolute + canonical (the raw value must equal its own
 * realpath() — this single check rejects relative components, a trailing slash, and any symlink
 * anywhere on the path in one move) and free of control characters. A directory target gets the full
 * class mask; a regular-file target gets the file-safe subset (no directory-only rights, which would
 * EINVAL on a non-dir fd) pinned to the file's own O_NOFOLLOW fd — never widened to its parent (same
 * discipline as FIX1/B22b-fix1 above). Absent HELM_SANDBOX_GIT_RO is a byte-identical no-op for every
 * existing caller (B9 threads this to cycle seats only); once set, GIT_ADMIN/GIT_REF_RW/GIT_OBJ are
 * ALL mandatory — the four classes travel together, so a partial set is a caller bug and fails closed
 * rather than silently granting less than intended.
 */
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <linux/landlock.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>
#include <limits.h>
#include <stdint.h>
#include <pwd.h>
#include <sys/types.h>
#include <dirent.h>
#include <stdbool.h>

#ifndef __NR_landlock_create_ruleset
#define __NR_landlock_create_ruleset 444
#endif
#ifndef __NR_landlock_add_rule
#define __NR_landlock_add_rule 445
#endif
#ifndef __NR_landlock_restrict_self
#define __NR_landlock_restrict_self 446
#endif

static int landlock_create_ruleset(const struct landlock_ruleset_attr *attr, size_t size, uint32_t flags) {
  return syscall(__NR_landlock_create_ruleset, attr, size, flags);
}
static int landlock_add_rule(int fd, enum landlock_rule_type t, const void *attr, uint32_t flags) {
  return syscall(__NR_landlock_add_rule, fd, t, attr, flags);
}
static int landlock_restrict_self(int fd, uint32_t flags) {
  return syscall(__NR_landlock_restrict_self, fd, flags);
}

static void fail(const char *op, const char *proj, int err) {
  fprintf(stderr,
          "helm-sandbox: landlock setup failed (op=%s, project_dir=%s): %s\n"
          "fail-closed: not executing the requested command (never run unfenced).\n",
          op, proj, strerror(err));
  exit(1);
}

static void ensure_dir(const char *path) {
  char tmp[PATH_MAX];
  strncpy(tmp, path, sizeof(tmp) - 1);
  tmp[sizeof(tmp) - 1] = '\0';
  for (char *p = tmp + 1; *p; ++p) {
    if (*p == '/') {
      *p = '\0';
      mkdir(tmp, 0755);
      *p = '/';
    }
  }
  mkdir(tmp, 0755);
}

static int open_path(const char *path) {
  int fd = open(path, O_PATH | O_CLOEXEC | O_DIRECTORY);
  if (fd < 0) {
    fd = open(path, O_PATH | O_CLOEXEC);
  }
  return fd;
}

/* allow_parent_widen=true: POCFIX10 behavior -- if the target isn't a directory, grant `access`
 * on its PARENT dir instead (used for char devices under /dev, where widening to the containing
 * dir is a documented, harmless tooling exception).
 * allow_parent_widen=false: FIX1 (B22b-fix1) -- never widen. If the target isn't a directory,
 * issue the PATH_BENEATH rule directly on the file's own fd. `access` must already be a
 * file-safe mask (no directory-only rights such as MAKE_REG, MAKE_DIR, REMOVE_FILE, REMOVE_DIR,
 * REFER, READ_DIR -- the kernel returns EINVAL if any of those are present on a non-directory
 * rule). Callers that need this must pass a file-scoped access mask (see file_rw_full below).
 */
static void add_rule_ex(int rs, const char *path, uint64_t access, const char *proj, const char *label, bool allow_parent_widen) {
  int fd = open_path(path);
  if (fd < 0) {
    ensure_dir(path);
    fd = open_path(path);
  }
  if (fd < 0) {
    if (strcmp(label, "project") == 0) {
      fail("open project_dir", proj, errno);
    }
    /* exceptions are best-effort for tooling; project fence is what matters */
    return;
  }

  struct stat st;
  if (fstat(fd, &st) == 0 && !S_ISDIR(st.st_mode) && allow_parent_widen) {
    /* POCFIX10 support: for leaf files/char devices (e.g. the listed /dev devices we add below), the open fd is not a dir.
     * kernel landlock PATH_BENEATH requires parent_fd to be a directory. Switch to the target's parent dir fd.
     * This lets us use literal device paths in the source add_rule calls (as required) without a broad /dev rule.
     * (Effect grants the /dev subtree containing the devices, but source uses exact listed char devices only.)
     */
    close(fd);
    char parent[PATH_MAX];
    strncpy(parent, path, sizeof(parent) - 1);
    parent[sizeof(parent) - 1] = '\0';
    char *last_slash = strrchr(parent, '/');
    if (last_slash && last_slash != parent) {
      *last_slash = '\0';
    } else {
      strcpy(parent, "/");
    }
    fd = open_path(parent);
    if (fd < 0) {
      return; /* best effort for exceptions */
    }
  }

  struct landlock_path_beneath_attr rule = {
    .allowed_access = access,
    .parent_fd = fd,
  };
  if (landlock_add_rule(rs, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) {
    close(fd);
    fail("landlock_add_rule", proj, errno);
  }
  close(fd);
}

static void add_rule(int rs, const char *path, uint64_t access, const char *proj, const char *label) {
  add_rule_ex(rs, path, access, proj, label, true);
}

/* W1 CRITICAL: scrub all inherited fds >=3 before execvp. Landlock only controls new opens, not writes to already-open fds.
 * close_range(3, ~0U, 0) preferred; fallback to /proc/self/fd scan keeping only 0/1/2.
 */
static void scrub_inherited_fds(void) {
  int cr = -1;
#ifdef __NR_close_range
  cr = syscall(__NR_close_range, 3U, ~0U, 0U);
#endif
  if (cr == 0) return;

  /* fallback */
  DIR *d = opendir("/proc/self/fd");
  if (d != NULL) {
    struct dirent *ent;
    while ((ent = readdir(d)) != NULL) {
      if (ent->d_name[0] == '.') continue;
      int fd = atoi(ent->d_name);
      if (fd >= 3) close(fd);
    }
    closedir(d);
    return;
  }
  /* last resort */
  for (int fd = 3; fd < 4096; fd++) close(fd);
}

/* R7.26/B22b + sol decision-4 (from-scratch scaffolding): the project-write grant has TWO
 * launch-time modes, selected once at fenced-session launch by whether a literal `north-star.md`
 * entry exists directly in the (already realpath()-canonicalized) project root. The root fd is
 * opened ONCE with O_PATH|O_CLOEXEC|O_DIRECTORY and the SAME fd is reused for both the inspection
 * (fstatat) and any rule add, so there is no path-replacement (TOCTOU) gap between check and grant.
 *
 *   PROTECTED-ROOT MODE  (fstatat(root_fd, "north-star.md", AT_SYMLINK_NOFOLLOW) succeeds — any
 *   inode type, INCLUDING a symlink): the historical R7.26/B22b per-child policy is retained, but the
 *   root is enumerated NO-FOLLOW from the pinned fd (openat(root_fd,".")→fdopendir; each child
 *   openat()'d O_PATH|O_NOFOLLOW; the rule is added on that child fd, never by path). We grant rw on
 *   every EXISTING direct child of the project root EXCEPT north-star.md (denial by omission — Landlock
 *   has no per-file deny, so the only way to keep a specific file non-writable is to never issue a rule
 *   that covers it; its READ access is still fully covered by the separate root-ro rule added in
 *   main()). Every other top-level entry (src, plan, tools, package.json, ...) keeps the exact recursive
 *   rw it had under the old single blanket rule, since PATH_BENEATH on an existing directory still
 *   cascades to everything created under it later. A top-level SYMLINK child is SKIPPED entirely (no
 *   rule): the OLD stat(path)+add_rule(path)→open_path(path) loop FOLLOWED such a symlink (stat follows;
 *   open_path has no O_NOFOLLOW) and granted its OUTSIDE target hierarchy — a real escape, made plantable
 *   by scaffold mode's new MAKE_SYM-on-root, so the no-follow enumeration is a load-bearing part of the
 *   fix, not a nicety. In this mode the known tradeoff holds: a brand-new top-level entry (a sibling of
 *   north-star.md that did not exist at launch) is NOT creatable, and existing top-level FILES cannot be
 *   deleted/renamed, since either would require a directory-scope rule on the root that would also
 *   re-cover north-star.md. New files/dirs within any existing top-level DIRECTORY entry (src, plan, ...)
 *   are unaffected. AT_SYMLINK_NOFOLLOW makes a dangling OR live root north-star.md symlink count as
 *   present, so a symlink can never trick the check into scaffold mode.
 *
 *   SCAFFOLD MODE  (fstatat returns exactly ENOENT — no root north-star.md at launch): a from-scratch
 *   project (only pre-created Helm dirs) must be able to create its own top-level scaffold — mkdir
 *   src/, write package.json, etc. We add ONE LANDLOCK_RULE_PATH_BENEATH directly on the root_fd with
 *   WRITE-SIDE bits ONLY (WRITE_FILE|TRUNCATE|MAKE_REG|MAKE_DIR|REMOVE_FILE|REMOVE_DIR|MAKE_SYM|REFER
 *   — deliberately NO READ_FILE/READ_DIR/EXECUTE, so the strict read profile is unaffected, and NO
 *   MAKE_CHAR/BLOCK/FIFO/SOCK, which are not in Helm's project rw mask). This grants top-level
 *   create/remove/rename plus recursive writes through entries created after launch. Reads still come
 *   only from the root/default read rules. This is a LAUNCH-TIME policy decision: Landlock has no
 *   atomic "allow the root unless this filename ever exists" predicate, so a root north-star.md
 *   created LATER in the worker's lifetime would be writable — Helm must therefore create authoritative
 *   root contracts before worker launch (#25 removes this lifecycle ambiguity by moving cycle artifacts
 *   outside the writable project root). Only ENOENT selects this mode; every OTHER fstatat/open/add-rule
 *   error calls fail(...) — absence is never inferred and the command is never exec'd unfenced.
 *
 * The other three governed docs (under plan/<cycle>/: og-requirements.md, plan.md, topology.yaml)
 * are NOT excluded here in either mode: they are siblings inside a directory (plan/<cycle>) that must
 * stay open to new-directory creation (every batch creates its own batch dir there), and Landlock
 * cannot grant "create new siblings here" without also covering the existing siblings in the same
 * directory. Those three are enforced in userspace instead — see src/services/doc-path-guard.ts
 * (startGovernedDocGuard), wired at fenced-session launch. Full analysis in
 * plan/c01-agent-studio-rebuild/batch-B22b/changes.md.
 *
 * FIX1 (B22b-fix1, protected-root mode only): top-level REGULAR FILES (package.json, .env, changes.md,
 * helm.db, ...) are granted a file-scoped rw rule (READ_FILE|WRITE_FILE|TRUNCATE) pinned to the file's
 * own O_PATH|O_NOFOLLOW fd — never the project-root parent (which would re-cover north-star.md). The
 * original hole was the shared POCFIX10 add_rule(), whose non-dir fallback widened to PATH_BENEATH(root,
 * rw), silently re-covering north-star.md; the no-follow fd-pinned add_rule below covers both that FIX1
 * case and the top-level-symlink escape without any add_rule/add_rule_ex path reopen. */
static void grant_project_rw_excluding_root_governed(int rs, const char *resolved, uint64_t rw) {
  uint64_t file_rw_full = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;
  /* Scaffold-mode grant: WRITE-SIDE bits ONLY. No READ_FILE/READ_DIR/EXECUTE (strict read profile
   * stays authoritative); no MAKE_CHAR/BLOCK/FIFO/SOCK (not in Helm's project rw mask). */
  const uint64_t project_write = LANDLOCK_ACCESS_FS_WRITE_FILE |
                                 LANDLOCK_ACCESS_FS_TRUNCATE |
                                 LANDLOCK_ACCESS_FS_MAKE_REG |
                                 LANDLOCK_ACCESS_FS_MAKE_DIR |
                                 LANDLOCK_ACCESS_FS_REMOVE_FILE |
                                 LANDLOCK_ACCESS_FS_REMOVE_DIR |
                                 LANDLOCK_ACCESS_FS_MAKE_SYM |
                                 LANDLOCK_ACCESS_FS_REFER;

  /* Open the canonical root ONCE; the same fd is used for inspection AND the scaffold rule
   * (no path re-open — closes the TOCTOU path-replacement gap). */
  int root_fd = open(resolved, O_PATH | O_CLOEXEC | O_DIRECTORY);
  if (root_fd < 0) fail("open canonical project root", resolved, errno);

  struct stat north_star_st;
  if (fstatat(root_fd, "north-star.md", &north_star_st, AT_SYMLINK_NOFOLLOW) != 0) {
    int check_errno = errno;
    if (check_errno != ENOENT) {
      close(root_fd);
      fail("fstatat project-root north-star.md", resolved, check_errno);
    }

    /* SCAFFOLD MODE: no root north-star.md at launch → grant write-only creation on the root fd. */
    struct landlock_path_beneath_attr root_write_rule = {
      .allowed_access = project_write,
      .parent_fd = root_fd,
    };
    if (landlock_add_rule(rs, LANDLOCK_RULE_PATH_BENEATH, &root_write_rule, 0)) {
      int add_errno = errno;
      close(root_fd);
      fail("landlock_add_rule(project-root scaffold write)", resolved, add_errno);
    }
    close(root_fd);
    return;
  }

  /* PROTECTED-ROOT MODE: root north-star.md exists → retain the per-child policy, but bind every rule
   * to a NO-FOLLOW fd and reuse the already-open root_fd (never close it before the enumeration). The
   * old stat(path)+add_rule(path)→open_path(path) sequence FOLLOWED a top-level symlink (stat follows;
   * open_path has no O_NOFOLLOW), so a launch-time `evil -> /outside` symlink planted in the root would
   * be granted recursive rw on the OUTSIDE target — a real escape (worsened by scaffold mode's new
   * MAKE_SYM-on-root primitive, which lets a worker plant it before a protected relaunch). Here every
   * child is openat()'d O_PATH|O_NOFOLLOW from the pinned dir fd and a symlink child is SKIPPED (still
   * readable via the ro rule; its target is never granted). No child is ever opened by path. */
  int scan_fd = openat(root_fd, ".", O_RDONLY | O_CLOEXEC | O_DIRECTORY);
  if (scan_fd < 0) {
    int scan_errno = errno;
    close(root_fd);
    fail("openat canonical project root for enumeration", resolved, scan_errno);
  }
  DIR *d = fdopendir(scan_fd); /* takes ownership of scan_fd */
  if (!d) {
    int dir_errno = errno;
    close(scan_fd);
    close(root_fd);
    fail("fdopendir(project_dir)", resolved, dir_errno);
  }
  for (;;) {
    errno = 0;
    struct dirent *ent = readdir(d);
    if (ent == NULL) {
      int read_errno = errno;
      if (read_errno != 0) {
        closedir(d);
        close(root_fd);
        fail("readdir(project_dir)", resolved, read_errno);
      }
      break;
    }
    if (strcmp(ent->d_name, ".") == 0 || strcmp(ent->d_name, "..") == 0) continue;
    if (strcmp(ent->d_name, "north-star.md") == 0) continue;

    int child_fd = openat(dirfd(d), ent->d_name, O_PATH | O_CLOEXEC | O_NOFOLLOW);
    if (child_fd < 0) {
      int child_errno = errno;
      closedir(d);
      close(root_fd);
      fail("openat project-root child (no-follow)", resolved, child_errno);
    }

    struct stat st;
    if (fstat(child_fd, &st) != 0) {
      int stat_errno = errno;
      close(child_fd);
      closedir(d);
      close(root_fd);
      fail("fstat project-root child", resolved, stat_errno);
    }
    if (S_ISLNK(st.st_mode)) {
      close(child_fd);
      continue; /* readable through the ro policy; never grant its target */
    }

    uint64_t child_access;
    if (S_ISDIR(st.st_mode)) {
      child_access = rw;
    } else if (S_ISREG(st.st_mode)) {
      /* FIX1: file-scoped rule (READ_FILE|WRITE_FILE|TRUNCATE) pinned to this exact file's no-follow
       * fd — never widened to the project-root parent (which would re-cover north-star.md). */
      child_access = file_rw_full;
    } else {
      close(child_fd);
      closedir(d);
      close(root_fd);
      fail("unsupported project-root child inode type", resolved, EINVAL);
    }

    struct landlock_path_beneath_attr child_rule = {
      .allowed_access = child_access,
      .parent_fd = child_fd,
    };
    if (landlock_add_rule(rs, LANDLOCK_RULE_PATH_BENEATH, &child_rule, 0)) {
      int add_errno = errno;
      close(child_fd);
      closedir(d);
      close(root_fd);
      fail("landlock_add_rule(project-root child)", resolved, add_errno);
    }
    close(child_fd);
  }
  closedir(d);
  close(root_fd);
}

/* W3 MED: canonicalize + reject too-shallow / relative / ancestor project_dir (fail-closed) */
static bool is_too_shallow(const char *p) {
  if (!p || !*p) return true;
  if (strcmp(p, "/") == 0 || strcmp(p, "/tmp") == 0 || strcmp(p, "/home") == 0) return true;
  /* reject the user's real home dir exactly */
  struct passwd *pw = getpwuid(getuid());
  if (pw && pw->pw_dir && strcmp(p, pw->pw_dir) == 0) return true;
  /* also reject any exact /home/<user> (even if pw lookup differs) */
  if (strncmp(p, "/home/", 6) == 0) {
    const char *rest = p + 6;
    if (strchr(rest, '/') == NULL) return true; /* exactly /home/xxx */
  }
  return false;
}

/* B-ISO1: strict-profile ro allowlist — colon-separated ABSOLUTE paths from
 * HELM_SANDBOX_RO_ALLOW, each canonicalized with realpath(3) and granted read+exec.
 * Directory entries get the full ro mask (READ_FILE|READ_DIR|EXECUTE); non-directory entries
 * get the file-safe subset (READ_FILE|EXECUTE) pinned to the file's OWN fd — never widened to
 * the parent dir (the POCFIX10 parent-widen fallback would silently over-grant the file's
 * siblings, the same class of hole FIX1/B22b-fix1 closed on the write side).
 * EVERY entry is mandatory-valid and FAILS CLOSED with a message naming the entry: a
 * silently-skipped entry would either boot a seat that cannot exec its CLI (confusing hang) or
 * leave the caller believing a path is granted when it is not (silent policy drift). */
static void add_strict_allow_rules(int rs, const char *list, uint64_t ro_dir, const char *proj) {
  /* sol review REQUIRED #2: strtok_r silently COLLAPSES leading/trailing/repeated ':' separators,
   * so "/usr::/etc", ":/usr", "/usr:" would pass with the empty token dropped — a caller policy
   * mistake that must NOT be papered over. An empty entry in a colon-separated list is exactly a
   * leading ':', a trailing ':', or a "::" run; refuse fail-closed naming the bad value BEFORE
   * strtok_r destroys the copy. (An all-separators value is also caught here.) */
  size_t n = strlen(list);
  bool has_empty_entry = (n == 0) || (list[0] == ':') || (list[n - 1] == ':') || (strstr(list, "::") != NULL);
  if (has_empty_entry) {
    char eb[PATH_MAX + 96];
    snprintf(eb, sizeof(eb),
             "HELM_SANDBOX_RO_ALLOW contains an empty entry (leading/trailing/repeated ':'): '%s'",
             list);
    fail(eb, proj, 0);
  }

  char *copy = strdup(list);
  if (copy == NULL) {
    fail("strdup(HELM_SANDBOX_RO_ALLOW)", proj, errno);
  }
  int granted = 0;
  char *saveptr = NULL;
  char op[PATH_MAX + 96];
  for (char *tok = strtok_r(copy, ":", &saveptr); tok != NULL; tok = strtok_r(NULL, ":", &saveptr)) {
    if (tok[0] != '/') {
      snprintf(op, sizeof(op), "strict ro-allowlist entry must be an absolute path: '%s'", tok);
      fail(op, proj, 0);
    }
    char rp[PATH_MAX];
    if (realpath(tok, rp) == NULL) {
      /* fail closed: a nonexistent allowlist path is a caller policy error, never skipped */
      snprintf(op, sizeof(op), "strict ro-allowlist entry does not resolve: realpath('%s')", tok);
      fail(op, proj, errno);
    }
    struct stat st;
    if (stat(rp, &st) != 0) {
      snprintf(op, sizeof(op), "stat strict ro-allowlist entry '%s'", rp);
      fail(op, proj, errno);
    }
    uint64_t access = S_ISDIR(st.st_mode)
        ? ro_dir
        : (LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE);
    int fd = open_path(rp);
    if (fd < 0) {
      snprintf(op, sizeof(op), "open strict ro-allowlist entry '%s'", rp);
      fail(op, proj, errno);
    }
    struct landlock_path_beneath_attr rule = {
      .allowed_access = access,
      .parent_fd = fd,
    };
    if (landlock_add_rule(rs, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) {
      int add_errno = errno;
      close(fd);
      snprintf(op, sizeof(op), "landlock_add_rule(strict ro-allowlist '%s')", rp);
      fail(op, proj, add_errno);
    }
    close(fd);
    granted++;
  }
  free(copy);
  if (granted == 0) {
    fail("strict ro-allowlist has zero entries (HELM_SANDBOX_RO_ALLOW contains only separators)", proj, 0);
  }
}

/* B1 (R2.12/F6): HELM_SANDBOX_WRITE_ALLOW=<abs1>:<abs2>:... — extra write-fence exceptions, same
 * documented tooling-exception class as /tmp and the $HOME dot-dirs (NOT a project-write hole).
 * Mirrors add_strict_allow_rules' fail-closed empty-entry detection (leading/trailing/repeated ':'
 * never silently collapsed by strtok_r). Each entry is ensure_dir()'d (a run root may not exist yet
 * at first boot, same as the /tmp/home-dot-dir exceptions) then granted via the shared add_rule()
 * helper with the caller-supplied access mask (the SAME `exc` bits used for /tmp — full rw in the
 * default profile, write-only in strict, per the strict-mode audit on the /tmp grant in main()). */
static void add_write_allow_rules(int rs, const char *list, uint64_t access, const char *proj) {
  size_t n = strlen(list);
  bool has_empty_entry = (n == 0) || (list[0] == ':') || (list[n - 1] == ':') || (strstr(list, "::") != NULL);
  if (has_empty_entry) {
    char eb[PATH_MAX + 96];
    snprintf(eb, sizeof(eb),
             "HELM_SANDBOX_WRITE_ALLOW contains an empty entry (leading/trailing/repeated ':'): '%s'",
             list);
    fail(eb, proj, 0);
  }

  char *copy = strdup(list);
  if (copy == NULL) {
    fail("strdup(HELM_SANDBOX_WRITE_ALLOW)", proj, errno);
  }
  int granted = 0;
  char *saveptr = NULL;
  char op[PATH_MAX + 96];
  for (char *tok = strtok_r(copy, ":", &saveptr); tok != NULL; tok = strtok_r(NULL, ":", &saveptr)) {
    if (tok[0] != '/') {
      snprintf(op, sizeof(op), "HELM_SANDBOX_WRITE_ALLOW entry must be an absolute path: '%s'", tok);
      fail(op, proj, 0);
    }
    ensure_dir(tok);
    add_rule(rs, tok, access, proj, "write-allow");
    granted++;
  }
  free(copy);
  if (granted == 0) {
    fail("HELM_SANDBOX_WRITE_ALLOW has zero entries (contains only separators)", proj, 0);
  }
}

static bool has_control_chars(const char *s) {
  for (const unsigned char *p = (const unsigned char *)s; *p; ++p) {
    if (*p < 0x20 || *p == 0x7f) return true;
  }
  return false;
}

/* B7: fail-closed canonicalization for one GIT_* path entry. Absolute, control-char-free, must
 * already exist (no ensure_dir), and exactly canonical — the raw value must equal its own
 * realpath(): this single comparison rejects relative components ('.'/'..'), a trailing slash,
 * repeated slashes, AND any symlink anywhere on the path (a symlinked entry's realpath()
 * necessarily differs from the raw string, since the target path is never textually identical to
 * a path that names it via a link). `what` names the offending source (env var or list entry) in
 * the failure message; the canonical form is copied into `resolved`. */
static void resolve_git_entry(const char *raw, const char *what, char *resolved, size_t resolved_sz, const char *proj) {
  char op[PATH_MAX + 160];
  if (raw == NULL || raw[0] == '\0') {
    snprintf(op, sizeof(op), "%s must not be empty", what);
    fail(op, proj, 0);
  }
  if (raw[0] != '/') {
    snprintf(op, sizeof(op), "%s must be an absolute path (got '%s')", what, raw);
    fail(op, proj, 0);
  }
  if (has_control_chars(raw)) {
    snprintf(op, sizeof(op), "%s contains control characters", what);
    fail(op, proj, 0);
  }
  if (strlen(raw) >= resolved_sz) {
    snprintf(op, sizeof(op), "%s exceeds PATH_MAX", what);
    fail(op, proj, 0);
  }
  char rp[PATH_MAX];
  if (realpath(raw, rp) == NULL) {
    snprintf(op, sizeof(op), "%s does not resolve (must already exist; no ensure_dir): realpath('%s')", what, raw);
    fail(op, proj, errno);
  }
  if (strcmp(raw, rp) != 0) {
    snprintf(op, sizeof(op),
             "%s is not canonical (relative components, a trailing slash, or a symlink): '%s' != realpath '%s'",
             what, raw, rp);
    fail(op, proj, 0);
  }
  if (is_too_shallow(rp)) {
    snprintf(op, sizeof(op), "%s resolves to a forbidden shallow path: '%s'", what, rp);
    fail(op, proj, 0);
  }
  strncpy(resolved, rp, resolved_sz - 1);
  resolved[resolved_sz - 1] = '\0';
}

/* True iff `candidate` is a STRICT descendant of `anchor` (never equal — an entry naming the
 * common-dir root itself is refused this way): candidate begins with anchor + '/'. Both must
 * already be canonical absolute paths (post resolve_git_entry). Comparing on "anchor + '/'"
 * rather than a bare prefix avoids the classic sibling bug (anchor `/a/b` must not match
 * candidate `/a/bc`). */
static bool is_strict_descendant(const char *anchor, const char *candidate) {
  size_t alen = strlen(anchor);
  if (strncmp(candidate, anchor, alen) != 0) return false;
  return candidate[alen] == '/';
}

/* B7: adds one PATH_BENEATH rule for a GIT_* entry, fd-pinned via O_NOFOLLOW (never widened to the
 * parent — no ensure_dir, no POCFIX10 parent-widen). A directory target gets `dir_access`; a
 * regular-file target gets the file-safe `file_access` subset (directory-only rights such as
 * MAKE_REG/MAKE_DIR/REMOVE_FILE/REMOVE_DIR/MAKE_SYM/REFER/READ_DIR would EINVAL on a non-dir fd).
 * Any other inode type (symlink already excluded by resolve_git_entry's canonical check; a device,
 * fifo, or socket left over from something else) refuses fail-closed rather than guessing which
 * mask applies. */
static void add_git_rule(int rs, const char *resolved, uint64_t dir_access, uint64_t file_access, const char *what, const char *proj) {
  char op[PATH_MAX + 128];
  int fd = open(resolved, O_PATH | O_CLOEXEC | O_NOFOLLOW);
  if (fd < 0) {
    snprintf(op, sizeof(op), "open %s '%s'", what, resolved);
    fail(op, proj, errno);
  }
  struct stat st;
  if (fstat(fd, &st) != 0) {
    int e = errno;
    snprintf(op, sizeof(op), "fstat %s '%s'", what, resolved);
    close(fd);
    fail(op, proj, e);
  }
  uint64_t access;
  if (S_ISDIR(st.st_mode)) {
    access = dir_access;
  } else if (S_ISREG(st.st_mode)) {
    access = file_access;
  } else {
    close(fd);
    snprintf(op, sizeof(op), "%s '%s' is neither a directory nor a regular file", what, resolved);
    fail(op, proj, 0);
  }
  struct landlock_path_beneath_attr rule = { .allowed_access = access, .parent_fd = fd };
  if (landlock_add_rule(rs, LANDLOCK_RULE_PATH_BENEATH, &rule, 0)) {
    int e = errno;
    close(fd);
    snprintf(op, sizeof(op), "landlock_add_rule(%s '%s')", what, resolved);
    fail(op, proj, e);
  }
  close(fd);
}

/* B7 (R4.1/R4.3): wires the cycle-scoped git capability — see the file-header doc comment for the
 * four classes. `rw` is the caller's full read+write class (same variable used for the project
 * grant); this function derives its own file-safe and OBJ-narrowed variants locally so it stays
 * fully self-contained, mirroring grant_project_rw_excluding_root_governed above. */
static void add_cycle_git_rules(int rs, uint64_t rw, const char *proj) {
  const char *ro_raw = getenv("HELM_SANDBOX_GIT_RO");
  if (ro_raw == NULL || ro_raw[0] == '\0') {
    /* Absent GIT_RO must mean NO git capability at all — a lone ADMIN/REF_RW/OBJ with no anchor
     * to validate against is a caller bug, never silently ignored (the four classes travel
     * together; see B8's "1 RO + 1 ADMIN + 2 REF_RW + 1 OBJ, never a subset" contract). */
    const char *others[] = { "HELM_SANDBOX_GIT_ADMIN", "HELM_SANDBOX_GIT_REF_RW", "HELM_SANDBOX_GIT_OBJ" };
    for (size_t i = 0; i < sizeof(others) / sizeof(others[0]); i++) {
      const char *v = getenv(others[i]);
      if (v != NULL && v[0] != '\0') {
        char op[192];
        snprintf(op, sizeof(op), "%s set without HELM_SANDBOX_GIT_RO — the git capability classes must travel together", others[i]);
        fail(op, proj, 0);
      }
    }
    return;
  }

  uint64_t ro = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_EXECUTE;
  uint64_t file_rw_full = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_TRUNCATE;

  char git_ro[PATH_MAX];
  resolve_git_entry(ro_raw, "HELM_SANDBOX_GIT_RO", git_ro, sizeof(git_ro), proj);
  add_git_rule(rs, git_ro, ro, LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_EXECUTE, "HELM_SANDBOX_GIT_RO", proj);

  const char *admin_raw = getenv("HELM_SANDBOX_GIT_ADMIN");
  const char *refrw_raw = getenv("HELM_SANDBOX_GIT_REF_RW");
  const char *obj_raw = getenv("HELM_SANDBOX_GIT_OBJ");
  if (admin_raw == NULL || admin_raw[0] == '\0') fail("HELM_SANDBOX_GIT_ADMIN is required once HELM_SANDBOX_GIT_RO is set", proj, 0);
  if (refrw_raw == NULL || refrw_raw[0] == '\0') fail("HELM_SANDBOX_GIT_REF_RW is required once HELM_SANDBOX_GIT_RO is set", proj, 0);
  if (obj_raw == NULL || obj_raw[0] == '\0') fail("HELM_SANDBOX_GIT_OBJ is required once HELM_SANDBOX_GIT_RO is set", proj, 0);

  /* GIT_ADMIN: exactly <GIT_RO>/worktrees/<id> — a strict descendant of GIT_RO, refusing
   * <GIT_RO>/worktrees itself and anything that is not a DIRECT child of it (a peer cycle's admin
   * dir, or a nested path underneath one). */
  char admin[PATH_MAX];
  resolve_git_entry(admin_raw, "HELM_SANDBOX_GIT_ADMIN", admin, sizeof(admin), proj);
  if (!is_strict_descendant(git_ro, admin)) {
    fail("HELM_SANDBOX_GIT_ADMIN must be a strict descendant of HELM_SANDBOX_GIT_RO", proj, 0);
  }
  char worktrees_dir[PATH_MAX];
  int wn = snprintf(worktrees_dir, sizeof(worktrees_dir), "%s/worktrees", git_ro);
  if (wn < 0 || (size_t)wn >= sizeof(worktrees_dir)) {
    fail("HELM_SANDBOX_GIT_RO path too long to derive its worktrees dir", proj, 0);
  }
  if (strcmp(admin, worktrees_dir) == 0) {
    fail("HELM_SANDBOX_GIT_ADMIN must not name <common>/worktrees itself", proj, 0);
  }
  const char *admin_slash = strrchr(admin, '/');
  size_t admin_parent_len = admin_slash ? (size_t)(admin_slash - admin) : 0;
  if (admin_parent_len != strlen(worktrees_dir) || strncmp(admin, worktrees_dir, admin_parent_len) != 0) {
    fail("HELM_SANDBOX_GIT_ADMIN must be a DIRECT child of <common>/worktrees", proj, 0);
  }
  add_git_rule(rs, admin, rw, file_rw_full, "HELM_SANDBOX_GIT_ADMIN", proj);

  /* GIT_REF_RW: colon-separated list (B8 emits exactly 2 — the namespaced ref dir + its reflog
   * mirror), each a strict descendant of GIT_RO. Mirrors add_write_allow_rules' fail-closed
   * empty-entry detection (leading/trailing/repeated ':' never silently collapsed by strtok_r). */
  {
    size_t rlen = strlen(refrw_raw);
    bool has_empty_entry = (rlen == 0) || (refrw_raw[0] == ':') || (refrw_raw[rlen - 1] == ':') || (strstr(refrw_raw, "::") != NULL);
    if (has_empty_entry) {
      char op[PATH_MAX + 96];
      snprintf(op, sizeof(op), "HELM_SANDBOX_GIT_REF_RW contains an empty entry (leading/trailing/repeated ':'): '%s'", refrw_raw);
      fail(op, proj, 0);
    }
    char *copy = strdup(refrw_raw);
    if (copy == NULL) fail("strdup(HELM_SANDBOX_GIT_REF_RW)", proj, errno);
    int granted = 0;
    char *saveptr = NULL;
    for (char *tok = strtok_r(copy, ":", &saveptr); tok != NULL; tok = strtok_r(NULL, ":", &saveptr)) {
      char resolved[PATH_MAX];
      resolve_git_entry(tok, "HELM_SANDBOX_GIT_REF_RW entry", resolved, sizeof(resolved), proj);
      if (!is_strict_descendant(git_ro, resolved)) {
        free(copy);
        fail("HELM_SANDBOX_GIT_REF_RW entry must be a strict descendant of HELM_SANDBOX_GIT_RO", proj, 0);
      }
      add_git_rule(rs, resolved, rw, file_rw_full, "HELM_SANDBOX_GIT_REF_RW", proj);
      granted++;
    }
    free(copy);
    if (granted == 0) fail("HELM_SANDBOX_GIT_REF_RW has zero entries (contains only separators)", proj, 0);
  }

  /* GIT_OBJ: <common>/objects, NARROWER mask than the other three classes — create-only.
   * Empirically derived minimum, starting from zero and adding one candidate bit at a time
   * against a real repo with fixtures deliberately placed OUTSIDE /tmp and every $HOME
   * tooling-exception dir (those get their own blanket write grants that would mask the very
   * enforcement under test): plan/cycle-branch-lifecycle/validation/B7-impl-a1/obj-mask-derivation.md.
   * The true minimum is MAKE_REG | MAKE_DIR | WRITE_FILE:
   *   - MAKE_REG: create the new loose-object file itself (both the temp file git writes and its
   *     final `objects/<2-hex>/<38-hex>` name — confirmed necessary: MAKE_DIR+WRITE_FILE alone
   *     fails with "adding files failed").
   *   - MAKE_DIR: create a new 2-hex-prefix subdirectory when an object's prefix hasn't been seen
   *     before (confirmed necessary: MAKE_REG+WRITE_FILE alone fails the same way; a passing run's
   *     prefix-dir count rises by exactly the number of new objects written).
   *   - WRITE_FILE: write the temp file's content before it is renamed into place (confirmed
   *     necessary: MAKE_REG+MAKE_DIR alone fails — creating-for-write is NOT covered by MAKE_REG
   *     alone on this kernel).
   * REFER is DELIBERATELY OMITTED — empirically proven unnecessary, not merely untried: 5/5 stable
   * passes on MAKE_REG|MAKE_DIR|WRITE_FILE alone, and adding REFER on top changes nothing. This
   * matches Landlock's own rename semantics — the temp file and its final name are both reparented
   * within the exact same granted `objects/` hierarchy (no rule boundary is crossed), so the
   * kernel's REFER escalation check never triggers for this rename. Any FUTURE git behavior that
   * needs REFER here (e.g. a temp dir outside `objects/`) would surface as an immediate, obvious
   * EACCES on a real commit — not a silent gap — so it is left out per the "never defaulted in"
   * instruction. TRUNCATE, REMOVE_FILE, REMOVE_DIR and MAKE_SYM are likewise OMITTED (not tested
   * for necessity — they are the deliberate negative: a pre-existing object reachable from base or
   * a peer branch must be neither truncatable nor unlinkable by this seat). Reads of the object
   * store (loose objects, pack files) are covered by the GIT_RO ancestor grant, not by this class. */
  char obj[PATH_MAX];
  resolve_git_entry(obj_raw, "HELM_SANDBOX_GIT_OBJ", obj, sizeof(obj), proj);
  if (!is_strict_descendant(git_ro, obj)) {
    fail("HELM_SANDBOX_GIT_OBJ must be a strict descendant of HELM_SANDBOX_GIT_RO", proj, 0);
  }
  uint64_t obj_dir_access = LANDLOCK_ACCESS_FS_MAKE_REG | LANDLOCK_ACCESS_FS_MAKE_DIR |
                             LANDLOCK_ACCESS_FS_WRITE_FILE;
  uint64_t obj_file_access = LANDLOCK_ACCESS_FS_WRITE_FILE;
  add_git_rule(rs, obj, obj_dir_access, obj_file_access, "HELM_SANDBOX_GIT_OBJ", proj);
}

int main(int argc, char **argv) {
  if (argc < 3) {
    fprintf(stderr, "usage: %s <project_dir> <cmd> [args...]\n", argv[0]);
    return 1;
  }
  const char *proj = argv[1];
  const char *cmd = argv[2];

  /* Minimal W3 iter2 fix: reject NON-ABSOLUTE project_dir BEFORE any rules/realpath/ensure.
     Helm launch paths ALWAYS pass absolute (from projects table); relative like '.' (from cd to parent) now fail-closed early.
     Keep realpath + is_too_shallow for canonical + shallow ancestor cases on absolute inputs. */
  if (proj[0] != '/') {
    fprintf(stderr, "helm-sandbox: project_dir must be an absolute path (got '%s')\n", proj);
    return 1;
  }

  /* B-ISO1: opt-in strict read profile — env-driven so the argv contract (<project_dir> <cmd>...)
   * is unchanged. Fail-closed security state machine (sol review REQUIRED #3): the profile selector
   * is EXACTLY one of three states, with NO silent fall-through —
   *   - absent OR empty        -> legacy default profile (read-all), byte-identical behavior;
   *   - exact value "strict"   -> strict read profile;
   *   - any other non-empty    -> REFUSE execution (a typo like "stict" must never silently select
   *                               read-all — that would turn a typo into a security bypass).
   * Validated BEFORE any rules/side effects. */
  const char *ro_profile = getenv("HELM_SANDBOX_RO_PROFILE");
  bool profile_set = (ro_profile != NULL && ro_profile[0] != '\0');
  bool strict = (profile_set && strcmp(ro_profile, "strict") == 0);
  if (profile_set && !strict) {
    char pbuf[256];
    snprintf(pbuf, sizeof(pbuf),
             "HELM_SANDBOX_RO_PROFILE unknown value '%s' (must be unset/empty for default read-all, or exactly 'strict')",
             ro_profile);
    fail(pbuf, proj, 0);
  }
  const char *ro_allow = getenv("HELM_SANDBOX_RO_ALLOW");
  if (strict && (ro_allow == NULL || ro_allow[0] == '\0')) {
    fail("HELM_SANDBOX_RO_PROFILE=strict requires a non-empty HELM_SANDBOX_RO_ALLOW (colon-separated absolute read+exec paths)", proj, 0);
  }

  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) {
    fail("prctl(PR_SET_NO_NEW_PRIVS)", proj, errno);
  }

  /* W3: ensure exists so realpath succeeds, then canonicalize + fail-closed on shallow/relative/ancestor */
  ensure_dir(proj);
  char resolved[PATH_MAX];
  if (realpath(proj, resolved) == NULL) {
    fail("realpath(project_dir)", proj, errno);
  }
  if (is_too_shallow(resolved)) {
    fail("project_dir too shallow or forbidden (reject / /home/<user> /tmp or relative ancestor)", resolved, 0);
  }

  /* ABI v4 rights: ro (read+exec) baseline + full rw (writes + REFER + TRUNCATE + creates) for fenced paths */
  uint64_t ro = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_EXECUTE;
  uint64_t rw = ro |
                LANDLOCK_ACCESS_FS_WRITE_FILE |
                LANDLOCK_ACCESS_FS_TRUNCATE |
                LANDLOCK_ACCESS_FS_MAKE_REG |
                LANDLOCK_ACCESS_FS_MAKE_DIR |
                LANDLOCK_ACCESS_FS_REMOVE_FILE |
                LANDLOCK_ACCESS_FS_REMOVE_DIR |
                LANDLOCK_ACCESS_FS_MAKE_SYM |
                LANDLOCK_ACCESS_FS_REFER;
  /* POCFIX10 fix (GATE-REOPEN): for char devices (/dev/*), use file-only mask (READ_FILE|WRITE_FILE).
     Full rw includes MAKE_DIR etc which are invalid for non-dir char device fds -> landlock_add_rule EINVAL (fails closed).
     Devices only need read/write; no creates/trunc/etc needed. */
  uint64_t file_rw = LANDLOCK_ACCESS_FS_READ_FILE | LANDLOCK_ACCESS_FS_WRITE_FILE;

  struct landlock_ruleset_attr attr = { .handled_access_fs = ro | rw };
  int rs = landlock_create_ruleset(&attr, sizeof(attr), 0);
  if (rs < 0) {
    fail("landlock_create_ruleset (need kernel with Landlock ABI v4+ support)", proj, errno);
  }

  if (strict) {
    /* B-ISO1 strict: NO blanket root-ro rule. Reads/execs come ONLY from the enumerated
     * HELM_SANDBOX_RO_ALLOW entries (fail-closed per entry) ... */
    add_strict_allow_rules(rs, ro_allow, ro, resolved);
    /* ... plus the project subtree, which must stay fully READABLE in strict mode. The per-entry
     * rw rules below cover the project's children, but NOT the project ROOT dir itself (ls of the
     * root) and NOT north-star.md (deliberately omitted from the rw grant — R7.26/B22b); both were
     * previously read-covered by the root-ro rule. A ro rule on the root restores exactly that
     * read coverage without granting ANY write bit, so the north-star.md write fence is unchanged. */
    add_rule(rs, resolved, ro, resolved, "project-ro");
  } else {
    /* ro on / (covers system libs + all sibling project dirs for cross-project READ) */
    add_rule(rs, "/", ro, resolved, "root-ro");
  }

  /* rw on the project dir's entries (the fence target) — use the canonical resolved path.
   * R7.26/B22b: north-star.md is excluded by omission; see grant_project_rw_excluding_root_governed. */
  ensure_dir(resolved);
  grant_project_rw_excluding_root_governed(rs, resolved, rw);

  /* documented rw exceptions (tooling viability only; still kernel-scoped, not a project-write hole)
   *
   * B-ISO1 strict-mode audit of every runtime grant below (each is either narrow-keep or
   * read-narrowed; NONE may silently re-open reads the allowlist excludes — sol's indirect-leak
   * finding in the 2026-07-16 agreement):
   *   - /tmp + the $HOME dot-dirs (.config .cache .npm .claude .grok .codex .local/state
   *     .local/share): BROAD trees, and rw includes the ro bits — granting them unchanged in
   *     strict mode would re-open reads of old /tmp helm-run-* artifacts and of the operator's
   *     real provider session history (prior runs containing the very material strict mode must
   *     hide). In strict mode they keep ONLY the write-side bits (exc_write): tooling can still
   *     create/write scratch and state exactly as in the default profile (the WRITE surface is
   *     identical in both profiles), but READS/EXECS inside these trees require an explicit
   *     HELM_SANDBOX_RO_ALLOW entry (the caller passes e.g. its per-run TMPDIR, sanitized
   *     per-run provider homes, and minimal auth files). Landlock's REFER escalation check
   *     denies rename/link of a write-only file into a read-granted dir (a moved file may never
   *     GAIN access rights), so the narrowing cannot be bypassed with mv/ln.
   *   - /dev/null zero full random urandom tty (further below): NARROW, specific char devices
   *     required by ubiquitous tooling (shell redirects, entropy, TTY probes); reading them
   *     leaks nothing. KEPT byte-identical in strict mode. */
  uint64_t exc_write = rw & ~ro; /* WRITE_FILE|TRUNCATE|MAKE_REG|MAKE_DIR|REMOVE_FILE|REMOVE_DIR|MAKE_SYM|REFER */
  uint64_t exc = strict ? exc_write : rw;
  add_rule(rs, "/tmp", exc, resolved, "tmp");

  /* B1 (R2.12/F6): opt-in extra write-fence exception for a durable run root outside /tmp — see the
   * file-header doc comment. Absent/empty is a no-op (byte-identical to every existing caller). */
  const char *write_allow = getenv("HELM_SANDBOX_WRITE_ALLOW");
  if (write_allow != NULL && write_allow[0] != '\0') {
    add_write_allow_rules(rs, write_allow, exc, resolved);
  }
  /* W2 HIGH: use real home from getpwuid(getuid()), NEVER the caller's getenv("HOME") (injectable) */
  struct passwd *pw = getpwuid(getuid());
  const char *real_home = (pw && pw->pw_dir && *pw->pw_dir) ? pw->pw_dir : NULL;
  if (real_home) {
    char p[PATH_MAX];
    snprintf(p, sizeof(p), "%s/.config", real_home);
    ensure_dir(p);
    add_rule(rs, p, exc, resolved, "home-config");
    snprintf(p, sizeof(p), "%s/.cache", real_home);
    ensure_dir(p);
    add_rule(rs, p, exc, resolved, "home-cache");
    snprintf(p, sizeof(p), "%s/.npm", real_home);
    ensure_dir(p);
    add_rule(rs, p, exc, resolved, "home-npm");
    snprintf(p, sizeof(p), "%s/.claude", real_home);
    ensure_dir(p);
    add_rule(rs, p, exc, resolved, "home-claude");
    /* POCFIX13 (panel fork C): agents persist session/runtime state in their own top-level home
     * state dirs at first-prompt session-start. grok writes the entire ~/.grok tree
     * (active_sessions.json+lock, sessions/, *.sqlite WAL, logs, auth.json, *.lock); codex writes
     * ~/.codex (sqlite WAL, auth, sessions). Not granting these = EPERM = frozen "Starting session"
     * hang (claude works only because ~/.claude is granted above). Grant the dirs (PATH_BENEATH
     * covers the subtree). XDG runtime/socket dirs are NOT granted (grok strips XDG, file-based IPC).
     * Same documented tooling-exception class as .config/.cache/.npm/.claude — NOT a project-write hole. */
    snprintf(p, sizeof(p), "%s/.grok", real_home);
    ensure_dir(p);
    add_rule(rs, p, exc, resolved, "home-grok");
    snprintf(p, sizeof(p), "%s/.codex", real_home);
    ensure_dir(p);
    add_rule(rs, p, exc, resolved, "home-codex");
    /* XDG state/data fallbacks (best-effort; some CLI builds migrate state here) */
    snprintf(p, sizeof(p), "%s/.local/state", real_home);
    ensure_dir(p);
    add_rule(rs, p, exc, resolved, "home-localstate");
    snprintf(p, sizeof(p), "%s/.local/share", real_home);
    ensure_dir(p);
    add_rule(rs, p, exc, resolved, "home-localshare");
  }

  /* POCFIX10: file-only rw on the standard safe writable char devices (grok-build agents boot+redirects like > /dev/null 2>&1, common tooling).
   * Use file_rw (READ_FILE|WRITE_FILE only) — NOT full rw (avoids EINVAL on char dev fds for MAKE_DIR etc).
   * Guard each only if exists (access F_OK); use literal absolute paths (not broad /dev or block devs). Same add_rule as /tmp + home-* (tooling only, not project-write hole).
   *
   * sol review REQUIRED #1 (real strict read leak): these devices are non-directories, so the default
   * POCFIX10 helper (allow_parent_widen=true) replaces the device fd with its PARENT /dev and grants
   * file_rw over the WHOLE /dev subtree — which makes /dev/shm/<name> (a tmpfs) READABLE. Under the
   * default read-all profile that is masked by root-ro (harmless), but under STRICT it re-opens a read
   * surface the allowlist excludes: an agent could stash+read cards material via /dev/shm. In strict
   * mode we therefore bind each rule to the device file's OWN fd (allow_parent_widen=false — the same
   * file-scoped path used for allowlist file entries and B22b top-level files); file_rw is already a
   * file-safe mask (no dir-only rights), so the exact devices still work while /dev itself gains no
   * rule. Default profile keeps the historical parent-widen behavior byte-identical. */
  bool dev_widen = !strict;
  if (access("/dev/null", F_OK) == 0) {
    add_rule_ex(rs, "/dev/null", file_rw, resolved, "dev-null", dev_widen);
  }
  if (access("/dev/zero", F_OK) == 0) {
    add_rule_ex(rs, "/dev/zero", file_rw, resolved, "dev-zero", dev_widen);
  }
  if (access("/dev/full", F_OK) == 0) {
    add_rule_ex(rs, "/dev/full", file_rw, resolved, "dev-full", dev_widen);
  }
  if (access("/dev/random", F_OK) == 0) {
    add_rule_ex(rs, "/dev/random", file_rw, resolved, "dev-random", dev_widen);
  }
  if (access("/dev/urandom", F_OK) == 0) {
    add_rule_ex(rs, "/dev/urandom", file_rw, resolved, "dev-urandom", dev_widen);
  }
  if (access("/dev/tty", F_OK) == 0) {
    add_rule_ex(rs, "/dev/tty", file_rw, resolved, "dev-tty", dev_widen);
  }

  /* B7 (R4.1/R4.3): cycle-scoped git capability (GIT_RO/GIT_ADMIN/GIT_REF_RW/GIT_OBJ) — see the
   * file-header doc comment. Absent HELM_SANDBOX_GIT_RO is a no-op, byte-identical to every
   * existing caller and profile. */
  add_cycle_git_rules(rs, rw, resolved);

  if (landlock_restrict_self(rs, 0)) {
    close(rs);
    fail("landlock_restrict_self", resolved, errno);
  }
  close(rs);

  /* W1 CRITICAL: scrub inherited fds (close_range or /proc fallback) before execvp */
  scrub_inherited_fds();

  /* Replace this process with the real CLI under the ruleset (using canonical project dir for rules) */
  execvp(cmd, &argv[2]);
  fprintf(stderr, "helm-sandbox: execvp(%s) failed after successful restrict: %s\n", cmd, strerror(errno));
  return 127;
}
