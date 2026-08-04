# R7 validator red-team pass — attempt 1

Commit under review: 10cc7bf997476e71928866f110c9c311ecc589de

Focused command:

`npx vitest run src/services/planning-review-round-block-diff.test.ts --minWorkers=1 --maxWorkers=4`

Result: PASS (6 tests passed).

## Lens 1 — AC coverage (R3.15)

PASS. On proposer/signer terminal non-convergence, `blockedReason` now carries
`NON-CONVERGENCE-DIFF (R3.15)` plus a textual unified-style hunk/body. The helper includes candidate
metadata, signer last draft metadata, readable content deltas, and final objections. It is not a bare
hash pair.

## Lens 2 — Monotone-fail behavior

PASS. The early `objection-not-monotone` return appends the same non-convergence diff suffix before
returning and preserves the existing typed cause. It does not burn later round-cap slots.

## Lens 3 — Cap exhaustion behavior

PASS. `toReviewRoundResult(..., runDir)` is used for proposer/signer cap exhaustion and attaches the
final-positions report for objections, signature mismatch, signer silence, candidate-not-committed, and
other non-agreeing proposer/signer outcomes. Legacy non-proposer/signer reviewer timeout has no final
candidate/signer position to compare, so the absence of this R7 diff there is acceptable for this slice.

## Lens 4 — PlanningResult / DB-shaped fields

PASS. Existing `PlanningResult` fields (`blockedReason`, `blockedReasonKind`, `roundsAttempted`) remain
unchanged and the R7 operator report is carried through `blockedReason`, which is the visible DB-shaped
field already returned by planning phase. The new `nonConvergenceDiffPath` is additive on
`ReviewRoundResult` only; `blockedReason` includes the full report path and summary.

## Lens 5 — Regression risk

PASS. The agreed path does not write a non-convergence report. Existing `RoundBlockedReasonKind` values
are preserved instead of widening consumers unnecessarily. The helper writes under the run directory's
`planning-drafts/non-convergence-diff.txt` path and handles unreadable sides with prose rather than
falling back to hash-only output.

Residual risk: the in-process LCS diff is O(n*m). Current planning artifacts are bounded enough for the
focused path, but a future very large plan could need a line cap or streaming summary.
