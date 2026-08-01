# [driver] Slice R6 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Objection monotonicity (R3.13).** Parse bounded numbered defect list from signer rejection; store count per round; if round N+1 defect count is **not strictly smaller** than round N’s against the revised candidate → typed BLOCK early (`blockedReasonKind: 'objection-not-monotone'`) without burning remaining cap. Register sweep mode `objection-monotonicity`.

## Acceptance criteria (ACs)
R3.13,R6.24

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-review-round-objection-mono.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 26min · deps: R5 · impl_tier=L2 · val_tier=L2 · budget=30
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
