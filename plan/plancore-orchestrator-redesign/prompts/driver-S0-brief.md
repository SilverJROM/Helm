# [driver] Slice S0 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Safety pins before any redesign edit.** Token-free assertions: (1) `grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts` == 3 (8024452 / A0 survival); (2) `HELM_SESSION_JANITOR` is not enabled in project defaults / stays `0` wherever this repo pins it; (3) `generateBrainBrief` still exists at `brief-writer-service.ts:496` and still contains the Phase-C “Wakes plancore to surgically revise THIS slice” line (~`:523`) — **presence pin, not edit**; (4) no new production import of `worker-runtime-finalize.ts` from new modules. New test file only — no production edits.

## Acceptance criteria (ACs)
R6.20,R6.22,R6.23,R1.3

## Focused tests (the row's acceptance)
`npx vitest run src/services/plancore-redesign-safety-pins.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 18min · deps: — · impl_tier=L1 · val_tier=L1 · budget=22
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
