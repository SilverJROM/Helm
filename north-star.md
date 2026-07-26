# Helm — PROJECT north-star

**The enduring constitution.** Vision, architecture goals, standing decisions, standing constraints.
**Authored by** `[north]` (`helm-97`) **2026-07-26**, from four read-only archaeology surveys of the live
tree plus JROM's vision interview.

**Curated, not append-only.** This doc is pruned as well as extended — superseded entries are archived,
not accumulated. It stays lean on purpose. Maintained like the JROM style codex, never appended blindly.

**What this is NOT:**
- Not `project_specs.md` — that holds build/test/deploy mechanics and per-module detail. **When the two
  disagree about a command or a path, `project_specs.md` is the one to fix; when they disagree about
  *intent*, this file wins.** (`project_specs.md` was measurably stale on 2026-07-26 — see §7.)
- Not an effort north-star. Effort docs live in `plan/<effort>/north-star.md`, **inherit** this one by
  citation, and are append-only within their run.

---

## 1. What Helm is

A standalone agent-orchestration application. It authors agents, binds swappable models to fixed agent
roles, and runs and supervises per-project agent teams from one command center. It is a **sibling
service to AGJAssist that cannot break it** (`og-requirements.md:3-6`).

Helm is the *engine* that runs real client projects: it plans work, dispatches AI coding agents into
tmux sessions under a Landlock write-fence, gates their output, escalates when they fail, and reports
what happened.

## 2. The founding principle — never restated, never revised

> **"ONE source of orchestration. The app owns the prompt + the durable state; the runtime is
> disposable."** — `og-requirements.md:8-9`

"The runtime is disposable" means **the record outlives the session** — when a pane dies you lose the
pane, never the truth. It does *not* mean headless, and it never licenses hiding the machinery.

Its corollary, which every effort inherits:

> **The app's report is a consequence of what happened, never a claim about it.** Derive state from the
> record; never from a hardcoded assumption, a regex over prose, or a file that may not exist.

An orchestrator whose self-report cannot be trusted cannot be pointed at a client project, because the
operator's only view of the work *is* the report. Integrity of the report is therefore a **functional**
requirement, not a presentation concern.

## 3. Acceptance philosophy

> **"this contract — not 'tests pass' — is the only acceptance target. A requirement is closed only when
> it is observably true in the running Helm system."** — `og-requirements.md:11-13`

Green tests are necessary and never sufficient. Every user-visible requirement is proven on the rendered
app with a screenshot into `validation/`. API-only or code-reading evidence is never acceptance.

## 4. Who Helm is for

**Personal now, product later** (JROM, 2026-07-26). Built for JROM today; the architecture must not paint
itself into a corner that a second operator would require a rewrite to undo.

Consequences that follow, and that agents may rely on:
- Owner-only auth is **current, not final**. Keep the seam; do not build multi-tenancy.
- Legibility is judged by whether **JROM** can supervise a run — not by whether a stranger can onboard.
- Where self-explanatory behaviour is cheap, take it. Where it costs real scope, defer it and say so.

## 5. Standing decisions

Numbered, dated, attributed. **Not re-openable by any agent** — only JROM revises these.

