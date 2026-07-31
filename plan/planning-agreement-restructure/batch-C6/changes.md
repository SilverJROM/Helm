# changes.md — Batch C6

**Batch:** C6 — The revise actuator
**AC:** AC11
**Branch:** `fix/planning-agreement-restructure`
**Date:** 2026-07-30

## Summary

C5 made every round spawn brand-new reviewer seats, but a round that failed because a reviewer
confirmed a genuine defect (`BROKEN`, bound to the CURRENT plan.md bytes) simply respawned fresh
reviewers against the exact same unrevised plan — wasting rounds on a plan nothing ever fixed. C6
closes that gap: when a round's non-agreement was actually caused by a same-plan-revision `BROKEN`,
and a round is still left to spend, the engine now spawns a fresh, uniquely-named plancore revision
turn, aggregates the reviewer defect notes into its brief, and waits for `plan.md`'s revision hash to
actually change before letting the loop's next iteration spawn C5's fresh reviewer seats.

## The core problem: `waitForAgreement` only returns a `boolean`

`waitForAgreement` (private to `planning-phase-service.ts`, untouched — out of scope) returns only
`Promise<boolean>`. `runReviewRound` has no verdict detail after a round fails. This module cannot
import `planning-phase-service.ts`'s private `parseAgreementCallbackLine`/`readCallbacksWindow`
(cross-file, out of scope), so it re-implements the SAME B3-fixed grammar locally
(`parseRoundCallbackLine`) and re-scans the SAME `callbacks.md` window `waitForAgreement` just
consumed — restricted to the round that JUST failed, using that round's own round-scoped
`partnerBatchIds` (C5), so an earlier round's stale evidence can never be mistaken for this round's.

## Mechanism

**New local helpers in `planning-review-round.ts` (no other file touched):**

- `parseRoundCallbackLine(line)` — byte-identical duplicate of
  `planning-phase-service.ts`'s private B3 grammar
  (`/^\[(?:helm|projcore) callback\]\s+(\S+)\s+(\S+)\s+STATUS:\s+([A-Z-]+)(?:\s+[\-—–:]\s+(.+))?\s*$/`),
  extracting `{role, batchId, state, note, planSha}` (`plan=<sha12>` parsed the same way B3/B5 do).
- `collectSameShaBrokenEvidence(cbPath, sinceOffset, partnerRole, partnerBatchIds, currentShort12)` —
  reversed (newest-first) scan, newest-`VERDICT-READY`-line-per-seat lock (mirrors
  `waitForAgreement`'s own `seenNewestVerdict` discipline so a malformed/stale newest line can't fall
  through to an older one), filtered to `partnerBatchIds` and `roleMatches(partnerRole, ...)`. Only a
  `BROKEN` whose `planSha === currentShort12` is returned — B5's binding discipline (a verdict must
  match the CURRENT plan bytes, not a superseded revision) carries over unchanged.
- `generatePlanRoundReviseBrief(briefWriter, params)` — **local function**, not a new
  `BriefWriterService` method (the brief's ownership constraint). Composes text via the already-public
  `briefWriter.generateBrief(...)` (the same base `generatePlanReviseBrief`/`generatePlanningBrief`
  already build on) plus a custom body listing the aggregated defect notes and instructing plancore to
  revise `plan.md` in place, then emit `PLAN-READY`.
- `waitForPlanRevisionChange(planMdPath, previousShort12, timeoutMs)` — polls
  `readPlanRevision(planMdPath)` (from `plan-revision.ts`, B1) every 200ms until the short12 differs
  from the pre-revise value, bounded by `timeoutMs`. Returns `false` on timeout — still a bounded exit,
  never a silent/unbounded wait.

**Round-loop wiring** (inside the existing `for (round = 1..resolvedRoundCap)` loop, right after
`if (agreed) break;`):

```
if (round < resolvedRoundCap) {
  const currentRevision = readPlanRevision(planMdPath);
  if (currentRevision) {
    const sameShaBroken = await collectSameShaBrokenEvidence(
      cbPath, agreementFenceOffset, partner, partnerBatchIds, currentRevision.short12
    );
    if (sameShaBroken.length > 0) {
      const reviseBatchId = `${batchId}-r${round}-revise`;
      const reviseBrief = generatePlanRoundReviseBrief(briefWriter, { ... });
      await writeBrief(`${brainRole}-r${round}-revise`, reviseBrief);
      const reviseSpawned = await transport.spawn({ role: brainRole, batchId: reviseBatchId, ... });
      partnerRuntimeIds.push(registerWorkerRuntime(brainRole, reviseBatchId, reviseSpawned.handle, ...));
      partnerHandles.push(reviseSpawned.handle);
      const revised = await waitForPlanRevisionChange(planMdPath, currentRevision.short12, resolvedPerRoundTimeoutMs);
      await transport.reap(reviseSpawned.handle, revised ? 'revise-turn-plan-updated-reaped' : 'revise-turn-timeout-reaped');
    }
  }
}
```

- `round < resolvedRoundCap` — only runs the actuator when there is a next round left to spend (the
  AC's own condition); the final/only round never triggers a revise (a round-1-only caller, e.g. every
  pre-C6 fixture, never enters this branch since `resolvedRoundCap` defaults to `1`).
- `readPlanRevision(planMdPath)` returning `null` (no plan.md on disk yet, e.g. the `isFake` fixture
  convention where `plan.md` is synthesized by the caller only AFTER agreement resolves) short-circuits
  the whole branch — nothing to bind evidence against, so C5/C4's existing bounded behaviour (just
  reap+respawn fresh reviewers) is preserved unchanged.
