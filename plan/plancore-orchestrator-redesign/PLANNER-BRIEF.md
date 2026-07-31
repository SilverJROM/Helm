# PLANNER BRIEF — effort `plancore-orchestrator-redesign`

**From** `[north]` `helm-97`. You are a **planner**. Author a plan. Implement nothing.

## Read in this order, in full — all paths relative to `/home/agjrom/websites/Helm`

1. `plan/plancore-orchestrator-redesign/north-star.md`
2. `plan/plancore-orchestrator-redesign/og-requirements.md` — **v2, SCOPE SOURCE OF TRUTH, 25 ACs across R1-R7**
3. `plan/plancore-orchestrator-redesign/SYNTHESIS.md` — why v1 was rejected and what replaced it
4. `plan/plancore-orchestrator-redesign/topology.yaml` — your tier ladder

## Context you must internalise

This is the **second** core-contract change to Helm's planning subsystem in 48 hours
(`plan/planning-agreement-restructure`, P0-P2, shipped `93d7cd7`, is the foundation — its round-machine
mechanics carry forward, re-pointed). And **v1 of this effort's own requirements were rejected by an
independent review before any code was written** — the byte-identical-drafts convergence mechanism was
unimplementable (symmetric reconcile instructions produce a swap, never agreement). v2 replaced it with
an **asymmetric candidate + signature protocol**, alternating proposer role each round. That is what you
are planning against. Do not reintroduce symmetric dual-authorship anywhere in your slices.

**One verified citation correction that matters:** `brief-writer-service.ts:523` is the **unrelated**
mid-implementation escalation replan (`generateBrainBrief`) — explicitly preserved, do not touch it. The
actual whole-plan revise path is `planning-review-round.ts:311` (brief) / `:692` (spawn).

## Deliverable

`plan/plancore-orchestrator-redesign/plan-<yourmodel>.md` — where `<yourmodel>` is `grok45`, `opus5`, or
`sol`, matching your seat.

A slice table, helm-algo-digestible, exactly these columns:

```
| id | scope | acs | tests | est_min | deps | impl_tier | val_tier | deliberation | redteam | budget |
```

## Hard planning rules

- **Every non-test slice UNDER 30 minutes.** Split anything larger.
- **Every AC (R1.1 through R7.25) maps to at least one slice.** Cite AC numbers in the `acs` column.
- **Group by file ownership, not by requirement number** — the same lesson from
  `planning-agreement-restructure`'s wave plan applies here. Before finalizing, check which files each
  slice touches (`brief-writer-service.ts`, `planning-review-round.ts`, `planning-phase-service.ts`, the
  new seat-scoped-draft storage, the regression sweep test file) and flag which slices MUST be serial on
  a shared file versus which are genuinely independent.
- **R1 (delete `generatePlanningBrief`) should land early** — it's the structural signal that plancore
  stops being an authoring seat, and other slices depend on that removal being real, not aspirational.
- **The proposer/signer alternation (R3.12) needs its own explicit test** — a 3-round trace asserting
  round 2 and round 3 have swapped roles, not just that agreement eventually happens.
- **R6.24 (the regression sweep rewrite) is not optional and not one throwaway slice** — spread real
  behavioral assertions across the slices whose mechanism they pin, same discipline as P0-P2's AC23.
- **Cite `file:line` for every mechanism you plan to change** — and if a citation in `og-requirements.md`
  itself looks stale when you check it against current source, say so in your plan rather than silently
  trusting or silently "fixing" it without flagging the discrepancy.
- **Verify verifier ≠ fixer** at every val_tier you assign, against `topology.yaml`'s implementer set.
- Do not plan a merge to `main` (SD10). Do not plan to enable `HELM_SESSION_JANITOR`. Do not touch
  `worker-runtime-finalize.ts`, the terminal-owner logic, or the E5-class session-registry path — R6.22
  locks these out of scope.

## Working rules

**Work ALONE.** Do not read the other planners' output. Divergence is the point — `[north]` synthesizes
the three into one plan.

End your run with the literal line: `PLAN-DONE <yourmodel>`
