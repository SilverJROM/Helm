# Batch B4 — review.md

## Acceptance criteria checklist (from the dispatch brief)

- [x] **Update only `src/services/planning-phase-service.ts` plus one new B4 test/artifacts.** —
      confirmed: the only source edit is `waitForAgreement`'s scan loop; `git status` shows
      exactly that file modified plus the new dedicated test file and these three artifacts.
- [x] **For each configured partner seat, consider only that seat's newest parsed
      `VERDICT-READY` line in the current callback window.** — `seenNewestVerdict` is set the
      first time (reversed/newest-first scan) a `VERDICT-READY` line for that seat's
      `partnerBatchId` is encountered, before any note-parsing decision is made, and gates all
      further consideration of that seat for the remainder of the pass.
- [x] **If the newest line is malformed/unparseable as a verdict payload, fail closed: do not
      walk past it to an older CLEAN.** — a failed `verdictMatch` leaves `verdicts` unset for
      that seat while `seenNewestVerdict` is already set, so the `!seenNewestVerdict.has(...)`
      guard blocks the loop from ever inspecting an older line for that same seat again in this
      pass. Proven by the B4 test's first case (older CLEAN + newer malformed → `false`).
- [x] **Preserve existing behavior for valid newest CLEAN, valid newest BROKEN, PLAN-READY
      requirement, race guard, and partnerBatchIds.** — the BROKEN-dispositive block, its
      `planMdPathForRaceGuard`/`fs.stat` race guard, the `PLAN-READY` requirement, and the
      unanimous-CLEAN pass check are byte-unchanged below the scan loop; full
      `planning-phase-service.test.ts` (31 tests, including A9's dual-prefix / em-dash
      `waitForAgreement` coverage and the A10 unanimous panelSize=3 case) reruns green.
- [x] **Do not enforce plan SHA yet; B5 owns current-plan binding.** — `planSha` is not read or
      referenced anywhere in this batch's diff.
- [x] **New dedicated B4 unit-test file** proving: older CLEAN + newer malformed does not pass;
      older BROKEN + newer CLEAN can pass with PLAN-READY; malformed newest stays
      non-agreement on a bounded short timeout. —
      `src/services/planning-phase-newest-verdict-b4.test.ts`, 4/4 green (a 4th regression test
      covers the changed multi-seat break condition).
- [x] **`HELM_DB_PATH=/tmp/helm-b4-$$.db npx vitest run <new-test-file>`** — passes
      (test-report.md).
- [x] **`grep -c planMdPathForRaceGuard` stays `3`.** — confirmed unchanged before and after.

## Design notes / self-review

- Chose a separate `Set<string>` (`seenNewestVerdict`) rather than changing `verdicts` to store
  a tri-state (`'CLEAN' | 'BROKEN' | 'MALFORMED'`) sentinel. A sentinel value would have required
  touching every downstream read of `verdicts` (the BROKEN-dispositive `.values().some(...)` scan
  and the unanimous `.every((id) => verdicts.get(id) === 'CLEAN')` check) to explicitly exclude
  the new sentinel; keeping `verdicts` as a pure `CLEAN|BROKEN` map and gating entry with a
  parallel seen-set means both existing consumers need zero changes — they already treat "absent
  from `verdicts`" as not-yet-agreed, which is exactly the fail-closed behavior AC8 wants for a
  malformed newest line.
- The early-break condition (`seenNewestVerdict.size === partnerBatchIds.length`) is the one
  place besides the seen-check itself that had to move off `verdicts`. Left it un-gated on
  `sawPlanReady` matching the pre-existing structure (`sawPlanReady && ...`), so the loop still
  can't break early on partner evidence alone before `PLAN-READY` is seen if it appears later in
  the file (older than the partner lines) — same ordering behavior as before, since scan order is
  purely by line position, not by field name.
- Deliberately did *not* make a malformed newest line dispositive-immediate (i.e., did not add an
  early `return false` the moment a malformed newest line is detected, the way a confirmed BROKEN
  is dispositive). The brief's acceptance criteria explicitly allow either "without waiting for
  timeout if the local helper makes that observable, or with a short timeout otherwise," and no
  local helper was extracted for this scope (only the scan loop changed) — a malformed line could
  plausibly still be a truncated in-flight write, so folding it into the same instant-fail path as
  a confirmed BROKEN would risk turning a genuinely transient write race into a hard failure. Bounding
  it by the ordinary outer `timeoutMs` (as the B4 test's third case exercises with a 120ms bound)
  keeps that same tolerance while still being deterministic and non-hanging.
- The B3 doc comment directly above `waitForAgreement` ("A missing/unparseable verdict body is
  treated as 'no verdict yet' ... in case the payload is still being written mid-line") remains
  accurate for the single-newest-line case; this batch does not change that tolerance, it only
  prevents the loop from falling through to a *different, older* line once the newest one for a
  seat has been inspected.

## Residual risk

- None identified within this batch's scope. B5 (current-plan-SHA enforcement) and B6 are the
  next slices in the serial P1 chain and both consume this same file — the standing regression
  rule (rerun A0/A5/A6 + P1 B-slice gates on shared-file changes) already covers them for their
  own batches.
