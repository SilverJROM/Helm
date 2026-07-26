# Helm — Requirements Contract (v1)

> **What Helm is:** a standalone, Agent-Zero-inspired orchestration system that lets JROM author agents,
> set models plug-and-play under fixed agent roles, and run/talk to per-project agent teams from a single
> command center. It is the real home of orchestration — the app owns the mechanics; the model under any
> role is swappable. Built as a **sibling service to AGJAssist** that cannot break it.

**North star:** ONE source of orchestration. The app owns the prompt + the durable state; the runtime is
disposable. Providers/models are plug-and-play under permanent agent *roles* (projcore/coord/lead/…).

**Acceptance bar (projcore rule):** this contract — not "tests pass" — is the only acceptance target. A
requirement is closed only when it is observably true in the running Helm system. `req-matrix.md` tracks
every row; final acceptance only when all = VERIFIED.

---

## Section ① — Agent Studio  (author agents + app plumbing)

- **H1** — Author agents as `.md` prompt files through a friendly editor: create / edit / list / delete agents.
  Each agent has a name, role, the prompt body, and metadata. (User-friendly is a first-class requirement.)
- **H2** — **Toolkit sidecars, JIT.** An agent's main `.md` declares its sidecars as a *manifest* of one-line
  entries (`deploy-toolkit — how to ship to dev/qa`). The full sidecar file is loaded ONLY when the task calls
  for it, so an agent never carries context it isn't using. (Mirrors how projcore's reference/routing sidecars work.)
- **H3** — Set each agent's **default model** (provider + model) in the Studio.
- **H4** — The **app-owned plumbing** every agent rides is surfaced/managed here: the watcher, callbacks, and
  wake/scheduler (the lifted, proven substrate). Agents do not hand-roll these.

## Section ② — Project Setup  (configure per-project teams)

- **H5** — Projects are **sourced from OVM** (read-only from AGJAssist's `projects` registry). You configure
  only projects that already exist in OVM; Helm never creates OVM projects.
- **H6** — Assign agents to a project and **override per-agent model defaults** where needed.
- **H7** — Set the project's **master model preference chain** — a primary model + ordered fallbacks
  (e.g. `claude-opus → codex-5.5 → grok-build`).

## Section ③ — Command Center  (talk + watch + steer)

- **H8** — A **project dropdown populated from OVM-set-up projects only.** You cannot open a conversation for a
  project that has not been set up in Project Setup.
- **H9** — **A tab per project;** a message under a project tab goes **straight to that project's persistent
  projcore master.** One master = one tab.
- **H10** — **Live "what's happening now":** current task, progress, and (P2+) worker activity, rendered from
  the structured event stream — NOT pane scraping.
- **H11** — **Agent-asks-you-here → you reply → work proceeds.** Each message carries real role + status +
  timestamp (structured events).
- **H12** — A **switch-model dropdown** in the Command Center: one-click hot swap of the master's model.

## Engine / mechanics  (the underground architecture)

- **H13** — **Persistent master session per project.** projcore runs as a **bare agentic CLI of the project's
  chosen provider** (Claude Code / codex / grok), fed the **app-composed prompt** (CORE + per-runtime overlay).
  App-supervised; **auto-respawns** after reboot/crash; stays alive indefinitely.
- **H14** — **Workers spawned through the app.** When the master needs help it asks the app (a sanctioned
  "spawn worker" tool); the **app owns the worker lifecycle** — create the tmux session, feed the composed
  worker prompt, watch it, tear it down when done. Workers are **ephemeral**.
- **H15** — **Model hot-swap.** On primary-model token-exhaustion (detected via the usage gateway) OR on a
  manual click, the app **parks the current runtime process** in the master session (does NOT kill the
  session), **launches the fallback provider in the same session**, and **re-feeds the composed prompt + a
  compact state digest** so it resumes the task. Emits one `master-switched` event.
- **H16** — **Durable, portable state.** All messages / tasks / decisions live in the `agent_events` DB + run
  files as they happen, so ANY runtime can resume — the runtime's in-memory context is never the source of truth.
- **H17** — **Plug-and-play providers.** Adding a provider/model = ONE registry edit (lifted A2 resolver),
  proven by adding a dummy and resolving it. v1 providers: claude, codex, grok.

## Cross-cutting

- **H18** — **Standalone.** Own directory + process + port + SQLite DB. AGJAssist is untouched; if Helm
  crashes, AGJAssist keeps serving (different process).
- **H19** — **Auth = reuse AGJAssist owner login**, and the proven B6 **spawn-path guardrails carry over**:
  spawn/launch endpoints loopback-bound, owner-only, **enumerated role×runtime vocabulary** (no free-form
  shell from a request or message).
- **H20** — **Link seam = read-only consumption of the OVM projects list.** No writes back into AGJAssist/OVM.
- **H21** — **Build topology:** coordinator (opus) ≠ implementer (grok-build) ≠ validator (sonnet|codex-5.5 per
  complexity). **Deliberation + red-team panel = sonnet + codex-5.5 + grok-build**, run for genuinely complex
  issues before building them.

## Non-goals (v1)

- Not a replacement for any AGJAssist feature; Helm sits beside it.
- Not multi-user — single owner (JROM).
- Never writes to AGJAssist/OVM data (read-only link).
- v1 does not auto-tune models by task complexity beyond the manual/fallback chain (that's a later idea).
