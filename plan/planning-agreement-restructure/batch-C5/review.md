# review.md — Batch C5 (implementer self-check)

**Verdict:** READY for independent validator
**AC11/AC13:** each round now spawns fresh reviewer seats with round-scoped, collision-free batch ids;
the prior round's now-stale seats are reaped before the next round's spawn; no `transport.send` or seat
reuse is introduced; caller-owned cleanup arrays keep accumulating every round's spawns for the existing
terminal owner.

## Checklist (against the brief's expected acceptance criteria)

| Check | Status |
|-------|--------|
| The C4 bounded loop becomes a real round loop over reviewer seats | Yes — `spawnRoundSeats(round)` is now called inside the `for (round = 1..resolvedRoundCap)` loop, replacing the pre-loop one-time spawn |
| Each round uses freshly spawned reviewer seats | Yes — every iteration calls `spawnRoundSeats(round)`, which always calls `transport.spawn` fresh; test case 1/5 prove distinct handles/ids per round |
| After a non-agreeing round and before the next round's spawn, the prior round's reviewer handles are reaped | Yes — reap of `priorRoundHandles` sits at the top of the loop body, executed before that iteration's `spawnRoundSeats` call; test case 2 proves the exact order `spawn→reap→spawn→reap→spawn` via a shared call-order log |
| Round 1 may preserve legacy batch ids; rounds 2+ use round-scoped unique batch ids that cannot collide with prior rounds | Yes — `roundSuffix = round===1 ? '' : '-r'+round`; round 1 ids are byte-identical to pre-C5 (`batch-C5-partner`); rounds 2+ get `batch-C5-r2-partner`, `batch-C5-r3-partner`, ... — the round number is embedded literally so no two rounds can ever produce the same string |
| No `transport.send` or prompt reuse to an existing reviewer seat is introduced | Yes — `ITransport` has no `send` method (test case 3 asserts `transport.send` is `undefined`); every round's seats come from a brand-new `spawnRoundSeats` call, never a replay of a prior handle (test case 3's `Set` size check) |
| Keep C3 artifact-publication gate before any reviewer spawn | Yes — `checkArtifactsPublished` call is untouched, still runs once, before the round loop, real-mode only |
| Keep C4 integer `roundCap` semantics and per-round timeout | Yes — `resolvedRoundCap`/`resolvedPerRoundTimeoutMs` computation and the loop bound are untouched; every `waitForAgreement` call still receives the same per-round timeout |
| Preserve caller-owned `partnerHandles`/`partnerRuntimeIds` cleanup visibility across a throw or normal exit | Yes — both arrays are still mutated in place inside `spawnRoundSeats`, never reset across rounds; test case 4 confirms both rounds' entries remain visible after an early agreement |
| Reap within `runReviewRound` only the previous round's reviewer handles; never finalize worker-runtime rows here | Yes — the only cleanup call in the loop is `transport.reap(...)`; `registerWorkerRuntime` is called solely to register at spawn time, never to finalize; finalization stays caller-owned in `planning-phase-service.ts`'s `runPlanningTerminal`, untouched |
| New dedicated C5 test: `roundCap=3` non-agreement spawns fresh seats per round with distinct round-scoped batch ids | Yes — test case 1 |
| New dedicated C5 test: prior round handles reaped before next round spawns | Yes — test case 2 (call-order log) |
| New dedicated C5 test: no `transport.send` used/reused | Yes — test case 3 |
| New dedicated C5 test: early agreement stops without spawning later rounds, leaves caller cleanup arrays populated for spawned seats | Yes — test case 4 |
| Targeted vitest on the new C5 test file | Yes — PASS, 6/6 |
| Re-run C2/C3/C4 tests (same round module) | Yes — PASS, 14/14, all three files unmodified |
| `grep -c planMdPathForRaceGuard` and `npx tsc --noEmit -p tsconfig.json` | Yes — `3`, PASS |
| Scope: `planning-review-round.ts` + new C5 test + batch-C5 artifacts only | Yes — no other file touched |
| No schema version invented | N/A — no schema touched |
| No edit to `src/index.ts` | Yes — untouched |
| No edit to `planning-phase-service.ts`, `brief-writer-service.ts`, `plan-parser-service.ts`, or any prior-slice test file | Yes — all untouched, confirmed by unmodified regate |

## Design notes for the validator

1. **Round-scoping lives entirely in the batch id string, not a new transport parameter.**
   `real-transport.ts`'s `SpawnBriefIdentity` type already has an (unused-by-this-slice) `round`/`seatId`
   field, explicitly commented as reserved for "later round-loop slices" — i.e., this one. I deliberately
   did NOT wire those fields, because `ITransport.spawn`'s params type (in `fake-transport.ts`, out of
   scope) has no `round`/`seatId` param at all — adding one would require editing a file this brief
   restricts. Instead, the round-scoped `batchId` string alone is sufficient: `real-transport.ts`'s brief
   basename resolver already disambiguates on `batchId` (C1), so a fresh `batchId` per round transparently
   produces a fresh on-disk brief path with zero transport-layer edits. This is a narrower mechanism than
   the reserved `round` field implies, but it satisfies every acceptance criterion in this brief without
   touching a file outside scope.
2. **`priorRoundHandles` is a length-delta slice, not a hardcoded single-handle assumption.** Panels with
   `partnerCount > 1` (multiple `coPlannerSeats`) reap ALL of the previous round's seats, not just the
   first — proven by test case 5 (2 seats × 2 rounds → exactly 2 reaps after round 1, matching
   `partnerCount`).
3. **The final round is intentionally never reaped inside this function.** This mirrors C4's contract:
   whatever the outcome (agreed or exhausted), the caller's existing `runPlanningTerminal` reaps every
   handle in `partnerHandles` on its own exit path. Reaping the final round here would be redundant work,
   not a correctness bug (reap is idempotent), but the brief is explicit that "finalization remains
   caller-owned" and I read "the previous round's reviewer handles" as excluding whichever round the
   function is about to return on.
4. **`waitForAgreement`'s own matching logic needed no changes.** It treats `partnerBatchIds` as opaque
   strings via `Array.includes`/`Set`-style membership checks (`planning-phase-service.ts:1049`) — a
   round-scoped id like `batch-C5-r2-partner` is matched identically to the legacy `batch-C5-partner`
   shape. This is why the brief's scope restriction (touch only `planning-review-round.ts`) was achievable
   without any wiring exception into `planning-phase-service.ts`, unlike C4's narrow PPS exception.
5. **BROKEN-vs-timeout is still undifferentiated, by design of this slice.** Same as C4: whether a round's
   `waitForAgreement` returns `false` from an explicit dispositive BROKEN or from plain timeout, the loop
   treats both identically and proceeds to reap+respawn for the next round. Distinguishing "revise after a
   confirmed BROKEN" is C6's explicit scope ("the revise actuator"), not this slice's.

## C5/C4/C3/C2 boundary

This slice makes the round loop spawn fresh seats and reap stale ones; it does not touch: the seat-count
resolution logic (`partnerCount`/`useConfiguredSeats`, C2/A10/S06, hoisted outside the loop since count is
round-invariant), the pre-loop artifact-publication gate (C3, untouched), the integer round-cap/per-round
timeout resolution (C4, untouched), the revise-on-BROKEN actuator (C6), the reviewer
spawn/first-callback/submit watchdog (C7), or removing the honest fail-fast (C8, deliberately last).

## Evidence

See `test-report.md`.
