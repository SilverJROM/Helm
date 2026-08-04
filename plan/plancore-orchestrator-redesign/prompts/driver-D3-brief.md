# [driver] Slice D3 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**NEW pure** `src/services/proposer-role.ts`: `designateRound2Proposer({seatA, shaA, seatB, shaB})` → lower full `sha256` (not short12) wins proposer for round 2; tie-break: lexicographically lower `seatId` (document + test). `rolesForRound(round, round2ProposerSeat, seatA, seatB)` → round 2 as designated; round 3 **swaps**; round 4 swaps again. `formatProposerLog(...)` returns auditable string including both shas + rule name `lower-sha256-of-round1-drafts`. No I/O.

## Acceptance criteria (ACs)
R3.9,R3.12

## Focused tests (the row's acceptance)
`npx vitest run src/services/proposer-role.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 20min · deps: S0 · impl_tier=L2 · val_tier=L1 · budget=24
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
