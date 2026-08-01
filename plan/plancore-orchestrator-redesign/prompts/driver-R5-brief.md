# [driver] Slice R5 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Agreement = signature on candidate bytes (B5 re-point).** New `waitForCandidateSignature` (ROUND-local or PPS helper used only by new path): signer’s `SIGNED plan=<sha12>` (or agreed grammar) must equal `readPlanRevision(candidatePath).short12` recomputed at check time; missing/malformed/stale SHA never agrees (R6.21). Engine sets `agreed:true` only here — seats never emit a status meaning “plan ready to use” (R3.14). Retire use of brain `PLAN-READY` inside this path. Keep old `waitForAgreement` intact for tests until P3.

## Acceptance criteria (ACs)
R3.11,R3.14,R6.21

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-review-round-signature-gate.test.ts src/services/planning-phase-current-plan-sha-b5.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: R3,B3 · impl_tier=L3 · val_tier=L2 · budget=34
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
