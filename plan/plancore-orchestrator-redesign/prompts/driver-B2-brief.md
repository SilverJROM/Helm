# [driver] Slice B2 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Purpose `plan-draft`:** move the **schema / R-XX / task-JSON contract** currently living in `generatePlanningBrief` (`brief-writer-service.ts:308–328`, also og-requirements order `:308–312`) into the draft brief. Instruct: write **only** seat-scoped paths from params (never canonical `plan.md` / `og-requirements.md`); emit `DRAFT-SUBMITTED plan=<sha12>` after atomic self-hash (non-authoritative). Context injection: absolute paths to north-star.md, conversation-log.md, decisions/ only. No “agree with partner,” no verdict grammar.

## Acceptance criteria (ACs)
R2.8,R2.5,R2.7,R1.1

## Focused tests (the row's acceptance)
`npx vitest run src/services/brief-writer-plan-draft-purpose.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 28min · deps: B1 · impl_tier=L2 · val_tier=L2 · budget=32
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
