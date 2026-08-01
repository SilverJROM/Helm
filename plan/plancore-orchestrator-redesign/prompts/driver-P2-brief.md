# [driver] Slice P2 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Promotion + failure rename.** On `agreed` from ROUND: engine **atomically** copies candidate → canonical `plan.md` + `og-requirements.md` under `canonicalArtifactRoot` (only writer of those paths — R2.5, R3.14). Rename throw at `:689–690` from `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN` → `NO-AGREED-PLAN-CANDIDATE` (or equivalent candidate/signature-shaped token) (R1.4). Keep B6 discipline: non-agreement returns **before** poll/ingest (`:583–611`). `planMdPathForRaceGuard` count stays 3.

## Acceptance criteria (ACs)
R1.4,R2.5,R3.14

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-phase-candidate-promote.test.ts src/services/planning-phase-nonconvergence-b6.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: P1,R5 · impl_tier=L3 · val_tier=L2 · budget=34
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
