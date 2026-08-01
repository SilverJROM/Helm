# [driver] Slice B1 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**`generatePanelBrief` gains required exhaustive `purpose` with no default** (`brief-writer-service.ts:433`). Union at minimum: plan-draft, plan-reconcile, plan-signature, task-conflict-reconvene, diff-review. **Re-verify callers at implement time** (R5.17): today `planning-review-round.ts:511`, `planning-phase-service.ts:952`, `panel-service.ts:63`, `panel-service.ts:123`. Migrate reconvene→task-conflict-reconvene and both panel-service sites→diff-review (bodies unchanged). ROUND temporarily uses diff-review (empty implementedDiff) so current verdict text survives until R2/B3. Typecheck must fail if a caller omits purpose.

## Acceptance criteria (ACs)
R5.17,R5.18,R5.19

## Focused tests (the row's acceptance)
`npx vitest run src/services/brief-writer-panel-purpose-b1.test.ts src/services/brief-writer-panel-plan-contract-b2.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: S0 · impl_tier=L2 · val_tier=L2 · budget=32
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
