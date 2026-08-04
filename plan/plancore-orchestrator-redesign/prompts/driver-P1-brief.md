# [driver] Slice P1 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**PPS: no model call for plancore during initial whole-plan authoring (R1.2).** Remove `generatePlanningBrief` call (`:433–443`), plancore spawn-retry loop (`:480–524`), and `writeBrief(..., 'plancore', ...)` as an authoring seat (`:447`, `:528`). Engine injects context paths into ROUND options (north-star / conversation-log / decisions already read at `:394–411`). Keep `brainRole` / `plancore` **label** in logs, staffing (S05/S06), topology — no renames (R1.3). Terminal owner `runPlanningTerminal` (`:472–477`) still reaps whatever ROUND pushed into `partnerHandles` / `partnerRuntimeIds` — **do not** restructure A5/A6.

## Acceptance criteria (ACs)
R1.2,R1.3

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-phase-no-plancore-author.test.ts src/services/planning-phase-service.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: B4,R2 · impl_tier=L3 · val_tier=L2 · budget=34
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
