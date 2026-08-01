# [driver] Slice R2 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Round 1 = dual blind draft, not review.** Replace reviewer-only `spawnRoundSeats` path for the initial draft phase: spawn **both** configured co-planner seats (`coPlannerSeats` / partnerCount logic at `:476–481`) with `purpose:'plan-draft'`, seat-scoped write targets, isolation allowlists from D2. Wait for each `DRAFT-SUBMITTED` (or first-callback + file commit); **engine recomputes** hashes via D1. C5 fresh seats (R6.20). **No** write to canonical plan/req. Extends C7 watchdog to draft seats. Register regression mode `blind-draft-isolation`.

## Acceptance criteria (ACs)
R2.5,R2.6,R2.7,R6.20,R6.24

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-review-round-blind-draft.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: R1,D2,B2,D3 · impl_tier=L3 · val_tier=L2 · budget=34
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
