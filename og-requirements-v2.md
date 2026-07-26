# Helm — Requirements Contract v2 (UI Redesign + functional completion)

> **Supersedes the UI/UX portions of og-requirements.md (v1, H1–H21).** The v1 *engine* requirements
> (H13–H17 mechanics, H18–H21 cross-cutting) carry forward and are REUSED, not rebuilt. v2 adds the
> agreed UI (sonnet mockup at `AGJ_Upgrade/mockups/helm-app-2026-06-15/code/sonnet/index.html`, rendered
> shots in `…/shots/sonnet/`) as the binding visual + structural contract, plus the functional
> amendments captured in the 2026-06-15 section-by-section interview.

**Acceptance bar (projcore §1.11 UI-PROOF):** a requirement is closed only when it is observably true in
the **rendered, running Helm app** (DOM/Playwright on :3110 + screenshot) AND matches sonnet's mockup
for that screen. `req-matrix.md` tracks every row; final acceptance only when all = VERIFIED.

**Visual contract:** match sonnet's mockup ~1:1 — sidebar + main shell, GitHub-dark palette, role color
chips, compact/professional/intuitive density, master-detail + grouped-card patterns, the hero chat.

---

## Amendments to v1 (the interview reversed/extended these)
- **A0 — Project source of truth FLIPPED (amends v1 H5/H20):** Helm is now the **source of truth** for
  projects; OVM will later read FROM Helm. Helm no longer reads projects from OVM. Projects are created by
  **promoting an open tmux session**.

## Global / shell
- **V1 — App shell:** left **sidebar** (Helm wordmark; nav: Agent Studio · Project Setup · Command Center ·
  Memory; owner/live indicator) + **main window** (section header, subsection tab strip, content). Matches
  sonnet desktop layout.
- **V2 — Compact mobile:** sidebar collapses to top-bar/drawer; full-width content; touch targets; matches
  sonnet mobile shots. Intentional `@media`, not a shrunk desktop.
- **V3 — Light + dark theme with auto-detect:** honors `prefers-color-scheme` on first load; manual toggle;
  choice persisted. Both themes legible + on-brand (GitHub-dark + a tasteful GitHub-light).
- **V4 — Login:** restyled owner-credential screen per sonnet `00-login`; reuses existing auth (v1 H19).

## ① Agent Studio
- **S1 — Models (shared library):** CRUD of model definitions = `provider + model-id + effort + approval +
  optional flags`. **effort = fixed value OR `dynamic`** (agent/coordinator decides at spawn). Reusable;
  agents/projects select from this library. (extends v1 H3, H17)
- **S2 — Agents:** master-detail. Agent `.md` shown as **filename only** (rules/identity; agent-edited;
  click → view raw). App-managed bindings (NOT in the `.md`): **default model** (from S1, may be `dynamic`),
  **1 backup model** (token-exhaustion), **spawn preference** (tmux default | in-process), **side-skills**
  as a JIT toolkit **filename TOC**. Create/edit/list/delete. (extends v1 H1, H2, H3)
- **S3 — Plumbing / Watchers (app-wide, model-agnostic):** the lifted watcher/wakeup/callback substrate
  that watches **coordinators** (not workers). Config: **brain model + backup brain** (backstop only —
  ~80–95% decisions algorithmic), **refresh thresholds** (task-count, context/token watermark, time
  fallback), **escalation policy** (real-blocker-only, de-dup, no spam). **Context Steward** live view:
  per-coordinator state (active/idle/stuck), last refresh/nudge/checkpoint, **self-set schedule** + JROM
  override. Coordinators **self-configure** their cadence via a sanctioned interface. (lifts v1 H4)

## ② Project Setup
- **P1 — Projects:** Helm-owned projects table. **Promote an open tmux session → project** (name ·
  directory · primary driver). **Autodetect** the runtime running in the session; **flag mismatch** vs the
  configured driver (no auto-switch). (amends v1 H5; extends H8)
- **P2 — Project agents:** per-project list of usable agents + model. Model **overridable per project**,
  incl. **`dynamic` = coordinator picks from the GLOBAL model pool** by complexity/token availability.
  **Set-to-default** (reset to Studio defaults) + **Add-all-agents** + add/delete. One **primary driver**.
  (extends v1 H6, H7)
- **P3 — Write-fence (app-enforced):** agents may **write only within their project directory**;
  cross-project **read OK, write never**; project-aware refusal as behavioral layer. App-enforced where
  technically feasible (spawn cwd lock + sanctioned-tool scoping). (new; security boundary)
- **P4 — Project prompts/prefs:** review surface listing the project's agent-authored `.md` docs (filename
  + description, click → view). Agent-maintained, JROM-reviewable. (new)

## ③ Command Center
- **C1 — Clean-chat channel:** the master posts owner-facing replies via a **sanctioned structured channel**
  (callback → `agent_events`), rendered in the **clean chat**; raw pane streams to the **terminal log**
  separately. Chat is **durable** and **part of the task spec the validator references**. (extends v1 H10,
  H11; structured events, not pane scraping)
- **C2 — Chat UI:** per-project **tabs** (closeable/reopenable; chat+terminal history persists). New
  conversation from a dropdown of **idle** projects. **3-way view toggle: split (chat+terminal) /
  chat-only / terminal-only** (clickable). **switch-model dropdown** = one-click master hot-swap (v1 H12,
  H15). Per-session **compact / clear-terminal**. Matches sonnet `07`. (extends v1 H8, H9)
- **C3 — Tasks:** per-project view of the **tasklist** (completed / working-on / pending) + **agent roster**
  (spawned, working vs idle). App-owned tasks table, coordinator-updated. OVM-replacement. Matches sonnet
  `08`. (extends v1 H10, H16)
- **C4 — Completed:** archive of previously-active task lists that finished, per project. Matches sonnet
  `09`. (new)

## ④ Memory
- **M1 — Memory store:** **App** (global) + **Project** (per-project) scopes. Each note = title +
  description + type (`user|feedback|project|reference`) + body. `.md`-note + DB index. (new)
- **M2 — JIT retrieval + curation:** agents **query** relevant notes JIT (scope-ranked, like side-skills);
  agents **propose**, JROM **approves** app-global notes; project memory **cross-project readable,
  write-siloed**. UI: App/Project toggle, list (title+desc, click→view), search, add/edit/delete,
  approve/reject. Matches sonnet `10`. (new)

## Reuse (carried from v1 — DO NOT rebuild, must keep working)
- H13 persistent master session + auto-respawn · H14 app-owned worker spawn lifecycle · H15 model hot-swap
  (park→relaunch→re-feed) · H16 durable portable state (`agent_events`) · H17 plug-and-play providers ·
  H18 standalone (own dir/process/port :3110/SQLite) · H19 auth = owner login + loopback/owner-only/
  enumerated guardrails · H20 (now: Helm is source of truth) · H21 build topology.

## Non-goals (v2)
- No master launch UI yet (JROM owns session lifecycle manually for now).
- No inter-project agent-to-agent channel yet (manual session handoff stands).
- Not merged to AGJAssist master — Helm stays standalone.
