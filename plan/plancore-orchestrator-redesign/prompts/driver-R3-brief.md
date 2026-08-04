# [driver] Slice R3 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Divergence → asymmetric proposer/signer (not dual reconcile).** On round-1 hash mismatch: call D3 designate; log rule; fresh-spawn proposer with `plan-reconcile` + **both** drafts; fresh-spawn signer with `plan-signature` + **only** candidate (R3.10). On round-1 hash **match**: engine may set candidate = that byte content without a model reconcile, still requiring a signature round **or** document auto-agree only when both drafts’ engine hashes are equal (prefer **signature still required** for one uniform promotion path — implement auto-agree only if tests prove no loss of R3.11). Remove any path that asks both seats to each author a new full draft.

## Acceptance criteria (ACs)
R3.9,R3.10,R3.11

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-review-round-proposer-signer.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: R2,D3,B3 · impl_tier=L3 · val_tier=L2 · budget=34
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
