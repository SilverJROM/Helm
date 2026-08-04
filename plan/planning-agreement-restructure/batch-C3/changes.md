# changes.md — Batch C3

**Batch:** C3 — Engine artifact-publication gate
**AC:** AC11, AC23
**Branch:** `fix/planning-agreement-restructure`
**Date:** 2026-07-30

## Summary

`runReviewRound()` (`planning-review-round.ts`) now refuses to write any partner brief or call
`transport.spawn` until the current attempt's `plan.md` and `og-requirements.md` both exist, are
non-empty, and are actually parseable. This removes the convene race **structurally** — the partner
brief already carries a CONVENE-RACE-FIX instruction telling every seat to wait-and-recheck rather than
emit BROKEN on an absent artifact, but that only ever worked if every seat's model honored free-text
instructions. The engine no longer depends on that.

## Mechanism

**Before (C2 baseline):** `runReviewRound` went straight from its options into the partner-spawn loop —
no read of `plan.md`/`og-requirements.md` at all; that stayed the caller's (`runPlanningPhase`'s) job,
done later, after agreement.

**After:** a new `checkArtifactsPublished(planMdPath, reqMdPath)` runs first, inside `runReviewRound`,
before the seat loop:
1. Reads `plan.md`. Missing → `plan.md not yet published`. Present but empty (after trim) → `plan.md is
   empty`. Present and non-empty → run it through the SAME `validateExecutionPlan` pipeline ingestion
   already trusts (`execution-plan-parser.ts`); a parse failure → `plan.md does not yet parse as a
   complete plan`.
2. Reads `og-requirements.md` (path derived as `path.join(path.dirname(planMdPath),
   CANONICAL_CYCLE_ARTIFACTS.requirements)` — the two canonical artifacts always share
   `canonicalArtifactRoot`, so this needs no new option threaded through `planning-phase-service.ts`,
   which is out of scope for this slice). Missing → `og-requirements.md not yet published`. Present but
   empty → `og-requirements.md is empty`.
3. Any problem → `runReviewRound` returns immediately: `{ agreed: false, partnerBatchIds: [],
   blockedReason: 'ARTIFACT-NOT-PUBLISHED (C3/AC11/AC23): ...' }`. **Zero partner briefs written, zero
   `transport.spawn` calls.** No throw — same "return, not throw" shape B6 already established for
   non-convergence.
4. No problems → falls through into the existing C2 partner-spawn loop and `waitForAgreement` call,
   byte-for-byte unchanged.

**Real-mode only (`!isFake`).** Under the FAKE fixture harness, `plan.md`/`og-requirements.md` are
synthesized by the caller (`runPlanningPhase`) only *after* the agreement gate resolves — the file
already documents this exact asymmetry for `currentPlanPath` (`isFake ? undefined : planMdPath`). There
is no genuine publication race under the fixture harness, so the gate is skipped there, and the C2
fixture suite (`isFake: true` throughout, never writes `plan.md` into `runDir`) needed zero changes.

`ReviewRoundResult` gained one **additive, optional** field: `blockedReason?: string`. The existing
`const { agreed, partnerBatchIds } = await runReviewRound({...})` destructure in
`planning-phase-service.ts` (untouched) is unaffected — it still builds its own `ROUND-CAP-EXHAUSTED`
message from `partnerBatchIds` on any `!agreed` result, C3's gate included.

## Files

| File | Change |
|------|--------|
| `src/services/planning-review-round.ts` | Add `checkArtifactsPublished()` + the real-mode-only gate call at the top of `runReviewRound`; add `blockedReason?: string` to `ReviewRoundResult`; new imports (`node:fs/promises`, `node:path`, `validateExecutionPlan`, `CANONICAL_CYCLE_ARTIFACTS`). |
| `src/services/planning-review-round-c3.test.ts` | **New.** C3-only gate (6 tests). |

## Explicit non-edits

- `planning-phase-service.ts` — untouched. `planMdPathForRaceGuard` grep count stays 3 (A0 preserved).
  `waitForAgreement`, B3/B4/B5/B6 logic, the terminal owner — all untouched.
- `brief-writer-service.ts`, `plan-parser-service.ts`, schema files, `src/index.ts` — untouched.
- No schema version invented.

## Known collateral (documented per coordinator direction, NOT fixed in this slice)

Re-running the shared-boundary gates (A0/A5/A6/B3-B6/C2, standing rule "rerun every previously verified
slice sharing a file or semantic boundary") turned up two real-mode test cases whose fixtures rely on the
exact race C3 structurally closes:

- `planning-phase-nonconvergence-b6.test.ts` — "no partner agreement ever arrives" deliberately never
  writes `plan.md`/`og-requirements.md`, forcing real mode, expecting the (pre-C3) partner-spawn to still
  happen and round-cap out. C3 now zero-spawns before that partner is ever created, so
  `partnerBatchIds` is `[]` instead of `['batch-B6-no-agreement-partner']`, and the assertion
  `expect(res.blockedReason).toContain('batch-B6-no-agreement-partner')` fails. The overall contract this
  test protects (non-convergence returns a typed blocked reason, never throws, never reads an
  unagreed plan) still holds — the test just asserts a partner batch id that can no longer exist.
- `planning-phase-one-terminal-owner-a6.test.ts` — "thrown exit (plancore never produced a canonical
  plan.md)" forces real mode with `plan.md`/`og-requirements.md` deliberately never written, then drives
  both seats to CLEAN/PLAN-READY via hand-appended callbacks, expecting agreement to succeed and the
  LATER canonical-plan-read step to throw `PLANCORE-DID-NOT-PRODUCE-CANONICAL-PLAN`. C3 makes that
  specific state (`agreed: true` while `plan.md` was never published) unreachable — the gate now refuses
  to spawn before agreement can even be attempted, so the thrown-exit path this test drives can no longer
  be reached this way.

Both failures are the direct, intended consequence of closing the C3 race, not a defect in the gate.
Reported to the coordinator (NEEDS-INFO); direction received: do not edit A6/B6 test files in this slice
(out of the C3 file allowlist) — C3's own acceptance gate is its dedicated test file plus the C2 regate,
raceguard grep and `tsc`, all green. Flagged here for whichever slice/owner next touches
`planning-phase-service.ts`'s test suite to update those two fixtures' expectations to match the new,
structurally-guaranteed invariant.
