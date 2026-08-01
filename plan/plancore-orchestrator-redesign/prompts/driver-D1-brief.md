# [driver] Slice D1 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**NEW pure-ish module** `src/services/seat-draft-store.ts`: path helpers `draftPlanPath(runDir, seatId)`, `draftReqPath(runDir, seatId)`, `candidatePlanPath(runDir)`, `candidateReqPath(runDir)`; `atomicWriteFile(path, bytes)` = write temp sibling + `rename` (R2.7); `hashDraft(path)` reuses `readPlanRevision` from `plan-revision.ts:35` (engine recomputes; never trusts callback claim). Canonical `plan.md` / `og-requirements.md` helpers **not** written here — promotion stays engine-side in P2.

## Acceptance criteria (ACs)
R2.5,R2.7

## Focused tests (the row's acceptance)
`npx vitest run src/services/seat-draft-store.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 22min · deps: S0 · impl_tier=L2 · val_tier=L1 · budget=26
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
