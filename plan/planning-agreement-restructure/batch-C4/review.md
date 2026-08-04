# review.md — Batch C4 (implementer self-check)

**Verdict:** READY for independent validator
**AC10/AC3:** `roundCap` is a genuine integer count of agreement rounds — `runReviewRound` takes a
per-round timeout and integer `roundCap`, wraps `waitForAgreement` in a bounded loop with a per-round
deadline, rather than one wait pre-multiplied by `roundCap`.

## Checklist (against the brief's expected acceptance criteria)

| Check | Status |
|-------|--------|
| `runReviewRound` takes a per-round timeout and integer `roundCap` rather than one multiplied timeout scalar | Yes — `perRoundTimeoutMs`/`roundCap` (primary), `effectiveTimeoutMs` demoted to legacy alias |
| The bounded loop lives in `planning-review-round.ts` | Yes — `for (round = 1..resolvedRoundCap)` inside `runReviewRound`, nothing added to PPS beyond the wiring exception |
| One round means one call to `waitForAgreement` with the per-round timeout | Yes — proven by C4 test case 1 (`4000,4000,4000`, not `12000` once) |
| `roundCap=N` allows exactly N agreement attempts, then returns non-agreement with a typed blocked reason / additive result; never multiplies wall-clock timeout and waits once | Yes — exhaustion returns `{ agreed:false, partnerBatchIds, roundsAttempted, blockedReason }`; C4 test case 3 |
| Existing C2/C3 behavior remains intact where `roundCap` defaults to one implicit round or is explicitly supplied | Yes — `roundCap` omitted ⇒ `resolvedRoundCap=1`; C2 (4/4) and C3 (6/6) rerun unmodified and green; C4 test case 4 covers the omitted-roundCap shape explicitly |
| PPS blocked message remains truthful: "no unanimous CLEAN within N round(s)", does not describe a multiplied timeout as a round machine | Yes — `${roundCap} round(s)` phrase unchanged (now mechanically true); budget wording changed to `(~${PLANNING_TIMEOUT_MS}ms/round budget)`, no multiplied value referenced anywhere in PPS after this edit |
| New dedicated C4 test: `roundCap=3` calls `waitForAgreement` 3x with per-round timeout, not once with timeout*3 | Yes — case 1 |
| New dedicated C4 test: early agreement stops the loop without extra rounds | Yes — case 2 (agrees on round 2, `waitForAgreement` called exactly 2x, not 3) |
| New dedicated C4 test: exhaustion returns non-agreement and exposes exhausted round count/reason | Yes — case 3 (`roundsAttempted:3`, `blockedReason` matches `/ROUND-CAP-EXHAUSTED/`) |
| New dedicated C4 test: C2/C3 spawn/publication behavior still works with the new parameters | Yes — case 4 (spawn/handle capture with `roundCap` omitted) |
| Targeted vitest on the new C4 test file | Yes — PASS, 4/4 |
| Rerun C2 and C3 (edits the same round module) | Yes — PASS, 4/4 and 6/6, both files unmodified |
| `grep -c planMdPathForRaceGuard` and `npx tsc --noEmit -p tsconfig.json` | Yes — `3`, PASS |
| Scope: `planning-review-round.ts` + new C4 test + batch-C4 artifacts + narrow PPS wiring exception only | Yes |
| PPS wiring limited to the 4 allowed bullets (drop multiplied timeout; pass per-round budget + integer count separately; keep blocked-message wording accurate; no adjacent refactor) | Yes — 3 lines changed in PPS: the deleted multiplication, the call-site params, the message wording |
| No schema version invented | N/A — no schema touched |
| No edit to `src/index.ts` | Yes — untouched |
| No edit to any prior-slice test file | Yes — `planning-review-round-c2.test.ts` / `-c3.test.ts` both untouched, confirmed by diff-free rerun |

## Design notes for the validator

1. **`effectiveTimeoutMs` as a legacy alias, not a removed field.** North ruled the primary field must be
   `perRoundTimeoutMs`, with `effectiveTimeoutMs` kept optional solely so C2/C3's locked fixtures (which
   set `effectiveTimeoutMs: 4000` and nothing else) keep compiling/passing unmodified. Resolution is
   `(perRoundTimeoutMs ?? effectiveTimeoutMs)!` — the non-null assertion is safe because every real caller
   (PPS, sets `perRoundTimeoutMs`) and every existing test fixture (sets `effectiveTimeoutMs`) supplies
   exactly one. A hypothetical caller supplying neither is not a reachable state in this codebase today.
2. **No seat reap/respawn between rounds.** The partner-spawn loop (C2/S06/A10/CONVENE-RACE-FIX) runs
   exactly once, before the round loop, same as before this slice. Every round in this slice's loop reuses
   the SAME spawned seats and calls the SAME `waitForAgreement` with the SAME `partnerBatchIds` /
   `agreementFenceOffset` / race-guard args — only the resolved per-round timeout is new. Reaping stale
   seats and spawning fresh round-scoped ones is explicitly C5's job (Wave 3's next slice), not this one.
3. **`agreementFenceOffset` is not advanced between rounds.** `waitForAgreement` already re-derives the
   "newest line per seat" on every internal poll pass from the same starting offset, so re-calling it with
   an unchanged offset across rounds is correct: round 2 simply sees whatever new lines have been appended
   to `callbacks.md` since round 1 started, using the exact same latest-wins parsing C4 does not touch.
4. **A dispositive BROKEN inside one round does not skip remaining rounds.** `waitForAgreement` can return
   `false` early (before its own `timeoutMs` elapses) on a confirmed BROKEN verdict — the C4 loop treats
   that identically to a plain timeout: it just proceeds to the next round (up to `roundCap`), never
   distinguishing "explicit BROKEN" from "silence." Re-review/revise-on-BROKEN is C6's scope ("the revise
   actuator"), not this slice's.

## C4/C2/C3 boundary

This slice only changes how the existing single agreement wait is invoked — N independent per-round waits
against the same seats, instead of one wait pre-multiplied by N. It does not touch: the partner-spawn loop
itself (C2), the pre-loop artifact-publication gate (C3, untouched — still runs once, real-mode only,
before any round), seat reap-and-respawn (C5), the revise actuator (C6), the reviewer spawn/first-callback
watchdog (C7), or removing the honest fail-fast (C8, deliberately last).

## Evidence

See `test-report.md`.
