# Helm v2 — Implementation Plan (UI redesign + functional completion)

Contract: `og-requirements-v2.md`. Visual contract: sonnet mockup
(`AGJ_Upgrade/mockups/helm-app-2026-06-15/code/sonnet/index.html`). Reuse the existing engine in
`/home/agjrom/TGBOTS/Helm` (auth, master launch/swap, worker spawn, usage gateway, SSE, DB+migrations).
Standalone repo; DO NOT merge to AGJAssist master. Each batch = atomic vertical slice, UI-PROOF accepted.

Topology: coordinator (Opus/projcore) ≠ implementer (grok-build, tmux) ≠ validator (sonnet/codex-5.5).
Gate: strict committed-state (git stash clear; npm ci; build; node --check app.js; vitest ×2; playwright).

## Phase A — Shell & theme (foundation; everything else renders inside it)
- **A1** [V1,V4] New app shell: sidebar+main, 4-section nav + subsection tab strip, section/hash routing,
  GitHub-dark design tokens + restyled primitives (cards, chips, tables, buttons, **styled inputs/textarea —
  no white boxes**), restyled login. Re-skin only; sections render as wired-or-stub panels.
- **A2** [V2,V3] Light/dark theme via CSS variables + `prefers-color-scheme` auto-detect + manual toggle +
  persistence; compact-mobile `@media` matching sonnet mobile shots.

## Phase B — Agent Studio
- **B1** [S1] Models: `models` table + CRUD API + library table/editor UI (effort fixed|**dynamic**,
  approval, flags). Migrate existing inline model usage to reference the library.
- **B2** [S2] Agents: master-detail UI; `.md` filename-only + raw view; app bindings (default from B1,
  backup, spawn pref, side-skill TOC). Reuse existing agents table + definition_md + toolkits.
- **B3** [S3] Plumbing/Watchers **[DELIBERATE]**: model-agnostic watcher substrate + brain/backup config +
  thresholds + escalation + Context Steward live view + self-config interface. Built as functional v1.

## Phase C — Project Setup
- **C1** [A0,P1] Projects: Helm-owned `projects` table; promote-open-tmux-session flow; autodetect runtime +
  mismatch flag. Replaces OVM-read project source.
- **C2** [P2] Project agents: per-project overrides incl. dynamic(global pool); Set-to-default + Add-all;
  primary driver.
- **C3** [P3] Write-fence **[DELIBERATE mechanism]** **[REDTEAM:elite]**: app-enforced cwd lock +
  cross-project read/write rules + project-aware refusal.
- **C4** [P4] Project prompts/prefs review surface (filename list + view).

## Phase D — Command Center
- **D1** [C1] Clean-chat channel **[DELIBERATE]** **[REDTEAM:standard]**: sanctioned structured owner-reply
  endpoint → typed `agent_events`; chat vs terminal separation; chat durable + spec-linked.
- **D2** [C2] Chat UI: per-project tabs (persistent), clean chat + tmux log pane, **3-way view toggle**,
  composer, switch-model hot-swap wiring, compact/clear-terminal. The hero screen.
- **D3** [C3] Tasks: app-owned `tasks` table (coordinator-updated) + roster; completed/working/pending view.
- **D4** [C4] Completed: archived finished task lists per project.

## Phase E — Memory
- **E1** [M1] Memory backend: app/project `memory` tables + `.md` notes + DB index + JIT query API.
- **E2** [M2] Memory UI **[REDTEAM:standard]**: App/Project toggle, list+search, add/edit/delete,
  propose→approve flow + project isolation (read cross / write siloed).

## Phase F — Capstone
- **F1** Full-app **[REDTEAM:elite]** capstone: cross-section regression + final §1.11 validation per req +
  pm2 redeploy to :3110 + UI-PROOF screenshots for every req-matrix row.

Dependencies: A1→A2 first (shell). B/C/D/E build inside the shell, ordered by value (Studio → Setup →
Command Center → Memory). D1 before D2. C1 before C2/C3. F1 last.
