# changes.md — Batch C8

**Batch:** C8 — Replace honest BROKEN fail-fast with typed round-loop results
**AC:** AC11, AC23
**Branch:** `fix/planning-agreement-restructure`
**Date:** 2026-07-30

## Summary

C8 is deliberately the LAST slice of the round core — the same discipline that kept the fail-fast
alive through C3-C7 so the round machine that supersedes it would exist first (the 04:00 PHT mistake
was removing it before that machine existed at all). By C7, `runReviewRound` already distinguishes two
of the three required non-agreement causes in code: C3's artifact-publication gate
(`ARTIFACT-NOT-PUBLISHED`) and C7's reviewer first-callback watchdog (`REVIEWER-NO-FIRST-CALLBACK`).
The third — a same-current-plan `BROKEN` verdict — was only classified **conditionally**: C6's
`collectSameShaBrokenEvidence` scan ran solely inside `if (round < resolvedRoundCap)`, because that
branch also decides whether to spawn a revise turn. On the round that actually exhausts `roundCap`
(the FINAL round), that condition is false, so the scan never ran — a same-current-plan `BROKEN` on
the last round fell straight through to the generic `ROUND-CAP-EXHAUSTED` return with no trace of why,
exactly the "anonymous boolean false" the brief describes.

C8 hoists that classification (not the revise **spawn**, which stays correctly gated on remaining
round budget) to run on every non-agreeing round, and adds an additive, typed `blockedReasonKind`
field so a same-current-plan `BROKEN` is a first-class, machine-checkable cause everywhere it happens
— including the round that has no budget left to act on it.

## Mechanism

**New exported type on `planning-review-round.ts`:**

```ts
export type RoundBlockedReasonKind =
  | 'artifact-not-published'
  | 'reviewer-no-first-callback'
  | 'same-plan-broken'
  | 'round-cap-exhausted';
```

**`ReviewRoundResult` gets one additive/optional field**, `blockedReasonKind?: RoundBlockedReasonKind`,
stamped alongside the pre-existing `blockedReason` string at all four return sites (C3's gate, C7's
watchdog, the new same-plan-broken exit, and the generic exhausted exit). The existing
`blockedReason` string is untouched in shape/format everywhere except the one new branch below, so no
existing consumer that only reads `blockedReason` (a plain string) is affected.

**The classification itself is hoisted out of the `round < resolvedRoundCap` gate:**

```ts
// before (C6): only scanned when a next round existed to spend
if (round < resolvedRoundCap) {
  const currentRevision = readPlanRevision(planMdPath);
  if (currentRevision) {
    const sameShaBroken = await collectSameShaBrokenEvidence(...);
    if (sameShaBroken.length > 0) { /* spawn revise */ }
  }
}

// after (C8): scanned every non-agreeing round; the SPAWN stays gated on round<cap
lastSamePlanBrokenEvidence = [];
const currentRevision = readPlanRevision(planMdPath);
if (currentRevision) {
  lastSamePlanBrokenEvidence = await collectSameShaBrokenEvidence(
    cbPath, agreementFenceOffset, partner, partnerBatchIds, currentRevision.short12
  );
}
if (lastSamePlanBrokenEvidence.length > 0 && round < resolvedRoundCap) {
  /* spawn revise — byte-identical mechanism to C6, now reading the hoisted evidence array */
}
```

`lastSamePlanBrokenEvidence` is a loop-scoped variable, reset to `[]` at the top of every
non-agreeing round's classification (never accumulated across rounds), so after the loop ends it
reflects exactly the round that left the loop — the one `roundsAttempted` names.

**The post-loop exhausted return branches on that evidence:**

