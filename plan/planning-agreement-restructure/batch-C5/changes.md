# changes.md — Batch C5

**Batch:** C5 — Keystone: fresh reviewer seats per round
**AC:** AC11, AC13
**Branch:** `fix/planning-agreement-restructure`
**Date:** 2026-07-30

## Summary

C4 made `roundCap` a genuine integer count of `waitForAgreement` calls, but every round still waited on
the SAME seats spawned once, before the loop — a "round" was a repeated wait, not a fresh review. C5
makes the round loop real: each round now spawns brand-new reviewer seats with round-scoped batch ids,
and the prior round's now-stale seats are reaped before the next round's spawn. A seat's turn ends the
moment its round's `waitForAgreement` call resolves without agreement — there is no `transport.send`, so
the only way to hear from a reviewer again is a fresh `transport.spawn`, never a resend to an existing
handle.

## Mechanism

**Before (C4 baseline):** the partner-spawn loop (`for (i < partnerCount)`) ran exactly once, above the
round `for` loop. The round loop only called `waitForAgreement` repeatedly against the one set of seats
spawned before it.

**After:**
- The per-seat spawn body (unchanged internals: `generatePanelBrief` → `writeBrief` → `transport.spawn` →
  `registerWorkerRuntime` → push to `partnerHandles`/`partnerRuntimeIds`) is extracted into a local
  closure `spawnRoundSeats(round: number): Promise<string[]>`, defined once inside `runReviewRound` (after
  `partnerCount`/`useConfiguredSeats`/`resolvedPanelSize`, which stay hoisted outside since seat COUNT
  never changes round to round — only identity does). It returns that round's `partnerBatchIds`.
- Round-scoped identity, computed once per seat inside `spawnRoundSeats`:
  - `roundSuffix = round === 1 ? '' : '-r' + round`
  - `seatIndexSuffix = i === 0 ? '' : '-' + (i + 1)`
  - `partnerBatchId = batchId + roundSuffix + '-partner' + seatIndexSuffix`
  - `seatLabel` (brief's `seat:` field) `= 'partner' + roundSuffix + seatIndexSuffix`
  - `writeBriefKey` (the `writeBrief(role, content)` key) `= partner + roundSuffix + seatIndexSuffix`
  - Round 1, seat 0/1 (2-seat example, `batchId='batch-C5'`, `partner='planner'`):
    `batch-C5-partner`, `batch-C5-partner-2` — byte-identical to every pre-C5 fixture; brief keys
    `planner`, `planner-2`.
  - Round 2, same seats: `batch-C5-r2-partner`, `batch-C5-r2-partner-2`; brief keys `planner-r2`,
    `planner-r2-2`. Round 3: `batch-C5-r3-partner`, ... — no round's id can ever equal another round's
    (the `-rN-` segment is present iff `N>1` and `N` is embedded literally, so two different rounds always
    produce two different strings).
  - `real-transport.ts`'s brief-basename disambiguation (from C1) already keys off this same `batchId`
    string passed through the existing `ITransport.spawn({..., batchId})` param, so round-scoping it here
    also gives each round's seat its own on-disk `prompts/*.brief.md` with **zero transport-layer
    changes** — `real-transport.ts` is not touched by this slice.
- The round loop now calls `spawnRoundSeats(round)` every iteration instead of relying on one pre-loop
  spawn:
  ```
  let priorRoundHandles: string[] = [];
  for (let round = 1; round <= resolvedRoundCap; round++) {
    roundsAttempted = round;
    if (round > 1) {
      for (const handle of priorRoundHandles) {
        await transport.reap(handle, 'round-non-agreement-reaped');
      }
      priorRoundHandles = [];
    }
    const handleCountBeforeRound = partnerHandles.length;
    partnerBatchIds = await spawnRoundSeats(round);
    priorRoundHandles = partnerHandles.slice(handleCountBeforeRound);
    agreed = await waitForAgreement(...partnerBatchIds...);
    if (agreed) break;
  }
  ```
  `priorRoundHandles` is captured as a before/after length delta on the caller-owned `partnerHandles`
  array, so it is correct for any `partnerCount` (not just single-seat panels) — it always holds exactly
  the handles the PREVIOUS iteration's `spawnRoundSeats` call pushed, nothing more/less.
- **Reap ordering:** the reap of `priorRoundHandles` happens at the TOP of the loop body, strictly BEFORE
  that iteration's `spawnRoundSeats(round)` call — i.e., strictly before any `transport.spawn` for the new
  round. A round can therefore never observe (or send to) a still-alive prior-round seat.
- **The final round is never reaped inside this function.** Whether the loop ends by agreement or by
  exhausting `resolvedRoundCap`, the last round's `priorRoundHandles` value is left un-reaped — that stays
  the caller's job via its existing terminal owner (`runPlanningTerminal` in `planning-phase-service.ts`,
  untouched), which reaps+finalizes everything in `partnerHandles`/`partnerRuntimeIds` regardless of how
  many rounds ran. `transport.reap` is already idempotent on an already-reaped handle (see
  `fake-transport.ts`'s `if (this.spawned.has(handle))` guard and the existing comment at
  `planning-phase-service.ts:255-260`), so even if this function's mid-loop reap and the caller's final
  reap ever targeted the same handle, that would be a safe no-op — they do not, by construction.
