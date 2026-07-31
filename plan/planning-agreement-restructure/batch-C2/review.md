# review.md — Batch C2 (implementer self-check)

**Verdict:** READY for independent validator
**AC11:** Engine owns the review round machine — this slice creates the seam (`runReviewRound`), no
round-machine semantics yet.

## Checklist

| Check | Status |
|-------|--------|
| Only `planning-phase-service.ts`, new `planning-review-round.ts`, new C2 test file touched | Yes |
| Partner-spawn loop extracted verbatim (same seat/batch-id logic, same brief params, same spawn params) | Yes |
| Single `waitForAgreement` call extracted verbatim (same args, same `isFake ? undefined : planMdPath` gating) | Yes |
| `waitForAgreement`/parser helpers stay on `PlanningPhaseService`, untouched | Yes — verified B3/B4/B5 direct-private-method tests still pass unmodified |
| `runPlanningPhase` remains owner of plancore spawn, canonical poll/read/ingest, terminalization, return shape | Yes — none of that code moved or changed |
| `partnerHandles`/`partnerRuntimeIds` passed by reference (not returned) so a mid-loop throw doesn't lose already-spawned seats | Yes — dedicated regression test (`planning-review-round-c2.test.ts`, case 4) |
| `planning-review-round.ts` has no fs/DB access, no importers beyond `planning-phase-service.ts` | Yes |
| No schema/migration/external runtime behavior added | Yes |
| No edits to `src/index.ts`, schema files, brief-writer/parser/ingest files | Yes |
| Own new unit-test file is the gate | Yes — 4/4 PASS |
| No schema version invented | N/A |
| `npx tsc --noEmit -p tsconfig.json` | PASS (whole project) |

## C3–C8 boundary

Nothing in this slice implements revise/fresh-seats/blocked-exit semantics. `runReviewRound` returns a
plain `{agreed, partnerBatchIds}` — the same shape of information `runPlanningPhase` already consumed
inline. C3 (artifact-publication gate) is the next slice in the round wave and owns
`planning-review-round.ts` from here.

## Residual note (pre-existing, not this slice's scope)

While re-running the broader (non-gate) `planning-phase-service.test.ts` file as an extra sanity check
beyond the brief's named re-verification list, one test —
`POCFIX8 (a): real !fake path uses long waitForAgreement timeout...` — times out at its hardcoded 12s
limit, which then cascades (`process.env.USE_FAKE_TMUX` never gets restored by its `finally` block) into
~21 subsequent failures in the same file. **Confirmed via `git stash` that this reproduces identically
on the pre-C2 baseline** — same test, same timeout, same cascade, zero relation to this extraction. Not
fixed here (out of scope: touching it would mean editing a test file outside C2's three-file allowlist
and chasing an unrelated pre-existing flake inside a 28-minute slice). Flagging for `[north]`/projcore to
triage separately; does not block this slice's own gate (A0/A5/A6/B3-B6/C2 dedicated files are all green).

## Evidence

See `test-report.md`.
