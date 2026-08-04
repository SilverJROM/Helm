# [driver] Slice R8 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Retire plancore whole-plan revise actuator.** Delete/stop calling `generatePlanRoundReviseBrief` (`:311–354`) and the C6 spawn block (`:690–726`) that uses `brainRole` / `planningBrainModel` for mid-round plancore rewrite. Reconcile rounds **are** the revise path (proposer co-planner only). Preserve C8 same-plan-broken classification concepts where they still apply to signature refusals, or map them onto objection evidence. Update `planning-review-round-c6.test.ts` to expect proposer reconcile, not plancore. Register `role-integrity` sweep mode.

## Acceptance criteria (ACs)
R3.10,R3.14,R1.2,R6.20

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-review-round-c6.test.ts src/services/planning-review-round-no-plancore-revise.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: R5,B4 · impl_tier=L3 · val_tier=L2 · budget=34
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
