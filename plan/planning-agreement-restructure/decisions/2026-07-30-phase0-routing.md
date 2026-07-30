---
date: 2026-07-30
project: Helm
type: autonomous-call
trigger: Phase 0 intake for planning-agreement-restructure
source: projcore
priority: high
search_hooks: [planning-agreement-restructure, tiller, base-commit, wave-plan]
---

**Decision:** Use the stamped plan folder as the run directory and dispatch Wave 0 using the active projcore tmux/gateway path.

**Counterfactual:** The Codex projcore default is Tiller mode after Phase 0.

**Reasoning:** The project packet and `north-star.md` say Tiller is a non-goal for this Helm effort, and the user explicitly instructed "Start with Wave 0: A0, B1, C1, D12-skeleton — four seats, zero shared files" plus standing auto-drain. `WAVE-PLAN.md` supersedes `plan.md` dependency order. Topology validation passed.

**Base note:** The briefing packet has an older base line `b11ef58`, while the user message and current repository state are `e461468`. The current user instruction and actual HEAD are treated as authoritative.
