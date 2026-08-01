# [driver] Slice X1 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**R6.24 regression sweep rewrite — not a skip skeleton.** Replace `src/planning-regression-index.test.ts` so every historical mode **and** new modes resolve to at least one **active** behavioral test (import or subprocess), not `it.skip`. Historical seven (from prior AC23): convene-before-artifacts; BROKEN→revise→CLEAN (now BROKEN→reconcile→SIGNED); partner1 CLEAN + partner2 BROKEN (re-point to dual-signer impossibility / dual-draft mismatch); partner silent until timeout; legacy path refuses when north-star exists; ibrain row count unchanged on planning block; stale-CLEAN/SIGNED rejected across revisions. **New modes:** blind-draft-isolation; proposer-signer-role-integrity; alternation; objection-monotonicity; atomic-candidate-promotion. Unresolved/skipped entry → **fail** the suite. Spread registration is done in R2/R4/R6/R8/P2; X1 only enforces.

## Acceptance criteria (ACs)
R6.24,R6.20,R6.21

## Focused tests (the row's acceptance)
`npx vitest run src/planning-regression-index.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: R8,P3,P4 · impl_tier=L2 · val_tier=L2 · budget=32
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
