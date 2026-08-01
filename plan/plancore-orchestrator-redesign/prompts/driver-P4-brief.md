# [driver] Slice P4 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**R7 explicit scope pin — adaptive untouched.** Assert `runPlanningPhase` still early-returns at `:356–365` when `adaptivePlanning` truthy **before** any new draft/signature code. Add a short code comment at that branch citing R7 / deferred backlog. No behavioral change to `adaptive-planning-phase.js`. File backlog note under `plan/plancore-orchestrator-redesign/decisions/` or effort decisions: reconcile adaptive co-author contract later.

## Acceptance criteria (ACs)
R7.25

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-phase-adaptive-scope-pin.test.ts src/services/adaptive-planning-foundation.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 18min · deps: P1 · impl_tier=L1 · val_tier=L1 · budget=22
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
