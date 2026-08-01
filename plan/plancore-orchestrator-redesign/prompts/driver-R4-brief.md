# [driver] Slice R4 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Alternation + explicit 3-round role-swap test (R3.12).** Wire `rolesForRound` into the round loop (`:605+`). **Mandatory test:** fixture with forced non-signature for rounds 2 and 3; assert round-2 proposer seat id == designate(round1); round-3 proposer == the other seat; round-4 == round-2’s proposer again. Fail if one seat holds the pen every round. Register sweep mode `proposer-signer-alternation`.

## Acceptance criteria (ACs)
R3.12,R6.20,R6.24

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-review-round-alternation.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 26min · deps: R3 · impl_tier=L3 · val_tier=L2 · budget=32
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
