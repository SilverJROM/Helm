# Requirements intake — list mode (JROM-driven)

**Protocol (locked 2026-07-22):** JROM gives requirements item by item → per item I dispatch a grok-4.5
investigator (background, hands-free) → findings logged here → when all done, I synthesize the init docs
(north-star / og-requirements / decisions) → hand to execution.

**Subject:** Helm platform — Project Setup / agent-config UI (inferred from item 1; confirm)
**Executor for init docs:** _(TBD — Helm adaptive planner we just built, or standalone projcore)_

**Legend:** status = `logged` → `investigating` → `done`.

---

## Items

| # | Requirement (verbatim) | Investigator | Status | Findings (1-line) |
|---|------------------------|--------------|--------|-------------------|
| 1 | Agent Override editor → **3 layouts by agent type**, compact ≥2-col: **SOLO** (discovery/plancore/ibrain) = main+backup model (col1) + effort/spawn/readiness (col2); **TIERED** (implementer/validator) = L1/L2/L3/L4 grid, model+own-effort per rung, **L4 optional/default-none**, ladder IS the backup (no separate backup field), start-rung chosen by task complexity (skip to L2/L3 to save tokens — existing Helm concept); **PLANNER** = remove all standard fields, panel-only (panel already built); **TEAMS** (deliberation/red-team, panelist) = team setup. Backend deltas: per-rung effort (currently per-agent only), optional 4th ladder rung. | grok-4.5 (inv-1) | investigating | _(pending)_ |
| | **JROM clarifications (2026-07-22):** (1) planner drawer = panel only, strip L1/effort/backup/spawn/readiness — planner is a different (team-style) setup; solo=discovery/plancore/ibrain, tiered=implementer/validator, + team setup. (2) L4 optional, default none. (3) yes per-rung effort. (4) L1-4 = the backup+escalation chain; complexity-tagged atomic tasks start at the right rung (L2/L3) instead of wasting L1. | | | |
| 1b | **Teams = planner-style panel.** deliberation-team + red-team get almost the same setup as the planner panel: dynamic member list (add/remove); **default set in Agent Studio, overridable per-project**. (Extends item 1's layout work.) **DECISION (JROM 2026-07-22): REUSE the planner-panel machinery** (`project_planner_panel`/`PlannerPanelService`/panel UI) for teams — do NOT keep the separate `team_members` path. One panel mechanism for planner + deliberation + red-team. | grok-4.5 (inv-2, part A) | investigating | _(pending)_ |
| 2 | **Show the ACTUAL model, not "default"/"inherit"/"[Agent default]".** Everywhere in Project Setup, display the real resolved model name (from Agent Studio's global default) so JROM doesn't cross-reference another screen. Keep the inherited-vs-project-override distinction visible. (panelist currently shows "default" = no default_model_id set.) | grok-4.5 (inv-2, part B) | investigating | _(pending)_ |
| 3 | **Unified agent list + classification + dynamic Agent Studio.** (a) Remove the Solo/Team tab split → one list. (b) Add a `solo/tiered/team` **classification** per agent, shown on the list — this is THE key that selects the item-1 override layout (solo/tiered/team-panel). (c) Agent Studio becomes dynamic: creating a new agent = pick class (solo/tiered/team) + configure per type. Mapping: solo=discovery/plancore/ibrain, tiered=implementer/validator, team=planner/deliberation/red-team. **DECISION (JROM 2026-07-22): panelist is OBSOLETE** — remove it (not a classification; team members come from the panel machinery, not standalone panelist agents). Unbind from projects + retire the agent. | grok-4.5 (inv-3) | investigating | _(pending)_ |

---

## Build topology (JROM-locked 2026-07-22)
grok is at 50% (resets Sat) → workhorse to burn before reset; codex + claude refreshed → codex = grok
6h-logout backup, claude = high-value escalations. **Critical wiring:** backup-on-grok-logout needs the
availability probe to check grok's token expiry (auth.json `expires_at`), else grok logout trips the #53
auth-pause instead of failing over.

| Role | Primary | Backup (grok logout) |
|---|---|---|
| plancore/projcore | grok-4.5 | codex-5.5 |
| ibrain | grok-4.5 | codex-5.5 (assumed) |
| discovery | opus | — |
| implementer L1 | grok-4.5 | luna |
| implementer L2 | grok-4.5 | terra |
| implementer L3 | sonnet-5 | — |
| validator L1 | codex-5.5 | — |
| validator L2 | codex-5.5 | — |
| validator L3 | opus | — |
| planner panel | opus (lead) + sol | — |

## Teams decision (SUPERSEDED → RESOLVED 2026-07-22)
Original "just use it / reuse the planner-panel machinery" was found by the co-author + inv-2 to require
rewiring the orchestrator + reseeding (runtime reads team_members via resolveProjectRole). **JROM
confirmed (verbatim):** *"if it would rewire them, then lets just upgrade the UI on how it shows rather
than changing what or how its used on the background."* → **Teams = UI presentation upgrade only**
(planner-style member-slot UI); backend consumption untouched; per-project override delivered additively
(opt-in) or deferred. See decisions.md DEC-6.

## Investigation notes
_(full grok-4.5 findings in tmp/investigate-item{1,2,3}-report.md)_