| # | Decision | Source |
|---|---|---|
| **SD1** | **Truth model.** The **DB is authoritative for execution state** (tasks, statuses, seats, verdicts). Human-readable **artifacts on disk are the durable, greppable, reboot-proof record**. Two records, one owner each; **neither may silently lie**. | JROM 2026-07-26; generalises effort D2 |
| **SD2** | **Sessions are real tmux and always attachable.** `tmux attach` must keep working standalone as the escape hatch. The browser has to *earn* being as good as attaching and never becomes the only way to see. JROM: *"i want to be able still to go inside the actual sessions and watch them, not some headless where i cant validate."* | JROM 2026-07-26 |
| **SD3** | **`helm_pm` is permanent safety — and the UI must still name the real agent.** One role carries three names: `plancore` internal, `helm_pm` model-facing, plus the DB-bound name (`src/services/role-alias.ts:14-18`). The alias exists so spawning Helm's planning brain does **not** summon the operator's global CLI `/projcore` persona; renaming it reintroduces a persona-hijack hazard that has bitten live sessions. **Keep it permanently; do not let a future cleanup "fix" it.** **Two audiences, two names:** the *model* sees only the face name; **every human-facing surface shows the true internal role + the actual model.** A masked name in the UI is the app reporting something other than what is happening. Note `helm_pm` faces **both** `plancore` and `ibrain`, so it is only resolvable with dispatch/run context — never by string substitution. | JROM 2026-07-26; UI half = effort `D8` |
| **SD4** | **Auth faults pause, never fail over.** If a seat loses auth (e.g. an expired grok token), **PAUSE the run resumably, notify JROM, hold until he re-logs in.** Never advance the escalation ladder to another provider on an auth fault. Terminal by design, not a bug (`src/services/seat-auth.ts:10-13`, `HARDENING-TODO.md:8-9`). | JROM-locked, pre-existing |
| **SD5** | **Deferral is OFF pre-live**, and the policy is **product-owned**: `policy/deferral-policy.md`. The enforceable test is whether deferred work has a queued task **in this run** that gates completion. No TODO/FIXME/compat-shim/punt-language. Workers must not read builder-side scaffolding under `~/.claude/JROM/**` — *"The product stands without the build crew."* | `policy/deferral-policy.md:8-10, 21, 36, 64-78` |
| **SD6** | **Helm is the source of truth for projects.** OVM will later read **from** Helm, not the reverse. Projects are created by promoting an open tmux session. (Amends the original v1 H5/H20.) | `og-requirements-v2.md:19-22` (A0) |
| **SD7** | **Models are swappable under fixed roles.** The app owns the mechanics; the model behind any role is configuration. Role identity never depends on which model currently fills it. | `og-requirements.md:3-6` |
| **SD8** | **Helm is the sole instruction envelope.** Every agent launch strips the operator's global CLI config (`real-transport.ts:113`) and runs behind the fail-closed Landlock fence (`tools/helm-sandbox.c`). An agent must never inherit ambient instructions Helm did not give it. | pre-existing, architectural |
| **SD9** | **One tmux session per spawned agent, pruned when its purpose is served.** JROM: *"i want as much as possible all agents spawned gets their own tmux session, but pruned after its purpose is done so save resources."* Session-per-seat is the isolation unit (it is also what makes SD2's attachability meaningful); reaping is the resource discipline. `helm_sessions` is the registry and the janitor's **only** authority; `worker_runtimes` carries the `launching → running → reaped` lifecycle. **Appears already implemented — [north] to verify before any work is proposed.** Pruning must never reap a session outside the `helm-` prefix, and never one belonging to a live run. | JROM 2026-07-26 |
| **SD10** | **Git is MANUAL and gated — for the client projects Helm manages.** Helm's own tree has no git (§6.1); this decision is about the repos it orchestrates. JROM: *"the branch and git cleanup and promote should be a different state… manual as i dont want this to be autonomous and override my branches, main, etc."* Therefore: (a) **branch cleanup / merge / promote is never autonomous** — Helm asks and waits; (b) **each task is done on its own new branch**; (c) **discovery audits branch state up front** — it flags any other unmerged branches cleanly and **recommends which branch to start from, before work begins.** This mirrors JROM's standing pre-start branch-audit habit, now stated as product policy. **NOT YET BUILT — see Q5.** | JROM 2026-07-26 |

## 6. Standing constraints — violating these breaks the system

1. **Helm IS a git repository — as of 2026-07-26 22:3x.** ~~There is no undo.~~ **RESOLVED.** JROM
   authorised it; `[north]` executed it. Baseline commit **`b015f3b`** (766 files) in
   `/home/agjrom/websites/Helm`, remote **`git@github.com:SilverJROM/Helm.git`** (**private**), branch
   `main`, force-pushed over the stale remote `abe404c9`. The app never stopped — `git init` writes only
   `.git/`. **Prior history is preserved untouched at `/home/agjrom/TGBOTS/Helm`** (JROM's backup); the
   live tree was originally seeded from there.
   **Consequences:** the recovery mechanism is now `git restore`, not a hand-made `.bak` sibling — the 229
   pre-git `.bak-*` copies are superseded and untracked (they remain on disk). And **every git-shaped gate
   in the older docs stops being dead letter** — "commit-landed-before-gate" and the `git stash`
   clean-checkout gate (`implementation-plan.md:58-59`) can now actually run. Adopt
   commit-landed-before-gate.
   **Gitignored on purpose:** `.env*`, all `data/*.db*` incl. `data/backups/`, `node_modules` (a symlink
   here — a trailing-slash pattern cannot match it), `dist/`, `tmp/`, `*.bak-*`, and **`plan/`** — run
   directories and their `validation/` evidence deliberately stay out of the product repo, per
   **SD5**'s "the product stands without the build crew". Never commit a database or an env file.
2. **Never `pm2 restart helm-harness` while any run has `status='active'`.** The engine auto-resumes on
   boot and corrupts in-flight runs (`ecosystem.config.cjs:14-17`). Restart only at a zero-active-run
   boundary.
3. **`src/web/public/app.js` is a 560 KB hand-written non-bundled vanilla SPA.** No build step, no TS
   annotations. `node --check` after **every** edit or the page goes blank. The tree ships **two** copies
   — `src/web/public/` (source) and `dist/web/public/` (served); a fix that lands only in `src/` is not a
   fix.
4. **Schema is two-track.** Fresh DBs from `src/db/schema.ts`; upgrades via a guarded block in
   `src/db/database.ts`. `SCHEMA_VERSION = 98`. The DDL is duplicated verbatim across both tracks and
   **can drift** — never change one without the other.
5. **UI evidence must target the live app on `:3110`.** The default `playwright.config.ts` points at
   `:3111` and spawns its **own** throwaway server with `USE_FAKE_TMUX=1` and a scratch DB — screenshots
   from it are not evidence about Helm. The live target is `playwright.cap.config.ts`, whose `testMatch`
   currently collects a **single** filename.
6. **The live database is `data/cards2-ibrain.db`** — `ecosystem.config.cjs:23` overrides `.env`.
   `data/helm.db` is stale and is also the only path the Vitest guard names.
7. **`/tmp` is not storage.** A reboot wiped `/tmp/helm-harness` and crash-looped Helm 1.38M times.
8. **Tests never touch a live DB.** `src/test-setup.ts` force-overrides `HELM_DB_PATH` before any
   `loadConfig`, which is path-agnostic and holds. Keep `vitest`'s `fileParallelism: false` (it is what
   actually prevents the fork storm) and cap forks explicitly as belt-and-braces.

## 7. What is strong here — protect it

- **The deferral policy demonstrably works.** A full grep of `src/` yields **one** TODO, and it is a
  string literal inside a test fixture. `app.js`, at 560 KB, has **zero**. That is a measurable asset
  almost no codebase of this size has; it exists because the policy is enforced rather than aspirational.
- **Honest empty states.** The UI renders "Not yet produced." / "No live terminal for this task yet."
  and refuses to fabricate; gate buttons disable with a *reason* string. Real-data discipline is already
  the house style — extend it, never regress it.
- **Fail-closed safety substrate.** Landlock write-fence, seat-binary preflight, dispatch nonces,
  callback byte-offset fences against stale verdicts, `assertRunActive` before every spawn.

## 8. Known structural debt — curated, not the full backlog

Recorded because each one *misleads* someone who doesn't know it. Not a work queue.

- **Three DB names for one database.** Code default `helm.db`, `.env` `helm-harness.db`, pm2
  `cards2-ibrain.db`. The safety rail names the non-production file; the production file has none.
- **`run_id` is two incompatible types.** INTEGER in `runs`/`worker_runtimes`; **TEXT with no FK** in
  `agent_events`, `run_events`, `stall_lineages`. The entire event substrate is therefore **detached
  from the run row it describes** and unjoinable without a cast.
- **Six overlapping mechanisms** answer "who fills role X for project P" (`role_defaults` →
  `role_bindings` → `project_agents` → `role_team_bindings` → `project_role_roster_members` → the tier
  stack), then freeze into `cycle_topology_freezes`. Three generations coexist **by explicit decision**;
  resolution order lives only in service code, never in the schema.
- **Run artifacts default to `os.tmpdir()`** (`src/services/run-paths.ts:17`) and `ecosystem.config.cjs`
  does **not** set `HELM_RUN_ROOT` — so durability is opt-in and currently **off in production**, while
  `artifacts.path` durably records paths that vanish on reboot.
- **Chat sessions are an in-memory `Map`** that a restart destroys, yet `agent_proposals.chat_session_id`
  durably stores a handle into it — every stored proposal's provenance dangles after any restart.
- **~1,900 lines of unreachable Command Center code** stranded behind removed tabs, including a
  fully-built 2×2 tmux grid.
- **Dead contract columns** — `teams.consensus_rule`, `team_members.context_meta`,
  `validations.validator_brief_ref`, `task_attempts.impl_dispatch_id`/`validator_dispatch_id`. Stored
  config no code reads. Wire it or delete it; never leave a contract that lies.
- **`claude-projcore` spawn flakiness** — empty pane 50-100% of the time, root cause unfound after
  POCFIX18/20; the standing workaround is routing to grok (`backburner.md:57-64`).
- **The adaptive planner is built and dark.** Stages 1-4 done and validated; **stage 5 (tests, telemetry,
  deploy) never executed**; default-OFF flag, no telemetry baseline ever taken, and its own status line
  is itself stale (`docs/adaptive-planner-plan.md:90-95`).

## 9. Open questions — do NOT assume an answer

| # | Question | Why it is open |
|---|---|---|
| ~~Q1~~ | **ANSWERED 2026-07-26 — JROM: *"the cards2-ibrain db is a misconfig yes."*** So the live process is pointed at the wrong file and the intended name is `data/helm.db` (the code default at `src/config/config.ts:68`). **The fix is a data migration, NOT a doc edit**: the real data lives in `cards2-ibrain.db`, so repointing means moving that data and correcting `ecosystem.config.cjs:23`. **Blocked on a zero-active-run boundary** (§6.2) and therefore its own scoped task — never folded into another effort. **Until it lands, `cards2-ibrain.db` remains what the app reads, so all `[DB]` evidence must target it.** A pleasant side effect once done: the Vitest guard at `database.ts:15-22`, which names `helm.db`, stops naming the wrong file. |
| **Q2** | Does the **adaptive planner** get launched, or stay dark? | Fully built through stage 4 and gated OFF. Launching needs stage 5; leaving it dark means carrying a large unexercised subsystem. |
| **Q3** | Is "not a git repo" **deliberate** or accidental? | It removes every undo and silently voids a class of gates the docs still assert. `implementation-plan.md:7` still claims a git home that does not exist. |
| **Q4** | Where is Helm going over the next 6-12 months? | Not yet elicited. The vision interview settled audience, truth model and attachability, but not the horizon. Being re-asked in a concrete form rather than abstractly. |
| **Q5** | Does **SD10** (git branch audit / per-task branches / manual gated promote) become the **next effort** after `helm-ux-remediation`? | The policy is decided; none of it is built. It is real scope — a discovery-time branch audit, per-task branch creation, and a human-gated promote state — and deliberately kept OUT of the current effort, whose 31 ACs are frozen and mid-plan. |

## 10. Maintenance

- **Promotion:** an effort surfaces an enduring decision → `[north]` **proposes** → **JROM approves** →
  curated into §5. The constitution never changes without him.
- **Effort docs inherit by citation**, never by copying §§1-6.
- A north-star boundary is a natural context-reset point for `[north]`.
- When this file and reality disagree, **reality wins and this file gets fixed** — the same rule the
  product is held to.
- **This file is version-controlled** (JROM 2026-07-26). It travels with the code, so its history is the
  record of how Helm's intent changed. `plan/` stays untracked — that is per-run scaffolding, this is the
  constitution.
