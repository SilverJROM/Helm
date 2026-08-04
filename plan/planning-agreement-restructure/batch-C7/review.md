# review.md — Batch C7 (implementer self-check)

**Verdict:** READY for independent validator
**AC15/AC23:** `runReviewRound` now generalizes plancore's POCFIX20 `waitForFirstCallback` rescue to
reviewer seats. After each round's `spawnRoundSeats` call and before that round's `waitForAgreement`
call, every freshly spawned reviewer seat must show a first callback line in `callbacks.md`, bounded
by the per-round timeout budget. A stuck seat returns a typed blocked result naming the exact seat and
reason (`no-first-callback` or `session-gone`) — `waitForAgreement` is never called and no canonical
plan polling/reading is reached. The watchdog is on by default in real mode (mirrors
`planning-phase-service.ts`'s own `USE_FAKE_TMUX` fixture-skip convention) without editing any prior
C2-C6 test file.

## Checklist (against the brief's expected acceptance criteria)

| Check | Status |
|-------|--------|
| After every reviewer `transport.spawn`, wait for that seat's first callback before entering the round's agreement wait | Yes — runs after `spawnRoundSeats(round)` returns (all of this round's seats spawned) and strictly before the round's `waitForAgreement` call |
| Bounded by the per-round timeout budget, scoped to the exact spawned reviewer role + round-scoped batch id | Yes — `boundedFirstCallbackTimeoutMs = min(reviewerFirstCallbackTimeoutMs ?? resolvedPerRoundTimeoutMs, resolvedPerRoundTimeoutMs)` can never exceed the round's own budget; matched via `RAW_CALLBACK_IDENTITY_RE` batch-id equality + `roleMatches(partner, ...)` |
| Stuck seat → typed blocked result, not a throw, not a silent agreement: `agreed:false`, `roundsAttempted` reflects the attempted round, `partnerBatchIds` includes the round's reviewer batch ids, `blockedReason` names the stuck batch id + reason | Yes — all four fields set from values already computed earlier in the same round iteration (`roundsAttempted = round` at loop top, `partnerBatchIds` just derived from `roundSeats`); `blockedReason` interpolates each stuck seat's `batchId` and `reason` (`no-first-callback`/`session-gone`) |
| Blocked path must not call `waitForAgreement`; no canonical plan polling/reading reached | Yes — the function `return`s before the `waitForAgreement` call; this module never polls/reads `plan.md`/`og-requirements.md` itself outside the C3 pre-spawn gate (which already ran, successfully, before any seat was spawned) |
| Composer-held seat → reuse `resubmitIfComposerHeld` via the transport if available, bounded retry; if `inspectSeat`/watchdog unavailable, preserve bounded timeout rather than expanding scope | Yes — accessed through the narrow `ReviewerWatchdogTransport` interface (mirrors the existing `(this.transport as any).resubmitIfComposerHeld?.(...)` access pattern), capped at `REVIEWER_FIRST_CALLBACK_MAX_PRESSES` (5) successful presses; a transport lacking either method (e.g. bare `FakeTransport`) simply skips that branch and falls through to the plain bounded poll — no thrown error, no new required interface member |
| Successful first callbacks preserve C2-C6 behaviour: artifact gate, integer round cap, fresh per-round seats, same-SHA revise actuator, cleanup-visible handles/runtime ids | Yes — none of that machinery was touched; `spawnRoundSeats`'s handle/runtime-id push order, `checkArtifactsPublished`, the round-cap loop, and `collectSameShaBrokenEvidence`/the revise actuator are byte-identical. Test case 5 proves the agreement path continues unchanged once a seat is proven alive |
| New dedicated C7 test: no first callback → typed blocked, no `waitForAgreement` | Yes — test cases 1 (fixture-harness force-enable) and 2 (genuine production default-on path, `USE_FAKE_TMUX` unset) |
| New dedicated C7 test: `session-gone` reviewer → typed blocked, names the stuck batch id | Yes — test case 3 |
| New dedicated C7 test: composer-held seats invoke the submit watchdog/retry path when the transport exposes it | Yes — test case 4 |
| New dedicated C7 test: valid first callback → existing agreement path continues | Yes — test case 5 |
| Targeted vitest on the new C7 test file | Yes — PASS, 5/5 |
| Re-run C2-C6 tests (same round module) | Yes — PASS, 25/25 unmodified (30/30 combined with C7) |
| `grep -c planMdPathForRaceGuard` and `npx tsc --noEmit -p tsconfig.json` | Yes — `3`, PASS |
| Scope: `planning-review-round.ts` + new C7 test + batch-C7 artifacts only | Yes — no other file touched |
| Do not move/edit `planning-phase-service.ts`'s private `waitForFirstCallback`; implement an analogous local helper if needed | Yes — `waitForReviewerFirstCallback` is a wholly local, unexported function in `planning-review-round.ts` |
| New option/type fields additive and optional | Yes — `reviewerFirstCallbackTimeoutMs?: number` is optional; `spawnRoundSeats`'s widened return type is a local closure detail, not part of any exported/public shape |
| Do not remove the honest `BROKEN` fail-fast globally; C8 owns replacing it | Yes — `waitForAgreement` (`planning-phase-service.ts`) untouched |
| No schema version invented | N/A — no schema touched |
| No edit to `src/index.ts` | Yes — untouched |
| No edit to `planning-phase-service.ts`, `brief-writer-service.ts`, `plan-parser-service.ts`, or any prior-slice test file | Yes — all untouched, confirmed by unmodified regate |
| Never edit a file another stream owns | Yes |

## Design notes for the validator

1. **Why the gate ended up default-on instead of purely opt-in.** The first implementation cut made
   the watchdog strictly opt-in (`reviewerFirstCallbackTimeoutMs` undefined ⇒ fully inert), reasoning
   that C7's scope forbids touching `planning-phase-service.ts` — the only place that could pass a real
   value for a new option. The coordinator corrected this mid-implementation: a mechanism that no real
   caller could ever activate does not satisfy AC15/AC23's intent. The fix generalizes
   `planning-phase-service.ts`'s own `isFakeP` convention
   (`process.env.USE_FAKE_TMUX === '1' && process.env.NODE_ENV !== 'production'`, used there to skip
   the plancore watchdog under the fixture harness) to this module: `!isFake && (USE_FAKE_TMUX !== '1'
   || reviewerFirstCallbackTimeoutMs != null)`. This makes the watchdog genuinely live on any real
   (non-fixture) call, while every existing C2-C6 spec file — which sets `USE_FAKE_TMUX='1'` at module
   load and never sets the override — stays byte-identical without editing a single one of them. This
   was proven, not assumed: the full C2-C6 suite was rerun unmodified after the change and stayed
   30/30 green (see test-report.md).
2. **Why `reviewerFirstCallbackTimeoutMs` still exists post-correction.** It now serves as a
   force-enable for tests that must run under the fixture harness (`USE_FAKE_TMUX='1'`) — required
   because `FakeTransport`'s own constructor refuses to build outside that env var — and as an optional
   bound override on top of the default (`resolvedPerRoundTimeoutMs`). Test case 2 is the one that
   proves the mechanism does NOT depend on this field at all: it unsets `USE_FAKE_TMUX` around the call
   (restored in `finally`) and omits the field entirely, exercising the exact same code path a real
   production caller would.
3. **Why `inspectSeat`/`resubmitIfComposerHeld` are accessed via a narrow local interface, not `any`.**
   The brief's own guidance permits "optional transport methods through a typed/narrow local
   interface." `ITransport` (in `fake-transport.ts`, not touched) does not declare
   `resubmitIfComposerHeld` at all — only `RealTransport` implements it, and
   `planning-phase-service.ts`'s own `waitForFirstCallback` already accesses it via
   `(this.transport as any).resubmitIfComposerHeld?.(...)`. `ReviewerWatchdogTransport` gives the same
   access with an explicit signature instead of `any`, without needing to touch `fake-transport.ts`.
4. **Why the retry is bounded by a press counter, not a wall-clock cadence.** `waitForFirstCallback`
   throttles `resubmitIfComposerHeld` to a ~30s cadence (`HELM_SUBMIT_WD_MS`, tunable, min 1s) because
   it also does full pane classification (idle/generating/composer-held) to decide when a nudge is
   warranted — machinery this row's scope explicitly excludes ("no pane/idle-prompt classification").
   Without that signal, a plain wall-clock cadence would either be too slow to matter within the
   reviewer's much shorter first-callback window, or (if shortened) start hammering `sendEnter` on a
   real tmux pane every tick. A bounded press *count* (5), checked on the same 200ms poll tick this
   module already uses elsewhere (`waitForPlanRevisionChange`), keeps any real nudging brief and finite
   regardless of how long the overall wait runs, while staying simple enough to not expand scope.
5. **Why `spawnRoundSeats`'s return type changed instead of adding a second lookup.** The watchdog
   needs each seat's brief text (for the optional resubmit nudge) and handle (for the optional
   `inspectSeat` probe) at the exact moment it was spawned. Both already exist as locals inside
   `spawnRoundSeats`'s loop body; returning them alongside the batch id is a same-function, in-memory
   change with no new file I/O, no new transport call, and no change to the wire format any consumer
   observes (`partnerBatchIds` is still derived as a plain `string[]` immediately after, so
   `waitForAgreement`'s call signature, the blocked-reason messages, and `ReviewRoundResult` are all
   unchanged).

## C7/C6/C5/C4/C3/C2 boundary

This slice adds the reviewer first-callback watchdog strictly between a round's `spawnRoundSeats` call
and that round's `waitForAgreement` call; it does not touch: seat-count resolution (C2/A10/S06), the
pre-loop artifact-publication gate (C3), integer round-cap/per-round timeout resolution (C4), the
fresh-seat spawn/reap mechanism itself (C5), or the revise actuator (C6) — none of `checkArtifactsPublished`,
`spawnRoundSeats`'s spawn/reap behaviour, `collectSameShaBrokenEvidence`, `generatePlanRoundReviseBrief`,
or `waitForPlanRevisionChange` were modified. It also does not remove or replace the honest `BROKEN`
fail-fast inside `waitForAgreement` — C8 (deliberately last of the round core) owns that.

## Evidence

See `test-report.md`.
