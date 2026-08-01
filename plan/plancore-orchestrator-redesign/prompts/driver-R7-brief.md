# [driver] Slice R7 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Non-convergence = visible BLOCKED + diff, not bare hash pairs (R3.15).** On cap exhaustion / monotone fail: `blockedReason` includes a **textual diff** (or structured hunk summary) between final candidate and signer’s last objection set / last draft positions — operator-legible. Extend `RoundBlockedReasonKind` if needed. `[DB]`-shaped fields remain on `PlanningResult`.

## Acceptance criteria (ACs)
R3.15

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-review-round-block-diff.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 24min · deps: R6 · impl_tier=L2 · val_tier=L2 · budget=28
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