- `sameShaBroken.length === 0` (round-cap/timeout with no confirmed same-plan BROKEN at all, OR only
  stale/different-SHA BROKEN evidence) also falls through unchanged — no revise call.
- **Unique identity:** `${batchId}-r${round}-revise` cannot collide with any reviewer batch id
  (`...-partner...`) or the original brainRole batchId, and is round-scoped so a later round's revise
  turn (if the plan is BROKEN again after a fix attempt) gets its own distinct id.
- **Cleanup-visible AND explicitly reaped (belt and suspenders):** the revise handle/runtime id are
  pushed into the SAME caller-owned `partnerHandles`/`partnerRuntimeIds` arrays the reviewer seats use
  — so a throw mid-flow still leaves it visible to the caller's terminal owner (A5/A6 safety net) —
  and this module ALSO explicitly `transport.reap`s it itself once the hash wait resolves or times
  out, mirroring how the loop already reaps prior-round reviewer handles. No leak either way.
- **Then continues into C5's fresh reviewer seats**, per the AC — no change to `spawnRoundSeats` or the
  loop's normal next-iteration behaviour.

**New optional fields on `RunReviewRoundOptions`** (additive, no caller wiring in this slice):
`planningBrainModel?: string`, `planningBrainProvider?: string` — bound model/provider for the revise
turn's `transport.spawn` call. Omitted by every existing C2-C5 fixture/caller (`undefined` is a valid
`transport.spawn` param, same as `partnerModel`/`partnerProvider` today).

## Files

| File | Change |
|------|--------|
| `src/services/planning-review-round.ts` | Add `parseRoundCallbackLine`, `collectSameShaBrokenEvidence`, `generatePlanRoundReviseBrief`, `waitForPlanRevisionChange` (all local, unexported); add `planningBrainModel?`/`planningBrainProvider?` to `RunReviewRoundOptions`; wire the revise actuator into the round loop between `waitForAgreement` and the next iteration. No change to `ReviewRoundResult`, `spawnRoundSeats`, or any C2-C5 code path when no same-SHA BROKEN evidence exists. |
| `src/services/planning-review-round-c6.test.ts` | **New.** C6-only gate (4 tests). |

## Explicit non-edits

- `planning-phase-service.ts`, `brief-writer-service.ts`, `plan-parser-service.ts`, `real-transport.ts`,
  `fake-transport.ts`, schema files, `src/index.ts` — untouched. No schema version invented.
- `planning-review-round-c2.test.ts`, `-c3.test.ts`, `-c4.test.ts`, `-c5.test.ts` — prior-slice files,
  untouched, rerun green with no modification.
- The honest `BROKEN` fail-fast inside `waitForAgreement` (`planning-phase-service.ts`) is **not**
  removed or weakened — it still returns `false` immediately on a confirmed BROKEN (subject to the
  existing plan-presence race guard). C6 only adds a NEW path taken AFTER that `false` return, deciding
  whether to spawn a revision turn before the next round. C8 (deliberately last of the round core) owns
  replacing the fail-fast itself.
- B5's current-plan-SHA binding is not weakened: `collectSameShaBrokenEvidence` only ever returns
  evidence whose `plan=` equals the CURRENT `readPlanRevision(planMdPath).short12`, re-read fresh on
  every check (never cached) — a stale/superseded BROKEN cannot trigger a revise for a newer revision,
  proven by the dedicated C6 test's third case.
- No reviewer first-callback/submit watchdog (C7) — the revise turn has no such rescue in this slice;
  its own wait is the bounded `waitForPlanRevisionChange` poll, not `waitForFirstCallback`.
