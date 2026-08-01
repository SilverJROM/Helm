# [driver] Slice B4 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Delete `generatePlanningBrief` entirely** (`brief-writer-service.ts:268–351`) — not repurposed (R1.1). Update/remove tests that call it (`brief-writer-a12-split-brain.test.ts`, `brief-writer-plan-ready-not-agreement-c9.test.ts`, `brief-writer-plan-schema.test.ts`, `dispatch-service.test.ts` planning clause, `brief-writer-q11.test.ts`, `brief-writer-focus-contract.test.ts` planning cases). **Do not touch** `generateBrainBrief` (`:496–558`). Token-free: `rg generatePlanningBrief src/` returns only historical comments or zero production defs. Structural signal that plancore is not an authoring seat.

## Acceptance criteria (ACs)
R1.1,R1.3

## Focused tests (the row's acceptance)
`npx vitest run src/services/brief-writer-planning-brief-deleted.test.ts src/services/brief-writer-q11.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 24min · deps: B3 · impl_tier=L2 · val_tier=L2 · budget=28
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
