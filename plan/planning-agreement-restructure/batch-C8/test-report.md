# test-report.md — Batch C8

**Batch:** C8 — Replace honest BROKEN fail-fast with typed round-loop results
**Date:** 2026-07-30

## 1. New C8 gate — `planning-review-round-c8.test.ts`

```
✓ src/services/planning-review-round-c8.test.ts (4 tests) 11ms
  ✓ BROKEN on R1 revises to R2, fresh reviewer seats spawn, CLEAN on R2 converges end-to-end
  ✓ same-current-plan BROKEN on the FINAL round returns typed same-plan-broken, not ROUND-CAP-EXHAUSTED
  ✓ stale/superseded-SHA BROKEN on the final round still does not count for the current plan
  ✓ older same-SHA BROKEN then a newer malformed verdict line for the same seat stays fail-closed on the final round

Test Files  1 passed (1)
     Tests  4 passed (4)
```

Maps directly to the brief's four required proofs:

1. **End-to-end convergence** — round 1 seeds a same-current-plan `BROKEN`; the round loop spawns a
   uniquely-named plancore revise turn (`batch-C8-r1-revise`); the (mocked) revise turn rewrites
   `plan.md` to a new revision; round 2 spawns fresh reviewer seats (`batch-C8-r2-partner`, distinct
   brief key `planner-r2`); a `CLEAN`-equivalent `waitForAgreement` resolution on round 2 converges.
   `result.agreed === true`, `blockedReason`/`blockedReasonKind` both `undefined`.
2. **Same-current-plan BROKEN drives a typed path, not `ROUND-CAP-EXHAUSTED`** — `BROKEN` evidence
   seeded only for round 2 (the FINAL round, `roundCap: 2`), no evidence for round 1. Result:
   `blockedReasonKind === 'same-plan-broken'`, message matches `/SAME-PLAN-BROKEN/` and does **not**
   match `/ROUND-CAP-EXHAUSTED/`. Zero revise-turn spawns (no budget left) — confirmed no phantom side
   effects.
3. **Stale/superseded evidence excluded** — `BROKEN` bound to a different (superseded) `plan=` SHA on
   the final round. Result falls back to `blockedReasonKind === 'round-cap-exhausted'`, message matches
   `/ROUND-CAP-EXHAUSTED/`, not `/SAME-PLAN-BROKEN/`.
4. **Malformed-newest-over-older-same-SHA fail-closed** — an older, parseable same-SHA `BROKEN` for a
   seat, then a newer, truncated/unparseable line for the SAME seat, on the final round. Result: seat
   is locked to its newest (malformed) line per B4 parity, evidence excluded, falls back to
   `round-cap-exhausted` — never `same-plan-broken`.

## 2. Regression sweep — C2 through C7 (shared module `planning-review-round.ts`)

```
✓ src/services/planning-review-round-c2.test.ts (4 tests)  7ms
✓ src/services/planning-review-round-c3.test.ts (6 tests) 12ms
✓ src/services/planning-review-round-c4.test.ts (4 tests)  6ms
✓ src/services/planning-review-round-c5.test.ts (6 tests)  9ms
✓ src/services/planning-review-round-c6.test.ts (5 tests) 1222ms
✓ src/services/planning-review-round-c7.test.ts (5 tests) 1825ms

Test Files  6 passed (6)
     Tests  30 passed (30)
```

Combined C2-C8 run (single vitest invocation, `Test Files 7 passed (7)`, `Tests 34 passed (34)`,
`Duration 4.00s`) — no cross-file interference, no order dependency.

None of C2-C7's fixtures exercise the new final-round classification with actual evidence present:
C4/C5 never write `plan.md` to disk (`readPlanRevision` returns `null`, scan is a no-op regardless of
which round); C6's fixtures seed `BROKEN` only for round 1's own batch id, never round 2's (the final
round in its `roundCap: 2` fixtures), so the final-round scan finds nothing there either — and none of
C2-C7 assert on `blockedReason`/`blockedReasonKind` content in a non-agreement scenario in the first
place. All 30 pass unmodified.

## 3. Standing gates

```
$ grep -c planMdPathForRaceGuard src/services/planning-phase-service.ts
3

$ npx tsc --noEmit -p tsconfig.json
(no output, exit 0)
```

## 4. Scope check

`git status --porcelain` for every out-of-scope file named in the brief (`planning-phase-service.ts`,
`brief-writer-service.ts`, `plan-parser-service.ts`, `src/index.ts`) shows only their pre-existing
modification state from prior batches — no new diff introduced by this session. Only
`planning-review-round.ts` (edited) and `planning-review-round-c8.test.ts` (new) changed.
