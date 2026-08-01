# [driver] Slice B3 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Purposes `plan-reconcile` + `plan-signature`.** Reconcile: receives **both** round-1 draft paths + defect list (if any); authors **one** candidate at candidate path; emit `CANDIDATE-SUBMITTED plan=<sha12>`; includes same task-JSON schema as B2 (R2.8). Signature: receives **only** candidate path + expected short12 line (mirror B5 bind style at current `generatePanelBrief` `:469–471`); may `SIGNED plan=<sha12>` **or** numbered bounded objection list — **never** a competing draft; **never** `PLAN-READY` as agreement. R5.19: existing `diff-review` render-contract test asserts **no** draft-authoring / reconcile instructions.

## Acceptance criteria (ACs)
R2.8,R3.10,R3.11,R3.14,R5.19

## Focused tests (the row's acceptance)
`npx vitest run src/services/brief-writer-plan-reconcile-signature.test.ts src/services/brief-writer-diff-review-unaffected.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: B2 · impl_tier=L3 · val_tier=L2 · budget=34
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
