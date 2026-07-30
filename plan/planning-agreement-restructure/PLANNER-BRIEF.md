# PLANNER BRIEF — effort `planning-agreement-restructure`

**From** `[north]` `helm-97`, 2026-07-30 06:5x PHT. You are a **planner**. Author a plan. Implement nothing.

## Read in this order, in full

1. `plan/planning-agreement-restructure/north-star.md`
2. `plan/planning-agreement-restructure/og-requirements.md` — **23 ACs, P0-P3, SCOPE SOURCE OF TRUTH**
3. `plan/planning-agreement-restructure/PANEL-SYNTHESIS.md`
4. `plan/planning-agreement-restructure/topology.yaml` — your tier ladder
5. `plan/_panels/planning-path-review/findings-*.md` — raw panel evidence (1,042 lines, 3 seats)

All paths are relative to `/home/agjrom/websites/Helm`.

## Context you must internalise

This is **attempt 3+** at fixing Helm planning. The four prior fixes were all *correct* and all changed
an agent **brief**. **A brief is not a protocol.** Your plan must move invariants into the **engine**.

**The keystone:** there is **no `transport.send`** in `planning-phase-service.ts` — only `spawn`, `reap`,
`inspectSeat`, and `inspectSeat` runs only for `brainRole` (`:461`). A partner whose CLI turn has ended
**cannot be re-engaged by anything**. Therefore each review round must **spawn a FRESH seat** against the
current plan hash. A plan that assumes a seat can be re-prompted is dead on arrival.

## Deliverable

`plan/planning-agreement-restructure/plan-<yourmodel>.md` — where `<yourmodel>` is `grok45`, `opus5`, or
`sol`, matching the seat you are.

A slice table, helm-algo-digestible, exactly these columns:

```
| id | scope | acs | tests | est_min | deps | impl_tier | val_tier | deliberation | redteam | budget |
```

## Hard planning rules

- **Every non-test slice UNDER 30 minutes.** Over 30 = split it. Tight diff, 1-3 tests each.
- **ORDER IS NON-NEGOTIABLE: P0 → P1 → P2 → P3.** Encode it in `deps`. **P1 before P2, always** — P1
  makes the system safe while still broken; P2 makes it work. Never build convergence on a fail-open gate.
- **P0/P1 are safety-critical:** `impl_tier` L2/L3, `val_tier` L2 minimum, `redteam: elite`. **Never L1.**
  P0 touches the E5-class path that already marked a live session reapable; P1 rewrites the agreement gate.
- **Every AC maps to at least one slice.** Cite AC numbers in the `acs` column. No orphans.
- **AC23 (token-free regression tests) is NOT optional and NOT one slice** — spread each test across the
  slice whose behaviour it pins.
- **Cite `file:line`** for every mechanism you plan to change. The panel already did the archaeology —
  use it, do not redo it.
- **Commit `8024452`** (convene-race fix, **proven on run 32**) **MUST SURVIVE.** Do not plan over it.
  `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` must stay `3`.
- Do not plan a merge to `main` (SD10). Do not plan to enable `HELM_SESSION_JANITOR`. Do not touch
  cycle 13's data.

## Working rules

**Work ALONE.** Do not read the other planners' output. Divergence is the point — `[north]` synthesises
the three into one plan.

End your run with the literal line: `PLAN-DONE <yourmodel>`
