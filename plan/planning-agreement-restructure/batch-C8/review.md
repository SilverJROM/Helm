# review.md — Batch C8 (implementer self-check)

**Verdict:** READY for independent validator
**AC11/AC23:** `runReviewRound`'s round loop now classifies a same-current-plan `BROKEN` on **every**
non-agreeing round — not only rounds with budget left to spend on a revise turn — and surfaces that
classification through an additive, typed `blockedReasonKind` field on `ReviewRoundResult`. A
same-current-plan `BROKEN` on the round that actually exhausts `roundCap` now returns
`blockedReasonKind: 'same-plan-broken'` with a distinct message, never the generic
`ROUND-CAP-EXHAUSTED` reason it silently collapsed into before C8.

## Checklist (against the brief's expected acceptance criteria)

| Check | Status |
|-------|--------|
| Round machine distinguishes: no unanimous current-plan CLEAN before timeout/cap; same-current-plan BROKEN evidence (C6 revise-worthy); stuck reviewer first-callback (C7) | Yes — four `blockedReasonKind` values: `'round-cap-exhausted'`, `'same-plan-broken'`, `'reviewer-no-first-callback'` (C7, unchanged), `'artifact-not-published'` (C3, unchanged) |
| A same-current-plan BROKEN no longer surfaces only as an anonymous `ROUND-CAP-EXHAUSTED` boolean-false | Yes — the same-SHA `BROKEN` scan (`collectSameShaBrokenEvidence` + `readPlanRevision`) is hoisted out of the `round < resolvedRoundCap` gate to run every non-agreeing round; the post-loop `!agreed` branch checks the LAST round's evidence first and returns the typed `same-plan-broken` exit before ever falling to the generic exhausted message |
| Production real mode uses the typed round-result path by default, no new host wiring from `planning-phase-service.ts` | Yes — the classification runs unconditionally inside `runReviewRound` on the exact same code path every real caller already takes; `blockedReasonKind` is additive/optional so `planning-phase-service.ts`'s existing `{ agreed, partnerBatchIds }` destructure needs no change to keep working |
| Fake-harness compatibility for C2-C7 preserved, same `USE_FAKE_TMUX` convention | Yes — the hoisted scan's only real-vs-fixture gate is implicit: `readPlanRevision` returns `null` when `plan.md` doesn't exist on disk, exactly as C6's original conditional scan already relied on; no new `isFake`/`USE_FAKE_TMUX` branch was needed because none was needed by C6 either |
| Preserve B3/B4/B5 invariants inside the local typed scan | Yes — `collectSameShaBrokenEvidence` itself (grammar, newest-line-locks-the-seat, current-plan SHA binding) is byte-identical; C8 only changed the *condition* under which it is called, never its body |
| Preserve A0 raceguard | Yes — `grep -c planMdPathForRaceGuard planning-phase-service.ts` == `3`; that file is untouched |
| Preserve C6 (same-current-plan BROKEN before the final round spawns a revise turn, waits for new hash, C5 spawns fresh seats) | Yes — the revise-turn SPAWN action is still gated on `round < resolvedRoundCap`, byte-identical brief/spawn/reap/hash-wait mechanism; only the classification that feeds it was hoisted |
| New dedicated C8 test: BROKEN on R1 → revise writes R2 → fresh reviewer seats → CLEAN on R2 converges end-to-end | Yes — test case 1 |
| New dedicated C8 test: same-current-plan BROKEN drives a typed BROKEN/revise path, not `ROUND-CAP-EXHAUSTED` | Yes — test case 2 (seeds evidence only on the FINAL round, asserts `blockedReasonKind === 'same-plan-broken'` and message does NOT match `/ROUND-CAP-EXHAUSTED/`) |
| New dedicated C8 test: stale/superseded BROKEN or CLEAN evidence still does not count for the current plan | Yes — test case 3 (different-SHA `BROKEN` on the final round falls back to `round-cap-exhausted`) |
| New dedicated C8 test: malformed newest verdict over older same-SHA evidence remains fail-closed | Yes — test case 4 (older parseable same-SHA `BROKEN` + newer truncated line for the same seat on the final round; seat locked to its malformed newest line, evidence excluded) |
| Targeted vitest on the new C8 test file | Yes — PASS, 4/4 |
| Re-run C2/C3/C4/C5/C6/C7 tests (same round module) | Yes — PASS, 30/30 unmodified (34/34 combined with C8) |
| `grep -c planMdPathForRaceGuard` and `npx tsc --noEmit -p tsconfig.json` | Yes — `3`, PASS (exit 0) |
| Scope: `planning-review-round.ts` + new C8 test + batch-C8 artifacts only | Yes — no other file touched (confirmed via `git status --porcelain` on every named out-of-scope file: unchanged from this session's start) |
| Do not move/edit `planning-phase-service.ts`'s private `waitForAgreement`; keep it as an injected compatibility path | Yes — untouched; still a plain `Promise<boolean>` callback |
| Do not implement C9/C10; do not touch their files | Yes — `brief-writer-service.ts`, `plan-parser-service.ts` untouched |
| New option/type fields additive and optional | Yes — `RoundBlockedReasonKind` is a new exported type but `blockedReasonKind` itself is `?:` optional on `ReviewRoundResult`; no existing field's type or meaning changed |
| The invariant lives in code/tests, not just brief wording | Yes — enforced by the typed return + the four C8 test assertions on `blockedReasonKind`/`blockedReason` content |
| No schema version invented | N/A — no schema touched |
| No edit to `src/index.ts` | Yes — untouched |
| Never edit a file another stream owns | Yes |

## Design notes for the validator

1. **Why the fix is "hoist the scan, keep the spawn gated" rather than a bigger rewrite.** The brief's
   batch title is "typed round-loop results," and the concrete gap after C7 was narrow: C6's
   `collectSameShaBrokenEvidence` scan was correct, it just only ran when there was budget left to act
   on it (`round < resolvedRoundCap`), because that condition was doing double duty — gating both "is
   this worth classifying" and "is this worth spawning a revise turn for." C8 splits those two
   concerns: classification now runs on every non-agreeing round (cheap — it's a read of the same
   `callbacks.md` window `waitForAgreement` just consulted, restricted to this round's own batch ids);
   the revise-turn spawn action keeps its original, unchanged gate. This is the minimal change that
   makes the FINAL round's failure cause visible without touching C5/C6's spawn/reap/revise mechanism
   at all.
2. **Why a new typed field (`blockedReasonKind`) instead of only a distinct string prefix.** The
   pre-existing `blockedReason` string already used distinct prefixes per cause
   (`ARTIFACT-NOT-PUBLISHED`, `REVIEWER-NO-FIRST-CALLBACK`, `ROUND-CAP-EXHAUSTED`) and that convention
   alone would have satisfied the letter of "distinguish... in code" via string matching. The batch
   title explicitly says "typed round-loop results," so C8 adds a real discriminated value
   (`RoundBlockedReasonKind`) a consumer can switch on without parsing prose, while keeping the
   human-readable `blockedReason` string exactly as useful as it already was for logs/UI. Both fields
   are additive/optional, so this is a pure widening of `ReviewRoundResult`'s shape — no existing
   `const { agreed, partnerBatchIds } = await runReviewRound(...)` call site anywhere breaks.
3. **Why the new message deliberately avoids the substring `ROUND-CAP-EXHAUSTED`.** The brief's second
   acceptance bullet is explicit that a same-current-plan BROKEN "must no longer be treated as an
   anonymous boolean false that can only surface later as `ROUND-CAP-EXHAUSTED`." The new
   `SAME-PLAN-BROKEN-NO-ROUNDS-LEFT` prefix is a distinct literal (not a suffix/variant of the old
   one) specifically so a caller `grep`-ing logs for `ROUND-CAP-EXHAUSTED` cannot accidentally still
   match this cause — verified directly by test case 2's `not.toMatch(/ROUND-CAP-EXHAUSTED/)`.
4. **Why C2/C3/C4/C5/C6/C7's fixtures needed no edits.** Verified by inspection before writing any
   code, then confirmed empirically by the unmodified regate (30/30 green): C4/C5's fixtures never
   write `plan.md` to the temp `runDir` at all, so `readPlanRevision` returns `null` and the hoisted
   scan is a no-op on every round including the final one — their `ROUND-CAP-EXHAUSTED` assertions
   (C4's dedicated `/ROUND-CAP-EXHAUSTED/` regex check) stay true. C6's fixtures seed `BROKEN` evidence
   only for round 1's own round-scoped batch id (`batch-C6-partner`), never round 2's
   (`batch-C6-r2-partner`, the final round in its `roundCap: 2` fixtures) — the final-round scan is
   correctly scoped to the CURRENT round's own `partnerBatchIds`, so it finds nothing there either, and
   none of C6's assertions inspect `blockedReason` content in the first place.
5. **Why `lastSamePlanBrokenEvidence` is reset to `[]` at the top of every round's classification, not
   accumulated.** A round with no evidence of its own must not inherit an earlier round's — otherwise a
   same-plan BROKEN detected (and successfully revised away) in round 1 could wrongly leak into round
   3's exhausted classification even though round 3's actual failure might be a genuine timeout with no
   BROKEN at all. Resetting every iteration guarantees the post-loop branch reflects only the round that
   actually ended the loop, matching what `roundsAttempted` already names.

## C8/C7/C6/C5/C4/C3/C2 boundary

This slice touches exactly one thing: the round loop's post-`waitForAgreement` classification and the
post-loop `!agreed` return. It does not touch: seat-count resolution (C2/A10/S06), the pre-loop
artifact-publication gate (C3, only additively stamped with `blockedReasonKind`), integer
round-cap/per-round timeout resolution (C4), the fresh-seat spawn/reap mechanism (C5), the revise
turn's spawn/brief/hash-wait/reap mechanism itself (C6 — untouched, only its evidence source is now
also read on rounds it doesn't act on), or the reviewer first-callback watchdog (C7, only additively
stamped). `waitForAgreement` (`planning-phase-service.ts`) is not touched, moved, or reimplemented —
C8 remains a classification layered on top of its plain boolean return, exactly as the brief's scope
required.

## Evidence

See `test-report.md`.
