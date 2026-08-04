# changes.md — B4: newest-verdict fail-closed tracking in waitForAgreement

**Batch:** B4
**AC:** 8, 23
**Branch:** `fix/planning-agreement-restructure`
**Tier:** L3 / high
**Status:** DONE

## Root cause (mechanism)

`waitForAgreement` (`src/services/planning-phase-service.ts`) scans `callbacks.md`
newest-first (`lines = raw.split(/\r?\n/).reverse()`). For each partner seat it only marked
that seat "resolved" — via `!verdicts.has(parsed.batchId)` — once a `VERDICT-READY` line's
note actually matched `/^\s*(CLEAN|BROKEN)\b/i`. If a seat's **newest** `VERDICT-READY` line
had a malformed/unparseable note, that guard stayed `true` (the seat was never marked
resolved), so the reversed scan kept walking backward through history for that same
`partnerBatchId` and could latch an **older**, already-stale `CLEAN`/`BROKEN` line instead.
That is stale-side fail-open: a bad newest verdict silently fell through to old evidence
rather than blocking the gate, violating AC8 ("fail closed instead of treating malformed or
stale lines as silence/pass").

## Fix

`src/services/planning-phase-service.ts`, `waitForAgreement`'s scan loop only
(previously ~lines 1059-1081):

1. Added a second tracking structure, `seenNewestVerdict: Set<string>`, keyed by
   `partnerBatchId`. It is populated the **first** time the reversed (newest-first) scan
   encounters a `VERDICT-READY` line for that seat's `batchId` + matching `partnerRole` —
   regardless of whether the note parses to `CLEAN`/`BROKEN`.
2. The existing `verdicts` map (`partnerBatchId -> 'CLEAN' | 'BROKEN'`) is now only populated
   *after* `seenNewestVerdict` gates entry, and only when the verdict regex actually matches.
   A malformed newest line adds the seat to `seenNewestVerdict` but leaves it absent from
   `verdicts` — permanently (for this poll pass) blocking any older line for that same seat
   from being considered, since the `!seenNewestVerdict.has(...)` guard is now what prevents
   re-entry, not `!verdicts.has(...)`.
3. The scan's early-break condition changed from `verdicts.size === partnerBatchIds.length` to
   `seenNewestVerdict.size === partnerBatchIds.length`, since `verdicts.size` can never reach
   that count while any seat's newest line is malformed (the loop would otherwise keep
   scanning to the top of the file every 20ms poll tick instead of breaking once every seat's
   newest line is accounted for).
4. The resolution logic below the scan (BROKEN-is-dispositive with the plan.md race guard, and
   the unanimous-CLEAN pass check) is **unchanged**. `partnerBatchIds.every((id) =>
   verdicts.get(id) === 'CLEAN')` already naturally evaluates to `false` when a seat's entry is
   missing from `verdicts`, so a malformed-newest seat correctly blocks the pass condition with
   no further code change.

## Explicit non-changes

- `planSha` is not read, parsed against, or enforced anywhere in this batch — B5 owns binding
  a verdict to the current `plan.md` SHA.
- No change to the BROKEN-dispositive race-guard block (`planMdPathForRaceGuard` / `fs.stat`
  check) — still exactly 3 source references, untouched logic.
- No change to `PLAN-READY` detection, `partnerBatchIds` handling, or the outer `timeoutMs`
  bounded-wait/return-`false`-on-timeout behavior.
- No other function in `planning-phase-service.ts` touched.
- No `src/index.ts` edit.

## Files changed

- `src/services/planning-phase-service.ts` (edited — `waitForAgreement` scan loop only)
- `src/services/planning-phase-newest-verdict-b4.test.ts` (new — dedicated B4 gate, 4 tests)

## Regression sweep (shared-file/semantic-boundary rerun)

Per standing rules, reran every previously-verified slice sharing this file or the
whole-plan-agreement semantic boundary (I-P1: A0/A5/A6 plus the P1 B-slice gates):

- `src/a0-convene-race-regression.test.ts` (5 tests)
- `src/services/planning-phase-reap-before-finalize-a5.test.ts` (3 tests)
- `src/services/planning-phase-one-terminal-owner-a6.test.ts` (1 test)
- `src/services/plan-revision-b1.test.ts` (10 tests)
- `src/services/brief-writer-panel-plan-contract-b2.test.ts` (2 tests)
- `src/services/planning-phase-verdict-parser-b3.test.ts` (12 tests)
- `src/services/planning-phase-newest-verdict-b4.test.ts` (4 tests, new)
- `src/services/planning-phase-service.test.ts` (31 tests — includes A9's full
  `waitForAgreement` dual-prefix/em-dash coverage)

All green, 68/68.

`tsc --noEmit` clean project-wide.

PLAN-CONTRADICTION: none.
