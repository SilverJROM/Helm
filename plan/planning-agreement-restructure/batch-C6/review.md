# review.md — Batch C6 (implementer self-check)

**Verdict:** READY for independent validator
**AC11:** on a same-plan-revision `BROKEN` round with a round left to spend, the engine now
engine-spawns a fresh, uniquely-named plancore revision turn carrying the aggregated defect notes,
waits for `plan.md`'s revision hash to genuinely change, and only then lets the loop's next iteration
spawn C5's fresh reviewer seats. Stale/different-SHA `BROKEN` evidence and cap-exhaustion with no
`BROKEN` evidence both preserve C5/C4's existing bounded behaviour unchanged. The revise seat is
cleanup-visible in the caller-owned arrays and explicitly reaped by this module.

## Checklist (against the brief's expected acceptance criteria)

| Check | Status |
|-------|--------|
| Round produces same-current-plan `BROKEN` evidence, `round < roundCap` → aggregate the `BROKEN` defect notes for that round/current plan SHA | Yes — `collectSameShaBrokenEvidence` re-scans `cbPath` restricted to the failed round's own `partnerBatchIds`, newest-VERDICT-READY-per-seat, filters to `verdict==='BROKEN' && planSha===currentShort12` |
| Engine-spawn a fresh uniquely named plancore revision turn using a local `generatePlanRoundReviseBrief` helper | Yes — `generatePlanRoundReviseBrief` is a local, unexported function in `planning-review-round.ts`; batch id `${batchId}-r${round}-revise` cannot collide with any reviewer or brainRole id; `transport.spawn({role: brainRole, ...})` |
| Wait for `plan.md` to change to a new revision hash before spawning the next reviewer round | Yes — `waitForPlanRevisionChange` polls `readPlanRevision(planMdPath).short12` every 200ms, bounded by `resolvedPerRoundTimeoutMs`; test case 2 proves the next round's spawn is genuinely blocked on this via a delayed background rewrite + synchronous assertion at spawn time, not just "eventually happens" |
| Then continue with C5's fresh reviewer seats | Yes — no change to `spawnRoundSeats` or the loop's normal next-iteration flow; the actuator runs, then the `for` loop's next iteration proceeds exactly as C5 already does |
| Revision turn has unique round-scoped identity, visible to caller-owned cleanup arrays/runtime ids, or an explicit cleanup path in this module — no leaked plancore revision seat | Yes, both — pushed into the SAME `partnerHandles`/`partnerRuntimeIds` arrays the reviewer seats use (A5/A6 safety net for a mid-flow throw) AND explicitly `transport.reap`'d by this module once the hash wait resolves/times out (test case 4) |
| No same-SHA `BROKEN` evidence → preserve C5/C4 bounded non-agreement behaviour | Yes — `sameShaBroken.length === 0` (or `readPlanRevision` returns `null`, e.g. the `isFake` fixture convention) falls through with zero side effects; test case 3 proves this for stale/different-SHA evidence specifically |
| Do not remove the honest `BROKEN` fail-fast globally; C8 owns replacing it | Yes — `waitForAgreement` (`planning-phase-service.ts`) is completely untouched; its immediate `false` return on a confirmed `BROKEN` (subject to the existing plan-presence race guard) is unmodified. C6 only adds a new branch taken AFTER that return |
| Do not weaken B5 current-plan SHA binding: stale/superseded `CLEAN`/`BROKEN` evidence must not drive agreement or revise for a new plan revision | Yes — `currentShort12` is re-derived fresh (`readPlanRevision(planMdPath)`) at the point of the check, never cached; only an exact match counts. Test case 3's seeded evidence (`plan=0123456789ab` against real content A) is proven to NOT trigger a revise |
| New dedicated C6 test: same-SHA `BROKEN` in round 1 before cap spawns a unique plancore revise turn | Yes — test case 1 |
| New dedicated C6 test: next reviewer round waits until `plan.md` hash changes | Yes — test case 2 |
| New dedicated C6 test: stale/different-SHA `BROKEN` does not trigger a revise for the current plan | Yes — test case 3 |
| New dedicated C6 test: revision/plancore handles are cleanup-visible or reaped | Yes — test case 4 |
| Targeted vitest on the new C6 test file | Yes — PASS, 4/4 |
| Re-run C2/C3/C4/C5 tests (same round module) | Yes — PASS, 20/20 unmodified (24/24 combined with C6) |
| `grep -c planMdPathForRaceGuard` and `npx tsc --noEmit -p tsconfig.json` | Yes — `3`, PASS |
| Scope: `planning-review-round.ts` + new C6 test + batch-C6 artifacts only | Yes — no other file touched |
| No schema version invented | N/A — no schema touched |
| No edit to `src/index.ts` | Yes — untouched |
| No edit to `planning-phase-service.ts`, `brief-writer-service.ts`, `plan-parser-service.ts`, or any prior-slice test file | Yes — all untouched, confirmed by unmodified regate |
| Never edit a file another stream owns | Yes — `generatePlanRoundReviseBrief` calls `briefWriter.generateBrief`, an EXISTING public method; no new `BriefWriterService` method was added, per the brief's explicit ownership constraint |

