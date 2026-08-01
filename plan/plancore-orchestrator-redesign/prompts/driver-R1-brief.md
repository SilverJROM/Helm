# [driver] Slice R1 — deterministic brief (run plancore-orchestrator-redesign)

## Scope (verbatim from hardened plan row — do ONLY this)
**Re-scope C3, do not delete** (`checkArtifactsPublished` `planning-review-round.ts:175–216`, gate `:451–464`). Round-2+ (and post-draft gates) check **relevant seat-scoped draft or candidate** exists, non-empty, and candidate/plan side parses via `validateExecutionPlan` when the artifact is a plan document — **never** require canonical `plan.md`/`og-requirements.md` before promotion (those stay absent until P2). Round-1 pre-spawn gate: only that runDir + context inputs exist (or no artifact gate). Real-mode only / fake exempt preserved.

## Acceptance criteria (ACs)
R4.16

## Focused tests (the row's acceptance)
`npx vitest run src/services/planning-review-round-c3.test.ts src/services/planning-review-round-gate-rescoped.test.ts --minWorkers=1 --maxWorkers=4`

## Contract
- estimate: 26min · deps: B2,D1 · impl_tier=L2 · val_tier=L2 · budget=30
- Verifier ≠ fixer. Do NOT widen scope beyond the row (any widen = re-plan/EDGE).
- End your terminal DONE callback with the VERDICT-V1 line (see design/VERDICT-V1.md).
