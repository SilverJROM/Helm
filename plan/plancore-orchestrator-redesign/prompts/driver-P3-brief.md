# [driver] Slice P3 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Fail-closed signature path on PPS boundary + legacy gate hygiene.** Ensure production non-adaptive path no longer requires brain `PLAN-READY` for agreement (`waitForAgreement` `:1047–1048`, `:1087` brain half). Either: (a) non-adaptive path never calls old `waitForAgreement`, only ROUND’s signature wait; or (b) extend `waitForAgreement` with a mode that skips PLAN-READY when `signatureOnly:true`. Stale/missing SHA still fail closed (R6.21). Update fixtures that seed plancore PLAN-READY lines for non-adaptive unit tests that now exercise the new path. **Do not** loosen B5.

## Acceptance criteria (ACs)
R3.11,R6.21,R3.14

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-phase-current-plan-sha-b5.test.ts src/services/planning-phase-signature-path.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: P2,R5 · impl_tier=L3 · val_tier=L2 · budget=34
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
