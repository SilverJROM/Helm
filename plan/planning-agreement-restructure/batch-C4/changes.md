# changes.md — Batch C4

**Batch:** C4 — `roundCap` becomes integer rounds
**AC:** AC10, AC3
**Branch:** `fix/planning-agreement-restructure`
**Date:** 2026-07-30

## Summary

`runReviewRound()` (`planning-review-round.ts`) used to receive one pre-multiplied
`effectiveTimeoutMs = PLANNING_TIMEOUT_MS * roundCap` from `planning-phase-service.ts` (PPS) and call
`waitForAgreement` exactly once with that scalar — a "round" was fictional, the caller could only ever
observe one long wait, never N discrete agreement attempts. `roundCap` is now a genuine integer count of
agreement rounds: `runReviewRound` takes a **per-round** timeout and calls `waitForAgreement` up to
`roundCap` times, stopping as soon as one round agrees.

## Mechanism

**Before (C3 baseline):** `RunReviewRoundOptions.effectiveTimeoutMs` was the WHOLE bounded-exit budget
(already multiplied by the caller). The function called `waitForAgreement` once with that value.

**After:**
- `RunReviewRoundOptions` gains a new **primary** field `perRoundTimeoutMs?: number` — the wait budget for
  *one* `waitForAgreement` call. `effectiveTimeoutMs` becomes a **legacy alias**, consulted only when
  `perRoundTimeoutMs` is omitted: `const resolvedPerRoundTimeoutMs = (perRoundTimeoutMs ??
  effectiveTimeoutMs)!`. This alias exists solely so the locked `planning-review-round-c2.test.ts` /
  `-c3.test.ts` fixtures (which set `effectiveTimeoutMs: 4000` and nothing else) keep compiling and
  passing byte-for-byte unmodified.
- `RunReviewRoundOptions` gains `roundCap?: number`, resolved as `Math.max(1, Math.trunc(roundCap ?? 1) ||
  1)`. Omitted/undefined ⇒ 1 round — the exact single-wait shape every existing C2/C3 direct fixture
  already exercises (none of them sets it).
- The single `await waitForAgreement(...)` call is replaced by a bounded `for` loop:
  `for (round = 1..resolvedRoundCap)`, each iteration calls `waitForAgreement` once with
  `resolvedPerRoundTimeoutMs`, and breaks as soon as a round returns `agreed === true`. The partner seats
  spawned earlier in the function are reused across every round in this slice — no reap/respawn (that is
  C5's job, explicitly deferred). `agreementFenceOffset` and the race-guard/current-plan-path args are
  passed identically on every round; `waitForAgreement`'s own internal per-poll re-derivation of the
  "newest line per seat" already handles a callbacks.md window that grows between rounds.
- On exhaustion (`!agreed` after the loop), `runReviewRound` now returns a typed, additive result:
  `{ agreed: false, partnerBatchIds, roundsAttempted, blockedReason: 'ROUND-CAP-EXHAUSTED (C4/AC10/AC3): ...' }`.
  `ReviewRoundResult` gained `roundsAttempted?: number` (0 when C3's pre-loop artifact-publication gate
  blocked before any round ran; equal to the resolved `roundCap` on exhaustion; less than `roundCap` when
  an earlier round agreed).
- C3's pre-loop artifact-publication gate (`checkArtifactsPublished`) is completely untouched — it still
  runs once, before any seat spawn, real-mode only.

**`planning-phase-service.ts` (narrow wiring exception, north-approved):**
1. Deleted `const effectiveTimeoutMs = PLANNING_TIMEOUT_MS * roundCap;` — the multiplication is gone.
2. The `runReviewRound({...})` call site now passes `perRoundTimeoutMs: PLANNING_TIMEOUT_MS, roundCap,`
   instead of a pre-multiplied `effectiveTimeoutMs`.
3. The `ROUND-CAP-EXHAUSTED` blocked-message string (built by PPS itself on `!agreed`, independent of
   `runReviewRound`'s own new `blockedReason`) no longer claims a multiplied-timeout budget: `(~${effectiveTimeoutMs}ms budget)` →
   `(~${PLANNING_TIMEOUT_MS}ms/round budget)`. The `"no unanimous CLEAN verdict within ${roundCap} round(s)"`
   wording is unchanged and is now mechanically true — `roundCap` really is the number of rounds attempted.
4. No adjacent refactor. `roundCap`'s own computation (`Math.max(1, Math.trunc(inputs.roundCap ?? 3) ||
   3)`) and its use at `planningRoundCap: roundCap` (the brief field) are untouched.

## Files

| File | Change |
|------|--------|
| `src/services/planning-review-round.ts` | Add `perRoundTimeoutMs?`/`roundCap?` to `RunReviewRoundOptions` (`effectiveTimeoutMs` demoted to legacy alias); add `roundsAttempted?` to `ReviewRoundResult`; replace the single `waitForAgreement` call with a bounded integer-round loop; new exhaustion `blockedReason`. |
| `src/services/planning-review-round-c4.test.ts` | **New.** C4-only gate (4 tests). |
| `src/services/planning-phase-service.ts` | Narrow wiring exception only: delete the multiplied `effectiveTimeoutMs` local; pass `perRoundTimeoutMs`+`roundCap` into `runReviewRound`; update the `ROUND-CAP-EXHAUSTED` message's budget wording. No other line touched. |

## Explicit non-edits

- `planning-review-round-c2.test.ts`, `planning-review-round-c3.test.ts` — prior-slice files, untouched,
  rerun green with no modification (proves the `effectiveTimeoutMs` legacy-alias path).
- `brief-writer-service.ts`, `plan-parser-service.ts`, `real-transport.ts`, schema files, `src/index.ts` —
  untouched. No schema version invented.
- `planning-phase-service.ts`'s stale `roundCap` JSDoc (`:152-155`, "the bounded-exit wall-clock budget is
  PLANNING_TIMEOUT_MS * roundCap (see effectiveTimeoutMs)") and `src/db/database.ts:3302`'s comment
  ("effectiveTimeoutMs (perRoundMs * roundCap)") both now describe a mechanism that no longer exists.
  Neither is one of the 4 approved wiring bullets (comment-only, no behavior/test impact) — left as-is per
  scope discipline; flagged here for whichever slice next touches those files' comments.
- No reap/respawn of partner seats between rounds — that is C5's explicit scope, not this slice's.