- **No `transport.send`, no seat reuse.** `ITransport` (`fake-transport.ts`, unedited by this slice) has
  no `send` method at all — only `spawn`/`reap`/`inspectSeat`/`nudgeSeat`. Nothing in this module ever
  reads back or replays a previous round's `partnerSpawned.handle`; every round's `partnerBatchIds` comes
  from a brand-new `spawnRoundSeats` call. The C5 test file proves this empirically: across every round in
  a run, the set of handles pushed to `partnerHandles` has no duplicates.
- **Caller-owned cleanup arrays are untouched in contract.** `partnerHandles.push(...)` and
  `partnerRuntimeIds.push(registerWorkerRuntime(...))` still happen inside `spawnRoundSeats`, exactly where
  they happened pre-C5 — these are the SAME arrays passed in via `options`, never reset or spliced by this
  function. After N rounds, both arrays hold N × `partnerCount` entries: every seat ever spawned, in every
  round, still visible to the caller's terminal owner. `registerWorkerRuntime` is only ever called to
  *register* a seat; this module never calls a finalize/DB function — finalization remains 100%
  caller-owned, exactly as before.
- C3's pre-loop artifact-publication gate (`checkArtifactsPublished`) and C4's integer `resolvedRoundCap` /
  per-round `resolvedPerRoundTimeoutMs` resolution are both completely untouched — the gate still runs
  once, before any seat spawn, real-mode only; the round-cap loop bound and per-round timeout value passed
  to every `waitForAgreement` call are unchanged.

## Files

| File | Change |
|------|--------|
| `src/services/planning-review-round.ts` | Extract the per-seat spawn body into `spawnRoundSeats(round)` with round-scoped batch id / seat label / writeBrief key; round loop now calls it every iteration and reaps the previous round's handles first. No public interface change — `RunReviewRoundOptions`/`ReviewRoundResult` shapes are unchanged. |
| `src/services/planning-review-round-c5.test.ts` | **New.** C5-only gate (6 tests). |

## Explicit non-edits

- `planning-phase-service.ts`, `brief-writer-service.ts`, `plan-parser-service.ts`, `real-transport.ts`,
  `fake-transport.ts`, schema files, `src/index.ts` — untouched. No schema version invented.
- `planning-review-round-c2.test.ts`, `-c3.test.ts`, `-c4.test.ts` — prior-slice files, untouched, rerun
  green with no modification (none of them set `roundCap > 1`, so the new reap-before-next-round branch is
  never entered for them; the round-1 legacy id shape they all assert is byte-identical to before).
- No revise-on-BROKEN actuator (C6), no reviewer first-callback/submit watchdog (C7), no removal of the
  honest fail-fast (C8, deliberately last) — all out of scope for this slice.
