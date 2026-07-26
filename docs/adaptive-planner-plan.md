# Adaptive tiered planning — build spec v2 (post grok-4.5 red-team, JROM-approved path B)

Re-architect Helm planning so `plancore` is a pure DRIVER and a configurable planner panel AUTHORS the
plan, with authoring DEPTH routed per-task-cluster to save tokens without losing quality. v2 folds in the
grok-4.5 red-team (verdict NEEDS-CHANGES → these fixes). Rollout = **path B**: build behind an opt-in
flag, instrument from day 1, validate savings on imgedt's first real planning run.

## Roles (unchanged intent, hardened)
- **plancore = DRIVER only.** Routes inputs, orchestrates tiers, holds gates, logs. **Never writes task
  prose and never "decides" content.** May only choose PROCEDURE (settle vs block) at deadlock.
- **lead_planner (planner_01) = top-tier model.** Drafts the skeleton + `plan_depth` tags AND is the
  **integrator** (assembles the merged plan.md). Panel authors slices; lead may not silently override
  A-settled text (must log).
- **planner panel = N members, default 2, per-project configurable.**

## FIX 1 (P0) — the SKELETON is the quality gate, not escalation
- Lead drafts skeleton = task_keys + one-line intents + `plan_depth` tags (NO full specs yet).
- **One panelist challenges the CUT** via the closed protocol (below): missing-task list, dep-DAG check,
  false-atomic flags, coverage. Hard gate before ANY authoring:
  every requirement has ≥1 task_key · no orphan deps · no xhigh cluster without a shared-contract task.
- Escalation outcomes INCLUDE re-cut: `ESCALATE_RECOMPOSE` (merge/split/add-task/add-dep), not just
  "author deeper." Drop the false claim that mis-triage "never" hurts quality — the skeleton gate is the
  real control; escalation is a backstop.

## FIX 2 (P0) — convene by TIER/BATCH, never per-task spawns
Per-task PROCESS convening is a latency/token bomb (Helm spawns are minutes-scale, PanelService is
sequential). Instead:
1. Skeleton (dual-read) → partition tasks into `solo_set`, `B_set`, `A_set` (cluster A by affinity).
2. **solo:** lead authors the whole solo_set in ONE pass, no reviewer.
3. **B:** ONE pass — lead drafts the whole B_set; one critic amends the set.
4. **A:** ONE pass per affinity cluster — panel drafts the cluster INDEPENDENTLY, in **parallel** seats,
   reconcile once. (Fix/replace PanelService sequential spawn first, or spawn in parallel directly.)
Per-task rows persist for telemetry; per-task spawning does not.

## FIX 3 (P1) — route on PLAN_DEPTH, not `complexity`
`complexity` (low|med|high|xhigh) = implementation/model-rung difficulty. Planning depth tracks planning
UNCERTAINTY and is often uncorrelated. Add a distinct signal:
- `plan_depth: solo | pair | panel` (the routing key), derived by the lead from a small vector it must
  justify: `{cross_cutting, ambiguity, blast_radius, novelty}`. Kept SEPARATE from `complexity` in the
  schema + briefs (implementers keep reading `complexity` as effort; planners write `plan_depth`).

## FIX 4 (P1) — machine-closed critic protocol (testable, not vibes)
```
CRITIQUE-READY
verdict: ACCEPT | AMEND | ESCALATE
severity: soft | hard
reasons: [cross_cutting | missing_deps | unsafe_solo | contradicts_decision | false_atomic | needs_JROM | ...]
patch: <optional structured deltas>
```
Only `ESCALATE`+`hard` burns a tier step (solo→B, B→A). Under-tag flagged `cross_cutting` may jump
straight to A. Deadlock on A → **settle-pair** (named models; explicit for N=2) writes the settled task,
plancore logs `SETTLED` + dissent; still conflicting / `needs_JROM` → BLOCK to operator. plancore never
authors.

## FIX 5 (P2) — solo backstop
After the solo_set lands, ONE cheap binary audit pass over the solo_set only ("any false-solo?"), plus a
heuristic auto-promote (atomic_work touching hardened modules / cross-cutting keywords → B) at skeleton
time. No solo task ships with zero second read on a systemic basis.

## FIX 6 (P2) — integration + coherence gate
Lead assembles the merged `plan.md` (integrator). Before PLAN-READY, plancore runs STRUCTURAL gates only
(no prose): schema valid · coverage matrix · **whole-plan contradiction pass wired to the existing
plan-contradiction machinery as a HARD gate** · dep-cycle check · duplicate atomic_work check.

## FIX 7 (P2) — isolation + rollout
- Feature flag `adaptive_planning` per project, default OFF. OFF → the EXISTING `runPlanningPhase`
  untouched (no shared "refactored helpers" in v1).
- ON → NEW module `adaptive-planning-phase.ts`. No conditionals sprinkled in the old file.
- Emits the SAME canonical `plan.md` / `og-requirements.md` so the implementation ingest contract is
  unchanged.
- One live smoke (imgedt) before any thought of default-flipping.

## Telemetry (path B — the savings must be MEASURED, not asserted)
run_events: `PLAN_SKELETON_GATE` (pass/fail + coverage), `PLAN_TIER_ROUTED` (histogram solo/B/A),
`PLAN_TIER_ESCALATED` (from→to + reason), `PLAN_SETTLE` / `PLAN_BLOCK`, and per-stage token/spawn counts
(`plan_tokens_by_stage`, `spawn_count`). imgedt's first run produces the baseline; kill/tune if batched
adaptive doesn't beat today's single-author path on tokens + wall-clock.

## Build stages
1. **Foundation:** ✅ DONE (2026-07-21). v92 migration adds `projects.adaptive_planning` (default 0, CHECK);
   projectService exposes it; `runPlanningPhase` delegates to the new `adaptive-planning-phase.ts` module
   when ON, existing path byte-identical when OFF; module scaffold carries the types (PlanDepth, closed
   Critique protocol, PlannerPanel) + telemetry event names, guarded until stages 2-4 land. 5 tests +
   tsc clean; migration verified on a live-DB copy (both projects preserved, all default 0). NOT yet
   deployed to :3110 (default-OFF, no urgency — deploy at a functional milestone).
2. **Skeleton dual-read gate** ✅ DONE — lead draft + panelist challenge (closed Critique) + hard coverage gate.
3. **Batch-tier authoring** ✅ DONE — solo/B/A sets, parallel A seats, escalation w/ re-cut.
4. **Integration + structural gates** ✅ DONE — lead integrator, contradiction/coverage hard gates, same plan.md.

**Build record (2026-07-21):** grok-4.5 implementer built 2–4 → grok-4.5 validator FAILed it on a real
driver-purity leak (plancore synthesizing task prose on the real path) → implementer fixed F1 (real path
BLOCKs, synthesis fixture-only) + F2 (real settle-pair spawn) → validator PASS → opus own-check confirms:
typecheck 0, 95/95 tests, OFF path byte-identical (isolation intact), all FIX 1–8 pass. In code, NOT
deployed (live engine still v91), default-OFF, not tied to any project.
5. **Tests + telemetry + deploy :3110 + imgedt first-run validation.**

## What grok validated as sound (keep)
plancore-as-driver (if it truly never writes prose), opt-in flag, adaptive-depth-in-principle, event
logging, stable ingest contract.