```ts
if (!agreed) {
  if (lastSamePlanBrokenEvidence.length > 0) {
    return {
      agreed: false, partnerBatchIds, roundsAttempted,
      blockedReasonKind: 'same-plan-broken',
      blockedReason: `SAME-PLAN-BROKEN-NO-ROUNDS-LEFT (C8/AC11/AC23): round ${roundsAttempted} ` +
        `reviewer seat(s) [...] returned BROKEN against the CURRENT plan.md revision, and no further ` +
        `round(s) remained (cap ${resolvedRoundCap}) to spawn a revise turn — a same-current-plan ` +
        `BROKEN, not a generic non-convergence timeout.`,
    };
  }
  return {
    agreed: false, partnerBatchIds, roundsAttempted,
    blockedReasonKind: 'round-cap-exhausted',
    blockedReason: `ROUND-CAP-EXHAUSTED (C4/AC10/AC3): ...` /* unchanged message */,
  };
}
```

## Why this preserves every prior invariant

- **B3/B4/B5 (via `collectSameShaBrokenEvidence`, untouched logic):** the hoisted call is the exact
  same function C6 already used — newest-raw-line-locks-the-seat (B4 parity), separator/`plan=`
  grammar (B3), current-plan SHA binding (B5) — now just invoked unconditionally instead of
  conditionally. No behavior inside that function changed.
- **A0 raceguard:** `grep -c planMdPathForRaceGuard planning-phase-service.ts` still returns `3` — C8
  never touches `planning-phase-service.ts`.
- **C6 (revise actuator):** the revise turn is still spawned only when `round < resolvedRoundCap`,
  byte-identical mechanism (same brief generator, same spawn params, same hash-wait, same explicit
  reap) — C8 only changed WHERE the evidence used to gate it is computed from (every round) to WHAT
  else that evidence is used for after the loop (final classification).
- **C7 (reviewer watchdog):** returns before this code runs at all on a stuck seat; unaffected.
- **Production wiring:** `blockedReasonKind` is additive/optional on `ReviewRoundResult`.
  `planning-phase-service.ts` already destructures `{ agreed, partnerBatchIds }` (per C2's original
  seam) and does not need to read the new field to keep working — the typed round-result path is live
  in real mode by construction (same code path every real caller already takes), with **no new host
  wiring required** from `planning-phase-service.ts`.

## Files

| File | Change |
|------|--------|
| `src/services/planning-review-round.ts` | Add `RoundBlockedReasonKind` type + `blockedReasonKind?` field on `ReviewRoundResult`; stamp it at all four blocked-return sites; hoist the same-SHA `BROKEN` classification out of the `round < resolvedRoundCap` gate into a loop-scoped `lastSamePlanBrokenEvidence` computed every non-agreeing round; keep the C6 revise-spawn action gated on `round < resolvedRoundCap` unchanged; add the `same-plan-broken` typed exit to the post-loop `!agreed` branch. |
| `src/services/planning-review-round-c8.test.ts` | **New.** C8-only gate (4 tests). |

## Explicit non-edits

- `planning-phase-service.ts`, `brief-writer-service.ts`, `plan-parser-service.ts`, schema files,
  `src/index.ts` — untouched. No schema version invented. No PPS host wiring required or added.
- `planning-review-round-c2.test.ts` through `-c7.test.ts` — prior-slice files, untouched, rerun green
  with no modification (30/30 — see `test-report.md`). None of them assert on `blockedReason` content
  in a scenario where the new final-round evidence scan finds anything: C4/C5's fixtures never write
  `plan.md` (so `readPlanRevision` returns `null` and the scan is a no-op); C6's fixtures only ever
  seed `BROKEN` evidence for round 1's own batch id, never the final round's — the final-round scan
  correctly finds nothing for those fixtures either, so their (unchecked) `blockedReason` stays the
  generic `ROUND-CAP-EXHAUSTED` string exactly as before.
- `waitForAgreement` itself (private to `PlanningPhaseService`) is not touched, moved, or reimplemented
  — it still returns a plain boolean; C8's "typed round result" is this module's own classification of
  *why* that boolean came back false, layered on top, exactly as the brief's scope required (`Do not
  move or edit it in C8`).