## Design notes for the validator

1. **Why re-implement the parser locally instead of touching `planning-phase-service.ts`.** The brief
   is explicit: touch only `planning-review-round.ts`. `parseAgreementCallbackLine`/
   `readCallbacksWindow` are private instance methods on `PlanningPhaseService`, not importable. The
   duplication is small (12 lines), commented as a deliberate duplication tied to B3's grammar, and
   scoped to exactly the same concern (`VERDICT-READY` + `plan=<sha12>` parsing) — not a new parser
   design.
2. **Why re-scan `callbacks.md` instead of changing `waitForAgreement`'s return type.** Changing
   `waitForAgreement` to return verdict detail would touch its signature and every call site in
   `planning-phase-service.ts` (out of scope) and the C2-C5 test fixtures that mock it as
   `Promise<boolean>` (locked, per the brief: "no prior-slice test file" edits). Re-scanning the same
   window it just read is more code in this file, but it is the only mechanism available without
   expanding scope — and it was flagged to the coordinator as the plan before implementation, per the
   PROPOSED/APPROVED-PLAN handshake.
3. **`round < resolvedRoundCap`, not `round <= resolvedRoundCap`.** The actuator only fires when
   there's a next round to spend the revision on — a `roundCap=1` caller (every pre-C6 fixture's
   default) can never trigger it, matching "preserve C5/C4 bounded non-agreement behaviour" for the
   single-round shape unchanged.
4. **`waitForPlanRevisionChange`'s timeout reuses `resolvedPerRoundTimeoutMs`** rather than inventing a
   new option field that no real caller in this slice would set anyway (`planning-phase-service.ts` is
   out of scope, so no wiring exception was available to plumb a dedicated revise-wait budget through).
   This is a reasonable default; a follow-up integration wave may add a dedicated field if the real
   revise-turn wait budget needs to differ from the reviewer-round wait budget.
5. **Belt-and-suspenders cleanup was a deliberate choice, not redundancy.** Pushing into
   `partnerHandles`/`partnerRuntimeIds` alone would satisfy "visible to caller-owned cleanup arrays."
   Explicit `transport.reap` alone would satisfy "explicit cleanup path in this module." Doing both
   means a mid-flow throw is still caught by the caller's terminal owner (A5/A6), while the normal
   non-throwing path doesn't leave a stale revise session alive alongside the next round's reviewers
   waiting on a reap that would otherwise only happen at whole-run terminalization.
6. **`planningBrainModel`/`planningBrainProvider` are additive/optional and unwired in this slice** —
   consistent with the brief's scope restriction (no `planning-phase-service.ts` edits). They default
   to `undefined`, which `ITransport.spawn` already treats as "no override," identical to how
   `partnerModel`/`partnerProvider` behave when omitted today.

## C6/C5/C4/C3/C2 boundary

This slice adds the revise-actuator branch between a failed round's `waitForAgreement` and the next
round's `spawnRoundSeats` call; it does not touch: seat-count resolution (C2/A10/S06), the pre-loop
artifact-publication gate (C3), integer round-cap/per-round timeout resolution (C4), or the fresh-seat
spawn/reap mechanism itself (C5, `spawnRoundSeats`/`priorRoundHandles` — completely untouched). It also
does not touch the reviewer spawn/first-callback/submit watchdog (C7) or removing the honest fail-fast
(C8, deliberately last of the round core).

## Evidence

See `test-report.md`.
